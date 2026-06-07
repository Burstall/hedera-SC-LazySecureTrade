# Building a SNIPER agent in ~80 lines

> **Audience:** TypeScript / Node developers building marketplace
> bots. Assumes familiarity with ethers v6 and the Hashgraph SDK.
> **Read time:** ~10 minutes.
> **Last updated:** 2026-05-27.

A SNIPER is the curated v1 agent for LazySecureTrade: it watches
the EnglishAuction surface for items you care about and places
bids inside the auction's anti-snipe window. The contract side
already exists and is deployed to Hedera testnet — your job is
the ~80 lines of off-chain logic that submits the bids.

This post walks through the minimal viable runtime.

## What you'll wire

```
┌─────────────────────┐     poll      ┌────────────────────────┐
│ Hedera mirror node  │◄─────────────│ watcher.ts             │
│  GET /api/v1/...    │               │  (auction snapshots)   │
└─────────────────────┘               └───────────┬────────────┘
                                                  │
                                                  │ snapshot
                                                  ▼
                                      ┌────────────────────────┐
                                      │ strategy.ts            │
                                      │  pure function:        │
                                      │  snapshot → bid|wait   │
                                      └───────────┬────────────┘
                                                  │
                                                  │ {bid: amount}
                                                  ▼
                                      ┌────────────────────────┐
                                      │ executor.ts            │
                                      │  signed Hedera tx ──►  │ contract
                                      └────────────────────────┘
```

Three modules. Strategy is pure (testable in isolation). Watcher
and executor are I/O. None of them holds your wallet's key.

## 0. Provision the agent account

Before any of this code matters, you need a Hedera account that
the agent will sign as. This isn't your wallet — it's a separate
ECDSA account whose only HBAR is enough for tx fees (~5 HBAR
covers many txs).

```typescript
import { ethers } from 'ethers';
import {
    AccountId, AccountInfoQuery, Client, Hbar, HbarUnit,
    PrivateKey, TransferTransaction,
} from '@hashgraph/sdk';

async function provisionAgent(
    operatorClient: Client,
    operatorId: AccountId,
    wallet: ethers.Wallet,
    fundHbar = 5,
) {
    const ecdsaKey = PrivateKey.fromStringECDSA(wallet.privateKey);

    // Fund the alias-key form (Hedera consensus accepts it as a
    // receiver; it auto-creates the account with this key).
    const aliasId = ecdsaKey.publicKey.toAccountId(0, 0);
    await new TransferTransaction()
        .addHbarTransfer(operatorId, new Hbar(-fundHbar))
        .addHbarTransfer(aliasId, new Hbar(fundHbar))
        .freezeWith(operatorClient)
        .execute(operatorClient)
        .then((r) => r.getReceipt(operatorClient));

    // Resolve to numeric AccountId. The SDK refuses to setOperator
    // with the alias form; we need 0.0.<num>.
    const info = await new AccountInfoQuery()
        .setAccountId(aliasId).execute(operatorClient);

    return {
        agentId: info.accountId,     // 0.0.<num>
        agentKey: ecdsaKey,
        agentEvm: wallet.address,    // matches msg.sender on-chain
    };
}
```

If you skip the `AccountInfoQuery` step and try to use the
alias-key AccountId directly with `setOperator`, the SDK throws
about checksums. If you skip and use `AccountId.fromEvmAddress(0,
0, wallet.address)` instead, Hedera consensus throws
`PAYER_ACCOUNT_NOT_FOUND`. Both traps cost a lot of dev hours; the
recipe above sidesteps them.

Run this once per agent during setup; store the agent ID + key
somewhere your runtime can read.

## 1. Authorize the agent on your user's stash

This is a one-shot human step, not part of the runtime. The user
calls `BidderContract.createEnvelope(params)` from their own
wallet, with the agent's EVM address as the agentKey. The
envelope structure is documented in
[Agent envelopes — your AI trader, your rules](../user/03-agent-envelopes-plain-english.md).

For the SNIPER milestone you want at minimum:

