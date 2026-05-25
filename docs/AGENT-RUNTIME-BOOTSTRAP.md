# Agent Runtime — Bootstrap Prompt

> **Drop this file into the root of a fresh empty repo as `CLAUDE.md` (or
> as `README.md` if you want it human-facing) and start a Claude Code
> session there. This file is self-contained — it carries enough context
> to start the agent runtime without reading anything in the
> `hedera-SC-LazySecureTrade` repo first, but links every claim to the
> source of truth.**
>
> **Last updated:** 2026-05-25 (against contracts repo `v0.3` branch tip
> `e6980bf`).

---

## What you're building

An **automated trading agent runtime** for the LazySecureTrade (LST)
marketplace on Hedera. The contracts already exist and are deployed to
Hedera testnet — your job is the off-chain process that submits
transactions on behalf of human users.

The marketplace is three parallel surfaces:

| Surface | What it is | Contract |
|---|---|---|
| **LST trades** | Fixed-price listings (open market or directed buyer). Single + atomic batch + multi-execute. | `LazySecureTrade` |
| **BCF bids** | CLOB-style resting bids per (token, serial). Each user gets a per-user "stash" contract holding funds + envelopes. | `BidderContractFactory` + `BidderContract` (stash) |
| **Auctions** | Timed English auctions with reserve, buy-now, anti-snipe extension. | `EnglishAuction` |

Plus two cross-cutting subsystems:

- `VIPSubscription` — paid tier (Bronze→Platinum) that gates how many
  agents a user can authorize and their daily/per-tx HBAR + LAZY budget.
- `AgentEnvelope` (lives on each stash) — per-(stash, agentKey) record
  with budgets, allowed actions, kill switch. **You consume this.**

---

## Hedera-specific facts that change the design

These are NOT standard EVM assumptions. Internalize them before writing
any agent logic.

1. **No mempool, no MEV, no sandwich attacks.** Hedera consensus orders
   transactions by timestamp. There is no concept of being "front-run"
   the way Ethereum has. Drop any commit-reveal / private-mempool
   defenses — they're irrelevant here.

2. **Auth is `msg.sender`-only.** Hedera's protocol layer verifies the
   submitting account's transaction signature (ECDSA secp256k1 OR
   ED25519, native to whatever key type the Hedera account uses) before
   the EVM runs. Contracts check `msg.sender == envelope.agentKey`
   against the stash's stored agentKey. **There is no EIP-712, no
   `ecrecover`, no nonce on the contract side.** Each agent is just a
   Hedera account; sign with that account's key, submit the tx, done.

3. **Each agent must be a Hedera account (EOA), not a contract.**
   `createEnvelope` rejects contract addresses via `extcodesize > 0`
   (custom error `AgentKeyIsContract`). Reason: contracts can be called
   by anyone and would propagate `msg.sender` in ways the envelope can't
   police.

4. **50 subcalls per transaction is the ceiling.** Every HTS precompile
   call counts. Batch operations are conservatively sized for this, not
   for gas alone.

5. **~1M gas per new HTS token association.** UX caps new associations
   at 5–8 per transaction.

6. **No gas refunds on revert.** Users pay for consumed gas even when
   the tx fails — prefer pre-flight validation over "try it and see".
   The contracts expose pre-flight views (`isBidValid`, `canAuthorize`,
   `getAuctionSnapshot`) for this reason; use them.

7. **Mirror node is your read path.** `mirrornode.hedera.com` (and the
   testnet/previewnet equivalents) is the canonical read source for
   contract state, transaction history, and event logs. Direct
   `eth_call` is supported but slower and rate-limited. Read from
   mirror; write via the SDK.

---

## Install the marketplace SDK

The contracts repo publishes the SDK as `@lazysuperheroes/marketplace-sdk`.
It is not yet on npm — install directly from the git URL:

```bash
yarn add "github:Burstall/hedera-SC-LazySecureTrade#v0.3"
```

