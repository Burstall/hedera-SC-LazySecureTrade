// SPDX-License-Identifier: GPL-3.0
pragma solidity >=0.8.12 <0.9.0;

/**
 * @title IVIPSubscription
 * @notice Minimal read interface for consumers of `VIPSubscription`.
 *         Agent envelope contracts (future BCF stash extension), the
 *         agent runtime, and frontends read subscription tier via this
 *         interface — they do NOT consume the full contract surface.
 * @dev    Trade-fee paths (LST, LazyTradeLotto) do NOT consume this —
 *         trade fees stay tied to LSH holdings via `LSHTierLib`.
 */
interface IVIPSubscription {
    /// @notice Subscription tier ordering: Free < Bronze < Silver < Gold < Platinum.
    enum Tier { Free, Bronze, Silver, Gold, Platinum }

    /// @notice Snapshot of a user's paid subscription. `expiresAt == 0`
    ///         or `expiresAt < block.timestamp` both mean "no active
    ///         subscription"; the tier field is informational in the
    ///         expired case (retained for post-mortem queries).
    struct Subscription {
        Tier tier;
        uint64 expiresAt;
    }

    /**
     * @notice Returns the user's currently-active paid tier, or `Free`
     *         if they have no subscription or the subscription has
     *         expired. Trivial single-SLOAD + timestamp comparison.
     * @param user Address to look up.
     * @return Active tier; `Free` for expired or never-subscribed.
     */
    function getTierFor(address user) external view returns (Tier);

    /**
     * @notice Returns the user's subscription struct verbatim, even if
     *         expired. Useful for indexers and renewal-prompt UI.
     * @param user Address to look up.
     */
    function subscriptionOf(address user) external view returns (Subscription memory);

    /**
     * @notice Returns the user's remaining subscription duration in
     *         seconds. Zero if no subscription or already expired.
     */
    function remainingDuration(address user) external view returns (uint256);
}
