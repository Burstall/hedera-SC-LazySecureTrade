# Hardhat against live testnet — our testing methodology

> **Audience:** Solidity developers building on Hedera who
> want to know what production-grade integration testing looks
> like in this ecosystem.
> **Read time:** ~10 minutes.
> **Last updated:** 2026-05-27.

Most Solidity test suites run against a local EVM — Hardhat
Network, Ganache, Anvil. Spin up a local node, run tests
against it, tear down. Cheap, fast, deterministic.

LazySecureTrade's test suite runs against **Hedera testnet** —
the actual live network — for every test. Each test costs real
HBAR. Each test waits for real consensus. The full suite costs
~225 HBAR per run and takes ~37 minutes.

That sounds painful. It is, sort of. But it's also the only
way to actually exercise the contracts the way users will. This
post is the methodology we converged on after a year of writing
Hedera integration tests, the conventions that make it
manageable, and why local mocking wasn't an option.

## Why local mocking doesn't work for HTS-heavy contracts

Hedera Token Service (HTS) is a Hedera-network primitive — not
an ERC-20/721 contract you can deploy locally. The HTS
precompile lives at `0x167`; calling it does network-level
work that's not part of EVM semantics. Hardhat Network has no
HTS implementation.

For LST/BCF/EA which lean on HTS for every NFT transfer,
royalty payment, allowance check, and association, local
mocking would mean:

- Mock the HTS precompile's behavior in JavaScript
- Mock the 1-tinybar custody hop
- Mock the royalty engine
- Mock token associations + their gas costs
- Mock the 50-subcall ceiling enforcement

That's not a mock anymore — that's a Hedera reimplementation.
And the mock would inevitably diverge from real Hedera
behavior, which is the LAST thing you want for security-
critical code.

So we test against the real thing. It's expensive, but it's
correct.

## The shape of a Hedera integration test

Every test file follows roughly this structure:

```javascript
const { Client, AccountId, PrivateKey, ContractId } = require('@hashgraph/sdk');
const { contractExecuteFunction, readOnlyEVMFromMirrorNode } = require('../utils/solidityHelpers');

describe('My contract test suite', function () {
    this.timeout(180_000);    // long — real network round trips

    let client, operatorId, operatorKey;
    let contractId, contractIface;

    before(async function () {
        this.timeout(300_000);
        // Set up Hedera client + operator
        operatorId = AccountId.fromString(process.env.ACCOUNT_ID);
        operatorKey = PrivateKey.fromStringED25519(process.env.PRIVATE_KEY);
        client = Client.forTestnet().setOperator(operatorId, operatorKey);

        // Load ABIs + addresses (cached or deploy)
        if (process.env.CACHED_CONTRACT_ID) {
            contractId = ContractId.fromString(process.env.CACHED_CONTRACT_ID);
        } else {
            // Deploy fresh — costs ~50 HBAR
            [contractId] = await contractDeployFunction(...);
        }
        contractIface = new ethers.Interface(contractJson.abi);
    });

    it('does the thing', async function () {
        // Submit a real transaction
        const [receipt] = await contractExecuteFunction(
            contractId, contractIface, client, 600_000,
            'doTheThing', [arg1, arg2],
        );
        expect(receipt.status.toString()).to.equal('SUCCESS');

        // Read state via mirror node (NOT through SDK)
        await sleep(MIRROR_DELAY);
        const state = (await mirrorQuery(contractId, contractIface, 'readState', []))[0];
        expect(state).to.equal(expectedValue);
    });
});
```

A few conventions are load-bearing here.

## Convention 1: typed revert assertions

For tests that expect a revert, plain `expect(rx).to.be.reverted`
doesn't tell you WHICH revert. On Hedera, error names are
typed (custom errors with selectors), and asserting against
the specific error name is non-negotiable for correctness:

```javascript
function expectRevertNamed(result, expectedName, extraIfaces = []) {
    const status = result?.[0]?.status;
    const name = status?.name?.toString?.();
    if (name === expectedName) return;
    // Also accept the error decoded from a custom interface
    const raw = status?.raw;
    if (raw && raw.length >= 10) {
        const selector = raw.slice(0, 10);
        for (const ifc of extraIfaces) {
            try {
                const e = ifc.getError(selector);
                if (e && e.name === expectedName) return;
            } catch (_) { /* selector miss */ }
        }
    }
    fail(`Expected revert ${expectedName}; got name=${name} raw=${raw}`);
}
```

