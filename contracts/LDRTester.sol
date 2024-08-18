// SPDX-License-Identifier: MIT
pragma solidity >=0.8.12 <0.9.0;

import { ILazyDelegateRegistry } from "./interfaces/ILazyDelegateRegistry.sol";

/**
 * Shell contract to test the LazyDelegateRegistry contract from EVM side
 *
 * @title LDRTester
 * @dev This contract is used for testing purposes only
 */ 

contract LDRTester {
	ILazyDelegateRegistry public lazyDelegateRegistry;

	constructor(address _lazyDelegateRegistry) {
		lazyDelegateRegistry = ILazyDelegateRegistry(_lazyDelegateRegistry);
	}

	function updateLDRContractAddress(address _lazyDelegateRegistry) external {
		lazyDelegateRegistry = ILazyDelegateRegistry(_lazyDelegateRegistry);
	}

	function getDelegatedWallet(address _delegateWallet) external view returns (address) {
		address claimingWallet = msg.sender;
		
		if (_delegateWallet != address(0) && _delegateWallet != msg.sender) {
			claimingWallet = lazyDelegateRegistry.getDelegateWallet(_delegateWallet);
		}

		return claimingWallet;
	}

	function checkDelegatedToken(address _token, uint256 _serial) external view returns (bool) {
		return lazyDelegateRegistry.checkDelegateToken(msg.sender, _token, _serial);
	}
}