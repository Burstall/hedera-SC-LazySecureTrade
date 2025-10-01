const fs = require('fs');
const { ethers } = require('ethers');
const { expect } = require('chai');
const { describe, it, before, after } = require('mocha');
const {
	Client,
	AccountId,
	PrivateKey,
	// eslint-disable-next-line no-unused-vars
	TokenId,
	// eslint-disable-next-line no-unused-vars
	ContractId,
	ContractFunctionParameters,
	HbarUnit,
	Hbar,
} = require('@hashgraph/sdk');

const {
	contractDeployFunction,
	contractExecuteFunction,
	contractExecuteQuery,
	readOnlyEVMFromMirrorNode,
} = require('../utils/solidityHelpers');
const {
	accountCreator,
	associateTokensToAccount,
	mintNFT,
	sendNFT,
	clearNFTAllowances,
	clearFTAllowances,
	setNFTAllowanceAll,
	sendHbar,
	setHbarAllowance,
	setFTAllowance,
	sweepHbar,
	sendNFTDefeatRoyalty,
} = require('../utils/hederaHelpers');
const { fail } = require('assert');
const {
	checkLastMirrorEvent,
	checkFTAllowances,
	checkMirrorBalance,
	checkMirrorHbarBalance,
	getSerialsOwned,
} = require('../utils/hederaMirrorHelpers');
const { sleep } = require('../utils/nodeHelpers');
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

const lazyContractCreator = 'LAZYTokenCreator';
const lazyGasStationName = 'LazyGasStation';
const contractName = 'LazySecureTrade';
const lazyDelegateRegistryName = 'LazyDelegateRegistry';
const env = process.env.ENVIRONMENT ?? null;
const LAZY_BURN_PERCENT = process.env.LAZY_BURN_PERCENT ?? 25;
const LAZY_DECIMAL = process.env.LAZY_DECIMALS ?? 1;
const LAZY_MAX_SUPPLY = process.env.LAZY_MAX_SUPPLY ?? 250_000_000;
const LAZY_COST_FOR_TRADE = process.env.LAZY_COST_FOR_TRADE ?? 103;

const addressRegex = /(\d+\.\d+\.[1-9]\d+)/i;

// reused variables
let lstContractAddress, lstContractId, ldrAddress;
let lazyIface, lazyGasStationIface, lazySecureTradeIface, lazyDelegateRegistryIface;
let lazyTokenId;
let alicePK, aliceId;
let bobPK, bobId;
let charliePK, charlieId;
let client;
let lazySCT;
let StkNFTA_TokenId,
	StkNFTB_TokenId,
	StkNFTC_TokenId;
let lazyGasStationId;

const operatorFtAllowances = [];
const operatorNftAllowances = [];

describe('Deployment', () => {
	it('Should deploy the contract and setup conditions', async () => {
		if (
			operatorKey === undefined ||
			operatorKey == null ||
			operatorId === undefined ||
			operatorId == null
		) {
			console.log(
				'Environment required, please specify PRIVATE_KEY & ACCOUNT_ID in the .env file',
			);
			process.exit(1);
		}

		console.log('\n-Using ENIVRONMENT:', env);

		if (env.toUpperCase() == 'TEST') {
			client = Client.forTestnet();
			console.log('testing in *TESTNET*');
		}
		else if (env.toUpperCase() == 'MAIN') {
			client = Client.forMainnet();
			console.log('testing in *MAINNET*');
		}
		else if (env.toUpperCase() == 'PREVIEW') {
			client = Client.forPreviewnet();
			console.log('testing in *PREVIEWNET*');
		}
		else if (env.toUpperCase() == 'LOCAL') {
			const node = { '127.0.0.1:50211': new AccountId(3) };
			client = Client.forNetwork(node).setMirrorNetwork('127.0.0.1:5600');
			console.log('testing in *LOCAL*');
			const rootId = AccountId.fromString('0.0.2');
			const rootKey = PrivateKey.fromStringED25519(
				'302e020100300506032b65700422042091132178e72057a1d7528025956fe39b0b847f200ab59b2fdd367017f3087137',
			);

			// create an operator account on the local node and use this for testing as operator
			client.setOperator(rootId, rootKey);
			operatorKey = PrivateKey.generateED25519();
			operatorId = await accountCreator(client, operatorKey, 1000);
		}
		else {
			console.log(
				'ERROR: Must specify either MAIN or TEST or PREVIEW or LOCAL as environment in .env file',
			);
			return;
		}

		client.setOperator(operatorId, operatorKey);
		// deploy the contract
		console.log('\n-Using Operator:', operatorId.toString());

		// moving account create up to fail fast is the service is busy.

		// create Alice account
		if (process.env.ALICE_ACCOUNT_ID && process.env.ALICE_PRIVATE_KEY) {
			aliceId = AccountId.fromString(process.env.ALICE_ACCOUNT_ID);
			alicePK = PrivateKey.fromStringED25519(process.env.ALICE_PRIVATE_KEY);
			console.log('\n-Using existing Alice:', aliceId.toString());

			// check if Alice has hbars
			const hbarBalance = await checkMirrorHbarBalance(env, aliceId);
			if (hbarBalance < Number(new Hbar(200, HbarUnit.Hbar).toTinybars())) {
				await sendHbar(client, operatorId, aliceId, 200, HbarUnit.Hbar);
			}
		}
		else {
			alicePK = PrivateKey.generateED25519();
			aliceId = await accountCreator(client, alicePK, 200);
			console.log(
				'Alice account ID:',
				aliceId.toString(),
				aliceId.toSolidityAddress(),
				'\nkey:',
				alicePK.toString(),
			);
		}
		expect(aliceId.toString().match(addressRegex).length == 2).to.be.true;

		// create Bob account
		if (process.env.BOB_ACCOUNT_ID && process.env.BOB_PRIVATE_KEY) {
			bobId = AccountId.fromString(process.env.BOB_ACCOUNT_ID);
			bobPK = PrivateKey.fromStringED25519(process.env.BOB_PRIVATE_KEY);
			console.log('\n-Using existing Bob:', bobId.toString());

			// send Bob some hbars
			const hbarBalance = await checkMirrorHbarBalance(env, bobId);
			if (hbarBalance < Number(new Hbar(50, HbarUnit.Hbar).toTinybars())) {
				await sendHbar(client, operatorId, bobId, 50, HbarUnit.Hbar);
			}
		}
		else {
			bobPK = PrivateKey.generateED25519();
			bobId = await accountCreator(client, bobPK, 50);
			console.log(
				'Bob account ID:',
				bobId.toString(),
				bobId.toSolidityAddress(),
				'\nkey:',
				bobPK.toString(),
			);
		}
		expect(bobId.toString().match(addressRegex).length == 2).to.be.true;

		// outside the if statement as we always need this abi
		// check if LAZY SCT has been deployed
		const lazyJson = JSON.parse(
			fs.readFileSync(
				`./artifacts/contracts/legacy/${lazyContractCreator}.sol/${lazyContractCreator}.json`,
			),
		);

		// import ABIs
		lazyIface = new ethers.Interface(lazyJson.abi);

		const lazyContractBytecode = lazyJson.bytecode;

		if (process.env.LAZY_SCT_CONTRACT_ID && process.env.LAZY_TOKEN_ID) {
			console.log(
				'\n-Using existing LAZY SCT:',
				process.env.LAZY_SCT_CONTRACT_ID,
			);
			lazySCT = ContractId.fromString(process.env.LAZY_SCT_CONTRACT_ID);


			lazyTokenId = TokenId.fromString(process.env.LAZY_TOKEN_ID);
			console.log('\n-Using existing LAZY Token ID:', lazyTokenId.toString());
		}
		else {
			const gasLimit = 5_800_000;

			console.log(
				'\n- Deploying contract...',
				lazyContractCreator,
				'\n\tgas@',
				gasLimit,
			);

			[lazySCT] = await contractDeployFunction(client, lazyContractBytecode, gasLimit);

			console.log(
				`Lazy Token Creator contract created with ID: ${lazySCT} / ${lazySCT.toSolidityAddress()}`,
			);

			expect(lazySCT.toString().match(addressRegex).length == 2).to.be.true;

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
			console.log('$LAZY Token minted:', lazyTokenId.toString());
		}

		expect(lazySCT.toString().match(addressRegex).length == 2).to.be.true;
		expect(lazyTokenId.toString().match(addressRegex).length == 2).to.be.true;

		const lazyGasStationJSON = JSON.parse(
			fs.readFileSync(
				`./artifacts/contracts/${lazyGasStationName}.sol/${lazyGasStationName}.json`,
			),
		);

		lazyGasStationIface = new ethers.Interface(lazyGasStationJSON.abi);
		if (process.env.LAZY_GAS_STATION_CONTRACT_ID) {
			console.log(
				'\n-Using existing Lazy Gas Station:',
				process.env.LAZY_GAS_STATION_CONTRACT_ID,
			);
			lazyGasStationId = ContractId.fromString(
				process.env.LAZY_GAS_STATION_CONTRACT_ID,
			);
		}
		else {
			const gasLimit = 6_800_000;
			console.log(
				'\n- Deploying contract...',
				lazyGasStationName,
				'\n\tgas@',
				gasLimit,
			);

			const lazyGasStationBytecode = lazyGasStationJSON.bytecode;

			const lazyGasStationParams = new ContractFunctionParameters()
				.addAddress(lazyTokenId.toSolidityAddress())
				.addAddress(lazySCT.toSolidityAddress());

			[lazyGasStationId] = await contractDeployFunction(
				client,
				lazyGasStationBytecode,
				gasLimit,
				lazyGasStationParams,
			);

			console.log(
				`Lazy Gas Station contract created with ID: ${lazyGasStationId} / ${lazyGasStationId.toSolidityAddress()}`,
			);

			expect(lazyGasStationId.toString().match(addressRegex).length == 2).to.be
				.true;
		}

		const ldrJson = JSON.parse(
			fs.readFileSync(
				`./artifacts/contracts/${lazyDelegateRegistryName}.sol/${lazyDelegateRegistryName}.json`,
			),
		);

		const ldrBytecode = ldrJson.bytecode;

		lazyDelegateRegistryIface = ethers.Interface.from(ldrJson.abi);

		if (process.env.LAZY_DELEGATE_REGISTRY_CONTRACT_ID) {
			console.log(
				'\n-Using existing Lazy Delegate Registry:',
				process.env.LAZY_DELEGATE_REGISTRY_CONTRACT_ID,
			);
			ldrAddress = ContractId.fromString(
				process.env.LAZY_DELEGATE_REGISTRY_CONTRACT_ID,
			);
		}
		else {
			const gasLimit = 6_800_000;

			console.log('\n- Deploying contract...', lazyDelegateRegistryName, '\n\tgas@', gasLimit);

			[ldrAddress] = await contractDeployFunction(client, ldrBytecode, gasLimit);

			console.log(
				`Lazy Delegate Registry contract created with ID: ${ldrAddress} / ${ldrAddress.toSolidityAddress()}`,
			);

			expect(ldrAddress.toString().match(addressRegex).length == 2).to.be.true;
		}

		// mint NFTs from the 3rd party Alice Account
		// ensure royalties in place
		/*
			3 x Different NFTs of size 15 each
		*/

		const nftSize = 15;

		client.setOperator(aliceId, alicePK);
		let [result, tokenId] = await mintNFT(
			client,
			aliceId,
			'Stk NFT A',
			'StkNFTA',
			nftSize,
		);
		expect(result).to.be.equal('SUCCESS');
		StkNFTA_TokenId = tokenId;

		[result, tokenId] = await mintNFT(
			client,
			aliceId,
			'Stk NFT B',
			'StkNFTB',
			nftSize,
		);
		expect(result).to.be.equal('SUCCESS');
		StkNFTB_TokenId = tokenId;

		[result, tokenId] = await mintNFT(
			client,
			aliceId,
			'Stk NFT C',
			'StkNFTC',
			nftSize,
		);
		expect(result).to.be.equal('SUCCESS');
		StkNFTC_TokenId = tokenId;

		// revert back to operator
		client.setOperator(operatorId, operatorKey);


		const gasLimit = 7_800_000;

		// now deploy main contract
		const lazySecureTradeJson = JSON.parse(
			fs.readFileSync(
				`./artifacts/contracts/${contractName}.sol/${contractName}.json`,
			),
		);

		// import ABI
		lazySecureTradeIface = ethers.Interface.from(lazySecureTradeJson.abi);

		const contractBytecode = lazySecureTradeJson.bytecode;

		console.log(
			'\n- Deploying contract...',
			contractName,
			'\n\tgas@',
			gasLimit,
		);

		const constructorParams = new ContractFunctionParameters()
			.addAddress(lazyTokenId.toSolidityAddress())
			.addAddress(lazyGasStationId.toSolidityAddress())
			.addAddress(ldrAddress.toSolidityAddress())
			.addAddress(StkNFTB_TokenId.toSolidityAddress())
			.addAddress(StkNFTC_TokenId.toSolidityAddress())
			.addAddress(StkNFTC_TokenId.toSolidityAddress())
			.addUint256(LAZY_COST_FOR_TRADE)
			.addUint256(LAZY_BURN_PERCENT);

		[lstContractId, lstContractAddress] = await contractDeployFunction(
			client,
			contractBytecode,
			gasLimit,
			constructorParams,
		);

		expect(lstContractId.toString().match(addressRegex).length == 2).to.be.true;

		console.log(
			`Lazy Secure Trade Contract created with ID: ${lstContractId} / ${lstContractAddress}`,
		);

		console.log('\n-Testing:', contractName);

		// associate the FTs & NFT to operator
		client.setOperator(operatorId, operatorKey);
		const operatorTokensToAssociate = [];
		// check if the lazy token is already associated to the operator
		if (await checkMirrorBalance(env, operatorId, lazyTokenId) === null) {
			operatorTokensToAssociate.push(lazyTokenId);
		}
		operatorTokensToAssociate.push(
			StkNFTA_TokenId,
			StkNFTB_TokenId,
			StkNFTC_TokenId,
		);

		result = await associateTokensToAccount(
			client,
			operatorId,
			operatorKey,
			operatorTokensToAssociate,
		);

		expect(result).to.be.equal('SUCCESS');

		// associate the token for Alice
		// alice has the NFTs already associated

		// check the balance of lazy tokens for Alice from mirror node
		const aliceLazyBalance = await checkMirrorBalance(
			env,
			aliceId,
			lazyTokenId,
		);

		if (!aliceLazyBalance) {
			result = await associateTokensToAccount(client, aliceId, alicePK, [
				lazyTokenId,
			]);
			expect(result).to.be.equal('SUCCESS');
		}

		// check the balance of lazy tokens for Bob from mirror node
		const bobLazyBalance = await checkMirrorBalance(env, bobId, lazyTokenId);

		const bobTokensToAssociate = [];
		if (!bobLazyBalance) {
			bobTokensToAssociate.push(lazyTokenId);
		}

		bobTokensToAssociate.push(
			StkNFTA_TokenId,
			StkNFTB_TokenId,
			StkNFTC_TokenId,
		);

		// associate the tokens for Bob
		result = await associateTokensToAccount(
			client,
			bobId,
			bobPK,
			bobTokensToAssociate,
		);
		expect(result).to.be.equal('SUCCESS');

		// send $LAZY to all accounts
		client.setOperator(operatorId, operatorKey);
		result = await sendLazy(operatorId, 2000 * 10 ** LAZY_DECIMAL);
		expect(result).to.be.equal('SUCCESS');
		result = await sendLazy(aliceId, 2000 * 10 ** LAZY_DECIMAL);
		expect(result).to.be.equal('SUCCESS');
		result = await sendLazy(bobId, 2000 * 10 ** LAZY_DECIMAL);
		expect(result).to.be.equal('SUCCESS');
		result = await sendHbar(client, operatorId, AccountId.fromString(lazyGasStationId.toString()), 1, HbarUnit.Hbar);
		expect(result).to.be.equal('SUCCESS');

		// send $LAZY to the Lazy Gas Station
		// gas station will fuel payouts so ensure it has enough
		result = await sendLazy(lazyGasStationId, 10000 * 10 ** LAZY_DECIMAL);
		expect(result).to.be.equal('SUCCESS');

		// add the LST to the lazy gas station as a contract user
		result = await contractExecuteFunction(
			lazyGasStationId,
			lazyGasStationIface,
			client,
			null,
			'addContractUser',
			[lstContractId.toSolidityAddress()],
		);

		if (result[0]?.status.toString() != 'SUCCESS') {
			console.log('ERROR adding LST to LGS:', result);
			fail();
		}

		// check the GasStationAccessControlEvent on the mirror node
		await sleep(4500);
		const lgsEvent = await checkLastMirrorEvent(
			env,
			lazyGasStationId,
			lazyGasStationIface,
			1,
			true,
		);

		expect(lgsEvent.toSolidityAddress().toLowerCase()).to.be.equal(
			lstContractId.toSolidityAddress(),
		);

		client.setOperator(aliceId, alicePK);

		// send NFTs 1-5 to Operator
		const serials = [...Array(nftSize).keys()].map((x) => ++x);
		result = await sendNFT(
			client,
			aliceId,
			operatorId,
			StkNFTA_TokenId,
			serials.slice(0, 5),
		);
		expect(result).to.be.equal('SUCCESS');

		result = await sendNFT(
			client,
			aliceId,
			operatorId,
			StkNFTB_TokenId,
			serials.slice(0, 5),
		);
		expect(result).to.be.equal('SUCCESS');

		result = await sendNFT(
			client,
			aliceId,
			operatorId,
			StkNFTC_TokenId,
			serials.slice(0, 5),
		);
		expect(result).to.be.equal('SUCCESS');
	});
});

