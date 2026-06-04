#!/usr/bin/env node
'use strict';

/**
 * Thin wrapper around the @lazysuperheroes/hedera-verify CLI — kept for this
 * repo's `node scripts/...` convention. Equivalent to
 * `npx hedera-verify <ContractName> <0.0.x|0xaddr> [options]` (and `yarn verify`).
 *
 *   node scripts/deployments/verifyContract.js LazySecureTrade 0.0.9057802
 *   node scripts/deployments/verifyContract.js LAZYTokenCreator 0.0.8986378 \
 *        --source contracts/legacy/LAZYTokenCreator.sol
 *
 * The verification engine lives in the package; run with no args for full help.
 */

require('@lazysuperheroes/hedera-verify/bin/hedera-verify.js');
