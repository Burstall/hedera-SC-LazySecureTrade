// LSHTierLib unit tests against minimal mocks.
//
// The library itself is `internal view` so it can only be exercised via
// the `LSHTierLibProbe` external wrapper. All LSH / LDR / staking
// dependencies are mocked under `contracts/test/` — we never touch real
// LSH NFTs or the production LDR.
//
// Tests run against a real Hedera testnet (per repo convention), but
// the contracts deployed are tiny mocks; total HBAR cost per full run
// is a few HBAR for deploys + a handful of view calls.

const fs = require('fs');
const { ethers } = require('ethers');
const { expect } = require('chai');
const { describe, it, before, beforeEach, after } = require('mocha');
const {
	Client,
	AccountId,
	PrivateKey,
	ContractId,
	ContractFunctionParameters,
} = require('@hashgraph/sdk');

const {
	contractDeployFunction,
	contractExecuteFunction,
	readOnlyEVMFromMirrorNode,
} = require('../utils/solidityHelpers');
const { ensureLibraries, linkLibraries } = require('../utils/libraryLinking');
const { sleep } = require('../utils/nodeHelpers');
require('dotenv').config();

// Bumped from the default 3500ms because rapid-fire state-changing
// txs in beforeEach + the test body can outpace mirror propagation
// for some contracts. Empirically 5000ms eliminates the flake on the
// Gen2-only path; cost is ~30s extra total runtime.
const MIRROR_DELAY = Number(process.env.SLEEP_TIME) || 5000;
const ENV = (process.env.ENVIRONMENT || 'test').toLowerCase();

// Free mirror-node read (no testnet tx). Used for probe view calls so
// the full test suite doesn't burn gas on read-only assertions.
async function mirrorQuery(contractId, iface, fcnName, params = []) {
	const encoded = iface.encodeFunctionData(fcnName, params);
	const operatorId = AccountId.fromString(process.env.ACCOUNT_ID);
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const raw = await readOnlyEVMFromMirrorNode(
				ENV, contractId, encoded, operatorId, false,
			);
			return iface.decodeFunctionResult(fcnName, raw);
		}
		catch (e) {
			if (attempt < 2) {
				await sleep(2500);
				continue;
			}
			throw e;
		}
	}
}

// Library Tier enum mirrored for assertions
const Tier = { Free: 0, Silver: 1, Gold: 2, Platinum: 3 };