describe('Check Contract Deployment', () => {
	it('Should check the contract configuration', async () => {
		client.setOperator(operatorId, operatorKey);

		// get tradeNonce
		const tradeNonceResult = await contractExecuteQuery(
			lstContractId,
			lazySecureTradeIface,
			client,
			null,
			'tradeNonce',
		);
		expect(Number(tradeNonceResult[0])).to.be.equal(
			0,
		);

		// get lazyBurnPercentage
		const burnPercentageResult = await contractExecuteQuery(
			lstContractId,
			lazySecureTradeIface,
			client,
			null,
			'lazyBurnPercentage',
		);
		expect(Number(burnPercentageResult[0])).to.be.equal(
			Number(LAZY_BURN_PERCENT),
		);

		// get lazyCostForTrade
		const lazyCostForTradeResult = await contractExecuteQuery(
			lstContractId,
			lazySecureTradeIface,
			client,
			null,
			'lazyCostForTrade',
		);
		expect(Number(lazyCostForTradeResult[0])).to.be.equal(
			Number(LAZY_COST_FOR_TRADE),
		);

		// get LSH_GEN1
		const lshGen1Result = await contractExecuteQuery(
			lstContractId,
			lazySecureTradeIface,
			client,
			null,
			'LSH_GEN1',
		);

		expect(lshGen1Result[0].slice(2).toLowerCase()).to.be.equal(
			StkNFTB_TokenId.toSolidityAddress().toLowerCase(),
		);

		// get LSH_GEN2 from the mirror nodes
		const encodedCommand = lazySecureTradeIface.encodeFunctionData(
			'LSH_GEN2',
		);

		const lshGen2 = await readOnlyEVMFromMirrorNode(
			env,
			lstContractId,
			encodedCommand,
			operatorId,
			false,
		);

		const lshGenResult = lazySecureTradeIface.decodeFunctionResult(
			'LSH_GEN2',
			lshGen2,
		);

		expect(lshGenResult[0].slice(2).toLowerCase()).to.be.equal(
			StkNFTC_TokenId.toSolidityAddress().toLowerCase(),
		);
	});

	it('Should check access controls', async () => {
		let expectedErrors = 0;
		let unexpectedErrors = 0;

		// ALICE is not owner so expect failures
		client.setOperator(aliceId, alicePK);

		// setLazyCostForTrade
		try {
			const result = await contractExecuteFunction(
				lstContractId,
				lazySecureTradeIface,
				client,
				null,
				'setLazyCostForTrade',
				[1],
			);
			if (
				result[0].status.toString() ==
				'REVERT: Ownable: caller is not the owner'
			) {
				expectedErrors++;
			}
			else {
				console.log('Unexpected Result (setLazyCostForTrade):', result);
				unexpectedErrors++;
			}
		}
		catch (err) {
			console.log(err);
			unexpectedErrors++;
		}

		// setLazyBurnPercentage
		try {
			const result = await contractExecuteFunction(
				lstContractId,
				lazySecureTradeIface,
				client,
				null,
				'setLazyBurnPercentage',
				[11],
			);
			if (
				result[0].status.toString() ==
				'REVERT: Ownable: caller is not the owner'
			) {
				expectedErrors++;
			}
			else {
				console.log('Unexpected Result (setLazyBurnPercentage):', result);
				unexpectedErrors++;
			}
		}
		catch (err) {
			console.log(err);
			unexpectedErrors++;
		}

		// withdrawPlatformFees
		try {
			const result = await contractExecuteFunction(
				lstContractId,
				lazySecureTradeIface,
				client,
				null,
				'withdrawPlatformFees',
				[aliceId.toSolidityAddress()],
			);
			if (
				result[0].status.toString() ==
				'REVERT: Ownable: caller is not the owner'
			) {
				expectedErrors++;
			}
			else {
				console.log('Unexpected Result (withdrawPlatformFees):', result);
				unexpectedErrors++;
			}
		}
		catch (err) {
			console.log(err);
			unexpectedErrors++;
		}

		// retrieveLazy
		try {
			const result = await contractExecuteFunction(
				lstContractId,
				lazySecureTradeIface,
				client,
				null,
				'retrieveLazy',
				[aliceId.toSolidityAddress(), 1],
			);
			if (
				result[0].status.toString() ==
				'REVERT: Ownable: caller is not the owner'
			) {
				console.log('Expected Result (retrieveLazy):', result);
				expectedErrors++;
			}
		}
		catch (err) {
			console.log(err);
			unexpectedErrors++;
		}

		console.log('Expected errors:', expectedErrors);
		console.log('Unexpected errors:', unexpectedErrors);

		expect(expectedErrors).to.be.equal(4);
		expect(unexpectedErrors).to.be.equal(0);
	});
});

