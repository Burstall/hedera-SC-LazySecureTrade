# First-time agent setup — a walkthrough

> **Audience:** Users setting up their first trading bot on
> LazySecureTrade. Assumes you have a wallet and have used the
> marketplace at least once manually.
> **Read time:** ~8 minutes.
> **Last updated:** 2026-05-27.

You've decided to run a bot. Maybe a SNIPER for auctions you
care about, maybe a standing bidder on a collection, maybe an
arbitrageur. The actual "what kind of bot" decision is a
strategy question; this post is about the **setup** — the
mechanical steps from "I want a bot" to "my bot just made
its first transaction."

The flow has 6 steps. Each is small. The whole thing should
take ~15 minutes assuming nothing goes sideways.

## Step 1: Decide whether to use a hosted runtime or run your own

Two options:

- **Hosted runtime** (when available — likely launching
  alongside or shortly after mainnet). You sign in via
  HashConnect; the platform provisions the agent account for
  you, hosts the bot software, charges a subscription fee on
  top of LST's. Lowest friction, less control.
- **Self-hosted runtime.** You spin up the bot software on
  your own machine / VPS, manage the agent's private key
  yourself, configure strategy yourself. More work, more
  control, no platform fees.

This post covers self-hosted because it's the more involved
path. Hosted abstracts most of these steps but the underlying
mechanics are the same.

## Step 2: Subscribe to a tier

Open the LST frontend, go to Subscription, pick a tier (see
[When is a subscription worth it?](07-when-is-a-subscription-worth-it.md)).
Pay in $LAZY. The frontend handles the payment + the
agent-tier authorization on your stash.

If you're an LSH NFT holder, the frontend will offer the
holder discount during checkout. Accept the proof flow if
you qualify.

After purchase, your stash's `getTierFor(you)` returns the
purchased tier. The agent slots are now available; you can
authorize agents up to that tier's slot count.

If you're already subscribed at the tier you want, skip this
step.

## Step 3: Generate the agent's wallet

The agent needs its own Hedera account. This account is
SEPARATE from your wallet. The agent has its own private key;
that key never touches your wallet.

For self-hosted, generate an ECDSA wallet using whatever
tooling you have:

```bash
# Using the ethers CLI:
npx ethers --wallet new

# Or write a tiny script:
node -e "
  const { Wallet } = require('ethers');
  const w = Wallet.createRandom();
  console.log('Address:', w.address);
  console.log('Private key:', w.privateKey);
"
```

Save the private key to a secure file (not in your code
repo; not in a Slack message; not anywhere indexed). The
agent's key controls the agent's account — same security
practice as any wallet key, just for an agent.

The agent's EVM address (`wallet.address`) is what you'll
authorize on your stash in step 5.

## Step 4: Fund the agent's Hedera account

The agent needs HBAR to pay transaction fees. NOT to spend
on bids — that comes from your stash. Just gas money.

Plan for ~5 HBAR per agent for a comfortable runway (handles
dozens to hundreds of txs).

The funding step uses the **alias-key auto-create pattern**.
From your wallet (or your runtime's operator account), send
HBAR to the agent's address. The first transfer
auto-creates the Hedera account with the ECDSA key.

If you're doing this manually:

```javascript
// Conceptual — the bot runtime does this for you
const aliasAccountId = ecdsaKey.publicKey.toAccountId(0, 0);
await new TransferTransaction()
    .addHbarTransfer(yourAccount, new Hbar(-5))
    .addHbarTransfer(aliasAccountId, new Hbar(5))
    .execute(client);
```

If the bot software handles it, you provide the agent key +
funding amount in config; the software does the rest. See
[Building a SNIPER agent in ~80 lines](../technical/01-building-a-sniper-agent.md)
for the technical recipe.

Verify the funding worked by querying the account on
HashScan: look up the agent's address; you should see a
fresh account with ~5 HBAR.

## Step 5: Authorize the agent on your stash

This is the only step that requires YOU (the human) to sign
a transaction. From your wallet, call `createEnvelope` on
your stash with the agent's parameters:

```javascript
// Frontend will wrap this; here's what's happening conceptually
stash.createEnvelope({
    agentKey: '0x...your agent\'s EVM address',
    dailyHbarCap: 500e8,         // 500 HBAR in tinybars
    dailyLazyCap: 5000n * 10n**8n,
    perTxHbarCap: 200e8,
    perTxLazyCap: 2000n * 10n**8n,
    expiresAt: 0,                // 0 = no expiry (within tier window)
    allowedActions: 0xFFFFFFFF,  // OR specific action bits
    reasoningTopicId: ethers.ZeroHash,  // 0 unless using HCS-10
});
```

Pick values appropriate to your tier and strategy:

- **`dailyHbarCap`** — total HBAR the agent can spend per UTC
  day. Cap at or below your tier's limit.
- **`perTxHbarCap`** — max for a single transaction.
  Belt-and-braces against runaway logic. Should be ≤
  `dailyHbarCap`.
- **`allowedActions`** — bitmap of which actions the agent
  can take. Common patterns:
  - `(1 << 7)` = AuctionBid only — for a sniper
  - `(1 << 0) | (1 << 1)` = BidCreate + BidCancel — for a
    CLOB bidder
  - `0xFFFFFFFF` = everything — flexible bot
- **`expiresAt`** — Unix timestamp when the envelope
  auto-expires. 0 = never. Useful to set if you're testing a
  new bot ("expires in 30 days; renew if it's working").

Submit. The transaction's gas comes from your wallet (~0.1
HBAR or so). The envelope is now live on your stash.

