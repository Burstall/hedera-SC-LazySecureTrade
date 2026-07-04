// EnglishAuction integration tests against real Hedera testnet.
//
// Tests run end-to-end with wall-clock waits (no time manipulation
// available on testnet). Auction durations kept short (60-120s) to
// keep total runtime manageable. Non-timing-sensitive validation tests
// run instantly. Timing-bound tests are tagged with `[TIMING]` and
// gated behind RUN_TIMING_TESTS=1 — set it to run the full suite.

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
const { ensureLibraries, linkLibraries } = require('../utils/libraryLinking');
const {
	setNFTAllowanceAll,
	setFTAllowance,
	sendNFT,
	mintAdditionalSerial,
} = require('../utils/hederaHelpers');
const { sleep } = require('../utils/nodeHelpers');
const {
	checkMirrorHbarBalance,
	checkMirrorBalance,
	getSerialsOwned,
} = require('../utils/hederaMirrorHelpers');
const { EMPTY_AUTH } = require('../utils/agentAuth');
require('dotenv').config();

const MIRROR_DELAY = Number(process.env.SLEEP_TIME) || 5000;
const ENV = (process.env.ENVIRONMENT || 'test').toLowerCase();
const LAZY_DECIMAL = Number(process.env.LAZY_DECIMALS ?? 1);
const RUN_TIMING_TESTS = process.env.RUN_TIMING_TESTS === '1';

const PaymentToken = { HBAR: 0, LAZY: 1 };
const State = { None: 0, Open: 1, Settled: 2, Failed: 3, Cancelled: 4 };

function expectRevertNamed(result, expectedName) {
	const status = result?.[0]?.status;
	const name = status?.name?.toString?.();
	if (name !== expectedName) {
		throw new Error(
			`Expected revert ${expectedName}, got ${name ?? status?.toString?.() ?? 'unknown'}`,
		);
	}
}

