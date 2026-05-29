# Changelog

All notable changes to `@lazysuperheroes/marketplace-sdk`.

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
