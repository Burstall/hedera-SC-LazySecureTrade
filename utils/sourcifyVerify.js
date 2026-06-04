'use strict';

/**
 * The Sourcify verification engine now lives in the standalone package
 * @lazysuperheroes/hedera-verify (single source of truth, shared across repos).
 *
 * This file is kept as a thin re-export so existing imports
 * (`require('../../utils/sourcifyVerify')`) — e.g. the VERIFY_ON_DEPLOY hooks in
 * the deploy scripts — keep working unchanged.
 *
 * Prefer importing the package directly in new code:
 *   const { verifyContract } = require('@lazysuperheroes/hedera-verify');
 */

module.exports = require('@lazysuperheroes/hedera-verify');
