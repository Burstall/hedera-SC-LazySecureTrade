# CREATE2 stash addresses — predict before deploy

> **Audience:** Frontend, indexer, and runtime developers who
> need to address per-user stash contracts before they exist
> on-chain.
> **Read time:** ~12 minutes.
> **Last updated:** 2026-05-27.

Every user on LazySecureTrade gets their own stash contract — a
small vault that holds funds + NFTs + bids. The stash is deployed
via OpenZeppelin's `Clones.cloneDeterministic`, which uses the
EVM's CREATE2 opcode under the hood. The address is a pure
function of `(factory, implementation, salt)`, and we engineer the
salt so off-chain code can derive each user's stash address
without an RPC call.

This post walks through the math, gives you working code, and
explains why we set things up this way.

## The math

CREATE2 produces an address by hashing four things:

```
address = keccak256(0xFF ++ deployer ++ salt ++ keccak256(initCode))[12:]
```

Where:

- `0xFF` is a one-byte sentinel separating CREATE2 from regular
  CREATE.
- `deployer` is the factory's 20-byte address.
- `salt` is a 32-byte arbitrary value.
- `initCode` is the contract's deploy bytecode.

OpenZeppelin's `Clones` library standardizes the initCode: every
clone is an ERC-1167 minimal proxy pointing at a single
implementation contract. So `keccak256(initCode)` becomes a
function of the implementation address, which is fixed per
factory deploy.

That collapses the formula to a function of three known values:

```
stashAddress = clonesCreate2(
    factory      = 0x...008a48c9,         // testnet BCF
    implementation = 0x...008a48c2,         // testnet stash impl
    salt         = keccak256("LST_STASH_v1", user)
)
```

The salt prefix `"LST_STASH_v1"` is a 13-byte ASCII string
encoded into the keccak as `bytes`. Pairing it with the user
address makes the salt unique per (factory generation, user).

## Why this matters off-chain

Without deterministic addresses, the only way to know a user's
stash address is to either:

1. Query the BCF (`getStashOf(user)`) and wait for a mirror-node
   round trip, or
2. Wait for the `StashDeployed` event after the user clicks
   "Deploy stash" in the frontend.

Both are slow on the human timescale. Deterministic addresses let
you skip the wait:

- **Indexers** can index the user's stash address the moment the
  user creates their wallet, before the stash is deployed. Stash
  notifications hit the indexer before the deploy receipt does.
- **Frontends** can compute and show the stash address to the
  user instantly. "Your stash will be at 0xCD86..." appears in
  the UI without any RPC traffic.
- **Agents** can compute their assigned stash address from their
  config without needing to wait for the user's deploy
  transaction to land.

You can also pre-fund a stash before it exists. Send HBAR to the
predicted address; when the stash deploys, the HBAR is already
there. (This works on Hedera because contracts are addressable
the moment they're created, but the *account* at that address —
in Hedera's hybrid account/contract model — accepts transfers
even pre-deploy. EVM-purist devs find this surprising.)

## Computing it in JavaScript

ethers v6 has the math built in:

```typescript
import { ethers } from 'ethers';

const FACTORY = '0x00000000000000000000000000000000008a48c9';      // testnet BCF
const IMPL    = '0x00000000000000000000000000000000008a48c2';      // testnet stash impl
const SALT_PREFIX = 'LST_STASH_v1';

function predictStashAddress(userAddress: string): string {
    // 1. Salt is keccak256 of (prefix, user). Solidity uses
    //    abi.encodePacked, so we do the same.
    const salt = ethers.solidityPackedKeccak256(
        ['string', 'address'],
        [SALT_PREFIX, userAddress],
    );

    // 2. ERC-1167 minimal proxy init-code. The OZ Clones library
    //    constructs this as bytes(0x3d602d80600a3d3981f3) ++ impl(20) ++
    //    bytes(0x5af43d82803e903d91602b57fd5bf3).
    const initCode = ethers.concat([
        '0x3d602d80600a3d3981f3363d3d373d3d3d363d73',
        IMPL,
        '0x5af43d82803e903d91602b57fd5bf3',
    ]);
    const initCodeHash = ethers.keccak256(initCode);

    // 3. CREATE2: keccak256(0xFF ++ factory ++ salt ++ keccak256(initCode))[12:]
    return ethers.getCreate2Address(FACTORY, salt, initCodeHash);
}
```

For a quick sanity check: call `BCF.getStashAddress(userAddress)`
via mirror node and confirm the bytes match what you just
computed. They should, exactly.

## Computing it on-chain (for contracts that want it)

If you're writing a Solidity contract that needs to address a
stash, BCF exposes a view:

```solidity
function getStashAddress(address user) public view returns (address) {
    return Clones.predictDeterministicAddress(
        BIDDER_CONTRACT_IMPLEMENTATION,
        _stashSalt(user)
    );
}

function _stashSalt(address user) internal pure returns (bytes32) {
    return keccak256(abi.encodePacked(STASH_SALT_VERSION, user));
}
```

