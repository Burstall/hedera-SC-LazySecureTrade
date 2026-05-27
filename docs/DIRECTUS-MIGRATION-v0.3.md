# Directus Schema Migration — v0.3 Bidder Factory

This document describes the Directus table schema changes required to support the `bidderFactoryEventScanner.js` which indexes BidderContractFactory + stash events from v0.3.

The existing v0.2 tables (`secureTradeEvents` and `SecureTradesCache`) are **untouched** — v0.3 uses three new tables alongside them.

## .env additions

Add these to your `.env` alongside the existing `SECURE_TRADE_*` vars:

```env
## v0.3 BidderContractFactory scanner
BIDDER_FACTORY_CONTRACT_ID=0.0.XXXXXXX
BIDDER_FACTORY_EVENTS_TABLE=bidderFactoryEvents
BIDDER_BIDS_CACHE_TABLE=bidderBidsCache
BIDDER_STASH_EVENTS_TABLE=bidderStashEvents
```

The `DIRECTUS_DB_URL`, `DIRECTUS_TOKEN`, and `SECURE_TRADE_ENV` vars are shared with the existing v0.2 scanner.

---

## Table 1: `bidderFactoryEvents` — Scanner state

Tracks the scanner's last-scanned timestamp per factory contract + environment. Mirrors the pattern used by `secureTradeEvents` for the v0.2 scanner.

| Field | Type | Notes |
|---|---|---|
| `id` | integer (auto PK) | Directus default primary key |
| `factoryContract` | string (32) | Hedera contract ID, e.g., `0.0.1234567` |
| `environment` | string (16) | `mainnet`, `testnet`, `previewnet`, `local` |
| `lastTimestamp` | string (32) | Mirror node consensus timestamp (seconds.nanoseconds) |
| `date_created` | datetime | Directus auto-field |
| `date_updated` | datetime | Directus auto-field |

**Unique constraint**: `(factoryContract, environment)` — one scanner state per contract per network.

### Create in Directus Admin

1. Go to **Settings → Data Model → Create Collection**
2. Collection name: `bidderFactoryEvents`
3. Add fields:
   - `factoryContract` — Type: String, Interface: Input, Required
   - `environment` — Type: String, Interface: Input, Required
   - `lastTimestamp` — Type: String, Interface: Input, Default: `0`

---

## Table 2: `bidderBidsCache` — Active/historical bid index

Caches bid data from `BidCreated` events and tracks lifecycle status updates from `BidCancelled`, `BidExecuted`, and `BidExpired` events. This is the primary table the frontend queries for bid discovery.

| Field | Type | Notes |
|---|---|---|
| `id` | integer (auto PK) | Directus default primary key |
| `factoryContract` | string (32) | Factory contract ID |
| `bidId` | string (66) | bytes32 hex string |
| `user` | string (16) | Hedera account ID of the bidder (e.g., `0.0.1234`) |
| `token` | string (16) | Hedera token ID of the target NFT collection |
| `stash` | string (42) | EVM address of the user's stash |
| `hbarAmount` | bigInteger | Bid HBAR amount in tinybars |
| `lazyAmount` | bigInteger | Bid $LAZY amount |
| `expiry` | bigInteger | Unix timestamp (0 = no expiry) |
| `minAcceptablePrice` | bigInteger | Bidder's arbitrage price floor (tinybars) |
| `serials` | json / text | JSON array of target serial numbers (e.g., `[1,2,3]`); empty array `[]` = any serial |
| `status` | string (16) | `Active`, `Cancelled`, `Executed`, `Expired` |
| `environment` | string (16) | Network environment |
| `timestamp` | string (32) | Mirror node consensus timestamp when the bid was created |
| `date_created` | datetime | Directus auto-field |
| `date_updated` | datetime | Directus auto-field |

**Index recommendations**:
- `(factoryContract, environment, status)` — filter active bids per network
- `(factoryContract, environment, token)` — discover bids by collection
- `(factoryContract, environment, user)` — user's bid history

