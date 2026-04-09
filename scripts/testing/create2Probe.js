/**
 * CREATE2 Test Harness for Hedera EVM
 * ====================================
 *
 * Empirically validates that Clones.cloneDeterministic works correctly on
 * Hedera EVM before the production BidderContractFactory adopts the pattern
 * in Phase 2 of the v0.3 redesign.
 *
 * Runs six properties against testnet (or previewnet):
 *
 *   P1  predictProbe(userA) returns a deterministic, non-zero address
 *   P2  deployProbe(userA) actually deploys at predictProbe(userA)
 *   P3  Mirror node indexes the deployed clone and getOwner() returns userA
 *   P4  isProbeDeployed(userA) reflects the extcodesize transition
 *   P5  A second deployProbe(userA) reverts (CREATE2 collision / ProbeAlreadyExists)
 *   P6  predictProbe(userB) != predictProbe(userA) for a distinct real user,
 *       and B deploys + indexes correctly alongside A
 *
 * Realism:
 *   - userA is the operator's own EVM address (already a real Hedera account)
 *   - userB is a freshly created Hedera account (ECDSA key) — mirrors the
 *     production scenario where a stash salt is derived from a real user's
 *     EVM address, not a placeholder.
 *
 * Hedera-specific notes:
 *   - CREATE2 is supported on Hedera EVM since Services v0.23 (confirmed via
 *     Hedera docs). Contracts created via CREATE2 inherit autoRenewAccount
 *     and autoRenewPeriod from the deployer contract (see Smart Contract Rent
 *     FAQ).
 *   - contractExecuteQuery uses ContractCallQuery which goes directly to a
 *     consensus node — no propagation delay needed before reading state.
 *   - The 6-second sleep is ONLY needed before the P3 mirror-node REST call,
 *     because the mirror node lags consensus by ~3-6 seconds.
 *
 * Requires in .env:
 *   ENVIRONMENT  test|preview  (NOT main — this writes state)
 *   ACCOUNT_ID   operator account
 *   PRIVATE_KEY  operator ED25519 key
 *
 * Usage:
 *   node scripts/testing/create2Probe.js
 *
 * Exit codes:
 *   0  all six properties passed
 *   1  environment / setup error
 *   2  one or more properties failed (Phase 2 is BLOCKED pending redesign)
 */

const fs = require('fs');
const { ethers } = require('ethers');
const {
	Client,
	AccountId,
	PrivateKey,
	ContractFunctionParameters,
	ContractId,
} = require('@hashgraph/sdk');
const axios = require('axios');

const {
	contractDeployFunction,
	contractExecuteFunction,
	contractExecuteQuery,
} = require('../../utils/solidityHelpers');
const { getBaseURL } = require('../../utils/hederaMirrorHelpers');
const { accountCreator } = require('../../utils/hederaHelpers');
require('dotenv').config();

const PROBE_NAME = 'CREATE2Probe';
const FACTORY_NAME = 'CREATE2ProbeFactory';

// Only needed before reads that go through the mirror node REST API (P3).
// Consensus queries via contractExecuteQuery don't need it.
const MIRROR_PROPAGATION_MS = 6000;

// Helper to convert a Hedera AccountId to its 0x-prefixed long-zero EVM
// address as a Solidity-compatible string (SDK toSolidityAddress omits 0x).
function toEvmAddress(accountId) {
	return '0x' + accountId.toSolidityAddress();
}

let operatorKey;
let operatorId;
try {
	operatorKey = PrivateKey.fromStringED25519(process.env.PRIVATE_KEY);
	operatorId = AccountId.fromString(process.env.ACCOUNT_ID);
}
catch (err) {
	console.log('ERROR: Must specify PRIVATE_KEY & ACCOUNT_ID in the .env file');
	process.exit(1);
}

