// SPDX-License-Identifier: GPL-3.0
pragma solidity >=0.8.12 <0.9.0;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ILazyDelegateRegistry} from "../interfaces/ILazyDelegateRegistry.sol";
import {ILazyNFTStaking} from "../interfaces/ILazyNFTStaking.sol";

/**
 * @title LSHTierLib
 * @notice Statically-linked library that computes a user's LSH tier from
 *         holdings + delegations + staking. Single source of truth for the
 *         LSH-holder check across LST, BCF, EnglishAuction (future) and
 *         any other consumer that wants tier-based fee discounts.
 *
 * @dev    Library functions are `internal view` so consumers inline the
 *         code at compile time. There is NO cross-contract-call subcall
 *         penalty; consumers pay the bytecode cost of the inlined body.
 *
 *         Tier ordering is hard-coded by check sequence and is load-
 *         bearing — first positive match wins, so Gen 1 (Platinum) is
 *         checked before Mutant (Gold) before Gen 2 (Silver). Reordering
 *         silently changes semantics.
 *
 *         LDR calls are wrapped in try/catch because LazyDelegateRegistry
 *         is immutable and has known revert paths. Degraded fallback is
 *         "no delegation found" — the user still gets their holdings-
 *         based tier. Matches the existing LST behavior we're replacing.
 *
 *         Staking is included by passing a non-zero `lazyNFTStaking`
 *         address in the `TierSources` struct. `getStakedNFTs` returns
 *         the user's full stake set in one subcall; the library iterates
 *         in memory at zero additional subcall cost.
 *
 *         Token addresses are passed via the `TierSources` struct rather
 *         than stored in the library so the library stays stateless and
 *         consumers can extend the struct for future LSH collections
 *         without redeploying the library itself.
 *
 *         See `docs/LSHTierLib-DESIGN.md` for the broader design rationale.
 */