### Create in Directus Admin

1. Collection name: `bidderBidsCache`
2. Add fields:
   - `factoryContract` — String, Required
   - `bidId` — String, Required
   - `user` — String, Required
   - `token` — String, Required
   - `stash` — String
   - `hbarAmount` — Big Integer, Default: `0`
   - `lazyAmount` — Big Integer, Default: `0`
   - `expiry` — Big Integer, Default: `0`
   - `minAcceptablePrice` — Big Integer, Default: `0`
   - `status` — String, Default: `Active`, Interface: Dropdown with options: `Active`, `Cancelled`, `Executed`, `Expired`
   - `environment` — String, Required
   - `timestamp` — String

---

## Table 3: `bidderStashEvents` — General v0.3 event log

Stores non-bid events from the factory and stash contracts as structured JSON. This table serves as an append-only event log for:

- `StashDeployed` — new stash deployments
- `BidExecuted` — trade execution metadata (correlated with bid status in `bidderBidsCache`)
- `ArbitrageExecuted` — arbitrage profit splits
- `TradeCreatedFromStash` — NFT listings from stash holdings
- `StashArbSettled` — stash-side arbitrage settlement records
- `FactoryDetached` — sovereignty detachment events
- `ArbProfitClaimed` — arbitrageur profit withdrawals
- `ProtocolProfitWithdrawn` — protocol treasury withdrawals

| Field | Type | Notes |
|---|---|---|
| `id` | integer (auto PK) | Directus default primary key |
| `factoryContract` | string (32) | Factory contract ID |
| `eventType` | string (32) | Event name (e.g., `ArbitrageExecuted`) |
| `data` | json / text | Full event payload as JSON string |
| `environment` | string (16) | Network environment |
| `timestamp` | string (32) | Mirror node consensus timestamp |
| `date_created` | datetime | Directus auto-field |

**Index recommendations**:
- `(factoryContract, environment, eventType)` — filter by event type
- `(factoryContract, environment, timestamp)` — chronological queries

### Create in Directus Admin

1. Collection name: `bidderStashEvents`
2. Add fields:
   - `factoryContract` — String, Required
   - `eventType` — String, Required
   - `data` — JSON or Text (JSON preferred if your Directus version supports it)
   - `environment` — String, Required
   - `timestamp` — String

---

## Relationship to existing v0.2 tables

| Table | Scanner | Purpose |
|---|---|---|
| `secureTradeEvents` | `secureTradeEventScanner.js` (v0.2) | LST scanner state (timestamp tracking) |
| `SecureTradesCache` | `secureTradeEventScanner.js` (v0.2) | Individual + batch trade cache for LST |
| **`bidderFactoryEvents`** | `bidderFactoryEventScanner.js` (v0.3) | Factory scanner state |
| **`bidderBidsCache`** | `bidderFactoryEventScanner.js` (v0.3) | Bid lifecycle cache (Active → terminal) |
| **`bidderStashEvents`** | `bidderFactoryEventScanner.js` (v0.3) | General v0.3 event log |

The v0.2 and v0.3 scanners run independently — they scan different contract addresses and write to different tables. You can run both in parallel (e.g., via cron or a scheduler) without conflicts.

---

## Running the scanner

```bash
# One-shot scan
node scripts/interactions/bidderFactoryEventScanner.js

# Or with explicit contract ID
node scripts/interactions/bidderFactoryEventScanner.js 0.0.1234567

# Cron (every 2 minutes)
*/2 * * * * cd /path/to/repo && node scripts/interactions/bidderFactoryEventScanner.js >> /var/log/bidder-scanner.log 2>&1
```

The scanner is incremental — it picks up from the last-scanned timestamp on each run. First run fetches the full event history; subsequent runs only fetch new events.

---

## Frontend query patterns

Once the tables are populated, typical Directus SDK queries:

