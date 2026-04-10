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