// SKIPPING v1 TESTS - Focus on v0.2 Platform Fee System Testing
describe.skip('Secure Trades are go...', () => {
	it('Operator Creates a trade for Bob (hbar only)', async () => {
		client.setOperator(operatorId, operatorKey);

		// set an NFT allowance for the operator to the contract
		const nftAllowanceResult = await setNFTAllowanceAll(
			client,
			[StkNFTA_TokenId],
			operatorId,
			AccountId.fromString(lstContractId.toString()),
		);

		operatorNftAllowances.push({
			tokenId: StkNFTA_TokenId,
			owner: operatorId,
			spender: AccountId.fromString(lstContractId.toString()),
		});

		expect(nftAllowanceResult).to.be.equal('SUCCESS');

		// create a trade for Bob
		const tradeResult = await contractExecuteFunction(
			lstContractId,
			lazySecureTradeIface,
			client,
			950_000 + 500_000,
			'createTrade',
			[
				StkNFTA_TokenId.toSolidityAddress(),
				bobId.toSolidityAddress(),
				1,
				Number(new Hbar(1, HbarUnit.Hbar).toTinybars()),
				0,
				0,
			],
		);

		expect(tradeResult[0].status.toString()).to.be.equal('SUCCESS');

		console.log('Trade created:', tradeResult[2]?.transactionId?.toString());
	});

	it('Check Alice/Operator can not accept the trade', async () => {
		// let mirror node catch up
		await sleep(5000);

		client.setOperator(aliceId, alicePK);
		// query trades available to Alice (expect 0) via mirror node
		let encodedCommand = lazySecureTradeIface.encodeFunctionData(
			'getUserTrades',
			[aliceId.toSolidityAddress()],
		);

		let userTrades = await readOnlyEVMFromMirrorNode(
			env,
			lstContractId,
			encodedCommand,
			operatorId,
			false,
		);

		let userTradesResult = lazySecureTradeIface.decodeFunctionResult(
			'getUserTrades',
			userTrades,
		);

		expect(userTradesResult[0].length).to.be.equal(0);

		// execute getUserTrades for Bob via mirror node
		encodedCommand = lazySecureTradeIface.encodeFunctionData(
			'getUserTrades',
			[bobId.toSolidityAddress()],
		);

		userTrades = await readOnlyEVMFromMirrorNode(
			env,
			lstContractId,
			encodedCommand,
			operatorId,
			false,
		);

		userTradesResult = lazySecureTradeIface.decodeFunctionResult(
			'getUserTrades',
			userTrades,
		);

		expect(userTradesResult[0].length).to.be.equal(1);

		const bobTrade = userTradesResult[0][0];

		// make sure the token is not in getTokenTrades for StkNFTA
		encodedCommand = lazySecureTradeIface.encodeFunctionData(
			'getTokenTrades',
			[StkNFTA_TokenId.toSolidityAddress()],
		);

		const tokenTrades = await readOnlyEVMFromMirrorNode(
			env,
			lstContractId,
			encodedCommand,
			operatorId,
			false,
		);

		const tokenTradesResult = lazySecureTradeIface.decodeFunctionResult(
			'getTokenTrades',
			tokenTrades,
		);

		expect(tokenTradesResult[0].length).to.be.equal(0);

		// check isTradeValid for address(0) expect true
		encodedCommand = lazySecureTradeIface.encodeFunctionData(
			'isTradeValid',
			[bobTrade, ethers.ZeroAddress],
		);

		const tradeValid = await readOnlyEVMFromMirrorNode(
			env,
			lstContractId,
			encodedCommand,
			operatorId,
			false,
		);

		const tradeValidResult = lazySecureTradeIface.decodeFunctionResult(
			'isTradeValid',
			tradeValid,
		);

		expect(tradeValidResult[0]).to.be.true;

		// executeTrade for Alice expect failure with TradeNotFoundOrInvalid
		let tradeExecutionResult = await contractExecuteFunction(
			lstContractId,
			lazySecureTradeIface,
			client,
			650_000,
			'executeTrade',
			[bobTrade],
			new Hbar(1, HbarUnit.Hbar),
		);

		if (tradeExecutionResult[0]?.status?.name != 'TradeNotFoundOrInvalid') {
			console.log('ERROR expecting TradeNotFoundOrInvalid:', tradeExecutionResult);
			fail();
		}

		// now try as operator
		client.setOperator(operatorId, operatorKey);

		// check isTradeValid for Operator expect true (as operator is the seeller)

		encodedCommand = lazySecureTradeIface.encodeFunctionData(
			'isTradeValid',
			[bobTrade, operatorId.toSolidityAddress()],
		);

		const tradeValidOperator = await readOnlyEVMFromMirrorNode(
			env,
			lstContractId,
			encodedCommand,
			operatorId,
			false,
		);

		const tradeValidOperatorResult = lazySecureTradeIface.decodeFunctionResult(
			'isTradeValid',
			tradeValidOperator,
		);

		expect(tradeValidOperatorResult[0]).to.be.true;

		// valid trade but not executable
		// executeTrade for Operator expect failure TradeNotFoundOrInvalid

		tradeExecutionResult = await contractExecuteFunction(
			lstContractId,
			lazySecureTradeIface,
			client,
			650_000,
			'executeTrade',
			[bobTrade],
			new Hbar(1, HbarUnit.Hbar),
		);

		if (tradeExecutionResult[0]?.status?.name != 'SellerCannotBeBuyer') {
			console.log('ERROR expecting SellerCannotBeBuyer:', tradeExecutionResult);
			fail();
		}
	});

	it('Bob accepts the trade', async () => {
		client.setOperator(bobId, bobPK);
		// Query the trades available to Bob
		// execute getUserTrades for Bob via mirror node
		let encodedCommand = lazySecureTradeIface.encodeFunctionData(
			'getUserTrades',
			[bobId.toSolidityAddress()],
		);

		const userTrades = await readOnlyEVMFromMirrorNode(
			env,
			lstContractId,
			encodedCommand,
			operatorId,
			false,
		);

		const userTradesResult = lazySecureTradeIface.decodeFunctionResult(
			'getUserTrades',
			userTrades,
		);

		expect(userTradesResult[0].length).to.be.equal(1);

		const bobTrade = userTradesResult[0][0];

		console.log('Bob trade:', bobTrade);

		// check the trade details
		encodedCommand = lazySecureTradeIface.encodeFunctionData(
			'getTrade',
			[bobTrade],
		);

		const trade = await readOnlyEVMFromMirrorNode(
			env,
			lstContractId,
			encodedCommand,
			operatorId,
			false,
		);

		const tradeResult = lazySecureTradeIface.decodeFunctionResult(
			'getTrade',
			trade,
		);

		console.log('Bob trade details:', tradeResult);

		// check isTradeValid for Bob expect true
		encodedCommand = lazySecureTradeIface.encodeFunctionData(
			'isTradeValid',
			[bobTrade, bobId.toSolidityAddress()],
		);

		const tradeValid = await readOnlyEVMFromMirrorNode(
			env,
			lstContractId,
			encodedCommand,
			operatorId,
			false,
		);

		const tradeValidResult = lazySecureTradeIface.decodeFunctionResult(
			'isTradeValid',
			tradeValid,
		);

		console.log('Bob trade valid:', tradeValidResult);

		if (!tradeValidResult[0]) {
			console.log('Bob trade is not valid:', bobTrade);
			fail();
		}

		// set a 1 tinybar allowance to LST
		const allowanceResult = await setHbarAllowance(
			client,
			bobId,
			AccountId.fromString(lstContractId.toString()),
			1,
			HbarUnit.Tinybar,
		);

		expect(allowanceResult).to.be.equal('SUCCESS');

		if (allowanceResult != 'SUCCESS') {
			console.log('Bob Hbar allowance failed:', allowanceResult);
			fail();
		}

		// executeTrade
		// sending > 1 hbar to check the additional value is returned
		const tradeExecutionResult = await contractExecuteFunction(
			lstContractId,
			lazySecureTradeIface,
			client,
			650_000,
			'executeTrade',
			[bobTrade],
			new Hbar(2, HbarUnit.Hbar),
		);

		if (tradeExecutionResult[0]?.status?.toString() != 'SUCCESS') {
			console.log('Trade Execution Error:', tradeExecutionResult);
			fail();
		}

		console.log('Bob Trade Execution tx:', tradeExecutionResult[2]?.transactionId?.toString());
	});

	it('Operator creates a listing for Alice for $LAZY (0 hbar), Alice Accepts', async () => {
		client.setOperator(operatorId, operatorKey);

		// set an NFT allowance for the operator to the contract
		const nftAllowanceResult = await setNFTAllowanceAll(
			client,
			[StkNFTB_TokenId],
			operatorId,
			AccountId.fromString(lstContractId.toString()),
		);

		operatorNftAllowances.push({
			tokenId: StkNFTB_TokenId,
			owner: operatorId,
			spender: AccountId.fromString(lstContractId.toString()),
		});

		expect(nftAllowanceResult).to.be.equal('SUCCESS');

		// create a trade for Alice
		let tradeResult = await contractExecuteFunction(
			lstContractId,
			lazySecureTradeIface,
			client,
			950_000 + 500_000,
			'createTrade',
			[
				StkNFTB_TokenId.toSolidityAddress(),
				aliceId.toSolidityAddress(),
				1,
				0,
				23,
				0,
			],
		);

		if (tradeResult[0]?.status?.toString() != 'SUCCESS') {
			console.log('Trade Creation Error (buyer = Alice):', tradeResult);
			fail();
		}

		// let mirror node catch up
		await sleep(5000);

		client.setOperator(aliceId, alicePK);

		// query trades available to Alice (expect 1) via mirror node
		let encodedCommand = lazySecureTradeIface.encodeFunctionData(
			'getUserTrades',
			[aliceId.toSolidityAddress()],
		);

		const userTrades = await readOnlyEVMFromMirrorNode(
			env,
			lstContractId,
			encodedCommand,
			operatorId,
			false,
		);

		const userTradesResult = lazySecureTradeIface.decodeFunctionResult(
			'getUserTrades',
			userTrades,
		);

		expect(userTradesResult[0].length).to.be.equal(1);

		const aliceTrade = userTradesResult[0][0];

		// trade hash should be the keccak256 of token and serial
		const tradeHashToCheck = ethers.solidityPackedKeccak256(
			['address', 'uint256'],
			[StkNFTB_TokenId.toSolidityAddress(), 1],
		);

		expect(aliceTrade).to.be.equal(tradeHashToCheck);

		// check the trade details
		encodedCommand = lazySecureTradeIface.encodeFunctionData(
			'getTrade',
			[aliceTrade],
		);

		const trade = await readOnlyEVMFromMirrorNode(
			env,
			lstContractId,
			encodedCommand,
			operatorId,
			false,
		);

		tradeResult = lazySecureTradeIface.decodeFunctionResult(
			'getTrade',
			trade,
		);

		console.log('Alice trade details:', tradeResult);

		// check isTradeValid for Alice expect true
		encodedCommand = lazySecureTradeIface.encodeFunctionData(
			'isTradeValid',
			[aliceTrade, aliceId.toSolidityAddress()],
		);

		const tradeValid = await readOnlyEVMFromMirrorNode(
			env,
			lstContractId,
			encodedCommand,
			operatorId,
			false,
		);

		const tradeValidResult = lazySecureTradeIface.decodeFunctionResult(
			'isTradeValid',
			tradeValid,
		);

		console.log('Alice trade valid:', tradeValidResult);

		expect(tradeValidResult[0]).to.be.true;

		// set a 1 tinybar allowance to LST
		const allowanceResult = await setFTAllowance(
			client,
			lazyTokenId,
			aliceId,
			AccountId.fromString(lazyGasStationId.toString()),
			23,
		);

		// set a 1 tinybar allowance to LST
		const hbarAllowanceResult = await setHbarAllowance(
			client,
			aliceId,
			AccountId.fromString(lstContractId.toString()),
			1,
			HbarUnit.Tinybar,
		);

		expect(hbarAllowanceResult).to.be.equal('SUCCESS');

		expect(allowanceResult).to.be.equal('SUCCESS');

		// executeTrade
		// sending 0 hbar
		const tradeExecutionResult = await contractExecuteFunction(
			lstContractId,
			lazySecureTradeIface,
			client,
			650_000,
			'executeTrade',
			[aliceTrade],
			0,
		);

		if (tradeExecutionResult[0]?.status?.toString() != 'SUCCESS') {
			console.log('Trade Execution Error (Operator creates a listing for Alice for $LAZY):', tradeExecutionResult);
			fail();
		}

		console.log('Alice Trade Execution tx:', tradeExecutionResult[2]?.transactionId?.toString());
	});

	it('Operator creates a listing with zero address as user for 11 $LAZY (2 hbar), Bob Accepts', async () => {
		client.setOperator(operatorId, operatorKey);

		// Allowance should be in place for the StkA NFT

		// user owns an LSH Gen1 or Gen2 NFT so no $LAZY cost to list

		// create a trade for null user
		const tradeResult = await contractExecuteFunction(
			lstContractId,
			lazySecureTradeIface,
			client,
			500_000,
			'createTrade',
			[
				StkNFTA_TokenId.toSolidityAddress(),
				ethers.ZeroAddress,
				2,
				Number(new Hbar(2, HbarUnit.Hbar).toTinybars()),
				11,
				0,
			],
		);

		if (tradeResult[0].status.toString() != 'SUCCESS') {
			console.log('Trade Creation Error (buyer = zero):', tradeResult);
			fail();
		}

		console.log('Trade created:', tradeResult[2]?.transactionId?.toString());

		// let mirror node catch up
		await sleep(5500);

		// expect to see this in the getTokenTrades method
		let encodedCommand = lazySecureTradeIface.encodeFunctionData(
			'getTokenTrades',
			[StkNFTA_TokenId.toSolidityAddress()],
		);

		let tokenTrades = await readOnlyEVMFromMirrorNode(
			env,
			lstContractId,
			encodedCommand,
			operatorId,
			false,
		);

		let tokenTradesResult = lazySecureTradeIface.decodeFunctionResult(
			'getTokenTrades',
			tokenTrades,
		);

		if (tokenTradesResult[0].length != 1) {
			console.log('ERROR: Trade not found in getTokenTrades:', tokenTradesResult);
			fail();
		}

		const listingTrade = tokenTradesResult[0][0];

		client.setOperator(bobId, bobPK);

		// query trades available to Bob (expect 0) via mirror node
		encodedCommand = lazySecureTradeIface.encodeFunctionData(
			'getUserTrades',
			[bobId.toSolidityAddress()],
		);

		const userTrades = await readOnlyEVMFromMirrorNode(
			env,
			lstContractId,
			encodedCommand,
			operatorId,
			false,
		);

		const userTradesResult = lazySecureTradeIface.decodeFunctionResult(
			'getUserTrades',
			userTrades,
		);

		expect(userTradesResult[0].length).to.be.equal(0);

		// check isTradeValid for Bob expect true

		encodedCommand = lazySecureTradeIface.encodeFunctionData(
			'isTradeValid',
			[listingTrade, bobId.toSolidityAddress()],
		);

		const tradeValid = await readOnlyEVMFromMirrorNode(
			env,
			lstContractId,
			encodedCommand,
			operatorId,
			false,
		);

		const tradeValidResult = lazySecureTradeIface.decodeFunctionResult(
			'isTradeValid',
			tradeValid,
		);

		expect(tradeValidResult[0]).to.be.true;

		// set a 1 tinybar allowance to LST
		const allowanceResult = await setHbarAllowance(
			client,
			bobId,
			AccountId.fromString(lstContractId.toString()),
			1,
			HbarUnit.Tinybar,
		);

		// set a 11 $LAZY allowance to LGS
		const lazyAllowanceResult = await setFTAllowance(
			client,
			lazyTokenId,
			bobId,
			AccountId.fromString(lazyGasStationId.toString()),
			11,
		);

		expect(lazyAllowanceResult).to.be.equal('SUCCESS');

		expect(allowanceResult).to.be.equal('SUCCESS');

		// executeTrade
		// sending 2 hbar as tinybars

		const tradeExecutionResult = await contractExecuteFunction(
			lstContractId,
			lazySecureTradeIface,
			client,
			650_000,
			'executeTrade',
			[listingTrade],
			new Hbar(2, HbarUnit.Hbar),
		);

		if (tradeExecutionResult[0].status.toString() != 'SUCCESS') {
			console.log('Trade Execution Error:', tradeExecutionResult);
			fail();
		}

		console.log('Bob Executes Listing Trade tx:', tradeExecutionResult[2]?.transactionId?.toString());

		// let mirror node catch up
		await sleep(5000);

		// check getTokenTrades for StkNFTC expect 0
		encodedCommand = lazySecureTradeIface.encodeFunctionData(
			'getTokenTrades',
			[StkNFTA_TokenId.toSolidityAddress()],
		);

		tokenTrades = await readOnlyEVMFromMirrorNode(
			env,
			lstContractId,
			encodedCommand,
			operatorId,
			false,
		);

		tokenTradesResult = lazySecureTradeIface.decodeFunctionResult(
			'getTokenTrades',
			tokenTrades,
		);

		expect(tokenTradesResult[0].length).to.be.equal(0);
	});

	it('Bob creates a listing with zero address as user, pays $LAZY to list, Alice Accepts', async () => {
		// Bob creates a listing for Zero address, has to pay $LAZY to list [initially does not set allowance, thus expect failure]
		client.setOperator(bobId, bobPK);

		// set allowance for StkNFTC from Bob to LST
		const nftAllowanceResult = await setNFTAllowanceAll(
			client,
			[StkNFTA_TokenId],
			bobId,
			AccountId.fromString(lstContractId.toString()),
		);

		expect(nftAllowanceResult).to.be.equal('SUCCESS');

		// create a trade for null user
		let tradeResult = await contractExecuteFunction(
			lstContractId,
			lazySecureTradeIface,
			client,
			500_000,
			'createTrade',
			[
				StkNFTA_TokenId.toSolidityAddress(),
				ethers.ZeroAddress,
				2,
				Number(new Hbar(1.5, HbarUnit.Hbar).toTinybars()),
				0,
				0,
			],
		);

		if (tradeResult[0]?.status?.toString() == 'SUCCESS') {
			console.log('ERROR: Trade Creation should have failed');
			console.log('Trade [Bob creates a listing with zero address] Create Result:', tradeResult);
			fail();
		}

		// set a $LAZY allowance for LAZY_COST_FOR_TRADE to LGS
		const lazyAllowanceResult = await setFTAllowance(
			client,
			lazyTokenId,
			bobId,
			AccountId.fromString(lazyGasStationId.toString()),
			LAZY_COST_FOR_TRADE,
		);

		if (lazyAllowanceResult != 'SUCCESS') {
			console.log('ERROR: $LAZY allowance failed', lazyAllowanceResult);
			fail();
		}

		// create a trade for null user - now expect success
		tradeResult = await contractExecuteFunction(
			lstContractId,
			lazySecureTradeIface,
			client,
			500_000,
			'createTrade',
			[
				StkNFTA_TokenId.toSolidityAddress(),
				ethers.ZeroAddress,
				2,
				Number(new Hbar(1.5, HbarUnit.Hbar).toTinybars()),
				0,
				0,
			],
		);

		if (tradeResult[0]?.status?.toString() != 'SUCCESS') {
			console.log('ERROR: Trade Creation failed');
			console.log('Trade Create Result:', tradeResult);
			fail();
		}

		console.log('Bob Trade Creation tx:', tradeResult[2]?.transactionId?.toString());
		console.log('Bob Trade Hash:', tradeResult[1]);

		// let mirror node catch up
		await sleep(5000);

		client.setOperator(aliceId, alicePK);

		// query trades available to Alice (expect 0) via mirror node

		let encodedCommand = lazySecureTradeIface.encodeFunctionData(
			'getUserTrades',
			[aliceId.toSolidityAddress()],
		);

		const userTrades = await readOnlyEVMFromMirrorNode(
			env,
			lstContractId,
			encodedCommand,
			operatorId,
			false,
		);

		const userTradesResult = lazySecureTradeIface.decodeFunctionResult(
			'getUserTrades',
			userTrades,
		);

		expect(userTradesResult[0].length).to.be.equal(0);

		// query trades available for getTokenTrades for StkNFTA
		encodedCommand = lazySecureTradeIface.encodeFunctionData(
			'getTokenTrades',
			[StkNFTA_TokenId.toSolidityAddress()],
		);

		const tokenTrades = await readOnlyEVMFromMirrorNode(
			env,
			lstContractId,
			encodedCommand,
			operatorId,
			false,
		);

		const tokenTradesResult = lazySecureTradeIface.decodeFunctionResult(
			'getTokenTrades',
			tokenTrades,
		);

		console.log('Token Trades:', tokenTradesResult[0], 'compare to:', tradeResult[1]);

		expect(tokenTradesResult[0].length).to.be.equal(1);

		// Alice sets a tinybar allowance to LST
		const allowanceResult = await setHbarAllowance(
			client,
			aliceId,
			AccountId.fromString(lstContractId.toString()),
			1,
			HbarUnit.Tinybar,
		);

		expect(allowanceResult).to.be.equal('SUCCESS');

		// executeTrade for Alice
		const tradeExecutionResult = await contractExecuteFunction(
			lstContractId,
			lazySecureTradeIface,
			client,
			650_000,
			'executeTrade',
			[tradeResult[1][0]],
			new Hbar(1.5, HbarUnit.Hbar),
		);

		if (tradeExecutionResult[0].status.toString() != 'SUCCESS') {
			console.log('Trade Execution Error:', tradeExecutionResult);
			fail();
		}

		console.log('Alice Trade Execution tx:', tradeExecutionResult[2]?.transactionId?.toString());
	});

	it('Operator delegates LSH Gen 2 to Bob, Bob creates a listing for Zero Address with no payment needed, Alice Accepts', async () => {
		// let the mirror nodes catch up
		await sleep(5000);

		client.setOperator(bobId, bobPK);

		// check the $LAZY allowance for Bob to LGS is < LAZY_COST_FOR_TRADE
		const lazyAllowance = await checkFTAllowances(env, bobId);

		for (let a = 0; a < lazyAllowance.length; a++) {
			const allowance = lazyAllowance[a];
			if (
				allowance.token_id == lazyTokenId.toString() &&
				allowance.amount >= LAZY_COST_FOR_TRADE
			) {
				// revoke the allowance
				const res = await clearFTAllowances(client, [
					{
						tokenId: lazyTokenId,
						owner: bobId,
						spender: AccountId.fromString(lazyGasStationId.toString()),
					},
				]);

				expect(res).to.be.equal('SUCCESS');
				console.log('Revoked $LAZY allowance for Bob');
				break;
			}
		}

		client.setOperator(operatorId, operatorKey);

		// delegate StkNFTC, serial 4 to Bob
		const result = await contractExecuteFunction(
			ldrAddress,
			lazyDelegateRegistryIface,
			client,
			650_000,
			'delegateNFT',
			[bobId.toSolidityAddress(), StkNFTC_TokenId.toSolidityAddress(), [4]],
		);

		if (result[0]?.status?.toString() != 'SUCCESS') {
			console.log('ERROR: Delegation failed');
			console.log('Delegation Result:', result);
			fail();
		}

		console.log('Bob delegated LSH Gen2 tx:', result[2]?.transactionId?.toString());

		client.setOperator(bobId, bobPK);

		// Bob creates a trade for null user (no $LAZY payment as an LSH Gen2 NFT (delegate) owner)
		const tradeResult = await contractExecuteFunction(
			lstContractId,
			lazySecureTradeIface,
			client,
			500_000,
			'createTrade',
			[
				StkNFTA_TokenId.toSolidityAddress(),
				ethers.ZeroAddress,
				1,
				Number(new Hbar(1, HbarUnit.Hbar).toTinybars()),
				0,
				Math.floor(new Date().getTime() / 1000) + 5,
			],
		);

		if (tradeResult[0]?.status?.toString() != 'SUCCESS') {
			console.log('ERROR: Trade Creation failed');
			console.log('Trade Create Result:', tradeResult);
			fail();
		}

		console.log('trade hash:', tradeResult[1][0]);
		const tradeHashToCheck = ethers.solidityPackedKeccak256(
			['address', 'uint256'],
			[StkNFTA_TokenId.toSolidityAddress(), 1],
		);
		console.log('trade hash to check:', tradeHashToCheck);

		console.log('Bob (delegate) Trade Creation tx:', tradeResult[2]?.transactionId?.toString());

		// let mirror node catch up
		await sleep(5000);

		// expect this trade to be valid - check via mirror node
		let encodedCommand = lazySecureTradeIface.encodeFunctionData(
			'isTradeValid',
			[tradeHashToCheck, operatorId.toSolidityAddress()],
		);

		let tradeValid = await readOnlyEVMFromMirrorNode(
			env,
			lstContractId,
			encodedCommand,
			operatorId,
			false,
		);

		let tradeValidResult = lazySecureTradeIface.decodeFunctionResult(
			'isTradeValid',
			tradeValid,
		);

		expect(tradeValidResult[0]).to.be.true;

		// now sleep for 6 seconds to allow the trade to expire

		await sleep(6000);

		// expect this trade to be invalid - check via mirror node

		encodedCommand = lazySecureTradeIface.encodeFunctionData(
			'isTradeValid',
			[tradeHashToCheck, operatorId.toSolidityAddress()],
		);

		tradeValid = await readOnlyEVMFromMirrorNode(
			env,
			lstContractId,
			encodedCommand,
			operatorId,
			false,
		);

		tradeValidResult = lazySecureTradeIface.decodeFunctionResult(
			'isTradeValid',
			tradeValid,
		);

		expect(tradeValidResult[0]).to.be.false;
	});

	it('Operator create a trade, then cancels it', async () => {
		client.setOperator(operatorId, operatorKey);

		// rely on NFT allowance being in place StkNFTA_TokenId

		// create a trade for Bob
		const tradeResult = await contractExecuteFunction(
			lstContractId,
			lazySecureTradeIface,
			client,
			500_000,
			'createTrade',
			[
				StkNFTA_TokenId.toSolidityAddress(),
				bobId.toSolidityAddress(),
				4,
				Number(new Hbar(3, HbarUnit.Hbar).toTinybars()),
				0,
				0,
			],
		);

		expect(tradeResult[0].status.toString()).to.be.equal('SUCCESS');

		console.log('Trade created:', tradeResult[2]?.transactionId?.toString());

		const hashToCheck = tradeResult[1][0];

		// let mirror node catch up
		await sleep(5000);

		// check trade is valid for Bob via mirror node, expect true
		let encodedCommand = lazySecureTradeIface.encodeFunctionData(
			'isTradeValid',
			[hashToCheck, bobId.toSolidityAddress()],
		);

		let tradeValid = await readOnlyEVMFromMirrorNode(
			env,
			lstContractId,
			encodedCommand,
			operatorId,
			false,
		);

		let tradeValidResult = lazySecureTradeIface.decodeFunctionResult(
			'isTradeValid',
			tradeValid,
		);

		expect(tradeValidResult[0]).to.be.true;

		// cancel the trade
		const cancelResult = await contractExecuteFunction(
			lstContractId,
			lazySecureTradeIface,
			client,
			300_000,
			'cancelTrade',
			[hashToCheck],
		);

		expect(cancelResult[0].status.toString()).to.be.equal('SUCCESS');

		console.log('Trade cancelled:', cancelResult[2]?.transactionId?.toString());

		// let mirror node catch up
		await sleep(5000);

		// check trade is valid for Bob via mirror node, expect false
		encodedCommand = lazySecureTradeIface.encodeFunctionData(
			'isTradeValid',
			[hashToCheck, bobId.toSolidityAddress()],
		);

		tradeValid = await readOnlyEVMFromMirrorNode(
			env,
			lstContractId,
			encodedCommand,
			operatorId,
			false,
		);

		tradeValidResult = lazySecureTradeIface.decodeFunctionResult(
			'isTradeValid',
			tradeValid,
		);

		expect(tradeValidResult[0]).to.be.false;
	});

	it('Operator creates a trade then modifies it', async () => {
		client.setOperator(operatorId, operatorKey);

		// rely on NFT allowance being in place StkNFTA_TokenId

		// create a trade for Bob
		const tradeResult = await contractExecuteFunction(
			lstContractId,
			lazySecureTradeIface,
			client,
			500_000,
			'createTrade',
			[
				StkNFTA_TokenId.toSolidityAddress(),
				bobId.toSolidityAddress(),
				4,
				Number(new Hbar(3, HbarUnit.Hbar).toTinybars()),
				0,
				0,
			],
		);

		expect(tradeResult[0].status.toString()).to.be.equal('SUCCESS');

		console.log('Trade created:', tradeResult[2]?.transactionId?.toString());

		const hashToCheck = tradeResult[1][0];

		// let mirror node catch up
		await sleep(5000);

		// check trade is valid for Bob via mirror node, expect true

		let encodedCommand = lazySecureTradeIface.encodeFunctionData(
			'isTradeValid',
			[hashToCheck, bobId.toSolidityAddress()],
		);

		let tradeValid = await readOnlyEVMFromMirrorNode(
			env,
			lstContractId,
			encodedCommand,
			operatorId,
			false,
		);

		let tradeValidResult = lazySecureTradeIface.decodeFunctionResult(
			'isTradeValid',
			tradeValid,
		);

		expect(tradeValidResult[0]).to.be.true;

		// modify the trade using createTrade for same token and serial
		const modifyResult = await contractExecuteFunction(
			lstContractId,
			lazySecureTradeIface,
			client,
			500_000,
			'createTrade',
			[
				StkNFTA_TokenId.toSolidityAddress(),
				aliceId.toSolidityAddress(),
				4,
				Number(new Hbar(5, HbarUnit.Hbar).toTinybars()),
				10,
				0,
			],
		);

		expect(modifyResult[0].status.toString()).to.be.equal('SUCCESS');

		console.log('Trade modified:', modifyResult[2]?.transactionId?.toString());

		// let mirror node catch up
		await sleep(5000);

		// check trade is now invalid for Bob via mirror node, expect false

		encodedCommand = lazySecureTradeIface.encodeFunctionData(
			'isTradeValid',
			[hashToCheck, bobId.toSolidityAddress()],
		);

		tradeValid = await readOnlyEVMFromMirrorNode(
			env,
			lstContractId,
			encodedCommand,
			operatorId,
			false,
		);

		tradeValidResult = lazySecureTradeIface.decodeFunctionResult(
			'isTradeValid',
			tradeValid,
		);

		expect(tradeValidResult[0]).to.be.false;

		// check trade is valid for Alice via mirror node, expect true

		encodedCommand = lazySecureTradeIface.encodeFunctionData(
			'isTradeValid',
			[modifyResult[1][0], aliceId.toSolidityAddress()],
		);

		tradeValid = await readOnlyEVMFromMirrorNode(
			env,
			lstContractId,
			encodedCommand,
			operatorId,
			false,
		);

		tradeValidResult = lazySecureTradeIface.decodeFunctionResult(
			'isTradeValid',
			tradeValid,
		);

		expect(tradeValidResult[0]).to.be.true;
	});

	it('Operator creates a trade for Alice, sends NFT to Bob, Alice can not execute', async () => {
		client.setOperator(operatorId, operatorKey);

		// rely on NFT allowance being in place StkNFTA_TokenId

		// create a trade for Alice
		const tradeResult = await contractExecuteFunction(
			lstContractId,
			lazySecureTradeIface,
			client,
			500_000,
			'createTrade',
			[
				StkNFTA_TokenId.toSolidityAddress(),
				aliceId.toSolidityAddress(),
				3,
				Number(new Hbar(0.25, HbarUnit.Hbar).toTinybars()),
				0,
				0,
			],
		);

		expect(tradeResult[0].status.toString()).to.be.equal('SUCCESS');

		console.log('Trade created:', tradeResult[2]?.transactionId?.toString());

		const hashToCheck = tradeResult[1][0];

		// let mirror node catch up
		await sleep(5000);

		// check trade is valid for Alice via mirror node, expect true
		let encodedCommand = lazySecureTradeIface.encodeFunctionData(
			'isTradeValid',
			[hashToCheck, aliceId.toSolidityAddress()],
		);

		let tradeValid = await readOnlyEVMFromMirrorNode(
			env,
			lstContractId,
			encodedCommand,
			operatorId,
			false,
		);

		let tradeValidResult = lazySecureTradeIface.decodeFunctionResult(
			'isTradeValid',
			tradeValid,
		);

		expect(tradeValidResult[0]).to.be.true;

		// transfer the NFT to Bob

		const NFTTransferResult = await sendNFTDefeatRoyalty(
			client,
			operatorId,
			bobId,
			bobPK,
			StkNFTA_TokenId,
			[3],
		);

		expect(NFTTransferResult).to.be.equal('SUCCESS');

		// let mirror node catch up
		await sleep(5000);

		// check trade is valid for Alice via mirror node, expect false
		encodedCommand = lazySecureTradeIface.encodeFunctionData(
			'isTradeValid',
			[hashToCheck, aliceId.toSolidityAddress()],
		);

		tradeValid = await readOnlyEVMFromMirrorNode(
			env,
			lstContractId,
			encodedCommand,
			operatorId,
			false,
		);

		tradeValidResult = lazySecureTradeIface.decodeFunctionResult(
			'isTradeValid',
			tradeValid,
		);

		expect(tradeValidResult[0]).to.be.false;
	});
});

