# The 48h timelock pattern — protecting users from compromised owner keys

> **Audience:** Smart contract developers + security-curious
> users. Anyone wondering "what stops the team from rugging?"
> **Read time:** ~11 minutes.
> **Last updated:** 2026-05-27.

Every smart contract has at least one owner address with
elevated powers. On LazySecureTrade that means setting BCF
pointers, authorizing factories, tuning fee tables, granting
admin subscription extensions. The owner is necessary —
contracts need *some* path for parameter changes — but the owner
key is also the highest-blast-radius single point of failure in
the system. If it's compromised, what's the worst the attacker
can do before users can react?

The answer hinges on which owner functions are **instant** and
which sit behind a **48-hour timelock**. This post catalogs the
split, why each function landed where it did, and what the
notice window actually buys you.

## The model: cooperative ops behind a multisig + timelock

Before we get into specifics: the owner address is expected to
be an **operational multisig with its own timelock at the human
layer.** Multiple key holders, m-of-n approval, possibly a
Gnosis-Safe-style queue, possibly a delayed execution at the
multisig level.

The on-chain 48h timelock is on top of that. It's the
**user-facing notice window**: even if the multisig's human
process is compromised AND the attacker controls enough signers
to push a transaction through, users get 48 hours to see the
change coming and react before it lands.

The on-chain timelock isn't a substitute for the operational
multisig — it's a defense-in-depth layer.

## What's instant vs timelocked

Catalog as of v0.3 (this is the live state, not a wish list):

### Instant — owner can apply without notice

| Function | Contract | Why instant |
|---|---|---|
| Initial `setBcf` (when `bcf == 0`) | LST, EA | Deploy-time wire-up; no users to protect yet |
| Initial `authorizeFactory` (when `factoryAuthorityEverGranted == false`) | LST | Same: bootstrap moment, no stashes exist |
| `authorizeFactory(addr, false)` (revoke) | LST | Emergency response — a malicious factory must be kickable IMMEDIATELY |
| `cancelBcfChange` | LST, EA | Owner regaining control after a queued change is malicious; should clear instantly |
| `cancelFactoryAuthorization` | LST | Same — abandon a queued grant |
| `cancelAgentTierLimitsChange` | BCF | Same — abandon a queued tier table change |
| `setMonthlyPrice` | VIPSubscription | Only affects FUTURE purchases; existing subs immune |
| `setDiscount` | VIPSubscription | Same — future-only |
| `setCooldownSeconds` | VIPSubscription | Same — future locks; existing locks decay normally |
| `extendSubscription` | VIPSubscription | One-way grant (only adds time), capped at `MAX_GRANT_MONTHS = 12` per call |
| Fee rate tunes | LST | Hard-capped via `MAX_FEE_RATE`; affects future trades only |
| `withdrawPlatformFees` | LST | Owner drains accumulated fees to chosen recipient |
| `pauseAllAgents` (per stash) | BidderContract | **NOT an owner function** — stash owner controls |
| Stash sovereignty paths (rescue, detach) | BidderContract | **NOT owner functions** — stash owner controls |

### Timelocked (48h) — queued first, applied later

| Function | Contract | Why timelocked |
|---|---|---|
| `setBcf` (rotation, when `bcf != 0`) | LST, EA | Cascades to fee resolution for every trade. Worst-case attack: re-point BCF to a malicious one that lies about stash ownership |
| `authorizeFactory(addr, true)` (subsequent grant) | LST | Adds a new factory authority. Attack: silently add a malicious factory that can list trades on stash behalf |
| `setAgentTierLimits` (per-tier rotation) | BCF | Changes envelope caps for new envelopes. Could allow a malicious owner to make Free tier "agent-permitting" with unbounded caps |
| `setArbitragePayoutBps` | BCF | Re-allocates arbitrage spread between arbitrageur and protocol. Attack: set protocol share to 100% to drain arb spreads |
| `setProtocolFeeBps` | EA | Affects future auctions' protocol fee. Cap enforced at the setter |
| `setSettlementBountyBps` | EA | Same — future auctions |

Plus the apply-after-ETA functions (`executeBcfChange`,
`executeFactoryAuthorization`, `executeAgentTierLimitsChange`)
which are **permissionless** — anyone can call them after the
48h elapses. The owner doesn't have to be live at the exact
moment of expiry.

