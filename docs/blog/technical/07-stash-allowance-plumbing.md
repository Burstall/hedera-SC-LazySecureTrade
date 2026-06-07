# Stash allowance plumbing — HIP-906 + per-serial NFT approvals

> **Audience:** Solidity developers integrating contract-as-buyer
> or contract-as-seller flows on Hedera, especially around HTS
> royalty handling.
> **Read time:** ~11 minutes.
> **Last updated:** 2026-05-27.

This is one of those "the doc you wish you had when you started"
posts. The stash contract (BidderContract) needs to grant
allowances *as a contract* — HBAR allowances to the LST
marketplace, NFT allowances per-serial — and Hedera's tooling
for this is non-obvious if you've only used EOA-side
`AccountAllowanceApproveTransaction` from the SDK.

The contract-side patterns we settled on took multiple design
passes to land. This post documents the as-shipped surface.

## The two allowance problems

When the stash participates in a trade flow, two allowance
gaps surface.

### Problem 1: stash-as-buyer HBAR allowance

LST's NFT-against-value transfer uses a 2-step custody hop
(see [Trading without trusting](../user/05-trading-without-trusting-royalties.md)).
The second leg moves the NFT from LST to the receiver and pulls
1 tinybar from receiver to LST as the "value-bearing" marker.
The 1 tinybar uses `isApproval=true` — meaning it's pulled via
allowance.

For an EOA buyer, the wallet grants this allowance via
`AccountAllowanceApproveTransaction` (the SDK's
`approveHbarAllowance`). For a stash-as-buyer (bid execution,
arbitrage), the buyer is a *contract*, and contracts can't be
the source of an `AccountAllowanceApproveTransaction` — that
transaction requires an account key signature, which contracts
don't have.

How does a contract grant its own HBAR allowance? Via HIP-906.

### Problem 2: stash-as-seller NFT allowance

When a stash lists an NFT (via `stash.createTrade(...)`), LST
records the stash as the trade's `seller`. At execution, LST
pulls the NFT from the stash to itself via a `cryptoTransfer`
where LST is the spender. That transfer requires the stash to
have granted LST a per-serial NFT allowance.

EOA sellers grant this via the SDK's
`approveTokenNftAllowance`. Stashes need to do it from inside
the contract — through the IERC721 facade or the HTS
precompile.

Both problems share the shape: "I'm a contract; I need to grant
an allowance to another address; I can't use the SDK's
account-allowance transaction."

## The HIP-906 path for HBAR allowances

HIP-906 introduces a "Hedera Account Service" (HASC) system
contract at address `0x16a`. It exposes `hbarApprove(owner,
spender, amount)` — the contract-callable analogue of the SDK's
HBAR allowance transaction. The contract itself becomes the
owner; HASC routes the approval through the network's account
allowance state.

The stash implements it like this:

```solidity
address internal constant HEDERA_ACCOUNT_SERVICE = address(0x16a);

function _hbarApprove(address spender, int256 amount) internal {
    (bool ok, bytes memory ret) = HEDERA_ACCOUNT_SERVICE.call(
        abi.encodeWithSignature(
            "hbarApprove(address,address,int256)",
            address(this),    // owner = the stash itself
            spender,
            amount
        )
    );
    if (!ok) revert HbarAllowanceFailed(HBAR_APPROVE_CALL_FAILED);
    if (ret.length < 32)
        revert HbarAllowanceFailed(HBAR_APPROVE_MALFORMED_RETURN);
    int32 rc = abi.decode(ret, (int32));
    if (rc != HederaResponseCodes.SUCCESS)
        revert HbarAllowanceFailed(int64(rc));
}
```

A few things to notice:

1. **The first argument is `address(this)`.** HASC takes the
   owner explicitly — it doesn't infer "owner = caller" the
   way a delegatecall might.
2. **The return is `int32`.** The Hedera response codes are
   signed 32-bit integers; we widen to `int64` for the error
   field so we have negative-space for synthetic failure
   modes (call-returned-ok=false, malformed return data).
3. **The error catalog distinguishes three failure modes.**
   `HBAR_APPROVE_CALL_FAILED = -1` for "HASC missing on this
   network," `HBAR_APPROVE_MALFORMED_RETURN = -2` for "HASC
   responded but with empty data," and `rc > 0` for "HASC
   responded with a real Hedera error code." Ops can
   disambiguate from the error data.

The corresponding read function — "what's my current HBAR
allowance to `spender`?" — is `hbarAllowance(owner, spender)`,
also on HASC, also a contract-side call. The stash uses it to
implement a lazy-refill pattern (see below).

## Lazy refills and the floor

The custody-hop pattern means LST needs an HBAR allowance from
the stash of at least 1 tinybar per executed trade. If the
stash starts with a 10-billion-tinybar allowance to LST and
executes 1 billion trades, it'll need refilling at some point.

The naive pattern would be "grant allowance once, manually
re-grant when it runs low." Brittle — easy to forget, and the
failure mode is silent (trades start reverting).

The shipped pattern is a lazy refill check inside
`executeTrade`:

```solidity
uint256 public constant CUSTODY_HOP_ALLOWANCE_REFILL = 1_000_000_000;   // 10 HBAR
uint256 public constant CUSTODY_HOP_ALLOWANCE_FLOOR  = 100_000_000;     // 1 HBAR

function _ensureHbarAllowanceForCustodyHop(address spender) internal {
    int256 current = _hbarAllowanceTo(spender);
    if (current >= int256(CUSTODY_HOP_ALLOWANCE_FLOOR)) return;
    _hbarApprove(spender, int256(CUSTODY_HOP_ALLOWANCE_REFILL));
}
```

