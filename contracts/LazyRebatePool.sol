// SPDX-License-Identifier: GPL-3.0
pragma solidity >=0.8.12 <0.9.0;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {HederaTokenService} from "./HederaTokenService.sol";
import {HederaResponseCodes} from "./HederaResponseCodes.sol";

/**
 * @title LazyRebatePool
 * @notice Generic Merkle-airdrop-style claim contract for $LAZY rebates.
 *         Receives LAZY transfers from VIPSubscription on each subscription
 *         purchase, then pays out per signed allocations published quarterly
 *         (or ad hoc) by a dedicated signer key.
 *
 * @dev    The contract is intentionally agnostic about staking, NFT tiers,
 *         and the multiplier table. The off-chain settlement process owns
 *         the audit trail — it reads mirror-node stake history, computes
 *         per-user time-weighted averages, applies the multiplier table,
 *         and publishes a Merkle root via `settleEpoch`. The on-chain
 *         claim path simply verifies the proof and pays out.
 *
 *         Key design decisions:
 *           - One epoch per `settleEpoch` call. The signer publishes a
 *             Merkle root over `keccak256(user, amount)` leaves plus the
 *             totalAllocated for the epoch.
 *           - Claims are one-shot per (epoch, user). Repeat claims revert.
 *           - 1-year claim window (owner-tunable). After expiry, anyone
 *             can call `recycleExpiredEpoch` to mark unclaimed amounts as
 *             "claimed" in the bookkeeping sense, freeing the LAZY for
 *             future epoch allocations.
 *           - Dedicated signer key (separate from owner). Owner can rotate
 *             the signer; signer can ONLY call `settleEpoch`.
 *           - LAZY association is a one-shot post-deploy admin step
 *             (`associateLazy`). The contract must be associated before
 *             LGS can pay it.
 */