// v0.2 TESTING PHASE 1: PLATFORM FEE SYSTEM TESTS
describe('v0.2 Phase 1: Platform Fee System Tests', () => {
	// Increased for v0.2 fee collection logic
	const gasLim = 2_000_000;
	const queryGas = 300_000;

	before('Setup additional test accounts for v0.2 testing', async () => {
		if (process.env.CHARLIE_ACCOUNT_ID && process.env.CHARLIE_PRIVATE_KEY) {
			charlieId = AccountId.fromString(process.env.CHARLIE_ACCOUNT_ID);
			charliePK = PrivateKey.fromStringED25519(process.env.CHARLIE_PRIVATE_KEY);
			console.log('\n-Using existing Charlie:', charlieId.toString());
		}
		else {
			charliePK = PrivateKey.generateED25519();
			charlieId = await accountCreator(client, charliePK, 50);
			console.log(
				'Charlie account ID:',
				charlieId.toString(),
				charlieId.toSolidityAddress(),
				'\nkey:',
				charliePK.toString(),
			);
		}
		expect(charlieId.toString().match(addressRegex).length == 2).to.be.true;

		await associateTokensToAccount(client, charlieId, charliePK, [
			lazyTokenId,
			StkNFTA_TokenId,
			StkNFTB_TokenId,
			StkNFTC_TokenId,
		]);

		// shift to operator to fund Charlie with $LAZY
		client.setOperator(operatorId, operatorKey);

		await sendLazy(charlieId, 2000 * 10 ** LAZY_DECIMAL);

		// Send Charlie NFTs to trade (using serials 9 and 10 which Alice owns)
		client.setOperator(aliceId, alicePK);
		await sendNFT(
			client,
			aliceId,
			charlieId,
			StkNFTA_TokenId,
			[9, 10, 11, 12, 13],
		);

		// Set NFT allowances for Charlie
		client.setOperator(charlieId, charliePK);
		await setNFTAllowanceAll(
			client,
			[StkNFTA_TokenId],
			charlieId,
			AccountId.fromString(lstContractId.toString()),
		);

		console.log('✅ Charlie setup complete');
	});

	describe('1.1 Fee Configuration Tests', () => {
		it('Should have correct initial fee configuration', async () => {
			const platformInfo = await contractExecuteQuery(
				lstContractId,
				lazySecureTradeIface,
				client,
				queryGas,
				'getPlatformFeeInfo',
			);

			const [baseFee, gen2Discount, mutantDiscount, gen1Discount] = platformInfo;

			expect(baseFee.toString()).to.equal('100');
			expect(gen2Discount.toString()).to.equal('50');
			expect(mutantDiscount.toString()).to.equal('75');
			expect(gen1Discount.toString()).to.equal('100');

			console.log('✅ Initial fee configuration verified');
		});

		it('Should update fee rates (owner only)', async () => {
			client.setOperator(operatorId, operatorKey);

			const newBaseFee = 150;
			const newGen2Discount = 60;
			const newMutantDiscount = 80;
			const newGen1Discount = 100;

			const result = await contractExecuteFunction(
				lstContractId,
				lazySecureTradeIface,
				client,
				gasLim,
				'updateFeeRates',
				[newBaseFee, newGen2Discount, newMutantDiscount, newGen1Discount],
			);

			expect(result[0]?.status?.toString()).to.equal('SUCCESS');

			const platformInfo = await contractExecuteQuery(
				lstContractId,
				lazySecureTradeIface,
				client,
				queryGas,
				'getPlatformFeeInfo',
			);

			const [baseFee, gen2Discount, mutantDiscount, gen1Discount] = platformInfo;
			expect(baseFee.toString()).to.equal(newBaseFee.toString());
			expect(gen2Discount.toString()).to.equal(newGen2Discount.toString());
			expect(mutantDiscount.toString()).to.equal(newMutantDiscount.toString());
			expect(gen1Discount.toString()).to.equal(newGen1Discount.toString());

			// Wait for mirror node sync
			console.log('⏳ Waiting for mirror node sync...');
			await sleep(4500);

			// Check event emission
			const eventCheck = await checkLastMirrorEvent(
				env,
				lstContractId,
				lazySecureTradeIface,
				0,
				false,
			);

			console.log('Event check value:', eventCheck);
			// The eventCheck should match the new base fee
			expect(eventCheck == 150).to.be.true;

			console.log('✅ Fee rates updated successfully');

			await contractExecuteFunction(
				lstContractId,
				lazySecureTradeIface,
				client,
				gasLim,
				'updateFeeRates',
				[100, 50, 75, 100],
			);
		});

		it('Should reject invalid fee rates', async () => {
			client.setOperator(operatorId, operatorKey);

			// Test base fee too high (>500)
			const result1 = await contractExecuteFunction(
				lstContractId,
				lazySecureTradeIface,
				client,
				gasLim,
				'updateFeeRates',
				[600, 50, 75, 100],
			);

			if (result1[0]?.status?.name.toString() != 'InvalidFeeRate') {
				console.log('ERROR: Should have failed for high base fee', result1);
				fail();
			}

			// Test invalid discount hierarchy (gen1 > gen2)
			const result2 = await contractExecuteFunction(
				lstContractId,
				lazySecureTradeIface,
				client,
				gasLim,
				'updateFeeRates',
				[100, 50, 75, 30],
			);

			if (result2[0]?.status?.name.toString() != 'InvalidFeeRate') {
				console.log('ERROR: Should have failed for invalid hierarchy', result2);
				fail();
			}


			const errorRes = await contractExecuteFunction(
				lstContractId,
				lazySecureTradeIface,
				client,
				gasLim,
				'updateFeeRates',
				[100, 80, 70, 100],
			);
			if (errorRes[0]?.status?.name.toString() != 'InvalidFeeRate') {
				console.log('ERROR: Should have failed for invalid hierarchy', errorRes);
				fail();
			}

			console.log('✅ Invalid fee rate rejection working');
		});

		it('Should prevent non-owner from updating fees', async () => {
			client.setOperator(aliceId, alicePK);

			const result = await contractExecuteFunction(
				lstContractId,
				lazySecureTradeIface,
				client,
				gasLim,
				'updateFeeRates',
				[200, 50, 75, 100],
			);

			expect(result[0].status.toString()).to.include('Ownable: caller is not the owner');

			console.log('✅ Non-owner access prevention working');
		});
	});

	describe('1.2 Fee Calculation Tests', () => {
		it('Should calculate fees correctly for different LSH tiers', async () => {
			const charlieRate = await contractExecuteQuery(
				lstContractId,
				lazySecureTradeIface,
				client,
				queryGas,
				'calculateSellerFeeRate',
				[charlieId.toSolidityAddress()],
			);
			// Base fee was reset to 100 after previous test
			expect(charlieRate[0].toString()).to.equal('100');

			const charlieTier = await contractExecuteQuery(
				lstContractId,
				lazySecureTradeIface,
				client,
				queryGas,
				'getLSHTokenTier',
				[charlieId.toSolidityAddress()],
			);
			expect(charlieTier[0].toString()).to.equal('0');

			const operatorTier = await contractExecuteQuery(
				lstContractId,
				lazySecureTradeIface,
				client,
				queryGas,
				'getLSHTokenTier',
				[operatorId.toSolidityAddress()],
			);
			console.log('Operator LSH tier:', operatorTier[0].toString());

			const operatorRate = await contractExecuteQuery(
				lstContractId,
				lazySecureTradeIface,
				client,
				queryGas,
				'calculateSellerFeeRate',
				[operatorId.toSolidityAddress()],
			);
			console.log('Operator fee rate:', operatorRate[0].toString(), 'basis points');

			console.log('✅ Fee calculation tests completed');
		});

		it('Should handle edge cases in fee calculation', async () => {
			client.setOperator(operatorId, operatorKey);

			await contractExecuteFunction(
				lstContractId,
				lazySecureTradeIface,
				client,
				gasLim,
				'updateFeeRates',
				[0, 50, 75, 100],
			);

			const zeroBaseFeeRate = await contractExecuteQuery(
				lstContractId,
				lazySecureTradeIface,
				client,
				queryGas,
				'calculateSellerFeeRate',
				[charlieId.toSolidityAddress()],
			);
			expect(zeroBaseFeeRate[0].toString()).to.equal('0');

			await contractExecuteFunction(
				lstContractId,
				lazySecureTradeIface,
				client,
				gasLim,
				'updateFeeRates',
				[100, 50, 75, 100],
			);

			console.log('✅ Edge case fee calculations working');
		});
	});

	describe('1.3 Fee Collection & Tracking Tests', () => {
		it('Should collect fees on open market HBAR trades', async () => {
			client.setOperator(charlieId, charliePK);

			const charlieTier = await contractExecuteQuery(
				lstContractId,
				lazySecureTradeIface,
				client,
				queryGas,
				'getLSHTokenTier',
				[charlieId.toSolidityAddress()],
			);
			console.log('Charlie LSH tier:', charlieTier[0].toString());

			const lazyCostResult = await contractExecuteQuery(
				lstContractId,
				lazySecureTradeIface,
				client,
				queryGas,
				'lazyCostForTrade',
			);
			const lazyCost = Number(lazyCostResult[0]);
			console.log('LAZY cost for trade:', lazyCost.toString());

			await setFTAllowance(
				client,
				lazyTokenId,
				charlieId,
				lazyGasStationId,
				lazyCost,
			);

			await sleep(4500);

			// validate the allowance is set
			const allowances = await checkFTAllowances(env, charlieId);
			let allowanceValid = false;
			for (let a = 0; a < allowances.length; a++) {
				const allowance = allowances[a];
				if (allowance.spender === lazyGasStationId.toString()) {
					if (allowance.token_id === lazyTokenId.toString()) {
						if (Number(allowance.amount) >= lazyCost) {
							allowanceValid = true;
							break;
						}
					}
				}
			}

			if (!allowanceValid) {
				console.log('ERROR: $LAZY allowance for LGS not valid', allowances);
				fail();
			}

			const tradePrice = 1000;
			const result = await contractExecuteFunction(
				lstContractId,
				lazySecureTradeIface,
				client,
				gasLim,
				'createTrade',
				[
					StkNFTA_TokenId.toSolidityAddress(),
					ethers.ZeroAddress,
					9,
					tradePrice,
					0,
					0,
				],
			);

			if (result[0]?.status?.toString() != 'SUCCESS') {
				console.log('CreateTrade result (open market):', result);
				fail();
			}

			client.setOperator(aliceId, alicePK);

			const platformInfoBefore = await contractExecuteQuery(
				lstContractId,
				lazySecureTradeIface,
				client,
				queryGas,
				'getPlatformFeeInfo',
			);
			const feesBefore = platformInfoBefore[4];

			const expectedFee = Math.floor((tradePrice * 100) / 10000);

			// Alice must set tinybar allowance of 1 tinybar per item to
			// the Lazy Secure Trade contract to enable the unstake
			// setting 1 hbar to avoid running out of allowance
			// in case of multiple tests
			const hbarAllowanceStatus = await setHbarAllowance(
				client,
				aliceId,
				AccountId.fromString(lstContractId.toString()),
				1,
				HbarUnit.Hbar,
			);

			if (hbarAllowanceStatus != 'SUCCESS') {
				console.log('ERROR: HBAR allowance to Lazy Secure Trade failed', hbarAllowanceStatus);
				fail();
			}

			const tradeId = ethers.solidityPackedKeccak256(
				['address', 'uint256'],
				[StkNFTA_TokenId.toSolidityAddress(), 9],
			);

			console.log('Trade ID to execute:', tradeId);
			console.log('Trade ID from contract:', result[1][0]);

			const executeResult = await contractExecuteFunction(
				lstContractId,
				lazySecureTradeIface,
				client,
				gasLim,
				'executeTrade',
				[tradeId],
				new Hbar(tradePrice, HbarUnit.Tinybar),
			);

			if (executeResult[0]?.status?.toString() != 'SUCCESS') {
				console.log('ExecuteTrade result (open market):', executeResult);
				fail();
			}

			console.log('Alice Trade Execution tx:', executeResult[2]?.transactionId?.toString());

			const platformInfoAfter = await contractExecuteQuery(
				lstContractId,
				lazySecureTradeIface,
				client,
				queryGas,
				'getPlatformFeeInfo',
			);
			const feesAfter = platformInfoAfter[4];
			const feeCollected = feesAfter - feesBefore;

			expect(feeCollected.toString()).to.equal(expectedFee.toString());
			console.log('✅ Open market trade with fee collection verified');

			// Wait for mirror node sync
			console.log('⏳ Waiting for mirror node sync...');
			await sleep(4500);

			const eventCheck = await checkLastMirrorEvent(
				env,
				lstContractAddress,
				lazySecureTradeIface,
				3,
				false,
			);
			console.log('Event check:', eventCheck);
			expect(Number(eventCheck)).to.equal(9);

			console.log('✅ Fee collection on open market HBAR trade verified');
		});

		it('Should NOT collect fees on private trades', async () => {
			client.setOperator(charlieId, charliePK);

			const platformInfoBefore = await contractExecuteQuery(
				lstContractId,
				lazySecureTradeIface,
				client,
				queryGas,
				'getPlatformFeeInfo',
			);
			const feesBefore = platformInfoBefore[4];

			// Charlie must set tinybar allowance of 1 tinybar per item to
			// the Lazy Secure Trade contract to enable the unstake
			// setting 1 hbar to avoid running out of allowance
			// in case of multiple tests
			const hbarAllowanceStatus = await setHbarAllowance(
				client,
				charlieId,
				AccountId.fromString(lstContractId.toString()),
				1,
				HbarUnit.Hbar,
			);

			if (hbarAllowanceStatus != 'SUCCESS') {
				console.log('ERROR: HBAR allowance to Lazy Secure Trade failed', hbarAllowanceStatus);
				fail();
			}

			const tradePrice = 2000;
			const result = await contractExecuteFunction(
				lstContractId,
				lazySecureTradeIface,
				client,
				gasLim,
				'createTrade',
				[
					StkNFTA_TokenId.toSolidityAddress(),
					aliceId.toSolidityAddress(),
					10,
					tradePrice,
					0,
					0,
				],
			);

			if (result[0]?.status?.toString() != 'SUCCESS') {
				console.log('CreateTrade result (private):', result);
				fail();
			}

			client.setOperator(aliceId, alicePK);

			const tradeId = ethers.solidityPackedKeccak256(
				['address', 'uint256'],
				[StkNFTA_TokenId.toSolidityAddress(), 10],
			);

			const executeResult = await contractExecuteFunction(
				lstContractId,
				lazySecureTradeIface,
				client,
				gasLim,
				'executeTrade',
				[tradeId],
				new Hbar(tradePrice, HbarUnit.Tinybar),
			);

			if (executeResult[0]?.status?.toString() != 'SUCCESS') {
				console.log('ExecuteTrade result (private):', executeResult);
				fail();
			}

			const platformInfoAfter = await contractExecuteQuery(
				lstContractId,
				lazySecureTradeIface,
				client,
				queryGas,
				'getPlatformFeeInfo',
			);
			const feesAfter = platformInfoAfter[4];
			const feeCollected = feesAfter - feesBefore;

			expect(Number(feeCollected.toString())).to.equal(0);
			console.log('✅ No fee collection on private trades verified');
		});
	});

	describe('1.4 Fee Withdrawal Tests', () => {
		it('Should allow owner to withdraw platform fees', async () => {
			client.setOperator(operatorId, operatorKey);

			const platformInfoBefore = await contractExecuteQuery(
				lstContractId,
				lazySecureTradeIface,
				client,
				queryGas,
				'getPlatformFeeInfo',
			);
			const collectedFees = platformInfoBefore[4];

			const result = await contractExecuteFunction(
				lstContractId,
				lazySecureTradeIface,
				client,
				gasLim,
				'withdrawPlatformFees',
				[operatorId.toSolidityAddress()],
			);

			expect(result[0]?.status?.toString()).to.equal('SUCCESS');

			// Note: Fees remain tracked as lifetime accrual - not reset to zero
			console.log(`✅ Platform fee withdrawal successful (${collectedFees} tinybar tracked fees)`);
		});

		it('Should prevent non-owner from withdrawing fees', async () => {
			client.setOperator(aliceId, alicePK);

			const result = await contractExecuteFunction(
				lstContractId,
				lazySecureTradeIface,
				client,
				gasLim,
				'withdrawPlatformFees',
				[aliceId.toSolidityAddress()],
			);

			expect(result[0].status.toString()).to.include('Ownable: caller is not the owner');
			console.log('✅ Non-owner withdrawal prevention working');
		});
	});

	after('Phase 1 cleanup', async () => {
		client.setOperator(operatorId, operatorKey);
		console.log('🏁 Phase 1: Platform Fee System Tests Complete');
	});
});

