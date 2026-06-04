#!/usr/bin/env node
'use strict';

/**
 * Thin wrapper around the @lazysuperheroes/hedera-verify CLI's `harness`
 * subcommand — kept for this repo's `node scripts/...` convention.
 * Equivalent to `npx hedera-verify harness` (and `yarn verify-harness`).
 *
 * The contract registry is read from verify.config.js in the repo root. Extra
 * args are preserved, e.g.:
 *   node scripts/testing/verifyHarness.js --only LazySecureTrade,LazyGasStation
 *   node scripts/testing/verifyHarness.js LazyRebatePool=0.0.123456
 *
 * For the registry/env-presence view use `npx hedera-verify list`.
 */

process.argv.splice(2, 0, 'harness');
require('@lazysuperheroes/hedera-verify/bin/hedera-verify.js');
