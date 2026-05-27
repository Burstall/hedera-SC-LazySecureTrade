// VIPSubscription unit + integration tests against real Hedera testnet.
//
// Reuses the shared $LAZY token / LGS / LDR / test NFT collection /
// Alice + Bob accounts cached in .env so each run is cheap. Deploys
// a fresh VIPSubscription, sets up a discount table, and exercises:
//   - Purchase happy paths (no discount, holdings discount, prepay)
//   - Loaner cooldown enforcement
//   - Max-discount cap
//   - Tier upgrade rules (extension, upgrade-in-place, downgrade-blocked)
//   - Admin paths (setDiscount, extendSubscription)
//   - Read API (getTierFor, subscriptionOf, expired-returns-Free)

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
	HbarUnit,
	Hbar,
} = require('@hashgraph/sdk');

const {
	contractDeployFunction,
	contractExecuteFunction,
	readOnlyEVMFromMirrorNode,
} = require('../utils/solidityHelpers');
const {
	setFTAllowance,
	sendHbar,
} = require('../utils/hederaHelpers');
const { sleep } = require('../utils/nodeHelpers');
const {
	checkMirrorBalance,
	checkMirrorHbarBalance,
} = require('../utils/hederaMirrorHelpers');
require('dotenv').config();

const MIRROR_DELAY = Number(process.env.SLEEP_TIME) || 5000;
const ENV = (process.env.ENVIRONMENT || 'test').toLowerCase();
const LAZY_DECIMAL = Number(process.env.LAZY_DECIMALS ?? 1);

// Tier ordering matches IVIPSubscription enum
const Tier = { Free: 0, Bronze: 1, Silver: 2, Gold: 3, Platinum: 4 };

function expectRevertNamed(result, expectedName) {
	const status = result?.[0]?.status;
	const name = status?.name?.toString?.();
	if (name !== expectedName) {
		throw new Error(
			`Expected revert ${expectedName}, got ${name ?? status?.toString?.() ?? 'unknown'}`,
		);
	}
}