contract LazyRebatePool is Ownable, ReentrancyGuard, HederaTokenService {

    // ============================================
    // Immutables
    // ============================================

    /// @notice LAZY token address (HTS fungible).
    address public immutable LAZY_TOKEN;

    // ============================================
    // Storage
    // ============================================

    /// @notice Dedicated signing key authorized to publish epoch Merkle
    ///         roots. Owner-rotatable. Should be a low-trust operational
    ///         key — even if compromised, the worst case is misallocation
    ///         of the existing pool balance (signer cannot mint new LAZY).
    address public signer;

    /// @notice Most-recently-settled epoch number. 1-indexed; 0 means
    ///         "no epoch has settled yet."
    uint256 public currentEpoch;

    /// @notice Claim window after settlement, in seconds. Default 365 days.
    ///         Tunable within [30 days, 1095 days]. After this window
    ///         elapses on a given epoch, anyone can call
    ///         `recycleExpiredEpoch` to release the unclaimed balance
    ///         back into the general pool.
    uint64 public epochClaimWindowSeconds;

    /// @notice Whether LAZY association has been performed. Set true by
    ///         `associateLazy`. The contract cannot receive LAZY until
    ///         this is true.
    bool public lazyAssociated;

    struct Epoch {
        bytes32 merkleRoot;
        uint256 totalAllocated;
        uint256 totalClaimed;
        uint64  settledAt;
    }

    /// @notice Per-epoch allocation state.
    mapping(uint256 epoch => Epoch) public epochs;

    /// @notice Per-(epoch, user) one-shot claim flag.
    mapping(uint256 epoch => mapping(address user => bool)) public claimed;

    // ============================================
    // Events
    // ============================================

    /// @notice Emitted when the signer publishes an epoch's Merkle root.
    event EpochSettled(
        uint256 indexed epoch,
        bytes32 indexed merkleRoot,
        uint256 totalAllocated,
        uint64 settledAt
    );

    /// @notice Emitted on each successful claim.
    event RebateClaimed(
        uint256 indexed epoch,
        address indexed user,
        uint256 amount
    );

    /// @notice Emitted when an expired epoch's unclaimed balance is
    ///         released back to the pool. `recycledAmount` is the
    ///         portion that was allocated but never claimed.
    event EpochRecycled(
        uint256 indexed epoch,
        uint256 recycledAmount
    );

    /// @notice Emitted when the owner rotates the signer.
    event SignerChanged(address indexed oldSigner, address indexed newSigner);

    /// @notice Emitted when the owner tunes the claim window.
    event ClaimWindowChanged(uint64 newWindowSeconds);

    /// @notice Emitted once on successful LAZY association.
    event LazyAssociated(address indexed lazyToken);

    /// @notice Emergency LAZY rescue path — owner can recover LAZY in
    ///         catastrophic-bug scenarios. Mirrors the BidderContract
    ///         rescue pattern.
    event LazyRescued(address indexed to, uint256 amount);

    // ============================================
    // Errors
    // ============================================

    error NotSigner();
    error SignerNotSet();
    error AlreadyAssociated();
    error AssociationFailed(int256 responseCode);
    error EpochNotSettled();
    error EpochAlreadySettled(uint256 epoch);
    error EpochExpired();
    error EpochNotExpired();
    error AlreadyClaimed();
    error InvalidProof();
    error InvalidWindow();
    error ZeroAddress();
    error ZeroAmount();
    error TransferFailed();
    error AllocationExceedsBalance(uint256 allocation, uint256 balance);

    // ============================================
    // Modifiers
    // ============================================

    modifier onlySigner() {
        if (signer == address(0)) revert SignerNotSet();
        if (msg.sender != signer) revert NotSigner();
        _;
    }

    // ============================================
    // Constructor
    // ============================================

    /**
     * @param _lazyToken LAZY HTS token address.
     * @param _signer Initial signer address. Owner can rotate later.
     * @param _claimWindowSeconds Initial claim window (e.g., 365 days).
     */
    constructor(
        address _lazyToken,
        address _signer,
        uint64 _claimWindowSeconds
    ) {
        if (_lazyToken == address(0)) revert ZeroAddress();
        if (_claimWindowSeconds < 30 days || _claimWindowSeconds > 1095 days) {
            revert InvalidWindow();
        }
        LAZY_TOKEN = _lazyToken;
        signer = _signer;
        epochClaimWindowSeconds = _claimWindowSeconds;
    }

    // ============================================
    // Admin
    // ============================================

    /**
     * @notice One-shot LAZY association. Must be called by owner before
     *         the contract can receive LAZY transfers (HTS requirement).
     * @dev    Hedera contracts must associate with HTS tokens before
     *         they can hold them. This is a 1-call admin step that
     *         happens post-deploy and is irrevocable. Costs ~1M gas.
     */
    function associateLazy() external onlyOwner {
        if (lazyAssociated) revert AlreadyAssociated();
        int256 rc = HederaTokenService.associateToken(address(this), LAZY_TOKEN);
        if (rc != HederaResponseCodes.SUCCESS) revert AssociationFailed(rc);
        lazyAssociated = true;
        emit LazyAssociated(LAZY_TOKEN);
    }

    /**
     * @notice Rotate the signer key. Owner-only.
     * @dev    Pass `address(0)` to disable settlement (e.g., during a
     *         security incident). No epochs can be settled until a new
     *         signer is set.
     */
    function setSigner(address newSigner) external onlyOwner {
        address oldSigner = signer;
        signer = newSigner;
        emit SignerChanged(oldSigner, newSigner);
    }

    /**
     * @notice Tune the claim window. Owner-only. Bounded.
     */
    function setEpochClaimWindowSeconds(uint64 secs) external onlyOwner {
        if (secs < 30 days || secs > 1095 days) revert InvalidWindow();
        epochClaimWindowSeconds = secs;
        emit ClaimWindowChanged(secs);
    }

    /**
     * @notice Emergency LAZY rescue. Owner-only escape hatch in case
     *         of catastrophic bug or stuck funds. Mirrors the rescue
     *         pattern in BidderContract. Does NOT touch epoch
     *         bookkeeping — owner must manage downstream consequences.
     */
    function rescueLazy(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (!IERC20(LAZY_TOKEN).transfer(to, amount)) revert TransferFailed();
        emit LazyRescued(to, amount);
    }

    // ============================================
    // Settlement (signer-only)
    // ============================================

    /**
     * @notice Publish the Merkle root for the next epoch.
     * @dev    Signer-only. Increments `currentEpoch`. The Merkle tree
     *         leaves are `keccak256(abi.encodePacked(user, amount))`.
     *         `totalAllocated` should equal the sum of all leaf amounts;
     *         the contract verifies it's covered by the current pool
     *         balance (preventing the signer from allocating more than
     *         what exists).
     *
     *         This is the on-chain commitment; the off-chain compute
     *         that produced it (mirror node stake-history reconstruction,
     *         time-weighted averaging, multiplier application) is the
     *         audit trail and lives in `scripts/ops/computeRebateEpoch.js`.
     *
     * @param merkleRoot Root of the Merkle tree for this epoch.
     * @param totalAllocated Sum of all per-user allocations in this epoch.
     */
    function settleEpoch(bytes32 merkleRoot, uint256 totalAllocated)
        external
        onlySigner
        nonReentrant
    {
        uint256 balance = IERC20(LAZY_TOKEN).balanceOf(address(this));
        if (totalAllocated > balance) {
            revert AllocationExceedsBalance(totalAllocated, balance);
        }

        uint256 nextEpoch = currentEpoch + 1;
        epochs[nextEpoch] = Epoch({
            merkleRoot: merkleRoot,
            totalAllocated: totalAllocated,
            totalClaimed: 0,
            settledAt: uint64(block.timestamp)
        });
        currentEpoch = nextEpoch;

        emit EpochSettled(nextEpoch, merkleRoot, totalAllocated, uint64(block.timestamp));
    }

    // ============================================
    // Claims
    // ============================================

    /**
     * @notice Claim the caller's allocation for a given epoch.
     * @dev    One-shot per (epoch, user). Verifies the Merkle proof
     *         against the published root. Pays out `amount` of LAZY
     *         immediately.
     *
     * @param epoch The epoch number to claim from.
     * @param amount The caller's allocation in LAZY base units.
     * @param proof Merkle proof for the leaf `keccak256(msg.sender, amount)`.
     */
    function claim(
        uint256 epoch,
        uint256 amount,
        bytes32[] calldata proof
    ) external nonReentrant {
        Epoch storage e = epochs[epoch];
        if (e.merkleRoot == bytes32(0)) revert EpochNotSettled();
        if (block.timestamp > e.settledAt + epochClaimWindowSeconds) {
            revert EpochExpired();
        }
        if (claimed[epoch][msg.sender]) revert AlreadyClaimed();

        bytes32 leaf = keccak256(abi.encodePacked(msg.sender, amount));
        if (!MerkleProof.verify(proof, e.merkleRoot, leaf)) revert InvalidProof();

        claimed[epoch][msg.sender] = true;
        e.totalClaimed += amount;

        if (!IERC20(LAZY_TOKEN).transfer(msg.sender, amount)) revert TransferFailed();
        emit RebateClaimed(epoch, msg.sender, amount);
    }

    /**
     * @notice Release the unclaimed portion of an expired epoch back
     *         to the general pool.
     * @dev    Permissionless after epoch expiry. The "release" is just
     *         bookkeeping — the LAZY is already on this contract; we
     *         mark the epoch as fully reconciled so future settlements
     *         can allocate against the freed balance.
     */
    function recycleExpiredEpoch(uint256 epoch) external nonReentrant {
        Epoch storage e = epochs[epoch];
        if (e.merkleRoot == bytes32(0)) revert EpochNotSettled();
        if (block.timestamp <= e.settledAt + epochClaimWindowSeconds) {
            revert EpochNotExpired();
        }
        uint256 unclaimed = e.totalAllocated - e.totalClaimed;
        if (unclaimed == 0) return;
        e.totalAllocated = e.totalClaimed; // zero-out the unclaimed portion
        emit EpochRecycled(epoch, unclaimed);
    }

    // ============================================
    // Views
    // ============================================

    /// @notice Returns the contract's current LAZY balance. This is the
    ///         "pool size" callers should display.
    function poolBalance() external view returns (uint256) {
        return IERC20(LAZY_TOKEN).balanceOf(address(this));
    }

    /// @notice Returns the unclaimed allocation for a given epoch.
    function unclaimedInEpoch(uint256 epoch) external view returns (uint256) {
        Epoch storage e = epochs[epoch];
        return e.totalAllocated - e.totalClaimed;
    }

    /// @notice True if `epoch` is past its claim window.
    function isEpochExpired(uint256 epoch) external view returns (bool) {
        Epoch storage e = epochs[epoch];
        if (e.merkleRoot == bytes32(0)) return false;
        return block.timestamp > e.settledAt + epochClaimWindowSeconds;
    }

    /// @notice True if the user has claimed for a given epoch.
    function hasClaimed(uint256 epoch, address user) external view returns (bool) {
        return claimed[epoch][user];
    }

    /// @notice Convenience: verify a proof without consuming it.
    ///         Useful for off-chain verification scripts and UI.
    function verifyProof(
        uint256 epoch,
        address user,
        uint256 amount,
        bytes32[] calldata proof
    ) external view returns (bool) {
        Epoch storage e = epochs[epoch];
        if (e.merkleRoot == bytes32(0)) return false;
        bytes32 leaf = keccak256(abi.encodePacked(user, amount));
        return MerkleProof.verify(proof, e.merkleRoot, leaf);
    }

    // ============================================
    // Receive hook
    // ============================================

    /// @notice Required to accept HBAR (e.g., for accidental sends).
    ///         Owner can sweep via `rescueLazy` analogue if needed —
    ///         not implemented here for HBAR. Stranger HBAR sends are
    ///         accepted but cannot be retrieved beyond an owner-side
    ///         escape function (not present). Acceptable trade-off
    ///         vs the complexity of restricting `receive`.
    receive() external payable {}
}