Every `executeTrade` call checks the stash's allowance to LST.
If it's below 1 HBAR worth (still ~1 billion custody hops
available — generous floor), we refill to 10 HBAR (10 billion
hops). 1 HBAR floor with 10 HBAR ceiling means refills happen
in long sweep cycles — typically once per stash, ever, in
practice — and the bounded ceiling caps the blast radius if
LST were ever compromised (max 10 HBAR drainable per stash via
the custody-hop vector before the owner can intervene).

The numbers are constants so no admin key can weaken them.

## Per-serial NFT allowances

For NFT allowances, the stash uses `IERC721.approve(spender,
tokenId)`. Sounds simple — and it is, with one Hedera quirk.

```solidity
function _approveNFTTo(address token, address spender, uint256 serial) internal {
    if (token == address(0)) revert InvalidAddress();
    IERC721(token).approve(spender, serial);
}
```

**Routing through the IERC721 facade at the token's own address,
not the HTS precompile at 0x167.** This is the Hedera quirk:
the HTS precompile path for `approveNFT` reverts with no data
when a *contract* is the NFT owner on testnet (verified
empirically in our P5.8 probe). The same call routed via the
ERC-721 facade at the token's own address works for both EOA
and contract owners.

The reason for the HTS-side failure isn't documented anywhere
we found — it might be a Hedera testnet bug, a HIP-336
interaction, or undefined behavior. We sidestepped it by
preferring the ERC-721 facade. Future Hedera updates might fix
the HTS path; we're not in a hurry to find out.

To revoke an NFT approval, pass `address(0)` as the spender
(standard ERC-721 idiom).

## Per-serial approvals, not blanket

We deliberately don't expose `setApprovalForAll` on the stash.
Why:

1. **Per-serial approvals are auto-consumed on transfer.** Once
   LST pulls the serial, the approval is gone. The blast radius
   on a healthy stash is "currently listed serials," not "every
   serial of that collection."
2. **Per-serial grants are individually revocable.** Required
   for the atomic revoke-on-cancel path: when a user cancels a
   stash-listed trade, the cancel function revokes the approval
   for THAT serial without touching other listings.
3. **No "grant-and-forget" footgun.** Approval-for-all on
   marketplaces has been the source of multiple Ethereum NFT
   thefts (the [Improper-Approval problem](https://blog.openzeppelin.com/cant-trust-cant-verify-the-state-of-eth-nft-security)).
   Per-serial keeps the blast radius bounded.

The trade-off is gas: granting and revoking per-serial costs
more than a one-time grant-all. We swallow the cost for the
safety.

## The cancel-flow choreography

A stash-listed trade's cancellation is a small dance:

1. User calls `BCF.cancelTradeFromStash(tradeId)` (or directly
   `stash.cancelLstTrade(tradeId)`).
2. Stash reads the trade from LST: `LST.getTrade(tradeId)`.
3. Stash verifies `trade.seller == address(this)` (spoof-vector
   guard — a compromised factory could otherwise ask us to
   cancel someone else's trade).
4. Stash calls `LST.cancelTrade(tradeId)` to mark the trade
   inactive.
5. Stash calls `IERC721(token).approve(address(0), serial)` to
   revoke the per-serial NFT approval.

Steps 4 and 5 are sequenced this way deliberately: cancel
first, then revoke. EVM atomicity means a revert in step 5
unwinds step 4 anyway, but the ordering matches the mental
model "the listing is gone before its approval is gone."

The spoof-vector guard at step 3 is the load-bearing part — it
means even a compromised factory can't trick the stash into
revoking approval for a serial it has listed elsewhere. Without
that guard, the factory could pass a `tradeId` whose seller is
a *different* stash, and our stash would dutifully revoke its
own approval for that token+serial. The guard rejects with
`NotMyTrade()`.

## Why the design takes so much explanation

If you're coming from Ethereum, this all reads as "way more
plumbing than it should be." Some of that is genuinely Hedera-
specific (HIP-906 for HBAR allowances). Some of it is the
2-step custody hop pattern that pays creator royalties
correctly. Some of it is the spoof-vector guards that emerge
once you have a stash + factory + LST triangle.

The combined picture, as a checklist for any
contract-as-buyer-or-seller integration on Hedera:

- [ ] Contract can grant HBAR allowances via HASC at `0x16a`
- [ ] Contract has a refill pattern with a floor + ceiling
      (lazy, not manual)
- [ ] Contract grants NFT allowances via IERC721 facade, NOT
      HTS precompile
- [ ] Per-serial allowances, not blanket
- [ ] Cancel flow atomically revokes the approval it granted
- [ ] Trade-spoof guard: verify the trade's seller is YOU
      before acting on it

All six are implemented in `BidderContract.sol`. The full
design rationale (and a bug catalog for the 5 issues this
analysis surfaced) is in
[`docs/BCF-StashAllowances-DESIGN.md`](https://github.com/lazysuperheroes/hedera-SC-LazySecureTrade/blob/main/docs/BCF-StashAllowances-DESIGN.md).

## Reference

- The contract surface lives at
  [`contracts/BidderContract.sol`](https://github.com/lazysuperheroes/hedera-SC-LazySecureTrade/blob/main/contracts/BidderContract.sol).
  Search for `approveHbarTo`, `approveNFTTo`, `_hbarApprove`,
  `_ensureHbarAllowanceForCustodyHop`.
- HIP-906 (the Hedera Account Service contract): search for
  HIP-906 at hips.hedera.com.
- The empirical probe that surfaced the HTS-precompile
  contract-owner revert: search the
  [BCF test suite](https://github.com/lazysuperheroes/hedera-SC-LazySecureTrade/blob/main/test/BidderContractFactory.test.js)
  for P5.8.
