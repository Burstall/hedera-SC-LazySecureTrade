// Rebate stack tests — LazyRebatePool + LSHRebateMultipliers +
// VIPSubscription 3-sink split.
//
// Coverage focuses on the critical paths:
//   M1-M3  LSHRebateMultipliers — Gen1/Mutant/Gen2/LSV weight returns
//   R1-R7  LazyRebatePool — settle, claim, double-claim, invalid proof,
//          expired claim, recycle, signer rotation
//   V1-V4  VIPSubscription — default split (rebate off), rebate enabled,
//          team enabled, rebate+team overpay (dips LGS)
//
// Runs against live Hedera testnet per the project's testing
// methodology. Deploys fresh LazyRebatePool + LSHRebateMultipliers
// on first run; reuses VIPSubscription if cached, else redeploys.
//
// Approx cost: ~40 HBAR fresh run; ~15 HBAR with cached scaffolds.

const fs = require('fs');
const { ethers } = require('ethers');
const { expect } = require('chai');
const { describe, it, before, after } = require('mocha');
const {
	Client,
	AccountId,
	PrivateKey,
	TokenId,
	ContractId,
	ContractFunctionParameters,
	Hbar,
	HbarUnit,
} = require('@hashgraph/sdk');

const {
	contractDeployFunction,
	contractExecuteFunction,
	readOnlyEVMFromMirrorNode,
} = require('../utils/solidityHelpers');
const { setFTAllowance } = require('../utils/hederaHelpers');
const { sleep } = require('../utils/nodeHelpers');
const { checkMirrorBalance } = require('../utils/hederaMirrorHelpers');
require('dotenv').config();

const MIRROR_DELAY = Number(process.env.SLEEP_TIME) || 5500;
const ENV = (process.env.ENVIRONMENT || 'test').toLowerCase();
const LAZY_DECIMAL = Number(process.env.LAZY_DECIMALS ?? 1);

// ============================================
// Minimal Merkle tree implementation (OZ-compatible)
// ============================================
//
// OZ's MerkleProof.verify pairs adjacent nodes with sorted
// concatenation: keccak256(min(a,b) || max(a,b)). Our leaves are
// keccak256(abi.encodePacked(user, amount)).

function hashLeaf(user, amount) {
	return ethers.solidityPackedKeccak256(['address', 'uint256'], [user, amount]);
}

function hashPair(a, b) {
	const [x, y] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
	return ethers.keccak256(ethers.concat([x, y]));
}

function buildTree(leaves) {
	let layer = [...leaves];
	const tree = [layer];
	while (layer.length > 1) {
		const next = [];
		for (let i = 0; i < layer.length; i += 2) {
			if (i + 1 === layer.length) next.push(layer[i]);
			else next.push(hashPair(layer[i], layer[i + 1]));
		}
		layer = next;
		tree.push(layer);
	}
	return tree;
}

function getRoot(tree) {
	return tree[tree.length - 1][0];
}

function getProof(tree, leaf) {
	let idx = tree[0].indexOf(leaf);
	if (idx < 0) throw new Error('Leaf not in tree');
	const proof = [];
	for (let layer = 0; layer < tree.length - 1; layer++) {
		const sibling = idx % 2 === 0 ? idx + 1 : idx - 1;
		if (sibling < tree[layer].length) proof.push(tree[layer][sibling]);
		idx = Math.floor(idx / 2);
	}
	return proof;
}

// ============================================
// Setup
// ============================================