- `agentKey = agent.evm`
- `allowedActions = (1 << AuctionBid)` (or also `AuctionBuyNow`
  if you want the option)
- `perTxHbarCap`, `dailyHbarCap` — sized to the user's risk
  appetite
- `expiresAt = 0` (no expiry) or a timestamp matching the
  user's auction-watching horizon
- `reasoningTopicId = ethers.ZeroHash` for v0; later you'll point
  at an HCS-10 topic where the agent logs reasoning

The runtime should refuse to start until it can read the
envelope from the stash and confirm it matches the local config.

## 2. The watcher

Mirror-node read patterns are HTTP. Polling is fine for a first
pass — the test suite's helpers already wrap this; you can
borrow the pattern.

```typescript
import { englishAuctionInterface, getAddresses } from '@lazysuperheroes/marketplace-sdk';

const { englishAuction: eaAddr } = getAddresses('testnet');
const eaIface = englishAuctionInterface();

async function pollAuction(auctionId: string) {
    const data = eaIface.encodeFunctionData('getAuctionSnapshot', [auctionId]);
    const resp = await fetch(`https://testnet.mirrornode.hedera.com/api/v1/contracts/call`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            block: 'latest',
            data,
            to: eaAddr.evmAddress,
            from: '0x0000000000000000000000000000000000000001',
        }),
    });
    const raw = (await resp.json()).result;
    return eaIface.decodeFunctionResult('getAuctionSnapshot', raw)[0];
}

async function watchOne(auctionId: string, onChange: (snap: any) => Promise<void>) {
    let lastClose = 0n;
    while (true) {
        try {
            const snap = await pollAuction(auctionId);
            if (snap.closeAt !== lastClose) {
                lastClose = snap.closeAt;
                await onChange(snap);
            }
        } catch (e) {
            console.warn('poll failed:', e);
        }
        await new Promise((r) => setTimeout(r, 5000));   // 5s — not aggressive
    }
}
```

Don't poll faster than 5s for production — mirror node is a
shared resource. For multiple auctions, fan out via Promise.all
on a single timer, not one timer per auction.

## 3. The strategy

Pure function. No I/O. Takes the auction snapshot + user config,
returns whether and how much to bid.

```typescript
type Strategy = (snap: AuctionSnapshot, config: SniperConfig) => Action;
type Action =
    | { type: 'wait' }
    | { type: 'bid'; amount: bigint }
    | { type: 'pass'; reason: string };

const snipeStrategy: Strategy = (snap, config) => {
    if (snap.state !== AuctionState.OPEN) return { type: 'pass', reason: 'not open' };
    if (snap.highBid >= config.maxBid) return { type: 'pass', reason: 'over max' };

    const now = BigInt(Math.floor(Date.now() / 1000));
    const timeLeft = snap.closeAt - now;
    if (timeLeft > config.snipeWindowSec) return { type: 'wait' };

    // Bid is current high + minStep, capped by config.maxBid.
    const minBid = snap.highBid + (snap.highBid * BigInt(snap.minStepBps) / 10_000n);
    const proposed = minBid > config.maxBid ? config.maxBid : minBid;
    return { type: 'bid', amount: proposed };
};
```

Test this against a handful of fixture snapshots before wiring
the executor. The bug surface is rich (off-by-one on the snipe
window, minStep math, max-bid sanity) and you'd rather catch it
in a unit test than against testnet.

## 4. The executor

Builds the `placeAuctionBid` calldata, signs as the agent,
submits via the Hashgraph SDK.

```typescript
import {
    ContractExecuteTransaction, ContractFunctionParameters, ContractId,
} from '@hashgraph/sdk';
import {
    bidderContractInterface, buildAgentAuth,
} from '@lazysuperheroes/marketplace-sdk';

const bcIface = bidderContractInterface();

