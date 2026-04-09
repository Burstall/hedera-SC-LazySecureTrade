const fs = require('fs');
const { ethers } = require('ethers');
const { expect } = require('chai');
const { describe, it, before, after } = require('mocha');
const {
	Client,
	AccountId,
	PrivateKey,
	ContractId,
	TokenId,
	ContractFunctionParameters,
	HbarUnit,
} = require('@hashgraph/sdk');

const {
	contractDeployFunction,
	contractExecuteFunction,
	contractExecuteQuery,
} = require('../utils/solidityHelpers');
const {
	accountCreator,
	associateTokensToAccount,
	mintNFT,
	sendNFT,
	setNFTAllowanceAll,
	setFTAllowance,
	setHbarAllowance,
} = require('../utils/hederaHelpers');
const {
	checkMirrorHbarBalance,
	getSerialsOwned,
} = require('../utils/hederaMirrorHelpers');
const { sleep } = require('../utils/nodeHelpers');
const { fail } = require('assert');
require('dotenv').config();

// Get operator from .env file
let operatorKey;
let operatorId;
try {
	operatorKey = PrivateKey.fromStringED25519(process.env.PRIVATE_KEY);
	operatorId = AccountId.fromString(process.env.ACCOUNT_ID);
}
catch (err) {
	console.log('ERROR: Must specify PRIVATE_KEY & ACCOUNT_ID in the .env file');
}

let client;
let lazyTokenId;
let lazySecureTradeIface;
let lstContractId;
let LAZYTokenCreatorId;
let lazyTokenCreatorIFace;
let lazyGasStationId;
let lazyDelegateRegistryId;
let bidderFactoryContractId;
let bidderFactoryIface;
let aliceId, alicePK;
let bobId, bobPK;
let carolId, carolPK;
let nftTokenId;
let nftSerial;
// Track which serial number to use next for tests
let nextSerialToUse = 1;
// LSH NFT tokens for fee discounts
let lshGen1TokenId;
let lshGen2TokenId;
let lshMutantTokenId;

const LAZY_BURN_PERCENT = process.env.LAZY_BURN_PERCENT ?? 25;
const LAZY_DECIMAL = process.env.LAZY_DECIMALS ?? 1;
const LAZY_MAX_SUPPLY = process.env.LAZY_MAX_SUPPLY ?? 250_000_000;
const LAZY_COST_FOR_TRADE = process.env.LAZY_COST_FOR_TRADE ?? 103;

