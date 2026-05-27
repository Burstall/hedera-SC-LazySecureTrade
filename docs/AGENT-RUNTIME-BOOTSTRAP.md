# Lazy Agent Runtime — Bootstrap Prompt

> **Drop this file into the root of a fresh empty repo (suggested name:
> `lazy-agent-runtime` to keep brand consistency with
> `@lazysuperheroes/*` packages) as `CLAUDE.md` (or as `README.md` if
> you want it human-facing) and start a Claude Code session there.
> This file is self-contained — it carries enough context to start the
> agent runtime without reading anything in the
> `hedera-SC-LazySecureTrade` repo first, but links every claim to the
> source of truth.**
>
> **Last updated:** 2026-05-27 (against contracts repo `v0.3` branch tip
> `a148c74`). Comprehensive AE0-AE11 envelope test suite landed
> (Sessions 1-3 live, AE11 timing-gated). Tier-3 polish items #7/#8/#9
> closed; #6 deferred. Agent Hedera-account provisioning recipe added
> below (Section "Provisioning an agent Hedera account").

---

## What you're building

An **automated trading agent runtime** for the LazySecureTrade (LST)
marketplace on Hedera. The contracts already exist and are deployed to
Hedera testnet — your job is the off-chain process that submits
transactions on behalf of human users.

The marketplace is three parallel surfaces:

| Surface | What it is | Contract |
|---|---|---|
| **LST trades** | Fixed-price listings (open market or directed buyer). Single + atomic batch + multi-execute. | `LazySecureTrade` |
| **BCF bids** | CLOB-style resting bids per (token, serial). Each user gets a per-user "stash" contract holding funds + envelopes. | `BidderContractFactory` + `BidderContract` (stash) |
| **Auctions** | Timed English auctions with reserve, buy-now, anti-snipe extension. | `EnglishAuction` |

Plus two cross-cutting subsystems:

- `VIPSubscription` — paid tier (Bronze→Platinum) that gates how many
  agents a user can authorize and their daily/per-tx HBAR + LAZY budget.
- `AgentEnvelope` (lives on each stash) — per-(stash, agentKey) record
  with budgets, allowed actions, kill switch. **You consume this.**

---

## Hedera-specific facts that change the design

These are NOT standard EVM assumptions. Internalize them before writing
any agent logic.

1. **No mempool, no MEV, no sandwich attacks.** Hedera consensus orders
   transactions by timestamp. There is no concept of being "front-run"
   the way Ethereum has. Drop any commit-reveal / private-mempool
   defenses — they're irrelevant here.

2. **Auth is `msg.sender`-only.** Hedera's protocol layer verifies the
   submitting account's transaction signature (ECDSA secp256k1 OR
   ED25519, native to whatever key type the Hedera account uses) before
   the EVM runs. Contracts check `msg.sender == envelope.agentKey`
   against the stash's stored agentKey. **There is no EIP-712, no
   `ecrecover`, no nonce on the contract side.** Each agent is just a
   Hedera account; sign with that account's key, submit the tx, done.

3. **Each agent must be a Hedera account (EOA), not a contract.**
   `createEnvelope` rejects contract addresses via `extcodesize > 0`
   (custom error `AgentKeyIsContract`). Reason: contracts can be called
   by anyone and would propagate `msg.sender` in ways the envelope can't
   police.

4. **50 subcalls per transaction is the ceiling.** Every HTS precompile
   call counts. Batch operations are conservatively sized for this, not
   for gas alone.

5. **~1M gas per new HTS token association.** UX caps new associations
   at 5–8 per transaction.

6. **No gas refunds on revert.** Users pay for consumed gas even when
   the tx fails — prefer pre-flight validation over "try it and see".
   The contracts expose pre-flight views (`isBidValid`, `canAuthorize`,
   `getAuctionSnapshot`) for this reason; use them.

7. **Mirror node is your read path.** `mirrornode.hedera.com` (and the
   testnet/previewnet equivalents) is the canonical read source for
   contract state, transaction history, and event logs. Direct
   `eth_call` is supported but slower and rate-limited. Read from
   mirror; write via the SDK.

