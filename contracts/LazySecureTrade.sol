// SPDX-License-Identifier: ISC
pragma solidity >=0.8.12 <0.9.0;

/// @title LazySecureTrade
/// @author stowerling.eth / stowerling.hbar
/// @notice This contract is a decentralized secure trade contract for HTS NFTs without time limits

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {EnumerableMap} from "@openzeppelin/contracts/utils/structs/EnumerableMap.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

import {TokenStaker} from "./TokenStaker.sol";
import {IHRC719} from "./interfaces/IHRC719.sol";

contract LazySecureTrade is Ownable, ReentrancyGuard, TokenStaker {
    using EnumerableSet for EnumerableSet.AddressSet;
    using EnumerableSet for EnumerableSet.Bytes32Set;
    using EnumerableMap for EnumerableMap.Bytes32ToBytes32Map;
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

    // Multiple Trade Events
    event MultipleTradesCreated(
        address indexed seller,
        address indexed buyer,
        uint256 successCount,
        uint256 totalLazyCost
    );

    event MultipleTradesExecuted(
        address indexed buyer,
        uint256 executedCount,
        uint256 failedCount,
        uint256 totalHbarUsed
    );

    event MultipleTradesCancelled(
        address indexed canceller,
        uint256 cancelledCount
    );

    // Token Association Events
    event TokenAssociationBatch(
        address[] tokens,
        uint256 associationCount,
        uint256 gasCost
    );

    event SecureTradeStatus(string message, address sender, uint256 value);

    error TradeNotFoundOrInvalid();
    error TradeExpired();
    error TradeAssocationMissing();
    error UserDoesNotOwnNFT();
    error InsufficientFunds();
    error InsufficientHBAR();
    error InsufficientLAZY();
    error InsufficientAllowanceLAZY();
    error UserNotSeller();
    error UserNotBuyer();
    error UserMustApproveNFTFirst();
    error SellerCannotBeBuyer();
    error ContractSunset();
    error ExpiryTimeInPast();

    // v0.2 Batch Trade Errors
    error BatchTradeNotFound(bytes32 batchId);
    error BatchTradeMismatch();
    error AtomicBatchExecutionFailed(bytes32 batchId, uint256 failedAtIndex);
    error BatchSizeExceedsLimit(uint256 provided, uint256 maximum);
    error InsufficientFundsForBatch(uint256 required, uint256 provided);

    // Token Association Errors
    error TooManyNewTokenAssociations(uint256 requested, uint256 maximum);

    // General Batch Errors
    error ArrayLengthMismatch();
    error EmptyBatchNotAllowed();
    error NonAtomicBatchNotSupported(); // Use createMultipleTrades instead

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
    uint256 public contractSunset;

    // v0.2 Configuration Parameters
    uint256 public arbitrageSplit = 5000; // 50.00% in basis points (owner configurable)
    uint256 public constant MAX_NEW_TOKEN_ASSOCIATIONS = 6; // Hard limit per batch operation

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

        // initial sunset at +90 days
        contractSunset = block.timestamp + 90 days;
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
        if (block.timestamp > contractSunset) {
            revert ContractSunset();
        }

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
        Trade memory trade = allTradesMap[_tradeId];

        // trade must be valid for msg.sender
        if (!isTradeValid(_tradeId, msg.sender)) {
            revert TradeNotFoundOrInvalid();
        }

        // ensure msg.sender is not the seller
        if (msg.sender == trade.seller) {
            revert SellerCannotBeBuyer();
        }

        // check if sufficient funds have been sent
        if (trade.tinybarPrice > 0) {
            if (msg.value < trade.tinybarPrice) {
                revert InsufficientFunds();
            }

            // refund any excess funds
            if (msg.value > trade.tinybarPrice) {
                payable(msg.sender).transfer(msg.value - trade.tinybarPrice);
            }
        }

        // if there is a price in $LAZY, then draw the funds from the buyer
        // and send them to the seller. N.B. the LazyGasStation will handle the movement
        // of the funds. This will not obey royalties yet (version 0.1)
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

        // use TokenStaker batchMoveNFTs to move the NFT from seller to the Smart Contract
        // then use batchMoveNFTs to move the NFT from the Smart Contract to the buyer
        // USING BATCHMOVE FOR A SINGLE NFT IS OVERKILL - but it is a good pattern to follow
        // as it hooks into the refill() modifier to ensure the contract has sufficient HBAR

        // single serial for now (version 0.1)
        uint256[] memory serials = new uint256[](1);
        serials[0] = trade.serial;

        // Seller to Smart Contract
        batchMoveNFTs(
            TransferDirection.STAKING,
            trade.token,
            serials,
            trade.seller,
            false,
            int64(Math.max(trade.tinybarPrice, 1).toUint64())
        );

        // Smart Contract to Buyer
        batchMoveNFTs(
            TransferDirection.WITHDRAWAL,
            trade.token,
            serials,
            msg.sender,
            false,
            1
        );

        // remove the trade from state
        removeTradeFromState(_tradeId, trade.buyer, trade.seller, trade.token);

        emit TradeCompleted(
            trade.seller,
            msg.sender,
            trade.token,
            trade.serial,
            trade.nonce
        );
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
            revert UserNotSeller();
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
        if (block.timestamp > contractSunset) {
            revert ContractSunset();
        }

        if (_expiryTime != 0 && _expiryTime < block.timestamp) {
            revert ExpiryTimeInPast();
        }

        uint256 tokenCount = _uniqueTokens.length;
        if (tokenCount == 0) {
            revert EmptyBatchNotAllowed();
        }

        // Validate array lengths match
        if (
            tokenCount != _serialsPerToken.length ||
            tokenCount != _tinybarPricesPerToken.length ||
            tokenCount != _lazyPricesPerToken.length
        ) {
            revert ArrayLengthMismatch();
        }

        // Calculate total trades and validate limits
        uint256 totalTrades = 0;
        for (uint256 i = 0; i < tokenCount; ) {
            uint256 serialsCount = _serialsPerToken[i].length;
            if (
                serialsCount != _tinybarPricesPerToken[i].length ||
                serialsCount != _lazyPricesPerToken[i].length
            ) {
                revert ArrayLengthMismatch();
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

        // Validate token associations directly (no need to extract unique tokens)
        validateTokenAssociations(_uniqueTokens);

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

        // Associate tokens that need association (gas cost handled here)
        uint256 associatedCount = associateTokensIfNeeded(_uniqueTokens);

        // Charge total $LAZY cost for open market trades
        if (totalLazyCost > 0 && !areAdvancedTradesFree(msg.sender)) {
            lazyGasStation.drawLazyFrom(
                msg.sender,
                totalLazyCost,
                lazyBurnPercentage
            );
        }

        // Emit batch event
        if (associatedCount > 0) {
            emit TokenAssociationBatch(
                _uniqueTokens,
                associatedCount,
                associatedCount * 1000000
            );
        }

        emit MultipleTradesCreated(
            msg.sender,
            _buyer,
            successfulTrades,
            totalLazyCost
        );
    }

    /***
     * @notice Execute multiple individual trades with partial failure handling
     * @dev Non-atomic execution - some trades may succeed while others fail
     * @param _tradeIds Array of trade IDs to execute
     * @return executedTrades Array of successfully executed trade IDs
     * @return failedTrades Array of failed trade IDs
     */
    function sweepTrades(
        bytes32[] memory _tradeIds
    )
        external
        payable
        nonReentrant
        returns (bytes32[] memory executedTrades, bytes32[] memory failedTrades)
    {
        uint256 length = _tradeIds.length;
        if (length == 0) {
            revert EmptyBatchNotAllowed();
        }

        // Reasonable limit for gas management
        if (length > 30) {
            revert BatchSizeExceedsLimit(length, 30);
        }

        bytes32[] memory tempExecuted = new bytes32[](length);
        bytes32[] memory tempFailed = new bytes32[](length);
        uint256 executedCount = 0;
        uint256 failedCount = 0;
        uint256 totalHbarUsed = 0;

        for (uint256 i = 0; i < length; ) {
            bytes32 tradeId = _tradeIds[i];
            Trade storage trade = allTradesMap[tradeId];

            // Check if trade exists and is valid
            if (trade.seller == address(0)) {
                tempFailed[failedCount] = tradeId;
                failedCount++;
                unchecked {
                    ++i;
                }
                continue;
            }

            // Check expiry
            if (trade.expiryTime != 0 && block.timestamp > trade.expiryTime) {
                tempFailed[failedCount] = tradeId;
                failedCount++;
                unchecked {
                    ++i;
                }
                continue;
            }

            // Check if buyer is authorized
            if (trade.buyer != address(0) && trade.buyer != msg.sender) {
                tempFailed[failedCount] = tradeId;
                failedCount++;
                unchecked {
                    ++i;
                }
                continue;
            }

            // Check if we have enough HBAR
            if (totalHbarUsed + trade.tinybarPrice > msg.value) {
                tempFailed[failedCount] = tradeId;
                failedCount++;
                unchecked {
                    ++i;
                }
                continue;
            }

            // Try to execute the trade
            try this._executeSingleTrade(tradeId, msg.sender) {
                tempExecuted[executedCount] = tradeId;
                executedCount++;
                totalHbarUsed += trade.tinybarPrice;
            } catch {
                tempFailed[failedCount] = tradeId;
                failedCount++;
            }

            unchecked {
                ++i;
            }
        }

        // Return properly sized arrays
        executedTrades = new bytes32[](executedCount);
        failedTrades = new bytes32[](failedCount);

        for (uint256 i = 0; i < executedCount; ) {
            executedTrades[i] = tempExecuted[i];
            unchecked {
                ++i;
            }
        }

        for (uint256 i = 0; i < failedCount; ) {
            failedTrades[i] = tempFailed[i];
            unchecked {
                ++i;
            }
        }

        // Refund excess HBAR
        if (msg.value > totalHbarUsed) {
            (bool success, ) = payable(msg.sender).call{
                value: msg.value - totalHbarUsed
            }("");
            require(success, "HBAR refund failed");
        }

        emit MultipleTradesExecuted(
            msg.sender,
            executedCount,
            failedCount,
            totalHbarUsed
        );
    }

    /***
     * @notice Internal function to execute a single trade (used by sweep functions)
     * @param _tradeId The trade ID to execute
     * @param _buyer The buyer address
     */
    function _executeSingleTrade(bytes32 _tradeId, address _buyer) external {
        require(msg.sender == address(this), "Only self-call allowed");

        Trade storage trade = allTradesMap[_tradeId];

        // Validate trade execution
        if (IERC721(trade.token).ownerOf(trade.serial) != trade.seller) {
            revert UserDoesNotOwnNFT();
        }

        if (
            !IERC721(trade.token).isApprovedForAll(trade.seller, address(this))
        ) {
            if (
                IERC721(trade.token).getApproved(trade.serial) != address(this)
            ) {
                revert UserMustApproveNFTFirst();
            }
        }

        // Transfer the NFT
        uint256[] memory serialArray = new uint256[](1);
        serialArray[0] = trade.serial;

        moveNFTs(
            TransferDirection.WITHDRAWAL,
            trade.token,
            serialArray,
            trade.seller,
            false, // No delegation changes
            1 // 1 tinybar minimum
        );

        // Handle payments
        if (trade.tinybarPrice > 0) {
            (bool success, ) = payable(trade.seller).call{
                value: trade.tinybarPrice
            }("");
            require(success, "HBAR payment failed");
        }

        if (trade.lazyPrice > 0) {
            IERC20(lazyToken).transferFrom(
                _buyer,
                trade.seller,
                trade.lazyPrice
            );
        }

        // Clean up storage
        userTradesMap[trade.seller].remove(_tradeId);
        if (trade.buyer != address(0)) {
            userTradesMap[trade.buyer].remove(_tradeId);
        }
        tokenTradesMap[trade.token].remove(_tradeId);

        delete allTradesMap[_tradeId];

        // Emit individual trade executed event
        emit TradeCompleted(
            trade.seller,
            _buyer,
            trade.token,
            trade.serial,
            trade.nonce
        );
    }

    /***
     * @notice Get tokens associated with the contract - better to poll tokesn associated to the contract
     * via the mirror nodes
     * @param _offset the offset to start from
     * @param _batch the number of tokens to return
     */
    function getTokens(
        uint256 offset,
        uint256 batch
    ) external view returns (address[] memory) {
        uint256 length = tokens.length();
        if (offset + batch > length) {
            revert BadArguments();
        }

        uint256 end = offset + batch > length ? length : offset + batch;
        address[] memory tokenList = new address[](end - offset);

        for (uint256 i = offset; i < end; ) {
            tokenList[i - offset] = tokens.at(i);

            unchecked {
                ++i;
            }
        }

        return tokenList;
    }

    /***
     * @notice Get the total number of tokens associated with the contract - better to poll tokesn associated to the contract
     * via the mirror nodes
     */
    function getTotalTokens() external view returns (uint256) {
        return tokens.length();
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

        if (trade.expiryTime != 0 && trade.expiryTime < block.timestamp) {
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

        // check the seller has the NFT
        if (IERC721(trade.token).ownerOf(trade.serial) != trade.seller) {
            return false;
        }

        // check the allowance of the NFT then return true
        if (
            IERC721(trade.token).isApprovedForAll(
                trade.seller,
                address(this)
            ) || IERC721(trade.token).getApproved(trade.serial) == address(this)
        ) {
            return true;
        }

        // if we get here, then the trade is invalid
        return false;
    }

    /***
     * @notice Check if multiple trades are valid for a user
     * @param _tradeIdList the list of trade IDs to check
     * @param _user the address of the user
     * @return validTrades the list of valid trades a bool array per ID supplied
     */
    function areTradesValid(
        bytes32[] memory _tradeIdList,
        address _user
    ) external view returns (bool[] memory) {
        uint256 length = _tradeIdList.length;
        bool[] memory validTrades = new bool[](length);

        for (uint256 i = 0; i < length; ) {
            validTrades[i] = isTradeValid(_tradeIdList[i], _user);

            unchecked {
                ++i;
            }
        }

        return validTrades;
    }

    /***
     * @notice Check if a user has advanced trades free
     * Owning an LSH Gen 1 / Gen 2 token (or having someone delegate to you) will allow you to create
     * advanced (open to anyone) trades for free else you pay $LAZY per create
     * @param _user the address of the user
     */
    function areAdvancedTradesFree(address _user) public view returns (bool) {
        if (
            IERC721(LSH_GEN1).balanceOf(_user) == 0 &&
            IERC721(LSH_GEN2).balanceOf(_user) == 0 &&
            IERC721(LSH_GEN1_MUTANT).balanceOf(_user) == 0 &&
            lazyDelegateRegistry
                .getSerialsDelegatedTo(_user, LSH_GEN1)
                .length ==
            0 &&
            lazyDelegateRegistry
                .getSerialsDelegatedTo(_user, LSH_GEN2)
                .length ==
            0 &&
            lazyDelegateRegistry
                .getSerialsDelegatedTo(_user, LSH_GEN1_MUTANT)
                .length ==
            0
        ) {
            return false;
        }

        return true;
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
     * @notice Validate token associations for batch operations
     * Count how many tokens need new associations and revert if > MAX_NEW_TOKEN_ASSOCIATIONS
     * @param _tokens array of token addresses to validate
     * @return newAssociationCount number of tokens that need new associations
     */
    function validateTokenAssociations(
        address[] memory _tokens
    ) internal view returns (uint256 newAssociationCount) {
        newAssociationCount = 0;

        for (uint256 i = 0; i < _tokens.length; ) {
            // Check if we need to associate this token
            if (!IHRC719(_tokens[i]).isAssociated()) {
                newAssociationCount++;
            }

            unchecked {
                ++i;
            }
        }

        if (newAssociationCount > MAX_NEW_TOKEN_ASSOCIATIONS) {
            revert TooManyNewTokenAssociations(
                newAssociationCount,
                MAX_NEW_TOKEN_ASSOCIATIONS
            );
        }
    }

    /***
     * @notice Associate tokens that need association and track them
     * @param _tokens array of token addresses to associate if needed
     * @return associatedCount number of tokens actually associated
     */
    function associateTokensIfNeeded(
        address[] memory _tokens
    ) internal returns (uint256 associatedCount) {
        associatedCount = 0;

        for (uint256 i = 0; i < _tokens.length; ) {
            if (!tokens.contains(_tokens[i])) {
                tokenAssociate(_tokens[i]);
                tokens.add(_tokens[i]);
                associatedCount++;
            }

            unchecked {
                ++i;
            }
        }
    }

    /***
     * @notice Create an atomic batch trade (1-32 NFTs)
     * @param _items Array of token/serial/price combinations
     * @param _buyer The address of the buyer (0x0 for open trade)
     * @param _expiryTime The expiry time of the batch trade (0 for no expiry)
     * @return batchId The ID of the batch trade
     */
    function createBatchTrade(
        TokenSerialPrice[] memory _items,
        address _buyer,
        uint256 _expiryTime
    ) external nonReentrant returns (bytes32 batchId) {
        if (block.timestamp > contractSunset) {
            revert ContractSunset();
        }

        if (_expiryTime != 0 && _expiryTime < block.timestamp) {
            revert ExpiryTimeInPast();
        }

        if (_items.length == 0) {
            revert EmptyBatchNotAllowed();
        }

        if (_items.length > 32) {
            revert BatchSizeExceedsLimit(_items.length, 32);
        }

        // Extract unique tokens for association validation
        address[] memory uniqueTokens = _extractUniqueTokens(_items);

        // Validate token associations upfront
        validateTokenAssociations(uniqueTokens);

        // Calculate total prices and validate ownership
        uint256 totalTinybarPrice = 0;
        uint256 totalLazyPrice = 0;

        for (uint256 i = 0; i < _items.length; ) {
            // Ensure the user owns each NFT
            if (
                IERC721(_items[i].token).ownerOf(_items[i].serial) != msg.sender
            ) {
                revert UserDoesNotOwnNFT();
            }

            totalTinybarPrice += _items[i].tinybarPrice;
            totalLazyPrice += _items[i].lazyPrice;

            unchecked {
                ++i;
            }
        }

        // Validate pricing for open trades
        if (
            _buyer == address(0) &&
            totalTinybarPrice == 0 &&
            totalLazyPrice == 0
        ) {
            revert BadArguments();
        }

        // Associate tokens that need association
        uint256 associatedCount = associateTokensIfNeeded(uniqueTokens);

        // Charge for open market batch trades based on item count
        if (_buyer == address(0)) {
            if (!areAdvancedTradesFree(msg.sender)) {
                uint256 batchCost = _calculateBatchTradeCost(_items.length);
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
        for (uint256 i = 0; i < _items.length; ) {
            batchTradesMap[batchId].items.push(_items[i]);

            // Map individual items to batch for lookups
            bytes32 itemId = keccak256(
                abi.encodePacked(_items[i].token, _items[i].serial)
            );
            itemToBatch[itemId] = batchId;

            unchecked {
                ++i;
            }
        }

        // Add to user's batch trades
        userBatchTradesMap[msg.sender].add(batchId);
        userBatchTradesMap[_buyer].add(batchId);

        // Emit events
        if (associatedCount > 0) {
            emit TokenAssociationBatch(
                uniqueTokens,
                associatedCount,
                associatedCount * 1000000
            ); // Approximate gas cost
        }

        emit BatchTradeCreated(
            batchId,
            msg.sender,
            _buyer,
            _items.length,
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
     * @notice Extract unique token addresses from items array
     * @param _items Array of TokenSerialPrice items
     * @return uniqueTokens Array of unique token addresses
     */
    function _extractUniqueTokens(
        TokenSerialPrice[] memory _items
    ) internal pure returns (address[] memory uniqueTokens) {
        // Create temporary array with max possible size
        address[] memory tempTokens = new address[](_items.length);
        uint256 uniqueCount = 0;

        for (uint256 i = 0; i < _items.length; ) {
            address token = _items[i].token;
            bool isUnique = true;

            // Check if token already exists in our unique list
            for (uint256 j = 0; j < uniqueCount; ) {
                if (tempTokens[j] == token) {
                    isUnique = false;
                    break;
                }
                unchecked {
                    ++j;
                }
            }

            if (isUnique) {
                tempTokens[uniqueCount] = token;
                uniqueCount++;
            }

            unchecked {
                ++i;
            }
        }

        // Create properly sized return array
        uniqueTokens = new address[](uniqueCount);
        for (uint256 i = 0; i < uniqueCount; ) {
            uniqueTokens[i] = tempTokens[i];
            unchecked {
                ++i;
            }
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
            revert UserNotBuyer();
        }

        // Ensure atomic execution by checking all prerequisites first
        _validateBatchTradeExecution(batchTrade);

        // Calculate arbitrage payments if applicable
        uint256 arbitrageTinybar = 0;
        uint256 arbitrageLazy = 0;
        if (batchTrade.buyer == address(0)) {
            arbitrageTinybar =
                (batchTrade.totalTinybarPrice * arbitrageSplit) /
                10000;
            arbitrageLazy =
                (batchTrade.totalLazyPrice * arbitrageSplit) /
                10000;
        }

        // Execute all transfers atomically
        try
            this._executeBatchTransfers(
                _batchId,
                arbitrageTinybar,
                arbitrageLazy
            )
        {
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
        } catch {
            revert AtomicBatchExecutionFailed(_batchId, 0);
        }
    }

    /***
     * @notice Internal function to validate batch trade execution prerequisites
     * @param batchTrade The batch trade to validate
     */
    function _validateBatchTradeExecution(
        BatchTrade storage batchTrade
    ) internal view {
        for (uint256 i = 0; i < batchTrade.items.length; ) {
            TokenSerialPrice memory item = batchTrade.items[i];

            // Check NFT ownership hasn't changed
            if (IERC721(item.token).ownerOf(item.serial) != batchTrade.seller) {
                revert UserDoesNotOwnNFT();
            }

            // Check approvals
            if (
                !IERC721(item.token).isApprovedForAll(
                    batchTrade.seller,
                    address(this)
                )
            ) {
                if (
                    IERC721(item.token).getApproved(item.serial) !=
                    address(this)
                ) {
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
            revert InsufficientHBAR();
        }

        if (batchTrade.totalLazyPrice > 0) {
            if (
                IERC20(lazyToken).balanceOf(msg.sender) <
                batchTrade.totalLazyPrice
            ) {
                revert InsufficientLAZY();
            }
            if (
                IERC20(lazyToken).allowance(msg.sender, address(this)) <
                batchTrade.totalLazyPrice
            ) {
                revert InsufficientAllowanceLAZY();
            }
        }
    }

    /***
     * @notice Internal function to execute all batch transfers
     * @param _batchId The batch trade ID
     * @param arbitrageTinybar Arbitrage payment in tinybar
     * @param arbitrageLazy Arbitrage payment in $LAZY
     */
    function _executeBatchTransfers(
        bytes32 _batchId,
        uint256 arbitrageTinybar,
        uint256 arbitrageLazy
    ) external {
        require(msg.sender == address(this), "Only self-call allowed");

        BatchTrade storage batchTrade = batchTradesMap[_batchId];

        // For batch efficiency, group NFTs by collection and use moveNFTs for each group
        // This approach leverages the existing TokenStaker infrastructure

        // Since we validated ownership and approvals earlier, we can proceed with transfers
        for (uint256 i = 0; i < batchTrade.items.length; ) {
            TokenSerialPrice memory item = batchTrade.items[i];

            // Transfer individual NFT using existing single NFT transfer logic
            uint256[] memory serialArray = new uint256[](1);
            serialArray[0] = item.serial;

            // Use the existing TokenStaker moveNFTs function
            moveNFTs(
                TransferDirection.WITHDRAWAL, // From seller to buyer
                item.token,
                serialArray,
                batchTrade.seller,
                false, // No delegation changes needed
                1 // 1 tinybar minimum for transfer
            );

            unchecked {
                ++i;
            }
        }

        // Handle payments
        if (batchTrade.totalTinybarPrice > 0) {
            uint256 sellerAmount = batchTrade.totalTinybarPrice -
                arbitrageTinybar;

            if (arbitrageTinybar > 0) {
                // Send arbitrage to caller
                (bool arbitrageSuccess, ) = payable(tx.origin).call{
                    value: arbitrageTinybar
                }("");
                require(arbitrageSuccess, "Arbitrage payment failed");
            }

            // Send payment to seller
            (bool sellerSuccess, ) = payable(batchTrade.seller).call{
                value: sellerAmount
            }("");
            require(sellerSuccess, "Seller payment failed");
        }

        if (batchTrade.totalLazyPrice > 0) {
            uint256 sellerAmount = batchTrade.totalLazyPrice - arbitrageLazy;

            if (arbitrageLazy > 0) {
                // Transfer arbitrage to caller
                IERC20(lazyToken).transferFrom(
                    msg.sender,
                    tx.origin,
                    arbitrageLazy
                );
            }

            // Transfer payment to seller
            IERC20(lazyToken).transferFrom(
                msg.sender,
                batchTrade.seller,
                sellerAmount
            );
        }
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
     * @notice Get all trades for a specific token
     * @param _token The token address
     * @return tradeIds Array of trade IDs for the token
     */
    function getTradesForToken(
        address _token
    ) external view returns (bytes32[] memory tradeIds) {
        uint256 length = tokenTradesMap[_token].length();
        tradeIds = new bytes32[](length);

        for (uint256 i = 0; i < length; ) {
            tradeIds[i] = tokenTradesMap[_token].at(i);
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
            revert EmptyBatchNotAllowed();
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

        emit MultipleTradesCancelled(msg.sender, cancelledCount);
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
     * @notice Set the contract sunset
     * The contract sunset is the time at which the contract will no longer accept new trades
     * Intent is this is a v0.1 contract with more features to come.
     * Having a decentralized (only extendable to give confidence) sunset allows for a new contract to
     * be deployed and the trades to be migrated to the new contract naturally
     * **ONLY OWNER**
     * @param _days the number of days to extend the sunset by
     */
    function extendSunset(uint256 _days) external onlyOwner {
        contractSunset += _days * 1 days;
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
     * @notice Remove Hbar from the contract
     * Used on sunset to avoid trapped collateral
     * **ONLY OWNER**
     * @param receiverAddress the address to send the Hbar to
     * @param amount the amount of Hbar to send
     */
    function transferHbar(
        address payable receiverAddress,
        uint256 amount
    ) external onlyOwner {
        if (receiverAddress == address(0) || amount == 0) {
            revert BadArguments();
        }
        Address.sendValue(receiverAddress, amount);
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

    // Default methods to allow HBAR to be received in EVM
    receive() external payable {
        emit SecureTradeStatus("Receive", msg.sender, msg.value);
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

        // Create the trade (overwrite any existing trade for this NFT)
        Trade storage trade = allTradesMap[tradeId];
        trade.seller = msg.sender;
        trade.buyer = _buyer;
        trade.token = _token;
        trade.serial = _serial;
        trade.tinybarPrice = _tinybarPrice;
        trade.lazyPrice = _lazyPrice;
        trade.expiryTime = _expiryTime;
        trade.nonce = ++tradeNonce;

        // Add to user mappings
        userTradesMap[msg.sender].add(tradeId);
        if (_buyer != address(0)) {
            userTradesMap[_buyer].add(tradeId);
        } else {
            // Open trade - add to token mapping for discovery
            tokenTradesMap[_token].add(tradeId);
        }

        return (tradeId, true);
    }

    fallback() external payable {
        emit SecureTradeStatus("Fallback", msg.sender, msg.value);
    }
}
