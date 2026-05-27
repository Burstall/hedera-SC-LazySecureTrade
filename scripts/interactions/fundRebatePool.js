// Fund the canonical LazyRebatePool with LAZY base units via
// LAZYTokenCreator.transferHTS (operator-owner-only path).
//
// In production the pool fills organically — every VIPSubscription
// purchase routes a configurable slice of LAZY into it via the
// LazyGasStation payoutLazy hop. This script is the manual top-up
// path for:
//   - Testnet first-epoch dry-runs (no real subscriptions yet)
//   - Edge cases like emergency recapitalization after a recycle
//
// Requires .env:
//   LAZY_SCT_CONTRACT_ID         — LAZYTokenCreator (operator must be its owner)
//   LAZY_TOKEN_ID                — the LAZY HTS token
//   LAZY_REBATE_POOL_CONTRACT_ID — destination
//
// Usage:
//   node scripts/interactions/fundRebatePool.js --amount=<LAZY-base-units>

const fs = require('fs');
const {
	Client,
	AccountId,
	PrivateKey,
	ContractId,
	TokenId,
} = require('@hashgraph/sdk');
const { ethers } = require('ethers');
const {
	contractExecuteFunction,
} = require('../../utils/solidityHelpers');
const { sleep } = require('../../utils/nodeHelpers');
const { checkMirrorBalance } = require('../../utils/hederaMirrorHelpers');
require('dotenv').config();

const MIRROR_DELAY = Number(process.env.SLEEP_TIME) || 5500;

(async () => {
	const args = {};
	for (const a of process.argv.slice(2)) {
		const m = a.match(/^--([^=]+)=(.*)$/);
		if (m) args[m[1]] = m[2];
	}
	const amount = Number(args.amount);
	if (!amount || amount <= 0) {
		console.error('Usage: --amount=<LAZY base units>');
		process.exit(1);
	}

	const env = (process.env.ENVIRONMENT || 'test').toLowerCase();
	const operatorId = AccountId.fromString(process.env.ACCOUNT_ID);
	const operatorKey = PrivateKey.fromStringED25519(process.env.PRIVATE_KEY);
	const client = env === 'main' ? Client.forMainnet()
		: env === 'preview' ? Client.forPreviewnet()
			: Client.forTestnet();
	client.setOperator(operatorId, operatorKey);

	for (const k of ['LAZY_SCT_CONTRACT_ID', 'LAZY_TOKEN_ID', 'LAZY_REBATE_POOL_CONTRACT_ID']) {
		if (!process.env[k]) {
			console.error(`Missing ${k} in .env`);
			process.exit(1);
		}
	}

	const lazyCreatorId = ContractId.fromString(process.env.LAZY_SCT_CONTRACT_ID);
	const lazyTokenId = TokenId.fromString(process.env.LAZY_TOKEN_ID);
	const poolId = ContractId.fromString(process.env.LAZY_REBATE_POOL_CONTRACT_ID);

	console.log('--- LazyRebatePool fund ---');
	console.log('Environment:    ', env);
	console.log('Operator:       ', operatorId.toString());
	console.log('LAZYTokenCreator', lazyCreatorId.toString());
	console.log('LAZY Token:     ', lazyTokenId.toString());
	console.log('Pool (dest):    ', poolId.toString());
	console.log('Amount:         ', amount, 'LAZY base units');

	const lazyCreatorJson = JSON.parse(fs.readFileSync(
		'./artifacts/contracts/legacy/LAZYTokenCreator.sol/LAZYTokenCreator.json', 'utf8',
	));
	const iface = new ethers.Interface(lazyCreatorJson.abi);

	const poolEvm = '0x' + poolId.toSolidityAddress();
	const tokenEvm = lazyTokenId.toSolidityAddress();

	const preBal = await checkMirrorBalance(env, poolId, lazyTokenId);
	console.log(`Pre-fund pool LAZY balance: ${preBal ?? 'null (not yet visible / not associated)'}`);

	const resp = await contractExecuteFunction(
		lazyCreatorId, iface, client, 400_000,
		'transferHTS', [tokenEvm, poolEvm, amount], 0, true,
	);
	const status = resp?.[0]?.status;
	const statusStr = status?.toString?.() ?? '';
	const errName = status?.name;
	if (statusStr !== 'SUCCESS') {
		throw new Error(`transferHTS failed: status=${statusStr} name=${errName ?? 'unknown'}`);
	}
	console.log('transferHTS: OK');

	await sleep(MIRROR_DELAY);

	const postBal = await checkMirrorBalance(env, poolId, lazyTokenId);
	console.log(`Post-fund pool LAZY balance: ${postBal}`);

	if (postBal === null || Number(postBal) < amount) {
		console.warn('Mirror may still be lagging; verify manually if downstream calls fail.');
	}

	process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