---

## Install the marketplace SDK

The contracts repo publishes the SDK to npm as
`@lazysuperheroes/marketplace-sdk`. Install + peer deps in one line:

```bash
yarn add @lazysuperheroes/marketplace-sdk ethers@^6 @hashgraph/sdk@^2.50
```

(The package ships pre-built `dist/` + bundled ABIs in the npm
tarball — no build step runs on the consumer side. Consumes ~916 KB
unpacked, of which most is the ABI JSON bundled into the type
declarations.)

### Also install the Hedera AI Agent Kit

The runtime is built on top of **`@hashgraph/hedera-agent-kit`** —
Hedera's official framework for agent-Hedera integration. Wraps the
Hashgraph SDK with plugins for HTS (NFT + fungible ops), HCS (topic
messaging), and account management. Provides LangChain / Vercel AI SDK
/ Google ADK / ElizaOS toolkit adapters out of the box.

```bash
yarn add @hashgraph/hedera-agent-kit
```

**Pin the version.** The kit is at v4 with documented breaking changes;
budget a quarterly pass to re-pin against the latest. Read the kit's
own migration guide before bumping major versions.

### How the two layers fit together

| Layer | Source | Responsibility |
|---|---|---|
| **Marketplace SDK** (`@lazysuperheroes/marketplace-sdk`) | This repo, contracts side | LST/BCF/EA contract calldata, addresses, typed enums + structs, `AgentAuth` tuple. The marketplace-specific surface that no general framework can know about. |
| **Hedera Agent Kit** (`@hashgraph/hedera-agent-kit`) | Hedera Foundation | Generic Hedera-native ops: HTS NFT associations, HCS topic creation + messaging (for HCS-10 reasoning trace), account/key management, network routing. LLM-orchestration substrate via the LangChain/AI SDK toolkits. |
| **Hashgraph SDK** (`@hashgraph/sdk`) | Hedera Foundation | Lowest-level Hedera transport. The Agent Kit wraps this; you'll only reach for it directly for niche cases (e.g., `TransactionRecordQuery`). |

**Rule of thumb:** if the operation touches LST/BCF/EA contracts, use
the marketplace SDK. If it touches HTS/HCS or account management, use
the Agent Kit. If it's a low-level Hashgraph operation neither covers,
use `@hashgraph/sdk` directly.

The first SNIPER milestone is rule-based (watcher + threshold strategy
+ executor) — it doesn't *need* the kit's LangChain integration. Use
the kit for HCS-10 trace + HTS association flows; defer LangChain
adoption to later milestones where actual LLM reasoning lives on the
critical path.

### What the SDK gives you (v0.1)

```typescript
import {
    // ABIs
    ABIS,
    LazySecureTradeAbi,
    BidderContractFactoryAbi,

    // Addresses
    getAddresses,
    hederaIdToEvmAddress,

    // Ethers Interface factories (lazy)
    bidderContractFactoryInterface,
    englishAuctionInterface,
    vipSubscriptionInterface,

    // AgentAuth tuple helpers
    EMPTY_AUTH,                  // owner-path marker
    buildAgentAuth,              // [agentKey, reasoningTopicId]
    AGENT_AUTH_TUPLE_TYPE,

    // Typed enums (numeric values verified vs Solidity)
    BidStatus, BidValidityCode,
    AuctionState, PaymentToken,
    ActionType, AuthFailCode,
    VipTier, LshTier,            // NOTE: deliberately separate enums

    // Typed structs
    BidDetails, AgentEnvelope, EnvelopeParams, TierLimits,
    Trade, TokenSerialPrice,
    AuctionItem, RoyaltyInfo, AuctionSnapshot, AuctionParams,
} from '@lazysuperheroes/marketplace-sdk';

const { bidderFactory, englishAuction, vipSubscription, lazySecureTrade } =
    getAddresses('testnet');
// → { hederaId: '0.0.9052252', evmAddress: '0x...008a205c' }
```

