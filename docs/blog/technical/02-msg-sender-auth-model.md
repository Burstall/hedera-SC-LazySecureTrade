# Hedera's msg.sender auth — why we deleted ecrecover

> **Audience:** Smart contract developers, especially Ethereum
> natives porting patterns to Hedera.
> **Read time:** ~10 minutes.
> **Last updated:** 2026-05-27.

For most of v0.3's development cycle, the agent envelope feature
was going to be EIP-712 based: the user signs a permission slip
off-chain, the agent submits it on-chain, the contract verifies
the signature via `ecrecover`. Standard Ethereum playbook.

We deleted all of that. The current auth model is `msg.sender ==
envelope.agentKey` and nothing else. No signature, no nonce, no
EIP-712 domain separator.

This is a Hedera-specific shortcut that doesn't translate to other
EVM chains. Worth understanding if you're building on Hedera.

## What changed

The original design had this shape in the contract:

```solidity
// PROPOSED — never shipped.
function createBid(BidDetails calldata details, AgentAuth calldata auth) external {
    bytes32 hash = _hashTypedDataV4(keccak256(abi.encode(
        BID_CREATE_TYPEHASH,
        details.token, details.serial, details.hbarAmount, auth.nonce
    )));
    address signer = ECDSA.recover(hash, auth.signature);
    require(signer == envelope.agentKey, "InvalidSignature");
    require(auth.nonce == envelope.nonce++, "BadNonce");
    require(auth.deadline >= block.timestamp, "Expired");
    // ... actual bid logic
}
```

The current shape is:

```solidity
function createBid(BidDetails calldata details, AgentAuth calldata auth) external {
    if (msg.sender != envelope.agentKey) revert OnlyOwner();
    // ... actual bid logic
}
```

That's it. No hash, no recover, no nonce, no deadline. The
`AgentAuth` tuple still exists, but it only carries
`(agentKey, reasoningTopicId)` — and `agentKey` is checked against
`msg.sender`, not against a signature.

## Why we could delete it

Three facts about Hedera converge:

**1. Hedera's protocol layer verifies signatures before the EVM
ever runs.** When you submit a `ContractExecuteTransaction` to the
Hedera network, the consensus layer checks the submitter's
signature against the payer's account key. By the time your
contract sees the call, `msg.sender` has already been
authenticated by the consensus protocol. There is no
unauthenticated msg.sender on Hedera.

This isn't strictly different from Ethereum — Ethereum's
mempool layer also requires a valid tx signature before the
contract executes — but the *implication* is the same: if you
trust msg.sender, you've already inherited the chain's
signature verification.

**2. There is no mempool, no front-running, no MEV.** Hedera
consensus orders transactions by timestamp. There's no period
during which a transaction is visible but not yet executed. So
the usual reason for nonces (replay protection across mempool
visibility) doesn't apply. Each transaction is unique by
consensus timestamp.

**3. Hedera supports two key types — ECDSA secp256k1 AND
ED25519.** Ethereum's `ecrecover` precompile only knows about
secp256k1. There is no native EVM precompile for ED25519
verification. So if you require contract-level signature
verification, you exclude every ED25519-native Hedera account
from acting as an agent — which is most legacy Hedera accounts
and many SDK-generated keys.

Stack those facts: there's no chain-level reason to need
contract-level signature verification, no per-tx nonce
requirement, and re-adding `ecrecover` would lock out half the
key types. Deleting all of it makes the system smaller, faster,
more bytecode-efficient, and *more inclusive* of Hedera's key
ecosystem.

## What this means in practice

For an agent runtime, the flow becomes:

1. The user creates an envelope on their stash naming the agent's
   EVM address (`createEnvelope(EnvelopeParams)`).
2. The agent operates from a real Hedera account whose key the
   user does not have. Either ECDSA or ED25519 — both work.
3. When the agent wants to act, it submits the
   `ContractExecuteTransaction` from its own Hedera account. The
   Hedera protocol layer verifies the agent's signature.
4. The contract sees `msg.sender == agent's EVM address`, checks
   `msg.sender == envelope.agentKey`, and proceeds.

No signature is constructed off-chain. No deadline is enforced
in the contract. The agent just acts.

## What we did keep

A few things from the EIP-712 era persist because they're not
auth-related:

- **`reasoningTopicId` in the AgentAuth tuple.** This is a
  bytes32 pointer to an HCS-10 topic where the agent has logged
  its reasoning. It gets emitted in events for off-chain
  correlation — no on-chain semantics. `bytes32(0)` means "no
  topic provided" and is the owner-path sentinel.