A test using it:

```javascript
const result = await contractExecuteFunction(
    contractId, iface, client, 200_000,
    'restrictedFn', [args],
    0, true,  // flagError=true — don't throw on revert
);
expectRevertNamed(result, 'OnlyOwner');
```

The `0, true` arguments to `contractExecuteFunction` tell the
helper "this might revert; capture the error info instead of
throwing." Without that flag, a revert blows up the test
runner with a stack trace; with it, we get back a structured
error object we can assert against.

## Convention 2: mirror-first reads

Reads go to **mirror node**, not to a Hedera consensus node:

```javascript
async function mirrorQuery(contractId, iface, fcnName, params = []) {
    const encoded = iface.encodeFunctionData(fcnName, params);
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const raw = await readOnlyEVMFromMirrorNode(
                env, contractId, encoded, operatorId, false,
            );
            return iface.decodeFunctionResult(fcnName, raw);
        } catch (e) {
            await sleep(800 * (attempt + 1));   // exponential backoff
        }
    }
    throw new Error('mirror query failed after 3 attempts');
}
```

Why mirror over consensus?

1. **Cost.** Mirror reads are free. Consensus calls cost real
   HBAR even for view functions.
2. **Speed.** Mirror is HTTP/REST; consensus is SDK
   round-tripping. Mirror is faster for cold reads.
3. **What users actually use.** Frontend dApps read from
   mirror. If we test against mirror, we exercise the same
   path users do.

The 800ms × N backoff handles mirror's eventual-consistency
window — mirror sometimes lags a few seconds behind consensus.

## Convention 3: `MIRROR_DELAY` sleeps after writes

After every state-mutating transaction, sleep before reading:

```javascript
const MIRROR_DELAY = 5500;   // 5.5 seconds

// After a write:
await contractExecuteFunction(contractId, iface, client, gas, 'mutateFn', [args]);
await sleep(MIRROR_DELAY);
// Now safe to mirrorQuery
```

Why 5.5 seconds? Empirical. Mirror node typically catches up
within 3-4 seconds; the extra buffer handles outlier latency.
Faster than this risks reading stale state. Slower wastes
test time.

If a read returns stale data despite the sleep, that's a flake
— retry within the test or extend `MIRROR_DELAY`. Don't ignore
it.

## Convention 4: .env-cached resource IDs

Test runs reuse contracts + accounts across sessions via
`.env`:

```bash
ACCOUNT_ID=0.0.8891352
PRIVATE_KEY=302e02...
ALICE_ACCOUNT_ID=0.0.8986332
ALICE_PRIVATE_KEY=302e02...
BOB_ACCOUNT_ID=0.0.8986333
BOB_PRIVATE_KEY=302e02...

LAZY_TOKEN_ID=0.0.8986380
LAZY_GAS_STATION_CONTRACT_ID=0.0.X
LAZY_SECURE_TRADE_CONTRACT_ID=0.0.9057802
BIDDER_FACTORY_CONTRACT_ID=0.0.9062601
VIP_SUBSCRIPTION_CONTRACT_ID=0.0.9043912
ENGLISH_AUCTION_CONTRACT_ID=0.0.9052454
```

The scaffold reads these and reuses what's there. If a var is
missing, the scaffold deploys fresh and prints the value for
the user to cache.

Why this matters: every cached resource saves real HBAR.
Deploying a fresh BCF costs ~30 HBAR; if you do it on every
test run, that's hundreds of HBAR over a development cycle.
Caching brings the cost down to 1-3 HBAR per run for resource
reuse, plus the actual per-test consumption.

## Convention 5: clean-up describe blocks

Tests that mutate global state (envelopes, bid registry, etc.)
end with a clean-up:

```javascript
describe('Clean-up', function () {
    after(async function () {
        // Best-effort: revert any state changes for next run
        try {
            await cancelAllEnvelopes(ctx, alice, stashId);
        } catch (e) {
            console.log('Cleanup skipped:', e.message);
        }
    });

    it('Clean-up: completed', async function () {
        expect(true).to.equal(true);   // sentinel
    });
});
```

