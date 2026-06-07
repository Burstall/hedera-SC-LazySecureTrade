> **📦 ARCHIVED — one-off handoff prompt.** This was a self-contained
> prompt to be dropped into the `hedera-SC-lazy-lotto` repo. It lives
> here only for history; operational procedure now lives in
> [`docs/v0.3-OPS-RUNBOOK.md`](../v0.3-OPS-RUNBOOK.md).

# LazyTradeLotto Scanner Cutover — Handoff Prompt

> **Drop this file into the root of the `hedera-SC-lazy-lotto` repo as
> `CLAUDE.md` (or paste it as the opening message of a Claude Code
> session there) and the session can start cold. It is self-contained:
> it carries enough context to make the scanner change without reading
> anything in the `hedera-SC-LazySecureTrade` repo first, but links
> every claim to a source of truth.**
>
> **Last updated:** 2026-05-28 (against contracts repo `v0.3` branch).
> Verified against `LazySecureTrade.sol` + `BidderContractFactory.sol`
> at the v0.3 tip. Cross-check the live contract before shipping —
> see "Verify before you trust this doc" at the bottom.

---

## What you're changing and why

LazyTradeLotto credits users for trades they participated in. Today the
off-chain **scanner** watches `LazySecureTrade.TradeCompleted` events,
and for each trade signs an eligibility envelope that lets the
participant call `rollLotto(...)`. The envelope is addressed to the
`seller` / `buyer` addresses straight from the event.

The LST **v0.3** release introduced a per-user **stash** contract
(`BidderContract`, deployed by `BidderContractFactory` / "BCF"). When a
user trades through their stash — placing CLOB bids, arbitrage, or
stash-listed trades — the on-chain `seller` or `buyer` is the **stash
contract address**, not the human's wallet (EOA).

That breaks lotto attribution: a stash address has **no UX path to call
`rollLotto`**, so any credit addressed to a stash is **stranded**. The
fix is one resolve hop: before signing, map any stash address back to
its human owner.

**Your job:** insert that resolve hop into the scanner, between event
parse and envelope signing. Everything else stays the same.

---

## The exact on-chain facts you need

### 1. The event you're already watching

`LazySecureTrade.TradeCompleted` — the **actual** Solidity signature
(LazySecureTrade.sol:84):

```solidity
event TradeCompleted(
    address indexed seller,
    address indexed buyer,
    address indexed token,
    uint256 serial,
    uint256 nonce
);
```

**Important — there is NO `tradeId`, `hbarPaid`, or `lazyPaid` field.**
If any prior doc told you otherwise, it was wrong. The fields are
exactly: `seller`, `buyer`, `token` (all indexed), `serial`, `nonce`.

- The trade's identity, if you need one, is
  `keccak256(abi.encodePacked(token, serial))` (matches LST's internal
  trade key). Compute it off the event; it is not emitted directly.
- `nonce` is the per-`(token, serial)` sequence number. Use it if your
  lotto contract needs replay-distinct identities for repeated trades
  of the same NFT.

### 2. The single BCF call that does the resolution

`BidderContractFactory.stashOwnerOf` is a **public mapping**
(BidderContractFactory.sol:66):

```solidity
mapping(address => address) public stashOwnerOf;
```

Solidity auto-generates a getter, so you call it like a view function:

- `stashOwnerOf(stashAddress)` → the **human owner** EOA.
- `stashOwnerOf(anyNonStashAddress)` → `address(0)`.

That single read answers both questions at once — "is this a stash?"
and "who owns it?". You do **not** need a separate `isValidStash`
pre-check (it exists, also as a public mapping at BCF:99, but it's the
same cost and gives you less information).

### 3. Resolution logic

```javascript
async function resolveStashOwner(bcf, addr) {
    const owner = await bcf.stashOwnerOf(addr);
    // address(0) => not a registered stash (a normal EOA trade), OR a
    // migration replay gap. Either way, attribute to the raw address:
    // better an EOA credit / orphan envelope than a silent miss.
    return owner === ethers.ZeroAddress ? addr : owner;
}

async function attributeTrade(event, bcf, signerKey) {
    const tradeKey = ethers.solidityPackedKeccak256(
        ['address', 'uint256'], [event.token, event.serial],
    );
    const sellerResolved = await resolveStashOwner(bcf, event.seller);
    const buyerResolved  = await resolveStashOwner(bcf, event.buyer);

    // Both sides are always set on a TradeCompleted. Sign one envelope
    // per side — the lotto contract scores both participants.
    return [
        signEnvelope({ recipient: sellerResolved, tradeKey, nonce: event.nonce, side: 'sell' }, signerKey),
        signEnvelope({ recipient: buyerResolved,  tradeKey, nonce: event.nonce, side: 'buy'  }, signerKey),
    ];
}
```

`signEnvelope` is your existing signing function — keep its envelope
schema. The only change is that `recipient` is now the **resolved**
address instead of the raw event address.

---

## Connection details (Hedera testnet)

