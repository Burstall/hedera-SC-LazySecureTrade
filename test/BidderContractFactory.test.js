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
	accountCreator,
	associateTokensToAccount,
	mintNFT,
	sendNFT,
	setNFTAllowanceAll,
	sendHbar,
	setHbarAllowance,
	setFTAllowance,
} = require('../utils/hederaHelpers');
const {
	checkMirrorHbarBalance,
	checkMirrorBalance,
} = require('../utils/hederaMirrorHelpers');
const { sleep } = require('../utils/nodeHelpers');
require('dotenv').config();

// ============================================
// Configuration
// ============================================

let operatorKey;
let operatorId;
try {
	operatorKey = PrivateKey.fromStringED25519(process.env.PRIVATE_KEY);
	operatorId = AccountId.fromString(process.env.ACCOUNT_ID);
}
catch (err) {
	console.log('ERROR: Must specify PRIVATE_KEY & ACCOUNT_ID in the .env file');
}

const env = process.env.ENVIRONMENT ?? null;
const LAZY_BURN_PERCENT = process.env.LAZY_BURN_PERCENT ?? 25;
const LAZY_DECIMAL = process.env.LAZY_DECIMALS ?? 1;
const LAZY_MAX_SUPPLY = process.env.LAZY_MAX_SUPPLY ?? 250_000_000;
const LAZY_COST_FOR_TRADE = process.env.LAZY_COST_FOR_TRADE ?? 103;
const MIRROR_DELAY = 5500;

// ============================================
// Shared state (populated in scaffold, reused in tests)
// ============================================

let client;

// Core contracts
let lazySCT, lazyTokenId, lazyGasStationId, ldrContractId, lstContractId;
let lazyIface, lazyGasStationIface, lstIface, ldrIface;
let bidderFactoryId, bidderFactoryIface;
let bidderContractIface;

// Test accounts
let alicePK, aliceId; // Seller / NFT holder
let bobPK, bobId; // Bidder / stash owner
let carolPK, carolId; // Arbitrageur (third party)

// NFT collection (with royalty, minted to operator then distributed)
let nftTokenId, nftSupplyKey;

// Stash addresses (populated during tests)
let bobStashAddress, bobStashId;
let carolStashAddress, carolStashId;

// ============================================
// Helper: mirror-node read (encode → REST → decode)
// ============================================
async function mirrorQuery(contractId, iface, fcnName, params = []) {
	const encoded = iface.encodeFunctionData(fcnName, params);
	const raw = await readOnlyEVMFromMirrorNode(env, contractId, encoded, operatorId, false);
	return iface.decodeFunctionResult(fcnName, raw);
}

// ============================================
// Helper: mint a fresh NFT serial and return its number
// ============================================
async function mintFreshSerial() {
	const mintTx = new (require('@hashgraph/sdk').TokenMintTransaction)()
		.setTokenId(nftTokenId)
		.addMetadata(Buffer.from('ipfs://bafybeihbyr6ldwpowrejyzq623lv374kggemmvebdyanrayuviufdhi6xu/metadata.json'))
		.setMaxTransactionFee(new Hbar(10, HbarUnit.Hbar));

	mintTx.freezeWith(client);
	const signed = await mintTx.sign(nftSupplyKey);
	const resp = await signed.execute(client);
	const receipt = await resp.getReceipt(client);
	return receipt.serials[0].toNumber();
}

// ============================================
// Test Suite
// ============================================