The `it('completed')` exists so the describe block has at
least one test that mocha actually runs (otherwise mocha
skips the entire block including the `after` hook).

Best-effort: the cleanup is wrapped in try/catch because if a
previous test failed mid-way, the cleanup might not have all
the assumptions it needs. Better to skip cleanup than to
cascade failures into the next test session.

## Convention 6: gas estimation with fallback

Hedera's mirror node provides gas estimation via
`/contracts/call?estimate=true`. We use it preferentially:

```javascript
async function _resolveExecutionGas(client, contractId, iface, fcnName, params, fallbackGas) {
    try {
        const data = iface.encodeFunctionData(fcnName, params);
        const estimated = await mirrorEstimate(env, contractId, data);
        return Math.floor(estimated * 1.3);   // 30% padding
    } catch (e) {
        return fallbackGas;
    }
}
```

The 30% padding is for the gap between "this is the minimum
gas to execute" and "this is the gas needed to NOT run out
during execution" (HTS associations bring variance, e.g.).

If estimation fails (mirror is overloaded, contract path is
unusual), we fall back to the caller-supplied gas. Logged so
flaky estimation is visible.

## Real-test cost economics

Per test, rough HBAR consumption:

| Operation | HBAR |
|---|---|
| Read via mirror | 0 |
| Simple state mutation | 0.1-0.5 |
| HTS NFT transfer | 1-3 |
| Contract deploy (small) | 5-15 |
| Contract deploy (LST/BCF-sized) | 30-50 |
| Trade execution (with royalty) | 3-7 |
| Agent provisioning (alias auto-create) | 5 |

For LST's full suite (225 tests, multi-contract scaffolds,
agent provisioning, NFT minting, etc.):

- Worst-case fresh deploy + all tests: ~250 HBAR
- Cached scaffolds + test reruns: ~80-100 HBAR

We deploy fresh only when contract code changes; otherwise we
reuse from `.env`. The agent envelope full suite (48 tests,
fresh VIP, agent provisioning per group) runs ~40 HBAR with
cached BCF + LST.

## Why this is worth the cost

Tests against real testnet give you things mocks can't:

1. **You catch Hedera-specific quirks.** Like the
   `AccountId.fromEvmAddress` PAYER_ACCOUNT_NOT_FOUND
   gotcha we documented in
   [Building a SNIPER agent](./01-building-a-sniper-agent.md).
   No local mock would have surfaced it.
2. **You exercise the 50-subcall ceiling for real.** Tests
   that pass locally but blow the ceiling on Hedera fail
   loud and proud here.
3. **You measure real gas costs.** Hardhat Network's gas
   metering is EVM-accurate but Hedera has additional
   non-EVM costs (HTS associations, royalty engine). Real
   tests give real numbers.
4. **You catch mirror-node consistency bugs.** If your
   contract's view function returns data inconsistently
   across mirror queries, you'll find out here, not in
   production.

The cost is the entry fee for confidence. We've shipped a few
contracts to mainnet from this methodology; we haven't had a
post-mainnet "huh, that doesn't work on the real network" bug
yet.

## When local IS the right tool

Two cases:

1. **Pure-function unit tests.** If you're testing a library
   function with no HTS / network dependencies, run it in
   Hardhat Network. Cheap, fast, no reason to pay HBAR.
2. **Property-based / fuzz testing.** If you're exhaustively
   exercising state-space, local-only fuzz tests catch bugs
   in semantically-pure functions. We've used Hardhat's
   built-in fuzzing for `LSHTierLib`'s tier-priority logic.

For everything that touches HTS, the answer is "real testnet."

## Reference

- The test helper library lives at
  [`utils/solidityHelpers.js`](https://github.com/Burstall/hedera-SC-LazySecureTrade/blob/v0.3/utils/solidityHelpers.js)
  (contract execution + mirror querying).
- The scaffold pattern is in
  [`test/scaffold.js`](https://github.com/Burstall/hedera-SC-LazySecureTrade/blob/v0.3/test/scaffold.js)
  (agent test suite — illustrative).
- An example test file:
  [`test/AgentEnvelopeFull.test.js`](https://github.com/Burstall/hedera-SC-LazySecureTrade/blob/v0.3/test/AgentEnvelopeFull.test.js).