**v0.1 ships transport primitives only.** Write-path
`TransactionRequest` builders, mirror-node read helpers, and event
decoders are deferred to v0.2 — they're your job to design once you
know the exact shape this runtime needs. When you converge on stable
patterns, propose them back to the contracts repo as PRs to
`packages/sdk/`.

---

## Latest testnet deploys

```
LazySecureTrade        0.0.9057802  (0x...008a360a)   # bumped 2026-05-26 (3-mode timelock)
BidderContract (impl)  0.0.9062594  (0x...008a48c2)   # bumped 2026-05-26
BidderContractFactory  0.0.9062601  (0x...008a48c9)   # bumped 2026-05-26
VIPSubscription        0.0.9043912  (0x...0089ffc8)
EnglishAuction         0.0.9052454  (0x...008a2126)
```

The published `@lazysuperheroes/marketplace-sdk@0.1.0` still points
at the older LST/BCF/impl deploys. The SDK will bump to 0.1.1 when
the runtime needs the new operator-side surface (currently it
doesn't — SNIPER only consumes stash + auction reads).

Mainnet addresses are still null in the SDK — v0.3 hasn't shipped to
mainnet yet.

**Active state to be aware of**: LST has a 48h-timelocked
`authorizeFactory` grant queued for the cached BCF that unlocks at
2026-05-28T18:30:36Z. Until that executes via `LST.executeFactoryAuthorization(bcf)`,
stash-initiated trade listings (`stash.createTrade` →
`BCF.createTradeOnBehalfOfStash` → `LST.createTradeOnBehalf`)
will revert `UnauthorizedFactory`. Bid + arb paths are unaffected.

---

## Provisioning an agent Hedera account

Each agent is a Hedera account; its key signs the transactions that
hit your envelope. The Hedera SDK has a non-obvious behavior here
that bit the contracts repo's own integration tests — record this
recipe before you write a single line of executor code.

### Why this matters (the gotcha)

`AccountId.fromEvmAddress(0, 0, evmAddress)` returns the **long-zero
form** (`0.0.<evmHex>`). Hedera consensus does NOT accept that form
as a transaction payer until the EVM→numeric mapping has been
resolved AND the account has been "completed" by a tx from its
ECDSA key. Submitting a tx with the long-zero payer fails precheck
with `PAYER_ACCOUNT_NOT_FOUND`. This is the trap.

The fix is a two-step pattern: fund via the alias-key form
(`publicKey.toAccountId(0, 0)`), then resolve to numeric via
`AccountInfoQuery` and use **that** for `setOperator`.

### The recipe

```typescript
import {
    AccountId, AccountInfoQuery, Client, Hbar, HbarUnit, PrivateKey,
    TransferTransaction,
} from '@hashgraph/sdk';
import { ethers } from 'ethers';

async function provisionAgentAccount(
    client: Client,             // signed in as the operator / funder
    operatorId: AccountId,
    wallet: ethers.Wallet,      // the agent's ECDSA wallet
    fundHbar = 5,
): Promise<{ id: AccountId; pk: PrivateKey; evm: string }> {
    const ecdsaKey = PrivateKey.fromStringECDSA(wallet.privateKey);

    // Step 1 — fund the alias-key form. Hedera consensus accepts this
    // as a RECEIVER (auto-creates the account with the ECDSA key).
    const aliasAccountId = ecdsaKey.publicKey.toAccountId(0, 0);
    await new TransferTransaction()
        .addHbarTransfer(operatorId, new Hbar(-fundHbar))
        .addHbarTransfer(aliasAccountId, new Hbar(fundHbar))
        .freezeWith(client)
        .execute(client)
        .then((resp) => resp.getReceipt(client));

    // Step 2 — resolve to numeric AccountId. SDK rejects the alias
    // form in setOperator (no checksum on aliases); we need 0.0.<num>.
    const info = await new AccountInfoQuery()
        .setAccountId(aliasAccountId)
        .execute(client);

    return {
        id: info.accountId,                       // 0.0.<num> — use for setOperator
        pk: ecdsaKey,                             // signs as the agent
        evm: wallet.address.toLowerCase(),        // matches msg.sender on-chain
    };
}

// Subsequent agent-as-payer calls:
const agent = await provisionAgentAccount(client, operatorId, wallet);
client.setOperator(agent.id, agent.pk);
// Now any contract call from `client` runs with msg.sender == agent.evm.
```

A working version of this pattern (Hardhat-test idiom) lives at
`test/scaffold.js:provisionAgentHederaAccount` in the contracts repo.
Smoke probe at `scripts/testing/agentAliasProbe.js` proves the
flow with `~3 HBAR`.

### What the contract sees

When the agent submits `stash.createBid(token, serials, hbarAmount,
lazyAmount, expiry, minAcceptablePrice, auth)`:

- `msg.sender` = the agent's EVM address (derived from the ECDSA
  pubkey — matches `wallet.address`).
