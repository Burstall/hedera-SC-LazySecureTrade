// SPDX-License-Identifier: GPL-3.0
pragma solidity >=0.8.12 <0.9.0;

/**
 * @title LSHRebateMultipliers
 * @notice Pure-view reference contract that returns the rebate weight
 *         for a given LSH NFT (token + serial). Used by frontends + the
 *         off-chain rebate computation script to ensure both sides
 *         agree on the per-token multiplier.
 *
 * @dev    The actual rebate allocation lives in the Merkle root
 *         published to `LazyRebatePool`; this contract is informational
 *         only. Off-chain scripts hard-code the same weights to compute
 *         allocations, then the frontend can show users their stake's
 *         weight via this on-chain reference.
 *
 *         Weights are scaled by 10 to keep integer math:
 *           Gen 1   = 50  (5.0 units per token)
 *           Mutant  = 25  (2.5 units per token)
 *           LSV     = 25  (2.5 units per token; Gen 2 serials 5001-5100)
 *           Gen 2   = 10  (1.0 unit per token; all other Gen 2 serials)
 *
 *         Max units assuming every eligible NFT is staked:
 *           Gen 1:    100 × 50  = 5,000
 *           Mutant:   100 × 25  = 2,500
 *           LSV:      100 × 25  = 2,500
 *           Gen 2:   5000 × 10  = 50,000
 *           ────────────────────────────
 *           Total scaled units  = 60,000
 *
 *         Note: Gen 2 has 5100 serials total (5000 base + 100 LSV);
 *         LSV tokens count at the higher weight, Gen 2 base tokens at
 *         the lower weight. Burn/mint cycles on Gen 2 don't affect this
 *         — the LSV range is fixed at serials 5001-5100.
 */
contract LSHRebateMultipliers {

    // ============================================
    // Immutables
    // ============================================

    address public immutable LSH_GEN1;
    address public immutable LSH_MUTANT;
    address public immutable LSH_GEN2;

    // ============================================
    // Constants
    // ============================================

    /// @notice Inclusive serial range that qualifies as LSV (subset of
    ///         LSH_GEN2). Fixed at deploy via the contract; minting
    ///         cycles on the underlying token don't change this range.
    uint256 public constant LSV_MIN_SERIAL = 5001;
    uint256 public constant LSV_MAX_SERIAL = 5100;

    /// @notice Per-token weights, scaled by `WEIGHT_SCALE`.
    uint256 public constant WEIGHT_GEN1   = 50;   // 5.0 units
    uint256 public constant WEIGHT_MUTANT = 25;   // 2.5 units
    uint256 public constant WEIGHT_LSV    = 25;   // 2.5 units
    uint256 public constant WEIGHT_GEN2   = 10;   // 1.0 unit
    uint256 public constant WEIGHT_SCALE  = 10;   // raw weight × scale

    /// @notice Maximum total scaled units across all eligible NFTs
    ///         (assumes every eligible NFT is staked). Used by frontends
    ///         to compute the per-unit minimum rebate as
    ///         `poolBalance / MAX_UNITS_SCALED`.
    uint256 public constant MAX_UNITS_SCALED = 60_000;

    // ============================================
    // Constructor
    // ============================================

    constructor(address _lshGen1, address _lshMutant, address _lshGen2) {
        LSH_GEN1 = _lshGen1;
        LSH_MUTANT = _lshMutant;
        LSH_GEN2 = _lshGen2;
    }

    // ============================================
    // Views
    // ============================================

    /**
     * @notice Returns the scaled weight for a single (token, serial)
     *         pair. Returns 0 if the token is not an LSH collection.
     */
    function getMultiplier(address token, uint256 serial)
        public
        view
        returns (uint256)
    {
        if (token == LSH_GEN1) return WEIGHT_GEN1;
        if (token == LSH_MUTANT) return WEIGHT_MUTANT;
        if (token == LSH_GEN2) {
            if (serial >= LSV_MIN_SERIAL && serial <= LSV_MAX_SERIAL) {
                return WEIGHT_LSV;
            }
            return WEIGHT_GEN2;
        }
        return 0;
    }

    /**
     * @notice Batched multiplier query. For each `tokens[i]`, returns
     *         an array of weights corresponding to `serials[i]`.
     *
     * @param tokens Array of token addresses.
     * @param serials Array of serial arrays (one per token).
     * @return weights Same shape as `serials`; weights[i][j] is the
     *                 scaled weight for token i, serial j.
     */
    function getMultipliers(
        address[] calldata tokens,
        uint256[][] calldata serials
    ) external view returns (uint256[][] memory weights) {
        require(tokens.length == serials.length, "length mismatch");
        weights = new uint256[][](tokens.length);
        for (uint256 i; i < tokens.length; ) {
            uint256[] memory row = new uint256[](serials[i].length);
            for (uint256 j; j < serials[i].length; ) {
                row[j] = getMultiplier(tokens[i], serials[i][j]);
                unchecked { ++j; }
            }
            weights[i] = row;
            unchecked { ++i; }
        }
    }

    /**
     * @notice Convenience: total scaled weight across a stash of LSH
     *         NFTs. Returns the sum of `getMultiplier(token, serial)`
     *         over all (token, serial) inputs.
     */
    function totalWeightFor(
        address[] calldata tokens,
        uint256[][] calldata serials
    ) external view returns (uint256 total) {
        require(tokens.length == serials.length, "length mismatch");
        for (uint256 i; i < tokens.length; ) {
            for (uint256 j; j < serials[i].length; ) {
                total += getMultiplier(tokens[i], serials[i][j]);
                unchecked { ++j; }
            }
            unchecked { ++i; }
        }
    }

    /**
     * @notice Returns the minimum per-unit rebate value assuming every
     *         eligible NFT is staked. Actual per-unit value will be
     *         higher because not all eligible NFTs are staked at any
     *         given time.
     *
     *         Frontends should display this as "minimum rebate per
     *         unit" and clearly indicate that actual outcomes depend on
     *         the participating stake set at epoch end.
     */
    function minPerUnitValue(uint256 poolAmount)
        external
        pure
        returns (uint256)
    {
        return poolAmount / MAX_UNITS_SCALED;
    }
}