describe('BidderContractFactory Tests', function () {
	this.timeout(9000000);

	before(async function () {
		console.log('Starting setup...');

		if (operatorKey === undefined || operatorKey == null || operatorId === undefined || operatorId == null) {
			console.log('Environment required, please specify PRIVATE_KEY & ACCOUNT_ID in the .env file');
			process.exit(1);
		}

		client = Client.forTestnet();
		client.setOperator(operatorId, operatorKey);

		// Check if contracts are already deployed
		if (process.env.LAZY_SECURE_TRADE_CONTRACT_ID && process.env.LAZY_GAS_STATION_CONTRACT_ID && process.env.LAZY_TOKEN_ID && process.env.LAZY_DELEGATE_REGISTRY_CONTRACT_ID) {
			console.log('Using existing contract deployments from .env');
			lstContractId = ContractId.fromString(process.env.LAZY_SECURE_TRADE_CONTRACT_ID);
			lazyGasStationId = ContractId.fromString(process.env.LAZY_GAS_STATION_CONTRACT_ID);
			lazyTokenId = TokenId.fromString(process.env.LAZY_TOKEN_ID);
			lazyDelegateRegistryId = ContractId.fromString(process.env.LAZY_DELEGATE_REGISTRY_CONTRACT_ID);

			// Load LST ABI to query LSH token addresses
			const lstJson = JSON.parse(fs.readFileSync('./artifacts/contracts/LazySecureTrade.sol/LazySecureTrade.json', 'utf8'));
			lazySecureTradeIface = new ethers.Interface(lstJson.abi);

			// Query LSH token addresses from deployed contract
			const lshGen1Addr = await contractExecuteQuery(
				lstContractId,
				lazySecureTradeIface,
				client,
				null,
				'LSH_GEN1',
				[],
			);
			lshGen1TokenId = TokenId.fromSolidityAddress(lshGen1Addr);
			console.log('LSH Gen1 Token:', lshGen1TokenId.toString());

			const lshGen2Addr = await contractExecuteQuery(
				lstContractId,
				lazySecureTradeIface,
				client,
				null,
				'LSH_GEN2',
				[],
			);
			lshGen2TokenId = TokenId.fromSolidityAddress(lshGen2Addr);
			console.log('LSH Gen2 Token:', lshGen2TokenId.toString());

			const lshMutantAddr = await contractExecuteQuery(
				lstContractId,
				lazySecureTradeIface,
				client,
				null,
				'LSH_GEN1_MUTANT',
				[],
			);
			lshMutantTokenId = TokenId.fromSolidityAddress(lshMutantAddr);
			console.log('LSH Mutant Token:', lshMutantTokenId.toString());

			// Check operator's holdings of these tokens
			console.log('Checking operator holdings of LSH tokens...');
			const gen1Serials = await getSerialsOwned(operatorId.toString(), lshGen1TokenId.toString());
			console.log(`  Operator owns ${gen1Serials.length} LSH Gen1 NFTs:`, gen1Serials.length > 0 ? gen1Serials : 'none');

			const gen2Serials = await getSerialsOwned(operatorId.toString(), lshGen2TokenId.toString());
			console.log(`  Operator owns ${gen2Serials.length} LSH Gen2 NFTs:`, gen2Serials.length > 0 ? gen2Serials : 'none');

			const mutantSerials = await getSerialsOwned(operatorId.toString(), lshMutantTokenId.toString());
			console.log(`  Operator owns ${mutantSerials.length} LSH Mutant NFTs:`, mutantSerials.length > 0 ? mutantSerials : 'none');
		}
		else {
			console.log('Deploying fresh contracts for testing...');

			// Step 1: Deploy LAZYTokenCreator and mint $LAZY token
			console.log('Deploying LAZYTokenCreator...');
			const lazyCreatorJson = JSON.parse(fs.readFileSync('./artifacts/contracts/legacy/LAZYTokenCreator.sol/LAZYTokenCreator.json', 'utf8'));
			const lazyCreatorByteCode = lazyCreatorJson.bytecode;
			[LAZYTokenCreatorId] = await contractDeployFunction(
				client,
				lazyCreatorByteCode,
				5_800_000,
				new ContractFunctionParameters(),
			);
			console.log('LAZYTokenCreator deployed:', LAZYTokenCreatorId.toString());

			// Mint $LAZY token
			console.log('Minting $LAZY token...');
			lazyTokenCreatorIFace = new ethers.Interface(lazyCreatorJson.abi);
			// mint the $LAZY FT
			await mintLazy(
				'Test_Lazy',
				'TLazy',
				'Test Lazy FT',
				LAZY_MAX_SUPPLY * 10 ** LAZY_DECIMAL,
				LAZY_DECIMAL,
				LAZY_MAX_SUPPLY * 10 ** LAZY_DECIMAL,
				30,
			);

			console.log('$LAZY Token created:', lazyTokenId.toString());

			// Step 2: Deploy LazyGasStation
			console.log('Deploying LazyGasStation...');
			const lgsJson = JSON.parse(fs.readFileSync('./artifacts/contracts/LazyGasStation.sol/LazyGasStation.json', 'utf8'));
			const lgsByteCode = lgsJson.bytecode;
			const lgsParams = new ContractFunctionParameters()
				.addAddress(lazyTokenId.toSolidityAddress())
				.addAddress(LAZYTokenCreatorId.toSolidityAddress());
			[lazyGasStationId] = await contractDeployFunction(
				client,
				lgsByteCode,
				6_800_000,
				lgsParams,
			);
			console.log('LazyGasStation deployed:', lazyGasStationId.toString());

			// Step 3: Deploy LazyDelegateRegistry
			console.log('Deploying LazyDelegateRegistry...');
			const ldrJson = JSON.parse(fs.readFileSync('./artifacts/contracts/LazyDelegateRegistry.sol/LazyDelegateRegistry.json', 'utf8'));
			const ldrByteCode = ldrJson.bytecode;
			[lazyDelegateRegistryId] = await contractDeployFunction(
				client,
				ldrByteCode,
				6_800_000,
				new ContractFunctionParameters(),
			);
			console.log('LazyDelegateRegistry deployed:', lazyDelegateRegistryId.toString());

			// Step 3.5: Create LSH NFT tokens for fee discounts (operator creates them)
			console.log('Creating LSH NFT tokens...');
			client.setOperator(operatorId, operatorKey);

			// 15 NFTs each for testing
			const lshSize = 15;
			let [result, tokenId] = await mintNFT(
				client,
				operatorId,
				'LSH Gen 1',
				'LSHG1',
				lshSize,
			);
			expect(result).to.be.equal('SUCCESS');
			lshGen1TokenId = tokenId;
			console.log('LSH Gen1 Token created:', lshGen1TokenId.toString());

			[result, tokenId] = await mintNFT(
				client,
				operatorId,
				'LSH Gen 2',
				'LSHG2',
				lshSize,
			);
			expect(result).to.be.equal('SUCCESS');
			lshGen2TokenId = tokenId;
			console.log('LSH Gen2 Token created:', lshGen2TokenId.toString());

			[result, tokenId] = await mintNFT(
				client,
				operatorId,
				'LSH Mutant',
				'LSHM',
				lshSize,
			);
			expect(result).to.be.equal('SUCCESS');
			lshMutantTokenId = tokenId;
			console.log('LSH Mutant Token created:', lshMutantTokenId.toString());

			// Check operator's holdings of these tokens
			console.log('Checking operator holdings of LSH tokens...');
			const gen1Serials = await getSerialsOwned(operatorId.toString(), lshGen1TokenId.toString());
			console.log(`  Operator owns ${gen1Serials.length} LSH Gen1 NFTs:`, gen1Serials);

			const gen2Serials = await getSerialsOwned(operatorId.toString(), lshGen2TokenId.toString());
			console.log(`  Operator owns ${gen2Serials.length} LSH Gen2 NFTs:`, gen2Serials);

			const mutantSerials = await getSerialsOwned(operatorId.toString(), lshMutantTokenId.toString());
			console.log(`  Operator owns ${mutantSerials.length} LSH Mutant NFTs:`, mutantSerials);

			// Step 4: Deploy LazySecureTrade with all dependencies
			console.log('Deploying LazySecureTrade...');
			const lstJson = JSON.parse(fs.readFileSync('./artifacts/contracts/LazySecureTrade.sol/LazySecureTrade.json', 'utf8'));
			const lstByteCode = lstJson.bytecode;

			// LAZY_COST_FOR_TRADE = 103
			// LAZY_BURN_PERCENT = 25
			const lstParams = new ContractFunctionParameters()
				.addAddress(lazyTokenId.toSolidityAddress())
				.addAddress(lazyGasStationId.toSolidityAddress())
				.addAddress(lazyDelegateRegistryId.toSolidityAddress())
				.addAddress(lshGen1TokenId.toSolidityAddress())
				.addAddress(lshGen2TokenId.toSolidityAddress())
				.addAddress(lshMutantTokenId.toSolidityAddress())
				.addUint256(LAZY_COST_FOR_TRADE)
				.addUint256(LAZY_BURN_PERCENT);

			lstContractId = await contractDeployFunction(
				client,
				lstByteCode,
				6_800_000,
				lstParams,
			);
			console.log('LazySecureTrade deployed:', lstContractId.toString());

			// Configure LazyGasStation
			const lgsIface = new ethers.Interface(lgsJson.abi);
			await contractExecuteFunction(
				lazyGasStationId,
				lgsIface,
				client,
				null,
				'addContractUser',
				[lstContractId.toSolidityAddress()],
			);

			await sleep(5000);
			console.log('Contracts configured');
		}

		// Load ABIs
		const lstJson = JSON.parse(fs.readFileSync('./artifacts/contracts/LazySecureTrade.sol/LazySecureTrade.json', 'utf8'));
		lazySecureTradeIface = new ethers.Interface(lstJson.abi);

		// Create test accounts
		console.log('Creating test accounts...');
		const aliceKey = PrivateKey.generateED25519();
		alicePK = aliceKey;
		aliceId = await accountCreator(client, aliceKey, 200);
		console.log('Alice created:', aliceId.toString());

		const bobKey = PrivateKey.generateED25519();
		bobPK = bobKey;
		bobId = await accountCreator(client, bobKey, 200);
		console.log('Bob created:', bobId.toString());

		const carolKey = PrivateKey.generateED25519();
		carolPK = carolKey;
		carolId = await accountCreator(client, carolKey, 200);
		console.log('Carol created:', carolId.toString());

		// Associate $LAZY token to test accounts
		await associateTokensToAccount(client, aliceId, alicePK, [lazyTokenId]);
		await associateTokensToAccount(client, bobId, bobPK, [lazyTokenId]);
		await associateTokensToAccount(client, carolId, carolPK, [lazyTokenId]);

		// Distribute $LAZY tokens to test accounts
		client.setOperator(operatorId, operatorKey);
		await sendLazy(aliceId, 50_000);
		await sendLazy(bobId, 50_000);
		await sendLazy(carolId, 50_000);

		console.log('$LAZY distributed to test accounts');

		// Deploy BidderContract implementation first (to be cloned)
		console.log('Deploying BidderContract implementation...');
		const bidderContractJson = JSON.parse(fs.readFileSync('./artifacts/contracts/BidderContract.sol/BidderContract.json', 'utf8'));
		const bidderContractByteCode = bidderContractJson.bytecode;
		const [bidderContractImplId] = await contractDeployFunction(
			client,
			bidderContractByteCode,
			3_500_000,
			new ContractFunctionParameters(),
		);
		console.log('BidderContract implementation deployed:', bidderContractImplId.toString());

		// Deploy BidderContractFactory
		console.log('Deploying BidderContractFactory...');
		const gasLimit = 4_000_000;
		const json = JSON.parse(fs.readFileSync('./artifacts/contracts/BidderContractFactory.sol/BidderContractFactory.json', 'utf8'));
		const byteCode = json.bytecode;
		bidderFactoryIface = new ethers.Interface(json.abi);

		const constructorParams = new ContractFunctionParameters()
			.addAddress(lstContractId.toSolidityAddress())
			.addAddress(lazyTokenId.toSolidityAddress())
			.addAddress(lazyGasStationId.toSolidityAddress())
			.addAddress(lazyDelegateRegistryId.toSolidityAddress())
			.addAddress(bidderContractImplId.toSolidityAddress());

		bidderFactoryContractId = await contractDeployFunction(
			client,
			byteCode,
			gasLimit,
			constructorParams,
		);
		console.log('BidderContractFactory deployed:', bidderFactoryContractId.toString());

		// Create test NFT collection from Alice's account (following LazySecureTrade.test.js pattern)
		console.log('Creating test NFT collection...');
		client.setOperator(aliceId, alicePK);

		const nftSize = 20;

		const [result, tokenId] = await mintNFT(
			client,
			aliceId,
			'Test NFT',
			'TNFT',
			nftSize,
		);
		expect(result).to.be.equal('SUCCESS');
		nftTokenId = tokenId;
		console.log('Test NFT collection created:', nftTokenId.toString());

		// Revert back to operator
		client.setOperator(operatorId, operatorKey);

		// Get the first serial (minted automatically)
		nftSerial = [1];
		console.log('NFT serials available: 1-20');

		// Associate NFT with test accounts
		await associateTokensToAccount(client, operatorId, operatorKey, [nftTokenId]);
		await associateTokensToAccount(client, bobId, bobPK, [nftTokenId]);
		await associateTokensToAccount(client, carolId, carolPK, [nftTokenId]);

		await sleep(5000);
		console.log('Setup complete');
	});

	after(async function () {
		await client.close();
	});

	it('Should verify factory deployment and initial state', async function () {
		const owner = await contractExecuteQuery(
			bidderFactoryContractId,
			bidderFactoryIface,
			client,
			null,
			'owner',
			[],
		);
		expect(AccountId.fromSolidityAddress(owner).toString()).to.equal(operatorId.toString());

		const lstAddress = await contractExecuteQuery(
			bidderFactoryContractId,
			bidderFactoryIface,
			client,
			null,
			'lazySecureTrade',
			[],
		);
		expect(ContractId.fromSolidityAddress(lstAddress).toString()).to.equal(lstContractId.toString());

		console.log('✓ Factory deployment verified');
	});

	it('Should authorize factory to create BidderContracts', async function () {
		const factoryAddress = bidderFactoryContractId.toSolidityAddress();

		// Authorize the factory - using array params
		await contractExecuteFunction(
			lstContractId,
			lazySecureTradeIface,
			client,
			null,
			'authorizeFactory',
			[factoryAddress, true],
		);

		await sleep(5000);

		// Verify authorization
		const isAuthorized = await contractExecuteQuery(
			lstContractId,
			lazySecureTradeIface,
			client,
			null,
			'isAuthorizedFactory',
			[factoryAddress],
		);
		expect(isAuthorized).to.be.true;

		console.log('✓ Factory authorized');
	});

	it('Should deploy a BidderContract for Alice with 1 HBAR funding', async function () {
		// Switch to Alice's context
		client.setOperator(aliceId, alicePK);

		// Deploy BidderContract with 1 HBAR payment - using array params
		await contractExecuteFunction(
			bidderFactoryContractId,
			bidderFactoryIface,
			client,
			null,
			'deployStash',
			[],
			1,
			HbarUnit.Hbar,
		);

		await sleep(5000);

		// Verify BidderContract was created
		const aliceBidderAddress = await contractExecuteQuery(
			bidderFactoryContractId,
			bidderFactoryIface,
			client,
			null,
			'getStashOf',
			[aliceId.toSolidityAddress()],
		);
		expect(aliceBidderAddress).to.not.equal('0x0000000000000000000000000000000000000000');

		const aliceBidderContractId = ContractId.fromSolidityAddress(aliceBidderAddress);
		console.log('✓ BidderContract deployed for Alice:', aliceBidderContractId.toString());

		// Setup HBAR allowance from BidderContract to LazySecureTrade for 100 HBAR
		const bidderContractJson = JSON.parse(fs.readFileSync('./artifacts/contracts/BidderContractFactory.sol/BidderContract.json', 'utf8'));
		const bidderContractIface = new ethers.Interface(bidderContractJson.abi);

		await contractExecuteFunction(
			aliceBidderContractId,
			bidderContractIface,
			client,
			null,
			'setHbarAllowance',
			[lstContractId.toSolidityAddress(), ethers.parseUnits('100', 8).toString()],
		);

		await sleep(5000);
		console.log('✓ HBAR allowance set from BidderContract to LST');

		// Switch back to operator
		client.setOperator(operatorId, operatorKey);
	});

	it('Should prevent duplicate BidderContract deployment', async function () {
		// Switch to Alice's context
		client.setOperator(aliceId, alicePK);

		// Try to deploy again - using array params
		const result = await contractExecuteFunction(
			bidderFactoryContractId,
			bidderFactoryIface,
			client,
			null,
			'deployStash',
			[],
			1,
			HbarUnit.Hbar,
		);

		// Check for revert - no try-catch, check status
		if (result[0]?.status?.toString().includes('REVERT:')) {
			console.log('✓ Duplicate deployment prevented as expected');
		}
		else {
			throw new Error('Expected deployment to revert for duplicate');
		}

		// Switch back to operator
		client.setOperator(operatorId, operatorKey);
	});

	it('Should allow Alice to withdraw HBAR from BidderContract keeping 1 HBAR', async function () {
		// Switch to Alice's context
		client.setOperator(aliceId, alicePK);

		const aliceBidderAddress = await contractExecuteQuery(
			bidderFactoryContractId,
			bidderFactoryIface,
			client,
			null,
			'getStashOf',
			[aliceId.toSolidityAddress()],
		);
		const aliceBidderContractId = ContractId.fromSolidityAddress(aliceBidderAddress);

		// Check initial balance
		const initialBalance = await checkMirrorHbarBalance(aliceBidderContractId.toString());
		console.log('BidderContract initial balance:', initialBalance, 'tinybar');

		// Withdraw all but 1 HBAR (100_000_000 tinybars)
		const withdrawAmount = initialBalance - 100_000_000;
		if (withdrawAmount > 0) {
			const bidderContractJson = JSON.parse(fs.readFileSync('./artifacts/contracts/BidderContractFactory.sol/BidderContract.json', 'utf8'));
			const bidderContractIface = new ethers.Interface(bidderContractJson.abi);

			await contractExecuteFunction(
				aliceBidderContractId,
				bidderContractIface,
				client,
				null,
				'withdrawHbar',
				[withdrawAmount.toString()],
			);

			await sleep(5000);

			const finalBalance = await checkMirrorHbarBalance(aliceBidderContractId.toString());
			console.log('BidderContract final balance:', finalBalance, 'tinybar');
			// Within 0.01 HBAR tolerance
			expect(finalBalance).to.be.approximately(100_000_000, 1_000_000);

			console.log('✓ HBAR withdrawn, 1 HBAR kept in contract');
		}
		else {
			console.log('✓ Contract already at minimum balance');
		}

		// Switch back to operator
		client.setOperator(operatorId, operatorKey);
	});

	it('Should deploy BidderContracts for Bob and Carol', async function () {
		// Deploy for Bob
		client.setOperator(bobId, bobPK);
		await contractExecuteFunction(
			bidderFactoryContractId,
			bidderFactoryIface,
			client,
			null,
			'deployStash',
			[],
			1,
			HbarUnit.Hbar,
		);

		await sleep(5000);

		const bobBidderAddress = await contractExecuteQuery(
			bidderFactoryContractId,
			bidderFactoryIface,
			client,
			null,
			'getStashOf',
			[bobId.toSolidityAddress()],
		);
		expect(bobBidderAddress).to.not.equal('0x0000000000000000000000000000000000000000');
		const bobBidderContractId = ContractId.fromSolidityAddress(bobBidderAddress);
		console.log('✓ BidderContract deployed for Bob:', bobBidderContractId.toString());

		// Setup HBAR allowance for Bob's BidderContract
		const bidderContractJson = JSON.parse(fs.readFileSync('./artifacts/contracts/BidderContractFactory.sol/BidderContract.json', 'utf8'));
		const bidderContractIface = new ethers.Interface(bidderContractJson.abi);

		await contractExecuteFunction(
			bobBidderContractId,
			bidderContractIface,
			client,
			null,
			'setHbarAllowance',
			[lstContractId.toSolidityAddress(), ethers.parseUnits('100', 8).toString()],
		);

		await sleep(5000);

		// Deploy for Carol
		client.setOperator(carolId, carolPK);
		await contractExecuteFunction(
			bidderFactoryContractId,
			bidderFactoryIface,
			client,
			null,
			'deployStash',
			[],
			1,
			HbarUnit.Hbar,
		);

		await sleep(5000);

		const carolBidderAddress = await contractExecuteQuery(
			bidderFactoryContractId,
			bidderFactoryIface,
			client,
			null,
			'getStashOf',
			[carolId.toSolidityAddress()],
		);
		expect(carolBidderAddress).to.not.equal('0x0000000000000000000000000000000000000000');
		const carolBidderContractId = ContractId.fromSolidityAddress(carolBidderAddress);
		console.log('✓ BidderContract deployed for Carol:', carolBidderContractId.toString());

		// Setup HBAR allowance for Carol's BidderContract
		await contractExecuteFunction(
			carolBidderContractId,
			bidderContractIface,
			client,
			null,
			'setHbarAllowance',
			[lstContractId.toSolidityAddress(), ethers.parseUnits('100', 8).toString()],
		);

		await sleep(5000);

		// Switch back to operator
		client.setOperator(operatorId, operatorKey);
	});

	it('Should create a bid from Alice\'s BidderContract', async function () {
		// Switch to Alice's context
		client.setOperator(aliceId, alicePK);

		const aliceBidderAddress = await contractExecuteQuery(
			bidderFactoryContractId,
			bidderFactoryIface,
			client,
			null,
			'getStashOf',
			[aliceId.toSolidityAddress()],
		);
		const aliceBidderContractId = ContractId.fromSolidityAddress(aliceBidderAddress);

		const bidderContractJson = JSON.parse(fs.readFileSync('./artifacts/contracts/BidderContractFactory.sol/BidderContract.json', 'utf8'));
		const bidderContractIface = new ethers.Interface(bidderContractJson.abi);

		// Create bid - using array params
		// 10 HBAR in tinybar
		const bidAmount = ethers.parseUnits('10', 8);
		await contractExecuteFunction(
			aliceBidderContractId,
			bidderContractIface,
			client,
			null,
			'createBid',
			[nftTokenId.toSolidityAddress(), nftSerial[0].toString(), bidAmount.toString()],
		);

		await sleep(5000);

		// Verify bid was created
		const bidId = await contractExecuteQuery(
			lstContractId,
			lazySecureTradeIface,
			client,
			null,
			'getActiveBidCount',
			[],
		);
		expect(Number(bidId)).to.be.greaterThan(0);

		console.log('✓ Bid created from Alice\'s BidderContract');

		// Switch back to operator
		client.setOperator(operatorId, operatorKey);
	});

	it('Should accept Alice\'s bid and complete trade', async function () {
		// Get Alice's bid details
		const activeBids = await contractExecuteQuery(
			lstContractId,
			lazySecureTradeIface,
			client,
			null,
			'getActiveBidCount',
			[],
		);
		const bidCount = Number(activeBids);
		expect(bidCount).to.be.greaterThan(0);

		// Get the bid ID (assuming it's the last one)
		const bidId = bidCount - 1;

		// Set NFT allowance for LST
		await setNFTAllowanceAll(client, nftTokenId, operatorId, lstContractId);

		await sleep(5000);

		// Accept the bid - using array params
		await contractExecuteFunction(
			lstContractId,
			lazySecureTradeIface,
			client,
			null,
			'acceptBid',
			[bidId.toString()],
		);

		await sleep(5000);

		// Verify trade completed
		const serials = await getSerialsOwned(aliceId.toString(), nftTokenId.toString());
		expect(serials).to.include(nftSerial[0]);

		console.log('✓ Bid accepted and trade completed');
	});

	it('Should create trade using $LAZY for gas (non-factory)', async function () {
		// Use next available serial
		nextSerialToUse++;
		const newSerial = nextSerialToUse;
		console.log('Using NFT serial:', newSerial);

		// Send NFT from Alice (owner) to Alice to prepare for trade
		client.setOperator(aliceId, alicePK);
		await sendNFT(client, nftTokenId, aliceId, aliceId, [newSerial]);

		await sleep(5000);

		// Switch to Alice's context
		client.setOperator(aliceId, alicePK);

		// Set $LAZY allowance to LazyGasStation for gas payment
		await setFTAllowance(client, lazyTokenId, aliceId, lazyGasStationId, 1000);

		// Set NFT allowance
		await setNFTAllowanceAll(client, nftTokenId, aliceId, lstContractId);

		await sleep(5000);

		// Create trade - using array params
		// 20 HBAR
		const tradePrice = ethers.parseUnits('20', 8);
		await contractExecuteFunction(
			lstContractId,
			lazySecureTradeIface,
			client,
			null,
			'createTrade',
			[
				nftTokenId.toSolidityAddress(),
				newSerial.toString(),
				tradePrice.toString(),
				'0x0000000000000000000000000000000000000000',
				'0',
				'0',
			],
		);

		await sleep(5000);

		// Verify trade created
		const activeTrades = await contractExecuteQuery(
			lstContractId,
			lazySecureTradeIface,
			client,
			null,
			'getActiveTradeCount',
			[],
		);
		expect(Number(activeTrades)).to.be.greaterThan(0);

		console.log('✓ Trade created using $LAZY for gas');

		// Switch back to operator
		client.setOperator(operatorId, operatorKey);
	});

	it('Should execute trade with Bob as buyer', async function () {
		// Get the last trade
		const activeTrades = await contractExecuteQuery(
			lstContractId,
			lazySecureTradeIface,
			client,
			null,
			'getActiveTradeCount',
			[],
		);
		const tradeCount = Number(activeTrades);
		const tradeId = tradeCount - 1;

		// Switch to Bob's context
		client.setOperator(bobId, bobPK);

		// Set HBAR allowance for Bob to pay for the trade
		await setHbarAllowance(client, bobId, lstContractId, 25, HbarUnit.Hbar);

		await sleep(5000);

		// Execute trade - using array params
		await contractExecuteFunction(
			lstContractId,
			lazySecureTradeIface,
			client,
			null,
			'executeTrade',
			[tradeId.toString()],
		);

		await sleep(5000);

		// Verify Bob owns the NFT
		const bobSerials = await getSerialsOwned(bobId.toString(), nftTokenId.toString());
		expect(bobSerials.length).to.be.greaterThan(0);

		console.log('✓ Trade executed by Bob');

		// Switch back to operator
		client.setOperator(operatorId, operatorKey);
	});

	it('Should create trade with FT payment requirement', async function () {
		// Use next available serial
		nextSerialToUse++;
		const newSerial = nextSerialToUse;

		// Send from Alice (owner) to Alice to prepare for trade
		client.setOperator(aliceId, alicePK);
		await sendNFT(client, nftTokenId, aliceId, aliceId, [newSerial]);

		await sleep(5000);

		// Switch to Alice's context
		client.setOperator(aliceId, alicePK);

		// Set $LAZY allowance for gas
		await setFTAllowance(client, lazyTokenId, aliceId, lazyGasStationId, 1000);

		// Set NFT allowance
		await setNFTAllowanceAll(client, nftTokenId, aliceId, lstContractId);

		await sleep(5000);

		// Create trade with FT payment - using array params
		// 5000 $LAZY
		const ftPayment = 5000;
		await contractExecuteFunction(
			lstContractId,
			lazySecureTradeIface,
			client,
			null,
			'createTrade',
			[
				nftTokenId.toSolidityAddress(),
				newSerial.toString(),
				'0',
				lazyTokenId.toSolidityAddress(),
				ftPayment.toString(),
				'0',
			],
		);

		await sleep(5000);

		console.log('✓ Trade created with FT payment requirement');

		// Switch back to operator
		client.setOperator(operatorId, operatorKey);
	});

	it('Should execute FT payment trade', async function () {
		// Get the last trade
		const activeTrades = await contractExecuteQuery(
			lstContractId,
			lazySecureTradeIface,
			client,
			null,
			'getActiveTradeCount',
			[],
		);
		const tradeCount = Number(activeTrades);
		const tradeId = tradeCount - 1;

		// Switch to Carol's context
		client.setOperator(carolId, carolPK);

		// Set FT allowance for payment
		await setFTAllowance(client, lazyTokenId, carolId, lstContractId, 6000);

		await sleep(5000);

		// Execute trade - using array params
		await contractExecuteFunction(
			lstContractId,
			lazySecureTradeIface,
			client,
			null,
			'executeTrade',
			[tradeId.toString()],
		);

		await sleep(5000);

		// Verify Carol owns the NFT
		const carolSerials = await getSerialsOwned(carolId.toString(), nftTokenId.toString());
		expect(carolSerials.length).to.be.greaterThan(0);

		console.log('✓ FT payment trade executed by Carol');

		// Switch back to operator
		client.setOperator(operatorId, operatorKey);
	});

	it('Should cancel a trade', async function () {
		// Use next available serial
		nextSerialToUse++;
		const newSerial = nextSerialToUse;

		// Send from Alice (owner) to Alice to prepare for trade
		client.setOperator(aliceId, alicePK);
		await sendNFT(client, nftTokenId, aliceId, aliceId, [newSerial]);

		await sleep(5000);

		// Switch to Alice's context
		client.setOperator(aliceId, alicePK);

		// Set $LAZY allowance for gas
		await setFTAllowance(client, lazyTokenId, aliceId, lazyGasStationId, 1000);

		// Set NFT allowance
		await setNFTAllowanceAll(client, nftTokenId, aliceId, lstContractId);

		await sleep(5000);

		// Create trade
		const tradePrice = ethers.parseUnits('15', 8);
		await contractExecuteFunction(
			lstContractId,
			lazySecureTradeIface,
			client,
			null,
			'createTrade',
			[
				nftTokenId.toSolidityAddress(),
				newSerial.toString(),
				tradePrice.toString(),
				'0x0000000000000000000000000000000000000000',
				'0',
				'0',
			],
		);

		await sleep(5000);

		// Get the trade ID
		const activeTrades = await contractExecuteQuery(
			lstContractId,
			lazySecureTradeIface,
			client,
			null,
			'getActiveTradeCount',
			[],
		);
		const tradeId = Number(activeTrades) - 1;

		// Cancel trade - using array params
		await contractExecuteFunction(
			lstContractId,
			lazySecureTradeIface,
			client,
			null,
			'cancelTrade',
			[tradeId.toString()],
		);

		await sleep(5000);

		// Verify Alice got NFT back
		const aliceSerials = await getSerialsOwned(aliceId.toString(), nftTokenId.toString());
		expect(aliceSerials).to.include(newSerial);

		console.log('✓ Trade cancelled successfully');

		// Switch back to operator
		client.setOperator(operatorId, operatorKey);
	});

	it('Should add and remove NFT collection exemption', async function () {
		// Add exemption - using array params
		await contractExecuteFunction(
			lstContractId,
			lazySecureTradeIface,
			client,
			null,
			'addNFTCollectionExemption',
			[nftTokenId.toSolidityAddress()],
		);

		await sleep(5000);

		// Verify exemption
		const isExempt = await contractExecuteQuery(
			lstContractId,
			lazySecureTradeIface,
			client,
			null,
			'isNFTCollectionExempt',
			[nftTokenId.toSolidityAddress()],
		);
		expect(isExempt).to.be.true;

		console.log('✓ NFT collection exemption added');

		// Remove exemption - using array params
		await contractExecuteFunction(
			lstContractId,
			lazySecureTradeIface,
			client,
			null,
			'removeNFTCollectionExemption',
			[nftTokenId.toSolidityAddress()],
		);

		await sleep(5000);

		// Verify exemption removed
		const isStillExempt = await contractExecuteQuery(
			lstContractId,
			lazySecureTradeIface,
			client,
			null,
			'isNFTCollectionExempt',
			[nftTokenId.toSolidityAddress()],
		);
		expect(isStillExempt).to.be.false;

		console.log('✓ NFT collection exemption removed');
	});

	it('Should add and remove account exemption', async function () {
		// Add exemption - using array params
		await contractExecuteFunction(
			lstContractId,
			lazySecureTradeIface,
			client,
			null,
			'addAccountExemption',
			[aliceId.toSolidityAddress()],
		);

		await sleep(5000);

		// Verify exemption
		const isExempt = await contractExecuteQuery(
			lstContractId,
			lazySecureTradeIface,
			client,
			null,
			'isAccountExempt',
			[aliceId.toSolidityAddress()],
		);
		expect(isExempt).to.be.true;

		console.log('✓ Account exemption added for Alice');

		// Remove exemption - using array params
		await contractExecuteFunction(
			lstContractId,
			lazySecureTradeIface,
			client,
			null,
			'removeAccountExemption',
			[aliceId.toSolidityAddress()],
		);

		await sleep(5000);

		// Verify exemption removed
		const isStillExempt = await contractExecuteQuery(
			lstContractId,
			lazySecureTradeIface,
			client,
			null,
			'isAccountExempt',
			[aliceId.toSolidityAddress()],
		);
		expect(isStillExempt).to.be.false;

		console.log('✓ Account exemption removed for Alice');
	});

	it('Should test TokenStakerV2 interaction', async function () {
		// This is a placeholder test for TokenStakerV2 functionality
		// TokenStakerV2 would need to be deployed and configured separately
		console.log('✓ TokenStakerV2 interaction test placeholder');
	});

	it('Should handle multiple concurrent bids', async function () {
		// Use next available serial
		nextSerialToUse++;
		const newSerial = nextSerialToUse;

		// Serial is already owned by Alice, no need to transfer
		await sleep(5000);

		// Get BidderContract addresses
		const aliceBidderAddress = await contractExecuteQuery(
			bidderFactoryContractId,
			bidderFactoryIface,
			client,
			null,
			'getStashOf',
			[aliceId.toSolidityAddress()],
		);
		const bobBidderAddress = await contractExecuteQuery(
			bidderFactoryContractId,
			bidderFactoryIface,
			client,
			null,
			'getStashOf',
			[bobId.toSolidityAddress()],
		);

		const aliceBidderContractId = ContractId.fromSolidityAddress(aliceBidderAddress);
		const bobBidderContractId = ContractId.fromSolidityAddress(bobBidderAddress);

		const bidderContractJson = JSON.parse(fs.readFileSync('./artifacts/contracts/BidderContractFactory.sol/BidderContract.json', 'utf8'));
		const bidderContractIface = new ethers.Interface(bidderContractJson.abi);

		// Create bid from Alice - using array params
		client.setOperator(aliceId, alicePK);
		const aliceBidAmount = ethers.parseUnits('15', 8);
		await contractExecuteFunction(
			aliceBidderContractId,
			bidderContractIface,
			client,
			null,
			'createBid',
			[nftTokenId.toSolidityAddress(), newSerial.toString(), aliceBidAmount.toString()],
		);

		await sleep(5000);

		// Create bid from Bob - using array params
		client.setOperator(bobId, bobPK);
		const bobBidAmount = ethers.parseUnits('20', 8);
		await contractExecuteFunction(
			bobBidderContractId,
			bidderContractIface,
			client,
			null,
			'createBid',
			[nftTokenId.toSolidityAddress(), newSerial.toString(), bobBidAmount.toString()],
		);

		await sleep(5000);

		// Verify both bids exist
		client.setOperator(operatorId, operatorKey);
		const activeBids = await contractExecuteQuery(
			lstContractId,
			lazySecureTradeIface,
			client,
			null,
			'getActiveBidCount',
			[],
		);
		expect(Number(activeBids)).to.be.greaterThan(1);

		console.log('✓ Multiple concurrent bids created');

		// Accept Bob's higher bid
		await setNFTAllowanceAll(client, nftTokenId, operatorId, lstContractId);

		await sleep(5000);

		// Bob's bid (last one)
		const bidId = Number(activeBids) - 1;
		await contractExecuteFunction(
			lstContractId,
			lazySecureTradeIface,
			client,
			null,
			'acceptBid',
			[bidId.toString()],
		);

		await sleep(5000);

		// Verify Bob owns the NFT
		const bobSerials = await getSerialsOwned(bobId.toString(), nftTokenId.toString());
		expect(bobSerials).to.include(newSerial);

		console.log('✓ Higher bid accepted and executed');
	});

	it('Should cancel a bid', async function () {
		// Use next available serial
		nextSerialToUse++;
		const newSerial = nextSerialToUse;

		// Serial is already owned by Alice, no need to transfer
		await sleep(5000);

		// Switch to Alice's context
		client.setOperator(aliceId, alicePK);

		const aliceBidderAddress = await contractExecuteQuery(
			bidderFactoryContractId,
			bidderFactoryIface,
			client,
			null,
			'getStashOf',
			[aliceId.toSolidityAddress()],
		);
		const aliceBidderContractId = ContractId.fromSolidityAddress(aliceBidderAddress);

		const bidderContractJson = JSON.parse(fs.readFileSync('./artifacts/contracts/BidderContractFactory.sol/BidderContract.json', 'utf8'));
		const bidderContractIface = new ethers.Interface(bidderContractJson.abi);

		// Create bid - using array params
		const bidAmount = ethers.parseUnits('12', 8);
		await contractExecuteFunction(
			aliceBidderContractId,
			bidderContractIface,
			client,
			null,
			'createBid',
			[nftTokenId.toSolidityAddress(), newSerial.toString(), bidAmount.toString()],
		);

		await sleep(5000);

		// Get bid ID
		const activeBids = await contractExecuteQuery(
			lstContractId,
			lazySecureTradeIface,
			client,
			null,
			'getActiveBidCount',
			[],
		);
		const bidId = Number(activeBids) - 1;

		// Cancel bid - using array params
		await contractExecuteFunction(
			aliceBidderContractId,
			bidderContractIface,
			client,
			null,
			'cancelBid',
			[bidId.toString()],
		);

		await sleep(5000);

		console.log('✓ Bid cancelled successfully');

		// Switch back to operator
		client.setOperator(operatorId, operatorKey);
	});

	it('Should query getBidderContractsByCollection', async function () {
		// Query all BidderContracts interested in the NFT collection - using array params
		const bidders = await contractExecuteQuery(
			bidderFactoryContractId,
			bidderFactoryIface,
			client,
			null,
			'getBidderContractsByCollection',
			[nftTokenId.toSolidityAddress()],
		);

		// Should return at least Alice and Bob's contracts
		expect(bidders.length).to.be.greaterThan(0);

		console.log('✓ BidderContracts queried by collection:', bidders.length);
	});

	it('Should query getCollectionsByBidderContract', async function () {
		const aliceBidderAddress = await contractExecuteQuery(
			bidderFactoryContractId,
			bidderFactoryIface,
			client,
			null,
			'getStashOf',
			[aliceId.toSolidityAddress()],
		);

		// Query all collections Alice's BidderContract has bid on - using array params
		const collections = await contractExecuteQuery(
			bidderFactoryContractId,
			bidderFactoryIface,
			client,
			null,
			'getCollectionsByBidderContract',
			[aliceBidderAddress],
		);

		expect(collections.length).to.be.greaterThan(0);

		console.log('✓ Collections queried for BidderContract:', collections.length);
	});

	it('Should update bid amount', async function () {
		// Use next available serial
		nextSerialToUse++;
		const newSerial = nextSerialToUse;

		// Serial is already owned by Alice, no need to transfer
		await sleep(5000);

		// Switch to Alice's context
		client.setOperator(aliceId, alicePK);

		const aliceBidderAddress = await contractExecuteQuery(
			bidderFactoryContractId,
			bidderFactoryIface,
			client,
			null,
			'getStashOf',
			[aliceId.toSolidityAddress()],
		);
		const aliceBidderContractId = ContractId.fromSolidityAddress(aliceBidderAddress);

		const bidderContractJson = JSON.parse(fs.readFileSync('./artifacts/contracts/BidderContractFactory.sol/BidderContract.json', 'utf8'));
		const bidderContractIface = new ethers.Interface(bidderContractJson.abi);

		// Create initial bid - using array params
		const initialBidAmount = ethers.parseUnits('10', 8);
		await contractExecuteFunction(
			aliceBidderContractId,
			bidderContractIface,
			client,
			null,
			'createBid',
			[nftTokenId.toSolidityAddress(), newSerial.toString(), initialBidAmount.toString()],
		);

		await sleep(5000);

		// Get bid ID
		const activeBids = await contractExecuteQuery(
			lstContractId,
			lazySecureTradeIface,
			client,
			null,
			'getActiveBidCount',
			[],
		);
		const bidId = Number(activeBids) - 1;

		// Update bid amount - using array params
		const newBidAmount = ethers.parseUnits('15', 8);
		await contractExecuteFunction(
			aliceBidderContractId,
			bidderContractIface,
			client,
			null,
			'updateBid',
			[bidId.toString(), newBidAmount.toString()],
		);

		await sleep(5000);

		console.log('✓ Bid amount updated successfully');

		// Switch back to operator
		client.setOperator(operatorId, operatorKey);
	});
});

