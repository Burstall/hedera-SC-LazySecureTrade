# Self-arb / wash-trade guards — why three checks instead of one

> **Audience:** Smart contract developers building marketplace
> primitives, particularly anyone implementing arbitrage paths
> or cross-side trade matching.
> **Read time:** ~8 minutes.
> **Last updated:** 2026-05-27.

`BCF.executeArbitrage` matches a bid against a listed trade and
pays the spread to whoever called it. The economically rational
behavior is: third-party arbitrageurs find profitable mismatches
between LST listings and resting BCF bids, capture the spread,
and the protocol takes a cut.

The unwanted behavior is: a user manipulates their own bid and
listing to create a fake spread, then "arbitrages" their own
trade to launder volume, dodge fees, or pump apparent activity.

This is the **self-trade / wash-trade** attack. The contract
needs to block it. A naive one-line check ("msg.sender !=
bidder") misses two of three attack permutations. The actual
guard is three checks against beneficial-owner-resolved
addresses. This post walks through why.

## The setup: who's who in an arbitrage

Three parties:

1. **Bidder** — the user who placed the resting bid (e.g.,
   "I'd buy any LSH Gen 1 for 100 HBAR").
2. **Seller** — the user who listed an NFT for sale on LST
   (e.g., "Selling Gen 1 #42 for 80 HBAR").
3. **Arbitrageur** — the third party who notices "the bid is
   100, the listing is 80, there's a 20-HBAR spread" and
   calls `executeArbitrage` to capture it.

For an honest arbitrage, all three are distinct humans. The
arbitrageur risks their gas to capture the spread, the bidder
gets the NFT they wanted at the price they bid, the seller gets
their asking price, the protocol takes a cut, the system works.

For a self-trade attack, two or three of these are the same
human in disguise:

- **Bidder == arbitrageur**: a bidder arbing their own bid.
  Could pump fake spread (place a bid at 100, list at 80, arb
  yourself, capture the 20 HBAR back).
- **Seller == arbitrageur**: same but from the listing side.
- **Bidder == seller**: same human on both sides, third party
  arbing. The third party makes money; the human launders
  volume against themselves.

All three need to be blocked.

## The three-condition guard

```solidity
address bidOwner = _resolveBeneficialOwner(bid.user);
address sellerOwner = _resolveBeneficialOwner(trade.seller);
if (
    effectiveCaller == bidOwner ||
    effectiveCaller == sellerOwner ||
    bidOwner == sellerOwner
) {
    revert SelfTradeBlocked();
}
```

Three independent conditions, OR'd. Any single match blocks
the trade.

The conditions in plain English:

1. `effectiveCaller == bidOwner` — "the arbitrageur is the
   person who placed the bid." Blocks bidder-as-arbitrageur.
2. `effectiveCaller == sellerOwner` — "the arbitrageur is the
   person who listed the NFT." Blocks seller-as-arbitrageur.
3. `bidOwner == sellerOwner` — "the bidder and seller are the
   same person." Blocks bidder-equals-seller (regardless of
   who arbitrages).

If you removed any one condition, you'd leave an attack
vector. Let's walk through what each blocks specifically.

## Condition 1: effectiveCaller == bidOwner

**Attack:** Bob places a bid at 100 HBAR. Bob's stash holds 100
HBAR (backing the bid). Bob also has a side wallet that lists
an LSH at 80 HBAR. Bob (via the side wallet) calls
`executeArbitrage` to match his own bid against the side
wallet's listing.

What happens without this check: 100 HBAR moves from Bob's
stash to Bob's side wallet (minus 80 HBAR to a fake "seller"
who is actually Bob); Bob captures the 20 HBAR spread; Bob
self-laundered the volume + showed it as legitimate trading
activity.

The block: `effectiveCaller` resolves Bob's side-wallet
address through `_resolveBeneficialOwner` — if that's Bob's
stash owner, it equals `bidOwner`. The trade reverts.

This is the most direct self-arb. Easiest to detect, easiest
to block.

## Condition 2: effectiveCaller == sellerOwner

**Attack:** Alice listed an NFT at 80 HBAR. A non-Alice party
places a bid at 100. Alice notices the spread and calls
`executeArbitrage` herself.

Why this is bad: Alice gets paid 80 HBAR (her ask) AND gets
the arbitrage spread of 20 HBAR. The bidder pays 100 HBAR
(their bid) and gets the NFT. From the bidder's perspective
nothing is wrong — they bid 100, they get the NFT they
wanted. From Alice's perspective she made an extra 20 HBAR
on top of her ask.

It's not exactly fraudulent — Alice could just have priced
her ask at 100 in the first place. But the arbitrage path
exists for THIRD parties to capture spreads, not for the
seller to double-dip on the same trade. The protocol's
arbitrage fee split was sized assuming third-party
arbitrageurs; sellers self-arbing breaks the economic model
because they're double-collecting.

The block: `effectiveCaller == sellerOwner` blocks this.
Alice (via any wallet she controls that resolves to her
beneficial owner) can't act as the arbitrageur on her own
listing.

## Condition 3: bidOwner == sellerOwner

**Attack:** Alice places a bid via her stash at 100 HBAR. Alice
ALSO lists an NFT (via her side wallet OR a different stash)
at 80 HBAR. A third party — Carol — notices the spread and
arbitrages.