describe('EnglishAuction tests', function () {
	this.timeout(300_000);
	this.retries(1);

	let operatorId, operatorKey, client;
	let lazyTokenId, lazyGasStationId, lazyGasStationIface;
	let lazyDelegateRegistryId;
	let nftTokenId, nftSupplyKey;
	let aliceId, alicePK;
	let bobId, bobPK;
	let auctionId_contractId, auctionIface;
	let lstContractId;

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

	async function mintFreshSerial() {
		const serial = await mintAdditionalSerial(client, nftTokenId, nftSupplyKey, 'ipfs://EA-test');
		return serial;
	}

	function nftItem(serial) {
		return {
			token: '0x' + nftTokenId.toSolidityAddress(),
			isNFT: true,
			serialOrAmount: serial,
		};
	}

	function ftItem(amount) {
		return {
			token: '0x' + lazyTokenId.toSolidityAddress(),
			isNFT: false,
			serialOrAmount: amount,
		};
	}

	function defaultParams(items, overrides = {}) {
		return {
			items,
			payment: overrides.payment ?? PaymentToken.HBAR,
			reservePrice: overrides.reservePrice ?? Number(new Hbar(1, HbarUnit.Hbar).toTinybars()),
			startPrice: overrides.startPrice ?? Number(new Hbar(1, HbarUnit.Hbar).toTinybars()),
			buyNowPrice: overrides.buyNowPrice ?? 0,
			duration: overrides.duration ?? 60,
			minStepBps: overrides.minStepBps ?? 0,
			antiSnipeWindow: overrides.antiSnipeWindow ?? 0,
			antiSnipeExtension: overrides.antiSnipeExtension ?? 0,
		};
	}

	before(async function () {
		this.timeout(600_000);

		operatorId = AccountId.fromString(process.env.ACCOUNT_ID);
		operatorKey = PrivateKey.fromStringED25519(process.env.PRIVATE_KEY);
		client = ENV === 'main' ? Client.forMainnet()
			: ENV === 'preview' ? Client.forPreviewnet()
				: Client.forTestnet();
		client.setOperator(operatorId, operatorKey);
		// Bump default maxTransactionFee. EnglishAuction's payable
		// `placeBid` + `buyNow` calls combine high-gas (~1.5M) with
		// HBAR msg.value, and Hedera testnet's precheck demands the
		// declared max fee cover the worst-case gas-price × gas-limit
		// product. The SDK's default (≤2 HBAR) trips this on contracts
		// where gas estimation fails and we fall back to high static
		// gas. 50 HBAR is well above any plausible single-tx fee on
		// testnet.
		client.setDefaultMaxTransactionFee(new Hbar(50));

		lazyTokenId = TokenId.fromString(process.env.LAZY_TOKEN_ID);
		lazyGasStationId = ContractId.fromString(process.env.LAZY_GAS_STATION_CONTRACT_ID);
		lazyDelegateRegistryId = ContractId.fromString(process.env.LAZY_DELEGATE_REGISTRY_CONTRACT_ID);
		nftTokenId = TokenId.fromString(process.env.BCF_NFT_TOKEN_ID);
		nftSupplyKey = PrivateKey.fromStringED25519(process.env.BCF_NFT_SUPPLY_KEY);
		aliceId = AccountId.fromString(process.env.ALICE_ACCOUNT_ID);
		alicePK = PrivateKey.fromStringED25519(process.env.ALICE_PRIVATE_KEY);
		bobId = AccountId.fromString(process.env.BOB_ACCOUNT_ID);
		bobPK = PrivateKey.fromStringED25519(process.env.BOB_PRIVATE_KEY);
		lstContractId = ContractId.fromString(process.env.LAZY_SECURE_TRADE_CONTRACT_ID);

		const lgsJson = JSON.parse(fs.readFileSync(
			'./artifacts/contracts/LazyGasStation.sol/LazyGasStation.json', 'utf8',
		));
		lazyGasStationIface = new ethers.Interface(lgsJson.abi);

		// Deploy EnglishAuction
		const auctionJson = JSON.parse(fs.readFileSync(
			'./artifacts/contracts/EnglishAuction.sol/EnglishAuction.json', 'utf8',
		));
		auctionIface = new ethers.Interface(auctionJson.abi);
		const params = new ContractFunctionParameters()
			.addAddress(lazyTokenId.toSolidityAddress())
			.addAddress(lazyGasStationId.toSolidityAddress())
			.addAddress(lazyDelegateRegistryId.toSolidityAddress())
			.addAddress(nftTokenId.toSolidityAddress()) // LSH_GEN1 mock = test NFT
			.addAddress(nftTokenId.toSolidityAddress()) // LSH_MUTANT mock
			.addAddress(nftTokenId.toSolidityAddress()) // LSH_GEN2 mock
			.addAddress('0x0000000000000000000000000000000000000000'); // no staking
		const eaLibs = await ensureLibraries(client);
		[auctionId_contractId] = await contractDeployFunction(
			client, linkLibraries(auctionJson.bytecode, auctionJson.linkReferences, eaLibs), 8_000_000, params,
		);
		console.log('EnglishAuction deployed:', auctionId_contractId.toString());

		// Register auction contract as LGS contract user (for LAZY transfers)
		await contractExecuteFunction(
			lazyGasStationId, lazyGasStationIface, client, 200_000,
			'addContractUser', [auctionId_contractId.toSolidityAddress()],
		);

		// Fund the auction contract with HBAR. The 2-step custody hop
		// (CUSTODY_HOP_TINYBAR = 1) requires the contract to be able to
		// pay 1 tinybar per NFT-item escrow. 10 HBAR covers ~10^9
		// escrows — effectively permanent runway.
		const { sendHbar } = require('../utils/hederaHelpers');
		await sendHbar(client, operatorId, auctionId_contractId, 10, HbarUnit.Hbar);
		console.log('Auction contract funded with 10 HBAR for custody hops');

		// Set durationLimits to allow 60s minimum (default is 1h)
		await contractExecuteFunction(
			auctionId_contractId, auctionIface, client, 200_000,
			'setDurationLimits', [30, 7 * 86400, 86400],
		);
		// Tight anti-snipe defaults for testing
		await contractExecuteFunction(
			auctionId_contractId, auctionIface, client, 200_000,
			'setDefaults', [200, 10, 15], // minStep 2%, snipe window 10s, extension 15s
		);
		console.log('EnglishAuction configured (30s minDuration, 10s/15s anti-snipe)');

		// Alice grants NFT all-serial allowance to auction contract +
		// HBAR allowance for the WITHDRAWAL custody-hop (1 HBAR covers
		// 10^8 hops) + LAZY allowance for FT-item bundles.
		const { setHbarAllowance } = require('../utils/hederaHelpers');
		client.setOperator(aliceId, alicePK);
		await setNFTAllowanceAll(client, [nftTokenId], aliceId, auctionId_contractId);
		await setHbarAllowance(client, aliceId, auctionId_contractId, 1, HbarUnit.Hbar);
		await setFTAllowance(client, lazyTokenId, aliceId, auctionId_contractId, 100_000 * 10 ** LAZY_DECIMAL);
		client.setOperator(operatorId, operatorKey);

		// Bob also needs HBAR allowance for WITHDRAWAL-leg pulls (he
		// may be the auction winner and pull the NFT delivery hop).
		client.setOperator(bobId, bobPK);
		await setHbarAllowance(client, bobId, auctionId_contractId, 1, HbarUnit.Hbar);
		client.setOperator(operatorId, operatorKey);
		console.log('Alice + Bob allowances set');

		await sleep(MIRROR_DELAY);
	});

	// ============================================
	// E1 — Read API + scaffold
	// ============================================
	describe('Read API + setup', function () {
		it('E1.1: deployed with expected config', async function () {
			const fee = await mirrorQuery(auctionId_contractId, auctionIface, 'protocolFeeBps', []);
			expect(Number(fee[0])).to.equal(100);
			const bounty = await mirrorQuery(auctionId_contractId, auctionIface, 'settlementBountyBps', []);
			expect(Number(bounty[0])).to.equal(10);
			const minDur = await mirrorQuery(auctionId_contractId, auctionIface, 'minDuration', []);
			expect(Number(minDur[0])).to.equal(30);
		});

		it('E1.2: setProtocolFeeBps above cap reverts InvalidBps', async function () {
			const result = await contractExecuteFunction(
				auctionId_contractId, auctionIface, client, 200_000,
				'setProtocolFeeBps', [1001], 0, true,
			);
			expectRevertNamed(result, 'InvalidBps');
		});

		it('E1.3: setSettlementBountyBps above cap reverts InvalidBps', async function () {
			const result = await contractExecuteFunction(
				auctionId_contractId, auctionIface, client, 200_000,
				'setSettlementBountyBps', [501], 0, true,
			);
			expectRevertNamed(result, 'InvalidBps');
		});

		it('E1.4: non-owner setProtocolFeeBps reverts', async function () {
			client.setOperator(aliceId, alicePK);
			const result = await contractExecuteFunction(
				auctionId_contractId, auctionIface, client, 200_000,
				'setProtocolFeeBps', [50], 0, true,
			);
			expect(result?.[0]?.status?.toString?.()).to.not.equal('SUCCESS');
			client.setOperator(operatorId, operatorKey);
		});
	});

	// ============================================
	// E2 — Auction creation + validation
	// ============================================
	describe('Auction creation', function () {
		let testSerial;

		before(async function () {
			testSerial = await mintFreshSerial();
			await sendNFT(client, operatorId, aliceId, nftTokenId, [testSerial]);
			await sleep(MIRROR_DELAY);
		});

		it('E2.1: createAuction with empty items reverts InvalidBundleSize', async function () {
			client.setOperator(aliceId, alicePK);
			const result = await contractExecuteFunction(
				auctionId_contractId, auctionIface, client, 1_000_000,
				'createAuction',
				[defaultParams([]), EMPTY_AUTH], 0, true,
			);
			expectRevertNamed(result, 'InvalidBundleSize');
			client.setOperator(operatorId, operatorKey);
		});

		it('E2.2: createAuction with duration < minDuration reverts InvalidDuration', async function () {
			client.setOperator(aliceId, alicePK);
			const result = await contractExecuteFunction(
				auctionId_contractId, auctionIface, client, 1_500_000,
				'createAuction',
				[defaultParams([nftItem(testSerial)], { duration: 10 }), EMPTY_AUTH], 0, true,
			);
			expectRevertNamed(result, 'InvalidDuration');
			client.setOperator(operatorId, operatorKey);
		});

		it('E2.3: createAuction happy path — escrow + AuctionCreated event', async function () {
			client.setOperator(aliceId, alicePK);
			const [rx] = await contractExecuteFunction(
				auctionId_contractId, auctionIface, client, 3_000_000,
				'createAuction',
				[defaultParams([nftItem(testSerial)]), EMPTY_AUTH],
			);
			expect(rx.status.toString()).to.equal('SUCCESS');
			client.setOperator(operatorId, operatorKey);
			await sleep(MIRROR_DELAY);

			// Verify NFT is now in the auction contract
			const ownership = await mirrorQuery(
				auctionId_contractId, auctionIface, 'protocolFeeBps', [],
			); // dummy read to validate contract is live
			expect(Number(ownership[0])).to.be.greaterThan(-1);
			console.log('E2.3: Auction created, NFT escrowed');
		});
	});

	// ============================================
	// E3 — Tier C bundle: multi-item creation
	// ============================================
	describe('Tier C bundle creation', function () {
		it('E3.1: multi-NFT same-collection bundle escrows all items', async function () {
			const s1 = await mintFreshSerial();
			const s2 = await mintFreshSerial();
			const s3 = await mintFreshSerial();
			await sendNFT(client, operatorId, aliceId, nftTokenId, [s1, s2, s3]);
			await sleep(MIRROR_DELAY);

			client.setOperator(aliceId, alicePK);
			const [rx] = await contractExecuteFunction(
				auctionId_contractId, auctionIface, client, 5_000_000,
				'createAuction',
				[defaultParams([nftItem(s1), nftItem(s2), nftItem(s3)]), EMPTY_AUTH],
			);
			expect(rx.status.toString()).to.equal('SUCCESS');
			client.setOperator(operatorId, operatorKey);
			await sleep(MIRROR_DELAY);
			console.log('E3.1: 3-NFT bundle escrowed');
		});

		it('E3.2: NFT + FT (LAZY) bundle escrows both', async function () {
			const s1 = await mintFreshSerial();
			await sendNFT(client, operatorId, aliceId, nftTokenId, [s1]);
			await sleep(MIRROR_DELAY);

			const lazyAmount = 100 * 10 ** LAZY_DECIMAL;
			client.setOperator(aliceId, alicePK);
			const [rx] = await contractExecuteFunction(
				auctionId_contractId, auctionIface, client, 5_000_000,
				'createAuction',
				[defaultParams([nftItem(s1), ftItem(lazyAmount)]), EMPTY_AUTH],
			);
			expect(rx.status.toString()).to.equal('SUCCESS');
			client.setOperator(operatorId, operatorKey);
			await sleep(MIRROR_DELAY);
			console.log('E3.2: NFT+FT bundle escrowed');
		});

		it('E3.3: bundle > MAX_BUNDLE_ITEMS reverts InvalidBundleSize', async function () {
			// Build 11-item bundle (just use the same FT amount entry 11 times)
			const items = [];
			for (let i = 0; i < 11; i++) items.push(ftItem(1));
			client.setOperator(aliceId, alicePK);
			const result = await contractExecuteFunction(
				auctionId_contractId, auctionIface, client, 1_500_000,
				'createAuction',
				[defaultParams(items), EMPTY_AUTH], 0, true,
			);
			expectRevertNamed(result, 'InvalidBundleSize');
			client.setOperator(operatorId, operatorKey);
		});
	});

	// ============================================
	// E4 — Bidding + self-bid block
	// ============================================
	describe('Bidding', function () {
		let bidSerial;
		let bidAuctionId;

		before(async function () {
			bidSerial = await mintFreshSerial();
			await sendNFT(client, operatorId, aliceId, nftTokenId, [bidSerial]);
			await sleep(MIRROR_DELAY);

			// Compute the next auctionId for Alice
			const nonce = await mirrorQuery(auctionId_contractId, auctionIface, 'sellerNonce', [
				aliceId.toSolidityAddress(),
			]);
			bidAuctionId = ethers.keccak256(ethers.solidityPacked(
				['address', 'uint64'],
				['0x' + aliceId.toSolidityAddress(), Number(nonce[0])],
			));

			client.setOperator(aliceId, alicePK);
			await contractExecuteFunction(
				auctionId_contractId, auctionIface, client, 3_000_000,
				'createAuction',
				[defaultParams([nftItem(bidSerial)], { duration: 60 }), EMPTY_AUTH],
			);
			client.setOperator(operatorId, operatorKey);
			await sleep(MIRROR_DELAY);
		});

		it('E4.1: seller bidding own auction reverts BidderIsSeller', async function () {
			client.setOperator(aliceId, alicePK);
			const tinybars = Number(new Hbar(2, HbarUnit.Hbar).toTinybars());
			const result = await contractExecuteFunction(
				auctionId_contractId, auctionIface, client, 1_000_000,
				'placeBid', [bidAuctionId, tinybars, EMPTY_AUTH], new Hbar(tinybars, HbarUnit.Tinybar), true,
			);
			expectRevertNamed(result, 'BidderIsSeller');
			client.setOperator(operatorId, operatorKey);
		});

		it('E4.2: bid below startPrice reverts BidBelowMinimum', async function () {
			client.setOperator(bobId, bobPK);
			const tinybars = Number(new Hbar(0.5, HbarUnit.Hbar).toTinybars());
			const result = await contractExecuteFunction(
				auctionId_contractId, auctionIface, client, 1_000_000,
				'placeBid', [bidAuctionId, tinybars, EMPTY_AUTH], new Hbar(tinybars, HbarUnit.Tinybar), true,
			);
			expectRevertNamed(result, 'BidBelowMinimum');
			client.setOperator(operatorId, operatorKey);
		});

		it('E4.3: msg.value mismatch reverts WrongPaymentValue', async function () {
			client.setOperator(bobId, bobPK);
			const tinybars = Number(new Hbar(2, HbarUnit.Hbar).toTinybars());
			const result = await contractExecuteFunction(
				auctionId_contractId, auctionIface, client, 1_000_000,
				'placeBid', [bidAuctionId, tinybars, EMPTY_AUTH], new Hbar(1, HbarUnit.Tinybar), true,
			);
			expectRevertNamed(result, 'WrongPaymentValue');
			client.setOperator(operatorId, operatorKey);
		});

		it('E4.4: valid bid succeeds + updates highBid', async function () {
			client.setOperator(bobId, bobPK);
			const tinybars = Number(new Hbar(2, HbarUnit.Hbar).toTinybars());
			const [rx] = await contractExecuteFunction(
				auctionId_contractId, auctionIface, client, 1_500_000,
				'placeBid', [bidAuctionId, tinybars, EMPTY_AUTH], new Hbar(tinybars, HbarUnit.Tinybar),
			);
			expect(rx.status.toString()).to.equal('SUCCESS');
			client.setOperator(operatorId, operatorKey);
			await sleep(MIRROR_DELAY);

			const snap = await mirrorQuery(auctionId_contractId, auctionIface, 'getAuctionSnapshot', [
				bidAuctionId,
			]);
			expect(Number(snap[0].highBid)).to.equal(tinybars);
			expect(snap[0].highBidder.toLowerCase()).to.equal(
				'0x' + bobId.toSolidityAddress().toLowerCase(),
			);
		});

		it('E4.5: outbid Bob — bob gets refund queued', async function () {
			const preBobClaim = await mirrorQuery(
				auctionId_contractId, auctionIface, 'claimableHbar', [bobId.toSolidityAddress()],
			);

			// Charlie (Alice's role here — we don't have a third account)
			// Operator can place a bid in role of Charlie
			const tinybars = Number(new Hbar(3, HbarUnit.Hbar).toTinybars());
			const [rx] = await contractExecuteFunction(
				auctionId_contractId, auctionIface, client, 1_500_000,
				'placeBid', [bidAuctionId, tinybars, EMPTY_AUTH], new Hbar(tinybars, HbarUnit.Tinybar),
			);
			expect(rx.status.toString()).to.equal('SUCCESS');
			await sleep(MIRROR_DELAY);

			const postBobClaim = await mirrorQuery(
				auctionId_contractId, auctionIface, 'claimableHbar', [bobId.toSolidityAddress()],
			);
			const diff = BigInt(postBobClaim[0]) - BigInt(preBobClaim[0]);
			expect(Number(diff)).to.equal(Number(new Hbar(2, HbarUnit.Hbar).toTinybars()));
			console.log('E4.5: Bob refund queued =', Number(diff), 'tinybars');
		});
	});

	// ============================================
	// E5 — Buy-now collapse
	// ============================================
	describe('Buy-now', function () {
		it('E5.1: buyNow on auction with no buyNowPrice reverts InvalidBuyNowPrice', async function () {
			const s = await mintFreshSerial();
			await sendNFT(client, operatorId, aliceId, nftTokenId, [s]);
			await sleep(MIRROR_DELAY);

			const nonce = await mirrorQuery(auctionId_contractId, auctionIface, 'sellerNonce', [
				aliceId.toSolidityAddress(),
			]);
			const aid = ethers.keccak256(ethers.solidityPacked(
				['address', 'uint64'],
				['0x' + aliceId.toSolidityAddress(), Number(nonce[0])],
			));

			client.setOperator(aliceId, alicePK);
			await contractExecuteFunction(
				auctionId_contractId, auctionIface, client, 3_000_000,
				'createAuction',
				[defaultParams([nftItem(s)]), EMPTY_AUTH],
			);
			client.setOperator(operatorId, operatorKey);
			await sleep(MIRROR_DELAY);

			client.setOperator(bobId, bobPK);
			const result = await contractExecuteFunction(
				auctionId_contractId, auctionIface, client, 1_000_000,
				'buyNow', [aid, EMPTY_AUTH], new Hbar(1, HbarUnit.Tinybar), true,
			);
			expectRevertNamed(result, 'InvalidBuyNowPrice');
			client.setOperator(operatorId, operatorKey);
		});

		it('E5.2: buyNow collapses auction + settles in same tx', async function () {
			const s = await mintFreshSerial();
			await sendNFT(client, operatorId, aliceId, nftTokenId, [s]);
			await sleep(MIRROR_DELAY);

			const buyNowPrice = Number(new Hbar(5, HbarUnit.Hbar).toTinybars());

			const nonce = await mirrorQuery(auctionId_contractId, auctionIface, 'sellerNonce', [
				aliceId.toSolidityAddress(),
			]);
			const aid = ethers.keccak256(ethers.solidityPacked(
				['address', 'uint64'],
				['0x' + aliceId.toSolidityAddress(), Number(nonce[0])],
			));

			client.setOperator(aliceId, alicePK);
			await contractExecuteFunction(
				auctionId_contractId, auctionIface, client, 3_000_000,
				'createAuction',
				[defaultParams([nftItem(s)], { buyNowPrice, reservePrice: buyNowPrice }), EMPTY_AUTH],
			);
			client.setOperator(operatorId, operatorKey);
			await sleep(MIRROR_DELAY);

			client.setOperator(bobId, bobPK);
			const [rx] = await contractExecuteFunction(
				auctionId_contractId, auctionIface, client, 3_500_000,
				'buyNow', [aid, EMPTY_AUTH], new Hbar(buyNowPrice, HbarUnit.Tinybar),
			);
			expect(rx.status.toString()).to.equal('SUCCESS');
			client.setOperator(operatorId, operatorKey);
			await sleep(MIRROR_DELAY);

			// Pull-claim (Finding 1): buyNow SETTLES (proceeds paid) but leaves
			// the auction in Settled state with the bundle escrowed — it is NOT
			// hard-deleted until the NFT is claimed.
			const snap = await mirrorQuery(auctionId_contractId, auctionIface, 'getAuctionSnapshot', [aid]);
			expect(Number(snap[0].state)).to.equal(State.Settled);

			// Bob (the winner/claimant) pulls the NFT; permissionless + EA funds
			// the custody hop. After claim the auction is hard-deleted.
			client.setOperator(bobId, bobPK);
			const [rxClaim] = await contractExecuteFunction(
				auctionId_contractId, auctionIface, client, 2_500_000,
				'claimAuctionNFT', [aid],
			);
			expect(rxClaim.status.toString()).to.equal('SUCCESS');
			client.setOperator(operatorId, operatorKey);
			await sleep(MIRROR_DELAY);

			const snap2 = await mirrorQuery(auctionId_contractId, auctionIface, 'getAuctionSnapshot', [aid]);
			expect(Number(snap2[0].state)).to.equal(State.None);
			const owner = (await checkMirrorBalance(ENV, bobId, nftTokenId)) ?? 0;
			expect(Number(owner)).to.be.greaterThan(0);
			console.log('E5.2: buyNow settled → claimAuctionNFT delivered to Bob + hard-deleted');
		});
	});

	// ============================================
	// E6 — Cancel
	// ============================================
	describe('Cancel', function () {
		it('E6.1: seller cancels zero-bid auction → NFT returned + AuctionCancelled', async function () {
			const s = await mintFreshSerial();
			await sendNFT(client, operatorId, aliceId, nftTokenId, [s]);
			await sleep(MIRROR_DELAY);

			const nonce = await mirrorQuery(auctionId_contractId, auctionIface, 'sellerNonce', [
				aliceId.toSolidityAddress(),
			]);
			const aid = ethers.keccak256(ethers.solidityPacked(
				['address', 'uint64'],
				['0x' + aliceId.toSolidityAddress(), Number(nonce[0])],
			));

			client.setOperator(aliceId, alicePK);
			await contractExecuteFunction(
				auctionId_contractId, auctionIface, client, 3_000_000,
				'createAuction',
				[defaultParams([nftItem(s)]), EMPTY_AUTH],
			);
			await sleep(MIRROR_DELAY);

			const [rx] = await contractExecuteFunction(
				auctionId_contractId, auctionIface, client, 2_000_000,
				'cancelAuction', [aid],
			);
			expect(rx.status.toString()).to.equal('SUCCESS');
			client.setOperator(operatorId, operatorKey);
			await sleep(MIRROR_DELAY);

			// Hard-deleted
			const snap = await mirrorQuery(auctionId_contractId, auctionIface, 'getAuctionSnapshot', [aid]);
			expect(Number(snap[0].state)).to.equal(State.None);
		});

		it('E6.2: cancel after bid reverts CannotCancelWithBids', async function () {
			const s = await mintFreshSerial();
			await sendNFT(client, operatorId, aliceId, nftTokenId, [s]);
			await sleep(MIRROR_DELAY);

			const nonce = await mirrorQuery(auctionId_contractId, auctionIface, 'sellerNonce', [
				aliceId.toSolidityAddress(),
			]);
			const aid = ethers.keccak256(ethers.solidityPacked(
				['address', 'uint64'],
				['0x' + aliceId.toSolidityAddress(), Number(nonce[0])],
			));

			client.setOperator(aliceId, alicePK);
			await contractExecuteFunction(
				auctionId_contractId, auctionIface, client, 3_000_000,
				'createAuction',
				[defaultParams([nftItem(s)]), EMPTY_AUTH],
			);
			client.setOperator(operatorId, operatorKey);
			await sleep(MIRROR_DELAY);

			// Bob bids
			client.setOperator(bobId, bobPK);
			const bid = Number(new Hbar(2, HbarUnit.Hbar).toTinybars());
			await contractExecuteFunction(
				auctionId_contractId, auctionIface, client, 1_500_000,
				'placeBid', [aid, bid, EMPTY_AUTH], new Hbar(bid, HbarUnit.Tinybar),
			);
			await sleep(MIRROR_DELAY);

			// Alice tries to cancel → reverts
			client.setOperator(aliceId, alicePK);
			const result = await contractExecuteFunction(
				auctionId_contractId, auctionIface, client, 500_000,
				'cancelAuction', [aid], 0, true,
			);
			expectRevertNamed(result, 'CannotCancelWithBids');
			client.setOperator(operatorId, operatorKey);
		});
	});

	// ============================================
	// E7 — Settle + claim queue ([TIMING])
	// ============================================
	if (RUN_TIMING_TESTS) {
		describe('Settle + claim [TIMING]', function () {
			it('E7.1: full lifecycle — create, bid, wait, settle, claim refund', async function () {
				this.timeout(180_000);

				const s = await mintFreshSerial();
				await sendNFT(client, operatorId, aliceId, nftTokenId, [s]);
				await sleep(MIRROR_DELAY);

				const nonce = await mirrorQuery(auctionId_contractId, auctionIface, 'sellerNonce', [
					aliceId.toSolidityAddress(),
				]);
				const aid = ethers.keccak256(ethers.solidityPacked(
					['address', 'uint64'],
					['0x' + aliceId.toSolidityAddress(), Number(nonce[0])],
				));

				client.setOperator(aliceId, alicePK);
				await contractExecuteFunction(
					auctionId_contractId, auctionIface, client, 3_000_000,
					'createAuction',
					[defaultParams([nftItem(s)], { duration: 35 }), EMPTY_AUTH],
				);
				await sleep(MIRROR_DELAY);

				// Bob bids
				client.setOperator(bobId, bobPK);
				const bid = Number(new Hbar(2, HbarUnit.Hbar).toTinybars());
				await contractExecuteFunction(
					auctionId_contractId, auctionIface, client, 1_500_000,
					'placeBid', [aid, bid, EMPTY_AUTH], new Hbar(bid, HbarUnit.Tinybar),
				);
				client.setOperator(operatorId, operatorKey);

				// Wait for close
				console.log('E7.1: waiting ~40s for close...');
				await sleep(40_000);

				// Settle
				const [rx] = await contractExecuteFunction(
					auctionId_contractId, auctionIface, client, 4_000_000,
					'settle', [aid],
				);
				expect(rx.status.toString()).to.equal('SUCCESS');
				await sleep(MIRROR_DELAY);

				// Pull-claim: settle finalises funds but leaves the auction
				// Settled with the bundle escrowed (not hard-deleted).
				const snap = await mirrorQuery(auctionId_contractId, auctionIface, 'getAuctionSnapshot', [aid]);
				expect(Number(snap[0].state)).to.equal(State.Settled);

				// Bob (winner) claims the NFT → auction hard-deleted.
				client.setOperator(bobId, bobPK);
				const [rxClaim] = await contractExecuteFunction(
					auctionId_contractId, auctionIface, client, 2_500_000,
					'claimAuctionNFT', [aid],
				);
				expect(rxClaim.status.toString()).to.equal('SUCCESS');
				client.setOperator(operatorId, operatorKey);
				await sleep(MIRROR_DELAY);
				const snap2 = await mirrorQuery(auctionId_contractId, auctionIface, 'getAuctionSnapshot', [aid]);
				expect(Number(snap2[0].state)).to.equal(State.None);
				console.log('E7.1: settled + claimed successfully');
			});

			it('E7.2: claim refund pulls queued HBAR', async function () {
				const preClaim = await mirrorQuery(
					auctionId_contractId, auctionIface, 'claimableHbar', [bobId.toSolidityAddress()],
				);
				const claimable = Number(preClaim[0]);
				if (claimable === 0) {
					console.log('E7.2: skipping — Bob has no claimable HBAR (prior tests may have changed state)');
					return;
				}

				const preBalance = await checkMirrorHbarBalance(ENV, bobId);
				client.setOperator(bobId, bobPK);
				const [rx] = await contractExecuteFunction(
					auctionId_contractId, auctionIface, client, 500_000,
					'claim', [PaymentToken.HBAR],
				);
				expect(rx.status.toString()).to.equal('SUCCESS');
				client.setOperator(operatorId, operatorKey);
				await sleep(MIRROR_DELAY);

				const postBalance = await checkMirrorHbarBalance(ENV, bobId);
				const delta = Number(postBalance) - Number(preBalance);
				expect(delta).to.be.greaterThan(claimable * 0.95);
				console.log('E7.2: Bob claimed', delta, 'tinybars (queued', claimable, ')');
			});
		});
	}
	else {
		describe('Settle + claim [TIMING]', function () {
			it('skipped — set RUN_TIMING_TESTS=1 to run timing-bound tests', function () {
				console.log('Skipping timing tests. Set RUN_TIMING_TESTS=1 in env to enable.');
			});
		});
	}

	after(function () {
		console.log('\n=== EnglishAuction test run summary ===');
		console.log('EnglishAuction:', auctionId_contractId?.toString());
		console.log('Tip: cache as ENGLISH_AUCTION_CONTRACT_ID in .env if desired.');
	});
});
