# @lazysuperheroes/marketplace-sdk

TypeScript SDK for the **LazySecureTrade** marketplace on Hedera.

Wraps the v0.3 contract surface so consumers (agent runtime, frontend,
analytics) get strongly-typed ABIs, deployed addresses per network,
ethers `Interface` instances, and the `AgentAuth` tuple shape — without
having to copy ABIs around or hand-roll enums.

---

## Scope

This is the **v0.2** release. It still ships transport primitives only —
ABIs, addresses, ethers `Interface`s, typed enums/structs, and the
`AgentAuth` helper — but now covers the **full v0.3 contract surface**,
including the staker-rebate stack (`LazyRebatePool` +
`LSHRebateMultipliers`) that 0.1.x listed by address but did not yet
expose an ABI for.

### In v0.2

| Surface | What's exported |
|---|---|
| ABIs | `LazySecureTrade`, `BidderContractFactory`, `BidderContract` (stash), `EnglishAuction`, `VIPSubscription`, **`LazyRebatePool`**, **`LSHRebateMultipliers`** — bundled under `./abi/*` and re-exported as JS arrays |
| Addresses | `ADDRESSES` registry per network (`mainnet` / `testnet` / `previewnet`), with both Hedera id (`0.0.X`) and EVM long-zero address for each contract (rebate stack included) |
| Ethers `Interface` factories | One per contract (seven total), lazily constructed — use for calldata encoding, return-data decoding, event log parsing |
| `AgentAuth` tuple | `EMPTY_AUTH`, `buildAgentAuth(...)`, `AGENT_AUTH_TUPLE_TYPE` — TS port of the `utils/agentAuth.js` helper from the contract repo |
| Typed enums | `BidStatus`, `BidValidityCode`, `AuctionState`, `PaymentToken`, `ActionType`, `AuthFailCode`, `VipTier`, `LshTier` — numeric values verified against the Solidity sources |
| Typed structs | `BidDetails`, `AgentEnvelope`, `EnvelopeParams`, `TierLimits`, `Trade`, `TokenSerialPrice`, `AuctionItem`, `RoyaltyInfo`, `AuctionSnapshot`, `AuctionParams`, **`RebateEpoch`** |

### New in v0.2

- **Rebate stack ABIs + Interfaces** — `LazyRebatePoolAbi` /
  `LSHRebateMultipliersAbi`, plus `lazyRebatePoolInterface()` /
  `lshRebateMultipliersInterface()`. Everything a claim UI needs to
  encode `claim(epoch, amount, proof)`, decode `epochs(...)` /
  `poolBalance()` / `getMultiplier(...)`, and parse `EpochSettled` /
  `RebateClaimed` / `EpochRecycled` events.
- **`RebateEpoch` struct** — decoded shape of the `epochs(uint256)`
  getter (`merkleRoot`, `totalAllocated`, `totalClaimed`, `settledAt`).

### Still deferred (later release)

- **Write-path `TransactionRequest` builders** — pre-populated tx objects
  for the common flows (create/cancel bid, execute against bid, create
  auction, place auction bid, settle, create envelope). Consumers build
  their tx/calldata layer on top of the `Interface` factories for now.
- **Mirror-node read helpers** — typed wrappers around
  `mirrornode.hedera.com` for bid registry queries, auction snapshots,
  envelope reads, stash discovery.
- **Event decoders** — convenience `findLastEventByName` /
  `getDecodedEventsFromMirror` ports of the contract-repo test helpers.
- **Network registry for mainnet** — placeholder `null` until the v0.3
  mainnet deploy lands.

---

## Install

```bash
yarn add @lazysuperheroes/marketplace-sdk ethers@^6 @hashgraph/sdk@^2.50
```

Peer dependencies the consumer must provide:

```json
{
  "@hashgraph/sdk": "^2.50.0",
  "ethers": "^6.0.0"
}
```

Pre-built `dist/` + bundled ABIs ship in the npm tarball — no build
step runs on the consumer side.

### Local development against an unpublished SDK change

If you're iterating on the SDK source itself (not just consuming it),
use `yarn link` to symlink instead of waiting on a publish:

```bash
# in packages/sdk (after every SDK change)
yarn build && yarn link

# in agent runtime repo (one-time)
yarn link "@lazysuperheroes/marketplace-sdk"
```

Or use the `file:` protocol:

```jsonc
// agent runtime package.json
"dependencies": {
  "@lazysuperheroes/marketplace-sdk":
    "file:../hedera-SC-LazySecureTrade/packages/sdk"
}
```

---

## Usage

### Resolve a contract address

```typescript
import { getAddresses } from '@lazysuperheroes/marketplace-sdk';

const addrs = getAddresses('testnet');
console.log(addrs.bidderFactory);
// { hederaId: '0.0.9052252', evmAddress: '0x00000000...008a205c' }
```