Without the third check, Carol's arbitrage succeeds: 100 HBAR
moves from Alice's stash; 80 HBAR goes to Alice's side wallet
(the seller); 20 HBAR spread is split 50/50 between Carol and
the protocol per `arbitragePayoutBps`. Carol gets 10 HBAR
profit on legit work.

But from Alice's perspective, she just moved 100 HBAR from
her stash to her side wallet, MINUS the 10 HBAR Carol kept
and the 10 HBAR the protocol kept. She lost 20 HBAR (the
spread) but gained the trade volume showing on her addresses.
She's paying 20 HBAR for "trade laundering" — which is a
deliberate choice she might want to make if she's trying to
inflate her trading-volume reputation to manipulate something
downstream (e.g., a leaderboard).

The block: `bidOwner == sellerOwner` catches this even when
the arbitrageur is innocent. Alice can't have both legs of an
arbitrage attributable to her own beneficial owner.

This is the subtlest of the three blocks and the one that's
easiest to forget. Without it, a wash-trader can use a willing
third-party arbitrageur as a cooperative laundromat.

## Why beneficial-owner resolution is load-bearing here

Notice that all three checks use the `_resolveBeneficialOwner`
function (see [Beneficial-owner resolution](./11-beneficial-owner-resolution.md)).
Why?

Imagine the checks were against literal `msg.sender`:

- `msg.sender == bid.user` — a user could bypass by calling
  through their stash. msg.sender becomes the stash address;
  bid.user is the user's EOA. They don't match. Bypassed.
- `msg.sender == trade.seller` — same. Listed via stash;
  arbed via EOA. Different msg.sender, bypassed.

The beneficial-owner layer collapses "user's EOA" + "user's
stash" + "user's other stash" into a single identity. The
guard becomes attacker-resistant because identity is resolved
at the human level, not the address level.

## The compound case: caller IS the agent

The agent path adds another wrinkle. When an agent calls
`executeArbitrage` via a stash, `msg.sender` is the stash
contract (not the agent's EOA). The `_resolveAgentOrOwner`
function inside `executeArbitrage` resolves this:

```solidity
(address effectiveCaller, address agentKeyForEvent, bytes32 reasoningTopic)
    = _resolveAgentOrOwner(auth, callerStash, ActionType.Arbitrage, 0, 0);
```

- **Owner path** (`auth.agentKey == 0`): `effectiveCaller` is
  the beneficial owner of `msg.sender` (the literal caller).
- **Agent path** (`auth.agentKey != 0`): the caller passes the
  stash they're acting on behalf of (`callerStash`) as a
  parameter. The function verifies the envelope and sets
  `effectiveCaller` to the BENEFICIAL OWNER of that stash.

Either way, by the time the three-condition guard runs,
`effectiveCaller` is the human-level identity of whoever is
trying to arbitrage. The guard's logic is the same regardless
of which path was used.

## What this DOESN'T catch

Honest scope:

- **Two different humans cooperating.** If Alice and Bob have
  an off-chain agreement to wash-trade, where Alice places a
  bid, Bob lists a matching NFT, and Carol (paid off-chain by
  Alice and Bob) arbitrages — the three on-chain identities
  ARE distinct beneficial owners. The contract can't prove
  the off-chain conspiracy. This is a general limitation of
  on-chain identity verification; we can't solve it without
  off-chain attestation.
- **Sybil attacks at scale.** A single human with N wallets
  spread across N different humans (e.g., via paid mules)
  defeats beneficial-owner resolution because each wallet has
  a different `stashOwnerOf`. Defending against this requires
  off-chain identity (KYC, social verification, etc.) which
  we don't ship and don't intend to.

Beneficial-owner resolution is necessary but not sufficient.
It catches the easy attacks. Determined wash-traders with
budget and operational sophistication can evade it. That's
fine — the goal is to prevent the easy/casual attacks and
make the sophisticated ones costly.

## The 50/50 split as additional deterrent

Even if a wash-trader gets all three identity gates lined up
(through Sybils etc.), the arbitrage profit is split 50/50
with the protocol via `arbitragePayoutBps`. So the wash-trader
keeps half the spread; the other half flows to the protocol's
profit pool.

The split is configurable (`setArbitragePayoutBps` is
owner-controlled with a 48h timelock, capped at 100%
arbitrageur share). If we wanted to discourage sophisticated
wash-trading further, we could push the protocol's share
higher — make the spread less profitable to fake.

Currently it's 50/50 because the primary purpose is
incentivizing legitimate arbitrageurs, not discouraging
wash-traders. The identity guards do most of the
wash-prevention work; the split is a back-stop.

## Reference

- The 3-condition guard lives in
  [`contracts/BidderContractFactory.sol`](https://github.com/lazysuperheroes/hedera-SC-LazySecureTrade/blob/main/contracts/BidderContractFactory.sol).
  Search for `SelfTradeBlocked`.
- The companion
  [Beneficial-owner resolution](./11-beneficial-owner-resolution.md)
  post explains the resolution function in depth.
- The `BCF` test suite covers all three permutations — search
  the
  [BCF test suite](https://github.com/lazysuperheroes/hedera-SC-LazySecureTrade/blob/main/test/BidderContractFactory.test.js)
  for `SelfTradeBlocked` to see the assertions.
- The agent-mediated arbitrage path is tested in
  [`test/AgentEnvelopeFull.test.js`](https://github.com/lazysuperheroes/hedera-SC-LazySecureTrade/blob/main/test/AgentEnvelopeFull.test.js)
  under AE10.3.