You can read it back via mirror node: `stash.getEnvelope(agentEvm)`
returns the struct you just set.

## Step 6: Fund the stash (if it isn't already)

The agent submits transactions but the BIDS come from your
stash's balance. If your stash already has HBAR (because
you've been using it for manual trading), it can back the
agent's bids.

If not, top it up. Send HBAR from your wallet to your stash
address. The stash deterministically lives at an address you
can compute off-chain (see
[CREATE2 stash addresses](../technical/03-create2-stash-prediction.md))
or look up via `BCF.getStashOf(you)`.

Same for $LAZY if you plan to run LAZY-denominated bids.

Rule of thumb: keep at least the agent's daily HBAR cap worth
in the stash. That way the agent can hit its budget on a busy
day without you topping up mid-day. Plus a buffer for
mid-flight bids that haven't settled yet.

## Step 7: Start the bot

If you wrote your own bot, start it. The bot:

1. Loads its config (agent key, strategy params, your stash
   address).
2. Sets its operator account to the agent (`client.setOperator(agentId, agentKey)`).
3. Polls mirror node for relevant events (auctions starting,
   bids being outbid, whatever your strategy watches).
4. Submits `placeAuctionBid` / `createBid` / etc. transactions
   when the strategy says so, with a populated `AgentAuth`
   tuple pointing at your envelope.
5. Logs everything (you'll want to debug).

If you're using a hosted runtime, you sign in to the platform
and configure your strategy parameters through the UI; the
hosted code does steps 2-5 above.

The bot's first transaction will fail if step 5 (authorize)
or step 6 (fund) were skipped. The revert names are explicit
(`EnvelopeAuthFailed`, `InsufficientBalance`) — log them, fix
the gap, restart.

## Common first-run failures

A few things to expect:

### `EnvelopeAuthFailed(agent, NotFound)`

The envelope you set in step 5 doesn't exist. Check the
agent EVM address in the bot config matches the one you
authorized. Also check the bot is calling YOUR stash, not
someone else's.

### `PAYER_ACCOUNT_NOT_FOUND`

The agent's Hedera account doesn't exist or isn't being
referenced correctly. This is the alias-key gotcha — see
[Building a SNIPER agent](../technical/01-building-a-sniper-agent.md)
"The recipe" for the right pattern. If you're using a
hosted runtime they handle this; for self-hosted, ensure
you're using the agent's NUMERIC AccountId (resolved via
`AccountInfoQuery`), not the long-zero form.

### `PerTxCapExceeded`

The bot tried to bid more than `perTxHbarCap`. Either lower
the bid or raise the cap (cancel + recreate envelope with
higher cap).

### `BudgetExhausted`

The day's HBAR budget is exhausted. Wait for UTC midnight
or raise `dailyHbarCap`.

### `InsufficientBalance`

Your stash doesn't have enough HBAR/LAZY to back the bid.
Top up the stash.

## Monitoring your bot

Once it's running, watch for two things:

1. **`EnvelopeBudgetConsumed` events.** Every successful
   agent action emits this; off-chain dashboards can show
   you "how much has the bot spent today vs cap."
2. **Strategy outcomes.** Did the bot win the auctions you
   wanted? Did its bids match? Track this in whatever
   analytics layer you have.

If the bot is misbehaving, you have a single-click kill
switch: `stash.pauseAgent(agentEvm, true)`. The agent's next
transaction reverts; the bot stops doing damage; you
investigate. Toggle off when ready.

## Iteration

First-run bots almost always need tuning:

- Caps that seemed reasonable are actually too low (or too
  high)
- Strategy logic has edge cases the test scenario didn't
  cover
- The bot is too aggressive (or not aggressive enough)

Plan to iterate. Re-tune the envelope (cancel + recreate is
the only update path) or re-tune the strategy code. The
underlying infrastructure stays stable; the parameters and
logic evolve.

Once it's working, you're done. Your bot is autonomous within
the budget you set; you can sleep through the auction sniping.

## Where to next

- [Building a SNIPER agent in ~80 lines](../technical/01-building-a-sniper-agent.md) — code-level walkthrough
- [Agent envelopes — your AI trader, your rules](03-agent-envelopes-plain-english.md) — what the permission slip actually does
- [Hedera vs Ethereum for NFT traders](04-hedera-vs-ethereum-for-nft-traders.md) — if you're coming from Ethereum and need orientation

## Reference

- The contract surface for envelopes:
  [`contracts/interfaces/IAgentEnvelope.sol`](https://github.com/lazysuperheroes/hedera-SC-LazySecureTrade/blob/v0.3/contracts/interfaces/IAgentEnvelope.sol).
- The runtime bootstrap doc:
  [`docs/AGENT-RUNTIME-BOOTSTRAP.md`](https://github.com/lazysuperheroes/hedera-SC-LazySecureTrade/blob/v0.3/docs/AGENT-RUNTIME-BOOTSTRAP.md).