describe('BidderContractFactory v0.3 Tests', function () {
	this.timeout(300_000); // 5 min — live testnet ops are slow

	// ============================================
	// Top-level scaffold: deploy core contracts ONCE
	// ============================================
	before(async function () {
		this.timeout(600_000); // 10 min for full scaffold

		if (!operatorKey || !operatorId || !env) {
			console.log('ERROR: .env must have ENVIRONMENT, ACCOUNT_ID, PRIVATE_KEY');
			process.exit(1);
		}

		// --- Client setup
		if (env.toUpperCase() === 'TEST') client = Client.forTestnet();
		else if (env.toUpperCase() === 'PREVIEW') client = Client.forPreviewnet();
		else if (env.toUpperCase() === 'LOCAL') {
			const node = { '127.0.0.1:50211': new AccountId(3) };
			client = Client.forNetwork(node).setMirrorNetwork('127.0.0.1:5600');
		}
		else {
			console.log('ERROR: ENVIRONMENT must be test|preview|local');
			process.exit(1);
		}
		client.setOperator(operatorId, operatorKey);
		console.log(`\n=== Scaffold: ${env.toUpperCase()} ===`);
		console.log('Operator:', operatorId.toString());

		// --- Create test accounts
		alicePK = PrivateKey.generateED25519();
		aliceId = await accountCreator(client, alicePK, 200, 10);
		console.log('Alice:', aliceId.toString());

		bobPK = PrivateKey.generateED25519();
		bobId = await accountCreator(client, bobPK, 200, 10);
		console.log('Bob:', bobId.toString());

		carolPK = PrivateKey.generateED25519();
		carolId = await accountCreator(client, carolPK, 50, 10);
		console.log('Carol:', carolId.toString());

		// --- Deploy LAZYTokenCreator + mint $LAZY
		const lazyJson = JSON.parse(
			fs.readFileSync('./artifacts/contracts/legacy/LAZYTokenCreator.sol/LAZYTokenCreator.json', 'utf8'),
		);
		lazyIface = new ethers.Interface(lazyJson.abi);

		if (process.env.LAZY_SCT_CONTRACT_ID && process.env.LAZY_TOKEN_ID) {
			lazySCT = ContractId.fromString(process.env.LAZY_SCT_CONTRACT_ID);
			lazyTokenId = TokenId.fromString(process.env.LAZY_TOKEN_ID);
			console.log('Reusing LAZY SCT:', lazySCT.toString(), 'Token:', lazyTokenId.toString());
		}
		else {
			[lazySCT] = await contractDeployFunction(client, lazyJson.bytecode, 5_800_000);
			console.log('LAZY SCT deployed:', lazySCT.toString());

			// Mint $LAZY
			const [, lazySCTResult] = await contractExecuteFunction(
				lazySCT, lazyIface, client, 3_000_000,
				'createFungibleWithBurn',
				['Test_Lazy', 'TLAZY', `${LAZY_MAX_SUPPLY}`, LAZY_DECIMAL, 30],
				15,
			);
			lazyTokenId = TokenId.fromSolidityAddress(lazySCTResult[0]);
			console.log('$LAZY minted:', lazyTokenId.toString());
		}

		// --- Deploy LazyGasStation
		const lgsJson = JSON.parse(
			fs.readFileSync('./artifacts/contracts/LazyGasStation.sol/LazyGasStation.json', 'utf8'),
		);
		lazyGasStationIface = new ethers.Interface(lgsJson.abi);

		if (process.env.LAZY_GAS_STATION_CONTRACT_ID) {
			lazyGasStationId = ContractId.fromString(process.env.LAZY_GAS_STATION_CONTRACT_ID);
			console.log('Reusing LGS:', lazyGasStationId.toString());
		}
		else {
			const lgsParams = new ContractFunctionParameters()
				.addAddress(lazyTokenId.toSolidityAddress())
				.addAddress(lazySCT.toSolidityAddress());
			[lazyGasStationId] = await contractDeployFunction(client, lgsJson.bytecode, 1_200_000, lgsParams);
			console.log('LGS deployed:', lazyGasStationId.toString());

			// Fund LGS with HBAR + $LAZY
			await sendHbar(client, operatorId, lazyGasStationId, 50, HbarUnit.Hbar);
			await contractExecuteFunction(lazySCT, lazyIface, client, 400_000, 'transferLazy', [lazyGasStationId.toSolidityAddress(), 50_000 * 10 ** LAZY_DECIMAL]);
		}

		// --- Deploy LazyDelegateRegistry
		const ldrJson = JSON.parse(
			fs.readFileSync('./artifacts/contracts/LazyDelegateRegistry.sol/LazyDelegateRegistry.json', 'utf8'),
		);
		ldrIface = new ethers.Interface(ldrJson.abi);

		if (process.env.LAZY_DELEGATE_REGISTRY_CONTRACT_ID) {
			ldrContractId = ContractId.fromString(process.env.LAZY_DELEGATE_REGISTRY_CONTRACT_ID);
			console.log('Reusing LDR:', ldrContractId.toString());
		}
		else {
			[ldrContractId] = await contractDeployFunction(client, ldrJson.bytecode, 1_200_000);
			console.log('LDR deployed:', ldrContractId.toString());
		}

		// --- Mint an NFT collection with 2% royalty + fallback
		client.setOperator(operatorId, operatorKey);
		nftSupplyKey = PrivateKey.generateED25519();
		const [nftStatus, mintedTokenId] = await mintNFT(
			client, operatorId, 'TestNFT_v03', 'TNFT03', 50, 50, nftSupplyKey,
		);
		expect(nftStatus).to.equal('SUCCESS');
		nftTokenId = mintedTokenId;
		console.log('NFT collection:', nftTokenId.toString());

		// --- Deploy LST (with mock LSH tokens = our test NFTs)
		const lstJson = JSON.parse(
			fs.readFileSync('./artifacts/contracts/LazySecureTrade.sol/LazySecureTrade.json', 'utf8'),
		);
		lstIface = new ethers.Interface(lstJson.abi);

		if (process.env.LAZY_SECURE_TRADE_CONTRACT_ID) {
			lstContractId = ContractId.fromString(process.env.LAZY_SECURE_TRADE_CONTRACT_ID);
			console.log('Reusing LST:', lstContractId.toString());
		}
		else {
			const lstParams = new ContractFunctionParameters()
				.addAddress(lazyTokenId.toSolidityAddress())
				.addAddress(lazyGasStationId.toSolidityAddress())
				.addAddress(ldrContractId.toSolidityAddress())
				.addAddress(nftTokenId.toSolidityAddress()) // LSH_GEN1 (mock — just need a valid NFT token)
				.addAddress(nftTokenId.toSolidityAddress()) // LSH_GEN2 (mock)
				.addAddress(nftTokenId.toSolidityAddress()) // LSH_GEN1_MUTANT (mock)
				.addUint256(LAZY_COST_FOR_TRADE * 10 ** LAZY_DECIMAL)
				.addUint256(LAZY_BURN_PERCENT);
			[lstContractId] = await contractDeployFunction(client, lstJson.bytecode, 6_000_000, lstParams);
			console.log('LST deployed:', lstContractId.toString());

			// Fund LST with HBAR for gas
			await sendHbar(client, operatorId, lstContractId, 30, HbarUnit.Hbar);

			// Register LST as a contract user on LGS
			await contractExecuteFunction(lazyGasStationId, lazyGasStationIface, client, 200_000, 'addContractUser', [lstContractId.toSolidityAddress()]);
		}

		// --- Deploy BidderContract implementation
		const bcJson = JSON.parse(
			fs.readFileSync('./artifacts/contracts/BidderContract.sol/BidderContract.json', 'utf8'),
		);
		bidderContractIface = new ethers.Interface(bcJson.abi);

		const [bidderImplId] = await contractDeployFunction(client, bcJson.bytecode, 1_500_000);
		console.log('BidderContract impl:', bidderImplId.toString());

		// --- Deploy BidderContractFactory
		const factoryJson = JSON.parse(
			fs.readFileSync('./artifacts/contracts/BidderContractFactory.sol/BidderContractFactory.json', 'utf8'),
		);
		bidderFactoryIface = new ethers.Interface(factoryJson.abi);

		const factoryParams = new ContractFunctionParameters()
			.addAddress(lstContractId.toSolidityAddress())
			.addAddress(lazyTokenId.toSolidityAddress())
			.addAddress(lazyGasStationId.toSolidityAddress())
			.addAddress(ldrContractId.toSolidityAddress())
			.addAddress(bidderImplId.toSolidityAddress());
		[bidderFactoryId] = await contractDeployFunction(client, factoryJson.bytecode, 1_500_000, factoryParams);
		console.log('Factory deployed:', bidderFactoryId.toString());

		// --- Authorize factory on LST
		await contractExecuteFunction(lstContractId, lstIface, client, 200_000, 'authorizeFactory', [bidderFactoryId.toSolidityAddress(), true]);
		console.log('Factory authorized on LST');

		// --- Register factory as contract user on LGS (so stash clones can refill)
		await contractExecuteFunction(lazyGasStationId, lazyGasStationIface, client, 200_000, 'addContractUser', [bidderFactoryId.toSolidityAddress()]);

		// --- Associate $LAZY and NFTs to test accounts
		await associateTokensToAccount(client, aliceId, alicePK, [lazyTokenId, nftTokenId]);
		await associateTokensToAccount(client, bobId, bobPK, [lazyTokenId]);
		await associateTokensToAccount(client, carolId, carolPK, [lazyTokenId]);
		console.log('Token associations done');

		// --- Fund accounts with $LAZY
		const lazyAmount = 10_000 * 10 ** LAZY_DECIMAL;
		await contractExecuteFunction(lazySCT, lazyIface, client, 400_000, 'transferLazy', [aliceId.toSolidityAddress(), lazyAmount]);
		await contractExecuteFunction(lazySCT, lazyIface, client, 400_000, 'transferLazy', [bobId.toSolidityAddress(), lazyAmount]);
		console.log('$LAZY distributed to Alice and Bob');

		// --- Send some NFT serials to Alice (she's the seller)
		// Serials 1-5 go to Alice for testing
		for (let i = 1; i <= 5; i++) {
			await sendNFT(client, operatorId, aliceId, nftTokenId, [i]);
		}
		console.log('NFT serials 1-5 sent to Alice');

		// --- Alice approves LST for ALL serials of the test collection
		client.setOperator(aliceId, alicePK);
		await setNFTAllowanceAll(client, [nftTokenId], aliceId, lstContractId);
		// Alice also needs HBAR allowance to LST (for the custody hop tinybar)
		await setHbarAllowance(client, aliceId, lstContractId, 100, HbarUnit.Hbar);
		console.log('Alice allowances set (NFT + HBAR → LST)');

		// Switch back to operator
		client.setOperator(operatorId, operatorKey);

		// --- Bob: set LAZY allowance to LGS (for $LAZY bid execution)
		client.setOperator(bobId, bobPK);
		await setFTAllowance(client, lazyTokenId, bobId, lazyGasStationId, 100_000 * 10 ** LAZY_DECIMAL);
		client.setOperator(operatorId, operatorKey);
		console.log('Bob LAZY allowance set → LGS');

		await sleep(MIRROR_DELAY);
		console.log('\n=== Scaffold complete ===\n');
	});

	// ============================================
	// Stash Management
	// ============================================
	describe('Stash Management', function () {
		it('Should deploy a stash for Bob via deployStash (CREATE2)', async function () {
			client.setOperator(bobId, bobPK);

			const [rx] = await contractExecuteFunction(
				bidderFactoryId, bidderFactoryIface, client, 1_500_000,
				'deployStash', [],
				1, // send 1 HBAR to fund the stash
			);
			expect(rx.status.toString()).to.equal('SUCCESS');

			await sleep(MIRROR_DELAY);

			// Read the deployed stash address via mirror
			const result = await mirrorQuery(bidderFactoryId, bidderFactoryIface, 'getStashOf', [bobId.toSolidityAddress()]);
			bobStashAddress = result[0];
			expect(bobStashAddress).to.not.equal(ethers.ZeroAddress);
			bobStashId = ContractId.fromEvmAddress(0, 0, bobStashAddress);
			console.log('Bob stash deployed:', bobStashId.toString(), bobStashAddress);

			client.setOperator(operatorId, operatorKey);
		});

		it('Should predict stash address correctly via getStashAddress', async function () {
			const predicted = await mirrorQuery(bidderFactoryId, bidderFactoryIface, 'getStashAddress', [bobId.toSolidityAddress()]);
			expect(predicted[0].toLowerCase()).to.equal(bobStashAddress.toLowerCase());
			console.log('Predicted matches deployed:', predicted[0]);
		});

		it('Should reject duplicate stash deployment for Bob', async function () {
			client.setOperator(bobId, bobPK);
			const result = await contractExecuteFunction(
				bidderFactoryId, bidderFactoryIface, client, 500_000,
				'deployStash', [], 0, true,
			);
			// Expect a revert (StashAlreadyExists)
			const status = result[0]?.status?.toString() ?? result[0];
			expect(status).to.not.equal('SUCCESS');
			console.log('Duplicate stash rejected as expected');
			client.setOperator(operatorId, operatorKey);
		});

		it('Should deploy stash FOR Carol permissionlessly (deployStashFor)', async function () {
			// Operator (not Carol) pays gas to deploy Carol's stash
			const [rx] = await contractExecuteFunction(
				bidderFactoryId, bidderFactoryIface, client, 1_500_000,
				'deployStashFor', [carolId.toSolidityAddress()],
				1,
			);
			expect(rx.status.toString()).to.equal('SUCCESS');

			await sleep(MIRROR_DELAY);

			const result = await mirrorQuery(bidderFactoryId, bidderFactoryIface, 'getStashOf', [carolId.toSolidityAddress()]);
			carolStashAddress = result[0];
			expect(carolStashAddress).to.not.equal(ethers.ZeroAddress);
			carolStashId = ContractId.fromEvmAddress(0, 0, carolStashAddress);
			console.log('Carol stash deployed by operator:', carolStashId.toString());

			// Verify the stash is legitimate
			const verified = await mirrorQuery(bidderFactoryId, bidderFactoryIface, 'verifyStash', [carolStashAddress]);
			expect(verified[0]).to.be.true;
			console.log('Carol stash verified');
		});

		it('Should return correct getStashSnapshot', async function () {
			const snapshot = await mirrorQuery(bidderFactoryId, bidderFactoryIface, 'getStashSnapshot', [bobId.toSolidityAddress()]);
			const [stash, deployed, hbarBal, lazyBal, bids] = snapshot;

			expect(stash.toLowerCase()).to.equal(bobStashAddress.toLowerCase());
			expect(deployed).to.be.true;
			expect(Number(hbarBal)).to.be.greaterThan(0); // funded with 1 HBAR
			expect(bids.length).to.equal(0); // no bids yet
			console.log('Snapshot — stash:', stash, 'HBAR:', hbarBal.toString(), 'LAZY:', lazyBal.toString(), 'bids:', bids.length);
		});
	});

	// ============================================
	// Fund Management
	// ============================================
	describe('Fund Management', function () {
		it('Should accept HBAR deposits to stash', async function () {
			const preBalance = await checkMirrorHbarBalance(env, bobStashId);

			await sendHbar(client, operatorId, bobStashId, 10, HbarUnit.Hbar);
			await sleep(MIRROR_DELAY);

			const postBalance = await checkMirrorHbarBalance(env, bobStashId);
			expect(Number(postBalance)).to.be.greaterThan(Number(preBalance));
			console.log('Bob stash HBAR:', preBalance, '→', postBalance);
		});

		it('Should accept LAZY deposits to stash', async function () {
			// Bob sends LAZY to his stash (stash already associated via init)
			client.setOperator(bobId, bobPK);
			const lazyToSend = 5_000 * 10 ** LAZY_DECIMAL;
			const sendResult = await contractExecuteFunction(
				lazySCT, lazyIface, client, 400_000,
				'transferLazy', [bobStashAddress, lazyToSend],
			);
			client.setOperator(operatorId, operatorKey);

			await sleep(MIRROR_DELAY);

			const lazyBal = await checkMirrorBalance(env, bobStashId, lazyTokenId);
			expect(Number(lazyBal)).to.be.greaterThan(0);
			console.log('Bob stash LAZY balance:', lazyBal);
		});

		it('Should allow owner to withdrawHbar (keeping 1 HBAR minimum)', async function () {
			client.setOperator(bobId, bobPK);
			// Withdraw 1 HBAR (should succeed, keeping at least 1 HBAR behind)
			const [rx] = await contractExecuteFunction(
				bobStashId, bidderContractIface, client, 200_000,
				'withdrawHbar', [Number(new Hbar(1, HbarUnit.Hbar).toTinybars())],
			);
			expect(rx.status.toString()).to.equal('SUCCESS');
			console.log('Bob withdrew 1 HBAR from stash');
			client.setOperator(operatorId, operatorKey);
		});

		it('Should reject non-owner withdrawals', async function () {
			// Carol tries to withdraw from Bob's stash
			client.setOperator(carolId, carolPK);
			const result = await contractExecuteFunction(
				bobStashId, bidderContractIface, client, 200_000,
				'withdrawHbar', [1], 0, true,
			);
			const status = result[0]?.status?.toString() ?? result[0];
			expect(status).to.not.equal('SUCCESS');
			console.log('Non-owner withdrawal rejected');
			client.setOperator(operatorId, operatorKey);
		});
	});

	// ============================================
	// Bid Lifecycle
	// ============================================
	describe('Bid Lifecycle', function () {
		let testBidId;

		it('Should create a bid with valid parameters', async function () {
			client.setOperator(bobId, bobPK);

			// Set HBAR allowance from Bob's stash to LGS (stash needs to pay for refills)
			await contractExecuteFunction(
				bobStashId, bidderContractIface, client, 200_000,
				'associateToken', [nftTokenId.toSolidityAddress()],
			);

			// Create a bid: 5 HBAR for any serial of the test NFT
			const bidHbar = Number(new Hbar(5, HbarUnit.Hbar).toTinybars());
			const [rx, result] = await contractExecuteFunction(
				bobStashId, bidderContractIface, client, 500_000,
				'createBid',
				[
					nftTokenId.toSolidityAddress(), // token
					[], // serials (empty = any)
					bidHbar, // hbarAmount
					0, // lazyAmount
					0, // expiry (0 = never)
					0, // minAcceptablePrice (0 = accept any)
				],
			);
			expect(rx.status.toString()).to.equal('SUCCESS');

			await sleep(MIRROR_DELAY);

			// Read Bob's active bids
			const bids = await mirrorQuery(bidderFactoryId, bidderFactoryIface, 'getUserBids', [bobId.toSolidityAddress()]);
			expect(bids[0].length).to.be.greaterThan(0);
			testBidId = bids[0][0];
			console.log('Bid created:', testBidId);

			client.setOperator(operatorId, operatorKey);
		});

		it('Should return bid with Active status via isBidValid', async function () {
			const result = await mirrorQuery(bidderFactoryId, bidderFactoryIface, 'isBidValid', [testBidId]);
			const [valid, code] = result;
			expect(valid).to.be.true;
			expect(Number(code)).to.equal(0); // BidValidityCode.Valid
			console.log('Bid is valid, code:', Number(code));
		});

		it('Should cancel a bid (Active → Cancelled)', async function () {
			// First create a second bid to cancel (keep the first for later tests)
			client.setOperator(bobId, bobPK);
			const bidHbar = Number(new Hbar(2, HbarUnit.Hbar).toTinybars());
			const [rx1] = await contractExecuteFunction(
				bobStashId, bidderContractIface, client, 500_000,
				'createBid',
				[nftTokenId.toSolidityAddress(), [], bidHbar, 0, 0, 0],
			);
			expect(rx1.status.toString()).to.equal('SUCCESS');

			await sleep(MIRROR_DELAY);

			// Get the new bid ID
			const bids = await mirrorQuery(bidderFactoryId, bidderFactoryIface, 'getUserBids', [bobId.toSolidityAddress()]);
			const cancelBidId = bids[0][bids[0].length - 1]; // last one

			// Cancel it
			const [rx2] = await contractExecuteFunction(
				bobStashId, bidderContractIface, client, 200_000,
				'cancelBid', [cancelBidId],
			);
			expect(rx2.status.toString()).to.equal('SUCCESS');

			await sleep(MIRROR_DELAY);

			// Verify the cancelled bid is no longer valid
			const result = await mirrorQuery(bidderFactoryId, bidderFactoryIface, 'isBidValid', [cancelBidId]);
			expect(result[0]).to.be.false;
			expect(Number(result[1])).to.equal(2); // BidValidityCode.NotActive
			console.log('Bid cancelled, validity code:', Number(result[1]));

			client.setOperator(operatorId, operatorKey);
		});
	});

	// ============================================
	// Trade Execution — executeAgainstBid
	// ============================================
	describe('Trade Execution — executeAgainstBid', function () {
		let execBidId;
		let execSerial;

		before(async function () {
			// Create a fresh bid for this test block
			client.setOperator(bobId, bobPK);
			const bidHbar = Number(new Hbar(5, HbarUnit.Hbar).toTinybars());
			const [rx] = await contractExecuteFunction(
				bobStashId, bidderContractIface, client, 500_000,
				'createBid',
				[nftTokenId.toSolidityAddress(), [], bidHbar, 0, 0, 0],
			);
			expect(rx.status.toString()).to.equal('SUCCESS');
			client.setOperator(operatorId, operatorKey);

			await sleep(MIRROR_DELAY);

			const bids = await mirrorQuery(bidderFactoryId, bidderFactoryIface, 'getUserBids', [bobId.toSolidityAddress()]);
			execBidId = bids[0][bids[0].length - 1];
			execSerial = 1; // Alice owns serial 1
			console.log('Trade execution bid:', execBidId, 'serial:', execSerial);
		});

		it('Should execute a seller-initiated bid match', async function () {
			// Alice executes against Bob's bid with serial 1
			client.setOperator(aliceId, alicePK);

			const [rx, result] = await contractExecuteFunction(
				bidderFactoryId, bidderFactoryIface, client, 2_000_000,
				'executeAgainstBid',
				[execBidId, nftTokenId.toSolidityAddress(), execSerial],
			);
			expect(rx.status.toString()).to.equal('SUCCESS');
			console.log('Trade executed! tx:', result?.[2]?.transactionId?.toString());

			await sleep(MIRROR_DELAY);

			// Verify the bid is now Executed (not Active)
			const bidResult = await mirrorQuery(bidderFactoryId, bidderFactoryIface, 'isBidValid', [execBidId]);
			expect(bidResult[0]).to.be.false;
			expect(Number(bidResult[1])).to.equal(2); // BidValidityCode.NotActive (status = Executed)
			console.log('Bid status after execution: NotActive (Executed), code:', Number(bidResult[1]));

			client.setOperator(operatorId, operatorKey);
		});
	});

	// ============================================
	// Arbitrage
	// ============================================
	describe('Arbitrage', function () {
		let arbBidId;
		let arbTradeId;
		let arbSerial;

		before(async function () {
			// Mint a fresh serial for arbitrage testing
			client.setOperator(operatorId, operatorKey);
			arbSerial = await mintFreshSerial();
			await sendNFT(client, operatorId, aliceId, nftTokenId, [arbSerial]);
			console.log('Fresh serial', arbSerial, 'sent to Alice for arbitrage test');

			// Bob creates a bid at 10 HBAR
			client.setOperator(bobId, bobPK);
			const bidHbar = Number(new Hbar(10, HbarUnit.Hbar).toTinybars());
			const [rx] = await contractExecuteFunction(
				bobStashId, bidderContractIface, client, 500_000,
				'createBid',
				[nftTokenId.toSolidityAddress(), [arbSerial], bidHbar, 0, 0, 0],
			);
			expect(rx.status.toString()).to.equal('SUCCESS');
			client.setOperator(operatorId, operatorKey);

			await sleep(MIRROR_DELAY);

			const bids = await mirrorQuery(bidderFactoryId, bidderFactoryIface, 'getUserBids', [bobId.toSolidityAddress()]);
			arbBidId = bids[0][bids[0].length - 1];

			// Alice lists the NFT at 5 HBAR (open market) on LST directly
			client.setOperator(aliceId, alicePK);
			const askHbar = Number(new Hbar(5, HbarUnit.Hbar).toTinybars());
			const [tradeRx, tradeResult] = await contractExecuteFunction(
				lstContractId, lstIface, client, 1_000_000,
				'createTrade',
				[
					nftTokenId.toSolidityAddress(),
					ethers.ZeroAddress, // buyer = open market
					arbSerial,
					askHbar, // tinybarPrice
					0, // lazyPrice
					0, // expiryTime
				],
			);
			expect(tradeRx.status.toString()).to.equal('SUCCESS');
			client.setOperator(operatorId, operatorKey);

			await sleep(MIRROR_DELAY);

			// Get the trade ID: keccak256(token, serial)
			arbTradeId = ethers.keccak256(
				ethers.AbiCoder.defaultAbiCoder().encode(
					['address', 'uint256'],
					[nftTokenId.toSolidityAddress(), arbSerial],
				),
			);
			console.log('Arbitrage setup: bid', arbBidId, 'at 10 HBAR, ask', arbTradeId, 'at 5 HBAR');
		});

		it('Should execute arbitrage when spread exists (bid > ask)', async function () {
			// Carol (third party) executes arbitrage
			client.setOperator(carolId, carolPK);

			const [rx] = await contractExecuteFunction(
				bidderFactoryId, bidderFactoryIface, client, 3_000_000,
				'executeArbitrage',
				[arbBidId, arbTradeId, 0], // minProfit = 0
			);
			expect(rx.status.toString()).to.equal('SUCCESS');
			console.log('Arbitrage executed successfully');

			await sleep(MIRROR_DELAY);

			// Check Carol has pending arb profit
			const profitResult = await mirrorQuery(bidderFactoryId, bidderFactoryIface, 'pendingArbProfit', [carolId.toSolidityAddress()]);
			const profit = Number(profitResult[0]);
			expect(profit).to.be.greaterThan(0);
			console.log('Carol pending arb profit:', profit, 'tinybars');

			// Check protocol profit accumulated
			const protocolResult = await mirrorQuery(bidderFactoryId, bidderFactoryIface, 'pendingProtocolProfit', []);
			const protocolProfit = Number(protocolResult[0]);
			expect(protocolProfit).to.be.greaterThan(0);
			console.log('Protocol pending profit:', protocolProfit, 'tinybars');

			// Total should be the spread (10 - 5 = 5 HBAR)
			const totalProfit = profit + protocolProfit;
			const expectedSpread = Number(new Hbar(5, HbarUnit.Hbar).toTinybars());
			expect(totalProfit).to.equal(expectedSpread);
			console.log('Total spread:', totalProfit, '=', expectedSpread, '(5 HBAR)');

			client.setOperator(operatorId, operatorKey);
		});

		it('Should block self-arbitrage (caller == bidder)', async function () {
			// Setup: create a fresh bid + trade for this test
			const selfArbSerial = await mintFreshSerial();
			await sendNFT(client, operatorId, aliceId, nftTokenId, [selfArbSerial]);

			client.setOperator(bobId, bobPK);
			const bidHbar = Number(new Hbar(8, HbarUnit.Hbar).toTinybars());
			const [rx] = await contractExecuteFunction(
				bobStashId, bidderContractIface, client, 500_000,
				'createBid',
				[nftTokenId.toSolidityAddress(), [selfArbSerial], bidHbar, 0, 0, 0],
			);
			expect(rx.status.toString()).to.equal('SUCCESS');
			client.setOperator(operatorId, operatorKey);

			await sleep(MIRROR_DELAY);
			const bids = await mirrorQuery(bidderFactoryId, bidderFactoryIface, 'getUserBids', [bobId.toSolidityAddress()]);
			const selfBidId = bids[0][bids[0].length - 1];

			// Alice lists cheaply
			client.setOperator(aliceId, alicePK);
			await contractExecuteFunction(lstContractId, lstIface, client, 1_000_000,
				'createTrade',
				[nftTokenId.toSolidityAddress(), ethers.ZeroAddress, selfArbSerial, Number(new Hbar(3, HbarUnit.Hbar).toTinybars()), 0, 0],
			);
			client.setOperator(operatorId, operatorKey);

			await sleep(MIRROR_DELAY);
			const selfTradeId = ethers.keccak256(
				ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [nftTokenId.toSolidityAddress(), selfArbSerial]),
			);

			// Bob tries to arb his own bid — should be blocked (SelfArbitrageBlocked)
			client.setOperator(bobId, bobPK);
			const result = await contractExecuteFunction(
				bidderFactoryId, bidderFactoryIface, client, 2_000_000,
				'executeArbitrage',
				[selfBidId, selfTradeId, 0],
				0, true,
			);
			const status = result[0]?.status?.toString() ?? result[0];
			expect(status).to.not.equal('SUCCESS');
			console.log('Self-arbitrage blocked as expected');
			client.setOperator(operatorId, operatorKey);
		});

		it('Should allow arbitrageur to claim profit', async function () {
			client.setOperator(carolId, carolPK);

			const preBal = await checkMirrorHbarBalance(env, carolId);
			const [rx] = await contractExecuteFunction(
				bidderFactoryId, bidderFactoryIface, client, 200_000,
				'claimArbProfit', [],
			);
			expect(rx.status.toString()).to.equal('SUCCESS');

			await sleep(MIRROR_DELAY);
			const postBal = await checkMirrorHbarBalance(env, carolId);
			expect(Number(postBal)).to.be.greaterThan(Number(preBal));
			console.log('Carol claimed profit. Balance:', preBal, '→', postBal);

			client.setOperator(operatorId, operatorKey);
		});

		it('Should allow owner to withdraw protocol profit', async function () {
			const preBal = await checkMirrorHbarBalance(env, operatorId);

			const protocolResult = await mirrorQuery(bidderFactoryId, bidderFactoryIface, 'pendingProtocolProfit', []);
			const protocolAmt = Number(protocolResult[0]);

			if (protocolAmt > 0) {
				const [rx] = await contractExecuteFunction(
					bidderFactoryId, bidderFactoryIface, client, 200_000,
					'withdrawProtocolProfit',
					[operatorId.toSolidityAddress(), protocolAmt],
				);
				expect(rx.status.toString()).to.equal('SUCCESS');
				console.log('Protocol profit withdrawn:', protocolAmt);
			}
			else {
				console.log('No protocol profit to withdraw (may have been claimed already)');
			}
		});
	});

	// ============================================
	// Sovereignty / Rescue
	// ============================================
	describe('Sovereignty / Rescue', function () {
		it('Should rescue HBAR to arbitrary address', async function () {
			// Fund Carol's stash first
			await sendHbar(client, operatorId, carolStashId, 5, HbarUnit.Hbar);
			await sleep(MIRROR_DELAY);

			client.setOperator(carolId, carolPK);
			const rescueAmt = Number(new Hbar(1, HbarUnit.Hbar).toTinybars());
			const [rx] = await contractExecuteFunction(
				carolStashId, bidderContractIface, client, 200_000,
				'rescueHbar', [carolId.toSolidityAddress(), rescueAmt],
			);
			expect(rx.status.toString()).to.equal('SUCCESS');
			console.log('Rescued 1 HBAR from Carol stash');
			client.setOperator(operatorId, operatorKey);
		});

		it('Should detach from factory', async function () {
			client.setOperator(carolId, carolPK);
			const [rx] = await contractExecuteFunction(
				carolStashId, bidderContractIface, client, 200_000,
				'detachFromFactory', [],
			);
			expect(rx.status.toString()).to.equal('SUCCESS');
			console.log('Carol stash detached from factory');

			// Verify factory ops fail after detach
			const result = await contractExecuteFunction(
				carolStashId, bidderContractIface, client, 500_000,
				'createBid',
				[nftTokenId.toSolidityAddress(), [], Number(new Hbar(1, HbarUnit.Hbar).toTinybars()), 0, 0, 0],
				0, true,
			);
			const status = result[0]?.status?.toString() ?? result[0];
			expect(status).to.not.equal('SUCCESS');
			console.log('Bid creation rejected after detach');

			// But rescue still works
			const rescueAmt = Number(new Hbar(1, HbarUnit.Hbar).toTinybars());
			const [rx2] = await contractExecuteFunction(
				carolStashId, bidderContractIface, client, 200_000,
				'rescueHbar', [carolId.toSolidityAddress(), rescueAmt],
			);
			expect(rx2.status.toString()).to.equal('SUCCESS');
			console.log('Rescue still works after detach');

			client.setOperator(operatorId, operatorKey);
		});
	});

	// ============================================
	// Governance
	// ============================================
	describe('Governance', function () {
		it('Should timelock arbitrage payout bps changes', async function () {
			// Propose a change to 60% (6000 bps)
			const [rx1] = await contractExecuteFunction(
				bidderFactoryId, bidderFactoryIface, client, 200_000,
				'setArbitragePayoutBps', [6000],
			);
			expect(rx1.status.toString()).to.equal('SUCCESS');
			console.log('Proposed payoutBps change to 6000');

			// Try to apply immediately — should fail (TimelockNotElapsed)
			const result = await contractExecuteFunction(
				bidderFactoryId, bidderFactoryIface, client, 200_000,
				'executeArbPayoutBpsChange', [],
				0, true,
			);
			const status = result[0]?.status?.toString() ?? result[0];
			expect(status).to.not.equal('SUCCESS');
			console.log('Early execution rejected (timelock not elapsed)');

			// NOTE: We can't wait 48 hours in a test, so we just verify
			// the proposal is registered and the early execution fails.
			// Full timelock testing would require a local-node time-skip.
		});
	});

	// ============================================
	// Pagination & View Queries
	// ============================================
	describe('Pagination & View Queries', function () {
		it('Should return paginated bids via getBidsForTokenPaginated', async function () {
			const result = await mirrorQuery(
				bidderFactoryId, bidderFactoryIface,
				'getBidsForTokenPaginated',
				[nftTokenId.toSolidityAddress(), 0, 10],
			);
			console.log('Paginated bids for token:', result[0].length, 'bids found');
			// Just verifying it doesn't revert and returns an array
			expect(Array.isArray(result[0])).to.be.true;
		});

		it('Should return paginated serial-specific bids', async function () {
			const result = await mirrorQuery(
				bidderFactoryId, bidderFactoryIface,
				'getBidsForTokenSerialPaginated',
				[nftTokenId.toSolidityAddress(), 1, 0, 10],
			);
			console.log('Serial-specific bids:', result[0].length, 'matches, nextOffset:', Number(result[1]));
		});
	});

	// ============================================
	// Cleanup
	// ============================================
	after(async function () {
		client.setOperator(operatorId, operatorKey);
		console.log('\n=== Test run complete ===');
		console.log('Factory:', bidderFactoryId?.toString());
		console.log('Bob stash:', bobStashId?.toString());
		console.log('Carol stash:', carolStashId?.toString());
		console.log('NFT collection:', nftTokenId?.toString());
	});
});
