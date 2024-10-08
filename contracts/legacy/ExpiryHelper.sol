// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.12 <0.9.0;
pragma experimental ABIEncoderV2;

import { HederaTokenService } from "./HederaTokenService.sol";
import { IHederaTokenService } from "./IHederaTokenService.sol";

abstract contract ExpiryHelper {

    function createAutoRenewExpiry(
        address autoRenewAccount,
        uint32 autoRenewPeriod
    ) internal pure returns (IHederaTokenService.Expiry memory expiry) {
        expiry.autoRenewAccount = autoRenewAccount;
        expiry.autoRenewPeriod = autoRenewPeriod;
    }

    function createSecondExpiry(uint32 second) internal pure returns (IHederaTokenService.Expiry memory expiry) {
        expiry.second = second;
    }
}