```javascript
// Get all active bids for a token on mainnet
const activeBids = await client.request(readItems('bidderBidsCache', {
  filter: {
    token: { _eq: '0.0.1234' },
    environment: { _eq: 'mainnet' },
    status: { _eq: 'Active' },
  },
  sort: ['-hbarAmount'], // highest bid first
  limit: 50,
}));

// Get a user's bid history (all statuses)
const userBids = await client.request(readItems('bidderBidsCache', {
  filter: {
    user: { _eq: '0.0.5678' },
    environment: { _eq: 'mainnet' },
  },
  sort: ['-timestamp'],
}));

// Get recent arbitrage events
const arbEvents = await client.request(readItems('bidderStashEvents', {
  filter: {
    eventType: { _eq: 'ArbitrageExecuted' },
    environment: { _eq: 'mainnet' },
  },
  sort: ['-timestamp'],
  limit: 20,
}));
```

---

## Rollback

To remove the v0.3 tables (e.g., during a failed migration):

1. Delete the three collections in Directus Admin: `bidderFactoryEvents`, `bidderBidsCache`, `bidderStashEvents`
2. Remove the `BIDDER_*` env vars from `.env`
3. The v0.2 scanner and tables are unaffected

---

## Addendum (2026-05-27) — Agent envelope event tables

The bid/trade/arb schema above doesn't cover the v0.3 agent
envelope subsystem (envelopes on each stash, budget consumption
events, kill-switch toggles). Indexers that want to drive
agent-permission UI, budget remaining displays, or
EnvelopeBudgetConsumed analytics need two additional tables.

### Table: `agentEnvelopes` — Current state per (stash, agent)

One row per active envelope. Derived from the event stream;
updated on every CRUD or budget event.

| Field | Type | Notes |
|---|---|---|
| `id` | integer (auto PK) | Directus default primary key |
| `stash` | string (44) | Stash address (EVM, 0x-prefixed) |
| `owner` | string (44) | Stash owner EVM address (denormalized for query speed) |
| `agentKey` | string (44) | Authorized agent's EVM address |
| `dailyHbarCap` | string (32) | Bigint as string (tinybars) |
| `dailyLazyCap` | string (32) | Bigint as string (LAZY base units) |
| `perTxHbarCap` | string (32) | |
| `perTxLazyCap` | string (32) | |
| `consumedHbarToday` | string (32) | Running counter; resets at UTC midnight |
| `consumedLazyToday` | string (32) | |
| `lastResetDay` | integer | `block.timestamp / 86400` |
| `expiresAt` | integer | Unix seconds; 0 = no expiry |
| `allowedActions` | integer | uint32 bitmap |
| `reasoningTopicId` | string (66) | HCS-10 topic id (bytes32 hex); 0 = unset |
| `paused` | boolean | Per-agent pause flag |
| `cancelled` | boolean | `true` once `EnvelopeCancelled` fires |
| `cancelledReason` | integer | 0 = owner-initiated (currently the only value) |
| `createdAt` | datetime | First seen on chain |
| `updatedAt` | datetime | Last event touched this row |

**Unique constraint**: `(stash, agentKey)` — at most one active
envelope per pair. Cancellation flips `cancelled = true` but
keeps the row for history; re-creation produces a NEW row with
the same `(stash, agentKey)` after marking the old one
cancelled (so the constraint must be on `(stash, agentKey,
cancelled = false)` as a partial unique index).

### Table: `agentEvents` — Event stream

Append-only log of every envelope-related event for audit + UI.
Mirrors the pattern of `bidderStashEvents` for stash-only
events.

