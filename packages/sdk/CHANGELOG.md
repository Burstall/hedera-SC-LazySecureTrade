# Changelog

All notable changes to `@lazysuperheroes/marketplace-sdk`.

## 0.2.2 — 2026-06-28

### Added
- **`VIPSubscription` x402 grant surface.** The bundled `VIPSubscription`
  ABI now carries the system-granted tier-override members used by the
  x402 convenience rail (pay HBAR/USDC off-chain, grant the paid tier
  on-chain so `getTierFor`/`subscriptionOf` stay the single source of
  truth — no off-chain overlay):
  - `grantSubscription(address user, uint8 tier, uint16 months, bytes32 ref)`
    — grant a specific tier WITHOUT `$LAZY`, callable by the owner or the
    registered `systemWallet`. Mirrors `purchaseSubscription` transitions
    (new / extend / upgrade-in-place / revert-on-downgrade). `ref` is a
    single-use idempotency key.
  - `setSystemWallet(address)` + the `systemWallet()` and
    `consumedRefs(bytes32)` views.
  - New events/errors: `SubscriptionGrantedBySystem`, `SystemWalletChanged`,
    `NotAuthorizedGrantor`, `RefAlreadyConsumed` (decodable via
    `vipSubscriptionInterface().parseError(...)`).

### Changed
- **Testnet address registry refreshed** — the full marketplace stack was
  redeployed under a single operator (`0.0.7934339`); the prior testnet
  stack was owned by a different bootstrap operator. New testnet ids:
  `lazySecureTrade 0.0.9367217`, `bidderImpl 0.0.9367257`,
  `bidderFactory 0.0.9367262`, `englishAuction 0.0.9367272`,
  `vipSubscription 0.0.9367578` (x402-grant build), `lazyRebatePool 0.0.9367573`,
  `lshRebateMultipliers 0.0.9367358`. Mainnet/previewnet remain `null`.

### Notes
- Transport-only and additive — no new exports, no struct changes.
  `VIPSubscription` is a non-proxy contract, so the grant members ship in a
  fresh deploy; consumers like `EnglishAuction` hold a mutable pointer and
  were repointed, not redeployed. Mainnet is unaffected (still `null`).

## 0.2.1 — 2026-06-24

### Added
- **`LazyGasStation` ABI + Interface — for revert decoding.** LazyGasStation
  is a shared dependency (not a marketplace contract), but LST and the
  bidder factory fan into it for `$LAZY` draws and HBAR refills, so a revert
  there bubbles up a LazyGasStation custom error that the marketplace ABIs
  alone cannot resolve. Now bundled so consumers can name them:
  - `LazyGasStationAbi` exported from `./abi` (and `ABIS.LazyGasStation`).
  - `lazyGasStationInterface()` Interface factory (and
    `INTERFACES.LazyGasStation`) — use `parseError(revertData)` to resolve
    the 11 custom errors (`InsufficientAllowance`, `PayoutFailed`,
    `NetPayoutFailed`, `AssociationFailed`, `BurnFailed`, etc.).
  - Bundled `abi/LazyGasStation.json` (the SDK now ships 8 ABIs).

### Notes
- Additive and transport-only — no address-registry entry (error decoding
  needs only the Interface, not a deployed address) and no change to any
  existing export. Stays in the `0.2.x` line; `0.3.x` remains reserved for
  the write-path builders + mirror helpers.

## 0.2.0 — 2026-06-02

### Added
- **Staker-rebate stack — full transport surface.** The ABIs, ethers
  `Interface` factories, and typed struct deferred from 0.1.1 now ship:
  - `LazyRebatePoolAbi` and `LSHRebateMultipliersAbi` exported from `./abi`
    — the SDK now bundles all 7 v0.3 contract ABIs.
  - `lazyRebatePoolInterface()` and `lshRebateMultipliersInterface()`
    Interface factories.
  - `RebateEpoch` type — the decoded shape of
    `LazyRebatePool.epochs(uint256)` (`merkleRoot`, `totalAllocated`,
    `totalClaimed`, `settledAt`) for the frontend claim UI. Leaves are
    `keccak256(abi.encodePacked(user, amount))`; an all-zero `merkleRoot`
    means the epoch is unsettled.

### Changed
- `lazyRebatePool` and `lshRebateMultipliers` are now first-class fields in
  the `MarketplaceAddresses` registry (testnet populated; mainnet/previewnet
  `null` pending deploy). In 0.1.1 these were addresses-only, with their
  ABIs/Interfaces/struct deferred.

### Notes
- Scope is still **transport-only**. Write-path `TransactionRequest` builders
  and mirror-node read helpers remain deferred to a later release alongside
  the agent runtime — see the README deferred list.

## 0.1.1 — 2026-05-29

### Fixed
- **Stale testnet addresses.** The 0.1.0 registry pointed at the
  2026-05-2x deploys. Refreshed to the current v0.3 testnet stack:
  - `lazySecureTrade` → `0.0.9057802`
  - `bidderImpl` → `0.0.9062594`
  - `bidderFactory` → `0.0.9062601`
  - `vipSubscription` → `0.0.9077208` (rebate-patched, 3-sink split)
  - `englishAuction` → `0.0.9052454` (unchanged)

### Added
- **Staker-rebate stack addresses** in the `MarketplaceAddresses`
  registry (additive, non-breaking):
  - `lazyRebatePool` → `0.0.9077172`
  - `lshRebateMultipliers` → `0.0.9077153`
  - Addresses only — their ABIs, ethers Interfaces, and typed structs
    are deferred to 0.2.0 (driven by the frontend claim UI). The
    subscription-side rebate config is already covered by the
    `vipSubscription` ABI.

### Notes
- Transport-only scope is unchanged from 0.1.0. Write-path
  TransactionRequest builders + mirror-node read helpers still land in
  0.2.0 alongside the agent runtime.

## 0.1.0 — 2026-05-25

- Initial release. Transport primitives: ABIs, address registry,
  ethers Interface factories, AgentAuth helpers, typed enums + structs
  for the 5-contract v0.3 surface (LST, BCF, BidderContract,
  EnglishAuction, VIPSubscription).
