// Wire VIPSubscription against the canonical LazyRebatePool.
//
// Sets:
//   setRebatePool(LAZY_REBATE_POOL_CONTRACT_ID)
//   setRebateBps(REBATE_BPS)              — default 1000 (10%)
//   setTeamWallet(TEAM_WALLET_ID)         — defaults to operator if unset
//   setTeamBps(TEAM_BPS)                  — default 0
//
// Requires .env:
//   VIP_SUBSCRIPTION_CONTRACT_ID
//   LAZY_REBATE_POOL_CONTRACT_ID
//
// Optional .env:
//   REBATE_BPS       — owner-tunable rebate %, default 1000 (10%)
//   TEAM_BPS         — owner-tunable team %, default 0
//   TEAM_WALLET_ID   — Hedera account id for the team slice, default operator
//
// Usage:
//   node scripts/interactions/wireVipRebate.js

const fs = require('fs');
const {
	Client,
	AccountId,
	PrivateKey,
	ContractId,
} = require('@hashgraph/sdk');
const { ethers } = require('ethers');
const {
	contractExecuteFunction,
	readOnlyEVMFromMirrorNode,
} = require('../../utils/solidityHelpers');
const { sleep } = require('../../utils/nodeHelpers');
require('dotenv').config();

const MIRROR_DELAY = Number(process.env.SLEEP_TIME) || 5500;
const DEFAULT_REBATE_BPS = 1000;
const DEFAULT_TEAM_BPS = 0;

(async () => {
	const env = (process.env.ENVIRONMENT || 'test').toLowerCase();
	const operatorId = AccountId.fromString(process.env.ACCOUNT_ID);
	const operatorKey = PrivateKey.fromStringED25519(process.env.PRIVATE_KEY);
	const client = env === 'main' ? Client.forMainnet()
		: env === 'preview' ? Client.forPreviewnet()
			: Client.forTestnet();
	client.setOperator(operatorId, operatorKey);

	const requiredKeys = ['VIP_SUBSCRIPTION_CONTRACT_ID', 'LAZY_REBATE_POOL_CONTRACT_ID'];
	const missing = requiredKeys.filter((k) => !process.env[k]);
	if (missing.length) {
		console.error(`Missing required .env keys: ${missing.join(', ')}`);
		process.exit(1);
	}

	const vipId = ContractId.fromString(process.env.VIP_SUBSCRIPTION_CONTRACT_ID);
	const poolId = ContractId.fromString(process.env.LAZY_REBATE_POOL_CONTRACT_ID);
	const teamWalletId = process.env.TEAM_WALLET_ID
		? AccountId.fromString(process.env.TEAM_WALLET_ID)
		: operatorId;
	const rebateBps = process.env.REBATE_BPS !== undefined
		? Number(process.env.REBATE_BPS)
		: DEFAULT_REBATE_BPS;
	const teamBps = process.env.TEAM_BPS !== undefined
		? Number(process.env.TEAM_BPS)
		: DEFAULT_TEAM_BPS;

	if (rebateBps < 0 || rebateBps > 5000) {
		console.error(`REBATE_BPS=${rebateBps} out of bounds [0, 5000]`);
		process.exit(1);
	}
	if (teamBps < 0 || teamBps > 5000) {
		console.error(`TEAM_BPS=${teamBps} out of bounds [0, 5000]`);
		process.exit(1);
	}

	console.log('--- VIP rebate wire-up ---');
	console.log('Environment:    ', env);
	console.log('Operator:       ', operatorId.toString());
	console.log('VIPSubscription:', vipId.toString());
	console.log('LazyRebatePool: ', poolId.toString());
	console.log('Team wallet:    ', teamWalletId.toString(), teamWalletId.equals(operatorId) ? '(operator default)' : '');
	console.log('Rebate BPS:     ', rebateBps, `(${rebateBps / 100}%)`);
	console.log('Team BPS:       ', teamBps, `(${teamBps / 100}%)`);

	const vipJson = JSON.parse(fs.readFileSync(
		'./artifacts/contracts/VIPSubscription.sol/VIPSubscription.json', 'utf8',
	));
	const vipIface = new ethers.Interface(vipJson.abi);

	const poolEvm = '0x' + poolId.toSolidityAddress();
	const teamEvm = '0x' + teamWalletId.toSolidityAddress();

	const send = async (fcn, args) => {
		const resp = await contractExecuteFunction(
			vipId, vipIface, client, 200_000, fcn, args, 0, true,
		);
		const status = resp?.[0]?.status;
		const statusStr = status?.toString?.() ?? '';
		const errName = status?.name;
		if (statusStr !== 'SUCCESS') {
			throw new Error(`${fcn} failed: status=${statusStr} name=${errName ?? 'unknown'}`);
		}
		console.log(`  ${fcn}(${JSON.stringify(args)}) OK`);
	};

	console.log('\nApplying setters...');
	await send('setRebatePool', [poolEvm]);
	await send('setRebateBps', [rebateBps]);
	await send('setTeamWallet', [teamEvm]);
	await send('setTeamBps', [teamBps]);

	await sleep(MIRROR_DELAY);

	// Verify state on mirror.
	const view = async (fcn) => {
		const enc = vipIface.encodeFunctionData(fcn, []);
		const raw = await readOnlyEVMFromMirrorNode(env, vipId, enc, operatorId, false);
		return vipIface.decodeFunctionResult(fcn, raw)[0];
	};

	const onChainPool = await view('rebatePool');
	const onChainRebateBps = Number(await view('rebateBps'));
	const onChainTeam = await view('teamWallet');
	const onChainTeamBps = Number(await view('teamBps'));

	console.log('\nMirror verification:');
	console.log('  rebatePool =', onChainPool, onChainPool.toLowerCase() === poolEvm.toLowerCase() ? 'OK' : 'MISMATCH');
	console.log('  rebateBps  =', onChainRebateBps, onChainRebateBps === rebateBps ? 'OK' : 'MISMATCH');
	console.log('  teamWallet =', onChainTeam, onChainTeam.toLowerCase() === teamEvm.toLowerCase() ? 'OK' : 'MISMATCH');
	console.log('  teamBps    =', onChainTeamBps, onChainTeamBps === teamBps ? 'OK' : 'MISMATCH');

	console.log('\nDone. Next subscription purchase will route LAZY across burn / rebate / team / LGS-treasury.');

	process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