- `auth = (agentKey, reasoningTopicId)` — built via
  `buildAgentAuth(agent.evm, hcs10TopicId)` from the SDK.
- The stash's `_ownerOrAgentMsgSender` check passes when
  `msg.sender == auth.agentKey`. Both reduce to the same EVM address.
- BCF.createBid (called by the stash) then calls back to
  `stash.spendForAgent(auth, ActionType.BidCreate, hbarAmount,
  lazyAmount)`, which runs the envelope verification +
  decrements daily/per-tx caps. Atomic with the bid.

### Stash funding (where the bid's value comes from)

The agent submits the transaction but pays only the **fee** in HBAR
from its own balance (~5 HBAR per agent covers many txs). The bid's
**value** comes from the user's stash — fund the stash with HBAR
and/or LAZY first.

```typescript
// HBAR to stash — use the SDK's sendHbar helper or any TransferTransaction
// where the stash's numeric ContractId is the receiver.
await new TransferTransaction()
    .addHbarTransfer(operatorId, new Hbar(-amount))
    .addHbarTransfer(stashContractId, new Hbar(amount))
    .execute(client);

// LAZY to stash — use LAZYTokenCreator.transferHTS(lazyToken, stashEvm, amount)
// (the pattern the contracts test suite uses to fund stashes for LAZY bids).
// See scripts/ops/snapshotStashOwners.js for the mirror-side analogues.
```

The runtime should never assume stash balance — always pre-check
`mirrorQuery(stash, 'balanceOf')` (LAZY) or
`checkMirrorHbarBalance(stash)` (HBAR) before sizing a bid, and
budget agent envelopes against what the stash actually holds.

---

## First milestone — the SNIPER agent

This is the curated v1 use case (per product). Spec:

> Watch the auction surface for items the user wants. Place bids
> through the user's stash, capped by the agent envelope, using a
> configurable strategy (e.g., snipe in the anti-snipe window with a
> max-bid cap).

Concrete on-chain interactions you'll need:

1. **Read auctions** — `EnglishAuction.getAuctionSnapshot(auctionId)` /
   `getActiveAuctionsForToken(token, offset, limit)` via mirror.
2. **Place a bid through the stash** — the stash exposes
   `placeAuctionBid(auctionId, amount, AgentAuth)`; pass a populated
   `AgentAuth` (built via `buildAgentAuth(agentEoa, hcs10TopicId)`).
   The stash verifies + consumes the envelope budget atomically.
3. **Pre-flight gate** — call `BidderContract.canAuthorize(...)` first
   to fail fast without burning gas on a revert.

The stash holds the funds. The agent's only job is timing + amount
selection. Sovereignty paths (`rescueNFT`, `rescueHbar`,
`detachFromFactory`) are owner-only — the agent cannot touch them.

### Suggested runtime skeleton

