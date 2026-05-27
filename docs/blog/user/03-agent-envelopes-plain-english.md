# Agent envelopes — your AI trader, your rules

> **Audience:** Anyone thinking about delegating trading to a bot
> or AI agent.
> **Read time:** ~8 minutes.
> **Last updated:** 2026-05-27.

Here's a problem.

You want a bot to snipe auctions on your behalf. The bot can watch
the marketplace 24/7 while you sleep; you can't. But you also
don't want to hand the bot your wallet's private key, because then
the bot could drain your wallet, take a loan, send your NFTs to a
mixer, whatever — anything *you* can do.

Most marketplaces solve this with a fragile workaround: you sign a
permission token off-chain, the bot submits it on-chain, and the
contract trusts that the signature matches. If the signing
infrastructure leaks the key, you're in the same trouble as if
you'd handed over the wallet.

We solve it differently.

## The envelope concept

An **agent envelope** is a permission slip stored *on your stash
contract* that names one specific wallet (the agent's) and bounds
exactly what that wallet can do. It's not a signature you generate.
It's not a JSON Web Token. It's a small storage record on your
stash, written by you, that the marketplace contracts consult
every time the agent tries to act.

Think of it like a corporate AmEx with a monthly limit and an
approved-merchants list. The card is in someone else's hand, but
the bank rules constrain what they can do with it.

An envelope has these fields:

- **agentKey** — the EVM address of the agent's wallet. Hedera
  has already verified the agent owns this wallet's private key
  by the time the transaction reaches the contract.
- **dailyHbarCap** — how much HBAR the agent can spend in a UTC
  day. Resets at midnight.
- **dailyLazyCap** — same, for $LAZY.
- **perTxHbarCap / perTxLazyCap** — single-transaction caps.
  Belt-and-braces against a runaway bid.
- **expiresAt** — when the envelope auto-expires. 0 means "no
  expiry," but your VIP tier might still cap the maximum.
- **allowedActions** — a bitmap of which marketplace actions the
  agent can take. You can let it only bid; or only auction-bid;
  or all of bid+arb+trade+auction. Your choice.
- **paused** — instant kill switch. Toggle and the agent is
  blocked until you toggle back.

Every time the agent tries to spend money, the stash checks: does
the envelope exist? is it expired? is the action allowed? does the
spend fit in the per-tx cap? does it fit in the remaining daily
budget? Any "no" means the transaction reverts.

## Why the agent has its own wallet

The agent's private key is **not yours**. Period. The agent
account is generated separately, lives separately, and has its
own HBAR balance (small — just enough to pay tx fees, maybe 5
HBAR).

If the agent gets compromised — say a bug in the runtime
software exposes the agent's key — the worst case is bounded by
your envelope: the attacker drains the daily HBAR budget, drains
the daily LAZY budget, then hits the cap and stops. They cannot
touch your wallet, cannot drain your stash beyond the envelope,
cannot extract NFTs that aren't part of an authorized action.

Your wallet stays untouched throughout. The attacker has to wait
24 hours for the daily reset (if you haven't paused them by then)
or hope you've put a huge daily cap on the envelope.

This is what "least privilege" looks like in a marketplace
context.

## What you can do that the agent can't

A bunch of things are owner-only and the agent path can't touch
them, even with `allowedActions = 0xFFFFFFFF`:

- **Rescue funds** (`rescueHbar`, `rescueLazy`, `rescueNFT`) —
  the emergency-drain paths. Owner-only because they bypass other
  guards.
- **Detach from factory** (`detachFromFactory`) — the nuclear
  option for cutting the marketplace cord.
- **Create or cancel envelopes** — you, and only you, can author
  permission slips on your stash. An agent can never grant
  another agent.
- **Pause the global kill switch** (`pauseAllAgents`) — disables
  every agent on your stash atomically. Single function call, no
  enumeration needed.

The contract enforces this with a check at the entry of every
agent-callable function: if the signer is *you* (the stash owner),
the privileged paths open; if it's an authorized agent, only the
budgeted paths open; if it's anyone else, every path closes.

## Walking through a worked scenario

You're a Bronze subscriber. Your envelope budget is:

- Daily HBAR cap: 500 HBAR
- Daily LAZY cap: 5,000 LAZY
- Per-tx HBAR cap: 200 HBAR
- Per-tx LAZY cap: 2,000 LAZY
- Allowed actions: bid create + bid cancel + auction bid

You spin up a SNIPER bot to bid on three collections. The bot is
running on your laptop, configured with the agent's wallet
private key (which exists only on that laptop). You authorize the
agent on your stash by calling `createEnvelope(...)` from your
wallet, with the parameters above.

**8:00 AM** — bot watches an auction. Auction snipe window
opens. Bot submits `placeAuctionBid(auctionId, 50 HBAR, false,
agentAuth)`. Stash sees: 50 < 200 (per-tx cap), 50 < 500
(remaining daily), AuctionBid is in allowedActions, agent
matches msg.sender, envelope active, not expired. ✓ Bid placed.
Stash's `consumedHbarToday` = 50.

**10:00 AM** — bot snipes another. 75 HBAR. Stash: 75 < 200, 75
< 450 remaining, ✓. consumedHbarToday = 125.

**3:00 PM** — auction starts heating up. Bot wants to bid 250
HBAR. Stash: 250 > 200 (per-tx cap). ✗. Reverts
`PerTxCapExceeded`. Bot logs the failure; no money moves.

**4:00 PM** — bot tries again with 180 HBAR. Stash: 180 < 200,
180 < 375 remaining, ✓. consumedHbarToday = 305.

**5:00 PM** — bot tries 200. Stash: 200 ≤ 200, 200 ≤ 195. Wait
— `BudgetExhausted`. The day's 500 cap is at 305 + 200 = 505 >
500. ✗. Reverts. consumedHbarToday stays at 305.

**Midnight UTC** — daily reset. consumedHbarToday goes to 0. Bot
can spend again.

**Next morning** — you notice the bot bid wildly yesterday. You
call `pauseAgent(agentAddress, true)`. Bot's next bid attempt
reverts `EnvelopeAuthFailed(Paused)`. You investigate, find a
configuration error, fix it, then `pauseAgent(agentAddress,
false)` to resume.

At no point did the attacker (or the rogue bot) reach your
wallet, your stash's owner-only rescue paths, or your authority
to authorize new envelopes. The blast radius was capped at the
envelope's daily budget.

## What about multiple agents?

VIP tiers control how many agents you can authorize. Platinum
gives you 5 slots; Bronze gives you 1. You can run a sniper bot
for auctions, a bidder bot for the CLOB, and an arbitrageur bot
that hunts profitable spread between LST and BCF — each with its
own envelope, its own daily budget, its own allowed actions.

They share the stash's funds (so the budgets are constraints, not
allocations from a pool), but their permissions are independent.
Pausing one doesn't pause the others. Burning through one's
daily cap doesn't affect the others'.

## What you should NOT do

A few footguns to avoid:

- **Don't store the agent's key on a public server.** It's a
  Hedera account; the only thing it costs you if it leaks is the
  envelope's daily budget. But that's still real money. Treat it
  like any other key.
- **Don't set the daily cap to "everything you have."** The point
  of the envelope is to bound the loss. If your daily cap equals
  your stash balance, the envelope is approximately useless.
- **Don't grant a contract address as the agent.** The contract
  rejects this at envelope-creation time with
  `AgentKeyIsContract`. Reason: contracts can be called by
  anyone; the envelope can't tell who is "behind" a contract.
  Only EOA wallets allowed.
- **Don't expect the envelope to police logic.** It enforces
  budgets and permissions, not strategy. If you tell your bot to
  bid 100 HBAR on every auction it sees, it'll keep doing that
  until the daily cap exhausts. The envelope is a budget, not a
  conscience.

## How to think about this

Most "agent" promises in crypto end up needing trust — either you
trust the off-chain signer, or you trust the bot operator, or you
hand over a session key with too much power. The envelope model
moves the trust assumption from "the agent won't misbehave" to
"the contract will enforce the limits I set."

That's a smaller trust surface. You can audit the limits. You can
adjust the limits. You can revoke entirely with a single
transaction. The bot operates inside a sandbox you defined.

For automated marketplace trading — sniping, arbitrage, DCA-style
bid laddering — that's the right shape. It's not a panacea (a
bot that's *bad at its job* still loses money inside the
envelope), but it converts a key-custody problem into a budget-
sizing problem, and budget-sizing is something you can iterate on
without exposure to total loss.