describe('v0.2 Phase 2: Batch Operations & Multi-Token Tests', () => {
	const gasLim = 2_000_000;

	before('Phase 2 setup', async () => {
		client.setOperator(operatorId, operatorKey);
		console.log('🚀 Starting Phase 2: Batch Operations & Multi-Token Tests');

		// check if token associations are in place for Charlie
		// Ensure Charlie is associated with LAZY token
		if ((await checkMirrorBalance(env, charlieId, StkNFTB_TokenId)) == null) {
			const associateResultA = await associateTokensToAccount(
				client,
				charlieId,
				charliePK,
				[StkNFTA_TokenId],
			);
			expect(associateResultA).to.equal('SUCCESS');
		}

		if ((await checkMirrorBalance(env, charlieId, StkNFTB_TokenId)) == null) {
			const associateResultB = await associateTokensToAccount(
				client,
				charlieId,
				charliePK,
				[StkNFTB_TokenId],
			);
			expect(associateResultB).to.equal('SUCCESS');
		}

		// Transfer some StakeTokenB NFTs from Alice to Charlie for testing
		// Using serials 6, 7, 8 which Alice retains (safe from earlier test usage)
		client.setOperator(aliceId, alicePK);
		const sendNFTB_Result = await sendNFT(
			client,
			aliceId,
			charlieId,
			StkNFTB_TokenId,
			[6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
		);
		expect(sendNFTB_Result).to.be.equal('SUCCESS');

		// Transfer some StakeTokenC NFTs from Alice to Charlie for testing
		// Using serials 6, 7, 8 which Alice retains (safe from earlier test usage)
		const sendNFTC_Result = await sendNFT(
			client,
			aliceId,
			charlieId,
			StkNFTC_TokenId,
			[6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
		);
		expect(sendNFTC_Result).to.be.equal('SUCCESS');

		console.log('✅ Phase 2 setup complete - Charlie has StakeTokenB and StakeTokenC NFTs (serials 6-8)');
	});

	describe('2.1 Batch Trade Creation Tests', () => {
		it('Should create and execute atomic batch trades', async () => {
			client.setOperator(charlieId, charliePK);

			// Set up LAZY allowance for batch trade creation
			const lazyCost = await contractExecuteQuery(
				lstContractId,
				lazySecureTradeIface,
				client,
				300_000,
				'lazyCostForTrade',
			);

			await setFTAllowance(
				client,
				lazyTokenId,
				charlieId,
				lazyGasStationId,
				Number(lazyCost[0]) * 3,
			);

			// need to setup NFT allowances for batch trade tokens
			await setNFTAllowanceAll(
				client,
				[StkNFTB_TokenId, StkNFTC_TokenId],
				charlieId,
				AccountId.fromString(lstContractId.toString()),
			);

			await sleep(4500);

			// Create atomic batch trade using createBatchTrade with mixed payment types
			// This creates a single batch that must be executed all-or-none
			const tokens = [StkNFTB_TokenId.toSolidityAddress(), StkNFTC_TokenId.toSolidityAddress()];
			// StkNFTB serials, StkNFTC serials
			const serials = [
				[6, 7],
				[6],
			];
			// Mixed pricing: Serial 6 HBAR only, Serial 7 LAZY only, StkNFTC HBAR + LAZY
			const tinybarPrices = [
				[5 * 10 ** 8, 0],
				[7.5 * 10 ** 8],
			];
			// Mixed LAZY pricing to test different payment combinations
			const lazyPrices = [
				[0, 1000],
				[500],
			];

			const batchResult = await contractExecuteFunction(
				lstContractId,
				lazySecureTradeIface,
				client,
				5_000_000,
				'createBatchTrade',
				[
					tokens,
					serials,
					tinybarPrices,
					lazyPrices,
					ethers.ZeroAddress,
					0,
				],
			);

			if (batchResult[0]?.status?.toString() !== 'SUCCESS') {
				console.log('createBatchTrade failed:', batchResult);
				fail();
			}

			console.log('Batch trade created, tx:', batchResult[2]?.transactionId?.toString());

			// Extract batch ID from result
			const batchId = batchResult[1][0];
			console.log('Created atomic batch trade with ID:', batchId);

			// Wait for mirror node sync
			await sleep(4500);

			// pull the user's batch trade data via mirror node to verify
			// DEV NOTE: call this for the ZeroAddress to get open batches for any user
			const userBatches = await readOnlyEVMFromMirrorNode(
				env,
				lstContractId,
				lazySecureTradeIface.encodeFunctionData('getUserBatchTrades', [charlieId.toSolidityAddress()]),
				operatorId,
				false,
			);

			const userBatchesResult = lazySecureTradeIface.decodeFunctionResult(
				'getUserBatchTrades',
				userBatches,
			);

			console.log('User batch trades:', userBatchesResult[0]);
			expect(userBatchesResult[0].toString()).to.be.equal(batchId);

			// Verify batch contents via getBatchTrade()
			// use the mirror node to query getBatchTrade() and verify contents
			const encodedCommand = lazySecureTradeIface.encodeFunctionData(
				'getBatchTrade',
				[batchId],
			);

			const batchData = await readOnlyEVMFromMirrorNode(
				env,
				lstContractId,
				encodedCommand,
				operatorId,
				false,
			);

			const batchDataResult = lazySecureTradeIface.decodeFunctionResult(
				'getBatchTrade',
				batchData,
			);

			console.log('Batch trade data:', batchDataResult);

			const batchCostInTinybars = Number(batchDataResult[0][3]);
			const batchCostInLazy = Number(batchDataResult[0][4]);

			console.log('Items in batch:', batchDataResult[0][2]);
			console.log('Total HBAR price (tinybars):', new Hbar(batchCostInTinybars, HbarUnit.Tinybar).toString());
			console.log('Total LAZY price:', batchCostInLazy / 10 ** LAZY_DECIMAL, '$LAZY');

			// expect 3 TokenSerialPrice structs in the batch
			// check the totalTinybarPrice and totalLazyPrice
			expect(batchDataResult[0][2].length).to.be.equal(3);
			expect(batchCostInTinybars).to.be.equal(1250000001);
			expect(batchCostInLazy).to.be.equal(1500);

			// Now Alice executes the atomic batch trade
			client.setOperator(aliceId, alicePK);

			// Alice needs LAZY allowance to LazyGasStation for purchase costs
			await setFTAllowance(
				client,
				lazyTokenId,
				aliceId,
				lazyGasStationId,
				batchCostInLazy,
			);

			// Alice needs HBAR allowances for buying the batch (royalty payments)
			const hbarAllowanceStatus = await setHbarAllowance(
				client,
				aliceId,
				AccountId.fromString(lstContractId.toString()),
				1,
				HbarUnit.Hbar,
			);
			expect(hbarAllowanceStatus).to.equal('SUCCESS');

			// Execute the atomic batch trade
			const executeResult = await contractExecuteFunction(
				lstContractId,
				lazySecureTradeIface,
				client,
				gasLim,
				'executeBatchTrade',
				[batchId],
				new Hbar(batchCostInTinybars, HbarUnit.Tinybar),
			);

			if (executeResult[0]?.status?.toString() !== 'SUCCESS') {
				console.log('executeBatchTrade failed:', executeResult);
				fail();
			}

			console.log('Alice executed batch trade with tx:', executeResult[2]?.transactionId?.toString());

			// Wait for mirror node sync
			await sleep(4500);

			// Verify batch execution event
			const eventCheck = await checkLastMirrorEvent(
				env,
				lstContractAddress,
				lazySecureTradeIface,
				1,
				true,
			);

			// eventCheck should be Alice's account ID
			expect(eventCheck.toString()).to.be.equal(aliceId.toString());
			console.log('✅ Atomic batch trade created and executed successfully');
		});

		it('Should create multiple individual trades simultaneously', async () => {
			client.setOperator(charlieId, charliePK);

			// Set up LAZY allowance for multiple individual trades
			const lazyCost = await contractExecuteQuery(
				lstContractId,
				lazySecureTradeIface,
				client,
				300_000,
				'lazyCostForTrade',
			);

			await setFTAllowance(
				client,
				lazyTokenId,
				charlieId,
				lazyGasStationId,
				Number(lazyCost[0]) * 3,
			);

			await sleep(4500);

			// Organize trades by unique tokens for multiple individual trade creation
			const uniqueTokens = [StkNFTB_TokenId.toSolidityAddress(), StkNFTC_TokenId.toSolidityAddress()];
			// Different serials from batch trade, with mixed payment types
			const serialsPerToken = [
				[8, 9],
				[7],
			];
			// Mixed pricing: some HBAR, some HBAR+LAZY
			const tinybarPricesPerToken = [
				[8 * 10 ** 8, 0],
				[11 * 10 ** 8],
			];
			// Mixed LAZY pricing for individual trades
			const lazyPricesPerToken = [
				[0, 800],
				[400],
			];

			// Create multiple individual trades using createMultipleTrades
			const result = await contractExecuteFunction(
				lstContractId,
				lazySecureTradeIface,
				client,
				5_000_000,
				'createMultipleTrades',
				[
					uniqueTokens,
					serialsPerToken,
					ethers.ZeroAddress,
					tinybarPricesPerToken,
					lazyPricesPerToken,
					0,
				],
			);

			if (result[0]?.status?.toString() !== 'SUCCESS') {
				console.log('createMultipleTrades failed:', result);
				fail();
			}

			console.log('Created multiple individual trades with tx:', result[2]?.transactionId?.toString());

			// Wait for mirror node sync
			await sleep(4500);

			// Verify trades were created with fee collection
			const eventCheck = await checkLastMirrorEvent(
				env,
				lstContractAddress,
				lazySecureTradeIface,
				3,
				false,
			);

			console.log('Event check result:', eventCheck);
			console.log('✅ Individual trades created successfully with createMultipleTrades method');

			// Now test executing one of the individual trades with LAZY payment
			client.setOperator(aliceId, alicePK);

			// Alice needs HBAR allowances for buying NFTs (royalty payments)
			const hbarAllowanceStatus = await setHbarAllowance(
				client,
				aliceId,
				AccountId.fromString(lstContractId.toString()),
				1,
				HbarUnit.Hbar,
			);
			expect(hbarAllowanceStatus).to.equal('SUCCESS');

			// Generate trade ID for StkNFTB serial 8 (LAZY only trade)
			const tradeId = ethers.solidityPackedKeccak256(
				['address', 'uint256'],
				[StkNFTB_TokenId.toSolidityAddress(), 9],
			);

			// get the trade details & price from the contract for verification via mirror node
			const encodedCommand = lazySecureTradeIface.encodeFunctionData(
				'getTrade',
				[tradeId],
			);

			const tradeData = await readOnlyEVMFromMirrorNode(
				env,
				lstContractId,
				encodedCommand,
				operatorId,
				false,
			);

			const tradeDataResult = lazySecureTradeIface.decodeFunctionResult(
				'getTrade',
				tradeData,
			);
			console.log('Trade data for individual trade execution:', tradeDataResult);
			const tradeCostInTinybars = Number(tradeDataResult[0][4]);
			const tradeCostInLazy = Number(tradeDataResult[0][5]);

			// Alice needs LAZY allowance for purchasing individual trade with LAZY cost
			await setFTAllowance(
				client,
				lazyTokenId,
				aliceId,
				lazyGasStationId,
				tradeCostInLazy,
			);

			// Execute the individual trade with LAZY payment
			const executeResult = await contractExecuteFunction(
				lstContractId,
				lazySecureTradeIface,
				client,
				gasLim,
				'executeTrade',
				[tradeId],
				new Hbar(tradeCostInTinybars, HbarUnit.Tinybar),
			);

			if (executeResult[0]?.status?.toString() !== 'SUCCESS') {
				console.log('Individual trade execution failed:', executeResult);
				fail();
			}

			console.log('Alice executed individual trade with tx:', executeResult[2]?.transactionId?.toString());

			await sleep(4500);
			console.log('✅ Individual trade with LAZY payment executed successfully');
		});

		it('Should execute multiple individual trades with executeTrades batch method', async () => {
			client.setOperator(aliceId, alicePK);

			// Alice needs LAZY allowance for purchasing trades with mixed LAZY costs
			await setFTAllowance(
				client,
				lazyTokenId,
				aliceId,
				lazyGasStationId,
				1000,
			);

			// Alice needs HBAR allowances for buying multiple NFTs (royalty payments)
			const hbarAllowanceStatus = await setHbarAllowance(
				client,
				aliceId,
				AccountId.fromString(lstContractId.toString()),
				3,
				HbarUnit.Hbar,
			);
			expect(hbarAllowanceStatus).to.equal('SUCCESS');

			// Execute multiple individual trades using executeTrades (not from atomic batch)
			const tokenTypes = [
				{ tokenId: StkNFTB_TokenId, serial: 8 },
				{ tokenId: StkNFTC_TokenId, serial: 7 },
			];

			// Generate trade IDs for individual trades execution
			const tradeIds = tokenTypes.map(tokenType =>
				ethers.solidityPackedKeccak256(
					['address', 'uint256'],
					[tokenType.tokenId.toSolidityAddress(), tokenType.serial],
				),
			);

			await sleep(4500);

			let tradesCostInTinybars = 0;
			let tradesCostInLazy = 0;
			// get the trade details & prices from the contract for verification via mirror node
			for (let i = 0; i < tradeIds.length; i++) {
				const encodedCommand = lazySecureTradeIface.encodeFunctionData(
					'getTrade',
					[tradeIds[i]],
				);

				const tradeData = await readOnlyEVMFromMirrorNode(
					env,
					lstContractId,
					encodedCommand,
					operatorId,
					false,
				);
				const tradeDataResult = lazySecureTradeIface.decodeFunctionResult(
					'getTrade',
					tradeData,
				);
				console.log(`Trade data for ID ${tradeIds[i]}:`, tradeDataResult);
				tradesCostInTinybars += Number(tradeDataResult[0][4]);
				tradesCostInLazy += Number(tradeDataResult[0][5]);
			}

			console.log('Total cost for multiple trades - HBAR: ', new Hbar(tradesCostInTinybars, HbarUnit.Tinybar).toString());
			console.log('Total cost for multiple trades - LAZY:', tradesCostInLazy / 10 ** LAZY_DECIMAL);

			// Alice needs LAZY allowance for purchasing individual trade with LAZY cost
			await setFTAllowance(
				client,
				lazyTokenId,
				aliceId,
				lazyGasStationId,
				tradesCostInLazy,
			);

			// Execute multiple individual trades using executeTrades batch method
			const result = await contractExecuteFunction(
				lstContractId,
				lazySecureTradeIface,
				client,
				gasLim,
				'executeTrades',
				[tradeIds],
				new Hbar(tradesCostInTinybars, HbarUnit.Tinybar),
			);

			if (result[0]?.status?.toString() !== 'SUCCESS') {
				console.log('executeTrades failed for multiple individual trades:', result);
				fail();
			}

			console.log('Alice executed multiple individual trades with tx:', result[2]?.transactionId?.toString());

			// Wait for mirror node sync
			await sleep(4500);

			// Verify multi-token fee collection
			const eventCheck = await checkLastMirrorEvent(
				env,
				lstContractAddress,
				lazySecureTradeIface,
				2,
				false,
			);

			console.log('Multiple individual trades event check:', eventCheck);
			console.log('✅ Multiple individual trades executed successfully using executeTrades batch method');
		});
	});

	describe('2.2 Platform Volume stats', () => {
		it('Should provide accurate platform fee summary', async () => {
			const platformInfo = await contractExecuteQuery(
				lstContractId,
				lazySecureTradeIface,
				client,
				300000,
				'getPlatformFeeInfo',
			);

			const [
				hbarFeeRate,
				gen2Discount,
				mutantDiscount,
				gen1Discount,
				totalFeesCollected,
				lifetimeHbarVolume,
				lifetimeLazyVolume,
			] = platformInfo;

			console.log('Final platform fee summary:');
			console.log(`- HBAR fee rate: ${hbarFeeRate} basis points`);
			console.log(`- LSH Gen2 discount: ${gen2Discount}%`);
			console.log(`- LSH Mutant discount: ${mutantDiscount}%`);
			console.log(`- LSH Gen1 discount: ${gen1Discount}%`);
			console.log(`- Total HBAR fees collected: ${totalFeesCollected} tinybars`);
			console.log(`- Lifetime HBAR volume: ${lifetimeHbarVolume} tinybars`);
			console.log(`- Lifetime LAZY volume: ${lifetimeLazyVolume} tokens`);

			// Verify the system has processed trades
			expect(Number(lifetimeHbarVolume.toString())).to.be.greaterThan(0);

			console.log('✅ Platform fee system validation completed');
		});
	});

	after('Phase 2 cleanup', async () => {
		client.setOperator(operatorId, operatorKey);
		console.log('🏁 Phase 2: Batch Operations & Multi-Token Tests Complete');
	});
});

describe('v0.2 Phase 3: Trade Management & Query Operations', () => {
	const gasLim = 2_000_000;
	let charlieNFTB = [];
	let charlieNFTC = [];

	before('Phase 3 setup', async () => {
		client.setOperator(operatorId, operatorKey);
		console.log('🚀 Phase 3: Trade Management & Query Operations');

		// Ensure Charlie has NFTs for cancellation tests (should already have from Phase 2)
		client.setOperator(charlieId, charliePK);

		// Verify Charlie's remaining NFT ownership and store for dynamic use
		charlieNFTB = await getSerialsOwned(env, charlieId, StkNFTB_TokenId);
		charlieNFTC = await getSerialsOwned(env, charlieId, StkNFTC_TokenId);

		console.log('Charlie\'s available NFTs for Phase 3:');
		console.log('- StkNFTB serials:', charlieNFTB);
		console.log('- StkNFTC serials:', charlieNFTC);

		// Ensure we have enough NFTs for testing
		if (charlieNFTB.length < 5) {
			throw new Error(`Charlie needs at least 5 StkNFTB serials for Phase 3 tests. Found: ${charlieNFTB.length}`);
		}
		if (charlieNFTC.length < 3) {
			throw new Error(`Charlie needs at least 3 StkNFTC serials for Phase 3 tests. Found: ${charlieNFTC.length}`);
		}

		// Ensure Charlie has proper allowances for creating trades to cancel
		await setNFTAllowanceAll(
			client,
			[StkNFTB_TokenId, StkNFTC_TokenId],
			charlieId,
			AccountId.fromString(lstContractId.toString()),
		);

		console.log('✅ Phase 3 setup complete - Ready for trade management tests');
	});

	describe('3.1 Trade Cancellation Tests', () => {
		it('Should cancel individual trade', async () => {
			client.setOperator(charlieId, charliePK);

			// Use first available StkNFTB serial dynamically
			const testSerial = charlieNFTB[0];
			console.log(`Creating trade with StkNFTB serial ${testSerial}`);

			// Set up LAZY allowance for trade creation
			const lazyCost = await contractExecuteQuery(
				lstContractId,
				lazySecureTradeIface,
				client,
				300_000,
				'lazyCostForTrade',
			);

			await setFTAllowance(
				client,
				lazyTokenId,
				charlieId,
				lazyGasStationId,
				Number(lazyCost[0]) * 2,
			);

			await sleep(4500);

			// Create a single trade to cancel using Charlie's actual NFT
			const createResult = await contractExecuteFunction(
				lstContractId,
				lazySecureTradeIface,
				client,
				gasLim,
				'createTrade',
				[
					StkNFTB_TokenId.toSolidityAddress(),
					ethers.ZeroAddress,
					testSerial,
					15 * 10 ** 8,
					0,
					0,
				],
			);

			if (createResult[0]?.status?.toString() !== 'SUCCESS') {
				console.log('createTrade failed:', createResult);
				fail();
			}

			console.log('✅ Trade created successfully. Transaction ID:', createResult[2]?.transactionId?.toString());

			// Wait for mirror node sync
			await sleep(4500);

			// Generate trade ID for cancellation using the actual serial
			const tradeId = ethers.solidityPackedKeccak256(
				['address', 'uint256'],
				[StkNFTB_TokenId.toSolidityAddress(), testSerial],
			);

			// Cancel the trade
			const cancelResult = await contractExecuteFunction(
				lstContractId,
				lazySecureTradeIface,
				client,
				gasLim,
				'cancelTrade',
				[tradeId],
			);

			if (cancelResult[0]?.status?.toString() !== 'SUCCESS') {
				console.log('cancelTrade failed:', cancelResult);
				fail();
			}

			console.log('✅ Trade cancelled successfully. Transaction ID:', cancelResult[2]?.transactionId?.toString());

			// Wait for mirror node sync
			await sleep(4500);

			// Verify trade is cancelled via mirror node query
			const encodedCommand = lazySecureTradeIface.encodeFunctionData(
				'getTrade',
				[tradeId],
			);

			const tradeData = await readOnlyEVMFromMirrorNode(
				env,
				lstContractId,
				encodedCommand,
				operatorId,
				false,
			);

			const tradeDataResult = lazySecureTradeIface.decodeFunctionResult(
				'getTrade',
				tradeData,
			);

			console.log('Trade status after cancellation:', tradeDataResult);
			// Trade should not exist or be marked as cancelled
			expect(tradeDataResult[0][0]).to.be.equal(ethers.ZeroAddress);

			console.log('✅ Individual trade cancellation verified');
		});

		it('Should create 4 trades and cancel 2 with cancelTrades', async () => {
			client.setOperator(charlieId, charliePK);

			// Use available NFT serials dynamically
			const testSerialsB = [charlieNFTB[1], charlieNFTB[2]];
			const testSerialsC = [charlieNFTC[0], charlieNFTC[1]];

			console.log(`Creating 4 trades with StkNFTB serials [${testSerialsB}] and StkNFTC serials [${testSerialsC}]`);

			// Set up LAZY allowance for multiple trade creation
			const lazyCost = await contractExecuteQuery(
				lstContractId,
				lazySecureTradeIface,
				client,
				300_000,
				'lazyCostForTrade',
			);

			await setFTAllowance(
				client,
				lazyTokenId,
				charlieId,
				lazyGasStationId,
				Number(lazyCost[0]) * 5,
			);

			await sleep(4500);

			// Create 4 individual trades using createMultipleTrades for efficiency
			const uniqueTokens = [StkNFTB_TokenId.toSolidityAddress(), StkNFTC_TokenId.toSolidityAddress()];
			const serialsPerToken = [
				testSerialsB,
				testSerialsC,
			];
			const tinybarPricesPerToken = [
				[16 * 10 ** 8, 17 * 10 ** 8],
				[18 * 10 ** 8, 19 * 10 ** 8],
			];
			const lazyPricesPerToken = [
				[0, 0],
				[0, 0],
			];

			// Create multiple trades
			const createResult = await contractExecuteFunction(
				lstContractId,
				lazySecureTradeIface,
				client,
				5_000_000,
				'createMultipleTrades',
				[
					uniqueTokens,
					serialsPerToken,
					ethers.ZeroAddress,
					tinybarPricesPerToken,
					lazyPricesPerToken,
					0,
				],
			);

			if (createResult[0]?.status?.toString() !== 'SUCCESS') {
				console.log('createMultipleTrades failed:', createResult);
				fail();
			}

			console.log('✅ 4 trades created successfully. Transaction ID:', createResult[2]?.transactionId?.toString());

			// Wait for mirror node sync
			await sleep(4500);

			// Generate trade IDs for the trades we want to cancel (first StkNFTB and first StkNFTC)
			const tradesToCancel = [
				ethers.solidityPackedKeccak256(
					['address', 'uint256'],
					[StkNFTB_TokenId.toSolidityAddress(), testSerialsB[0]],
				),
				ethers.solidityPackedKeccak256(
					['address', 'uint256'],
					[StkNFTC_TokenId.toSolidityAddress(), testSerialsC[0]],
				),
			];

			console.log(`Cancelling trades for StkNFTB serial ${testSerialsB[0]} and StkNFTC serial ${testSerialsC[0]}`);

			// Cancel 2 out of 4 trades using cancelTrades
			const cancelResult = await contractExecuteFunction(
				lstContractId,
				lazySecureTradeIface,
				client,
				gasLim,
				'cancelTrades',
				[tradesToCancel],
			);

			if (cancelResult[0]?.status?.toString() !== 'SUCCESS') {
				console.log('cancelTrades failed:', cancelResult);
				fail();
			}

			console.log('✅ 2 trades cancelled successfully. Transaction ID:', cancelResult[2]?.transactionId?.toString());

			// Wait for mirror node sync
			await sleep(4500);

			// Verify cancelled trades via mirror node
			for (const tradeId of tradesToCancel) {
				const encodedCommand = lazySecureTradeIface.encodeFunctionData(
					'getTrade',
					[tradeId],
				);

				const tradeData = await readOnlyEVMFromMirrorNode(
					env,
					lstContractId,
					encodedCommand,
					operatorId,
					false,
				);

				const tradeDataResult = lazySecureTradeIface.decodeFunctionResult(
					'getTrade',
					tradeData,
				);

				console.log('Cancelled trade status:', tradeDataResult);
				expect(tradeDataResult[0][0]).to.be.equal(ethers.ZeroAddress);
			}

			// Verify remaining trades are still active (second StkNFTB and second StkNFTC)
			const remainingTrades = [
				ethers.solidityPackedKeccak256(
					['address', 'uint256'],
					[StkNFTB_TokenId.toSolidityAddress(), testSerialsB[1]],
				),
				ethers.solidityPackedKeccak256(
					['address', 'uint256'],
					[StkNFTC_TokenId.toSolidityAddress(), testSerialsC[1]],
				),
			];

			console.log(`Verifying remaining active trades for StkNFTB serial ${testSerialsB[1]} and StkNFTC serial ${testSerialsC[1]}`);

			for (const tradeId of remainingTrades) {
				const encodedCommand = lazySecureTradeIface.encodeFunctionData(
					'getTrade',
					[tradeId],
				);

				const tradeData = await readOnlyEVMFromMirrorNode(
					env,
					lstContractId,
					encodedCommand,
					operatorId,
					false,
				);

				const tradeDataResult = lazySecureTradeIface.decodeFunctionResult(
					'getTrade',
					tradeData,
				);

				console.log('Remaining active trade:', tradeDataResult);
				expect(tradeDataResult[0][0].slice(2).toLowerCase()).to.be.equal(charlieId.toSolidityAddress());
			}

			console.log('✅ Selective trade cancellation verified - 2 cancelled, 2 remaining active');
		});

		it('Should cancel atomic batch trade', async () => {
			client.setOperator(charlieId, charliePK);

			// Use available NFT serials dynamically for batch trade
			const batchSerialB = charlieNFTB[3];
			const batchSerialC = charlieNFTC[2];

			console.log(`Creating batch trade with StkNFTB serial ${batchSerialB} and StkNFTC serial ${batchSerialC}`);

			// Set up LAZY allowance for batch trade creation
			const lazyCost = await contractExecuteQuery(
				lstContractId,
				lazySecureTradeIface,
				client,
				300_000,
				'lazyCostForTrade',
			);

			await setFTAllowance(
				client,
				lazyTokenId,
				charlieId,
				lazyGasStationId,
				Number(lazyCost[0]) * 3,
			);

			await sleep(4500);

			// Create atomic batch trade for cancellation testing
			const tokens = [StkNFTB_TokenId.toSolidityAddress(), StkNFTC_TokenId.toSolidityAddress()];
			const serials = [
				[batchSerialB],
				[batchSerialC],
			];
			const tinybarPrices = [
				[20 * 10 ** 8],
				[21 * 10 ** 8],
			];
			const lazyPrices = [
				[0],
				[0],
			];

			const batchResult = await contractExecuteFunction(
				lstContractId,
				lazySecureTradeIface,
				client,
				5_000_000,
				'createBatchTrade',
				[
					tokens,
					serials,
					tinybarPrices,
					lazyPrices,
					ethers.ZeroAddress,
					0,
				],
			);

			if (batchResult[0]?.status?.toString() !== 'SUCCESS') {
				console.log('createBatchTrade failed:', batchResult);
				fail();
			}

			const batchId = batchResult[1][0];
			console.log('✅ Batch trade created successfully. Transaction ID:', batchResult[2]?.transactionId?.toString());
			console.log('Batch ID:', batchId);

			// Wait for mirror node sync
			await sleep(4500);

			// Cancel the batch trade
			const cancelResult = await contractExecuteFunction(
				lstContractId,
				lazySecureTradeIface,
				client,
				gasLim,
				'cancelBatchTrade',
				[batchId],
			);

			if (cancelResult[0]?.status?.toString() !== 'SUCCESS') {
				console.log('cancelBatchTrade failed:', cancelResult);
				fail();
			}

			console.log('✅ Batch trade cancelled successfully. Transaction ID:', cancelResult[2]?.transactionId?.toString());

			// Wait for mirror node sync
			await sleep(4500);

			// Verify batch is cancelled via mirror node
			const encodedCommand = lazySecureTradeIface.encodeFunctionData(
				'getBatchTrade',
				[batchId],
			);

			const batchData = await readOnlyEVMFromMirrorNode(
				env,
				lstContractId,
				encodedCommand,
				operatorId,
				false,
			);

			const batchDataResult = lazySecureTradeIface.decodeFunctionResult(
				'getBatchTrade',
				batchData,
			);

			console.log('Batch status after cancellation:', batchDataResult);
			// Batch should not exist or be marked as cancelled
			expect(batchDataResult[0][0]).to.be.equal(ethers.ZeroAddress);

			console.log('✅ Atomic batch trade cancellation verified');
		});
	});

	describe('3.2 Trade Query & Discovery Tests', () => {
		it('Should query user trades and validate active trades', async () => {
			// Use mirror node to get Charlie's active trades
			const encodedCommand = lazySecureTradeIface.encodeFunctionData(
				'getUserTrades',
				[charlieId.toSolidityAddress()],
			);

			const userTradesData = await readOnlyEVMFromMirrorNode(
				env,
				lstContractId,
				encodedCommand,
				operatorId,
				false,
			);

			const userTradesResult = lazySecureTradeIface.decodeFunctionResult(
				'getUserTrades',
				userTradesData,
			);

			console.log('Charlie\'s active trades:', userTradesResult[0]);
			console.log('Number of active trades:', userTradesResult[0].length);

			// Should have remaining active trades from previous test (2 remaining from the 4 created)
			expect(userTradesResult[0].length).to.be.greaterThan(0);

			console.log('✅ User trade query validated');
		});

		it('Should query token-specific trades', async () => {
			// Query trades for StkNFTB token
			const encodedCommand = lazySecureTradeIface.encodeFunctionData(
				'getTokenTrades',
				[StkNFTB_TokenId.toSolidityAddress()],
			);

			const tokenTradesData = await readOnlyEVMFromMirrorNode(
				env,
				lstContractId,
				encodedCommand,
				operatorId,
				false,
			);

			const tokenTradesResult = lazySecureTradeIface.decodeFunctionResult(
				'getTokenTrades',
				tokenTradesData,
			);

			console.log('StkNFTB token trades:', tokenTradesResult[0]);
			console.log('Number of StkNFTB trades:', tokenTradesResult[0].length);

			// Should have some trades for this token
			expect(tokenTradesResult[0].length).to.be.greaterThan(0);

			console.log('✅ Token-specific trade query validated');
		});

		it('Should validate trade state with isTradeValid', async () => {
			// Get one of Charlie's remaining active trades - use the second StkNFTB trade that should still be active
			// This was testSerialsB[1] in the cancellation test
			const activeSerial = charlieNFTB[2];
			const remainingTradeId = ethers.solidityPackedKeccak256(
				['address', 'uint256'],
				[StkNFTB_TokenId.toSolidityAddress(), activeSerial],
			);

			console.log(`Checking validity of active trade for StkNFTB serial ${activeSerial}`);

			// Check if the trade is valid using mirror node
			const encodedCommand = lazySecureTradeIface.encodeFunctionData(
				'isTradeValid',
				[remainingTradeId, ethers.ZeroAddress],
			);

			const isValidData = await readOnlyEVMFromMirrorNode(
				env,
				lstContractId,
				encodedCommand,
				operatorId,
				false,
			);

			const isValidResult = lazySecureTradeIface.decodeFunctionResult(
				'isTradeValid',
				isValidData,
			);

			console.log('Trade validity check:', isValidResult[0]);
			expect(isValidResult[0]).to.be.true;

			// Check a cancelled trade should be invalid - use the first StkNFTB trade that was cancelled
			// This was testSerialsB[0] in the cancellation test
			const cancelledSerial = charlieNFTB[1];
			const cancelledTradeId = ethers.solidityPackedKeccak256(
				['address', 'uint256'],
				[StkNFTB_TokenId.toSolidityAddress(), cancelledSerial],
			);

			console.log(`Checking validity of cancelled trade for StkNFTB serial ${cancelledSerial}`);

			const encodedCommandCancelled = lazySecureTradeIface.encodeFunctionData(
				'isTradeValid',
				[cancelledTradeId, ethers.ZeroAddress],
			);

			const isValidCancelledData = await readOnlyEVMFromMirrorNode(
				env,
				lstContractId,
				encodedCommandCancelled,
				operatorId,
				false,
			);

			const isValidCancelledResult = lazySecureTradeIface.decodeFunctionResult(
				'isTradeValid',
				isValidCancelledData,
			);

			console.log('Cancelled trade validity check:', isValidCancelledResult[0]);
			expect(isValidCancelledResult[0]).to.be.false;

			console.log('✅ Trade validation checks completed');
		});
	});

	after('Phase 3 cleanup', async () => {
		client.setOperator(operatorId, operatorKey);
		console.log('🏁 Phase 3: Trade Management & Query Operations Complete');
	});
}); describe('Clean-up', () => {
	it('removes allowances from Operator', async () => {
		client.setOperator(operatorId, operatorKey);
		let result;
		if (operatorNftAllowances.length != 0) {
			result = await clearNFTAllowances(client, operatorNftAllowances);
			expect(result).to.be.equal('SUCCESS');
		}

		// clean up the LGS authorizations
		// getContractUsers()
		const lgsContractUsers = await contractExecuteQuery(
			lazyGasStationId,
			lazyGasStationIface,
			client,
			null,
			'getContractUsers',
		);

		for (let i = 0; i < lgsContractUsers[0].length; i++) {
			result = await contractExecuteFunction(
				lazyGasStationId,
				lazyGasStationIface,
				client,
				300_000,
				'removeContractUser',
				[lgsContractUsers[0][i]],
			);

			if (result[0]?.status.toString() !== 'SUCCESS') { console.log('Failed to remove LGS contract user:', result); }
			expect(result[0].status.toString()).to.be.equal('SUCCESS');
		}

		// getAuthorizers()
		const lgsAuthorizers = await contractExecuteQuery(
			lazyGasStationId,
			lazyGasStationIface,
			client,
			null,
			'getAuthorizers',
		);

		for (let i = 0; i < lgsAuthorizers[0].length; i++) {
			result = await contractExecuteFunction(
				lazyGasStationId,
				lazyGasStationIface,
				client,
				300_000,
				'removeAuthorizer',
				[lgsAuthorizers[0][i]],
			);

			if (result[0]?.status.toString() !== 'SUCCESS') { console.log('Failed to remove LGS authorizer:', result); }
			expect(result[0].status.toString()).to.be.equal('SUCCESS');
		}

		// getAdmins()
		const lgsAdmins = await contractExecuteQuery(
			lazyGasStationId,
			lazyGasStationIface,
			client,
			null,
			'getAdmins',
		);

		for (let i = 0; i < lgsAdmins[0].length; i++) {
			if (
				lgsAdmins[0][i].slice(2).toLowerCase() == operatorId.toSolidityAddress()
			) {
				console.log('Skipping removal of Operator as LGS admin');
				continue;
			}

			result = await contractExecuteFunction(
				lazyGasStationId,
				lazyGasStationIface,
				client,
				300_000,
				'removeAdmin',
				[lgsAdmins[0][i]],
			);

			if (result[0]?.status.toString() !== 'SUCCESS') { console.log('Failed to remove LGS admin:', result); }
			expect(result[0].status.toString()).to.be.equal('SUCCESS');
		}

		// ensure mirrors have caught up
		await sleep(4500);

		const outstandingAllowances = [];
		// get the FT allowances for operator
		const mirrorFTAllowances = await checkFTAllowances(env, operatorId);
		for (let a = 0; a < mirrorFTAllowances.length; a++) {
			const allowance = mirrorFTAllowances[a];
			// console.log('FT Allowance found:', allowance.token_id, allowance.owner, allowance.spender);
			if (allowance.token_id == lazyTokenId.toString() && allowance.amount > 0) { outstandingAllowances.push(allowance.spender); }
		}

		// if the contract was created reset any $LAZY allowance for the operator
		if (
			lstContractId &&
			outstandingAllowances.includes(lstContractId.toString())
		) {
			operatorFtAllowances.push({
				tokenId: lazyTokenId,
				owner: operatorId,
				spender: AccountId.fromString(lstContractId.toString()),
			});
		}
		if (
			lazyGasStationId &&
			outstandingAllowances.includes(lazyGasStationId.toString())
		) {
			operatorFtAllowances.push({
				tokenId: lazyTokenId,
				owner: operatorId,
				spender: AccountId.fromString(lazyGasStationId.toString()),
			});
		}

		result = await clearFTAllowances(client, operatorFtAllowances);
		expect(result).to.be.equal('SUCCESS');
	});

	it('sweep hbar from the test accounts', async () => {
		await sleep(5000);
		client.setOperator(operatorId, operatorKey);
		let balance = await checkMirrorHbarBalance(env, aliceId, alicePK);
		balance -= 1_000_000;
		console.log('sweeping alice', balance / 10 ** 8);
		let result = await sweepHbar(client, aliceId, alicePK, operatorId, new Hbar(balance, HbarUnit.Tinybar));
		console.log('alice:', result);
		balance = await checkMirrorHbarBalance(env, bobId, bobPK);
		balance -= 1_000_000;
		console.log('sweeping bob', balance / 10 ** 8);
		result = await sweepHbar(client, bobId, bobPK, operatorId, new Hbar(balance, HbarUnit.Tinybar));
		console.log('bob:', result);

		// Sweep Charlie if account was created during v0.2 testing
		if (typeof charlieId !== 'undefined' && charlieId) {
			balance = await checkMirrorHbarBalance(env, charlieId, charliePK);
			balance -= 1_000_000;
			console.log('sweeping charlie', balance / 10 ** 8);
			result = await sweepHbar(client, charlieId, charliePK, operatorId, new Hbar(balance, HbarUnit.Tinybar));
			console.log('charlie:', result);
		}
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
		lazySCT,
		lazyIface,
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
		lazySCT,
		lazyIface,
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
