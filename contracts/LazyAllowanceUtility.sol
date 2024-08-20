// SPDX-License-Identifier: GPL-3.0
pragma solidity >=0.8.0 <0.9.0;

import { ILazyAllowanceUtility } from "./interfaces/ILazyAllowanceUtility.sol";

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Address } from "@openzeppelin/contracts/utils/Address.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract LazyAllowanceUtility is Ownable, ILazyAllowanceUtility {
	
	// Use to check the live allowance of a FT on Hedera
	/// @param _token address in EVM format of the token
	/// @param _owner address in EVM format of the owner of the token
	/// @param _spender address in EVM format of the spender of the token
	/// @return allowance number of tokens allowed to be spent
	function checkLiveAllowance(address _token, address _owner, address _spender) public view returns (uint256 allowance) {
		allowance = IERC20(_token).allowance(_owner, _spender);
	}

	// Use to check the ALL approval for an NFT on Hedera
	/// @param _token address in EVM format of the NFT token
	/// @param _owner address in EVM format of the owner of the token
	/// @param _spender address in EVM format of the spender of the token
	/// @return isApproved boolean
	function isApprovedForAllSerials(address _token, address _owner, address _spender) public view returns (bool isApproved) {
		isApproved = IERC721(_token).isApprovedForAll(_owner, _spender);
	}

	// Use to check the live allowance of multiple FTs on Hedera
	/// @param _token array of addresses in EVM format of the tokens
	/// @param _owner array of addresses in EVM format of the owners of the tokens
	/// @param _spender array of addresses in EVM format of the spenders of the tokens
	/// @return allowances array of numbers of tokens allowed to be spent
	function checkLiveAllowances(address[] memory _token, address[] memory _owner, address[] memory _spender) public view returns (uint256[] memory allowances) {
		if (_token.length != _owner.length || _owner.length != _spender.length) {
			revert InvalidArguments();
		}
		allowances = new uint256[](_token.length);
		for (uint256 i = 0; i < _token.length; i++) {
			allowances[i] = checkLiveAllowance(_token[i], _owner[i], _spender[i]);
		}
	}
	
	// Use to check the ALL approval for multiple NFTs on Hedera
	/// @param _token array of addresses in EVM format of the NFT tokens
	/// @param _owner array of addresses in EVM format of the owners of the tokens
	/// @param _spender array of addresses in EVM format of the spenders of the tokens
	/// @return approvals array of booleans
	function checkTokensApprovedForAllSerial(address[] memory _token, address[] memory _owner, address[] memory _spender) public view returns (bool[] memory approvals) {
		if (_token.length != _owner.length || _owner.length != _spender.length) {
			revert InvalidArguments();
		}
		approvals = new bool[](_token.length);
		for (uint256 i = 0; i < _token.length; i++) {
			approvals[i] = isApprovedForAllSerials(_token[i], _owner[i], _spender[i]);
		}
	}

	// Use to check the approved address of an NFT on Hedera
	/// @param _token address in EVM format of the NFT token
	/// @param _serial serial number of the NFT token
	/// @return approvedAddress address in EVM format of the approved address
	function checkApprovedAddress(address _token, uint256 _serial) public view returns (address approvedAddress) {
		approvedAddress = IERC721(_token).getApproved(_serial);
	}

	// Use to check the approved address of multiple NFTs on Hedera
	/// @param _tokens array of addresses in EVM format of the NFT tokens
	/// @param _serials array of serial numbers of the NFT tokens
	/// @return approvedAddresses array of addresses in EVM format of the approved addresses
	function checkApprovedAddresses(address[] memory _tokens, uint256[] memory _serials) public view returns (address[] memory approvedAddresses) {
		if (_tokens.length != _serials.length) {
			revert InvalidArguments();
		}
		approvedAddresses = new address[](_tokens.length);
		for (uint256 i = 0; i < _tokens.length; i++) {
			approvedAddresses[i] = checkApprovedAddress(_tokens[i], _serials[i]);
		}
	}

	/// @param receiverAddress address in EVM fomat of the reciever of the token
    /// @param amount number of tokens to send (in tinybar i.e. adjusted for decimal)
    function transferHbar(address payable receiverAddress, uint256 amount)
        external
        onlyOwner
    {
		if (receiverAddress == address(0) || amount == 0) {
			revert InvalidArguments();
		}

		Address.sendValue(receiverAddress, amount);

		emit LazyAllowanceUtilityEvent(
			receiverAddress, 
			amount,
			"Hbar Transfer Complete"
		);
    }

	receive() external payable {
        emit LazyAllowanceUtilityEvent(
            msg.sender,
            msg.value,
            "Recieved Hbar"
        );
    }

    fallback() external payable {
        emit LazyAllowanceUtilityEvent(msg.sender, msg.value, "Fallback Called");
    }
}