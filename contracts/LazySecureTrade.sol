// SPDX-License-Identifier: ISC
pragma solidity >=0.8.12 <0.9.0;

/// @title LazySecureTrade
/// @author stowerling.eth / stowerling.hbar
/// @notice This contract is a decentralized secure trade contract for HTS NFTs without time limits

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

import {TokenStaker} from "./TokenStaker.sol";

contract LazySecureTrade is Ownable, ReentrancyGuard, TokenStaker {
    using EnumerableSet for EnumerableSet.AddressSet;
    using EnumerableSet for EnumerableSet.Bytes32Set;
    using SafeCast for uint256;
    using Address for address;

    struct Trade {
        address seller;
        address buyer;
        address token;
        uint256 serial;
        uint256 tinybarPrice;
        uint256 lazyPrice;
        uint256 expiryTime;
        uint256 nonce;
    }

    struct BatchTrade {
        address seller;
        address buyer; // address(0) = open market, specific address = closed trade
        TokenSerialPrice[] items;
        uint256 totalTinybarPrice;
        uint256 totalLazyPrice;
        uint256 expiryTime;
        uint256 nonce; // Uses existing tradeNonce counter
    }

    struct TokenSerialPrice {
        address token;
        uint256 serial;
        uint256 tinybarPrice;
        uint256 lazyPrice;
    }

    event TradeCreated(
        address indexed seller,
        address indexed buyer,
        address indexed token,
        uint256 serial,
        uint256 tinybarPrice,
        uint256 lazyPrice,
        uint256 expiryTime,
        uint256 nonce
    );

    event TradeCancelled(
        address indexed seller,
        address indexed token,
        uint256 serial,
        uint256 nonce
    );

    event TradeCompleted(
        address indexed seller,
        address indexed buyer,
        address indexed token,
        uint256 serial,
        uint256 nonce
    );

    // v0.2 Batch Trade Events
    event BatchTradeCreated(
        bytes32 indexed batchId,
        address indexed seller,
        address indexed buyer,
        uint256 itemCount,
        uint256 totalTinybarPrice,
        uint256 totalLazyPrice
    );

    event BatchTradeExecuted(
        bytes32 indexed batchId,
        address indexed buyer,
        uint256 itemCount,
        uint256 totalTinybarPrice,
        uint256 totalLazyPrice
    );

    event BatchTradeCancelled(
        bytes32 indexed batchId,
        address indexed canceller,
        uint256 itemCount
    );

    // Token Association Events
    event TokenAssociated(address indexed token, address indexed account);

    // Platform Fee Events
    event PlatformFeeCollected(
        address indexed seller,
        address indexed buyer,
        uint256 hbarFee,
        uint256 effectiveFeeRate
    );

    event FeeRatesUpdated(
        uint256 baseFeeRate,
        uint256 lshGen2Discount,
        uint256 lshMutantDiscount,
        uint256 lshGen1Discount
    );

    event FeesWithdrawn(address indexed recipient, uint256 hbarAmount);

    event SecureTradeStatus(string message, address sender, uint256 value);

    error TradeNotFoundOrInvalid();
    error TradeExpired();
    error UserDoesNotOwnNFT();
    error InsufficientPayment(); // Consolidated: InsufficientFunds, InsufficientHBAR, InsufficientLAZY, InsufficientAllowanceLAZY
    error UserNotAuthorized(); // Consolidated: UserNotSeller, UserNotBuyer
    error UserMustApproveNFTFirst();
    error SellerCannotBeBuyer();
    error ExpiryTimeInPast();

    // Platform Fee Errors
    error InvalidFeeRate(uint256 rate);
    error InsufficientFeesToWithdraw();

    // v0.2 Batch Trade Errors
    error BatchTradeNotFound(bytes32 batchId);
    error BatchSizeExceedsLimit(uint256 provided, uint256 maximum);

    // General Batch Errors
    error InvalidBatchParameters(); // Consolidated: ArrayLengthMismatch, EmptyBatchNotAllowed
    error InvalidPricing(); // Both tinybar and lazy prices provided for same item

    mapping(address => EnumerableSet.Bytes32Set) private userTradesMap;
    mapping(address => EnumerableSet.Bytes32Set) private tokenTradesMap;
    mapping(bytes32 => Trade) private allTradesMap;

    // v0.2 Batch Trade Storage
    mapping(bytes32 => BatchTrade) private batchTradesMap;
    mapping(address => EnumerableSet.Bytes32Set) private userBatchTradesMap;
    mapping(bytes32 => bytes32) private itemToBatch; // hash(token,serial) → batchId

    EnumerableSet.AddressSet private tokens;

    address public immutable LSH_GEN1;
    address public immutable LSH_GEN2;
    address public immutable LSH_GEN1_MUTANT;

    // each trade has a unique nonce
    uint256 public tradeNonce;
    uint256 public lazyCostForTrade;
    uint256 public lazyBurnPercentage;

    // Platform fee system (in basis points: 100bp = 1%)
    // Base rate + discount system for efficiency
    uint256 public baseFeeRate = 100; // 1% base rate for non-LSH holders
    uint256 public lshGen2Discount = 50; // 50% discount for LSH Gen2 holders (0.5% effective)
    uint256 public lshMutantDiscount = 75; // 75% discount for LSH Mutant holders (0.25% effective)
    uint256 public lshGen1Discount = 100; // 100% discount for LSH Gen1 holders (0% effective - FREE!)

    // Fee collection tracking (HBAR only - LAZY trades excluded)
    uint256 public totalHbarFeesCollected;

    // Lifetime volume tracking for analytics
    uint256 public lifetimeHbarVolume; // Total HBAR volume processed
    uint256 public lifetimeLazyVolume; // Total LAZY volume processed

    constructor(
        address _lazyToken,
        address _lazyGasStation,
        address _lazyDelegateRegistry,
        address _lshGen1,
        address _lshGen2,
        address _lshGen1Mutant,
        uint256 _lazyCostForTrade,
        uint256 _lazyBurnPercentage
    ) {
        // initialize the TokenStaker contract
        initContracts(_lazyToken, _lazyGasStation, _lazyDelegateRegistry);

        LSH_GEN1 = _lshGen1;
        LSH_GEN2 = _lshGen2;
        LSH_GEN1_MUTANT = _lshGen1Mutant;

        lazyCostForTrade = _lazyCostForTrade;
        lazyBurnPercentage = _lazyBurnPercentage;
    }

    /***
     * @notice Create a trade for an NFT (single NFT)
     * @param _token The address of the NFT
     * @param _buyer The address of the buyer (0x0 for open trade)
     * @param _serial The serial of the NFT
     * @param _tinybarPrice The price in tinybars (0 for free)
     * @param _lazyPrice The price in Lazy tokens (0 for free)
     * @param _expiryTime The expiry time of the trade (0 for no expiry)
     * @return tradeId The ID of the trade as a bytes32 hash of token and serial
     */
    function createTrade(
        address _token,
        address _buyer,
        uint256 _serial,
        uint256 _tinybarPrice,
        uint256 _lazyPrice,
        uint256 _expiryTime
    ) external nonReentrant returns (bytes32 tradeId) {
        // Handle $LAZY charging for open market trades before creation
        if (_buyer == address(0)) {
            // check if the user does not own an LSH Gen 1 or Gen 2
            if (!areAdvancedTradesFree(msg.sender)) {
                // if not then charge the user for the trade
                lazyGasStation.drawLazyFrom(
                    msg.sender,
                    lazyCostForTrade,
                    lazyBurnPercentage
                );
            }
        }

        // Use common validation and creation logic
        bool success;
        (tradeId, success) = _validateAndCreateTrade(
            _token,
            _serial,
            _buyer,
            _tinybarPrice,
            _lazyPrice,
            _expiryTime
        );

        if (!success) {
            // Determine the specific error to revert with
            if (_expiryTime != 0 && _expiryTime < block.timestamp) {
                revert ExpiryTimeInPast();
            }
            if (_buyer == address(0) && _tinybarPrice == 0 && _lazyPrice == 0) {
                revert BadArguments();
            }
            if (IERC721(_token).ownerOf(_serial) != msg.sender) {
                revert UserDoesNotOwnNFT();
            }
            // This should never happen now that we removed the existence check
            revert BadArguments();
        }

        emit TradeCreated(
            msg.sender,
            _buyer,
            _token,
            _serial,
            _tinybarPrice,
            _lazyPrice,
            _expiryTime,
            tradeNonce
        );
    }

    /***
     * @notice Cancel a trade
     * @param _tradeId The ID of the trade (hash of token and serial)
     */
    function cancelTrade(bytes32 _tradeId) public {
        Trade memory trade = allTradesMap[_tradeId];

        // user should be able to cancel trade as long
        // as they are the seller or buyer
        // does not matter if they own the NFT or not
        if (trade.seller != msg.sender && trade.buyer != msg.sender) {
            revert TradeNotFoundOrInvalid();
        }

        removeTradeFromState(_tradeId, trade.buyer, trade.seller, trade.token);

        emit TradeCancelled(msg.sender, trade.token, trade.serial, trade.nonce);
    }

    /***
     * @notice Cancel multiple trades in one call as a convenience
     * @param _tradeIdList The list of trade IDs to cancel
     */
    function cancelTrades(bytes32[] memory _tradeIdList) external {
        uint256 length = _tradeIdList.length;

        for (uint256 i = 0; i < length; ) {
            cancelTrade(_tradeIdList[i]);

            unchecked {
                ++i;
            }
        }
    }

    /***
     * @notice Execute a trade
     * @param _tradeId The ID of the trade (hash of token and serial)
     */
    function executeTrade(bytes32 _tradeId) external payable nonReentrant {
        // Execute the trade with funds checking enabled and get HBAR used
        uint256 hbarUsed = _executeTrade(_tradeId, true);

        // Refund any excess HBAR
        if (msg.value > hbarUsed) {
            Address.sendValue(payable(msg.sender), msg.value - hbarUsed);
        }
    }

    /***
     * @notice Pull trade details from the contract
     * @param _tradeId the hash of the token and serial
     */
    function getTrade(bytes32 _tradeId) external view returns (Trade memory) {
        return allTradesMap[_tradeId];
    }

    /***
     * @notice Pull multiple trade details from the contract - convenience method
     * @param _tradeIdList the list of trade IDs to pull
     */
    function getTrades(
        bytes32[] memory _tradeIdList
    ) external view returns (Trade[] memory) {
        uint256 length = _tradeIdList.length;
        Trade[] memory trades = new Trade[](length);

        for (uint256 i = 0; i < length; ) {
            trades[i] = allTradesMap[_tradeIdList[i]];

            unchecked {
                ++i;
            }
        }

        return trades;
    }

    /***
     * @notice Pull all trades for a user
     * @param _user the address of the user
     */
    function getUserTrades(
        address _user
    ) external view returns (bytes32[] memory) {
        uint256 length = userTradesMap[_user].length();
        bytes32[] memory trades = new bytes32[](length);

        for (uint256 i = 0; i < length; ) {
            trades[i] = userTradesMap[_user].at(i);

            unchecked {
                ++i;
            }
        }

        return trades;
    }

    /***
     * @notice Pull all trades for a token
     * @param _token the address of the token
     */
    function getTokenTrades(
        address _token
    ) external view returns (bytes32[] memory) {
        uint256 length = tokenTradesMap[_token].length();
        bytes32[] memory trades = new bytes32[](length);

        for (uint256 i = 0; i < length; ) {
            trades[i] = tokenTradesMap[_token].at(i);

            unchecked {
                ++i;
            }
        }

        return trades;
    }

    /***
     * @notice Pull batch trade details from the contract
     * @param _batchId the batch trade ID
     */
    function getBatchTrade(
        bytes32 _batchId
    ) external view returns (BatchTrade memory) {
        return batchTradesMap[_batchId];
    }

    /***
     * @notice Pull multiple batch trade details from the contract - convenience method
     * @param _batchIdList the list of batch trade IDs to pull
     */
    function getBatchTrades(
        bytes32[] memory _batchIdList
    ) external view returns (BatchTrade[] memory) {
        uint256 length = _batchIdList.length;
        BatchTrade[] memory batches = new BatchTrade[](length);

        for (uint256 i = 0; i < length; ) {
            batches[i] = batchTradesMap[_batchIdList[i]];

            unchecked {
                ++i;
            }
        }

        return batches;
    }

    /***
     * @notice Pull all batch trades for a user
     * @param _user the address of the user
     */
    function getUserBatchTrades(
        address _user
    ) external view returns (bytes32[] memory) {
        uint256 length = userBatchTradesMap[_user].length();
        bytes32[] memory batches = new bytes32[](length);

        for (uint256 i = 0; i < length; ) {
            batches[i] = userBatchTradesMap[_user].at(i);

            unchecked {
                ++i;
            }
        }

        return batches;
    }

    /***
     * @notice Cancel a batch trade (only by seller)
     * @param _batchId the batch trade ID to cancel
     */
    function cancelBatchTrade(bytes32 _batchId) external nonReentrant {
        BatchTrade storage batchTrade = batchTradesMap[_batchId];

        if (batchTrade.seller == address(0)) {
            revert BatchTradeNotFound(_batchId);
        }

        if (batchTrade.seller != msg.sender) {
            revert UserNotAuthorized();
        }

        // Clean up storage
        _cleanupBatchTrade(_batchId, batchTrade);

        emit BatchTradeCancelled(_batchId, msg.sender, batchTrade.items.length);
    }

    /***
     * @notice Create multiple individual trades (non-atomic) in a single transaction
     * @dev More efficient than calling createTrade multiple times, but trades are independent
     * @param _uniqueTokens Array of unique token addresses (no duplicates)
     * @param _serialsPerToken Array of serial arrays - each index corresponds to token at same index
     * @param _buyer The buyer address (same for all trades, 0x0 for open market)
     * @param _tinybarPricesPerToken Array of tinybar price arrays - flattened per token
     * @param _lazyPricesPerToken Array of lazy price arrays - flattened per token
     * @param _expiryTime Expiry time (same for all trades, 0 for no expiry)
     * @return tradeIds Array of created trade IDs
     */
    function createMultipleTrades(
        address[] memory _uniqueTokens,
        uint256[][] memory _serialsPerToken,
        address _buyer,
        uint256[][] memory _tinybarPricesPerToken,
        uint256[][] memory _lazyPricesPerToken,
        uint256 _expiryTime
    ) external nonReentrant returns (bytes32[] memory tradeIds) {
        if (_expiryTime != 0 && _expiryTime < block.timestamp) {
            revert ExpiryTimeInPast();
        }

        uint256 tokenCount = _uniqueTokens.length;
        if (tokenCount == 0) {
            revert InvalidBatchParameters();
        }

        // Validate array lengths match
        if (
            tokenCount != _serialsPerToken.length ||
            tokenCount != _tinybarPricesPerToken.length ||
            tokenCount != _lazyPricesPerToken.length
        ) {
            revert InvalidBatchParameters();
        }

        // Calculate total trades and validate limits
        uint256 totalTrades = 0;
        for (uint256 i = 0; i < tokenCount; ) {
            uint256 serialsCount = _serialsPerToken[i].length;
            if (
                serialsCount != _tinybarPricesPerToken[i].length ||
                serialsCount != _lazyPricesPerToken[i].length
            ) {
                revert InvalidBatchParameters();
            }
            totalTrades += serialsCount;
            unchecked {
                ++i;
            }
        }

        // Reasonable limit to prevent gas issues (reduced for Hedera subcall limits)
        if (totalTrades > 32) {
            revert BatchSizeExceedsLimit(totalTrades, 32);
        }

        tradeIds = new bytes32[](totalTrades);
        uint256 totalLazyCost = 0;
        uint256 successfulTrades = 0;
        uint256 tradeIndex = 0;

        // Create individual trades per token
        for (uint256 tokenIdx = 0; tokenIdx < tokenCount; ) {
            address token = _uniqueTokens[tokenIdx];
            uint256[] memory serials = _serialsPerToken[tokenIdx];
            uint256[] memory tinybarPrices = _tinybarPricesPerToken[tokenIdx];
            uint256[] memory lazyPrices = _lazyPricesPerToken[tokenIdx];

            for (uint256 serialIdx = 0; serialIdx < serials.length; ) {
                uint256 serial = serials[serialIdx];
                uint256 tinybarPrice = tinybarPrices[serialIdx];
                uint256 lazyPrice = lazyPrices[serialIdx];

                // Use common validation and creation logic
                (bytes32 tradeId, bool success) = _validateAndCreateTrade(
                    token,
                    serial,
                    _buyer,
                    tinybarPrice,
                    lazyPrice,
                    _expiryTime
                );

                if (success) {
                    tradeIds[tradeIndex] = tradeId;
                    successfulTrades++;
                    tradeIndex++;

                    // Count cost for open market trades
                    if (_buyer == address(0)) {
                        totalLazyCost += lazyCostForTrade;
                    }
                }

                unchecked {
                    ++serialIdx;
                }
            }

            unchecked {
                ++tokenIdx;
            }
        }

        // Associate tokens that need association
        associateTokensIfNeeded(_uniqueTokens);

        // Charge total $LAZY cost for open market trades
        if (totalLazyCost > 0 && !areAdvancedTradesFree(msg.sender)) {
            lazyGasStation.drawLazyFrom(
                msg.sender,
                totalLazyCost,
                lazyBurnPercentage
            );
        }

        // Individual TokenAssociated events already emitted in associateTokensIfNeeded
    }

    /***
     * @notice Execute multiple individual trades atomically
     * @dev All trades execute or entire transaction reverts - no partial execution
     * @param _tradeIds Array of trade IDs to execute
     */
    function executeTrades(
        bytes32[] memory _tradeIds
    ) external payable nonReentrant {
        uint256 length = _tradeIds.length;
        if (length == 0) {
            revert InvalidBatchParameters();
        }

        // Conservative limit for Hedera subcall management (2 NFT moves per trade + LAZY payments)
        if (length > 20) {
            revert BatchSizeExceedsLimit(length, 20);
        }

        // Execute all trades and accumulate actual HBAR usage - any failure reverts entire transaction
        // Funds checking is disabled for batch execution - if we run out of funds, we run out of funds
        uint256 totalHbarUsed = 0;
        for (uint256 i = 0; i < length; ) {
            totalHbarUsed += _executeTrade(_tradeIds[i], false);
            unchecked {
                ++i;
            }
        }

        // Refund excess HBAR based on actual usage
        if (msg.value > totalHbarUsed) {
            Address.sendValue(payable(msg.sender), msg.value - totalHbarUsed);
        }
    }

    /***
     * @notice Process HBAR payment with platform fees
     * @param seller The seller address
     * @param buyer The buyer address
     * @param tinybarPrice The price in tinybars
     * @return hbarFee The fee collected
     */
    function _processHbarPayment(
        address seller,
        address buyer,
        uint256 tinybarPrice
    ) internal returns (uint256 hbarFee) {
        if (tinybarPrice > 0) {
            // Track lifetime HBAR volume
            lifetimeHbarVolume += tinybarPrice;

            // Calculate platform fee for HBAR trades only
            uint256 sellerFeeRate = calculateSellerFeeRate(seller);
            if (sellerFeeRate > 0) {
                hbarFee = (tinybarPrice * sellerFeeRate) / 10000;
                uint256 sellerAmount = tinybarPrice - hbarFee;

                // Send net amount to seller
                Address.sendValue(payable(seller), sellerAmount);

                // Track collected fees (fees stay in contract)
                totalHbarFeesCollected += hbarFee;

                // Emit platform fee collection event
                emit PlatformFeeCollected(
                    seller,
                    buyer,
                    hbarFee,
                    sellerFeeRate
                );
            } else {
                // No fees - send full amount to seller
                Address.sendValue(payable(seller), tinybarPrice);
            }
        }
    }

    /***
     * @notice Process LAZY payment via gas station (no fees)
     * @param seller The seller address
     * @param buyer The buyer address
     * @param lazyPrice The price in LAZY tokens
     */
    function _processLazyPayment(
        address seller,
        address buyer,
        uint256 lazyPrice
    ) internal {
        if (lazyPrice > 0) {
            // Track lifetime LAZY volume
            lifetimeLazyVolume += lazyPrice;

            // Use LazyGasStation for LAZY payment - full amount to seller (no platform fees)
            lazyGasStation.drawLazyFromPayTo(buyer, lazyPrice, 0, seller);
        }
    }

    /***
     * @notice Execute 2-step NFT transfer for Hedera royalty compliance
     * @param token The token address
     * @param serial The NFT serial number
     * @param seller The seller address
     * @param buyer The buyer address
     * @param salePrice The sale price for royalty calculations
     */
    function _execute2StepNFTTransfer(
        address token,
        uint256 serial,
        address seller,
        address buyer,
        uint256 salePrice
    ) internal {
        uint256[] memory serialArray = new uint256[](1);
        serialArray[0] = serial;

        // Step 1: Seller → Smart Contract (triggers royalty calculations)
        batchMoveNFTs(
            TransferDirection.STAKING,
            token,
            serialArray,
            seller,
            false,
            int64(Math.max(salePrice, 1).toUint64())
        );

        // Step 2: Smart Contract → Buyer (completes the trade)
        batchMoveNFTs(
            TransferDirection.WITHDRAWAL,
            token,
            serialArray,
            buyer,
            false,
            1
        );
    }
    /***
     * @notice Internal function to execute a single trade
     * @param _tradeId The trade ID to execute
     * @param _checkFunds Whether to check insufficient funds (false for batch execution)
     * @return hbarUsed The amount of HBAR used for this trade
     */
    function _executeTrade(
        bytes32 _tradeId,
        bool _checkFunds
    ) internal returns (uint256 hbarUsed) {
        Trade storage trade = allTradesMap[_tradeId];

        // Validate trade exists and is valid for msg.sender
        if (!isTradeValid(_tradeId, msg.sender)) {
            revert TradeNotFoundOrInvalid();
        }

        // Ensure msg.sender is not the seller
        if (msg.sender == trade.seller) {
            revert SellerCannotBeBuyer();
        }

        // Check sufficient HBAR sent for this trade (only if requested)
        if (
            _checkFunds &&
            trade.tinybarPrice > 0 &&
            msg.value < trade.tinybarPrice
        ) {
            revert InsufficientPayment();
        }

        // Handle $LAZY payment first (if needed)
        // if there is a price in $LAZY, then draw the funds from the buyer
        // and send them to the seller. N.B. the LazyGasStation will handle the movement
        // of the funds. This will not obey royalties yet.
        // to handle royalties we would need to ensure royalty collectors have $LAZY associated
        // or use try/catch to handle the failure of the transfer and revert to this work around
        if (trade.lazyPrice > 0) {
            lazyGasStation.drawLazyFromPayTo(
                msg.sender,
                trade.lazyPrice,
                0,
                trade.seller
            );
        }

        // Execute 2-step NFT transfer for Hedera royalty compliance
        _execute2StepNFTTransfer(
            trade.token,
            trade.serial,
            trade.seller,
            msg.sender,
            trade.tinybarPrice
        );

        // Handle payments using shared helper functions
        hbarUsed = trade.tinybarPrice;
        _processHbarPayment(trade.seller, msg.sender, trade.tinybarPrice);
        _processLazyPayment(trade.seller, msg.sender, trade.lazyPrice);

        // Clean up storage using existing helper method
        removeTradeFromState(_tradeId, trade.buyer, trade.seller, trade.token);

        // Emit individual trade executed event
        emit TradeCompleted(
            trade.seller,
            msg.sender,
            trade.token,
            trade.serial,
            trade.nonce
        );

        return hbarUsed;
    }

    /***
     * @notice Check is a trade is valid for a user
     * If the user is 0x0, then only expiry, ownership and allowance are checked
     * If the user is not 0x0, then the user must be the seller or buyer (unless the trade is open as
     * in the case of a buyer being 0x0)
     * @param _tradeId the hash of the token and serial
     * @param _user the address of the user
     * @return valid true if the trade is valid, false otherwise
     */
    function isTradeValid(
        bytes32 _tradeId,
        address _user
    ) public view returns (bool) {
        Trade memory trade = allTradesMap[_tradeId];

        // if trade does not exist, then it is invalid
        if (trade.seller == address(0)) {
            return false;
        }

        if (trade.expiryTime != 0 && block.timestamp > trade.expiryTime) {
            return false;
        }

        // validity on time / ownership / approval is generic
        // hence allow a bypass for this condition

        if (
            _user != address(0) &&
            trade.seller != _user &&
            trade.buyer != address(0) &&
            trade.buyer != _user
        ) {
            return false;
        }

        // now on to paid methods (will 'cost' 3 sub transactions, remember the limit is 50 total)
        // so we can only accept 16 validations per call

        // Use consolidated NFT validation
        return
            _validateNFTOwnershipAndApproval(
                trade.token,
                trade.serial,
                trade.seller
            );
    }

    /***
     * @notice Get current platform fee information
     * @return baseFee Base fee rate in basis points
     * @return gen2Discount LSH Gen2 holder discount percentage
     * @return mutantDiscount LSH Mutant holder discount percentage
     * @return gen1Discount LSH Gen1 holder discount percentage
     * @return hbarCollected Total HBAR fees collected
     * @return hbarVolume Lifetime HBAR volume processed
     * @return lazyVolume Lifetime LAZY volume processed
     */
    function getPlatformFeeInfo()
        external
        view
        returns (
            uint256 baseFee,
            uint256 gen2Discount,
            uint256 mutantDiscount,
            uint256 gen1Discount,
            uint256 hbarCollected,
            uint256 hbarVolume,
            uint256 lazyVolume
        )
    {
        return (
            baseFeeRate,
            lshGen2Discount,
            lshMutantDiscount,
            lshGen1Discount,
            totalHbarFeesCollected,
            lifetimeHbarVolume,
            lifetimeLazyVolume
        );
    }

    /***
     * @notice Get LSH token tier for a user (consolidated logic)
     * @param _user The address to check
     * @return tier 0=none, 1=Gen2, 2=Mutant, 3=Gen1 (highest)
     */
    function getLSHTokenTier(address _user) public view returns (uint256 tier) {
        // Check Gen1 first (highest tier) - includes delegated tokens
        if (
            IERC721(LSH_GEN1).balanceOf(_user) > 0 ||
            lazyDelegateRegistry.getSerialsDelegatedTo(_user, LSH_GEN1).length >
            0
        ) {
            return 3; // Gen1 tier
        }

        // Check Mutant (second tier) - includes delegated tokens
        if (
            IERC721(LSH_GEN1_MUTANT).balanceOf(_user) > 0 ||
            lazyDelegateRegistry
                .getSerialsDelegatedTo(_user, LSH_GEN1_MUTANT)
                .length >
            0
        ) {
            return 2; // Mutant tier
        }

        // Check Gen2 (third tier) - includes delegated tokens
        if (
            IERC721(LSH_GEN2).balanceOf(_user) > 0 ||
            lazyDelegateRegistry.getSerialsDelegatedTo(_user, LSH_GEN2).length >
            0
        ) {
            return 1; // Gen2 tier
        }

        return 0; // No LSH tokens
    }

    /***
     * @notice Calculate the platform fee rate for a seller based on their LSH token ownership
     * @param _seller The address of the seller to check
     * @return feeRate The effective fee rate in basis points (100bp = 1%)
     */
    function calculateSellerFeeRate(
        address _seller
    ) public view returns (uint256 feeRate) {
        // Early exit if base rate is 0 - no fees apply
        if (baseFeeRate == 0) {
            return 0;
        }

        uint256 tier = getLSHTokenTier(_seller);

        if (tier == 3) {
            // Gen1 - 100% discount = FREE trades (0% fee)
            // Handle 100% discount case explicitly to avoid any potential edge cases
            if (lshGen1Discount >= 100) {
                return 0;
            }
            return baseFeeRate - (baseFeeRate * lshGen1Discount) / 100;
        } else if (tier == 2) {
            // Mutant - apply Mutant discount (75% = 0.25% effective fee)
            if (lshMutantDiscount >= 100) {
                return 0;
            }
            return baseFeeRate - (baseFeeRate * lshMutantDiscount) / 100;
        } else if (tier == 1) {
            // Gen2 - apply Gen2 discount (50% = 0.5% effective fee)
            if (lshGen2Discount >= 100) {
                return 0;
            }
            return baseFeeRate - (baseFeeRate * lshGen2Discount) / 100;
        }

        // No LSH tokens - full base rate (1%)
        return baseFeeRate;
    }

    /***
     * @notice Check if a user has advanced trades free
     * Owning an LSH Gen 1 / Gen 2 token (or having someone delegate to you) will allow you to create
     * advanced (open to anyone) trades for free else you pay $LAZY per create
     * @param _user the address of the user
     */
    function areAdvancedTradesFree(address _user) public view returns (bool) {
        // Use consolidated LSH tier checking - any tier above 0 gets free trades
        return getLSHTokenTier(_user) > 0;
    }

    /***
     * @notice Helper to check if association in place for a token before creation
     * this allows efficient gas managment
     * @param _token the address of the token
     */
    function isTokenAssociated(address _token) external view returns (bool) {
        return tokens.contains(_token);
    }

    /***
     * @notice Associate tokens that need association and track them
     * @param _tokens array of token addresses to associate if needed
     */
    function associateTokensIfNeeded(address[] memory _tokens) internal {
        for (uint256 i = 0; i < _tokens.length; ) {
            if (!tokens.contains(_tokens[i])) {
                tokenAssociate(_tokens[i]);
                tokens.add(_tokens[i]);

                // Emit individual association event - track who paid for the association
                emit TokenAssociated(_tokens[i], msg.sender);
            }

            unchecked {
                ++i;
            }
        }
    }

    /***
     * @notice Create an atomic batch trade (1-32 NFTs) with per-serial pricing
     * @param _tokens Array of unique token addresses (no duplicates)
     * @param _serials Array of serial arrays - each index corresponds to token at same index
     * @param _tinybarPrices Array of tinybar price arrays - each serial gets individual price
     * @param _lazyPrices Array of lazy price arrays - each serial gets individual price
     * @param _buyer The address of the buyer (0x0 for open trade)
     * @param _expiryTime The expiry time of the batch trade (0 for no expiry)
     * @return batchId The ID of the batch trade
     */
    function createBatchTrade(
        address[] memory _tokens,
        uint256[][] memory _serials,
        uint256[][] memory _tinybarPrices,
        uint256[][] memory _lazyPrices,
        address _buyer,
        uint256 _expiryTime
    ) external nonReentrant returns (bytes32 batchId) {
        if (_expiryTime != 0 && _expiryTime < block.timestamp) {
            revert ExpiryTimeInPast();
        }

        uint256 tokenCount = _tokens.length;
        if (tokenCount == 0) {
            revert InvalidBatchParameters();
        }

        // Validate outer array lengths match
        if (
            tokenCount != _serials.length ||
            tokenCount != _tinybarPrices.length ||
            tokenCount != _lazyPrices.length
        ) {
            revert InvalidBatchParameters();
        }

        // Calculate total items and validate inner array lengths
        uint256 totalItems = 0;
        for (uint256 i = 0; i < tokenCount; ) {
            uint256 serialsCount = _serials[i].length;
            if (
                serialsCount != _tinybarPrices[i].length ||
                serialsCount != _lazyPrices[i].length
            ) {
                revert InvalidBatchParameters();
            }
            totalItems += serialsCount;
            unchecked {
                ++i;
            }
        }

        if (totalItems == 0) {
            revert InvalidBatchParameters();
        }

        if (totalItems > 32) {
            revert BatchSizeExceedsLimit(totalItems, 32);
        }

        // Build TokenSerialPrice array and validate pricing/ownership
        TokenSerialPrice[] memory items = new TokenSerialPrice[](totalItems);
        uint256 totalTinybarPrice = 0;
        uint256 totalLazyPrice = 0;
        uint256 itemIndex = 0;

        for (uint256 tokenIdx = 0; tokenIdx < tokenCount; ) {
            address token = _tokens[tokenIdx];

            for (
                uint256 serialIdx = 0;
                serialIdx < _serials[tokenIdx].length;

            ) {
                uint256 serial = _serials[tokenIdx][serialIdx];
                uint256 tinybarPrice = _tinybarPrices[tokenIdx][serialIdx];
                uint256 lazyPrice = _lazyPrices[tokenIdx][serialIdx];

                // Enforce XOR pricing (not both)
                if (tinybarPrice > 0 && lazyPrice > 0) {
                    revert InvalidPricing();
                }

                // Auto-correct free items to 1 tinybar minimum (anti-royalty-bypass)
                if (tinybarPrice == 0 && lazyPrice == 0) {
                    tinybarPrice = 1;
                }

                // Validate ownership
                if (IERC721(token).ownerOf(serial) != msg.sender) {
                    revert UserDoesNotOwnNFT();
                }

                // Create TokenSerialPrice struct with validated pricing
                items[itemIndex] = TokenSerialPrice({
                    token: token,
                    serial: serial,
                    tinybarPrice: tinybarPrice,
                    lazyPrice: lazyPrice
                });

                totalTinybarPrice += tinybarPrice;
                totalLazyPrice += lazyPrice;
                itemIndex++;

                unchecked {
                    ++serialIdx;
                }
            }

            unchecked {
                ++tokenIdx;
            }
        }

        // Validate pricing for open trades (should have at least some value)
        if (
            _buyer == address(0) &&
            totalTinybarPrice == 0 &&
            totalLazyPrice == 0
        ) {
            revert BadArguments();
        }

        // Associate tokens that need association
        associateTokensIfNeeded(_tokens);

        // Charge for open market batch trades based on item count
        if (_buyer == address(0)) {
            if (!areAdvancedTradesFree(msg.sender)) {
                uint256 batchCost = _calculateBatchTradeCost(totalItems);
                lazyGasStation.drawLazyFrom(
                    msg.sender,
                    batchCost,
                    lazyBurnPercentage
                );
            }
        }

        // Create batch ID and store batch trade
        batchId = keccak256(
            abi.encodePacked(msg.sender, block.timestamp, ++tradeNonce)
        );

        // Store the batch trade (need to handle dynamic array in struct)
        batchTradesMap[batchId].seller = msg.sender;
        batchTradesMap[batchId].buyer = _buyer;
        batchTradesMap[batchId].totalTinybarPrice = totalTinybarPrice;
        batchTradesMap[batchId].totalLazyPrice = totalLazyPrice;
        batchTradesMap[batchId].expiryTime = _expiryTime;
        batchTradesMap[batchId].nonce = tradeNonce;

        // Store items array separately due to dynamic array limitation
        for (uint256 i = 0; i < totalItems; ) {
            batchTradesMap[batchId].items.push(items[i]);

            // Map individual items to batch for lookups
            bytes32 itemId = keccak256(
                abi.encodePacked(items[i].token, items[i].serial)
            );
            itemToBatch[itemId] = batchId;

            unchecked {
                ++i;
            }
        }

        // Add to user's batch trades
        userBatchTradesMap[msg.sender].add(batchId);
        userBatchTradesMap[_buyer].add(batchId);

        // Individual TokenAssociated events already emitted in associateTokensIfNeeded

        emit BatchTradeCreated(
            batchId,
            msg.sender,
            _buyer,
            totalItems,
            totalTinybarPrice,
            totalLazyPrice
        );
    }

    /***
     * @notice Calculate the cost in $LAZY for creating a batch trade based on item count
     * @param _itemCount Number of items in the batch
     * @return batchCost The cost in $LAZY tokens
     */
    function _calculateBatchTradeCost(
        uint256 _itemCount
    ) internal view returns (uint256 batchCost) {
        if (_itemCount <= 5) {
            return lazyCostForTrade * 2; // 2x base cost
        } else if (_itemCount <= 12) {
            return lazyCostForTrade * 3; // 3x base cost
        } else {
            return lazyCostForTrade * 5; // 5x base cost (13-32 items)
        }
    }

    /***
     * @notice Execute a batch trade atomically
     * @param _batchId The batch trade ID to execute
     * @return success Whether the batch execution was successful
     */
    function executeBatchTrade(
        bytes32 _batchId
    ) external nonReentrant returns (bool success) {
        BatchTrade storage batchTrade = batchTradesMap[_batchId];

        if (batchTrade.seller == address(0)) {
            revert BatchTradeNotFound(_batchId);
        }

        if (
            batchTrade.expiryTime != 0 &&
            block.timestamp > batchTrade.expiryTime
        ) {
            revert TradeExpired();
        }

        if (batchTrade.buyer != address(0) && batchTrade.buyer != msg.sender) {
            revert UserNotAuthorized();
        }

        // Ensure atomic execution by checking all prerequisites first
        _validateBatchTradeExecution(batchTrade);

        // Execute all transfers atomically
        _executeBatchTransfers(_batchId);

        // Clean up storage
        _cleanupBatchTrade(_batchId, batchTrade);

        emit BatchTradeExecuted(
            _batchId,
            msg.sender,
            batchTrade.items.length,
            batchTrade.totalTinybarPrice,
            batchTrade.totalLazyPrice
        );

        return true;
    }

    /***
     * @notice Internal function to validate NFT ownership and approval for a single item
     * @param token The NFT token address
     * @param serial The NFT serial number
     * @param owner Expected owner address
     * @return valid True if NFT is owned by owner and approved for this contract
     */
    function _validateNFTOwnershipAndApproval(
        address token,
        uint256 serial,
        address owner
    ) internal view returns (bool valid) {
        // Check NFT ownership
        if (IERC721(token).ownerOf(serial) != owner) {
            return false;
        }

        // Check approvals - either approved for all or specific serial approval
        return
            IERC721(token).isApprovedForAll(owner, address(this)) ||
            IERC721(token).getApproved(serial) == address(this);
    }

    /***
     * @notice Internal function to validate batch trade execution prerequisites
     * @param batchTrade The batch trade to validate
     */
    function _validateBatchTradeExecution(
        BatchTrade storage batchTrade
    ) internal view {
        // Validate all NFTs using consolidated validation
        for (uint256 i = 0; i < batchTrade.items.length; ) {
            TokenSerialPrice memory item = batchTrade.items[i];

            if (
                !_validateNFTOwnershipAndApproval(
                    item.token,
                    item.serial,
                    batchTrade.seller
                )
            ) {
                // Check specific failure reason for better error messages
                if (
                    IERC721(item.token).ownerOf(item.serial) !=
                    batchTrade.seller
                ) {
                    revert UserDoesNotOwnNFT();
                } else {
                    revert UserMustApproveNFTFirst();
                }
            }

            unchecked {
                ++i;
            }
        }

        // Validate buyer's payment capacity
        if (
            batchTrade.totalTinybarPrice > 0 &&
            msg.sender.balance < batchTrade.totalTinybarPrice
        ) {
            revert InsufficientPayment();
        }

        if (batchTrade.totalLazyPrice > 0) {
            if (
                IERC20(lazyToken).balanceOf(msg.sender) <
                batchTrade.totalLazyPrice
            ) {
                revert InsufficientPayment();
            }
            if (
                IERC20(lazyToken).allowance(msg.sender, address(this)) <
                batchTrade.totalLazyPrice
            ) {
                revert InsufficientPayment();
            }
        }
    }

    /***
     * @notice Internal function to execute all batch transfers
     * @param _batchId The batch trade ID
     */
    function _executeBatchTransfers(bytes32 _batchId) internal {
        BatchTrade storage batchTrade = batchTradesMap[_batchId];

        // Execute 2-step NFT transfers for each item using shared helper
        for (uint256 i = 0; i < batchTrade.items.length; ) {
            TokenSerialPrice memory item = batchTrade.items[i];

            _execute2StepNFTTransfer(
                item.token,
                item.serial,
                batchTrade.seller,
                batchTrade.buyer,
                item.tinybarPrice
            );

            unchecked {
                ++i;
            }
        }

        // Handle payments using shared helper functions
        _processHbarPayment(
            batchTrade.seller,
            msg.sender,
            batchTrade.totalTinybarPrice
        );
        _processLazyPayment(
            batchTrade.seller,
            msg.sender,
            batchTrade.totalLazyPrice
        );
    }

    /***
     * @notice Clean up batch trade storage after execution
     * @param _batchId The batch trade ID
     * @param batchTrade The batch trade struct
     */
    function _cleanupBatchTrade(
        bytes32 _batchId,
        BatchTrade storage batchTrade
    ) internal {
        // Remove from user mappings
        userBatchTradesMap[batchTrade.seller].remove(_batchId);
        userBatchTradesMap[batchTrade.buyer].remove(_batchId);

        // Clean up item to batch mappings
        for (uint256 i = 0; i < batchTrade.items.length; ) {
            bytes32 itemId = keccak256(
                abi.encodePacked(
                    batchTrade.items[i].token,
                    batchTrade.items[i].serial
                )
            );
            delete itemToBatch[itemId];
            unchecked {
                ++i;
            }
        }

        // Delete the batch trade
        delete batchTradesMap[_batchId];
    }

    /***
     * @notice Get trades for a specific token with pagination
     * @param _token The token address
     * @param _offset The starting index (0-based)
     * @param _size The maximum number of trades to return
     * @return tradeIds Array of trade IDs for the token
     */
    function getTradesForToken(
        address _token,
        uint256 _offset,
        uint256 _size
    ) external view returns (bytes32[] memory tradeIds) {
        uint256 totalLength = tokenTradesMap[_token].length();

        if (_offset >= totalLength) {
            return new bytes32[](0);
        }

        uint256 end = _offset + _size;
        if (end > totalLength) {
            end = totalLength;
        }

        uint256 resultLength = end - _offset;
        tradeIds = new bytes32[](resultLength);

        for (uint256 i = 0; i < resultLength; ) {
            tradeIds[i] = tokenTradesMap[_token].at(_offset + i);
            unchecked {
                ++i;
            }
        }
    }

    /***
     * @notice Cancel multiple trades in a single transaction
     * @param _tradeIds Array of trade IDs to cancel
     * @return cancelledCount Number of successfully cancelled trades
     */
    function cancelMultipleTrades(
        bytes32[] memory _tradeIds
    ) external nonReentrant returns (uint256 cancelledCount) {
        uint256 length = _tradeIds.length;
        if (length == 0) {
            revert InvalidBatchParameters();
        }

        // Reasonable limit for gas management (reduced for Hedera subcall limits)
        if (length > 32) {
            revert BatchSizeExceedsLimit(length, 32);
        }

        for (uint256 i = 0; i < length; ) {
            bytes32 tradeId = _tradeIds[i];
            Trade storage trade = allTradesMap[tradeId];

            // Check if trade exists and user is authorized to cancel
            if (trade.seller != address(0) && trade.seller == msg.sender) {
                // Cancel the trade
                userTradesMap[trade.seller].remove(tradeId);
                if (trade.buyer != address(0)) {
                    userTradesMap[trade.buyer].remove(tradeId);
                }
                tokenTradesMap[trade.token].remove(tradeId);

                emit TradeCancelled(
                    trade.seller,
                    trade.token,
                    trade.serial,
                    trade.nonce
                );
                delete allTradesMap[tradeId];
                cancelledCount++;
            }

            unchecked {
                ++i;
            }
        }

        // Individual TradeCancelled events already emitted above
    }

    /***
     * @notice Set the cost for an advanced trade
     * An advanced trade is one where the buyer is 0x0 and the trade is open to anyone
     * **ONLY OWNER**
     * @param _lazyCostForTrade the cost in $LAZY for a trade
     */
    function setLazyCostForTrade(uint256 _lazyCostForTrade) external onlyOwner {
        lazyCostForTrade = _lazyCostForTrade;
    }

    /***
     * @notice Set the burn percentage for a trade
     * The burn percentage is the percentage of $LAZY that is burned when a trade is created
     * by paying $LAZY for the trade create
     * **ONLY OWNER**
     * @param _lazyBurnPercentage the percentage of $LAZY to burn
     */
    function setLazyBurnPercentage(
        uint256 _lazyBurnPercentage
    ) external onlyOwner {
        lazyBurnPercentage = _lazyBurnPercentage;
    }

    /***
     * @notice Update platform fee rates and discounts
     * **ONLY OWNER**
     * @param _baseFeeRate Base fee rate in basis points (100bp = 1%) - applies to HBAR trades only
     * @param _lshGen2Discount LSH Gen2 holder discount percentage (0-100)
     * @param _lshMutantDiscount LSH Mutant holder discount percentage (0-100)
     * @param _lshGen1Discount LSH Gen1 holder discount percentage (0-100, should be highest)
     */
    function updateFeeRates(
        uint256 _baseFeeRate,
        uint256 _lshGen2Discount,
        uint256 _lshMutantDiscount,
        uint256 _lshGen1Discount
    ) external onlyOwner {
        // Validate base fee rate (max 10% = 1000bp)
        if (_baseFeeRate > 1000) {
            revert InvalidFeeRate(_baseFeeRate);
        }

        // Validate discount percentages (0-100%)
        if (
            _lshGen2Discount > 100 ||
            _lshMutantDiscount > 100 ||
            _lshGen1Discount > 100
        ) {
            revert InvalidFeeRate(_lshGen1Discount);
        }

        // Ensure hierarchical discount structure (Gen1 should have highest discount)
        if (
            _lshGen1Discount < _lshMutantDiscount ||
            _lshMutantDiscount < _lshGen2Discount
        ) {
            revert InvalidFeeRate(_lshGen1Discount);
        }

        baseFeeRate = _baseFeeRate;
        lshGen2Discount = _lshGen2Discount;
        lshMutantDiscount = _lshMutantDiscount;
        lshGen1Discount = _lshGen1Discount;

        emit FeeRatesUpdated(
            _baseFeeRate,
            _lshGen2Discount,
            _lshMutantDiscount,
            _lshGen1Discount
        );
    }

    /***
     * @notice Withdraw collected platform fees (HBAR only - LAZY trades are fee-free)
     * **ONLY OWNER**
     * @param _recipient Address to receive the fees
     */
    function withdrawPlatformFees(address _recipient) external onlyOwner {
        if (_recipient == address(0)) {
            revert BadArguments();
        }

        uint256 hbarAmount = totalHbarFeesCollected;
        if (hbarAmount == 0) {
            revert InsufficientFeesToWithdraw();
        }

        totalHbarFeesCollected = 0;
        Address.sendValue(payable(_recipient), hbarAmount);

        emit FeesWithdrawn(_recipient, hbarAmount);
    }

    /***
     * @notice Remove a trade from the state
     * * Internal function * to aid code reuse
     * @param _tradeId the hash of the token and serial
     * @param _buyer the address of the buyer
     * @param _seller the address of the seller
     * @param _token the address of the token
     */
    function removeTradeFromState(
        bytes32 _tradeId,
        address _buyer,
        address _seller,
        address _token
    ) internal {
        delete allTradesMap[_tradeId];
        userTradesMap[_seller].remove(_tradeId);
        if (_buyer != address(0)) {
            userTradesMap[_buyer].remove(_tradeId);
        } else {
            tokenTradesMap[_token].remove(_tradeId);
        }
    }

    /***
     * @notice Remove Lazy from the contract
     * Used on sunset to avoid trapped collateral
     * **ONLY OWNER**
     * @param _receiver the address to send the $LAZY to
     * @param _amount the amount of $LAZY to send
     */
    function retrieveLazy(
        address _receiver,
        uint256 _amount
    ) external onlyOwner {
        if (_receiver == address(0) || _amount == 0) {
            revert BadArguments();
        }

        IERC20(lazyToken).transfer(_receiver, _amount);
    }

    /***
     * @notice Internal helper to validate and create a single trade
     * @dev Encapsulates common validation logic shared between createTrade and createMultipleTrades
     * @param _token The token address
     * @param _serial The serial number
     * @param _buyer The buyer address (0x0 for open market)
     * @param _tinybarPrice The tinybar price
     * @param _lazyPrice The lazy price
     * @param _expiryTime The expiry time
     * @return tradeId The created trade ID, or bytes32(0) if creation failed
     * @return success Whether the trade was successfully created
     */
    function _validateAndCreateTrade(
        address _token,
        uint256 _serial,
        address _buyer,
        uint256 _tinybarPrice,
        uint256 _lazyPrice,
        uint256 _expiryTime
    ) internal returns (bytes32 tradeId, bool success) {
        // Validate expiry time (contract sunset checked by caller)
        if (_expiryTime != 0 && _expiryTime < block.timestamp) {
            return (bytes32(0), false);
        }

        // Validate pricing for open trades
        if (_buyer == address(0) && _tinybarPrice == 0 && _lazyPrice == 0) {
            return (bytes32(0), false);
        }

        // Ensure token association
        if (!tokens.contains(_token)) {
            tokenAssociate(_token);
            tokens.add(_token);
        }

        // Validate ownership
        if (IERC721(_token).ownerOf(_serial) != msg.sender) {
            return (bytes32(0), false);
        }

        // Create trade ID
        tradeId = keccak256(abi.encodePacked(_token, _serial));

        // Check if trade already exists and clean up before overwriting
        Trade storage existingTrade = allTradesMap[tradeId];
        bool tradeExists = existingTrade.seller != address(0);

        if (tradeExists) {
            // Always emit TradeCancelled event for the old trade before overwriting
            emit TradeCancelled(
                msg.sender,
                _token,
                _serial,
                existingTrade.nonce
            );

            // Clean up old mappings
            userTradesMap[existingTrade.seller].remove(tradeId);
            if (existingTrade.buyer != address(0)) {
                userTradesMap[existingTrade.buyer].remove(tradeId);
            } else {
                tokenTradesMap[_token].remove(tradeId);
            }
        }

        // Create/overwrite the trade
        Trade storage trade = allTradesMap[tradeId];
        trade.seller = msg.sender;
        trade.buyer = _buyer;
        trade.token = _token;
        trade.serial = _serial;
        trade.tinybarPrice = _tinybarPrice;
        trade.lazyPrice = _lazyPrice;
        trade.expiryTime = _expiryTime;
        trade.nonce = ++tradeNonce;

        // Add to appropriate mappings (always add since we cleaned up above if trade existed)
        userTradesMap[msg.sender].add(tradeId);
        if (_buyer != address(0)) {
            userTradesMap[_buyer].add(tradeId);
        } else {
            // Open trade - add to token mapping for discovery
            tokenTradesMap[_token].add(tradeId);
        }

        return (tradeId, true);
    }

    // Default methods to allow HBAR to be received in EVM
    receive() external payable {
        emit SecureTradeStatus("Receive", msg.sender, msg.value);
    }

    fallback() external payable {
        emit SecureTradeStatus("Fallback", msg.sender, msg.value);
    }
}
