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
        initContracts(_lazyToken, _lazyGasStation, _lazyDelegateRegistry);

		LSH_GEN1 = _lshGen1;
		LSH_GEN2 = _lshGen2;

		lazyCostForTrade = _lazyCostForTrade;
		lazyBurnPercentage = _lazyBurnPercentage;

		contractSunset = block.timestamp + 90 days;
    }

	modifier pruneInvalidTrades() {
		// remove all trades that are expired or invalid due to approval / ownership
		// keeps state clean and allows for faster trade lookup
		// not the most efficient way to do this, but it is a start vis version 0.1

		uint256 length = userTradesMap[msg.sender].length();

		for (uint256 i = 0; i < length; ) {
			bytes32 tradeId = userTradesMap[msg.sender].at(i);

			if (!isTradeValid(tradeId, msg.sender)) {
				cancelTrade(tradeId);
			}

			unchecked {
				++i;
			}
		}
		_;
	}	

    function createTrade(
        address _token,
        address _buyer,
        uint256 _serial,
        uint256 _tinybarPrice,
        uint256 _lazyPrice,
        uint256 _expiryTime,
        bool _associationRequired
    ) external nonReentrant pruneInvalidTrades returns (bytes32 tradeId) {
        if (_expiryTime != 0 && _expiryTime < block.timestamp) {
            revert BadArguments();
        }

		if (_buyer == address(0) && _tinybarPrice == 0 && _lazyPrice == 0) {
			// potentially valid but risks anyone claiming the NFT for free
			revert BadArguments();
		}

        if (_associationRequired) {
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
			if (IERC721(LSH_GEN1).balanceOf(msg.sender) == 0 &&
					 IERC721(LSH_GEN2).balanceOf(msg.sender)== 0 &&
					 lazyDelegateRegistry.getSerialsDelegatedTo(msg.sender, LSH_GEN1).length == 0 &&
					 lazyDelegateRegistry.getSerialsDelegatedTo(msg.sender, LSH_GEN2).length == 0) {
				
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
        userTradesMap[msg.sender].add(tradeId);
        if (_buyer != address(0)) {
            userTradesMap[_buyer].add(tradeId);
        }
		else {
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

    function cancelTrade(bytes32 _tradeId) public {
        Trade memory trade = allTradesMap[_tradeId];

        // user should be able to cancel trade as long as it is their trade
        // does not matter if they own the NFT or not
        if (trade.seller != msg.sender) {
            revert TradeNotFoundOrInvalid();
        }

        removeTradeFromState(_tradeId, trade.buyer, trade.seller, trade.token);

        emit TradeCancelled(msg.sender, trade.token, trade.serial, trade.nonce);
    }

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

	function getTrade(bytes32 _tradeId) external view returns (Trade memory) {
		return allTradesMap[_tradeId];
	}

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

	function getTotalTokens() external view returns (uint256) {
		return tokens.length();
	}

	function isTradeValid(bytes32 _tradeId, address _user) public view returns (bool) {
		Trade memory trade = allTradesMap[_tradeId];

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


    function isTokenAssociated(address _token) external view returns (bool) {
        return tokens.contains(_token);
    }

	function setLazyCostForTrade(uint256 _lazyCostForTrade) external onlyOwner {
		lazyCostForTrade = _lazyCostForTrade;
	}

	function setLazyBurnPercentage(uint256 _lazyBurnPercentage) external onlyOwner {
		lazyBurnPercentage = _lazyBurnPercentage;
	}

	function extendSunset(uint256 _days) external onlyOwner {
		contractSunset += _days * 1 days;
	}

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

	/// @notice Transfer Hbar from the contract to a receiver
	/// @param receiverAddress The address to send the Hbar to
	/// @param amount The amount of Hbar to send
    function transferHbar(address payable receiverAddress, uint256 amount)
        external
        onlyOwner
    {
		if (receiverAddress == address(0) || amount == 0) {
			revert BadArguments();
		}
		Address.sendValue(receiverAddress, amount);
    }

	/// @notice Retrieve Lazy tokens from the contract
	/// @param _receiver The address to send the Lazy tokens to
	/// @param _amount The amount of Lazy tokens to send
	function retrieveLazy(
		address _receiver,
		uint256 _amount
	) external onlyOwner() {
		if (_receiver == address(0) || _amount == 0) {
			revert BadArguments();
		}

		IERC20(lazyToken).transfer(_receiver, _amount);
	}

	 // allows the contract top recieve HBAR
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