| Thing | Value |
|---|---|
| `BidderContractFactory` (testnet) | `0.0.9062601` (EVM long-zero: zero-pad the 0x form of the entity num) |
| LST (`LazySecureTrade`, testnet) | `0.0.9057802` |
| Mirror node (testnet) | `https://testnet.mirrornode.hedera.com` |
| BCF ABI source of truth | `hedera-SC-LazySecureTrade/artifacts/contracts/BidderContractFactory.sol/BidderContractFactory.json`, or the published `@lazysuperheroes/marketplace-sdk` package (exports the BCF ABI + address registry) |

> **Addresses move.** `0.0.9062601` is the **current testnet** BCF. The
> mainnet BCF address won't exist until the mainnet deploy. Pin whatever
> the contracts repo's `.env` / SDK `addresses.ts` says at cutover time,
> not this number. Always confirm against the live `.env` in the
> contracts repo before you wire a production signer.

### How to read `stashOwnerOf` without an SDK

It's a plain `eth_call`. Encode `stashOwnerOf(address)` and POST to the
mirror node's contract-call endpoint, or use ethers against the Hashio
JSON-RPC relay (`https://testnet.hashio.io/api`). The contracts repo's
`utils/hederaMirrorHelpers.js` → `readOnlyEVMFromMirrorNode` is a
working reference for the mirror `eth_call` pattern if you want to copy
it rather than run a relay.

---

## Cutover plan

| # | Action | Timing |
|---|---|---|
| 1 | Add `resolveStashOwner` + wire it into the attribution path; key envelopes on the resolved address | Pre-mainnet |
| 2 | `address(0)` fallback: non-stash addresses pass through unchanged | Pre-mainnet |
| 3 | Deploy the scanner update to the production signer with the BCF address pinned to the **mainnet** `BIDDER_FACTORY_CONTRACT_ID` | **Before BCF mainnet activation** |
| 4 | Replay a few testnet trades to confirm envelopes address humans (see verification below) | Pre-mainnet |

### Pre-mainnet verification checklist

Block BCF mainnet activation until each row is signed off. Track these
as issues / PRs in this repo; record the merge commit hash so the
contracts-repo ops runbook §3 can link it.

- [ ] Resolve hop merged; envelopes key on the resolved address.
- [ ] Scanner deployed to the production signer, BCF address pinned to
      mainnet.
- [ ] **Stash-side trade test:** trigger a stash-listed trade on
      testnet (in the contracts repo:
      `scripts/interactions/createTrade.js` against Alice's stash, then
      execute as Bob), and confirm the resulting lotto envelope's
      `recipient` resolves to **Alice's EOA**, not the stash address.
- [ ] **Non-stash trade unaffected:** replay a plain EOA-to-EOA trade
      and confirm the envelope still addresses the EOA directly (no
      spurious stash resolution).
- [ ] **`address(0)` fallback exercised:** call `resolveStashOwner`
      with a random non-stash address; confirm it returns the input
      unchanged.

---

## Failure mode if you ship LATE (after BCF mainnet activation)

Stash trades produce lotto envelopes addressed to stash contract
addresses. Stashes have no UX path to call `rollLotto` → **those lotto
credits are stranded** until the scanner catches up and re-issues
envelopes against resolved owners.

**Cleaner mitigation than retroactive repair:** coordinate with the
contracts-repo ops team to **hold off enabling stash creation on
mainnet BCF until this scanner is live.** There is no on-chain pause on
`deployStash`, so this is an off-chain sequencing agreement, not a
contract control. Cheaper than reconstructing stranded envelopes after
the fact.

---

## Verify before you trust this doc

This prompt is a snapshot. Before you ship, confirm against the live
contract (addresses + signatures drift):

1. **Confirm the event signature.** Pull `TradeCompleted` from the BCF/
   LST ABI you're building against (or grep `LazySecureTrade.sol` in the
   contracts repo). It must be `(seller, buyer, token, serial, nonce)`.
2. **Confirm `stashOwnerOf` exists and is public.** Grep
   `BidderContractFactory.sol` for `stashOwnerOf` — it should be a
   `mapping(address => address) public`. Do a live `eth_call` against
   the testnet BCF with a known stash address and confirm it returns a
   non-zero owner.
3. **Confirm the BCF address.** Read the contracts repo's `.env`
   (`BIDDER_FACTORY_CONTRACT_ID`) or the SDK `addresses.ts` — do not
   trust the number baked into this doc.

If any of the three disagree with this doc, **trust the live contract**
and flag the discrepancy back to the contracts-repo ops owner so the
ops runbook §3 can be corrected.

---

## Source of truth (contracts repo)

- Cutover coordination + checklist: `docs/v0.3-OPS-RUNBOOK.md` §3.
- Beneficial-owner design rationale: `docs/AGENT-MARKETPLACE-DELTA.md`
  and the Phase 1 commits on the `v0.3` branch.
- Why stashes exist at all: `CLAUDE.md` → "v0.3 Bidder architecture".