async function placeBid(
    client: Client,           // operator = agent (setOperator was called earlier)
    stashId: ContractId,
    auctionId: string,
    amount: bigint,
    reasoningTopicId: string, // bytes32(0) or HCS-10 topic
) {
    const auth = buildAgentAuth(client.operatorAccountId.toEvmAddress(), reasoningTopicId);
    const calldata = bcIface.encodeFunctionData('placeAuctionBid', [
        auctionId, amount, false /* isLazy */, auth,
    ]);

    const tx = await new ContractExecuteTransaction()
        .setContractId(stashId)
        .setGas(1_500_000)
        .setFunctionParameters(Buffer.from(calldata.slice(2), 'hex'))
        .freezeWith(client)
        .execute(client);

    const receipt = await tx.getReceipt(client);
    return receipt.status.toString();
}
```

The stash forwards to `EnglishAuction.placeBid` after verifying
the envelope. If the per-tx cap is busted, the daily cap is
exhausted, or the envelope is paused, the call reverts before the
auction sees it — gas is consumed but no funds move. Your
runtime should distinguish revert types (`PerTxCapExceeded`,
`BudgetExhausted`, `EnvelopeAuthFailed`) and back off intelligently
(e.g., stop trying for the day if BudgetExhausted; alert the human
if EnvelopeAuthFailed because that means they paused you).

## 5. Wire it together

```typescript
async function runSniper(config: SniperConfig) {
    const { agentId, agentKey } = await loadAgentFromKeystore(config.agentKeyPath);
    const client = Client.forTestnet().setOperator(agentId, agentKey);

    for (const auctionId of config.watchList) {
        watchOne(auctionId, async (snap) => {
            const action = snipeStrategy(snap, config);
            if (action.type === 'bid') {
                console.log(`bidding ${action.amount} on ${auctionId}`);
                const status = await placeBid(client, config.stashId, auctionId, action.amount, ethers.ZeroHash);
                console.log(`  status: ${status}`);
            }
        });
    }
}
```

That's the skeleton. ~80 lines counting helpers.

## Things this skeleton doesn't do (yet)

- **HCS-10 reasoning topics.** The `reasoningTopicId` is
  `bytes32(0)` here. For a real deployment you'd publish a topic
  per agent and write each decision to it (e.g., "Bid 50 HBAR
  because snap.highBid was 47 and snap.closeAt was within 30s").
  Use the Hedera Agent Kit's HCS plugin to manage these topics.
- **Backoff on revert.** Add an exponential backoff when you see
  `PerTxCapExceeded` or `BudgetExhausted` so you don't waste gas
  on retries.
- **Health checks.** Verify the envelope is still active before
  each poll cycle (`bidderContractInterface().getEnvelope(agentEvm)`
  via mirror). If `expiresAt` has passed or the envelope was
  cancelled, stop.
- **Concurrency.** Two auctions closing at the same time — your
  current single-threaded executor will serialize them, possibly
  missing one. Add a queue or fan out.

## Where the code lives

The reference scaffolding is in
[`test/AgentEnvelopeFull.test.js`](https://github.com/lazysuperheroes/hedera-SC-LazySecureTrade/blob/v0.3/test/AgentEnvelopeFull.test.js)
in the contracts repo. The agent provisioning helper in
[`test/scaffold.js`](https://github.com/lazysuperheroes/hedera-SC-LazySecureTrade/blob/v0.3/test/scaffold.js)
is the canonical pattern. The probe at
[`scripts/testing/agentAliasProbe.js`](https://github.com/lazysuperheroes/hedera-SC-LazySecureTrade/blob/v0.3/scripts/testing/agentAliasProbe.js)
proves the alias-key auto-create + AccountInfoQuery resolve flow
end-to-end for ~3 HBAR.

For the SDK side, install:

```bash
yarn add @lazysuperheroes/marketplace-sdk ethers@^6 @hashgraph/sdk@^2.50
yarn add @hashgraph/hedera-agent-kit   # optional; needed for HCS-10
```

And read [`docs/AGENT-RUNTIME-BOOTSTRAP.md`](https://github.com/lazysuperheroes/hedera-SC-LazySecureTrade/blob/v0.3/docs/AGENT-RUNTIME-BOOTSTRAP.md)
for the broader runtime context.
