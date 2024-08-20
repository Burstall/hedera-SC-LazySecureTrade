// SPDX-License-Identifier: ISC
pragma solidity >=0.8.12 <0.9.0;

/// @title LazySecureTrade
/// @author stowerling.eth / stowerling.hbar
/// @notice This contract is a decentralized secure trade contract for HTS NFTs without time limits

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {EnumerableMap} from "@openzeppelin/contracts/utils/structs/EnumerableMap.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

import {TokenStaker} from "./TokenStaker.sol";

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

	event SecureTradeStatus (
		string message,
		address sender,
		uint256 value
	);

    error TradeNotFoundOrInvalid();
    error TradeExpired();
    error TradeAssocationMissing();
    error UserDoesNotOwnNFT();
	error InsufficientFunds();
	error SellerCannotBeBuyer();
	error ContractSunset();
	error ExpiryTimeInPast();

    mapping(address => EnumerableSet.Bytes32Set) private userTradesMap;
    mapping(address => EnumerableSet.Bytes32Set) private tokenTradesMap;
    mapping(bytes32 => Trade) private allTradesMap;

    EnumerableSet.AddressSet private tokens;

	address public immutable LSH_GEN1;
	address public immutable LSH_GEN2;

    // each trade has a unique nonce
    uint256 public tradeNonce;
    uint256 public lazyCostForTrade;
    uint256 public lazyBurnPercentage;
	uint256 public contractSunset;

    constructor(
        address _lazyToken,
        address _lazyGasStation,
        address _lazyDelegateRegistry,
		address _lshGen1,
		address _lshGen2,
		uint256 _lazyCostForTrade,
		uint256 _lazyBurnPercentage
    ) {
        // initialize the TokenStaker contract
		initContracts(_lazyToken, _lazyGasStation, _lazyDelegateRegistry);

		LSH_GEN1 = _lshGen1;
		LSH_GEN2 = _lshGen2;

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

        if (_expiryTime != 0 && _expiryTime < block.timestamp) {
            revert ExpiryTimeInPast();
        }

		if (_buyer == address(0) && _tinybarPrice == 0 && _lazyPrice == 0) {
			// potentially valid but risks anyone claiming the NFT for free
			revert BadArguments();
		}

        if (!tokens.contains(_token)) {
            tokenAssociate(_token);
            tokens.add(_token);
        }

        // ensure the user owns the NFT
        if (IERC721(_token).ownerOf(_serial) != msg.sender) {
            revert UserDoesNotOwnNFT();
        }

		// if _buyer == address(0), then it is an open trade
		// charge the user for the trade (paid in $LAZY via the LazyGasStation)
		if (_buyer == address(0)) {
			// check if the user does not own an LSH Gen 1 or Gen 2
			if (!areAdvancedTradesFree(msg.sender)) {
				
				// if not then charge the user for the trade
				lazyGasStation.drawLazyFrom(msg.sender, lazyCostForTrade, lazyBurnPercentage);
			}
		}

        // each NFT can only have one trade live at a time
        // hence limited to a hash of token and serial
        tradeId = keccak256(abi.encodePacked(_token, _serial));

        Trade memory trade = Trade({
            seller: msg.sender,
            buyer: _buyer,
            token: _token,
            serial: _serial,
            tinybarPrice: _tinybarPrice,
            lazyPrice: _lazyPrice,
            expiryTime: _expiryTime,
            nonce: tradeNonce++
        });

        allTradesMap[tradeId] = trade;
		// always add the trade to the user's trade list
        userTradesMap[msg.sender].add(tradeId);
		// if the buyer is not 0x0, then add the trade to the buyer's trade list
        if (_buyer != address(0)) {
            userTradesMap[_buyer].add(tradeId);
        }
		else {
			// if the buyer is 0x0, then add the trade to the token's trade list
			// trade is open for anyone to buy
			tokenTradesMap[_token].add(tradeId);
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
	function executeTrade(bytes32 _tradeId) external nonReentrant payable {
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
			lazyGasStation.drawLazyFromPayTo(msg.sender, trade.lazyPrice, 0, trade.seller);
		}

		// use TokenStaker moveNFTs to move the NFT from seller to the Smart Contract
		// then use moveNFTs to move the NFT from the Smart Contract to the buyer

		// single serial for now (version 0.1)
		uint256[] memory serials = new uint256[](1);
		serials[0] = trade.serial;

		// Seller to Smart Contract
		moveNFTs(
			TransferDirection.STAKING,
			trade.token,
			serials,
			trade.seller,
			false,
			int64(trade.tinybarPrice.toUint64()));

		// Smart Contract to Buyer
		moveNFTs(
			TransferDirection.WITHDRAWAL,
			trade.token,
			serials,
			msg.sender,
			false,
			1);


		// remove the trade from state
		removeTradeFromState(_tradeId, trade.buyer, trade.seller, trade.token);

		emit TradeCompleted(trade.seller, msg.sender, trade.token, trade.serial, trade.nonce);
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
	function getTrades(bytes32[] memory _tradeIdList) external view returns (Trade[] memory) {
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
	function getUserTrades(address _user) external view returns (bytes32[] memory) {
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
	function getTokenTrades(address _token) external view returns (bytes32[] memory) {
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
	 * @notice Get tokens associated with the contract - better to poll tokesn associated to the contract
	 * via the mirror nodes
	 * @param _offset the offset to start from
	 * @param _batch the number of tokens to return
	 */
	function getTokens(uint256 offset, uint256 batch) external view returns (address[] memory) {
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
	function isTradeValid(bytes32 _tradeId, address _user) public view returns (bool) {
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
		
		if (_user != address(0) && 
				trade.seller != _user &&
				trade.buyer != address(0) && 
				trade.buyer != _user) {
			return false;
		}



		// now on to paid methods (will 'cost' 3 sub transactions, remember the limit is 50 total)
		// so we can only accept 16 validations per call

		// check the seller has the NFT
		if (IERC721(trade.token).ownerOf(trade.serial) != trade.seller) {
			return false;
		}

		// check the allowance of the NFT then return true
		if (IERC721(trade.token).isApprovedForAll(trade.seller, address(this)) ||
			IERC721(trade.token).getApproved(trade.serial) == address(this)) {
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
	function areTradesValid(bytes32[] memory _tradeIdList, address _user) external view returns (bool[] memory) {
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
		if (IERC721(LSH_GEN1).balanceOf(_user) == 0 &&
				 IERC721(LSH_GEN2).balanceOf(_user)== 0 &&
				 lazyDelegateRegistry.getSerialsDelegatedTo(_user, LSH_GEN1).length == 0 &&
				 lazyDelegateRegistry.getSerialsDelegatedTo(_user, LSH_GEN2).length == 0) {
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
	function setLazyBurnPercentage(uint256 _lazyBurnPercentage) external onlyOwner {
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
	function removeTradeFromState(bytes32 _tradeId, address _buyer, address _seller, address _token) internal {
		delete allTradesMap[_tradeId];
		userTradesMap[_seller].remove(_tradeId);
		if (_buyer != address(0)) {
			userTradesMap[_buyer].remove(_tradeId);
		}
		else {
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
    function transferHbar(address payable receiverAddress, uint256 amount)
        external
        onlyOwner
    {
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
	) external onlyOwner() {
		if (_receiver == address(0) || _amount == 0) {
			revert BadArguments();
		}

		IERC20(lazyToken).transfer(_receiver, _amount);
	}

	// Default methods to allow HBAR to be received in EVM
    receive() external payable {
        emit SecureTradeStatus(
            "Receive",
            msg.sender,
            msg.value
        );
    }

    fallback() external payable {
        emit SecureTradeStatus(
            "Fallback",
            msg.sender,
            msg.value
        );
    }
}