- **The AgentAuth tuple itself.** We still wrap `(agentKey,
  reasoningTopicId)` in a struct so callers know whether they're
  acting as owner (`EMPTY_AUTH`) or as an agent (populated). The
  contract uses this to decide whether to consult the envelope at
  all.
- **Per-tx and daily budget caps in the envelope.** These are
  always enforced — they're independent of how msg.sender was
  authenticated.

## Catches and gotchas

A few non-obvious consequences worth flagging.

### "Owner path" vs "Agent path"

The same function signatures (`createBid`, `cancelBid`, etc.)
serve both the owner (calling from their wallet) and the agent
(calling from their wallet). The discriminator is the
`AgentAuth` tuple:

- **`EMPTY_AUTH` = `(address(0), bytes32(0))`** — owner path.
  Contract requires `msg.sender == owner`. No envelope state is
  touched.
- **Populated auth** — agent path. Contract requires
  `msg.sender == auth.agentKey`. Envelope state is consulted and
  consumed.

If a random EOA submits a populated auth claiming to be the
agent, but their `msg.sender` doesn't match `auth.agentKey`, the
call reverts `OnlyOwner` (same error name, both branches; the
revert is bytecode-cheap and unambiguous given the context).

### Contracts can't be agents

The envelope-creation function rejects contract addresses as
agentKey via `extcodesize > 0` (`AgentKeyIsContract` error). The
reason is subtle: a contract can be called by anyone, and if the
caller's msg.sender propagates through, "the agent" effectively
becomes "whoever can call the contract." That's not a bounded
trust surface.

EOAs — both ECDSA and ED25519 Hedera accounts — have zero code
and pass the check. Contracts don't.

### Mirror node simulations don't emit events

`eth_call` on mirror node simulates the transaction. If your
contract emits an event during the call (e.g., the `LDRDegraded`
event we considered earlier), the simulation doesn't record it —
the event only fires on a real on-chain tx. For agent flows this
means: you can't probe envelope state by simulating a write and
inspecting the emitted budget-consumed event. You either read
the state directly (`getEnvelope(agentKey)`) or submit the real
tx and observe the receipt.

## Implications for cross-chain bridging

If you bridge marketplace primitives from Hedera to an Ethereum
L2, you cannot reuse this auth model directly. Ethereum has a
mempool, has MEV, and only supports secp256k1 — three of the
properties that made msg.sender-only viable on Hedera. Your L2
counterpart would need EIP-712 signatures, nonces, and deadlines
as a matter of basic safety.

The marketplace SDK's `AgentAuth` tuple shape will probably
diverge across chains for this reason. The Hedera one is a
2-tuple; an Ethereum sibling would be more like a 5-tuple with
signature, nonce, deadline alongside agentKey and
reasoningTopicId.

## Summary

| Pattern | EVM (typical) | Hedera |
|---|---|---|
| Off-chain signature | EIP-712 / personal_sign | Not used |
| Nonce | Per-account or per-envelope | Not used |
| Deadline | `auth.deadline >= block.timestamp` | Not used |
| msg.sender auth | After signature recovery | Direct; consensus already verified |
| Key types supported | ECDSA secp256k1 only | ECDSA + ED25519 |
| Bytecode cost | ~500 B per signed-action site | ~30 B per check |

You can think of it as: Ethereum builds signature verification on
top of msg.sender authentication because Ethereum doesn't trust
its own mempool to discriminate signers. Hedera doesn't need the
layer because consensus already does that work for you.

When in Hedera, do as Hedera does. Delete the ceremony.

## Reference

- The auth-model NatSpec lives at
  [`contracts/interfaces/IAgentEnvelope.sol:14-25`](https://github.com/Burstall/hedera-SC-LazySecureTrade/blob/v0.3/contracts/interfaces/IAgentEnvelope.sol).
- The owner-or-agent check is at
  [`contracts/BidderContract.sol:_ownerOrAgentMsgSender`](https://github.com/Burstall/hedera-SC-LazySecureTrade/blob/v0.3/contracts/BidderContract.sol).
- The library that enforces budget + permissions is
  [`contracts/libraries/AgentEnvelopeLib.sol`](https://github.com/Burstall/hedera-SC-LazySecureTrade/blob/v0.3/contracts/libraries/AgentEnvelopeLib.sol).
- The decision-context trail is in
  [`docs/AGENT-MARKETPLACE-DELTA.md`](https://github.com/Burstall/hedera-SC-LazySecureTrade/blob/v0.3/docs/AGENT-MARKETPLACE-DELTA.md)
  under the "Resulting architectural decisions" section, item 4
  (annotated REVERSED — the original design proposed signed-proofs
  as an optional hot path; msg.sender-only replaced it entirely).