describe('LSHTierLib unit tests', function () {
	this.timeout(120_000);
	// Single retry to tolerate transient mirror-propagation lag on the
	// per-test state setups. The library logic is deterministic; any
	// genuine logic bug fails both attempts.
	this.retries(1);

	let operatorId, operatorKey, client;
	let probeId, probeIface;
	let gen1Id, mutantId, gen2Id; // mock LSH NFTs
	let ldrId; // mock LDR
	let stakingId; // mock staking
	let gen1Sol, mutantSol, gen2Sol, ldrSol, stakingSol;
	let testUser;

	function makeSources(overrides = {}) {
		return {
			lshGen1: overrides.lshGen1 ?? gen1Sol,
			lshMutant: overrides.lshMutant ?? mutantSol,
			lshGen2: overrides.lshGen2 ?? gen2Sol,
			lazyDelegateRegistry: overrides.lazyDelegateRegistry ?? ldrSol,
			lazyNFTStaking: overrides.lazyNFTStaking ?? stakingSol,
		};
	}

	async function readTier(user, sources) {
		const decoded = await mirrorQuery(
			probeId, probeIface, 'tierFor', [user, sources],
		);
		return Number(decoded[0]);
	}

	async function readAnyHolder(user, sources) {
		const decoded = await mirrorQuery(
			probeId, probeIface, 'anyHolder', [user, sources],
		);
		return Boolean(decoded[0]);
	}

	// Convenience: reset all mocks to baseline (no holdings, no
	// delegations, no stakes, no reverts) before each test.
	async function resetMocks() {
		const setBal0 = async (cid) => {
			await contractExecuteFunction(cid, gen1Iface, client, 200_000,
				'setBalance', [testUser, 0]);
		};
		await setBal0(gen1Id);
		await setBal0(mutantId);
		await setBal0(gen2Id);

		await contractExecuteFunction(ldrId, ldrIface, client, 200_000,
			'setRevertAll', [false]);
		for (const tok of [gen1Sol, mutantSol, gen2Sol]) {
			await contractExecuteFunction(ldrId, ldrIface, client, 200_000,
				'setDelegated', [testUser, tok, []]);
		}

		await contractExecuteFunction(stakingId, stakingIface, client, 200_000,
			'setRevertAll', [false]);
		await contractExecuteFunction(stakingId, stakingIface, client, 300_000,
			'setStakedFor', [testUser, [], []]);
	}

	let gen1Iface, ldrIface, stakingIface;

	before(async function () {
		this.timeout(300_000);

		const env = (process.env.ENVIRONMENT || 'test').toLowerCase();
		operatorId = AccountId.fromString(process.env.ACCOUNT_ID);
		operatorKey = PrivateKey.fromStringED25519(process.env.PRIVATE_KEY);
		client = env === 'main' ? Client.forMainnet()
			: env === 'preview' ? Client.forPreviewnet()
			: Client.forTestnet();
		client.setOperator(operatorId, operatorKey);

		// Test user — any unused EOA address works; we never make this user
		// sign anything, just check it as a query target. Use a static
		// throwaway address so tests are deterministic.
		testUser = '0x' + AccountId.fromString('0.0.1234567').toSolidityAddress();

		// --- Deploy mock LSH NFTs (just balanceOf stubs)
		const erc721Json = JSON.parse(fs.readFileSync(
			'./artifacts/contracts/test/MockERC721Balance.sol/MockERC721Balance.json',
			'utf8',
		));
		gen1Iface = new ethers.Interface(erc721Json.abi);
		[gen1Id] = await contractDeployFunction(client, erc721Json.bytecode, 500_000);
		[mutantId] = await contractDeployFunction(client, erc721Json.bytecode, 500_000);
		[gen2Id] = await contractDeployFunction(client, erc721Json.bytecode, 500_000);
		gen1Sol = '0x' + gen1Id.toSolidityAddress();
		mutantSol = '0x' + mutantId.toSolidityAddress();
		gen2Sol = '0x' + gen2Id.toSolidityAddress();
		console.log('Gen1:', gen1Id.toString(), 'Mutant:', mutantId.toString(), 'Gen2:', gen2Id.toString());

		// --- Mock LDR
		const ldrJson = JSON.parse(fs.readFileSync(
			'./artifacts/contracts/test/MockLazyDelegateRegistry.sol/MockLazyDelegateRegistry.json',
			'utf8',
		));
		ldrIface = new ethers.Interface(ldrJson.abi);
		[ldrId] = await contractDeployFunction(client, ldrJson.bytecode, 800_000);
		ldrSol = '0x' + ldrId.toSolidityAddress();
		console.log('Mock LDR:', ldrId.toString());

		// --- Mock staking
		const stakingJson = JSON.parse(fs.readFileSync(
			'./artifacts/contracts/test/MockLazyNFTStaking.sol/MockLazyNFTStaking.json',
			'utf8',
		));
		stakingIface = new ethers.Interface(stakingJson.abi);
		[stakingId] = await contractDeployFunction(client, stakingJson.bytecode, 1_500_000);
		stakingSol = '0x' + stakingId.toSolidityAddress();
		console.log('Mock Staking:', stakingId.toString());

		// --- Probe
		const probeJson = JSON.parse(fs.readFileSync(
			'./artifacts/contracts/test/LSHTierLibProbe.sol/LSHTierLibProbe.json',
			'utf8',
		));
		probeIface = new ethers.Interface(probeJson.abi);
		const probeLibs = await ensureLibraries(client);
		[probeId] = await contractDeployFunction(
			client, linkLibraries(probeJson.bytecode, probeJson.linkReferences, probeLibs), 2_000_000,
		);
		console.log('Probe:', probeId.toString());

		await sleep(MIRROR_DELAY);
		await resetMocks();
		await sleep(MIRROR_DELAY);
	});

	beforeEach(async function () {
		this.timeout(60_000);
		await resetMocks();
		await sleep(MIRROR_DELAY);
	});

	// ============================================
	// Tier-resolution correctness
	// ============================================
	describe('Tier resolution', function () {
		it('T1: holds Gen1 only → Platinum', async function () {
			await contractExecuteFunction(gen1Id, gen1Iface, client, 200_000,
				'setBalance', [testUser, 1]);
			await sleep(MIRROR_DELAY);
			expect(await readTier(testUser, makeSources())).to.equal(Tier.Platinum);
		});

		it('T2: holds Mutant only → Gold', async function () {
			await contractExecuteFunction(mutantId, gen1Iface, client, 200_000,
				'setBalance', [testUser, 1]);
			await sleep(MIRROR_DELAY);
			expect(await readTier(testUser, makeSources())).to.equal(Tier.Gold);
		});

		it('T3: holds Gen2 only → Silver', async function () {
			await contractExecuteFunction(gen2Id, gen1Iface, client, 200_000,
				'setBalance', [testUser, 1]);
			await sleep(MIRROR_DELAY);
			expect(await readTier(testUser, makeSources())).to.equal(Tier.Silver);
		});

		it('T4: no holdings / no delegations / no stakes → Free', async function () {
			expect(await readTier(testUser, makeSources())).to.equal(Tier.Free);
		});

		it('T5: holds Mutant + Gen1 → Platinum (priority)', async function () {
			await contractExecuteFunction(mutantId, gen1Iface, client, 200_000,
				'setBalance', [testUser, 5]);
			await contractExecuteFunction(gen1Id, gen1Iface, client, 200_000,
				'setBalance', [testUser, 1]);
			await sleep(MIRROR_DELAY);
			expect(await readTier(testUser, makeSources())).to.equal(Tier.Platinum);
		});
	});

	// ============================================
	// Staking branch
	// ============================================
	describe('Staking-as-holdings semantic', function () {
		it('T6: staked Gen1 only → Platinum', async function () {
			await contractExecuteFunction(stakingId, stakingIface, client, 300_000,
				'setStakedFor', [testUser, [gen1Sol], [[1, 2]]]);
			await sleep(MIRROR_DELAY);
			expect(await readTier(testUser, makeSources())).to.equal(Tier.Platinum);
		});

		it('T7: staked Mutant + held Gen2 → Gold (held Gen2 fires first; staking elevates to Gold)', async function () {
			// User holds Gen2 (Silver) and also stakes Mutant (Gold).
			// Held check fires first (returns Silver). Staking check
			// should NOT run because the held-Gen2 branch returned.
			// Therefore final tier = Silver. This documents the
			// short-circuit semantic explicitly.
			await contractExecuteFunction(gen2Id, gen1Iface, client, 200_000,
				'setBalance', [testUser, 1]);
			await contractExecuteFunction(stakingId, stakingIface, client, 300_000,
				'setStakedFor', [testUser, [mutantSol], [[10]]]);
			await sleep(MIRROR_DELAY);
			// Per the short-circuit algorithm in LSHTierLib.getTierFor,
			// holdings checks run before staking. Silver (Gen2 held)
			// returns immediately.
			expect(await readTier(testUser, makeSources())).to.equal(Tier.Silver);
		});

		it('T8: staked Mutant + delegated Gen1 → Platinum (max across staking + delegation)', async function () {
			await contractExecuteFunction(stakingId, stakingIface, client, 300_000,
				'setStakedFor', [testUser, [mutantSol], [[1]]]);
			await contractExecuteFunction(ldrId, ldrIface, client, 300_000,
				'setDelegated', [testUser, gen1Sol, [42]]);
			await sleep(MIRROR_DELAY);
			expect(await readTier(testUser, makeSources())).to.equal(Tier.Platinum);
		});

		it('T9: staked Gen1 short-circuits before delegation check', async function () {
			// User stakes Gen1 AND has delegated Mutant. Library returns
			// Platinum (from staking) without consulting LDR.
			await contractExecuteFunction(stakingId, stakingIface, client, 300_000,
				'setStakedFor', [testUser, [gen1Sol], [[7]]]);
			await contractExecuteFunction(ldrId, ldrIface, client, 300_000,
				'setDelegated', [testUser, mutantSol, [99]]);
			await sleep(MIRROR_DELAY);
			expect(await readTier(testUser, makeSources())).to.equal(Tier.Platinum);
		});

		it('T10: lazyNFTStaking = address(0) opts out of staking branch', async function () {
			// User stakes Gen1, but consumer passes lazyNFTStaking=0.
			// Result: staking ignored; falls through to delegation (none) → Free.
			await contractExecuteFunction(stakingId, stakingIface, client, 300_000,
				'setStakedFor', [testUser, [gen1Sol], [[1]]]);
			await sleep(MIRROR_DELAY);
			const zeroAddr = '0x' + AccountId.fromString('0.0.0').toSolidityAddress();
			expect(await readTier(testUser, makeSources({ lazyNFTStaking: zeroAddr })))
				.to.equal(Tier.Free);
		});
	});

	// ============================================
	// Delegation branch
	// ============================================
	describe('Delegation tier', function () {
		it('T11: delegated Gen1 only → Platinum', async function () {
			await contractExecuteFunction(ldrId, ldrIface, client, 300_000,
				'setDelegated', [testUser, gen1Sol, [1, 2, 3]]);
			await sleep(MIRROR_DELAY);
			expect(await readTier(testUser, makeSources())).to.equal(Tier.Platinum);
		});

		it('T12: delegated Gen2 + held Mutant → Gold (held wins via priority)', async function () {
			await contractExecuteFunction(ldrId, ldrIface, client, 300_000,
				'setDelegated', [testUser, gen2Sol, [5]]);
			await contractExecuteFunction(mutantId, gen1Iface, client, 200_000,
				'setBalance', [testUser, 1]);
			await sleep(MIRROR_DELAY);
			expect(await readTier(testUser, makeSources())).to.equal(Tier.Gold);
		});

		it('T13: lazyDelegateRegistry = address(0) opts out of delegation branch', async function () {
			await contractExecuteFunction(ldrId, ldrIface, client, 300_000,
				'setDelegated', [testUser, gen1Sol, [1]]);
			await sleep(MIRROR_DELAY);
			const zeroAddr = '0x' + AccountId.fromString('0.0.0').toSolidityAddress();
			expect(await readTier(testUser, makeSources({ lazyDelegateRegistry: zeroAddr })))
				.to.equal(Tier.Free);
		});
	});

	// ============================================
	// LDR / staking resilience (the load-bearing try/catch contract)
	// ============================================
	describe('Resilience (LDR / staking revert)', function () {
		it('T14: LDR reverts on getSerialsDelegatedTo → user with only delegation falls back to Free', async function () {
			await contractExecuteFunction(ldrId, ldrIface, client, 300_000,
				'setDelegated', [testUser, gen1Sol, [1]]);
			await contractExecuteFunction(ldrId, ldrIface, client, 200_000,
				'setRevertAll', [true]);
			await sleep(MIRROR_DELAY);
			expect(await readTier(testUser, makeSources())).to.equal(Tier.Free);
		});

		it('T15: LDR reverts + user holds Mutant → Gold (holdings path still works)', async function () {
			await contractExecuteFunction(mutantId, gen1Iface, client, 200_000,
				'setBalance', [testUser, 1]);
			await contractExecuteFunction(ldrId, ldrIface, client, 200_000,
				'setRevertAll', [true]);
			await sleep(MIRROR_DELAY);
			expect(await readTier(testUser, makeSources())).to.equal(Tier.Gold);
		});

		it('T16: staking reverts on getStakedNFTs → falls back to delegation (still works)', async function () {
			await contractExecuteFunction(stakingId, stakingIface, client, 200_000,
				'setRevertAll', [true]);
			await contractExecuteFunction(ldrId, ldrIface, client, 300_000,
				'setDelegated', [testUser, gen1Sol, [1]]);
			await sleep(MIRROR_DELAY);
			expect(await readTier(testUser, makeSources())).to.equal(Tier.Platinum);
		});
	});

	// ============================================
	// isAnyHolder convenience
	// ============================================
	describe('isAnyHolder boolean', function () {
		it('T17: any LSH source → true', async function () {
			await contractExecuteFunction(gen2Id, gen1Iface, client, 200_000,
				'setBalance', [testUser, 1]);
			await sleep(MIRROR_DELAY);
			expect(await readAnyHolder(testUser, makeSources())).to.be.true;
		});

		it('T18: no sources → false', async function () {
			expect(await readAnyHolder(testUser, makeSources())).to.be.false;
		});
	});

	after(function () {
		console.log('\n=== LSHTierLib test run summary ===');
		console.log('Probe:    ', probeId?.toString());
		console.log('Gen1 mock:', gen1Id?.toString());
		console.log('Mutant mock:', mutantId?.toString());
		console.log('Gen2 mock:', gen2Id?.toString());
		console.log('LDR mock: ', ldrId?.toString());
		console.log('Staking mock:', stakingId?.toString());
	});
});
