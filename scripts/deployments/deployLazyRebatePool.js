// Deploy LazyRebatePool — Merkle-airdrop primitive that receives a
// slice of every VIPSubscription purchase and pays it out to LSH
// stakers via quarterly per-user allocations.
//
// Constructor args:
//   _lazyToken          — LAZY HTS token address (from LAZY_TOKEN_ID)
//   _signer             — initial signer key (defaults to operator if
//                         REBATE_SIGNER_ID not set; rotate later via
//                         setSigner)
//   _claimWindowSeconds — initial claim window in seconds
//                         (default 365 days)
//
// Post-deploy:
//   - Calls associateLazy() so the contract can hold LAZY (owner-only)
//
// Usage:
//   node scripts/deployments/deployLazyRebatePool.js

const fs = require('fs');
const {
	Client,
	AccountId,
	PrivateKey,
	TokenId,
	ContractFunctionParameters,
} = require('@hashgraph/sdk');
const { ethers } = require('ethers');
const {
	contractDeployFunction,
	contractExecuteFunction,
	readOnlyEVMFromMirrorNode,
} = require('../../utils/solidityHelpers');
const { sleep } = require('../../utils/nodeHelpers');
require('dotenv').config();

const MIRROR_DELAY = Number(process.env.SLEEP_TIME) || 5500;
const DEFAULT_CLAIM_WINDOW_SECONDS = 365 * 24 * 60 * 60;

(async () => {
	const env = (process.env.ENVIRONMENT || 'test').toLowerCase();
	const operatorId = AccountId.fromString(process.env.ACCOUNT_ID);
	const operatorKey = PrivateKey.fromStringED25519(process.env.PRIVATE_KEY);
	const client = env === 'main' ? Client.forMainnet()
		: env === 'preview' ? Client.forPreviewnet()
			: Client.forTestnet();
	client.setOperator(operatorId, operatorKey);

	if (!process.env.LAZY_TOKEN_ID) {
		console.error('Missing LAZY_TOKEN_ID in .env');
		process.exit(1);
	}
	const lazyTokenId = TokenId.fromString(process.env.LAZY_TOKEN_ID);

	// Signer defaults to operator. The signer is the key authorised to
	// publish epoch Merkle roots (settleEpoch). Keep it as a dedicated
	// low-trust ops key in production; operator-default is for testnet
	// dry-runs only.
	const signerId = process.env.REBATE_SIGNER_ID
		? AccountId.fromString(process.env.REBATE_SIGNER_ID)
		: operatorId;
	const signerEvm = '0x' + signerId.toSolidityAddress();

	const claimWindowSeconds = process.env.REBATE_CLAIM_WINDOW_SECONDS
		? Number(process.env.REBATE_CLAIM_WINDOW_SECONDS)
		: DEFAULT_CLAIM_WINDOW_SECONDS;
	if (claimWindowSeconds < 30 * 24 * 60 * 60 || claimWindowSeconds > 1095 * 24 * 60 * 60) {
		console.error(`Claim window ${claimWindowSeconds}s out of bounds [30d, 1095d]`);
		process.exit(1);
	}

	console.log('--- LazyRebatePool deploy ---');
	console.log('Environment:    ', env);
	console.log('Operator:       ', operatorId.toString());
	console.log('LAZY Token:     ', lazyTokenId.toString());
	console.log('Signer (init):  ', signerId.toString(), signerId.equals(operatorId) ? '(operator default — rotate in prod)' : '');
	console.log('Claim window:   ', claimWindowSeconds, 'seconds (', Math.round(claimWindowSeconds / 86400), 'days )');

	const rpJson = JSON.parse(fs.readFileSync(
		'./artifacts/contracts/LazyRebatePool.sol/LazyRebatePool.json', 'utf8',
	));
	const rpIface = new ethers.Interface(rpJson.abi);

	const params = new ContractFunctionParameters()
		.addAddress(lazyTokenId.toSolidityAddress())
		.addAddress(signerEvm)
		.addUint64(claimWindowSeconds);

	const [rpId, rpAddr] = await contractDeployFunction(
		client, rpJson.bytecode, 2_000_000, params,
	);
	console.log(`\nLazyRebatePool deployed: ${rpId.toString()} / ${rpAddr}`);

	await sleep(MIRROR_DELAY);

	// One-shot LAZY association. Owner-only; the contract cannot hold
	// LAZY until this lands.
	console.log('\nAssociating LAZY...');
	const assocResp = await contractExecuteFunction(
		rpId, rpIface, client, 1_500_000,
		'associateLazy', [], 0, true,
	);
	const assocStatus = assocResp?.[0]?.status;
	const assocStatusStr = assocStatus?.toString?.() ?? '';
	const assocErrName = assocStatus?.name;
	if (assocStatusStr !== 'SUCCESS' && assocErrName !== 'AlreadyAssociated') {
		console.error(`associateLazy failed: status=${assocStatusStr} name=${assocErrName ?? 'unknown'}`);
		process.exit(1);
	}
	console.log('associateLazy:', assocStatusStr === 'SUCCESS' ? 'OK' : 'already associated');

	await sleep(MIRROR_DELAY);

	// Verify state landed on mirror
	const mirrorView = async (fcn) => {
		const enc = rpIface.encodeFunctionData(fcn, []);
		const raw = await readOnlyEVMFromMirrorNode(env, rpId, enc, operatorId, false);
		return rpIface.decodeFunctionResult(fcn, raw)[0];
	};

	const associated = await mirrorView('lazyAssociated');
	const onChainSigner = await mirrorView('signer');
	const onChainWindow = await mirrorView('epochClaimWindowSeconds');
	const onChainEpoch = await mirrorView('currentEpoch');

	console.log('\nMirror verification:');
	console.log('  lazyAssociated         =', associated);
	console.log('  signer                 =', onChainSigner);
	console.log('  epochClaimWindowSeconds=', onChainWindow.toString());
	console.log('  currentEpoch           =', onChainEpoch.toString(), '(expect 0)');

	console.log('\nAdd to .env:');
	console.log(`LAZY_REBATE_POOL_CONTRACT_ID=${rpId.toString()}`);
	console.log('\nNext step:');
	console.log('  node scripts/interactions/wireVipRebate.js');
	console.log('  — wires VIPSubscription against this pool with default split (10% rebate, 0% team)');

	process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