`STASH_SALT_VERSION = "LST_STASH_v1"` is a constant — note that
*changing it requires a new factory deploy*, because every
existing user's stash address depends on it. This is intentional:
the salt is a chain-of-trust anchor, not a tunable parameter.

## Failure modes to be aware of

Three things will silently produce *wrong* addresses if you get
them wrong.

### Wrong factory address

The most obvious — but it has a subtle variant. If your
testnet/mainnet split mixes up factory addresses in config, every
predicted stash address will be off. The SDK's `getAddresses()`
function exposes the canonical factory per network; use that
rather than hardcoding.

### Wrong implementation address

This is the trap. The BCF stores its implementation address as
`immutable BIDDER_CONTRACT_IMPLEMENTATION`. If you predict using
the WRONG impl (e.g., you grabbed it from an outdated SDK build),
you'll get an address that doesn't match what the BCF actually
deploys. Sanity-check: read `factory.BIDDER_CONTRACT_IMPLEMENTATION()`
via mirror once at startup and pin to that.

### Wrong salt encoding

The salt is `keccak256(abi.encodePacked("LST_STASH_v1", user))`,
which uses `solidityPackedKeccak256` in ethers — NOT
`keccak256(abi.encode(...))`, which would produce a different
hash. The two differ in how the string is padded.

```typescript
// CORRECT (matches the contract)
ethers.solidityPackedKeccak256(['string', 'address'], [prefix, user])

// WRONG (would not match)
ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['string', 'address'], [prefix, user]))
```

If your computed addresses are off by what looks like random
bits, this is almost always the cause.

## Why "LST_STASH_v1"?

The version marker is so we can change the stash implementation
without colliding with existing users' addresses. If we ever ship
v2 of the stash impl, we'd want either:

1. **Same factory + new salt prefix** (`"LST_STASH_v2"`) — new
   stashes get a new address; old stashes still resolve to v1
   addresses via the v1 prefix.
2. **New factory + same salt prefix** — same outcome via a
   different lever; the new factory's address goes into CREATE2,
   producing different addresses.

Right now we don't have a v2 plan. The version marker exists
defensively so we have the option without a migration headache.

## Indexer use case — pre-deploy notifications

Imagine you're building an indexer that wants to alert a user
when their stash receives an event. Without deterministic
addresses, the flow is:

1. User creates wallet.
2. User clicks "Deploy stash."
3. Stash deploy tx lands.
4. Indexer sees `StashDeployed(user, stash)` event.
5. Indexer subscribes to `stash` for future events.

There's a window between step 1 and step 4 where the user has no
indexer coverage. If they fund the predicted stash address (which
they can — see below) and then the stash receives an HBAR
deposit notification, your indexer might miss the deposit
because it hasn't subscribed yet.

With deterministic addresses:

1. User creates wallet.
2. Indexer immediately computes the stash address and subscribes.
3. User deploys stash + funds it. All events are captured from
   tx 1.

Same flow, no window. The indexer can subscribe months before
the user even thinks about deploying.

## Pre-funding the stash

Hedera's account model lets you transfer HBAR to an address
before the contract there exists. The transfer creates a
hidden balance at that address; when the contract later deploys
to that address, the balance is right there waiting.

```typescript
const stash = predictStashAddress(userAddress);
await new TransferTransaction()
    .addHbarTransfer(funderId, new Hbar(-50))
    .addHbarTransfer(stash, new Hbar(50))    // stash doesn't exist YET
    .execute(client);

// Later:
await new ContractExecuteTransaction()
    .setContractId(bcfId)
    .setFunction('deployStash')
    .execute(client);
// Stash now exists at predicted address, with 50 HBAR balance.
```

EVM purists object — "you can't send funds to a contract that
doesn't exist!" — but in Hedera's hybrid model the address is
already valid as an account-shadow long before any contract code
lives there. The transferred HBAR sits in the account-shadow until
the contract deploys.

This is genuinely useful for self-onboarding: the user can fund
their stash from a custodian or exchange before the stash exists,
then deploy when ready. No "deploy first, fund second" two-step.

## Reference

- The BCF's `getStashAddress` is at
  [`contracts/BidderContractFactory.sol`](https://github.com/lazysuperheroes/hedera-SC-LazySecureTrade/blob/main/contracts/BidderContractFactory.sol).
- The salt prefix `STASH_SALT_VERSION = "LST_STASH_v1"` is a
  constant in the same file.
- OpenZeppelin's `Clones.predictDeterministicAddress` is the
  canonical impl; ethers v6's `getCreate2Address` matches the
  on-chain semantics exactly.
- The CREATE2 probe at
  [`contracts/test/CREATE2Probe.sol`](https://github.com/lazysuperheroes/hedera-SC-LazySecureTrade/blob/main/contracts/test/CREATE2Probe.sol)
  empirically validates Hedera's CREATE2 implementation against
  EVM equivalence — Hedera has surprised us before, so we test
  against the spec rather than trusting it.
- The empirical test driver:
  [`scripts/testing/create2Probe.js`](https://github.com/lazysuperheroes/hedera-SC-LazySecureTrade/blob/main/scripts/testing/create2Probe.js).