### Encode calldata for an agent-mediated `cancelBid`

```typescript
import {
    bidderContractFactoryInterface,
    buildAgentAuth,
} from '@lazysuperheroes/marketplace-sdk';

const iface = bidderContractFactoryInterface();
const auth = buildAgentAuth(agentEoaAddress, hcs10TopicId);
const calldata = iface.encodeFunctionData('cancelBid', [bidId, auth]);
```

### Decode a `BidExecuted` event

```typescript
import { bidderContractFactoryInterface, BidStatus } from '@lazysuperheroes/marketplace-sdk';

const iface = bidderContractFactoryInterface();
const log = iface.parseLog({ topics, data });
if (log?.name === 'BidExecuted') {
    const { bidId, executor, agentKey } = log.args;
    // ...
}
```

### Owner-path call (no agent envelope)

```typescript
import { EMPTY_AUTH, bidderContractFactoryInterface } from '@lazysuperheroes/marketplace-sdk';

const iface = bidderContractFactoryInterface();
const calldata = iface.encodeFunctionData('createBid', [bidDetails, EMPTY_AUTH]);
```

### Claim a staker rebate

The Merkle root, per-user `amount`, and `proof` come from the off-chain
settlement output (`scripts/ops/computeRebateEpoch.js` in the contract
repo). The SDK gives you the address, ABI, and Interface to encode the
on-chain claim and read the pool.

```typescript
import {
    getAddresses,
    lazyRebatePoolInterface,
    type RebateEpoch,
} from '@lazysuperheroes/marketplace-sdk';

const { lazyRebatePool } = getAddresses('testnet');
const iface = lazyRebatePoolInterface();

// encode the claim
const calldata = iface.encodeFunctionData('claim', [epoch, amount, proof]);

// decode an `epochs(epoch)` mirror read into a typed struct
const [merkleRoot, totalAllocated, totalClaimed, settledAt] =
    iface.decodeFunctionResult('epochs', returnData);
const ep: RebateEpoch = { merkleRoot, totalAllocated, totalClaimed, settledAt };
```

`LSHRebateMultipliers` is pure-view — use `lshRebateMultipliersInterface()`
to encode `getMultiplier(token, serial)` / `minPerUnitValue(poolAmount)`
when displaying a stash's rebate weight.

---

## AgentAuth model — important

Authentication is **msg.sender-only**. Hedera's protocol layer verifies
the agent's transaction signature (ECDSA secp256k1 OR ED25519, native to
whatever key type the agent's Hedera account holds) before the EVM runs.
Contracts check `msg.sender == envelope.agentKey` against the envelope's
stored agentKey. There is no EIP-712, no ecrecover, no nonce.

`buildAgentAuth(agentKey, reasoningTopicId)` produces the calldata
tuple. `EMPTY_AUTH` is the owner-path marker — pass it wherever a
function takes `AgentAuth` but the caller is the stash owner / direct
EOA (not an envelope-mediated agent).

---

## Repo layout

```
packages/sdk/
├── abi/                       # bundled ABIs (regenerated from artifacts/)
├── scripts/copyAbis.js        # ABI extraction script
├── src/
│   ├── abi/index.ts           # ABI re-exports
│   ├── contracts/
│   │   ├── addresses.ts       # per-network address registry
│   │   └── interfaces.ts      # ethers Interface factories
│   ├── helpers/
│   │   └── agentAuth.ts       # AgentAuth tuple helpers
│   ├── types/index.ts         # enums + structs
│   └── index.ts               # public barrel
├── package.json
├── tsconfig.json
└── README.md                  # this file
```

---

## Development

From `packages/sdk/`:

```bash
yarn install            # installs tsup + typescript (peer deps come from the consumer)
yarn copy-abi           # extract ABIs from ../../artifacts/contracts/
yarn typecheck          # tsc --noEmit
yarn build              # tsup → dist/ (CJS + ESM + .d.ts)
yarn dev                # tsup --watch
```

`prebuild` runs `copy-abi` automatically, so `yarn build` is a
single-command "fresh ABIs + clean compile". The build will fail loudly
if any of the 7 artifacts is missing — run `yarn hardhat compile` in the
repo root first.

---

## Versioning

SDK versioning will track contract releases once mainnet ships. For now:

- **0.1.x** — pre-mainnet, testnet addresses only, transport primitives
  for the core five contracts.
- **0.2.x** — full v0.3 contract surface, including the staker-rebate
  stack (`LazyRebatePool` + `LSHRebateMultipliers`) ABIs, Interfaces, and
  the `RebateEpoch` struct. Still transport-only.
- **0.3.x** — write-path builders + mirror helpers when the agent
  runtime lands.
- **1.0.0** — first release with populated mainnet addresses.
