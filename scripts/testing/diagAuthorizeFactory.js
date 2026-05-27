// Diagnose AE0.1 failure: query LST's authorization state for the
// cached BCF. Reports the three things we need to decide the fix:
//   1. authorizedFactories[bcf] — current authorization bit
//   2. factoryAuthorityEverGranted — whether instant grant is still
//      available (false → next call is INSTANT; true → 48h timelock)
//   3. pendingFactoryAuthEta[bcf] — if a timelock is already queued

const fs = require('fs');
const {
	Client,
	AccountId,
	PrivateKey,
	ContractId,
} = require('@hashgraph/sdk');
const { ethers } = require('ethers');
const { readOnlyEVMFromMirrorNode } = require('../../utils/solidityHelpers');
require('dotenv').config();

(async () => {
	const env = (process.env.ENVIRONMENT || 'test').toLowerCase();
	const operatorId = AccountId.fromString(process.env.ACCOUNT_ID);
	const operatorKey = PrivateKey.fromStringED25519(process.env.PRIVATE_KEY);
	const client = env === 'main' ? Client.forMainnet()
		: env === 'preview' ? Client.forPreviewnet()
			: Client.forTestnet();
	client.setOperator(operatorId, operatorKey);

	const lstId = ContractId.fromString(process.env.LAZY_SECURE_TRADE_CONTRACT_ID);
	const bcfId = ContractId.fromString(
		process.env.BIDDER_FACTORY_CONTRACT_ID || process.env.BCF_CONTRACT_ID,
	);
	const bcfEvm = '0x' + bcfId.toSolidityAddress();

	const lstJson = JSON.parse(fs.readFileSync(
		'./artifacts/contracts/LazySecureTrade.sol/LazySecureTrade.json', 'utf8',
	));
	const lstIface = new ethers.Interface(lstJson.abi);

	async function call(fcn, params = []) {
		const data = lstIface.encodeFunctionData(fcn, params);
		const raw = await readOnlyEVMFromMirrorNode(env, lstId, data, operatorId, false);
		return lstIface.decodeFunctionResult(fcn, raw)[0];
	}

	console.log('=== LST authorization state diagnostic ===');
	console.log('LST:', lstId.toString(), '/', '0x' + lstId.toSolidityAddress());
	console.log('BCF:', bcfId.toString(), '/', bcfEvm);
	console.log('Operator:', operatorId.toString());
	console.log();

	const authNow = await call('authorizedFactories', [bcfEvm]);
	console.log('authorizedFactories[BCF]:', authNow);

	const pendingEta = await call('pendingFactoryAuthEta', [bcfEvm]);
	const pendingEtaNum = Number(pendingEta);
	console.log('pendingFactoryAuthEta[BCF]:', pendingEtaNum,
		pendingEtaNum === 0 ? '(no pending)' :
			`(unlocks at ${new Date(pendingEtaNum * 1000).toISOString()})`);

	const owner = await call('owner');
	console.log('LST owner:', owner);
	const operatorEvm = '0x' + operatorId.toSolidityAddress();
	console.log('Operator EVM:', operatorEvm);
	const isOperatorOwner = owner.toLowerCase() === operatorEvm.toLowerCase();
	console.log('Operator IS owner?', isOperatorOwner);

	// We can't read `factoryAuthorityEverGranted` directly (internal).
	// Inferred from observable state: if `authorizedFactories[BCF]` is
	// false AND no pending grant, the next `authorizeFactory(bcf,true)`
	// call by the owner either: applies INSTANTLY (if everGranted was
	// false) OR queues a 48h pending grant. The receipt tells us which
	// via event topics.

	console.log('\n=== Decision tree ===');
	if (authNow) {
		console.log('✓ BCF already authorized. AE0.1 should pass on re-run.');
	}
	else if (pendingEtaNum > 0) {
		if (pendingEtaNum * 1000 <= Date.now()) {
			console.log('▶ Pending grant is past ETA. Anyone can call:');
			console.log(`   executeFactoryAuthorization("${bcfEvm}")`);
		}
		else {
			const remaining = Math.ceil((pendingEtaNum * 1000 - Date.now()) / 1000);
			console.log(`⏳ Pending grant — ${remaining}s (~${(remaining/3600).toFixed(1)}h) remaining.`);
		}
	}
	else if (!isOperatorOwner) {
		console.log('▶ Operator is NOT the LST owner. Cannot self-authorize.');
		console.log(`  Owner is ${owner}. Coordinate with the owner key holder.`);
	}
	else {
		console.log('▶ No pending grant. Owner (=operator) can attempt authorizeFactory.');
		console.log('  If `factoryAuthorityEverGranted` is false → grant applies INSTANTLY.');
		console.log('  If true → 48h pending grant queues (must wait + execute).');
		console.log(`\n  Next step: call authorizeFactory("${bcfEvm}", true) as operator,`);
		console.log('  then re-run this diagnostic to see which branch fired.');
	}
	process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