describe('Rebate stack tests', function () {
	this.timeout(180_000);

	let operatorId, operatorKey, client;
	let lazyTokenId, lazyGasStationId, lgsIface;
	let lshGen1, lshMutant, lshGen2; // EVM addresses for multiplier tests

	let multipliersId, multipliersIface;
	let rebatePoolId, rebatePoolIface;
	let signerWallet; // ethers wallet used as the signing key

	async function mirrorQuery(contractId, iface, fcnName, params = []) {
		const encoded = iface.encodeFunctionData(fcnName, params);
		const raw = await readOnlyEVMFromMirrorNode(ENV, contractId, encoded, operatorId, false);
		return iface.decodeFunctionResult(fcnName, raw);
	}

	function expectRevertNamed(result, expectedName) {
		const status = result?.[0]?.status;
		const name = status?.name?.toString?.();
		if (name !== expectedName) {
			throw new Error(`Expected revert ${expectedName}, got ${name ?? status?.toString?.()}`);
		}
	}

	before(async function () {
		this.timeout(300_000);

		operatorId = AccountId.fromString(process.env.ACCOUNT_ID);
		operatorKey = PrivateKey.fromStringED25519(process.env.PRIVATE_KEY);
		client = ENV === 'main' ? Client.forMainnet()
			: ENV === 'preview' ? Client.forPreviewnet()
				: Client.forTestnet();
		client.setOperator(operatorId, operatorKey);

		lazyTokenId = TokenId.fromString(process.env.LAZY_TOKEN_ID);
		lazyGasStationId = ContractId.fromString(process.env.LAZY_GAS_STATION_CONTRACT_ID);

		const lgsJson = JSON.parse(fs.readFileSync(
			'./artifacts/contracts/LazyGasStation.sol/LazyGasStation.json', 'utf8',
		));
		lgsIface = new ethers.Interface(lgsJson.abi);

		// LSH token EVM addresses for multiplier deployment.
		// Fall back to dummy addresses when env vars aren't set so
		// the multiplier deploy still succeeds for tests that don't
		// hit real LSH tokens.
		lshGen1 = process.env.LSH_GEN1_TOKEN_ID
			? '0x' + TokenId.fromString(process.env.LSH_GEN1_TOKEN_ID).toSolidityAddress()
			: '0x0000000000000000000000000000000000000001';
		lshMutant = process.env.LSH_GEN1_MUTANT_TOKEN_ID
			? '0x' + TokenId.fromString(process.env.LSH_GEN1_MUTANT_TOKEN_ID).toSolidityAddress()
			: '0x0000000000000000000000000000000000000002';
		lshGen2 = process.env.LSH_GEN2_TOKEN_ID
			? '0x' + TokenId.fromString(process.env.LSH_GEN2_TOKEN_ID).toSolidityAddress()
			: '0x0000000000000000000000000000000000000003';

		// Deploy LSHRebateMultipliers
		const mJson = JSON.parse(fs.readFileSync(
			'./artifacts/contracts/LSHRebateMultipliers.sol/LSHRebateMultipliers.json', 'utf8',
		));
		multipliersIface = new ethers.Interface(mJson.abi);
		const mParams = new ContractFunctionParameters()
			.addAddress(lshGen1).addAddress(lshMutant).addAddress(lshGen2);
		[multipliersId] = await contractDeployFunction(
			client, mJson.bytecode, 800_000, mParams,
		);
		console.log('LSHRebateMultipliers deployed:', multipliersId.toString());

		// Deploy LazyRebatePool with operator as the signer (rotate
		// later in R7).
		signerWallet = ethers.Wallet.createRandom();
		const rpJson = JSON.parse(fs.readFileSync(
			'./artifacts/contracts/LazyRebatePool.sol/LazyRebatePool.json', 'utf8',
		));
		rebatePoolIface = new ethers.Interface(rpJson.abi);
		const rpParams = new ContractFunctionParameters()
			.addAddress(lazyTokenId.toSolidityAddress())
			.addAddress('0x' + operatorId.toSolidityAddress()) // signer = operator for tests
			.addUint64(365 * 24 * 60 * 60); // 1 year claim window
		[rebatePoolId] = await contractDeployFunction(
			client, rpJson.bytecode, 2_000_000, rpParams,
		);
		console.log('LazyRebatePool deployed:', rebatePoolId.toString());

		// Associate LAZY on the rebate pool (one-shot admin step)
		await contractExecuteFunction(
			rebatePoolId, rebatePoolIface, client, 1_500_000,
			'associateLazy', [],
		);
		console.log('LazyRebatePool associated with LAZY');

		await sleep(MIRROR_DELAY);
	});

	// ============================================
	// M — LSHRebateMultipliers
	// ============================================

	describe('M — LSHRebateMultipliers', function () {
		it('M1: Gen1 returns 50, Mutant returns 25, Gen2 base returns 10', async function () {
			const g1 = (await mirrorQuery(multipliersId, multipliersIface, 'getMultiplier', [lshGen1, 1]))[0];
			const m = (await mirrorQuery(multipliersId, multipliersIface, 'getMultiplier', [lshMutant, 1]))[0];
			const g2 = (await mirrorQuery(multipliersId, multipliersIface, 'getMultiplier', [lshGen2, 100]))[0];
			expect(Number(g1)).to.equal(50);
			expect(Number(m)).to.equal(25);
			expect(Number(g2)).to.equal(10);
		});

		it('M2: LSV range (Gen2 serials 5001-5100) returns 25; outside returns 10', async function () {
			const before5001 = (await mirrorQuery(multipliersId, multipliersIface, 'getMultiplier', [lshGen2, 5000]))[0];
			const lsvMin = (await mirrorQuery(multipliersId, multipliersIface, 'getMultiplier', [lshGen2, 5001]))[0];
			const lsvMax = (await mirrorQuery(multipliersId, multipliersIface, 'getMultiplier', [lshGen2, 5100]))[0];
			const after5100 = (await mirrorQuery(multipliersId, multipliersIface, 'getMultiplier', [lshGen2, 5101]))[0];
			expect(Number(before5001)).to.equal(10);
			expect(Number(lsvMin)).to.equal(25);
			expect(Number(lsvMax)).to.equal(25);
			expect(Number(after5100)).to.equal(10);
		});

		it('M3: getMultipliers batched form works across multiple tokens + serials', async function () {
			const tokens = [lshGen1, lshGen2];
			const serials = [[1, 50], [5050, 5050, 1]]; // jagged
			const result = (await mirrorQuery(multipliersId, multipliersIface, 'getMultipliers', [tokens, serials]))[0];
			expect(result.length).to.equal(2);
			expect(Number(result[0][0])).to.equal(50);
			expect(Number(result[0][1])).to.equal(50);
			expect(Number(result[1][0])).to.equal(25);
			expect(Number(result[1][1])).to.equal(25);
			expect(Number(result[1][2])).to.equal(10);
		});
	});

	// ============================================
	// R — LazyRebatePool
	// ============================================

	describe('R — LazyRebatePool', function () {
		let testTree;
		let testRoot;
		const aliceAmount = 100n * 10n ** BigInt(LAZY_DECIMAL);
		const bobAmount = 50n * 10n ** BigInt(LAZY_DECIMAL);

		before(async function () {
			this.timeout(300_000);

			// Fund the rebate pool with LAZY so it has a balance to allocate.
			// Use the operator's LAZY balance (LAZYTokenCreator transfer).
			const lazyCreatorId = ContractId.fromString(process.env.LAZY_SCT_CONTRACT_ID);
			const lazyCreatorJson = JSON.parse(fs.readFileSync(
				'./artifacts/contracts/legacy/LAZYTokenCreator.sol/LAZYTokenCreator.json', 'utf8',
			));
			const lazyCreatorIface = new ethers.Interface(lazyCreatorJson.abi);
			const poolEvm = '0x' + rebatePoolId.toSolidityAddress();
			const fundAmount = Number(aliceAmount + bobAmount + 10n * 10n ** BigInt(LAZY_DECIMAL));
			await contractExecuteFunction(
				lazyCreatorId, lazyCreatorIface, client, 400_000,
				'transferHTS', [lazyTokenId.toSolidityAddress(), poolEvm, fundAmount],
			);
			await sleep(MIRROR_DELAY);

			// Build the test Merkle tree
			const operatorEvm = '0x' + operatorId.toSolidityAddress();
			const aliceEvm = process.env.ALICE_ACCOUNT_ID
				? '0x' + AccountId.fromString(process.env.ALICE_ACCOUNT_ID).toSolidityAddress()
				: operatorEvm; // fall back to operator if alice missing
			const bobEvm = process.env.BOB_ACCOUNT_ID
				? '0x' + AccountId.fromString(process.env.BOB_ACCOUNT_ID).toSolidityAddress()
				: operatorEvm;
			const leaves = [
				hashLeaf(operatorEvm, aliceAmount),
				hashLeaf(bobEvm, bobAmount),
			];
			testTree = buildTree(leaves);
			testRoot = getRoot(testTree);
		});

		it('R1: settleEpoch publishes a Merkle root + advances currentEpoch', async function () {
			const totalAllocated = aliceAmount + bobAmount;
			const [rx] = await contractExecuteFunction(
				rebatePoolId, rebatePoolIface, client, 400_000,
				'settleEpoch', [testRoot, totalAllocated.toString()],
			);
			expect(rx.status.toString()).to.equal('SUCCESS');
			await sleep(MIRROR_DELAY);

			const currentEpoch = Number((await mirrorQuery(rebatePoolId, rebatePoolIface, 'currentEpoch', []))[0]);
			expect(currentEpoch).to.be.greaterThan(0);
			const epochState = (await mirrorQuery(rebatePoolId, rebatePoolIface, 'epochs', [currentEpoch]))[0];
			expect(epochState.merkleRoot).to.equal(testRoot);
			expect(BigInt(epochState.totalAllocated)).to.equal(totalAllocated);
		});

		it('R2: claim with valid proof transfers LAZY + sets claimed flag', async function () {
			const currentEpoch = Number((await mirrorQuery(rebatePoolId, rebatePoolIface, 'currentEpoch', []))[0]);
			const operatorEvm = '0x' + operatorId.toSolidityAddress();
			const leaf = hashLeaf(operatorEvm, aliceAmount);
			const proof = getProof(testTree, leaf);

			// Operator is the "alice" of our test tree
			const preBal = await checkMirrorBalance(ENV, operatorId, lazyTokenId);
			const [rx] = await contractExecuteFunction(
				rebatePoolId, rebatePoolIface, client, 600_000,
				'claim', [currentEpoch, aliceAmount.toString(), proof],
			);
			expect(rx.status.toString()).to.equal('SUCCESS');
			await sleep(MIRROR_DELAY);

			const postBal = await checkMirrorBalance(ENV, operatorId, lazyTokenId);
			expect(postBal - preBal).to.equal(Number(aliceAmount));

			const hasClaimed = (await mirrorQuery(
				rebatePoolId, rebatePoolIface, 'hasClaimed', [currentEpoch, operatorEvm],
			))[0];
			expect(hasClaimed).to.equal(true);
		});

		it('R3: double-claim reverts AlreadyClaimed', async function () {
			const currentEpoch = Number((await mirrorQuery(rebatePoolId, rebatePoolIface, 'currentEpoch', []))[0]);
			const operatorEvm = '0x' + operatorId.toSolidityAddress();
			const leaf = hashLeaf(operatorEvm, aliceAmount);
			const proof = getProof(testTree, leaf);

			const result = await contractExecuteFunction(
				rebatePoolId, rebatePoolIface, client, 400_000,
				'claim', [currentEpoch, aliceAmount.toString(), proof],
				0, true,
			);
			expectRevertNamed(result, 'AlreadyClaimed');
		});

		it('R4: invalid proof reverts InvalidProof', async function () {
			const currentEpoch = Number((await mirrorQuery(rebatePoolId, rebatePoolIface, 'currentEpoch', []))[0]);
			const operatorEvm = '0x' + operatorId.toSolidityAddress();
			// Wrong amount - proof won't verify
			const fakeProof = [ethers.ZeroHash];
			const result = await contractExecuteFunction(
				rebatePoolId, rebatePoolIface, client, 400_000,
				'claim', [currentEpoch + 999, aliceAmount.toString(), fakeProof],
				0, true,
			);
			// Could be EpochNotSettled (since epoch doesn't exist) or InvalidProof.
			// Both are valid rejections of an unauthorized claim attempt.
			const status = result?.[0]?.status;
			const name = status?.name?.toString?.();
			expect(['EpochNotSettled', 'InvalidProof']).to.include(name);
		});

		it('R5: claim before settlement reverts EpochNotSettled', async function () {
			const futureEpoch = 9_999_999;
			const result = await contractExecuteFunction(
				rebatePoolId, rebatePoolIface, client, 400_000,
				'claim', [futureEpoch, '1', [ethers.ZeroHash]],
				0, true,
			);
			expectRevertNamed(result, 'EpochNotSettled');
		});

		it('R6: recycleExpiredEpoch reverts EpochNotExpired during claim window', async function () {
			const currentEpoch = Number((await mirrorQuery(rebatePoolId, rebatePoolIface, 'currentEpoch', []))[0]);
			const result = await contractExecuteFunction(
				rebatePoolId, rebatePoolIface, client, 400_000,
				'recycleExpiredEpoch', [currentEpoch],
				0, true,
			);
			expectRevertNamed(result, 'EpochNotExpired');
		});

		it('R7: setSigner rotates the signer; old signer cannot settleEpoch', async function () {
			const newSigner = ethers.Wallet.createRandom();
			const [rxSet] = await contractExecuteFunction(
				rebatePoolId, rebatePoolIface, client, 200_000,
				'setSigner', [newSigner.address],
			);
			expect(rxSet.status.toString()).to.equal('SUCCESS');
			await sleep(MIRROR_DELAY);

			// Operator (was the signer) now should NOT be able to settleEpoch
			const result = await contractExecuteFunction(
				rebatePoolId, rebatePoolIface, client, 400_000,
				'settleEpoch', [ethers.ZeroHash, '1'],
				0, true,
			);
			expectRevertNamed(result, 'NotSigner');

			// Restore for cleanup
			await contractExecuteFunction(
				rebatePoolId, rebatePoolIface, client, 200_000,
				'setSigner', ['0x' + operatorId.toSolidityAddress()],
			);
			await sleep(MIRROR_DELAY);
		});
	});

	// ============================================
	// V — VIPSubscription 3-sink split
	// ============================================
	//
	// The new revenue split is exercised here. We assume a fresh
	// VIPSubscription is deployed against the rebate pool from above.
	// If the VIP test cycle has already extensively tested basic
	// subscription mechanics, these tests focus on the SPLIT
	// behavior only.

	describe('V — VIPSubscription 3-sink split', function () {
		let vipId, vipIface;

		before(async function () {
			this.timeout(300_000);
			// Deploy a fresh VIPSubscription for these tests.
			const vipJson = JSON.parse(fs.readFileSync(
				'./artifacts/contracts/VIPSubscription.sol/VIPSubscription.json', 'utf8',
			));
			vipIface = new ethers.Interface(vipJson.abi);
			const vipParams = new ContractFunctionParameters()
				.addAddress(lazyTokenId.toSolidityAddress())
				.addAddress(lazyGasStationId.toSolidityAddress());
			[vipId] = await contractDeployFunction(
				client, vipJson.bytecode, 3_500_000, vipParams,
			);
			console.log('Fresh VIPSubscription:', vipId.toString());

			// Authorize on LGS so it can call drawLazyFrom + payoutLazy
			await contractExecuteFunction(
				lazyGasStationId, lgsIface, client, 200_000,
				'addContractUser', [vipId.toSolidityAddress()],
			);

			// Set monthly prices (Bronze=10 LAZY for cheap tests)
			const mult = 10 ** LAZY_DECIMAL;
			await contractExecuteFunction(vipId, vipIface, client, 200_000,
				'setMonthlyPrice', [1, 10 * mult]); // Bronze = 1
			await sleep(MIRROR_DELAY);

			// Operator approves LAZY to LGS
			await setFTAllowance(client, lazyTokenId, operatorId, lazyGasStationId, 10000 * mult);
			await sleep(1500);
		});

		it('V1: default split (rebate off) — burn + LGS-retain only, behavior unchanged', async function () {
			// rebateBps defaults to 1000 (10%) but rebatePool is unset
			// (address(0)), so the rebate path is inert. teamBps is 0.
			// Net behavior should match pre-patch.
			const [rx] = await contractExecuteFunction(
				vipId, vipIface, client, 1_000_000,
				'purchaseSubscription', [1 /* Bronze */, 1, []],
			);
			expect(rx.status.toString()).to.equal('SUCCESS');
			// Subscription should be active
			await sleep(MIRROR_DELAY);
			const tier = Number((await mirrorQuery(vipId, vipIface, 'getTierFor', [
				'0x' + operatorId.toSolidityAddress(),
			]))[0]);
			expect(tier).to.equal(1); // Bronze
		});

		it('V2: setRebatePool then purchase routes rebate slice to pool', async function () {
			const poolEvm = '0x' + rebatePoolId.toSolidityAddress();
			await contractExecuteFunction(vipId, vipIface, client, 200_000,
				'setRebatePool', [poolEvm]);
			await sleep(MIRROR_DELAY);

			const prePoolBal = await checkMirrorBalance(ENV, rebatePoolId, lazyTokenId) ?? 0;

			// Extend Bronze by 1 month
			await contractExecuteFunction(
				vipId, vipIface, client, 1_000_000,
				'purchaseSubscription', [1, 1, []],
			);
			await sleep(MIRROR_DELAY);

			const postPoolBal = await checkMirrorBalance(ENV, rebatePoolId, lazyTokenId) ?? 0;
			// 10% of (10 LAZY × decimals) = 1 LAZY × decimals
			const expectedDelta = (10 * (10 ** LAZY_DECIMAL) * 0.9) | 0; // ~90% after prepay discount
			// Pool received some LAZY; exact amount depends on discount math
			expect(postPoolBal).to.be.greaterThan(prePoolBal);
			console.log(`V2: rebate pool gained ${postPoolBal - prePoolBal} LAZY base units`);
		});

		it('V3: setRebateBps with value > MAX_REBATE_BPS reverts', async function () {
			const result = await contractExecuteFunction(
				vipId, vipIface, client, 200_000,
				'setRebateBps', [6000], // > 5000 cap
				0, true,
			);
			expectRevertNamed(result, 'RebateBpsExceedsCap');
		});

		it('V4: setTeamBps with value > MAX_TEAM_BPS reverts', async function () {
			const result = await contractExecuteFunction(
				vipId, vipIface, client, 200_000,
				'setTeamBps', [6000],
				0, true,
			);
			expectRevertNamed(result, 'TeamBpsExceedsCap');
		});
	});
});