| Field | Type | Notes |
|---|---|---|
| `id` | integer (auto PK) | |
| `stash` | string (44) | |
| `owner` | string (44) | |
| `agentKey` | string (44) | Empty for `AllAgentsPaused` |
| `eventType` | string (32) | enum: `EnvelopeCreated`, `EnvelopeCancelled`, `EnvelopePaused`, `AllAgentsPaused`, `EnvelopeBudgetConsumed`, `EnvelopeDailyReset`, `EnvelopeExpired`, `VipSubscriptionSet`, `EnglishAuctionSet` |
| `action` | string (16) | For `EnvelopeBudgetConsumed`: `BidCreate`, `BidCancel`, `TradeExecute`, etc. Empty for other event types |
| `hbarAmount` | string (32) | The consumed amount (bigint) |
| `lazyAmount` | string (32) | |
| `remainingHbar` | string (32) | Post-consumption remainder |
| `remainingLazy` | string (32) | |
| `reasoningTopicId` | string (66) | HCS-10 topic from AgentAuth |
| `timestamp` | string (32) | Mirror consensus timestamp |
| `txId` | string (64) | For dedup + drill-down |
| `environment` | string (16) | `mainnet` / `testnet` etc |
| `date_created` | datetime | |

**Index**: `(stash, agentKey, timestamp)` for the
"events affecting this agent recently" query.

### Indexer hook points

The scanner reads BCF + stash logs (already covered by
`bidderStashEvents`); add a parallel reader for envelope
event topics:

```javascript
const ENVELOPE_TOPICS = [
    'EnvelopeCreated(address,address,uint96,uint96,uint96,uint96,uint64,uint32,bytes32)',
    'EnvelopeCancelled(address,address,uint8)',
    'EnvelopePaused(address,address,bool)',
    'AllAgentsPaused(address,bool)',
    'EnvelopeBudgetConsumed(address,address,uint8,uint96,uint96,uint96,uint96,bytes32)',
    'EnvelopeDailyReset(address,address,uint64)',
    'EnvelopeExpired(address,address,uint64)',
    'VipSubscriptionSet(address)',
    'EnglishAuctionSet(address)',
];
```

The scanner emits the per-stash (the address that emitted the
log) and the agent key (decoded from the first indexed param).

### EnglishAuction event tables

Auctions are a separate contract with its own event stream.
Recommend a third table parallel to the others:

| Field | Type | Notes |
|---|---|---|
| `id` | integer (auto PK) | |
| `auctionId` | string (66) | bytes32 hex |
| `seller` | string (44) | EVM address; the stash if listed via agent |
| `items` | json | `[{token, serialOrAmount, isNFT}, ...]` |
| `payment` | string (8) | `HBAR` or `LAZY` |
| `startPrice` | string (32) | |
| `reservePrice` | string (32) | |
| `buyNowPrice` | string (32) | 0 = no buy-now |
| `closeAt` | integer | Unix seconds; updated on anti-snipe extension |
| `state` | string (16) | enum: `OPEN`, `CLOSED`, `SETTLED`, `FAILED`, `CANCELLED` |
| `highBidder` | string (44) | |
| `highBid` | string (32) | |
| `winner` | string (44) | Set on settle |
| `finalPrice` | string (32) | Set on settle |
| `protocolFee` | string (32) | |
| `settlementBounty` | string (32) | |
| `royaltyPaid` | string (32) | Aggregate across all recipients |
| `extensionsCount` | integer | How many times anti-snipe fired |
| `createdAt` | datetime | |
| `updatedAt` | datetime | |

Plus the per-bid history table if you want bid-by-bid UI:

| Field | Type | Notes |
|---|---|---|
| `auctionId` | string (66) | |
| `bidder` | string (44) | |
| `amount` | string (32) | |
| `previousBidder` | string (44) | |
| `previousAmount` | string (32) | |
| `newCloseAt` | integer | |
| `wasExtension` | boolean | |
| `reasoningTopicId` | string (66) | |
| `timestamp` | string (32) | |

### Migration notes

The agent envelope addition is non-breaking — the existing
`bidderStashEvents` table continues to capture stash events
(`FactoryDetached`, `StashArbSettled`). The new tables sit
alongside.

If you're rolling out a fresh indexer build, you can ship the
4 new tables (`agentEnvelopes`, `agentEvents`, `auctions`,
`auctionBids`) in one Directus migration. If you're patching
an existing v0.3 indexer that pre-dates this addendum, the
agent envelope event topics will have been silently dropped
until the scanner is updated to read them — backfill from
mirror node logs filtered by the topics listed above.