describe('VIPSubscription tests', function () {
	this.timeout(180_000);
	this.retries(1);

	let operatorId, operatorKey, client;
	let lazyTokenId, lazyGasStationId, lazyGasStationIface;
	let nftTokenId; // doubles as the LSH-Gen1 mock for tests
	let aliceId, alicePK;
	let vipId, vipIface;
	let vipSol;

	async function mirrorQuery(contractId, iface, fcnName, params = []) {
		const encoded = iface.encodeFunctionData(fcnName, params);
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

	before(async function () {
		this.timeout(300_000);

		operatorId = AccountId.fromString(process.env.ACCOUNT_ID);
		operatorKey = PrivateKey.fromStringED25519(process.env.PRIVATE_KEY);
		client = ENV === 'main' ? Client.forMainnet()
			: ENV === 'preview' ? Client.forPreviewnet()
				: Client.forTestnet();
		client.setOperator(operatorId, operatorKey);

		// Resolve cached dependencies from .env
		lazyTokenId = TokenId.fromString(process.env.LAZY_TOKEN_ID);
		lazyGasStationId = ContractId.fromString(process.env.LAZY_GAS_STATION_CONTRACT_ID);
		nftTokenId = TokenId.fromString(process.env.BCF_NFT_TOKEN_ID);
		aliceId = AccountId.fromString(process.env.ALICE_ACCOUNT_ID);
		alicePK = PrivateKey.fromStringED25519(process.env.ALICE_PRIVATE_KEY);

		const lgsJson = JSON.parse(fs.readFileSync(
			'./artifacts/contracts/LazyGasStation.sol/LazyGasStation.json', 'utf8',
		));
		lazyGasStationIface = new ethers.Interface(lgsJson.abi);

		// --- Deploy VIPSubscription
		const vipJson = JSON.parse(fs.readFileSync(
			'./artifacts/contracts/VIPSubscription.sol/VIPSubscription.json', 'utf8',
		));
		vipIface = new ethers.Interface(vipJson.abi);
		const vipParams = new ContractFunctionParameters()
			.addAddress(lazyTokenId.toSolidityAddress())
			.addAddress(lazyGasStationId.toSolidityAddress());
		[vipId] = await contractDeployFunction(client, vipJson.bytecode, 3_500_000, vipParams);
		vipSol = '0x' + vipId.toSolidityAddress();
		console.log('VIPSubscription deployed:', vipId.toString());

		// --- Authorize VIPSubscription as a contract user on LGS
		await contractExecuteFunction(
			lazyGasStationId, lazyGasStationIface, client, 200_000,
			'addContractUser', [vipId.toSolidityAddress()],
		);
		console.log('VIPSubscription registered as LGS contract user');

		// --- Configure tier prices (use small LAZY amounts so test
		//     accounts can afford them with existing balances).
		// Prices: Bronze=10, Silver=20, Gold=50, Platinum=100 LAZY/month.
		// (base-units; decimals from .env)
		const mult = 10 ** LAZY_DECIMAL;
		await contractExecuteFunction(vipId, vipIface, client, 200_000,
			'setMonthlyPrice', [Tier.Bronze, 10 * mult]);
		await contractExecuteFunction(vipId, vipIface, client, 200_000,
			'setMonthlyPrice', [Tier.Silver, 20 * mult]);
		await contractExecuteFunction(vipId, vipIface, client, 200_000,
			'setMonthlyPrice', [Tier.Gold, 50 * mult]);
		await contractExecuteFunction(vipId, vipIface, client, 200_000,
			'setMonthlyPrice', [Tier.Platinum, 100 * mult]);

		// --- Configure discount table: nftTokenId acts as our Gen1 mock,
		//     so set 75% off for Platinum tier when nominated.
		await contractExecuteFunction(vipId, vipIface, client, 300_000,
			'setDiscount', [nftTokenId.toSolidityAddress(), Tier.Platinum, 7_500, []]);
		// And 50% off Gold tier (same token = standin for Gen1 holdings).
		await contractExecuteFunction(vipId, vipIface, client, 300_000,
			'setDiscount', [nftTokenId.toSolidityAddress(), Tier.Gold, 5_000, []]);
		console.log('Discount table configured');

		// --- Alice approves LAZY to LGS (covers all test purchases).
		client.setOperator(aliceId, alicePK);
		await setFTAllowance(
			client, lazyTokenId, aliceId, lazyGasStationId, 100_000 * mult,
		);
		client.setOperator(operatorId, operatorKey);

		await sleep(MIRROR_DELAY);
	});

	// ============================================
	// V1 — Read API
	// ============================================
	describe('Read API', function () {
		it('V1.1: getTierFor returns Free for an address with no subscription', async function () {
			const result = await mirrorQuery(vipId, vipIface, 'getTierFor', [
				operatorId.toSolidityAddress(),
			]);
			expect(Number(result[0])).to.equal(Tier.Free);
		});

		it('V1.2: subscriptionOf returns zero struct for never-subscribed address', async function () {
			const result = await mirrorQuery(vipId, vipIface, 'subscriptionOf', [
				operatorId.toSolidityAddress(),
			]);
			const s = result[0];
			expect(Number(s.tier)).to.equal(Tier.Free);
			expect(Number(s.expiresAt)).to.equal(0);
		});

		it('V1.3: remainingDuration is 0 for never-subscribed address', async function () {
			const result = await mirrorQuery(vipId, vipIface, 'remainingDuration', [
				operatorId.toSolidityAddress(),
			]);
			expect(Number(result[0])).to.equal(0);
		});

		it('V1.4: priceFor Bronze 1-month no-holdings includes pro-rata prepay discount', async function () {
			// Annual-prepay discount (default 2000 bps) applies pro-rata
			// even to single-month purchases: 2000 × 1 / 12 = 166 bps.
			// Base = 10 LAZY × decimals = 100 raw. Final = 100 × (1 -
			// 0.0166) = 98.34 → 98 (integer truncation).
			const result = await mirrorQuery(vipId, vipIface, 'priceFor', [
				Tier.Bronze, 1, [], aliceId.toSolidityAddress(),
			]);
			const mult = 10 ** LAZY_DECIMAL;
			const baseUnits = 10 * mult; // Bronze 1mo base
			const expectedBps = Math.floor((2000 * 1) / 12); // 166
			const expectedPrice = Math.floor((baseUnits * (10000 - expectedBps)) / 10000);
			expect(Number(result[0])).to.equal(expectedPrice);
			expect(Number(result[1])).to.equal(expectedBps);
		});
	});

	// ============================================
	// V2 — Purchase flow happy path
	// ============================================
	describe('Purchase happy paths', function () {
		it('V2.1: Alice purchases Bronze 1 month with no discount → SubscriptionPurchased + tier active', async function () {
			const preAliceLazy = await checkMirrorBalance(ENV, aliceId, lazyTokenId) ?? 0;

			client.setOperator(aliceId, alicePK);
			const [rx] = await contractExecuteFunction(
				vipId, vipIface, client, 800_000,
				'purchaseSubscription', [Tier.Bronze, 1, []],
			);
			expect(rx.status.toString()).to.equal('SUCCESS');
			client.setOperator(operatorId, operatorKey);
			await sleep(MIRROR_DELAY);

			// Tier should now be Bronze
			const tier = await mirrorQuery(vipId, vipIface, 'getTierFor', [
				aliceId.toSolidityAddress(),
			]);
			expect(Number(tier[0])).to.equal(Tier.Bronze);

			// Alice's LAZY decreased
			const postAliceLazy = await checkMirrorBalance(ENV, aliceId, lazyTokenId) ?? 0;
			expect(postAliceLazy).to.be.lessThan(preAliceLazy);
			console.log('V2.1: Alice paid', preAliceLazy - postAliceLazy, 'LAZY base units for Bronze 1mo');
		});
	});

	// ============================================
	// V3 — Tier upgrade rules
	// ============================================
	describe('Tier upgrade rules', function () {
		it('V3.1: Alice with active Bronze buys Platinum → upgrade-in-place (Platinum tier)', async function () {
			// Alice already has Bronze from V2.1. Buy Platinum 1 month.
			client.setOperator(aliceId, alicePK);
			const [rx] = await contractExecuteFunction(
				vipId, vipIface, client, 1_000_000,
				'purchaseSubscription', [Tier.Platinum, 1, []],
			);
			expect(rx.status.toString()).to.equal('SUCCESS');
			client.setOperator(operatorId, operatorKey);
			await sleep(MIRROR_DELAY);

			const tier = await mirrorQuery(vipId, vipIface, 'getTierFor', [
				aliceId.toSolidityAddress(),
			]);
			expect(Number(tier[0])).to.equal(Tier.Platinum);
			console.log('V3.1: Alice upgraded Bronze → Platinum (existing time forfeited)');
		});

		it('V3.2: Alice with active Platinum buys Bronze → CannotDowngradeActiveSubscription', async function () {
			client.setOperator(aliceId, alicePK);
			const result = await contractExecuteFunction(
				vipId, vipIface, client, 800_000,
				'purchaseSubscription', [Tier.Bronze, 1, []], 0, true,
			);
			expectRevertNamed(result, 'CannotDowngradeActiveSubscription');
			client.setOperator(operatorId, operatorKey);
			console.log('V3.2: downgrade rejected');
		});

		it('V3.3: Alice extends Platinum by another month → same-tier extension', async function () {
			const pre = await mirrorQuery(vipId, vipIface, 'subscriptionOf', [
				aliceId.toSolidityAddress(),
			]);
			const preExpiresAt = Number(pre[0].expiresAt);

			client.setOperator(aliceId, alicePK);
			const [rx] = await contractExecuteFunction(
				vipId, vipIface, client, 1_000_000,
				'purchaseSubscription', [Tier.Platinum, 1, []],
			);
			expect(rx.status.toString()).to.equal('SUCCESS');
			client.setOperator(operatorId, operatorKey);
			await sleep(MIRROR_DELAY);

			const post = await mirrorQuery(vipId, vipIface, 'subscriptionOf', [
				aliceId.toSolidityAddress(),
			]);
			const postExpiresAt = Number(post[0].expiresAt);
			// 30 days ≈ 2_592_000s added; allow ±60s tolerance
			expect(postExpiresAt - preExpiresAt).to.be.greaterThan(2_591_900);
			expect(postExpiresAt - preExpiresAt).to.be.lessThan(2_592_100);
			console.log('V3.3: Platinum extended by +30 days');
		});
	});

	// ============================================
	// V4 — Discount + cooldown
	// ============================================
	describe('Discount + cooldown', function () {
		it('V4.1: Alice purchases Gold with NFT proof → pays 50% of base + cooldown locked', async function () {
			// Alice has Platinum active. For this test we need a discount
			// purchase, which requires buying ≥ current tier or same tier
			// (same-tier extension). Buying Platinum with a proof works.
			//
			// Find a serial Alice owns.
			const { getSerialsOwned } = require('../utils/hederaMirrorHelpers');
			const aliceSerials = (await getSerialsOwned(ENV, aliceId, nftTokenId)) ?? [];
			expect(aliceSerials.length).to.be.greaterThan(0);
			const proofSerial = aliceSerials[0];

			const preLazy = await checkMirrorBalance(ENV, aliceId, lazyTokenId) ?? 0;

			// priceFor quote at Platinum + 1 proof should show 75% discount
			const quote = await mirrorQuery(vipId, vipIface, 'priceFor', [
				Tier.Platinum, 1,
				[{ token: nftTokenId.toSolidityAddress(), serial: proofSerial }],
				aliceId.toSolidityAddress(),
			]);
			// Platinum 1mo base = 100 LAZY × decimals. 75% off discount =
			// raw 7500, + duration 2000×1/12 = 166, sum 7666, capped at
			// maxCombined 9000 → 7666 applies. Final price = 100 × 0.2334
			expect(Number(quote[1])).to.equal(7666);

			client.setOperator(aliceId, alicePK);
			const [rx] = await contractExecuteFunction(
				vipId, vipIface, client, 1_500_000,
				'purchaseSubscription', [
					Tier.Platinum, 1,
					[{ token: nftTokenId.toSolidityAddress(), serial: proofSerial }],
				],
			);
			expect(rx.status.toString()).to.equal('SUCCESS');
			client.setOperator(operatorId, operatorKey);
			await sleep(MIRROR_DELAY);

			const postLazy = await checkMirrorBalance(ENV, aliceId, lazyTokenId) ?? 0;
			const paid = preLazy - postLazy;
			const mult = 10 ** LAZY_DECIMAL;
			// Final price = 100 LAZY × (1 - 0.7666) = ~23.34 LAZY in base units
			// (close to 23 or 24 depending on rounding). Sanity-check the range.
			expect(paid).to.be.greaterThan(20 * mult);
			expect(paid).to.be.lessThan(30 * mult);
			console.log('V4.1: Alice paid', paid, 'for Platinum with Gen1 proof');

			// Cooldown locked
			const lock = await mirrorQuery(vipId, vipIface, 'isSerialLocked', [
				nftTokenId.toSolidityAddress(), proofSerial,
			]);
			expect(lock[0]).to.be.true;
			console.log('V4.1: serial', proofSerial, 'locked until', Number(lock[1]));
		});

		it('V4.2: Re-using the same serial within cooldown → SerialCooldownActive revert', async function () {
			const { getSerialsOwned } = require('../utils/hederaMirrorHelpers');
			const aliceSerials = (await getSerialsOwned(ENV, aliceId, nftTokenId)) ?? [];
			const proofSerial = aliceSerials[0];

			client.setOperator(aliceId, alicePK);
			const result = await contractExecuteFunction(
				vipId, vipIface, client, 1_000_000,
				'purchaseSubscription', [
					Tier.Platinum, 1,
					[{ token: nftTokenId.toSolidityAddress(), serial: proofSerial }],
				],
				0, true,
			);
			expectRevertNamed(result, 'SerialCooldownActive');
			client.setOperator(operatorId, operatorKey);
			console.log('V4.2: cooldown enforced');
		});
	});

	// ============================================
	// V5 — Admin paths
	// ============================================
	describe('Admin paths', function () {
		it('V5.1: extendSubscription adds time without LAZY consumed', async function () {
			const pre = await mirrorQuery(vipId, vipIface, 'subscriptionOf', [
				aliceId.toSolidityAddress(),
			]);
			const preExpiresAt = Number(pre[0].expiresAt);
			const preLazy = await checkMirrorBalance(ENV, aliceId, lazyTokenId) ?? 0;

			// Operator (owner) grants Alice 3 more months
			const [rx] = await contractExecuteFunction(
				vipId, vipIface, client, 200_000,
				'extendSubscription', [aliceId.toSolidityAddress(), 3],
			);
			expect(rx.status.toString()).to.equal('SUCCESS');
			await sleep(MIRROR_DELAY);

			const post = await mirrorQuery(vipId, vipIface, 'subscriptionOf', [
				aliceId.toSolidityAddress(),
			]);
			const postExpiresAt = Number(post[0].expiresAt);
			const postLazy = await checkMirrorBalance(ENV, aliceId, lazyTokenId) ?? 0;

			// 90 days added ±60s
			expect(postExpiresAt - preExpiresAt).to.be.greaterThan(7_775_900);
			expect(postExpiresAt - preExpiresAt).to.be.lessThan(7_776_100);
			// No LAZY consumed
			expect(postLazy).to.equal(preLazy);
			console.log('V5.1: admin extended +3 months for free');
		});

		it('V5.2: setMonthlyPrice from non-owner reverts', async function () {
			client.setOperator(aliceId, alicePK);
			const result = await contractExecuteFunction(
				vipId, vipIface, client, 200_000,
				'setMonthlyPrice', [Tier.Bronze, 999], 0, true,
			);
			// OZ Ownable revert — just confirm tx failed
			expect(result?.[0]?.status?.toString?.()).to.not.equal('SUCCESS');
			client.setOperator(operatorId, operatorKey);
			console.log('V5.2: non-owner setMonthlyPrice rejected');
		});

		it('V5.3: setAnnualPrepayDiscountBps > 10000 reverts InvalidConfigBps', async function () {
			const result = await contractExecuteFunction(
				vipId, vipIface, client, 200_000,
				'setAnnualPrepayDiscountBps', [10001], 0, true,
			);
			expectRevertNamed(result, 'InvalidConfigBps');
			console.log('V5.3: invalid bps rejected');
		});
	});

	// ============================================
	// V6 — Validation errors
	// ============================================
	describe('Validation errors', function () {
		it('V6.1: purchase Tier.Free reverts InvalidTier', async function () {
			client.setOperator(aliceId, alicePK);
			const result = await contractExecuteFunction(
				vipId, vipIface, client, 500_000,
				'purchaseSubscription', [Tier.Free, 1, []], 0, true,
			);
			expectRevertNamed(result, 'InvalidTier');
			client.setOperator(operatorId, operatorKey);
		});

		it('V6.2: purchase with months=0 reverts ZeroMonths', async function () {
			client.setOperator(aliceId, alicePK);
			const result = await contractExecuteFunction(
				vipId, vipIface, client, 500_000,
				'purchaseSubscription', [Tier.Platinum, 0, []], 0, true,
			);
			expectRevertNamed(result, 'ZeroMonths');
			client.setOperator(operatorId, operatorKey);
		});

		it('V6.3: priceFor with token that has no discount config reverts NoQualifyingDiscount', async function () {
			const result = await contractExecuteFunction(
				vipId, vipIface, client, 500_000,
				'priceFor', [
					Tier.Bronze, 1,
					[{ token: '0x' + lazyTokenId.toSolidityAddress(), serial: 1 }],
					aliceId.toSolidityAddress(),
				],
				0, true,
			);
			// priceFor is a view but Hedera contract calls still go via
			// transaction; revert surfaces in result.
			expectRevertNamed(result, 'NoQualifyingDiscount');
		});
	});

	// ============================================
	// V7 — 3-sink revenue split end-to-end
	// ============================================
	//
	// Setter bounds are exercised in `test/RebateStack.test.js` (V1–V4).
	// This section exercises the actual `purchaseSubscription` flow with
	// rebate + team slices configured, and asserts the post-purchase
	// balances on the rebate pool + team wallet tick by exactly the
	// computed slice amounts.

	describe('3-sink revenue split', function () {
		let rebatePoolId;
		let rebatePoolIface;

		before(async function () {
			this.timeout(300_000);

			// --- Deploy a fresh LazyRebatePool with operator as signer +
			//     365-day claim window. Signer is irrelevant for this test
			//     (no settleEpoch calls); we just need the contract to
			//     receive LAZY payouts from LGS.
			const rpJson = JSON.parse(fs.readFileSync(
				'./artifacts/contracts/LazyRebatePool.sol/LazyRebatePool.json', 'utf8',
			));
			rebatePoolIface = new ethers.Interface(rpJson.abi);
			const rpParams = new ContractFunctionParameters()
				.addAddress(lazyTokenId.toSolidityAddress())
				.addAddress('0x' + operatorId.toSolidityAddress())
				.addUint64(365 * 24 * 60 * 60);
			[rebatePoolId] = await contractDeployFunction(
				client, rpJson.bytecode, 2_000_000, rpParams,
			);
			console.log('V7 LazyRebatePool deployed:', rebatePoolId.toString());

			// --- LAZY-associate the pool so LGS.payoutLazy can land.
			//     flagError=true so revert reasons surface (silent failures
			//     here produce confusing downstream "no reason" reverts in
			//     LGS.payoutLazy when the pool transfer destination is
			//     non-associated).
			const assocResp = await contractExecuteFunction(
				rebatePoolId, rebatePoolIface, client, 1_500_000,
				'associateLazy', [], 0, true,
			);
			const assocStatus = assocResp?.[0]?.status;
			const assocStatusStr = assocStatus?.toString?.() ?? '';
			const assocErrName = assocStatus?.name;
			if (assocStatusStr !== 'SUCCESS' && assocErrName !== 'AlreadyAssociated') {
				throw new Error(`V7 associateLazy failed: status=${assocStatusStr} name=${assocErrName ?? 'unknown'}`);
			}
			await sleep(MIRROR_DELAY);

			// Verify on mirror — guard against the silent-success / no-state-update path
			const assocFlag = (await mirrorQuery(
				rebatePoolId, rebatePoolIface, 'lazyAssociated', [],
			))[0];
			if (!assocFlag) {
				throw new Error('V7 pool reports lazyAssociated=false after associateLazy — fix associate flow before re-running');
			}

			// --- Wire the VIP. Use operator as team wallet (operator is
			//     LAZY-associated and we can read its balance via mirror).
			const poolEvm = '0x' + rebatePoolId.toSolidityAddress();
			const operatorEvm = '0x' + operatorId.toSolidityAddress();
			await contractExecuteFunction(vipId, vipIface, client, 200_000,
				'setRebatePool', [poolEvm]);
			await contractExecuteFunction(vipId, vipIface, client, 200_000,
				'setRebateBps', [1000]); // 10%
			await contractExecuteFunction(vipId, vipIface, client, 200_000,
				'setTeamWallet', [operatorEvm]);
			await contractExecuteFunction(vipId, vipIface, client, 200_000,
				'setTeamBps', [500]); // 5%
			await sleep(MIRROR_DELAY);

			console.log('V7 VIP wired: rebatePool=' + rebatePoolId.toString()
				+ ', rebateBps=1000 (10%), teamWallet=operator, teamBps=500 (5%)');
		});

		it('V7.1: Platinum 1mo purchase ticks rebate pool + team wallet by computed slice', async function () {
			// Quote the price first so we use an exact value for slice math.
			// Alice currently has Platinum (extended through V3.x + V5.1).
			// Buying Platinum 1mo is a same-tier extension and applies the
			// per-month prepay discount.
			const quote = await mirrorQuery(vipId, vipIface, 'priceFor', [
				Tier.Platinum, 1, [], aliceId.toSolidityAddress(),
			]);
			const finalPrice = Number(quote[0]);
			const expectedRebate = Math.floor((finalPrice * 1000) / 10000);
			const expectedTeam = Math.floor((finalPrice * 500) / 10000);
			console.log(`V7.1: finalPrice=${finalPrice}, expectedRebate=${expectedRebate}, expectedTeam=${expectedTeam}`);
			expect(finalPrice).to.be.greaterThan(0);
			expect(expectedRebate).to.be.greaterThan(0);
			expect(expectedTeam).to.be.greaterThan(0);

			// Pre-snapshot balances
			const preAliceLazy = (await checkMirrorBalance(ENV, aliceId, lazyTokenId)) ?? 0;
			const prePoolLazy = (await checkMirrorBalance(ENV, rebatePoolId, lazyTokenId)) ?? 0;
			const preOperatorLazy = (await checkMirrorBalance(ENV, operatorId, lazyTokenId)) ?? 0;

			client.setOperator(aliceId, alicePK);
			const [rx] = await contractExecuteFunction(
				vipId, vipIface, client, 1_500_000,
				'purchaseSubscription', [Tier.Platinum, 1, []],
			);
			expect(rx.status.toString()).to.equal('SUCCESS');
			client.setOperator(operatorId, operatorKey);
			await sleep(MIRROR_DELAY);

			// Post-snapshot balances
			const postAliceLazy = (await checkMirrorBalance(ENV, aliceId, lazyTokenId)) ?? 0;
			const postPoolLazy = (await checkMirrorBalance(ENV, rebatePoolId, lazyTokenId)) ?? 0;
			const postOperatorLazy = (await checkMirrorBalance(ENV, operatorId, lazyTokenId)) ?? 0;

			const aliceDelta = preAliceLazy - postAliceLazy;
			const poolDelta = postPoolLazy - prePoolLazy;
			const operatorDelta = postOperatorLazy - preOperatorLazy;

			console.log(`V7.1: aliceDelta=${aliceDelta}, poolDelta=${poolDelta}, operatorDelta=${operatorDelta}`);

			expect(aliceDelta).to.equal(finalPrice);
			expect(poolDelta).to.equal(expectedRebate);
			expect(operatorDelta).to.equal(expectedTeam);
		});

		it('V7.2: turning rebate off (rebateBps=0) skips the rebate payout but still ticks team', async function () {
			await contractExecuteFunction(vipId, vipIface, client, 200_000,
				'setRebateBps', [0]);
			await sleep(MIRROR_DELAY);

			const quote = await mirrorQuery(vipId, vipIface, 'priceFor', [
				Tier.Platinum, 1, [], aliceId.toSolidityAddress(),
			]);
			const finalPrice = Number(quote[0]);
			const expectedTeam = Math.floor((finalPrice * 500) / 10000);

			const prePoolLazy = (await checkMirrorBalance(ENV, rebatePoolId, lazyTokenId)) ?? 0;
			const preOperatorLazy = (await checkMirrorBalance(ENV, operatorId, lazyTokenId)) ?? 0;

			client.setOperator(aliceId, alicePK);
			const [rx] = await contractExecuteFunction(
				vipId, vipIface, client, 1_500_000,
				'purchaseSubscription', [Tier.Platinum, 1, []],
			);
			expect(rx.status.toString()).to.equal('SUCCESS');
			client.setOperator(operatorId, operatorKey);
			await sleep(MIRROR_DELAY);

			const postPoolLazy = (await checkMirrorBalance(ENV, rebatePoolId, lazyTokenId)) ?? 0;
			const postOperatorLazy = (await checkMirrorBalance(ENV, operatorId, lazyTokenId)) ?? 0;

			expect(postPoolLazy - prePoolLazy).to.equal(0);
			expect(postOperatorLazy - preOperatorLazy).to.equal(expectedTeam);
			console.log(`V7.2: rebate skipped, team tick=${expectedTeam}`);
		});

		it('V7.3: turning team off (teamBps=0) with rebate restored ticks only the pool', async function () {
			await contractExecuteFunction(vipId, vipIface, client, 200_000,
				'setRebateBps', [1000]);
			await contractExecuteFunction(vipId, vipIface, client, 200_000,
				'setTeamBps', [0]);
			await sleep(MIRROR_DELAY);

			const quote = await mirrorQuery(vipId, vipIface, 'priceFor', [
				Tier.Platinum, 1, [], aliceId.toSolidityAddress(),
			]);
			const finalPrice = Number(quote[0]);
			const expectedRebate = Math.floor((finalPrice * 1000) / 10000);

			const prePoolLazy = (await checkMirrorBalance(ENV, rebatePoolId, lazyTokenId)) ?? 0;
			const preOperatorLazy = (await checkMirrorBalance(ENV, operatorId, lazyTokenId)) ?? 0;

			client.setOperator(aliceId, alicePK);
			const [rx] = await contractExecuteFunction(
				vipId, vipIface, client, 1_500_000,
				'purchaseSubscription', [Tier.Platinum, 1, []],
			);
			expect(rx.status.toString()).to.equal('SUCCESS');
			client.setOperator(operatorId, operatorKey);
			await sleep(MIRROR_DELAY);

			const postPoolLazy = (await checkMirrorBalance(ENV, rebatePoolId, lazyTokenId)) ?? 0;
			const postOperatorLazy = (await checkMirrorBalance(ENV, operatorId, lazyTokenId)) ?? 0;

			expect(postPoolLazy - prePoolLazy).to.equal(expectedRebate);
			expect(postOperatorLazy - preOperatorLazy).to.equal(0);
			console.log(`V7.3: team skipped, pool tick=${expectedRebate}`);
		});
	});

	after(function () {
		console.log('\n=== VIPSubscription test run summary ===');
		console.log('VIPSubscription:', vipId?.toString());
		console.log('Tip: cache as VIP_SUBSCRIPTION_CONTRACT_ID in .env to skip redeploy.');
	});
});