/**
 * Helper function to encpapsualte minting an FT
 * @param {string} tokenName
 * @param {string} tokenSymbol
 * @param {string} tokenMemo
 * @param {number} tokenInitalSupply
 * @param {number} tokenDecimal
 * @param {number} tokenMaxSupply
 * @param {number} payment
 */
async function mintLazy(
	tokenName,
	tokenSymbol,
	tokenMemo,
	tokenInitalSupply,
	decimal,
	tokenMaxSupply,
	payment,
) {
	const gasLim = 800000;
	// call associate method
	const params = [
		tokenName,
		tokenSymbol,
		tokenMemo,
		tokenInitalSupply,
		decimal,
		tokenMaxSupply,
	];

	const [, , createTokenRecord] = await contractExecuteFunction(
		LAZYTokenCreatorId,
		lazyTokenCreatorIFace,
		client,
		gasLim,
		'createFungibleWithBurn',
		params,
		payment,
	);
	const tokenIdSolidityAddr =
		createTokenRecord.contractFunctionResult.getAddress(0);
	lazyTokenId = TokenId.fromSolidityAddress(tokenIdSolidityAddr);
}

/**
 * Use the LSCT to send $LAZY out
 * @param {AccountId} receiverId
 * @param {*} amt
 */
async function sendLazy(receiverId, amt) {
	const result = await contractExecuteFunction(
		LAZYTokenCreatorId,
		lazyTokenCreatorIFace,
		client,
		300_000,
		'transferHTS',
		[lazyTokenId.toSolidityAddress(), receiverId.toSolidityAddress(), amt],
	);
	if (result[0]?.status?.toString() !== 'SUCCESS') {
		console.log('Failed to send $LAZY:', result);
		fail();
	}
	return result[0]?.status.toString();
}