## The asymmetric 3-mode pattern on authorizeFactory

`authorizeFactory` is the most interesting one because it has
THREE modes, not two:

```solidity
function authorizeFactory(address factory, bool authorized) external onlyOwner {
    if (authorized) {
        if (authorizedFactories[factory]) return;        // already authorized; no-op
        if (!factoryAuthorityEverGranted) {
            // Mode 1: instant initial wire-up
            factoryAuthorityEverGranted = true;
            authorizedFactories[factory] = true;
            emit FactoryAuthorized(factory, true);
        } else {
            // Mode 2: 48h timelock for subsequent grants
            uint64 eta = uint64(block.timestamp + FACTORY_AUTH_TIMELOCK);
            pendingFactoryAuthEta[factory] = eta;
            emit FactoryAuthorizePending(factory, eta);
        }
    } else {
        // Mode 3: instant revoke
        if (pendingFactoryAuthEta[factory] != 0) {
            delete pendingFactoryAuthEta[factory];
            emit FactoryAuthorizationCancelled(factory);
        }
        if (authorizedFactories[factory]) {
            authorizedFactories[factory] = false;
            emit FactoryAuthorized(factory, false);
        }
    }
}
```

Three behaviors from one signature:

1. **Initial wire-up = instant.** At deploy time, the operator
   needs an un-timelocked path to plug BCF into a freshly-
   deployed LST. There are no stashes yet, no users to
   protect. The `factoryAuthorityEverGranted` flag flips true
   the first time and never flips back — locking this mode to
   the deploy moment.
2. **Subsequent grants = 48h.** After the flag flips, adding a
   NEW factory takes 48 hours. This is the H3 attack vector:
   a briefly-compromised owner key could otherwise add a
   malicious factory that lists trades on stash behalf.
   Timelock gives users (and the legit owner if they regain
   control) time to react.
3. **Revokes = instant.** A factory that's misbehaving needs
   to be kicked out IMMEDIATELY. Timelock here would be a
   regression — you can't make users wait 48 hours while a
   bad factory keeps draining stashes.

The asymmetry is the load-bearing piece. Two-mode (instant
always) is too dangerous; two-mode (timelocked always) breaks
deploy ops AND emergency response. Three-mode handles all
three legitimate use cases.

## What 48 hours actually buys you

The on-chain timelock isn't magic. It buys you specifically
one thing: **a notice window during which users can take
defensive action.**

What defensive action? Depends on the user:

- **Stash owners can detach.** `BidderContract.detachFromFactory()`
  irreversibly severs the link to the BCF. After detach, the
  malicious BCF can't reach the stash; the stash becomes a
  pure vault under the owner's control. Owner can rescue funds
  + NFTs and move to a fresh stash on a clean BCF.
- **Traders can withdraw bids + listings.** Cancel any
  active bid, cancel any active listing. Move funds back to
  the wallet.
- **Subscribers can wait out their VIP duration.** Subscription
  isn't affected by BCF changes; it's a separate contract.
- **Indexers + watchers can alert users.** The pending change
  emits `BcfChangePending` / `FactoryAuthorizePending` etc;
  off-chain watchers should subscribe and notify affected
  users.