(The SDK's `prepare` script auto-builds in your `node_modules` on
install — `tsup` + `typescript` are pulled in as devDeps temporarily.
Pre-committed ABIs cover the case where the parent Hardhat
`artifacts/` directory isn't present.)

Peer dependencies you must add yourself:

```bash
yarn add ethers@^6 @hashgraph/sdk@^2.50
```

### What the SDK gives you (v0.1)

```typescript
import {
    // ABIs
    ABIS,
    LazySecureTradeAbi,
    BidderContractFactoryAbi,

    // Addresses
    getAddresses,
    hederaIdToEvmAddress,

    // Ethers Interface factories (lazy)
    bidderContractFactoryInterface,
    englishAuctionInterface,
    vipSubscriptionInterface,

    // AgentAuth tuple helpers
    EMPTY_AUTH,                  // owner-path marker
    buildAgentAuth,              // [agentKey, reasoningTopicId]
    AGENT_AUTH_TUPLE_TYPE,

    // Typed enums (numeric values verified vs Solidity)
    BidStatus, BidValidityCode,
    AuctionState, PaymentToken,
    ActionType, AuthFailCode,
    VipTier, LshTier,            // NOTE: deliberately separate enums

    // Typed structs
    BidDetails, AgentEnvelope, EnvelopeParams, TierLimits,
    Trade, TokenSerialPrice,
    AuctionItem, RoyaltyInfo, AuctionSnapshot, AuctionParams,
} from '@lazysuperheroes/marketplace-sdk';

const { bidderFactory, englishAuction, vipSubscription, lazySecureTrade } =
    getAddresses('testnet');
// → { hederaId: '0.0.9052252', evmAddress: '0x...008a205c' }
```

**v0.1 ships transport primitives only.** Write-path
`TransactionRequest` builders, mirror-node read helpers, and event
decoders are deferred to v0.2 — they're your job to design once you
know the exact shape this runtime needs. When you converge on stable
patterns, propose them back to the contracts repo as PRs to
`packages/sdk/`.

---

## Latest testnet deploys

Match what `getAddresses('testnet')` returns:

```
LazySecureTrade        0.0.9052246  (0x...008a2056)
BidderContract (impl)  0.0.9052248  (0x...008a2058)
BidderContractFactory  0.0.9052252  (0x...008a205c)
VIPSubscription        0.0.9043912  (0x...0089ffc8)
EnglishAuction         0.0.9052454  (0x...008a2126)
```

Mainnet addresses are still null in the SDK — v0.3 hasn't shipped to
mainnet yet.

---

## First milestone — the SNIPER agent

This is the curated v1 use case (per product). Spec:

> Watch the auction surface for items the user wants. Place bids
> through the user's stash, capped by the agent envelope, using a
> configurable strategy (e.g., snipe in the anti-snipe window with a
> max-bid cap).

Concrete on-chain interactions you'll need:

1. **Read auctions** — `EnglishAuction.getAuctionSnapshot(auctionId)` /
   `getActiveAuctionsForToken(token, offset, limit)` via mirror.
2. **Place a bid through the stash** — the stash exposes
   `placeAuctionBid(auctionId, amount, AgentAuth)`; pass a populated
   `AgentAuth` (built via `buildAgentAuth(agentEoa, hcs10TopicId)`).
   The stash verifies + consumes the envelope budget atomically.
3. **Pre-flight gate** — call `BidderContract.canAuthorize(...)` first
   to fail fast without burning gas on a revert.

The stash holds the funds. The agent's only job is timing + amount
selection. Sovereignty paths (`rescueNFT`, `rescueHbar`,
`detachFromFactory`) are owner-only — the agent cannot touch them.

### Suggested runtime skeleton

```
src/
  agents/
    sniper/
      strategy.ts       # bid amount + timing logic
      watcher.ts        # mirror polling / event subscription
      executor.ts       # ethers tx submission via @hashgraph/sdk
  config/
    networks.ts         # testnet / mainnet routing
    accounts.ts         # agent Hedera accounts (env-loaded)
  hcs10/
    topic.ts            # off-chain reasoning trace logged here
  index.ts              # entry: pick agent, start runtime
```

HCS-10 is Hedera's standard for agent reasoning topics. Each agent
action carries a `reasoningTopicId` (`bytes32` in the `AgentAuth`
tuple) that off-chain readers correlate to a topic where you logged
the agent's reasoning. Use `0x00...00` if you're not logging trace.

---

## Reference materials (in the contracts repo)

All in `github.com/Burstall/hedera-SC-LazySecureTrade` on the `v0.3` branch.

### Architecture + design

- **`docs/AGENT-MARKETPLACE-DELTA.md`** — full architectural delta +
  16-row decisions table. Read first.
- **`docs/AGENT-MARKETPLACE-PICKUP.md`** — contract-side pickup items
  (most resolved; some still open). Skim for context on open
  questions.
- **`docs/EnglishAuction-DESIGN.md`** — auction primitive design,
  includes SNIPER integration pattern (~line 381).
- **`docs/VIPSubscription-DESIGN.md`** — paid tier mechanics.
- **`docs/LSHTierLib-DESIGN.md`** — LSH-holdings tier (orthogonal to
  VIP — used for trade fee discount, not envelope caps).
- **`docs/BCF-StashAllowances-DESIGN.md`** — how stash-listed trades
  resolve to the beneficial owner.

### Operational

- **`docs/v0.3-OPS-RUNBOOK.md`** — deployment procedures, gotchas.
- **`docs/v0.3-WORKING-PLAN.md`** — current state of the contracts
  branch; check this for what's shipped vs outstanding.
- **`packages/sdk/README.md`** — SDK install paths, what's in v0.1,
  what's deferred.

### Source of truth

- **`contracts/interfaces/IAgentEnvelope.sol`** — envelope struct,
  enums, errors. The SDK types mirror this exactly.
- **`contracts/interfaces/IBidderContractFactory.sol`** — BCF surface
  including `createTradeOnBehalfOfStash`, `cancelTradeFromStash`,
  envelope-aware `createBid`/`cancelBid`.
- **`contracts/interfaces/IEnglishAuction.sol`** — auction params,
  snapshot struct, events.
- **`contracts/interfaces/IVIPSubscription.sol`** — `Tier` enum (NOTE:
  `LSHTierLib.Tier` is a different enum with different Silver value;
  the SDK types both correctly).
- **`utils/agentAuth.js`** — the JS reference for `AgentAuth`; the
  SDK's `src/helpers/agentAuth.ts` is its TS port.

### Tier table (the locked defaults)

| Tier | Slots | Daily HBAR | Daily LAZY | Per-tx HBAR | Per-tx LAZY |
|------|-------|------------|------------|-------------|-------------|
| Free | 0 | — | — | — | — |
| Bronze | 1 | 500 | 5,000 | 200 | 2,000 |
| Silver | 2 | 1,500 | 15,000 | 500 | 5,000 |
| Gold | 3 | 3,500 | 35,000 | 1,000 | 10,000 |
| Platinum | 5 | 10,000 | 100,000 | 2,500 | 25,000 |

Free tier has 0 slots — Free users cannot run any agents. LSH holders
get 1 free slot **off-chain only** (UX rule, not enforced on-chain) —
the runtime should refuse to provision an agent for a Free-tier user
unless they're an LSH holder, then surface that "free slot" in the
SDK layer.

---

## What NOT to do

- **Don't fork the contracts.** The contracts repo is the single source
  of truth. If you need a contract change, open an issue or PR there.
- **Don't add EIP-712 / ecrecover anywhere in the runtime.** The auth
  model is intentionally msg.sender-only. Re-adding signature
  verification would break ED25519 agents (no EVM precompile on Hedera).
- **Don't try to bypass the envelope** for "convenience." Owner-path
  (`EMPTY_AUTH`) is only valid when the human's EOA is `msg.sender` —
  the runtime, by definition, is not the human's EOA.
- **Don't poll mirror at sub-second rates.** Hedera mirror is a shared
  resource. Use event subscription patterns (websocket / SSE if
  available) and reserve polling for fallback.
- **Don't store the user's private key.** Each agent is its own Hedera
  account with its own key. The user authorizes the agent's address via
  `createEnvelope` on their stash — the runtime never touches the
  user's key.
- **Don't introduce a JS bigint → number cast for any uint96 / uint256
  field.** The SDK's types use `bigint` deliberately; collapsing to
  Number loses precision above 2^53.

---

## First-session checklist

When the agent runtime repo's first Claude Code session starts:

1. `yarn init -y` + install ethers + @hashgraph/sdk + the marketplace SDK.
2. Skim `docs/AGENT-MARKETPLACE-DELTA.md` in the contracts repo
   (fetch via WebFetch on the GitHub URL — no clone needed).
3. Write a smoke test: import the SDK, call `getAddresses('testnet')`,
   construct an ethers `Interface`, encode `cancelBid` calldata with
   `EMPTY_AUTH`. Verify the bytes round-trip via `decodeFunctionData`.
4. Stand up a single-agent SNIPER skeleton against testnet. Use a
   throwaway agent Hedera account + a throwaway VIP-Bronze stash so
   the budget cap surfaces early.
5. Iterate.

---

## Open questions you'll have to answer

These are deferred from the contracts side and need product/runtime
input:

- **HCS-10 topic format.** The `reasoningTopicId` field is `bytes32`
  in the envelope/auth tuple, but what off-chain schema is the topic
  itself? (Standard HCS-10 message envelope? Custom format? See
  `docs/AGENT-MARKETPLACE-DELTA.md` for what's been discussed.)
- **Multi-agent strategies.** A Platinum user gets 5 slots — how do
  multiple agents coordinate on the same stash without stepping on each
  other's budget? Per-agent allowed-action bitmaps help, but the
  runtime needs to enforce coherent strategy at composition time.
- **Settlement bounty keeper.** EnglishAuction's `settle()` pays a
  keeper bounty. Worth running a settlement-keeper bot alongside the
  user-facing agents? (Probably yes, separate process, separate
  account.)
- **What does an "agent" look like in the consumer UI.** Wallet, name,
  reasoning trace surface, manual override, kill switch (the contract
  exposes `pauseAgent` + `pauseAllAgents`; the UI should too).

Bring these up early — the answers shape the runtime architecture
more than any code decision.