library LSHTierLib {

    /// @notice Tier ordering: Free < Silver < Gold < Platinum.
    ///         Platinum receives the largest fee discount; Free is the
    ///         base (no LSH benefit). Consumers translate tier → fee
    ///         bps via their own table.
    enum Tier { Free, Silver, Gold, Platinum }

    /// @notice Configuration struct passed by consumers at call time.
    /// @param lshGen1 LSH Generation 1 NFT contract (Platinum tier source)
    /// @param lshMutant LSH Mutant NFT contract (Gold tier source)
    /// @param lshGen2 LSH Generation 2 NFT contract (Silver tier source)
    /// @param lazyDelegateRegistry LDR address for delegation lookups.
    ///         Pass `address(0)` to skip the delegation branch.
    /// @param lazyNFTStaking LazyNFTStaking address. Pass `address(0)`
    ///         to skip the staking branch (consumers that don't honor
    ///         staking-as-holdings semantics).
    struct TierSources {
        address lshGen1;
        address lshMutant;
        address lshGen2;
        address lazyDelegateRegistry;
        address lazyNFTStaking;
    }

    /**
     * @notice Returns the highest LSH tier the user qualifies for.
     * @dev    Short-circuits on first positive match. Subcall budget:
     *         - Gen 1 holder:         1 subcall (best case)
     *         - Mutant holder:        2 subcalls
     *         - Gen 2 holder:         3 subcalls
     *         - Staked Gen 1 only:    4 subcalls
     *         - Staked Mutant only:   4 subcalls (still 4 — staking is 1 call)
     *         - Delegated Gen 1:      5 subcalls
     *         - Delegated Mutant:     6 subcalls
     *         - Delegated Gen 2:      7 subcalls (worst case)
     *         - No anything:          7 subcalls
     */
    function getTierFor(
        address user,
        TierSources memory sources
    ) internal view returns (Tier) {
        // Holdings first — cheapest path. balanceOf is 1 subcall each.
        if (IERC721(sources.lshGen1).balanceOf(user) > 0) {
            return Tier.Platinum;
        }
        if (IERC721(sources.lshMutant).balanceOf(user) > 0) {
            return Tier.Gold;
        }
        if (IERC721(sources.lshGen2).balanceOf(user) > 0) {
            return Tier.Silver;
        }

        // Staking — single subcall returns the user's full stake set;
        // iterate in memory across collections. Stakers retain their
        // tier as if they still held the NFT directly.
        if (sources.lazyNFTStaking != address(0)) {
            Tier stakedTier = _stakingTier(
                sources.lazyNFTStaking,
                user,
                sources.lshGen1,
                sources.lshMutant,
                sources.lshGen2
            );
            if (stakedTier == Tier.Platinum) return Tier.Platinum;
            if (stakedTier != Tier.Free) {
                // Hold onto the staking tier as a floor while we check
                // delegations — a delegated higher tier should still win.
                Tier delegatedTier = _delegationTier(sources, user);
                return _maxTier(stakedTier, delegatedTier);
            }
        }

        // Delegations — same priority order, each wrapped in try/catch
        // for LDR resilience. If LDR reverts the user falls back to
        // holdings-only (returns Free below).
        return _delegationTier(sources, user);
    }

    /**
     * @notice Cheap boolean check: does the user qualify for any LSH tier?
     * @dev    LazyLotto's primary call site. Same short-circuit cost as
     *         `getTierFor` — returns on first positive.
     */
    function isAnyHolder(
        address user,
        TierSources memory sources
    ) internal view returns (bool) {
        return getTierFor(user, sources) != Tier.Free;
    }

    // ============================================
    // Internal helpers
    // ============================================

    /// @dev Resolves the user's staking tier. Single subcall to
    ///      `getStakedNFTs`; iteration over the returned arrays is in
    ///      memory and costs no additional subcalls. Returns the highest
    ///      tier across all staked collections.
    function _stakingTier(
        address staking,
        address user,
        address lshGen1,
        address lshMutant,
        address lshGen2
    ) private view returns (Tier) {
        try ILazyNFTStaking(staking).getStakedNFTs(user) returns (
            address[] memory collections,
            uint256[][] memory /* serials */
        ) {
            Tier highest = Tier.Free;
            uint256 n = collections.length;
            for (uint256 i; i < n; ) {
                address c = collections[i];
                if (c == lshGen1) return Tier.Platinum;
                if (c == lshMutant && highest < Tier.Gold) {
                    highest = Tier.Gold;
                }
                else if (c == lshGen2 && highest < Tier.Silver) {
                    highest = Tier.Silver;
                }
                unchecked { ++i; }
            }
            return highest;
        } catch {
            // Staking contract reverted or returned malformed data —
            // degrade to "no staking" gracefully. Same posture as the
            // LDR try/catch.
            return Tier.Free;
        }
    }

    /// @dev Resolves the user's delegation tier in priority order.
    ///      Each LDR call wrapped in try/catch via `_safeDelegatedLength`.
    function _delegationTier(
        TierSources memory sources,
        address user
    ) private view returns (Tier) {
        if (sources.lazyDelegateRegistry == address(0)) return Tier.Free;
        if (_safeDelegatedLength(
            sources.lazyDelegateRegistry, user, sources.lshGen1
        ) > 0) {
            return Tier.Platinum;
        }
        if (_safeDelegatedLength(
            sources.lazyDelegateRegistry, user, sources.lshMutant
        ) > 0) {
            return Tier.Gold;
        }
        if (_safeDelegatedLength(
            sources.lazyDelegateRegistry, user, sources.lshGen2
        ) > 0) {
            return Tier.Silver;
        }
        return Tier.Free;
    }

    /// @dev Safe LDR length lookup. Returns 0 on any revert — preserves
    ///      the LST production behavior of "don't brick trades when LDR
    ///      misbehaves." Cited in CLAUDE.md as a load-bearing pattern.
    function _safeDelegatedLength(
        address ldr,
        address user,
        address token
    ) private view returns (uint256) {
        try ILazyDelegateRegistry(ldr).getSerialsDelegatedTo(user, token)
            returns (uint256[] memory serials)
        {
            return serials.length;
        } catch {
            return 0;
        }
    }

    /// @dev Returns the higher of two tiers. Solidity enum comparisons
    ///      are integer comparisons under the hood.
    function _maxTier(Tier a, Tier b) private pure returns (Tier) {
        return a >= b ? a : b;
    }
}