- **Legit owner can cancel.** If the legit owner regains
  control of the multisig (e.g., revoked the compromised
  signer's authority), they call `cancelBcfChange` /
  `cancelFactoryAuthorization` to abandon the queued change.

The notice window is only useful if you can detect the change.
That's why every pending change emits an event with the ETA.
Indexers should treat these events as elevated-priority alerts.

## Why 48 hours specifically

The constant `TIMELOCK_WINDOW = 48 hours` came from a few
constraints:

1. **Longer than weekend ops cycles.** Critical infrastructure
   maintenance might span 48 hours; a window shorter than that
   could miss the response team.
2. **Short enough that legitimate ops aren't paralyzed.** Ops
   teams that need to rotate BCF (e.g., for a v2 migration)
   don't want to wait a week.
3. **Long enough that any reasonable security alerting catches
   it.** 48 hours is enough time for Twitter blow-ups, Discord
   panics, indexer alerts, on-chain monitoring services to
   all flag the pending change.

The 48-hour value isn't tunable. Setting it longer would make
ops painful; setting it shorter would reduce the defensive
window. It's a compromise that doesn't deserve a knob.

## What's deliberately NOT timelocked

A common question: "Why isn't the platform fee rate
timelocked?" or "Why doesn't `extendSubscription` need 48
hours?"

The answer for both: **the function's effect is bounded enough
that 48h notice isn't load-bearing.**

- **Platform fee rate** is capped at `MAX_FEE_RATE` (hardcoded
  in the contract). A compromised owner can move it within the
  cap, but they can't make it 50%. The cap is the protection.
- **`extendSubscription`** can only EXTEND time. The compromised
  owner can't shorten anyone's subscription, can't change
  anyone's tier, can't drain user funds. The function is
  one-way and bounded.
- **`withdrawPlatformFees`** drains the LST contract's HBAR
  balance to the owner's chosen recipient. But the LST
  contract's HBAR balance is ONLY accumulated platform fees —
  user funds aren't routed through LST's balance. The blast
  radius is "the protocol's earnings since the last
  withdrawal," not user funds.

When the blast radius is bounded by other mechanisms (caps,
one-way semantics, segregated balances), a timelock would be
mostly ceremony. We skip it.

## The opt-in monitoring model

LST's events are designed for off-chain consumption by
operations + community watchdog tooling. The events that
matter for security monitoring:

| Event | Where | What to watch for |
|---|---|---|
| `BcfChangePending(newBcf, eta)` | LST, EA | New BCF queued; verify it's the expected upgrade |
| `FactoryAuthorizePending(factory, eta)` | LST | New factory queued; verify it's expected |
| `AgentTierLimitsChangePending(tier, limits, eta)` | BCF | Tier table change queued; verify it's expected |
| `FactoryAuthorized(factory, false)` | LST | Emergency revoke; investigate |
| `OwnerChanged` (OZ Ownable) | All | Owner key rotation; verify it's expected |

Anyone running a Hedera mirror watcher can subscribe to these.
The community can run watchdog bots that post to Twitter /
Discord when these fire. We encourage it.

## Comparison: the Ethereum-typical pattern

Compare to a typical Ethereum DeFi setup:

- Owner is a single EOA OR a Gnosis Safe
- High-blast-radius functions might use OpenZeppelin's
  `TimelockController` contract
- Timelock window is configurable per-function and per-protocol

LST's approach is similar in spirit but uses inline storage
+ enums rather than a separate Timelock contract:

- ~50 bytes per timelocked function (pending pointer + ETA)
- One contract, one place to audit
- No separate Timelock contract to mis-deploy

Trade-off: less flexible (can't reuse Timelock for multiple
ops), more compact, easier to reason about. For a marketplace
that doesn't need exotic governance, this is the right
trade.

## What this DOESN'T protect against

Honest scope:

- **Bugs in the contracts.** Timelock protects against
  malicious admin actions, not against unintended behavior in
  the code. We have a comprehensive test suite + design
  reviews + (future) third-party audit for that.
- **Compromised users.** If a user's stash owner key is
  compromised, the timelock doesn't help — the attacker can
  rescue funds directly. The user is responsible for their
  own key.
- **LDR / LSH NFT misbehavior.** External dependencies
  (LazyDelegateRegistry, the LSH token contracts) aren't
  ours; if they misbehave, our resilience is the try/catch
  fallback in `LSHTierLib._safeDelegatedLength`, not the
  timelock.

The timelock is one layer in a defense-in-depth stack. Not the
only layer.

## Reference

- The timelock constants live in each contract's storage
  section. Grep for `TIMELOCK_WINDOW` or `FACTORY_AUTH_TIMELOCK`
  or `AGENT_TIER_TIMELOCK`.
- The Owner Administration Model is documented in
  [`SECURITY.md`](https://github.com/Burstall/hedera-SC-LazySecureTrade/blob/v0.3/SECURITY.md).
- The acceptance tests for the timelock paths are in
  [`test/BidderContractFactory.test.js`](https://github.com/Burstall/hedera-SC-LazySecureTrade/blob/v0.3/test/BidderContractFactory.test.js)
  (P5.26–P5.32 cover `authorizeFactory` specifically).
- The 3-mode `authorizeFactory` design ships as the H3
  finding fix; see commit `bb1980e` in the history.