```
src/
  agents/
    sniper/
      strategy.ts       # bid amount + timing logic (pure)
      watcher.ts        # mirror polling / event subscription
      executor.ts       # tx submission via marketplace SDK + Agent Kit
  config/
    networks.ts         # testnet / mainnet routing
    accounts.ts         # agent Hedera accounts (env-loaded keys)
  hcs10/
    topic.ts            # HCS-10 reasoning trace (Agent Kit HCS plugin)
  index.ts              # entry: pick agent, start runtime
```

Module responsibilities:

- **`strategy.ts`** — pure function. Takes auction snapshot + user
  config, returns `{ bid: bigint, action: 'wait' | 'bid' | 'pass' }`.
  No I/O, fully testable.
- **`watcher.ts`** — mirror polling for new auctions + bid events.
  Driven by Hedera mirror REST or websocket. Backoff + retry.
- **`executor.ts`** — calldata via marketplace SDK
  (`bidderContractInterface().encodeFunctionData('placeAuctionBid', [...])`),
  signed + submitted via Agent Kit's transaction helpers (which wrap
  `@hashgraph/sdk` underneath).
- **`hcs10/topic.ts`** — Agent Kit's HCS plugin to publish reasoning
  trace; pass the resulting topic id (as `bytes32`) in the `AgentAuth`
  tuple via `buildAgentAuth(agentEoa, topicId)`.

HCS-10 is Hedera's emerging standard for agent reasoning topics. Each
on-chain action carries a `reasoningTopicId` (`bytes32` in the
`AgentAuth` tuple) that off-chain readers correlate to a topic where
you logged the agent's reasoning. Use `0x00...00` if you're not
logging trace yet — that's a valid sentinel.

---

## Reference materials (in the contracts repo)

All in `github.com/Burstall/hedera-SC-LazySecureTrade` on the `v0.3` branch.

### Architecture + design

- **`docs/AGENT-MARKETPLACE-DELTA.md`** — full architectural delta +
  16-row decisions table. Read first.
- **`docs/AGENT-MARKETPLACE-PICKUP.md`** — contract-side pickup items
  (most resolved; some still open). Skim for context on open
  questions.
- **`docs/EnglishAuction-DESIGN.md`** — auction primitive design,
  includes SNIPER integration pattern (~line 381).
- **`docs/VIPSubscription-DESIGN.md`** — paid tier mechanics.
- **`docs/LSHTierLib-DESIGN.md`** — LSH-holdings tier (orthogonal to
  VIP — used for trade fee discount, not envelope caps).
- **`docs/BCF-StashAllowances-DESIGN.md`** — how stash-listed trades
  resolve to the beneficial owner.

### Operational

- **`docs/v0.3-OPS-RUNBOOK.md`** — deployment procedures, gotchas.
- **`docs/v0.3-WORKING-PLAN.md`** — current state of the contracts
  branch; check this for what's shipped vs outstanding.
- **`packages/sdk/README.md`** — SDK install paths, what's in v0.1,
  what's deferred.

### Source of truth

- **`contracts/interfaces/IAgentEnvelope.sol`** — envelope struct,
  enums, errors. The SDK types mirror this exactly.
- **`contracts/interfaces/IBidderContractFactory.sol`** — BCF surface
  including `createTradeOnBehalfOfStash`, `cancelTradeFromStash`,
  envelope-aware `createBid`/`cancelBid`.
- **`contracts/interfaces/IEnglishAuction.sol`** — auction params,
  snapshot struct, events.
- **`contracts/interfaces/IVIPSubscription.sol`** — `Tier` enum (NOTE:
  `LSHTierLib.Tier` is a different enum with different Silver value;
  the SDK types both correctly).
- **`utils/agentAuth.js`** — the JS reference for `AgentAuth`; the
  SDK's `src/helpers/agentAuth.ts` is its TS port.

### Tier table (the locked defaults)

| Tier | Slots | Daily HBAR | Daily LAZY | Per-tx HBAR | Per-tx LAZY |
|------|-------|------------|------------|-------------|-------------|
| Free | 0 | — | — | — | — |
| Bronze | 1 | 500 | 5,000 | 200 | 2,000 |
| Silver | 2 | 1,500 | 15,000 | 500 | 5,000 |
| Gold | 3 | 3,500 | 35,000 | 1,000 | 10,000 |
| Platinum | 5 | 10,000 | 100,000 | 2,500 | 25,000 |

