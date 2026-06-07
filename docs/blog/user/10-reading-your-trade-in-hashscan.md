# Reading your trade in HashScan — what each line means

> **Audience:** Traders who want to understand what actually
> happened in their transaction receipt, line by line.
> **Read time:** ~7 minutes.
> **Last updated:** 2026-05-27.

You buy an NFT on LazySecureTrade. The transaction succeeds,
the NFT shows up in your wallet, and HashScan (Hedera's block
explorer) has a record with about 15 lines of detail you've
never had to read before.

This post is a Rosetta stone for those lines. By the end you
should be able to look at any LST trade receipt and tell which
line is the price, which is the fee, which is the royalty,
which is the network gas, and which is the weird 1-tinybar
thing.

## A worked example

Let's say you bought NFT serial #42 from a **non-LSH collection**
for 100 HBAR. The seller is Alice; the platform fee is 1%
(Alice doesn't hold LSH); the collection's royalty is 5%.

(If the NFT were an LSH itself — Gen 1, Mutant, or Gen 2 — the
trade would be fee-free regardless of Alice's wallet tier. See
the [Variations to look for](#variations-to-look-for) section
below for that case.)

HashScan's transaction view would show something like this
(simplified):

```
Transaction ID: 0.0.YOU@1700000000.123456789
Status: SUCCESS
Fee: 0.01234 HBAR    (network fee — yours)

HBAR Transfers:
  YOU                  -100.00000000 HBAR
  ALICE                 +94.00000000 HBAR
  LST Contract          +5.00000000 HBAR    (royalty receiver wallet)
  PLATFORM FEE WALLET   +1.00000000 HBAR
  YOU                   -0.00000001 HBAR    (1 tinybar — the custody hop)
  LST Contract          +0.00000001 HBAR    (custody hop received)

Token Transfers:
  Gen2 NFT serial #42:  ALICE → LST Contract → YOU
```

Let's walk through each line.

## Line by line

### `Transaction ID`

Format: `payer@seconds.nanoseconds`. The payer is whoever
submitted the transaction (you, if you bought directly).
The timestamp is Hedera's consensus timestamp — the moment
the network agreed on this transaction's ordering.

You can use this ID to look up the transaction on mirror node
APIs or other Hedera explorers.

### `Status: SUCCESS`

If the trade succeeded, this is SUCCESS. Otherwise it'd show
the failure code (e.g., `INSUFFICIENT_PAYER_BALANCE`,
`CONTRACT_REVERT_EXECUTED`).

For LST trades, `CONTRACT_REVERT_EXECUTED` means the contract
itself rejected the trade — common reasons: trade expired,
seller already cancelled, you don't hold enough HBAR. The
specific reason is encoded in the transaction's
`contractCallResult.errorMessage` field.

### `Fee: X HBAR`

This is the **network fee** — what Hedera charged you to
submit and execute the transaction. NOT the platform fee on
the trade.

For a typical LST buy, this is ~0.01-0.03 HBAR. The number
varies by gas consumed; complex trades (royalty distribution,
HTS token associations) cost more than simple ones.

You pay this whether the trade succeeds or fails. (Reverted
trades still cost network fee for consumed gas — no refunds
on Hedera.)

### HBAR Transfers section

This is where the trade's economic outcome lives. Each line
is one HBAR movement between accounts. Negative = leaving the
account; positive = entering.

In our example:

- **`YOU -100.00000000 HBAR`** — your purchase amount. This
  is what you offered for the NFT.
- **`ALICE +94.00000000 HBAR`** — Alice's proceeds. Note
  this is 100 - 5 (royalty) - 1 (platform fee) = 94. Alice
  receives the trade amount minus all deductions.
- **`LST Contract +5.00000000 HBAR`** — the royalty cut. The
  HTS royalty engine pulls this automatically (see
  [Trading without trusting](05-trading-without-trusting-royalties.md))
  and routes it to the royalty recipient configured on the
  token. The LST contract may temporarily hold it before
  forwarding; you might see the eventual transfer to the
  royalty wallet as a separate transaction.
- **`PLATFORM FEE WALLET +1.00000000 HBAR`** — the platform
  fee. This is LST's revenue. The address is configured at
  contract deploy and visible on chain.
- **`YOU -0.00000001 HBAR`** + **`LST Contract +0.00000001
  HBAR`** — the **custody hop**. The 1-tinybar value-bearing
  marker we explained in
  [Trading without trusting](05-trading-without-trusting-royalties.md).
  It exists to satisfy HTS's "this transfer is against value"
  requirement; the actual money is negligible (1 tinybar =
  0.00000001 HBAR ≈ a fraction of a cent). You authorized it
  via a one-time HBAR allowance to LST when you first set
  up.

Total HBAR movement: 100 leaves you, 94 goes to Alice, 5 goes
to royalty, 1 goes to platform fee, 0.00000001 each way for
the custody hop. The "extra" 1 tinybar from you balances
arithmetically with the 1 tinybar to LST. Net out: you paid
100, the seller got 94, LST got 6 (1 platform + 5 royalty
in-flight), and the custody hop balances at zero.

### Token Transfers section

This is where NFTs move. Note the chain: `ALICE → LST →
YOU`. Two hops, not one. This is the 2-step custody pattern
that makes royalty work — Alice's NFT goes to LST
momentarily, then LST hands it off to you.

You'll see ONE token-transfer entry per NFT in the trade. For
a batch trade buying 5 NFTs, you'd see 5 transfer entries
(plus the corresponding price/fee/royalty splits in the HBAR
section).

The serial number is shown; cross-reference with the
collection's metadata to know which specific NFT moved.

## Variations to look for

### $LAZY-denominated trades

If the trade was paid in $LAZY instead of HBAR, the structure
is similar but you'll see:

- Your wallet → LST Contract → Seller: the $LAZY amount
- Royalty payment in LAZY (if the collection's royalty is
  denominated; some are HBAR-only, some are token-of-the-
  trade)
- **No platform fee** (LAZY trades are fee-free — see
  [What is $LAZY](09-what-is-lazy-token.md))
- Still a 1-tinybar HBAR custody hop (the custody hop is
  always HBAR regardless of trade denomination)

### Stash-mediated trades

If the seller listed via their stash (rather than from their
EOA directly), the seller line says `STASH ADDRESS` instead of
the human's address. The stash held the NFT; the stash
receives the proceeds. The stash owner later withdraws.

This is the kind of trade where beneficial-owner resolution
matters — see
[Beneficial-owner resolution](../technical/11-beneficial-owner-resolution.md)
for the fee-tier implications.

### LSH NFT being sold (item-side exemption)

If the NFT you're trading IS an LSH Gen 1, Mutant, or Gen 2,
the HBAR Transfers section is simpler:

```
HBAR Transfers:
  YOU                  -100.00000000 HBAR
  ALICE                 +95.00000000 HBAR    (full price minus royalty only)
  LST Contract          +5.00000000 HBAR    (royalty cut)
  YOU                   -0.00000001 HBAR    (custody hop)
  LST Contract          +0.00000001 HBAR
```

No `PLATFORM FEE WALLET` line. The item-side LSH exemption
zeroes the platform fee regardless of who the seller is. Alice
nets 95 HBAR instead of 94. The royalty (5%) is paid normally
because royalty is a network-level fee tied to the NFT, not the
marketplace's platform fee.

This route is independent of the seller-tier discount. A
non-LSH-holder selling an LSH-item pays 0% platform fee. An
LSH-Gen-1 holder selling a non-LSH item ALSO pays 0% (via
seller-side discount). Both routes lead to the same line-item
result; the contract's exemption logic uses whichever fires
first.

### Agent-mediated bids

If you placed a bid via an agent (not manually), the
transaction's payer is the AGENT'S Hedera account, not yours.
HashScan shows the agent's address as the submitter; the
funds came from your stash. You'll see your stash's address
in the HBAR Transfers section as the source.

### Batch trades

For a single-tx batch trade (multiple NFTs in one
transaction), the Token Transfers section has multiple
entries — one per NFT. The HBAR Transfers section has
corresponding price/fee/royalty splits.

The whole batch is atomic. If any item fails, the entire
batch reverts and nothing moves.

## What's NOT in the receipt

A few things that affect your trade but don't show up
on-chain:

- **Off-chain price discovery.** Where did you see the
  listing? Frontend / Twitter / Discord. None of that's on
  chain.
- **Allowance grants.** If you set up an HBAR allowance to
  LST in a previous transaction (one-time setup), it's a
  separate transaction with its own receipt — not shown in
  the trade receipt itself.
- **Royalty distribution to final recipient.** If LST pulls
  royalty into its own contract and forwards to the royalty
  wallet, the forward happens in a separate transaction.

The trade transaction is just the swap itself; ancillary
flows (allowance setup, treasury sweeps) are separate.

## Checking your trade went well

Three sanity checks after any trade:

1. **HBAR balance.** Did your wallet's HBAR go down by the
   right amount? Approximately (purchase price + network
   fee + 1 tinybar). The "approximately" handles network
   fee variance.
2. **NFT ownership.** Open HashScan / your wallet to confirm
   the NFT is in your wallet. If it's still in LST's contract
   address, something didn't complete — check the
   transaction status.
3. **Royalty + platform fee.** If you're a buyer, you don't
   pay either of these directly — they come out of the
   seller's proceeds. But you can verify the math: total
   HBAR sent should equal (seller's proceeds + royalty +
   platform fee + custody hop).

If something's off, the transaction status is the first place
to look. `SUCCESS` means everything in the receipt happened.
Anything else means the trade didn't execute as you saw it.

## When to look at HashScan vs. trust the frontend

The frontend's trade history shows you the high-level outcome
("Bought NFT #42 for 100 HBAR"). That's enough for routine
trading.

Use HashScan when:

- A trade behaves unexpectedly (price differs from what you
  expected, fees seem off)
- You're doing accounting / tax reporting (HashScan has the
  authoritative numbers)
- You want to verify the marketplace contracts are doing
  what they say they are (this is the open-source side of
  trustless infrastructure — verify, don't trust)
- You're investigating a stuck or failed trade

For day-to-day, the frontend is fine. HashScan is the
audit trail when you need it.

## Reference

- HashScan testnet: https://hashscan.io/testnet
- HashScan mainnet: https://hashscan.io/mainnet
- The mirror node REST API (for programmatic access):
  https://docs.hedera.com/hedera/mirrornode/mirror-node-api
- The contract that does the 2-step custody hop:
  [`contracts/TokenStakerV2.sol`](https://github.com/lazysuperheroes/hedera-SC-LazySecureTrade/blob/v0.3/contracts/TokenStakerV2.sol).