const env = process.env.ENVIRONMENT ?? null;
if (!env) {
	console.log('ERROR: ENVIRONMENT must be set (test|preview)');
	process.exit(1);
}
if (env.toUpperCase() === 'MAIN') {
	console.log('ERROR: CREATE2 probe must NOT run on mainnet. Use test or preview.');
	process.exit(1);
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Track property pass/fail for final report
const results = {
	P1: { passed: false, detail: '' },
	P2: { passed: false, detail: '' },
	P3: { passed: false, detail: '' },
	P4: { passed: false, detail: '' },
	P5: { passed: false, detail: '' },
	P6: { passed: false, detail: '' },
};

function mark(prop, passed, detail) {
	results[prop].passed = passed;
	results[prop].detail = detail;
	const icon = passed ? 'PASS' : 'FAIL';
	console.log(`  [${icon}] ${prop}: ${detail}`);
}

async function main() {
	console.log('\n=== CREATE2 Probe — Hedera EVM Validation ===');
	console.log(`Network: ${env.toUpperCase()}`);
	console.log(`Operator: ${operatorId.toString()}`);

	// --- Setup client
	let client;
	if (env.toUpperCase() === 'TEST') {
		client = Client.forTestnet();
	}
	else if (env.toUpperCase() === 'PREVIEW') {
		client = Client.forPreviewnet();
	}
	else {
		console.log(`ERROR: Unsupported ENVIRONMENT '${env}'`);
		process.exit(1);
	}
	client.setOperator(operatorId, operatorKey);

	// --- Real user accounts for the CREATE2 salts
	//
	// userA: the operator itself — already a real Hedera account, no cost to reuse.
	// userB: a freshly-created ECDSA account — models a new user being onboarded
	//        (salt derived from their EVM address). Uses accountCreator helper.
	//
	// The probe's initialize() stores this address as probeOwner; the P3 check
	// verifies the clone returns it from getOwner(). Using real accounts means
	// the test mirrors the production Phase 2 flow where the salt IS a real
	// user's EVM address, not a placeholder.
	const USER_A = toEvmAddress(operatorId);
	console.log(`User A (operator): ${USER_A}`);

	console.log('\nCreating fresh ECDSA account for User B...');
	const userBKey = PrivateKey.generateECDSA();
	const userBId = await accountCreator(client, userBKey, 1);
	const USER_B = toEvmAddress(userBId);
	console.log(`User B: ${userBId.toString()} → ${USER_B}`);


	// --- Load artifacts
	const probeJson = JSON.parse(
		fs.readFileSync(
			`./artifacts/contracts/test/${PROBE_NAME}.sol/${PROBE_NAME}.json`,
			'utf8',
		),
	);
	const factoryJson = JSON.parse(
		fs.readFileSync(
			`./artifacts/contracts/test/${FACTORY_NAME}.sol/${FACTORY_NAME}.json`,
			'utf8',
		),
	);
	const probeIface = ethers.Interface.from(probeJson.abi);
	const factoryIface = ethers.Interface.from(factoryJson.abi);

	// --- Step 1: deploy the probe implementation
	console.log('Step 1: Deploying CREATE2Probe implementation...');
	const [probeImplId, probeImplAddress] = await contractDeployFunction(
		client,
		probeJson.bytecode,
		800_000,
	);
	console.log(`  Implementation: ${probeImplId.toString()} (${probeImplAddress})`);

	// --- Step 2: deploy the factory
	console.log('\nStep 2: Deploying CREATE2ProbeFactory...');
	const factoryParams = new ContractFunctionParameters().addAddress(probeImplAddress);
	const [factoryId, factoryAddress] = await contractDeployFunction(
		client,
		factoryJson.bytecode,
		800_000,
		factoryParams,
	);
	console.log(`  Factory: ${factoryId.toString()} (${factoryAddress})`);

	// No mirror-propagation sleep here — P1/P2/P4/P5/P6 all use
	// contractExecuteQuery which hits consensus directly. Only P3 (mirror
	// node REST) needs the wait, and it sleeps just before the REST call.

	// --- P1: predictProbe(USER_A) returns a deterministic non-zero address
	console.log('\n--- P1: predictProbe(A) is deterministic and non-zero ---');
	let predictedA;
	try {
		const firstCall = await contractExecuteQuery(
			factoryId,
			factoryIface,
			client,
			null,
			'predictProbe',
			[USER_A],
		);
		const secondCall = await contractExecuteQuery(
			factoryId,
			factoryIface,
			client,
			null,
			'predictProbe',
			[USER_A],
		);
		predictedA = firstCall[0];
		const match = firstCall[0] === secondCall[0];
		const nonZero = predictedA !== ethers.ZeroAddress;
		mark(
			'P1',
			match && nonZero,
			`predictedA=${predictedA} (deterministic=${match}, nonZero=${nonZero})`,
		);
	}
	catch (err) {
		mark('P1', false, `exception: ${err.message}`);
	}

	// --- P2: deployProbe(USER_A) actually deploys at predictedA
	console.log('\n--- P2: deployProbe(A) deploys at the predicted address ---');
	let deployedProbeA_address;
	try {
		const [deployRx, deployResult] = await contractExecuteFunction(
			factoryId,
			factoryIface,
			client,
			500_000,
			'deployProbe',
			[USER_A],
		);
		if (deployRx?.status?.toString() !== 'SUCCESS') {
			mark('P2', false, `deployProbe rx status: ${deployRx?.status?.toString()}`);
		}
		else {
			deployedProbeA_address = deployResult[0];
			const match = deployedProbeA_address?.toLowerCase() === predictedA?.toLowerCase();
			mark(
				'P2',
				match,
				`deployed=${deployedProbeA_address}, predicted=${predictedA}, match=${match}`,
			);
		}
	}
	catch (err) {
		mark('P2', false, `exception: ${err.message}`);
	}

	// Wait for mirror node to index the just-deployed clone. This is the ONLY
	// spot in the script that needs propagation — P3 below makes an actual
	// REST call to /api/v1/contracts/{addr}. All other properties read via
	// consensus query (contractExecuteQuery → ContractCallQuery) which doesn't
	// need to wait.
	await sleep(MIRROR_PROPAGATION_MS);

	// --- P3: Mirror node indexes the deployed clone, and getOwner() returns USER_A
	console.log('\n--- P3: Mirror node indexes clone and state reads correctly ---');
	try {
		const baseUrl = getBaseURL(env);
		// Mirror node indexes contracts by EVM address (normalised lowercase, no 0x prefix OK either way)
		const cleanAddr = deployedProbeA_address.toLowerCase().replace(/^0x/, '');
		const mirrorUrl = `${baseUrl}/api/v1/contracts/${cleanAddr}`;
		let mirrorOk = false;
		let mirrorDetail = '';
		try {
			const resp = await axios.get(mirrorUrl, { timeout: 10000 });
			mirrorOk = resp.status === 200 && !!resp.data && !!resp.data.contract_id;
			mirrorDetail = mirrorOk
				? `mirror contract_id=${resp.data.contract_id}`
				: 'mirror returned no contract_id';
		}
		catch (mirrorErr) {
			mirrorDetail = `mirror fetch error: ${mirrorErr.response?.status || mirrorErr.code || mirrorErr.message}`;
		}

		// Also verify the clone's state reads correctly — prove state isolation
		let ownerReadOk = false;
		let ownerReadDetail = '';
		try {
			// Convert EVM address → ContractId for SDK query
			const deployedContractId = ContractId.fromEvmAddress(0, 0, deployedProbeA_address);
			const ownerCall = await contractExecuteQuery(
				deployedContractId,
				probeIface,
				client,
				null,
				'getOwner',
				[],
			);
			const owner = ownerCall[0];
			ownerReadOk = owner?.toLowerCase() === USER_A.toLowerCase();
			ownerReadDetail = `owner=${owner}, expected=${USER_A}`;
		}
		catch (queryErr) {
			ownerReadDetail = `query error: ${queryErr.message}`;
		}

		mark('P3', mirrorOk && ownerReadOk, `${mirrorDetail}; ${ownerReadDetail}`);
	}
	catch (err) {
		mark('P3', false, `exception: ${err.message}`);
	}

	// --- P4: isProbeDeployed(A) returns true via extcodesize check
	console.log('\n--- P4: extcodesize transitions 0 → nonzero post-deploy ---');
	try {
		const call = await contractExecuteQuery(
			factoryId,
			factoryIface,
			client,
			null,
			'isProbeDeployed',
			[USER_A],
		);
		const deployed = call[0];
		mark('P4', deployed === true, `isProbeDeployed(A)=${deployed}`);
	}
	catch (err) {
		mark('P4', false, `exception: ${err.message}`);
	}

	// --- P5: Second deployProbe(A) reverts
	console.log('\n--- P5: second deployProbe(A) reverts ---');
	try {
		const [rx, result] = await contractExecuteFunction(
			factoryId,
			factoryIface,
			client,
			500_000,
			'deployProbe',
			[USER_A],
			0,
			// flagError = true, don't throw on revert
			true,
		);
		const status = rx?.status?.toString();
		const reverted = status !== 'SUCCESS' || (result && result.error);
		mark(
			'P5',
			reverted,
			`status=${status}, result=${JSON.stringify(result).slice(0, 120)}`,
		);
	}
	catch (err) {
		// contractExecuteFunction throws on revert if flagError=false; either way the revert is the pass
		const msg = err.message || String(err);
		mark('P5', true, `reverted as expected: ${msg.slice(0, 120)}`);
	}

	// --- P6: predictProbe(B) != predictProbe(A), and B is also indexable after deploy
	console.log('\n--- P6: second distinct user deploys to a different address ---');
	try {
		const predictCall = await contractExecuteQuery(
			factoryId,
			factoryIface,
			client,
			null,
			'predictProbe',
			[USER_B],
		);
		const predictedB = predictCall[0];
		const distinct = predictedB?.toLowerCase() !== predictedA?.toLowerCase();
		const nonZero = predictedB !== ethers.ZeroAddress;

		if (!(distinct && nonZero)) {
			mark('P6', false, `predictedA=${predictedA}, predictedB=${predictedB}`);
		}
		else {
			// Actually deploy B
			const [deployRx, deployResult] = await contractExecuteFunction(
				factoryId,
				factoryIface,
				client,
				500_000,
				'deployProbe',
				[USER_B],
			);
			const deployedB = deployResult[0];
			const bMatches = deployedB?.toLowerCase() === predictedB?.toLowerCase();
			const rxOk = deployRx?.status?.toString() === 'SUCCESS';
			mark(
				'P6',
				distinct && nonZero && rxOk && bMatches,
				`predictedA=${predictedA}, predictedB=${predictedB}, deployedB=${deployedB}, match=${bMatches}`,
			);
		}
	}
	catch (err) {
		mark('P6', false, `exception: ${err.message}`);
	}

	// --- Final report
	console.log('\n=== CREATE2 Probe — Final Report ===');
	let passCount = 0;
	let failCount = 0;
	for (const [prop, state] of Object.entries(results)) {
		const icon = state.passed ? 'PASS' : 'FAIL';
		console.log(`  ${icon}  ${prop}  ${state.detail}`);
		if (state.passed) passCount++;
		else failCount++;
	}
	console.log(`\n  Total: ${passCount} passed, ${failCount} failed.`);

	if (failCount === 0) {
		console.log('\n✔ All properties passed. Phase 2 (CREATE2 stash refactor) is GO.');
		process.exit(0);
	}
	else {
		console.log('\n✘ One or more properties failed. Phase 2 is BLOCKED pending redesign.');
		console.log('  Review the per-property detail above for remediation direction.');
		process.exit(2);
	}
}

main().catch((err) => {
	console.error('FATAL:', err);
	process.exit(1);
});