Free tier has 0 slots — Free users cannot run any agents. LSH holders
get 1 free slot **off-chain only** (UX rule, not enforced on-chain) —
the runtime should refuse to provision an agent for a Free-tier user
unless they're an LSH holder, then surface that "free slot" in the
SDK layer.

---

## What NOT to do

- **Don't fork the contracts.** The contracts repo is the single source
  of truth. If you need a contract change, open an issue or PR there.
- **Don't add EIP-712 / ecrecover anywhere in the runtime.** The auth
  model is intentionally msg.sender-only. Re-adding signature
  verification would break ED25519 agents (no EVM precompile on Hedera).
- **Don't try to bypass the envelope** for "convenience." Owner-path
  (`EMPTY_AUTH`) is only valid when the human's EOA is `msg.sender` —
  the runtime, by definition, is not the human's EOA.
- **Don't poll mirror at sub-second rates.** Hedera mirror is a shared
  resource. Use event subscription patterns (websocket / SSE if
  available) and reserve polling for fallback.
- **Don't store the user's private key.** Each agent is its own Hedera
  account with its own key. The user authorizes the agent's address via
  `createEnvelope` on their stash — the runtime never touches the
  user's key.
- **Don't introduce a JS bigint → number cast for any uint96 / uint256
  field.** The SDK's types use `bigint` deliberately; collapsing to
  Number loses precision above 2^53.

---

## First-session checklist

When the `lazy-agent-runtime` repo's first Claude Code session starts:

1. `yarn init -y`. Install peers + both SDKs:
   ```bash
   yarn add @lazysuperheroes/marketplace-sdk \
            @hashgraph/hedera-agent-kit \
            ethers@^6 @hashgraph/sdk@^2.50
   ```
2. Skim `docs/AGENT-MARKETPLACE-DELTA.md` in the contracts repo
   (fetch via WebFetch on the GitHub URL — no clone needed). Also
   skim the Hedera AI Agent Kit docs:
   `https://docs.hedera.com/hedera/open-source-solutions/ai-studio-on-hedera/hedera-ai-agent-kit`
3. Write a smoke test: import the marketplace SDK, call
   `getAddresses('testnet')`, construct an ethers `Interface`, encode
   `cancelBid` calldata with `EMPTY_AUTH`. Verify the bytes round-trip
   via `decodeFunctionData`.
4. Smoke the Agent Kit: create an HCS topic + publish a dummy
   reasoning message; assert the topic id is retrievable.
5. Stand up a single-agent SNIPER skeleton against testnet. Use a
   throwaway agent Hedera account + a throwaway VIP-Bronze stash so
   the budget cap surfaces early.
6. Iterate.

---

## Open questions you'll have to answer

These are deferred from the contracts side and need product/runtime
input:

- **HCS-10 topic format.** The `reasoningTopicId` field is `bytes32`
  in the envelope/auth tuple, but what off-chain schema is the topic
  itself? (Standard HCS-10 message envelope? Custom format? See
  `docs/AGENT-MARKETPLACE-DELTA.md` for what's been discussed.)
- **Multi-agent strategies.** A Platinum user gets 5 slots — how do
  multiple agents coordinate on the same stash without stepping on each
  other's budget? Per-agent allowed-action bitmaps help, but the
  runtime needs to enforce coherent strategy at composition time.
- **Settlement bounty keeper.** EnglishAuction's `settle()` pays a
  keeper bounty. Worth running a settlement-keeper bot alongside the
  user-facing agents? (Probably yes, separate process, separate
  account.)
- **What does an "agent" look like in the consumer UI.** Wallet, name,
  reasoning trace surface, manual override, kill switch (the contract
  exposes `pauseAgent` + `pauseAllAgents`; the UI should too).

Bring these up early — the answers shape the runtime architecture
more than any code decision.
