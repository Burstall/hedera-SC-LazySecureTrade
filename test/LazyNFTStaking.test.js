const fs = require('fs');
const { ethers } = require('ethers');
const { expect } = require('chai');
const { describe, it } = require('mocha');
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
	sendFT,
	sendHbar,
	setHbarAllowance,
} = require('../utils/hederaHelpers');
const { fail } = require('assert');
const {
	checkLastMirrorEvent,
	checkFTAllowances,
	checkMirrorBalance,
} = require('../utils/hederaMirrorHelpers');
const { sleep } = require('../utils/nodeHelpers');
const {
	Stake,
	generateStakingRewardProof,
} = require('../utils/LazyNFTStakingHelper');
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
const contractName = 'LazyNFTStaking';
const lazyDelegateRegistryName = 'LazyDelegateRegistry';
const env = process.env.ENVIRONMENT ?? null;
const LAZY_BURN_PERCENT = process.env.LAZY_BURN_PERCENT ?? 25;
const LAZY_DECIMAL = process.env.LAZY_DECIMALS ?? 1;
const LAZY_STAKING_DISTRIBUTION_PERIOD =
	process.env.LAZY_STAKING_DISTRIBUTION_PERIOD ?? 3;
const LAZY_STAKING_BOOST_CAP = process.env.LAZY_STAKING_BOOST_CAP ?? 200;
const LAZY_STAKING_PERIOD_FOR_BONUS =
	process.env.LAZY_STAKING_PERIOD_FOR_BONUS ?? 5;
const LAZY_STAKING_HODL_BONUS = process.env.LAZY_STAKING_HODL_BONUS ?? 25;
const LAZY_STAKING_MAX_BONUS_PERIODS =
	process.env.LAZY_STAKING_MAX_BONUS_PERIODS ?? 3;
const LAZY_HALF_AFTER = process.env.LAZY_HALF_AFTER ?? 50_000_000;
const LAZY_MAX_SUPPLY = process.env.LAZY_MAX_SUPPLY ?? 250_000_000;

const addressRegex = /(\d+\.\d+\.[1-9]\d+)/i;

// reused variables
let lnsContractAddress, lnsContractId;
let lazyIface, lazyGasStationIface, lazyNFTStakingIface;
let lazyTokenId;
let alicePK, aliceId;
let bobPK, bobId;
let client;
let lazySCT;
let StkNFTA_TokenId,
	StkNFTB_TokenId,
	StkNFTC_TokenId,
	StkNFTD_TokenId,
	StkNFTE_TokenId;
let lazyGasStationId;
let signingWalletPK;

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

			await sendHbar(client, operatorId, aliceId, 300, HbarUnit.Hbar);
		}
		else {
			alicePK = PrivateKey.generateED25519();
			aliceId = await accountCreator(client, alicePK, 300);
			console.log(
				'Alice account ID:',
				aliceId.toString(),
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
			await sendHbar(client, operatorId, bobId, 50, HbarUnit.Hbar);
		}
		else {
			bobPK = PrivateKey.generateED25519();
			bobId = await accountCreator(client, bobPK, 50);
			console.log(
				'Bob account ID:',
				bobId.toString(),
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

		let lazyDeploySkipped = false;
		if (process.env.LAZY_SCT_CONTRACT_ID && process.env.LAZY_TOKEN_ID) {
			console.log(
				'\n-Using existing LAZY SCT:',
				process.env.LAZY_SCT_CONTRACT_ID,
			);
			lazySCT = ContractId.fromString(process.env.LAZY_SCT_CONTRACT_ID);

			lazyDeploySkipped = true;

			lazyTokenId = TokenId.fromString(process.env.LAZY_TOKEN_ID);
			console.log('\n-Using existing LAZY Token ID:', lazyTokenId.toString());
		}
		else {
			const gasLimit = 800_000;

			console.log(
				'\n- Deploying contract...',
				lazyContractCreator,
				'\n\tgas@',
				gasLimit,
			);

			[lazySCT] = await contractDeployFunction(client, lazyContractBytecode);

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
			const gasLimit = 1_500_000;
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

		let ldrAddress;
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
			const gasLimit = 500_000;

			const ldrJson = JSON.parse(
				fs.readFileSync(
					`./artifacts/contracts/${lazyDelegateRegistryName}.sol/${lazyDelegateRegistryName}.json`,
				),
			);

			const ldrBytecode = ldrJson.bytecode;

			console.log('\n- Deploying contract...', lazyDelegateRegistryName, '\n\tgas@', gasLimit);

			[ldrAddress] = await contractDeployFunction(client, ldrBytecode, gasLimit);

			console.log(
				`Lazy Delegate Registry contract created with ID: ${ldrAddress} / ${ldrAddress.toSolidityAddress()}`,
			);

			expect(ldrAddress.toString().match(addressRegex).length == 2).to.be.true;
		}


		const gasLimit = 2_500_000;

		// generate key pair for offchain signing
		signingWalletPK = PrivateKey.generateECDSA();
		console.log(
			`Using off-chain signing Public Key: 0x${signingWalletPK.publicKey.toEvmAddress()}`,
		);

		// now deploy main contract
		const lazyNFTStakerJson = JSON.parse(
			fs.readFileSync(
				`./artifacts/contracts/${contractName}.sol/${contractName}.json`,
			),
		);

		// import ABI
		lazyNFTStakingIface = ethers.Interface.from(lazyNFTStakerJson.abi);

		const contractBytecode = lazyNFTStakerJson.bytecode;

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
			.addAddress(signingWalletPK.publicKey.toEvmAddress())
			.addUint256(LAZY_BURN_PERCENT)
			.addUint256(LAZY_STAKING_DISTRIBUTION_PERIOD)
			.addUint32(LAZY_STAKING_BOOST_CAP)
			.addUint16(LAZY_STAKING_PERIOD_FOR_BONUS)
			.addUint16(LAZY_STAKING_HODL_BONUS)
			.addUint16(LAZY_STAKING_MAX_BONUS_PERIODS)
			.addUint256(LAZY_MAX_SUPPLY * 10 ** LAZY_DECIMAL)
			.addUint256(LAZY_HALF_AFTER * 10 ** LAZY_DECIMAL);

		[lnsContractId, lnsContractAddress] = await contractDeployFunction(
			client,
			contractBytecode,
			gasLimit,
			constructorParams,
		);

		expect(lnsContractId.toString().match(addressRegex).length == 2).to.be.true;

		console.log(
			`Lazy NFT Staking Contract created with ID: ${lnsContractId} / ${lnsContractAddress}`,
		);

		console.log('\n-Testing:', contractName);

		// mint NFTs from the 3rd party Alice Account
		// ensure royalties in place
		/*
			5 x Different NFTs of size 20 each
		*/

		const nftSize = 20;

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

		[result, tokenId] = await mintNFT(
			client,
			aliceId,
			'Stk NFT D',
			'StkNFTD',
			nftSize,
		);
		expect(result).to.be.equal('SUCCESS');
		StkNFTD_TokenId = tokenId;

		[result, tokenId] = await mintNFT(
			client,
			aliceId,
			'Stk NFT E',
			'StkNFTE',
			nftSize,
		);
		expect(result).to.be.equal('SUCCESS');
		StkNFTE_TokenId = tokenId;

		// configure the LazyNFTStaking instance
		client.setOperator(operatorId, operatorKey);

		// associate the FTs & NFT to operator
		client.setOperator(operatorId, operatorKey);
		const operatorTokensToAssociate = [];
		if (!lazyDeploySkipped) {
			operatorTokensToAssociate.push(lazyTokenId);
		}
		operatorTokensToAssociate.push(
			StkNFTA_TokenId,
			StkNFTB_TokenId,
			StkNFTC_TokenId,
			StkNFTD_TokenId,
			StkNFTE_TokenId,
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
			StkNFTD_TokenId,
			StkNFTE_TokenId,
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
		result = await sendLazy(operatorId, 600);
		expect(result).to.be.equal('SUCCESS');
		result = await sendLazy(aliceId, 900);
		expect(result).to.be.equal('SUCCESS');
		result = await sendLazy(bobId, 900);
		expect(result).to.be.equal('SUCCESS');
		result = await sendHbar(client, operatorId, AccountId.fromString(lazyGasStationId.toString()), 1, HbarUnit.Hbar);
		expect(result).to.be.equal('SUCCESS');

		// send $LAZY to the Lazy Gas Station
		// gas station will fuel payouts so ensure it has enough
		result = await sendLazy(lazyGasStationId, 100_000);
		expect(result).to.be.equal('SUCCESS');

		// add the LazyNFTStaker to the lazy gas station as a contract user
		result = await contractExecuteFunction(
			lazyGasStationId,
			lazyGasStationIface,
			client,
			null,
			'addContractUser',
			[lnsContractId.toSolidityAddress()],
		);

		if (result[0]?.status.toString() != 'SUCCESS') {
			console.log('ERROR adding LNS to LGS:', result);
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
			lnsContractId.toSolidityAddress(),
		);

		client.setOperator(aliceId, alicePK);

		// send NFTs 1-5 to Operator and 6-10 to Bob
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

		result = await sendNFT(
			client,
			aliceId,
			operatorId,
			StkNFTD_TokenId,
			serials.slice(0, 5),
		);
		expect(result).to.be.equal('SUCCESS');

		result = await sendNFT(
			client,
			aliceId,
			operatorId,
			StkNFTE_TokenId,
			serials.slice(0, 5),
		);

		result = await sendNFT(
			client,
			aliceId,
			bobId,
			StkNFTA_TokenId,
			serials.slice(5, 10),
		);
		expect(result).to.be.equal('SUCCESS');

		result = await sendNFT(
			client,
			aliceId,
			bobId,
			StkNFTB_TokenId,
			serials.slice(5, 10),
		);
		expect(result).to.be.equal('SUCCESS');

		result = await sendNFT(
			client,
			aliceId,
			bobId,
			StkNFTC_TokenId,
			serials.slice(5, 10),
		);
		expect(result).to.be.equal('SUCCESS');

		result = await sendNFT(
			client,
			aliceId,
			bobId,
			StkNFTD_TokenId,
			serials.slice(5, 10),
		);
		expect(result).to.be.equal('SUCCESS');

		result = await sendNFT(
			client,
			aliceId,
			bobId,
			StkNFTE_TokenId,
			serials.slice(5, 10),
		);
		expect(result).to.be.equal('SUCCESS');
	});
});

describe('Check Contract Deployment', () => {
	it('Should check the contract configuration', async () => {
		client.setOperator(operatorId, operatorKey);

		// get distributionPeriod
		const distributionPeriodResult = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'distributionPeriod',
		);
		expect(Number(distributionPeriodResult[0])).to.be.equal(
			Number(LAZY_STAKING_DISTRIBUTION_PERIOD),
		);

		// get burnPercentage
		const burnPercentageResult = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'burnPercentage',
		);
		expect(Number(burnPercentageResult[0])).to.be.equal(
			Number(LAZY_BURN_PERCENT),
		);

		// get boostRateCap
		const boostRateCapResult = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'boostRateCap',
		);
		expect(Number(boostRateCapResult[0])).to.be.equal(
			Number(LAZY_STAKING_BOOST_CAP),
		);

		// get totalItemsStaked (expect 0) from the mirror nodes
		const encodedCommand = lazyNFTStakingIface.encodeFunctionData(
			'totalItemsStaked',
			[],
		);

		const totalItemsStaked = await readOnlyEVMFromMirrorNode(
			env,
			lnsContractId,
			encodedCommand,
			operatorId,
			false,
		);

		const totalItemsStakedResult = lazyNFTStakingIface.decodeFunctionResult(
			'totalItemsStaked',
			totalItemsStaked,
		);
		expect(Number(totalItemsStakedResult[0])).to.be.equal(0);

		// get periodForBonus
		const periodForBonusResult = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'periodForBonus',
		);
		expect(Number(periodForBonusResult[0])).to.be.equal(
			Number(LAZY_STAKING_PERIOD_FOR_BONUS),
		);

		// get hodlBonusRate
		const hodlBonusRateResult = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'hodlBonusRate',
		);
		expect(Number(hodlBonusRateResult[0])).to.be.equal(
			Number(LAZY_STAKING_HODL_BONUS),
		);

		// get maxBonusTimePeriods
		const maxBonusTimePeriodsResult = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'maxBonusTimePeriods',
		);
		expect(Number(maxBonusTimePeriodsResult[0])).to.be.equal(
			Number(LAZY_STAKING_MAX_BONUS_PERIODS),
		);

		// get systemWallet
		const systemWallet = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'systemWallet',
		);
		expect(systemWallet[0].slice(2).toLowerCase()).to.be.equal(
			signingWalletPK.publicKey.toEvmAddress().toLowerCase(),
		);

		// check lazyMaxSupply
		const totalSupply = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'LAZY_MAX_SUPPLY',
		);
		expect(Number(totalSupply[0])).to.be.equal(LAZY_MAX_SUPPLY * 10 ** LAZY_DECIMAL);

		// check halfAfter
		const halfAfter = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'HALF_AFTER',
		);

		expect(Number(halfAfter[0])).to.be.equal(Number(LAZY_HALF_AFTER * 10 ** LAZY_DECIMAL));

		// currentEpoch should be 0
		const currentEpoch = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'currentEpoch',
		);
		expect(Number(currentEpoch[0])).to.be.equal(0);

		// epochPoints should be an array of size 5 with all elements 0
		const numPoints = Math.floor(LAZY_MAX_SUPPLY / LAZY_HALF_AFTER);
		for (let e = 0; e < numPoints; e++) {
			const epochPoints = await contractExecuteQuery(
				lnsContractId,
				lazyNFTStakingIface,
				client,
				null,
				'epochPoints',
				[e],
			);
			expect(epochPoints.length).to.be.equal(1);
			expect(Number(epochPoints[0])).to.be.equal(0);

			const epochValues = await contractExecuteQuery(
				lnsContractId,
				lazyNFTStakingIface,
				client,
				null,
				'epochValues',
				[e],
			);

			expect(epochValues.length).to.be.equal(1);
			expect(Number(epochValues[0])).to.be.equal(2 ** e);
		}
	});

	it('Should check access controls', async () => {
		let expectedErrors = 0;
		let unexpectedErrors = 0;

		// ALICE is not owner so expect failures
		client.setOperator(aliceId, alicePK);
		const newPK = PrivateKey.generateECDSA();
		try {
			const result = await contractExecuteFunction(
				lnsContractId,
				lazyNFTStakingIface,
				client,
				null,
				'setSystemWallet',
				[newPK.publicKey.toEvmAddress()],
			);
			if (
				result[0].status.toString() ==
				'REVERT: Ownable: caller is not the owner'
			) {
				expectedErrors++;
			}
			else {
				console.log('Unexpected Result (setSystemWallet):', result);
				unexpectedErrors++;
			}
		}
		catch (err) {
			console.log(err);
			unexpectedErrors++;
		}

		// setDistributionPeriod
		try {
			const result = await contractExecuteFunction(
				lnsContractId,
				lazyNFTStakingIface,
				client,
				null,
				'setDistributionPeriod',
				[1],
			);
			if (
				result[0].status.toString() ==
				'REVERT: Ownable: caller is not the owner'
			) {
				expectedErrors++;
			}
			else {
				console.log('Unexpected Result (setDistributionPeriod):', result);
				unexpectedErrors++;
			}
		}
		catch (err) {
			console.log(err);
			unexpectedErrors++;
		}

		// setStakeableCollection
		try {
			const result = await contractExecuteFunction(
				lnsContractId,
				lazyNFTStakingIface,
				client,
				null,
				'setStakeableCollection',
				[[StkNFTA_TokenId.toSolidityAddress()], [200]],
			);
			if (
				result[0].status.toString() ==
				'REVERT: Ownable: caller is not the owner'
			) {
				expectedErrors++;
			}
			else {
				console.log('Unexpected Result (setStakeableCollection):', result);
				unexpectedErrors++;
			}
		}
		catch (err) {
			console.log(err);
			unexpectedErrors++;
		}

		// removeStakeableCollection
		try {
			const result = await contractExecuteFunction(
				lnsContractId,
				lazyNFTStakingIface,
				client,
				null,
				'removeStakeableCollection',
				[[StkNFTA_TokenId.toSolidityAddress()]],
			);
			if (
				result[0].status.toString() ==
				'REVERT: Ownable: caller is not the owner'
			) {
				expectedErrors++;
			}
			else {
				console.log('Unexpected Result (removeStakeableCollection):', result);
				unexpectedErrors++;
			}
		}
		catch (err) {
			console.log(err);
			unexpectedErrors++;
		}

		// setBurnPercentage
		try {
			const result = await contractExecuteFunction(
				lnsContractId,
				lazyNFTStakingIface,
				client,
				null,
				'setBurnPercentage',
				[1],
			);
			if (
				result[0].status.toString() ==
				'REVERT: Ownable: caller is not the owner'
			) {
				expectedErrors++;
			}
			else {
				console.log('Unexpected Result (setBurnPercentage):', result);
				unexpectedErrors++;
			}
		}
		catch (err) {
			console.log(err);
			unexpectedErrors++;
		}

		// setBoostRateCap
		try {
			const result = await contractExecuteFunction(
				lnsContractId,
				lazyNFTStakingIface,
				client,
				null,
				'setBoostRateCap',
				[1],
			);
			if (
				result[0].status.toString() ==
				'REVERT: Ownable: caller is not the owner'
			) {
				expectedErrors++;
			}
			else {
				console.log('Unexpected Result (setBoostRateCap):', result);
				unexpectedErrors++;
			}
		}
		catch (err) {
			console.log(err);
			unexpectedErrors++;
		}

		// setHodlBonusRate
		try {
			const result = await contractExecuteFunction(
				lnsContractId,
				lazyNFTStakingIface,
				client,
				null,
				'setHodlBonusRate',
				[1],
			);
			if (
				result[0].status.toString() ==
				'REVERT: Ownable: caller is not the owner'
			) {
				expectedErrors++;
			}
			else {
				console.log('Unexpected Result (setHodlBonusRate):', result);
				unexpectedErrors++;
			}
		}
		catch (err) {
			console.log(err);
			unexpectedErrors++;
		}

		// setPeriodForBonus
		try {
			const result = await contractExecuteFunction(
				lnsContractId,
				lazyNFTStakingIface,
				client,
				null,
				'setPeriodForBonus',
				[1],
			);
			if (
				result[0].status.toString() ==
				'REVERT: Ownable: caller is not the owner'
			) {
				expectedErrors++;
			}
			else {
				console.log('Unexpected Result (setPeriodForBonus):', result);
				unexpectedErrors++;
			}
		}
		catch (err) {
			console.log(err);
			unexpectedErrors++;
		}

		// setMaxBonusTimePeriods
		try {
			const result = await contractExecuteFunction(
				lnsContractId,
				lazyNFTStakingIface,
				client,
				null,
				'setMaxBonusTimePeriods',
				[1],
			);
			if (
				result[0].status.toString() ==
				'REVERT: Ownable: caller is not the owner'
			) {
				expectedErrors++;
			}
			else {
				console.log('Unexpected Result (setMaxBonusTimePeriods):', result);
				unexpectedErrors++;
			}
		}
		catch (err) {
			console.log(err);
			unexpectedErrors++;
		}

		console.log('Expected errors:', expectedErrors);
		console.log('Unexpected errors:', unexpectedErrors);

		expect(expectedErrors).to.be.equal(9);
		expect(unexpectedErrors).to.be.equal(0);
	});

	it('Should ready the contract for use', async () => {
		// add the token to the stakeable collection
		client.setOperator(operatorId, operatorKey);
		const result = await contractExecuteFunction(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			5_750_000,
			'setStakeableCollection',
			[
				[
					StkNFTA_TokenId.toSolidityAddress(),
					StkNFTB_TokenId.toSolidityAddress(),
					StkNFTC_TokenId.toSolidityAddress(),
					StkNFTD_TokenId.toSolidityAddress(),
					StkNFTE_TokenId.toSolidityAddress(),
				],
				[2000, 2000, 2000, 2000, 2000],
			],
		);

		if (result[0]?.status.toString() != 'SUCCESS') {
			console.log('ERROR adding NFTs to stakeable collection:', result);
			fail();
		}
	});
});

describe('Message Verification', () => {
	it('Should send an encoded staking message and check it verifies', async () => {
		// check the message verification mechanism
		client.setOperator(operatorId, operatorKey);

		const boostRate = 3;

		// create an array of Stake objects
		const stakes = [];

		stakes.push(new Stake(StkNFTA_TokenId.toSolidityAddress(), [1, 2], [1, 1]));
		stakes.push(new Stake(StkNFTB_TokenId.toSolidityAddress(), [3, 4], [2, 2]));
		stakes.push(new Stake(StkNFTC_TokenId.toSolidityAddress(), [5], [100]));

		// to create the signature we need to pack the variables and hash them in the same order and manner as the contract
		const rewardProof = await generateStakingRewardProof(
			operatorId,
			boostRate,
			signingWalletPK,
			stakes,
		);

		// now verify the proof with the contract
		let result = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'isValidSignature',
			[stakes, rewardProof],
		);

		expect(result[0]).to.be.true;

		// noew check it via the mirror node
		const encodedCommand = lazyNFTStakingIface.encodeFunctionData(
			'isValidSignature',
			[stakes, rewardProof],
		);

		result = await readOnlyEVMFromMirrorNode(
			env,
			lnsContractId,
			encodedCommand,
			operatorId,
			false,
		);

		const valid = lazyNFTStakingIface.decodeFunctionResult(
			'isValidSignature',
			result,
		);

		expect(valid[0]).to.be.true;

		// tamper with the rate and verify it fails
		rewardProof.boostRate = 4;

		try {
			result = await contractExecuteQuery(
				lnsContractId,
				lazyNFTStakingIface,
				client,
				null,
				'isValidSignature',
				[stakes, rewardProof],
			);

			expect(result[0]).to.be.false;
		}
		catch (err) {
			console.log('ERROR testing signature verification:', err);
			fail();
		}

		// reset boostRate and then dope the Stake array and verify it fails
		rewardProof.boostRate = 3;
		stakes.push(new Stake(StkNFTD_TokenId.toSolidityAddress(), [6], [100]));

		try {
			result = await contractExecuteQuery(
				lnsContractId,
				lazyNFTStakingIface,
				client,
				null,
				'isValidSignature',
				[stakes, rewardProof],
			);

			expect(result[0]).to.be.false;
		}
		catch (err) {
			console.log('ERROR verifying signature with extra stake:', err);
			fail();
		}

		// pop the dopes Stake array and verify it passes again
		stakes.pop();
		result = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'isValidSignature',
			[stakes, rewardProof],
		);

		expect(result[0]).to.be.true;

		// REMOVED: validity now set to 120 seconds in the future in line with Hedera consensus
		// // test timeout: sleep until 10 seconds after the rewardProof.validityTimestamp
		// const timeToSleep =
		// 	(rewardProof.validityTimestamp + 10) * 1000 - Date.now();
		// if (timeToSleep > 0) await sleep(timeToSleep + 800);

		// try {
		// 	result = await contractExecuteFunction(
		// 		lnsContractId,
		// 		lazyNFTStakingIface,
		// 		client,
		// 		null,
		// 		'isValidSignature',
		// 		[stakes, rewardProof],
		// 	);

		// 	expect(result[0].status.toString()).to.be.equal(
		// 		'REVERT: Signature has expired',
		// 	);
		// }
		// catch (err) {
		// 	console.log('ERROR expecting verification timeout:', err);
		// 	console.log('RewardProof object', rewardProof);
		// 	fail();
		// }
	});
});

describe('Staking', () => {
	it('Check Base Rate Cap blocks', async () => {
		// check the base rate cap for collection A
		// let mirror catch up
		await sleep(4000);
		const encodedCommand = lazyNFTStakingIface.encodeFunctionData(
			'getMaxBaseRate',
			[StkNFTA_TokenId.toSolidityAddress()],
		);

		let result = await readOnlyEVMFromMirrorNode(
			env,
			lnsContractId,
			encodedCommand,
			operatorId,
			false,
		);

		const maxBaseRate = lazyNFTStakingIface.decodeFunctionResult(
			'getMaxBaseRate',
			result,
		);

		console.log('Max Base Rate:', maxBaseRate);
		expect(Number(maxBaseRate[0])).to.be.equal(2000);

		// try and stake more than the base rate cap expecting a RateCapExceeded error
		const stakes = [];
		stakes.push(new Stake(StkNFTA_TokenId.toSolidityAddress(), [1, 2], [2000, 2001]));

		const boostRate = 10;

		const rewardProof = await generateStakingRewardProof(
			operatorId,
			boostRate,
			signingWalletPK,
			stakes,
		);

		result = await contractExecuteFunction(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			750_000,
			'stake',
			[stakes, rewardProof],
		);

		if (result[0]?.status?.name != 'RateCapExceeded') {
			console.log('ERROR expecting RateCapExceeded:', result);
			fail();
		}
	});

	it('Check invalid collection blocker', async () => {
		// try and stake an NFT that is not in the stakeable collection
		const stakes = [];
		// using random collection ID
		stakes.push(new Stake(TokenId.fromString('0.0.2222').toSolidityAddress(), [1], [100]));

		const boostRate = 0;

		const rewardProof = await generateStakingRewardProof(
			operatorId,
			boostRate,
			signingWalletPK,
			stakes,
		);

		const result = await contractExecuteFunction(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			750_000,
			'stake',
			[stakes, rewardProof],
		);

		if (result[0]?.status != 'REVERT: Invalid Collection') {
			console.log('ERROR expecting Invalid Collection Revert message:', result);
			fail();
		}
	});

	it('Operator should stake NFTs, check earn rate and claim', async () => {
		// stake the NFTs
		client.setOperator(operatorId, operatorKey);

		// first let's check current rewards are 0
		const encodedCommand = lazyNFTStakingIface.encodeFunctionData(
			'calculateRewards',
			[operatorId.toSolidityAddress()],
		);

		let result = await readOnlyEVMFromMirrorNode(
			env,
			lnsContractId,
			encodedCommand,
			operatorId,
			false,
		);

		const rewards = lazyNFTStakingIface.decodeFunctionResult(
			'calculateRewards',
			result,
		);

		// uint256 rewards, uint256 rewardRate, uint256 asOfTimestamp, unit256 userLastClaim
		expect(Number(rewards[0])).to.be.equal(0);
		expect(Number(rewards[1])).to.be.equal(0);
		expect(Number(rewards[3])).to.be.equal(0);

		// now stake the NFTs
		const stakes = [];
		stakes.push(new Stake(StkNFTA_TokenId.toSolidityAddress(), [1, 2], [10, 10]));
		stakes.push(new Stake(StkNFTB_TokenId.toSolidityAddress(), [3, 4], [20, 20]));
		stakes.push(new Stake(StkNFTC_TokenId.toSolidityAddress(), [5], [1000]));

		// set allowance for LNS to spend the NFTs
		const approvalTx = await setNFTAllowanceAll(client, [StkNFTA_TokenId, StkNFTB_TokenId, StkNFTC_TokenId], operatorId, AccountId.fromString(lnsContractId.toString()));
		expect(approvalTx).to.be.equal('SUCCESS');

		operatorNftAllowances.push({ tokenId: StkNFTA_TokenId, owner: operatorId, spender: AccountId.fromString(lnsContractId.toString()) });
		operatorNftAllowances.push({ tokenId: StkNFTB_TokenId, owner: operatorId, spender: AccountId.fromString(lnsContractId.toString()) });
		operatorNftAllowances.push({ tokenId: StkNFTC_TokenId, owner: operatorId, spender: AccountId.fromString(lnsContractId.toString()) });

		const boostRate = 10;

		const rewardProof = await generateStakingRewardProof(
			operatorId,
			boostRate,
			signingWalletPK,
			stakes,
		);

		result = await contractExecuteFunction(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			3_500_000,
			'stake',
			[stakes, rewardProof],
		);

		const stakedTimestamp = Date.now();

		if (result[0]?.status?.toString() != 'SUCCESS') {
			console.log('ERROR staking NFTs:', result);
			fail();
		}

		console.log('Staking - Tx id:', result[2]?.transactionId?.toString());

		// test we can get status of what is staked
		// getStakedNFTs
		const stakedNFTs = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'getStakedNFTs',
			[operatorId.toSolidityAddress()],
		);
		// address[] collection, unit256[][] serials
		expect(stakedNFTs.length).to.be.equal(2);
		expect(stakedNFTs[0].length).to.be.equal(3);
		expect(stakedNFTs[0][0].slice(2).toLowerCase()).to.be.equal(
			StkNFTA_TokenId.toSolidityAddress().toLowerCase(),
		);
		expect(stakedNFTs[0][1].slice(2).toLowerCase()).to.be.equal(
			StkNFTB_TokenId.toSolidityAddress().toLowerCase(),
		);
		expect(stakedNFTs[0][2].slice(2).toLowerCase()).to.be.equal(
			StkNFTC_TokenId.toSolidityAddress().toLowerCase(),
		);
		expect(stakedNFTs[1].length).to.be.equal(3);
		expect(stakedNFTs[1][0].length).to.be.equal(2);
		expect(stakedNFTs[1][0][0]).to.be.equal(1);
		expect(stakedNFTs[1][0][1]).to.be.equal(2);
		expect(stakedNFTs[1][1][0]).to.be.equal(3);
		expect(stakedNFTs[1][1][1]).to.be.equal(4);
		expect(stakedNFTs[1][2][0]).to.be.equal(5);

		// getStakingUsers
		const stakingUsers = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'getStakingUsers',
		);
		expect(stakingUsers[0].length).to.be.equal(1);
		expect(stakingUsers[0][0].slice(2).toLowerCase()).to.be.equal(
			operatorId.toSolidityAddress().toLowerCase(),
		);

		// getStakableCollections
		const stakableCollections = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'getStakableCollections',
		);

		expect(stakableCollections[0].length).to.be.equal(5);
		expect(stakableCollections[0][0].slice(2).toLowerCase()).to.be.equal(
			StkNFTA_TokenId.toSolidityAddress().toLowerCase(),
		);
		expect(stakableCollections[0][1].slice(2).toLowerCase()).to.be.equal(
			StkNFTB_TokenId.toSolidityAddress().toLowerCase(),
		);
		expect(stakableCollections[0][2].slice(2).toLowerCase()).to.be.equal(
			StkNFTC_TokenId.toSolidityAddress().toLowerCase(),
		);
		expect(stakableCollections[0][3].slice(2).toLowerCase()).to.be.equal(
			StkNFTD_TokenId.toSolidityAddress().toLowerCase(),
		);
		expect(stakableCollections[0][4].slice(2).toLowerCase()).to.be.equal(
			StkNFTE_TokenId.toSolidityAddress().toLowerCase(),
		);

		// getStakedSerials
		const stakedSerials = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'getStakedSerials',
			[StkNFTA_TokenId.toSolidityAddress()],
		);

		expect(stakedSerials[0].length).to.be.equal(2);
		expect(stakedSerials[0][0]).to.be.equal(1);
		expect(stakedSerials[0][1]).to.be.equal(2);

		// getNumStakedNFTs
		const numStakedNFTs = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'getNumStakedNFTs',
			[StkNFTC_TokenId.toSolidityAddress()],
		);
		expect(Number(numStakedNFTs[0])).to.be.equal(1);

		// totalItemsStaked
		const totalItemsStaked = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'totalItemsStaked',
		);

		expect(Number(totalItemsStaked[0])).to.be.equal(5);

		// getBaseRewardRate
		const baseRewardRate = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'getBaseRewardRate',
			[operatorId.toSolidityAddress()],
		);

		expect(Number(baseRewardRate[0])).to.be.equal(1060);

		// getActiveBoostRate
		const activeBoostRate = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'getActiveBoostRate',
			[operatorId.toSolidityAddress()],
		);

		expect(Number(activeBoostRate[0])).to.be.equal(10);

		// speed bump
		await sleep(2000);

		const timePassedInSeconds = Math.floor(
			(Date.now() - stakedTimestamp) / 1000,
		);

		const [expectedRewards, earnRate] = calcRewards(
			Number(baseRewardRate[0]),
			Number(activeBoostRate[0]),
			timePassedInSeconds,
			LAZY_STAKING_DISTRIBUTION_PERIOD,
			LAZY_STAKING_PERIOD_FOR_BONUS,
			LAZY_STAKING_MAX_BONUS_PERIODS,
			LAZY_STAKING_HODL_BONUS,
		);
		console.log('Time passed in seconds:', timePassedInSeconds, 'expected:', expectedRewards, '@', earnRate);
		// calculateRewards
		const calculateRewards = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'calculateRewards',
			[operatorId.toSolidityAddress()],
		);
		console.log('Lazy Earnt:', Number(calculateRewards[0]), 'As of', Number(calculateRewards[2]));
		expect(Number(calculateRewards[0])).to.be.greaterThanOrEqual(expectedRewards);

		// get the operator's balance of lazy tokens from mirror node
		const operatorLazyBalance = await checkMirrorBalance(
			env,
			operatorId,
			lazyTokenId,
		);

		// claimRewards
		result = await contractExecuteFunction(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			800_000,
			'claimRewards',
		);

		if (result[0]?.status.toString() != 'SUCCESS') {
			console.log('ERROR claiming rewards:', result);
			fail();
		}

		const anticipatedPmtNetOfBurn = Math.floor(Number(calculateRewards[0]) * (100 - Number(LAZY_BURN_PERCENT)) / 100);
		console.log('Anticipated payment net of burn:', anticipatedPmtNetOfBurn, 'actual:', Number(result[1][0]));
		expect(Number(result[1][0])).to.be.greaterThanOrEqual(anticipatedPmtNetOfBurn);

		await sleep(5000);

		const newOperatorLazyBalance = await checkMirrorBalance(
			env,
			operatorId,
			lazyTokenId,
		);

		expect(Number(newOperatorLazyBalance)).to.be.equal(operatorLazyBalance + Number(result[1][0]));

		console.log('Operator Lazy Balance:', operatorLazyBalance, '->', newOperatorLazyBalance, 'claimed:', Number(result[1][0]));

	});

	it('Bob should stake NFTs, check earn rate and HODL', async () => {
		// stake the NFTs
		client.setOperator(bobId, bobPK);

		// first let's check current rewards are 0
		const encodedCommand = lazyNFTStakingIface.encodeFunctionData(
			'calculateRewards',
			[bobId.toSolidityAddress()],
		);

		let result = await readOnlyEVMFromMirrorNode(
			env,
			lnsContractId,
			encodedCommand,
			bobId,
			false,
		);

		const rewards = lazyNFTStakingIface.decodeFunctionResult(
			'calculateRewards',
			result,
		);

		// uint256 rewards, uint256 rewardRate, uint256 asOfTimestamp, unit256 userLastClaim
		expect(Number(rewards[0])).to.be.equal(0);
		expect(Number(rewards[1])).to.be.equal(0);
		expect(Number(rewards[3])).to.be.equal(0);

		// now stake the NFTs
		const stakes = [];
		stakes.push(new Stake(StkNFTA_TokenId.toSolidityAddress(), [6], [10]));
		stakes.push(new Stake(StkNFTB_TokenId.toSolidityAddress(), [6], [20]));
		stakes.push(new Stake(StkNFTC_TokenId.toSolidityAddress(), [6, 7, 8], [1000, 500, 250]));

		// set allowance for LNS to spend the NFTs
		const approvalTx = await setNFTAllowanceAll(client, [StkNFTA_TokenId, StkNFTB_TokenId, StkNFTC_TokenId], bobId, AccountId.fromString(lnsContractId.toString()));
		expect(approvalTx).to.be.equal('SUCCESS');

		const boostRate = 15;

		const rewardProof = await generateStakingRewardProof(
			bobId,
			boostRate,
			signingWalletPK,
			stakes,
		);

		result = await contractExecuteFunction(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			3_500_000,
			'stake',
			[stakes, rewardProof],
		);

		const stakedTimestamp = Date.now();

		if (result[0]?.status?.toString() != 'SUCCESS') {
			console.log('ERROR staking NFTs:', result);
			fail();
		}

		console.log('Staking - Tx id:', result[2]?.transactionId?.toString());

		// test we can get status of what is staked
		// getStakedNFTs
		const stakedNFTs = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'getStakedNFTs',
			[bobId.toSolidityAddress()],
		);
		// address[] collection, unit256[][] serials
		expect(stakedNFTs.length).to.be.equal(2);
		expect(stakedNFTs[0].length).to.be.equal(3);
		expect(stakedNFTs[0][0].slice(2).toLowerCase()).to.be.equal(
			StkNFTA_TokenId.toSolidityAddress().toLowerCase(),
		);
		expect(stakedNFTs[0][1].slice(2).toLowerCase()).to.be.equal(
			StkNFTB_TokenId.toSolidityAddress().toLowerCase(),
		);
		expect(stakedNFTs[0][2].slice(2).toLowerCase()).to.be.equal(
			StkNFTC_TokenId.toSolidityAddress().toLowerCase(),
		);
		expect(stakedNFTs[1].length).to.be.equal(3);
		expect(stakedNFTs[1][0].length).to.be.equal(1);
		expect(stakedNFTs[1][0][0]).to.be.equal(6);
		expect(stakedNFTs[1][1].length).to.be.equal(1);
		expect(stakedNFTs[1][1][0]).to.be.equal(6);
		expect(stakedNFTs[1][2].length).to.be.equal(3);
		expect(stakedNFTs[1][2][0]).to.be.equal(6);
		expect(stakedNFTs[1][2][1]).to.be.equal(7);
		expect(stakedNFTs[1][2][2]).to.be.equal(8);

		// getStakingUsers
		const stakingUsers = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'getStakingUsers',
		);
		expect(stakingUsers[0].length).to.be.equal(2);
		expect(stakingUsers[0][0].slice(2).toLowerCase()).to.be.equal(
			operatorId.toSolidityAddress().toLowerCase(),
		);
		expect(stakingUsers[0][1].slice(2).toLowerCase()).to.be.equal(
			bobId.toSolidityAddress().toLowerCase(),
		);

		// getStakedSerials
		const stakedSerials = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'getStakedSerials',
			[StkNFTA_TokenId.toSolidityAddress()],
		);

		expect(stakedSerials[0].length).to.be.equal(3);
		expect(stakedSerials[0][0]).to.be.equal(1);
		expect(stakedSerials[0][1]).to.be.equal(2);
		expect(stakedSerials[0][2]).to.be.equal(6);

		// getNumStakedNFTs
		const numStakedNFTs = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'getNumStakedNFTs',
			[StkNFTC_TokenId.toSolidityAddress()],
		);
		expect(Number(numStakedNFTs[0])).to.be.equal(4);

		// totalItemsStaked
		const totalItemsStaked = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'totalItemsStaked',
		);

		expect(Number(totalItemsStaked[0])).to.be.equal(10);

		// getBaseRewardRate
		const baseRewardRate = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'getBaseRewardRate',
			[bobId.toSolidityAddress()],
		);

		expect(Number(baseRewardRate[0])).to.be.equal(1780);

		// getActiveBoostRate
		const activeBoostRate = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'getActiveBoostRate',
			[bobId.toSolidityAddress()],
		);

		expect(Number(activeBoostRate[0])).to.be.equal(15);

		// speed bump
		await sleep(2000);

		const timePassedInSeconds = Math.floor(
			(Date.now() - stakedTimestamp) / 1000,
		);

		const [expectedRewards, earnRate] = calcRewards(
			Number(baseRewardRate[0]),
			Number(activeBoostRate[0]),
			timePassedInSeconds,
			LAZY_STAKING_DISTRIBUTION_PERIOD,
			LAZY_STAKING_PERIOD_FOR_BONUS,
			LAZY_STAKING_MAX_BONUS_PERIODS,
			LAZY_STAKING_HODL_BONUS,
		);
		console.log('Time passed in seconds:', timePassedInSeconds, 'expected:', expectedRewards, '@', earnRate);
		// calculateRewards
		const calculateRewards = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'calculateRewards',
			[bobId.toSolidityAddress()],
		);
		console.log('Lazy Earnt:', Number(calculateRewards[0]), 'As of', Number(calculateRewards[2]));
		expect(Number(calculateRewards[0])).to.be.greaterThanOrEqual(expectedRewards);
	});

	it('Alice should stake NFTs, check earn rate and HODL', async () => {
		// stake the NFTs
		client.setOperator(aliceId, alicePK);

		// first let's check current rewards are 0
		const encodedCommand = lazyNFTStakingIface.encodeFunctionData(
			'calculateRewards',
			[aliceId.toSolidityAddress()],
		);

		let result = await readOnlyEVMFromMirrorNode(
			env,
			lnsContractId,
			encodedCommand,
			aliceId,
			false,
		);

		const rewards = lazyNFTStakingIface.decodeFunctionResult(
			'calculateRewards',
			result,
		);

		// uint256 rewards, uint256 rewardRate, uint256 asOfTimestamp, unit256 userLastClaim
		expect(Number(rewards[0])).to.be.equal(0);
		expect(Number(rewards[1])).to.be.equal(0);
		expect(Number(rewards[3])).to.be.equal(0);

		// now stake the NFTs
		const stakes = [];
		stakes.push(new Stake(StkNFTA_TokenId.toSolidityAddress(), [11], [10]));
		stakes.push(new Stake(StkNFTB_TokenId.toSolidityAddress(), [11, 12, 13], [15, 15, 5]));
		stakes.push(new Stake(StkNFTC_TokenId.toSolidityAddress(), [11], [350]));

		// set allowance for LNS to spend the NFTs
		const approvalTx = await setNFTAllowanceAll(client, [StkNFTA_TokenId, StkNFTB_TokenId, StkNFTC_TokenId], aliceId, AccountId.fromString(lnsContractId.toString()));
		expect(approvalTx).to.be.equal('SUCCESS');

		const boostRate = 0;

		const rewardProof = await generateStakingRewardProof(
			aliceId,
			boostRate,
			signingWalletPK,
			stakes,
		);

		result = await contractExecuteFunction(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			3_000_000,
			'stake',
			[stakes, rewardProof],
		);

		const stakedTimestamp = Date.now();

		if (result[0]?.status?.toString() != 'SUCCESS') {
			console.log('ERROR staking NFTs:', result);
			fail();
		}

		console.log('Staking - Tx id:', result[2]?.transactionId?.toString());

		// test we can get status of what is staked
		// getStakedNFTs
		const stakedNFTs = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'getStakedNFTs',
			[aliceId.toSolidityAddress()],
		);
		// address[] collection, unit256[][] serials
		expect(stakedNFTs.length).to.be.equal(2);
		expect(stakedNFTs[0].length).to.be.equal(3);
		expect(stakedNFTs[0][0].slice(2).toLowerCase()).to.be.equal(
			StkNFTA_TokenId.toSolidityAddress().toLowerCase(),
		);
		expect(stakedNFTs[0][1].slice(2).toLowerCase()).to.be.equal(
			StkNFTB_TokenId.toSolidityAddress().toLowerCase(),
		);
		expect(stakedNFTs[0][2].slice(2).toLowerCase()).to.be.equal(
			StkNFTC_TokenId.toSolidityAddress().toLowerCase(),
		);
		expect(stakedNFTs[1].length).to.be.equal(3);
		expect(stakedNFTs[1][0].length).to.be.equal(1);
		expect(stakedNFTs[1][0][0]).to.be.equal(11);
		expect(stakedNFTs[1][1].length).to.be.equal(3);
		expect(stakedNFTs[1][1][0]).to.be.equal(11);
		expect(stakedNFTs[1][1][1]).to.be.equal(12);
		expect(stakedNFTs[1][1][2]).to.be.equal(13);
		expect(stakedNFTs[1][2].length).to.be.equal(1);
		expect(stakedNFTs[1][2][0]).to.be.equal(11);

		// getStakingUsers
		const stakingUsers = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'getStakingUsers',
		);
		expect(stakingUsers[0].length).to.be.equal(3);
		expect(stakingUsers[0][0].slice(2).toLowerCase()).to.be.equal(
			operatorId.toSolidityAddress().toLowerCase(),
		);
		expect(stakingUsers[0][1].slice(2).toLowerCase()).to.be.equal(
			bobId.toSolidityAddress().toLowerCase(),
		);
		expect(stakingUsers[0][2].slice(2).toLowerCase()).to.be.equal(
			aliceId.toSolidityAddress().toLowerCase(),
		);

		// getStakedSerials
		const stakedSerials = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'getStakedSerials',
			[StkNFTA_TokenId.toSolidityAddress()],
		);

		expect(stakedSerials[0].length).to.be.equal(4);
		expect(stakedSerials[0][0]).to.be.equal(1);
		expect(stakedSerials[0][1]).to.be.equal(2);
		expect(stakedSerials[0][2]).to.be.equal(6);
		expect(stakedSerials[0][3]).to.be.equal(11);

		// getNumStakedNFTs
		const numStakedNFTs = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'getNumStakedNFTs',
			[StkNFTC_TokenId.toSolidityAddress()],
		);
		expect(Number(numStakedNFTs[0])).to.be.equal(5);

		// totalItemsStaked
		const totalItemsStaked = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'totalItemsStaked',
		);

		expect(Number(totalItemsStaked[0])).to.be.equal(15);

		// getBaseRewardRate
		const baseRewardRate = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'getBaseRewardRate',
			[aliceId.toSolidityAddress()],
		);

		expect(Number(baseRewardRate[0])).to.be.equal(395);

		// getActiveBoostRate
		const activeBoostRate = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'getActiveBoostRate',
			[aliceId.toSolidityAddress()],
		);

		expect(Number(activeBoostRate[0])).to.be.equal(0);

		// speed bump
		await sleep(2000);

		const timePassedInSeconds = Math.floor(
			(Date.now() - stakedTimestamp) / 1000,
		);

		const [expectedRewards, earnRate] = calcRewards(
			Number(baseRewardRate[0]),
			Number(activeBoostRate[0]),
			timePassedInSeconds,
			LAZY_STAKING_DISTRIBUTION_PERIOD,
			LAZY_STAKING_PERIOD_FOR_BONUS,
			LAZY_STAKING_MAX_BONUS_PERIODS,
			LAZY_STAKING_HODL_BONUS,
		);
		console.log('Time passed in seconds:', timePassedInSeconds, 'expected:', expectedRewards, '@', earnRate);
		// calculateRewards
		const calculateRewards = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'calculateRewards',
			[aliceId.toSolidityAddress()],
		);
		console.log('Lazy Earnt:', Number(calculateRewards[0]), 'As of', Number(calculateRewards[2]));
		expect(Number(calculateRewards[0])).to.be.greaterThanOrEqual(expectedRewards);
	});

	it('Operator adds more NFTs, checks math on claim and HODL', async () => {
		// stake the NFTs
		client.setOperator(operatorId, operatorKey);

		// get current reward rate
		let baseRewardRate = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'getBaseRewardRate',
			[operatorId.toSolidityAddress()],
		);

		const oldBaseRewardRate = Number(baseRewardRate[0]);

		// stake additional token D and E
		const stakes = [];
		stakes.push(new Stake(StkNFTD_TokenId.toSolidityAddress(), [1], [20]));
		stakes.push(new Stake(StkNFTE_TokenId.toSolidityAddress(), [1], [25]));

		// set allowance for LNS to spend the NFTs
		const approvalTx = await setNFTAllowanceAll(client, [StkNFTD_TokenId, StkNFTE_TokenId], operatorId, AccountId.fromString(lnsContractId.toString()));
		expect(approvalTx).to.be.equal('SUCCESS');

		// get the current claimable reward
		const encodedCommand = lazyNFTStakingIface.encodeFunctionData(
			'calculateRewards',
			[operatorId.toSolidityAddress()],
		);

		let result = await readOnlyEVMFromMirrorNode(
			env,
			lnsContractId,
			encodedCommand,
			operatorId,
			false,
		);

		const rewards = lazyNFTStakingIface.decodeFunctionResult(
			'calculateRewards',
			result,
		);

		// uint256 rewards, uint256 rewardRate, uint256 asOfTimestamp, unit256 userLastClaim
		const preAdditionalStakeRewards = Number(rewards[0]);
		const preAdditionalStakeRewardRate = Number(rewards[1]);

		const boostRate = 20;

		const rewardProof = await generateStakingRewardProof(
			operatorId,
			boostRate,
			signingWalletPK,
			stakes,
		);

		result = await contractExecuteFunction(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			2_600_000,
			'stake',
			[stakes, rewardProof],
		);

		const stakedTimestamp = Date.now();

		if (result[0]?.status?.toString() != 'SUCCESS') {
			console.log('ERROR staking NFTs:', result);
			fail();
		}

		console.log('Staking - Tx id:', result[2]?.transactionId?.toString());

		// test we can get status of what is staked
		// getStakedNFTs
		const stakedNFTs = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'getStakedNFTs',
			[operatorId.toSolidityAddress()],
		);
		// address[] collection, unit256[][] serials
		expect(stakedNFTs.length).to.be.equal(2);
		expect(stakedNFTs[0].length).to.be.equal(5);
		expect(stakedNFTs[0][0].slice(2).toLowerCase()).to.be.equal(
			StkNFTA_TokenId.toSolidityAddress().toLowerCase(),
		);
		expect(stakedNFTs[0][1].slice(2).toLowerCase()).to.be.equal(
			StkNFTB_TokenId.toSolidityAddress().toLowerCase(),
		);
		expect(stakedNFTs[0][2].slice(2).toLowerCase()).to.be.equal(
			StkNFTC_TokenId.toSolidityAddress().toLowerCase(),
		);
		expect(stakedNFTs[0][3].slice(2).toLowerCase()).to.be.equal(
			StkNFTD_TokenId.toSolidityAddress().toLowerCase(),
		);
		expect(stakedNFTs[0][4].slice(2).toLowerCase()).to.be.equal(
			StkNFTE_TokenId.toSolidityAddress().toLowerCase(),
		);
		expect(stakedNFTs[1].length).to.be.equal(5);
		expect(stakedNFTs[1][0].length).to.be.equal(2);
		expect(stakedNFTs[1][0][0]).to.be.equal(1);
		expect(stakedNFTs[1][0][1]).to.be.equal(2);
		expect(stakedNFTs[1][1].length).to.be.equal(2);
		expect(stakedNFTs[1][1][0]).to.be.equal(3);
		expect(stakedNFTs[1][1][1]).to.be.equal(4);
		expect(stakedNFTs[1][2].length).to.be.equal(1);
		expect(stakedNFTs[1][2][0]).to.be.equal(5);
		expect(stakedNFTs[1][3].length).to.be.equal(1);
		expect(stakedNFTs[1][3][0]).to.be.equal(1);
		expect(stakedNFTs[1][4].length).to.be.equal(1);
		expect(stakedNFTs[1][4][0]).to.be.equal(1);

		// totalItemsStaked
		const totalItemsStaked = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'totalItemsStaked',
		);

		expect(Number(totalItemsStaked[0])).to.be.equal(17);

		// getBaseRewardRate
		baseRewardRate = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'getBaseRewardRate',
			[operatorId.toSolidityAddress()],
		);

		expect(Number(baseRewardRate[0])).to.be.equal(oldBaseRewardRate + 45);

		// getActiveBoostRate
		const activeBoostRate = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'getActiveBoostRate',
			[operatorId.toSolidityAddress()],
		);

		expect(Number(activeBoostRate[0])).to.be.equal(20);

		const timePassedInSeconds = Math.floor(
			(Date.now() - stakedTimestamp) / 1000,
		);

		const [expectedRewards, earnRate] = calcRewards(
			Number(baseRewardRate[0]),
			Number(activeBoostRate[0]),
			timePassedInSeconds,
			LAZY_STAKING_DISTRIBUTION_PERIOD,
			LAZY_STAKING_PERIOD_FOR_BONUS,
			LAZY_STAKING_MAX_BONUS_PERIODS,
			LAZY_STAKING_HODL_BONUS,
		);
		console.log('Time passed in seconds:', timePassedInSeconds, 'expected:', expectedRewards, '@', earnRate);
		// calculateRewards
		const calculateRewards = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'calculateRewards',
			[operatorId.toSolidityAddress()],
		);
		console.log('Lazy Earnt:', Number(calculateRewards[0]), 'As of', Number(calculateRewards[2]));
		console.log('Pre-additional stake rewards:', preAdditionalStakeRewards, 'Post-additional stake rewards:', Number(calculateRewards[0]));
		console.log('Pre-additional stake reward rate:', preAdditionalStakeRewardRate, 'Post-additional stake reward rate:', Number(calculateRewards[1]));
		expect(Number(calculateRewards[0])).to.be.greaterThanOrEqual(expectedRewards + preAdditionalStakeRewards);
	});
});

describe('Halvening', () => {
	it('Operator should execute halvening (epoch 1) and test reward rates and claim', async () => {
		// halvening
		client.setOperator(operatorId, operatorKey);

		// check currentEpoch == 0
		const currentEpoch = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'currentEpoch',
		);

		expect(Number(currentEpoch[0])).to.be.equal(0);

		// move 50mm $LAZY from the LST to Operator (to allow halving to occur)
		const transferTx = await sendLazy(operatorId, 50_000_000 * 10 ** LAZY_DECIMAL);
		expect(transferTx).to.be.equal('SUCCESS');

		// get the base reward rate
		const baseRewardRate = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'getBaseRewardRate',
			[operatorId.toSolidityAddress()],
		);

		// get boost rate
		const activeBoostRate = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'getActiveBoostRate',
			[operatorId.toSolidityAddress()],
		);

		const preHalveningBaseRewardRate = Number(baseRewardRate[0]);
		const preHalveningActiveBoostRate = Number(activeBoostRate[0]);

		// calculateRewards [will not know of the halving as this is a read-only call]
		const encodedCommand = lazyNFTStakingIface.encodeFunctionData(
			'calculateRewards',
			[operatorId.toSolidityAddress()],
		);

		const result = await readOnlyEVMFromMirrorNode(
			env,
			lnsContractId,
			encodedCommand,
			operatorId,
			false,
		);

		const rewards = lazyNFTStakingIface.decodeFunctionResult(
			'calculateRewards',
			result,
		);

		console.log('Pre-halvening: Lazy Earnt:', Number(rewards[0]), 'at rate:', Number(rewards[1]), 'As of', Number(rewards[2]), 'Last claim:', Number(rewards[3]));

		// uint256 rewards, uint256 rewardRate, uint256 asOfTimestamp, unit256 userLastClaim
		const preHalveningRewards = Number(rewards[0]);
		const preHalveningRewardRate = Number(rewards[1]);

		// trigger halvening
		const halveningTx = await contractExecuteFunction(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			300_000,
			'checkHalvening',
		);

		const halveningTimestamp = Date.now();

		if (halveningTx[0]?.status?.toString() != 'SUCCESS') {
			console.log('ERROR executing halvening:', halveningTx);
			fail();
		}

		console.log('Halvening - Tx id:', halveningTx[2]?.transactionId?.toString());

		// check currentEpoch == 1
		const currentEpochPostHalvening = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'currentEpoch',
		);

		expect(Number(currentEpochPostHalvening[0])).to.be.equal(1);

		// sleep for 3 seconds
		await sleep(3000);

		// estimate the rewards that will have been earnt
		const timePassedInSeconds = Math.floor(
			(Date.now() - halveningTimestamp) / 1000,
		);


		// using the live rate as bonuses may well have kicked in
		const [expectedRewards, earnRate] = calcRewards(
			Number(rewards[1]),
			Number(preHalveningActiveBoostRate),
			timePassedInSeconds,
			LAZY_STAKING_DISTRIBUTION_PERIOD,
			LAZY_STAKING_PERIOD_FOR_BONUS,
			LAZY_STAKING_MAX_BONUS_PERIODS,
			LAZY_STAKING_HODL_BONUS,
			currentEpochPostHalvening[0],
		);

		console.log('Time passed in seconds *POST HALVENING*:', timePassedInSeconds, 'expected:', expectedRewards, '@', earnRate);

		// calculateRewards and check the increment is in line with the expected post halvening result

		const calculateRewards = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'calculateRewards',
			[operatorId.toSolidityAddress()],
		);

		console.log('POST-HALVENING Lazy Earnt:', Number(calculateRewards[0]), 'at rate:', Number(calculateRewards[1]), 'As of', Number(calculateRewards[2]), 'Last claim:', Number(calculateRewards[3]));
		console.log('Pre-halvening reward rate:', preHalveningRewardRate, 'Post-halvening reward rate:', Number(calculateRewards[1]));
		console.log('Pre-halvening base reward rate:', preHalveningBaseRewardRate, 'Post-halvening base reward rate:', Number(baseRewardRate[0]));

		// calculate time from pre calculateRewards call until halvenignTimestamp
		const extraPeriodsInLastEpoch = (halveningTimestamp / 1000 - Number(rewards[2])) / LAZY_STAKING_DISTRIBUTION_PERIOD;
		const periodsPostEpoch = (Number(calculateRewards[2]) - halveningTimestamp / 1000) / LAZY_STAKING_DISTRIBUTION_PERIOD;
		expect(Number(calculateRewards[0])).to.be.greaterThanOrEqual(preHalveningRewards + expectedRewards);
		console.log('final', preHalveningRewards, extraPeriodsInLastEpoch, Number(rewards[1]), periodsPostEpoch, Number(calculateRewards[1]) * 1.5);
		expect(Number(calculateRewards[0])).to.be.lessThan(preHalveningRewards + extraPeriodsInLastEpoch * Number(rewards[1]) + Math.abs(periodsPostEpoch) * Number(calculateRewards[1]) * 1.15);
	});

	it('Operator should execute halvening (epoch 2) and test reward rates and claim Alice', async () => {
		// halvening
		client.setOperator(operatorId, operatorKey);

		// check currentEpoch == 1
		const currentEpoch = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'currentEpoch',
		);

		expect(Number(currentEpoch[0])).to.be.equal(1);

		// set allowance for LNS to spend the nft
		client.setOperator(aliceId, alicePK);
		const approvalTx = await setNFTAllowanceAll(client, [StkNFTD_TokenId], aliceId, AccountId.fromString(lnsContractId.toString()));
		expect(approvalTx).to.be.equal('SUCCESS');

		client.setOperator(operatorId, operatorKey);

		// move 50mm $LAZY from the LST to Operator (to allow halving to occur)
		const transferTx = await sendLazy(operatorId, 50_000_000 * 10 ** LAZY_DECIMAL);
		expect(transferTx).to.be.equal('SUCCESS');

		// get the base reward rate
		const baseRewardRate = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'getBaseRewardRate',
			[aliceId.toSolidityAddress()],
		);

		// get boost rate
		const activeBoostRate = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'getActiveBoostRate',
			[aliceId.toSolidityAddress()],
		);

		const preHalveningBaseRewardRate = Number(baseRewardRate[0]);
		const preHalveningActiveBoostRate = Number(activeBoostRate[0]);

		// calculateRewards [will not know of the halving as this is a read-only call]
		const encodedCommand = lazyNFTStakingIface.encodeFunctionData(
			'calculateRewards',
			[aliceId.toSolidityAddress()],
		);

		let result = await readOnlyEVMFromMirrorNode(
			env,
			lnsContractId,
			encodedCommand,
			aliceId,
			false,
		);

		const rewards = lazyNFTStakingIface.decodeFunctionResult(
			'calculateRewards',
			result,
		);

		console.log('Pre-halvening: Lazy Earnt:', Number(rewards[0]), 'at rate:', Number(rewards[1]), 'As of', Number(rewards[2]), 'Last claim:', Number(rewards[3]));

		// uint256 rewards, uint256 rewardRate, uint256 asOfTimestamp, unit256 userLastClaim
		const preHalveningRewards = Number(rewards[0]);
		const preHalveningRewardRate = Number(rewards[1]);
		const lastAsOfTimestamp = Number(rewards[2]);

		// switch to Alice for staking
		client.setOperator(aliceId, alicePK);

		// trigger halvening by staking an additional NFT
		const stakes = [];

		stakes.push(new Stake(StkNFTD_TokenId.toSolidityAddress(), [11], [10]));

		const boostRate = preHalveningActiveBoostRate + 2;

		const rewardProof = await generateStakingRewardProof(
			aliceId,
			boostRate,
			signingWalletPK,
			stakes,
		);

		const stakedTimestamp = Date.now();

		result = await contractExecuteFunction(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			1_500_000,
			'stake',
			[stakes, rewardProof],
		);

		if (result[0]?.status?.toString() != 'SUCCESS') {
			console.log('ERROR staking NFTs:', result);
			fail();
		}

		console.log('Staking - Tx id:', result[2]?.transactionId?.toString());

		// check currentEpoch == 2
		const currentEpochPostHalvening = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'currentEpoch',
		);

		expect(Number(currentEpochPostHalvening[0])).to.be.equal(2);

		// sleep for 3 seconds
		await sleep(3000);

		// estimate the rewards that will have been earnt
		const timePassedInSeconds = Math.floor(
			(Date.now() - stakedTimestamp) / 1000,
		);

		// using the live rate as bonuses may well have kicked in
		const [expectedRewards, earnRate] = calcRewards(
			Number(rewards[1]) + 10,
			Number(boostRate),
			timePassedInSeconds,
			LAZY_STAKING_DISTRIBUTION_PERIOD,
			LAZY_STAKING_PERIOD_FOR_BONUS,
			LAZY_STAKING_MAX_BONUS_PERIODS,
			LAZY_STAKING_HODL_BONUS,
			currentEpochPostHalvening[0],
		);

		console.log('Time passed in seconds *3rd EPOCH HALVENING*:', timePassedInSeconds, 'expected:', expectedRewards, '@', earnRate);

		// calculateRewards and check the increment is in line with the expected post halvening result

		const calculateRewards = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'calculateRewards',
			[aliceId.toSolidityAddress()],
		);

		const postHalveningBaseRewardRate = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'getBaseRewardRate',
			[aliceId.toSolidityAddress()],
		);

		console.log('POST HALVENING Lazy Earnt:', Number(calculateRewards[0]), 'at rate:', Number(calculateRewards[1]), 'As of', Number(calculateRewards[2]), 'Last claim:', Number(calculateRewards[3]));
		console.log('Pre-halvening reward rate:', preHalveningRewardRate, 'Post-halvening reward rate:', Number(calculateRewards[1]));
		console.log('Pre-halvening base reward rate:', preHalveningBaseRewardRate, 'Post-halvening base reward rate:', Number(postHalveningBaseRewardRate[0]));

		// calculate time from pre calculateRewards call until halvenignTimestamp
		const extraPeriodsInLastEpoch = Math.ceil((stakedTimestamp / 1000 - lastAsOfTimestamp) / LAZY_STAKING_DISTRIBUTION_PERIOD);
		const periodsPostEpoch = Math.ceil((Number(calculateRewards[2]) - stakedTimestamp / 1000) / LAZY_STAKING_DISTRIBUTION_PERIOD);
		expect(Number(calculateRewards[0])).to.be.greaterThanOrEqual(preHalveningRewards + expectedRewards);
		console.log('final', preHalveningRewards, extraPeriodsInLastEpoch, Number(rewards[1]) * 1.5, periodsPostEpoch, Number(calculateRewards[1]) * 1.5);
		expect(Number(calculateRewards[0])).to.be.lessThan(preHalveningRewards + extraPeriodsInLastEpoch * Number(rewards[1]) * 1.5 + Math.abs(periodsPostEpoch + 1) * Number(calculateRewards[1]) * 1.5);
	});

	it('Operator should execute halvening (epoch 4) and test reward rates and claim Bob', async () => {
		// halvening
		client.setOperator(operatorId, operatorKey);

		// check currentEpoch == 1
		const currentEpoch = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'currentEpoch',
		);

		expect(Number(currentEpoch[0])).to.be.equal(2);

		// move 50mm $LAZY from the LST to Operator (to allow halving to occur)
		const transferTx = await sendLazy(operatorId, 100_000_000 * 10 ** LAZY_DECIMAL);
		expect(transferTx).to.be.equal('SUCCESS');

		// get the base reward rate
		const baseRewardRate = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'getBaseRewardRate',
			[bobId.toSolidityAddress()],
		);

		// get boost rate
		const activeBoostRate = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'getActiveBoostRate',
			[bobId.toSolidityAddress()],
		);

		const preHalveningBaseRewardRate = Number(baseRewardRate[0]);
		const preHalveningActiveBoostRate = Number(activeBoostRate[0]);

		// calculateRewards [will not know of the halving as this is a read-only call]
		const encodedCommand = lazyNFTStakingIface.encodeFunctionData(
			'calculateRewards',
			[bobId.toSolidityAddress()],
		);

		let result = await readOnlyEVMFromMirrorNode(
			env,
			lnsContractId,
			encodedCommand,
			bobId,
			false,
		);

		const rewards = lazyNFTStakingIface.decodeFunctionResult(
			'calculateRewards',
			result,
		);

		// uint256 rewards, uint256 rewardRate, uint256 asOfTimestamp, unit256 userLastClaim

		console.log('Pre-halvening: Lazy Earnt:', Number(rewards[0]), 'at rate:', Number(rewards[1]), 'As of', Number(rewards[2]), 'Last claim:', Number(rewards[3]));

		const preHalveningRewardRate = Number(rewards[1]);

		client.setOperator(bobId, bobPK);

		// V1 - LEGACY - $LAZY to stake
		// const approvalTx = await setFTAllowance(client, lazyTokenId, bobId, AccountId.fromString(lnsContractId.toString()), 1);
		const approvalTx = await setHbarAllowance(client, bobId, AccountId.fromString(lnsContractId.toString()), 1);
		expect(approvalTx).to.be.equal('SUCCESS');

		// trigger halvening by unstaking an NFT
		const stakes = [];
		stakes.push(new Stake(StkNFTA_TokenId.toSolidityAddress(), [6], [10]));

		const boostRate = preHalveningActiveBoostRate - 2;

		const rewardProof = await generateStakingRewardProof(
			bobId,
			boostRate,
			signingWalletPK,
			stakes,
		);

		result = await contractExecuteFunction(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			1_500_000,
			'unstake',
			[stakes, rewardProof],
		);

		const unstakedTimestamp = Date.now();

		if (result[0]?.status?.toString() != 'SUCCESS') {
			console.log('ERROR unstaking NFTs:', result);
			fail();
		}

		console.log('Unstaking - Tx id:', result[2]?.transactionId?.toString());

		client.setOperator(operatorId, operatorKey);

		// get the new base reward rate
		const newBaseRewardRate = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'getBaseRewardRate',
			[bobId.toSolidityAddress()],
		);

		expect(Number(newBaseRewardRate[0])).to.be.equal(preHalveningBaseRewardRate - 10);

		// check currentEpoch == 4
		const currentEpochPostHalvening = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'currentEpoch',
		);

		expect(Number(currentEpochPostHalvening[0])).to.be.equal(4);

		// sleep for 3 seconds
		await sleep(3000);

		// estimate the rewards that will have been earnt
		const timePassedInSeconds = Math.floor(
			(Date.now() - unstakedTimestamp) / 1000,
		);

		const [expectedRewards, earnRate] = calcRewards(
			Number(newBaseRewardRate[0]),
			Number(boostRate),
			timePassedInSeconds,
			LAZY_STAKING_DISTRIBUTION_PERIOD,
			LAZY_STAKING_PERIOD_FOR_BONUS,
			LAZY_STAKING_MAX_BONUS_PERIODS,
			LAZY_STAKING_HODL_BONUS,
			currentEpochPostHalvening[0],
		);

		console.log('Time passed in seconds *4th EPOCH HALVENING*:', timePassedInSeconds, 'expected:', expectedRewards, '@', earnRate);

		// calculateRewards and check the increment is in line with the expected post halvening result

		const calculateRewards = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'calculateRewards',
			[bobId.toSolidityAddress()],
		);

		console.log('POST HALVENING Lazy Earnt:', Number(calculateRewards[0]), 'at rate:', Number(calculateRewards[1]), 'As of', Number(calculateRewards[2]), 'Last claim:', Number(calculateRewards[3]));
		console.log('Pre-halvening reward rate:', preHalveningRewardRate, 'Post-halvening reward rate:', Number(calculateRewards[1]));

		// when unstaking the rewards should be claimed so just the rewards form the period of unstaking until now
		expect(Number(calculateRewards[0])).to.be.greaterThanOrEqual(expectedRewards);
		expect(Number(calculateRewards[0])).to.be.lessThanOrEqual(expectedRewards * 4);
	});

	it('Operator sends back all $LAZY to LST', async () => {
		// transfer all $LAZY back to LST
		client.setOperator(operatorId, operatorKey);
		const transferTx = await sendFT(client, lazyTokenId, 200_000_000 * 10 ** LAZY_DECIMAL, operatorId, AccountId.fromString(lazySCT.toString()));
		expect(transferTx).to.be.equal('SUCCESS');
	});
});

describe('Unstaking', () => {
	it('Operator should (all but one) unstake NFTs, check that rewards were claimed and new earn rate', async () => {
		// unstake the NFTs
		client.setOperator(operatorId, operatorKey);

		// totalItemsStaked
		const oldTotalItemsStaked = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'totalItemsStaked',
		);

		// ensure the mirror is up to date for the $LAZY balance
		await sleep(4500);

		// get the $LAZY balance as unstake will trigger claim
		const oldOperatorLazyBalance = await checkMirrorBalance(
			env,
			operatorId,
			lazyTokenId,
		);

		// get the current claimable reward
		const encodedCommand = lazyNFTStakingIface.encodeFunctionData(
			'calculateRewards',
			[operatorId.toSolidityAddress()],
		);

		let result = await readOnlyEVMFromMirrorNode(
			env,
			lnsContractId,
			encodedCommand,
			operatorId,
			false,
		);

		const rewards = lazyNFTStakingIface.decodeFunctionResult(
			'calculateRewards',
			result,
		);

		console.log('Pre-unstaking: Lazy Earnt:', Number(rewards[0]), 'at rate:', Number(rewards[1]), 'As of', Number(rewards[2]), 'Last claim:', Number(rewards[3]));

		// uint256 rewards, uint256 rewardRate, uint256 asOfTimestamp, unit256 userLastClaim
		const preUnstakeRewards = Number(rewards[0]);

		// unstake all but serial 1 of token E
		const unstake = [];
		unstake.push(new Stake(StkNFTA_TokenId.toSolidityAddress(), [1, 2], [10, 10]));
		unstake.push(new Stake(StkNFTB_TokenId.toSolidityAddress(), [3, 4], [20, 20]));
		unstake.push(new Stake(StkNFTC_TokenId.toSolidityAddress(), [5], [1000]));
		unstake.push(new Stake(StkNFTD_TokenId.toSolidityAddress(), [1], [20]));

		// V1 - LEGACY - Used $LAZY to stake
		// set allowance for LNS to spend 0.1 $LAZY per NFT collection unstaked
		// const approvalTx = await setFTAllowance(client, lazyTokenId, operatorId, AccountId.fromString(lnsContractId.toString()), 4);
		// V2 - Use Hbar as value to stake
		const approvalTx = await setHbarAllowance(client, operatorId, AccountId.fromString(lnsContractId.toString()), 4);
		expect(approvalTx).to.be.equal('SUCCESS');

		const boostRate = 0;

		const rewardProof = await generateStakingRewardProof(
			operatorId,
			boostRate,
			signingWalletPK,
			unstake,
		);

		result = await contractExecuteFunction(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			3_000_000,
			'unstake',
			[unstake, rewardProof],
		);

		const unstakedTimestamp = Date.now();

		if (result[0]?.status?.toString() != 'SUCCESS') {
			console.log('ERROR staking NFTs:', result);
			fail();
		}

		console.log('Unstaking - Tx id:', result[2]?.transactionId?.toString());

		// totalItemsStaked
		const totalItemsStaked = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'totalItemsStaked',
		);

		expect(Number(totalItemsStaked[0])).to.be.equal(oldTotalItemsStaked - 6);

		// getBaseRewardRate
		const baseRewardRate = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'getBaseRewardRate',
			[operatorId.toSolidityAddress()],
		);

		expect(Number(baseRewardRate[0])).to.be.equal(25);

		// getActiveBoostRate
		const activeBoostRate = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'getActiveBoostRate',
			[operatorId.toSolidityAddress()],
		);

		expect(Number(activeBoostRate[0])).to.be.equal(0);

		// get the current epoch
		const currentEpoch = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'currentEpoch',
		);

		expect(Number(currentEpoch[0])).to.be.equal(4);

		// put a speed bump in
		await sleep(3000);

		const timePassedInSeconds = Math.floor(
			(Date.now() - unstakedTimestamp) / 1000,
		);

		const [expectedRewards, earnRate] = calcRewards(
			Number(baseRewardRate[0]),
			Number(activeBoostRate[0]),
			timePassedInSeconds,
			LAZY_STAKING_DISTRIBUTION_PERIOD,
			LAZY_STAKING_PERIOD_FOR_BONUS,
			LAZY_STAKING_MAX_BONUS_PERIODS,
			LAZY_STAKING_HODL_BONUS,
			Number(currentEpoch[0]),
		);
		console.log('Time passed in seconds:', timePassedInSeconds, 'expected:', expectedRewards, '@', earnRate);
		// calculateRewards
		const calculateRewards = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'calculateRewards',
			[operatorId.toSolidityAddress()],
		);
		console.log('Lazy Earnt:', Number(calculateRewards[0]), 'As of', Number(calculateRewards[2]));
		expect(Number(calculateRewards[0])).to.be.greaterThanOrEqual(Math.floor(expectedRewards));

		// ensure the mirror is up to date for the $LAZY balance
		await sleep(5500);

		// get the operator's balance of lazy tokens from mirror node
		const operatorLazyBalance = await checkMirrorBalance(
			env,
			operatorId,
			lazyTokenId,
		);

		// check the operator's balance has increased by the expected rewards
		expect(operatorLazyBalance).to.be.greaterThanOrEqual(preUnstakeRewards * ((100 - LAZY_BURN_PERCENT) / 100) + oldOperatorLazyBalance);

	});

	it('Bob should fully unstake NFTs, check that rewards were claimed and new earn rate', async () => {
		// unstake the NFTs
		client.setOperator(bobId, bobPK);

		// get the $LAZY balance
		const oldBobLazyBalance = await checkMirrorBalance(
			env,
			bobId,
			lazyTokenId,
		);

		console.log('Bob (pre unstake) $LAZY balance:', oldBobLazyBalance);

		// get the current claimable reward
		const encodedCommand = lazyNFTStakingIface.encodeFunctionData(
			'calculateRewards',
			[bobId.toSolidityAddress()],
		);

		let result = await readOnlyEVMFromMirrorNode(
			env,
			lnsContractId,
			encodedCommand,
			bobId,
			false,
		);

		const rewards = lazyNFTStakingIface.decodeFunctionResult(
			'calculateRewards',
			result,
		);

		console.log('Bob (pre unstake) rewards:', rewards);

		// uint256 rewards, uint256 rewardRate, uint256 asOfTimestamp, unit256 userLastClaim
		const preUnstakeRewards = Number(rewards[0]);

		// unstake all NFTs
		const unstake = [];
		unstake.push(new Stake(StkNFTB_TokenId.toSolidityAddress(), [6], [20]));
		unstake.push(new Stake(StkNFTC_TokenId.toSolidityAddress(), [6, 7, 8], [1000, 500, 250]));

		// V1 - LEGACY - Used $LAZY to stake
		// const approvalTx = await setFTAllowance(client, lazyTokenId, bobId, AccountId.fromString(lnsContractId.toString()), 2);
		// V2 - Use Hbar as value to stake
		const approvalTx = await setHbarAllowance(client, bobId, AccountId.fromString(lnsContractId.toString()), 2);
		expect(approvalTx).to.be.equal('SUCCESS');

		const boostRate = 0;

		const rewardProof = await generateStakingRewardProof(
			bobId,
			boostRate,
			signingWalletPK,
			unstake,
		);

		result = await contractExecuteFunction(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			3_000_000,
			'unstake',
			[unstake, rewardProof],
		);

		if (result[0]?.status?.toString() != 'SUCCESS') {
			console.log('ERROR staking NFTs:', result);
			fail();
		}

		// get the new base reward rate
		const newBaseRewardRate = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'getBaseRewardRate',
			[bobId.toSolidityAddress()],
		);

		expect(Number(newBaseRewardRate[0])).to.be.equal(0);

		// getActiveBoostRate
		const activeBoostRate = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'getActiveBoostRate',
			[bobId.toSolidityAddress()],
		);

		expect(Number(activeBoostRate[0])).to.be.equal(0);

		// put a speed bump in
		await sleep(5000);

		// check $LAZY balance increased by *AT LEAST* the expected rewards
		const bobLazyBalance = await checkMirrorBalance(
			env,
			bobId,
			lazyTokenId,
		);

		console.log('Bob Lazy balance:', bobLazyBalance, 'Old:', oldBobLazyBalance, 'Rewards:', preUnstakeRewards);

		// check the operator's balance has increased by the expected rewards
		expect(bobLazyBalance).to.be.greaterThanOrEqual(preUnstakeRewards * (100 - LAZY_BURN_PERCENT) / 100 + oldBobLazyBalance);
	});

	it('Alice should fully unstake NFTs, check that rewards were claimed and new earn rate', async () => {
		// unstake the NFTs
		client.setOperator(aliceId, alicePK);

		// get the $LAZY balance
		const oldAliceLazyBalance = await checkMirrorBalance(
			env,
			aliceId,
			lazyTokenId,
		);

		// get the current claimable reward
		const encodedCommand = lazyNFTStakingIface.encodeFunctionData(
			'calculateRewards',
			[aliceId.toSolidityAddress()],
		);

		let result = await readOnlyEVMFromMirrorNode(
			env,
			lnsContractId,
			encodedCommand,
			aliceId,
			false,
		);

		const rewards = lazyNFTStakingIface.decodeFunctionResult(
			'calculateRewards',
			result,
		);

		// uint256 rewards, uint256 rewardRate, uint256 asOfTimestamp, unit256 userLastClaim
		console.log('Alice rewards:', rewards);

		const preUnstakeRewards = Number(rewards[0]);

		// unstake all NFTs

		const unstake = [];
		unstake.push(new Stake(StkNFTA_TokenId.toSolidityAddress(), [11], [10]));
		unstake.push(new Stake(StkNFTB_TokenId.toSolidityAddress(), [11, 12, 13], [15, 15, 5]));
		unstake.push(new Stake(StkNFTC_TokenId.toSolidityAddress(), [11], [350]));
		unstake.push(new Stake(StkNFTD_TokenId.toSolidityAddress(), [11], [10]));

		// V1 - LEGACY - Used $LAZY to stake
		// const approvalTx = await setFTAllowance(client, lazyTokenId, aliceId, AccountId.fromString(lnsContractId.toString()), 4);
		// V2 - Use Hbar as value to stake
		const approvalTx = await setHbarAllowance(client, aliceId, AccountId.fromString(lnsContractId.toString()), 4);
		expect(approvalTx).to.be.equal('SUCCESS');

		const boostRate = 0;

		const rewardProof = await generateStakingRewardProof(
			aliceId,
			boostRate,
			signingWalletPK,
			unstake,
		);

		result = await contractExecuteFunction(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			3_000_000,
			'unstake',
			[unstake, rewardProof],
		);

		if (result[0]?.status?.toString() != 'SUCCESS') {
			console.log('ERROR staking NFTs:', result);
			fail();
		}

		// get the new base reward rate
		const newBaseRewardRate = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'getBaseRewardRate',
			[aliceId.toSolidityAddress()],
		);

		expect(Number(newBaseRewardRate[0])).to.be.equal(0);

		// getActiveBoostRate
		const activeBoostRate = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'getActiveBoostRate',
			[aliceId.toSolidityAddress()],
		);

		expect(Number(activeBoostRate[0])).to.be.equal(0);

		// put a speed bump in to ensure mirror node has updated
		await sleep(6000);

		// check $LAZY balance increased by *AT LEAST* the expected rewards
		const aliceLazyBalance = await checkMirrorBalance(
			env,
			aliceId,
			lazyTokenId,
		);

		console.log('Alice Lazy balance:', aliceLazyBalance, 'Old:', oldAliceLazyBalance, 'Rewards:', preUnstakeRewards);

		// check the operator's balance has increased by the expected rewards
		expect(aliceLazyBalance).to.be.greaterThanOrEqual(preUnstakeRewards * ((100 - LAZY_BURN_PERCENT) / 100) + oldAliceLazyBalance);
	});
});

describe('Edge Case Staking', () => {
	it('Operator cannot execute unstakeUnauthorizedNFT on the last NFT staked', async () => {
		// unstakeUnauthorizedNFT for token E serial 1 expecting REVERT failure
		client.setOperator(operatorId, operatorKey);

		const result = await contractExecuteFunction(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			2_000_000,
			'unstakeUnauthorizedNFT',
			[StkNFTE_TokenId.toSolidityAddress(), [1]],
		);

		if (result[0]?.status?.toString() != 'REVERT: NFTs staked by user') {
			console.log('ERROR executing unstakeUnauthorizedNFT - expected failure but got:', result);
			fail();
		}
	});

	it('Alice cannot execute unstakeAnyNFT on the last NFT staked by Operator', async () => {
		// unstakeAnyNFT for token E serial 1 expecting 'REVERT: NFT not staked' failure
		client.setOperator(aliceId, alicePK);

		const result = await contractExecuteFunction(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			2_000_000,
			'unstakeAnyNFT',
			[StkNFTE_TokenId.toSolidityAddress(), [1]],
		);

		if (result[0]?.status?.toString() != 'REVERT: NFT not staked') {
			console.log('ERROR executing unstakeAnyNFT - expected failure but got:', result);
			fail();
		}
	});

	it('Operator should remove last NFT *BRUTE FORCE* and ensure contract state remains good', async () => {
		// unstakeAnyNFT for token E serial 1 expecting success
		client.setOperator(operatorId, operatorKey);

		// check totalItemsStaked
		const oldTotalItemsStaked = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'totalItemsStaked',
		);

		// get the $LAZY balance for operator
		const oldOperatorLazyBalance = await checkMirrorBalance(
			env,
			operatorId,
			lazyTokenId,
		);

		console.log('Pre - Operator Lazy balance:', oldOperatorLazyBalance);

		// get the current claimable reward
		const encodedCommand = lazyNFTStakingIface.encodeFunctionData(
			'calculateRewards',
			[operatorId.toSolidityAddress()],
		);

		let result = await readOnlyEVMFromMirrorNode(
			env,
			lnsContractId,
			encodedCommand,
			operatorId,
			false,
		);

		const rewards = lazyNFTStakingIface.decodeFunctionResult(
			'calculateRewards',
			result,
		);

		// uint256 rewards, uint256 rewardRate, uint256 asOfTimestamp, unit256 userLastClaim
		const preUnstakeRewards = Number(rewards[0]);

		console.log('Pre-unstake rewards:', preUnstakeRewards, 'reward rate', Number(rewards[1]), 'As of', Number(rewards[2]), 'Last claim:', Number(rewards[3]));

		expect(preUnstakeRewards).to.be.greaterThan(0);

		// V1 - LEGACY - Used $LAZY to stake
		// set FT allowance for LNS to spend 0.1 $LAZY
		// const approvalTx = await setFTAllowance(client, lazyTokenId, operatorId, AccountId.fromString(lnsContractId.toString()), 1);
		// V2 - Use Hbar as value to stake
		const approvalTx = await setHbarAllowance(client, operatorId, AccountId.fromString(lnsContractId.toString()), 1);
		expect(approvalTx).to.be.equal('SUCCESS');

		result = await contractExecuteFunction(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			2_000_000,
			'unstakeAnyNFT',
			[StkNFTE_TokenId.toSolidityAddress(), [1]],
		);

		if (result[0]?.status?.toString() != 'SUCCESS') {
			console.log('ERROR executing unstakeAnyNFT - expected success but got:', result);
			fail();
		}

		// check totalItemsStaked
		const totalItemsStaked = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'totalItemsStaked',
		);

		expect(Number(totalItemsStaked[0])).to.be.equal(oldTotalItemsStaked - 1);

		// get the new base reward rate
		const newBaseRewardRate = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'getBaseRewardRate',
			[operatorId.toSolidityAddress()],
		);

		expect(Number(newBaseRewardRate[0])).to.be.equal(0);

		// getActiveBoostRate
		const activeBoostRate = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'getActiveBoostRate',
			[operatorId.toSolidityAddress()],
		);

		expect(Number(activeBoostRate[0])).to.be.equal(0);

		// put a speed bump in
		await sleep(5000);

		// check $LAZY balance increased by *AT LEAST* the expected rewards
		const operatorLazyBalance = await checkMirrorBalance(
			env,
			operatorId,
			lazyTokenId,
		);

		// check the operator's balance has increased by the expected rewards
		expect(operatorLazyBalance).to.be.greaterThanOrEqual(preUnstakeRewards * ((100 - LAZY_BURN_PERCENT) / 100) + oldOperatorLazyBalance);
	});

	it('Alice sends an NFT using native HTS, then operator tries to pull it back', async () => {
		// unstakeUnauthorizedNFT
		client.setOperator(aliceId, alicePK);

		// check totalItemsStaked
		let itemsStaked = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'totalItemsStaked',
		);

		const oldTotalItemsStaked = Number(itemsStaked[0]);

		// send an NFT to the LNS contract using HTS native call
		let result = await sendNFT(
			client,
			aliceId,
			AccountId.fromString(lnsContractId.toString()),
			StkNFTE_TokenId,
			[15],
		);
		expect(result).to.be.equal('SUCCESS');

		// check totalItemsStaked
		itemsStaked = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'totalItemsStaked',
		);

		expect(Number(itemsStaked[0])).to.be.equal(oldTotalItemsStaked);

		// try unstakeUnauthorizedNFT as Alice expecting failure given onlyOwner modifier
		result = await contractExecuteFunction(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			600_000,
			'unstakeUnauthorizedNFT',
			[StkNFTE_TokenId.toSolidityAddress(), [15]],
		);

		if (result[0]?.status?.toString() != 'REVERT: Ownable: caller is not the owner') {
			console.log('ERROR executing unstakeUnauthorizedNFT - expected failure but got:', result);
			fail();
		}

		// now try to pull the NFT back using unstakeAnyNFT expecting success
		client.setOperator(operatorId, operatorKey);

		// V1 - LEGACY - Used $LAZY to stake
		// set FT allowance for LNS to spend 0.1 $LAZY
		// const approvalTx = await setFTAllowance(client, lazyTokenId, operatorId, AccountId.fromString(lnsContractId.toString()), 1);
		// V2 - Use Hbar as value to stake
		const approvalTx = await setHbarAllowance(client, operatorId, AccountId.fromString(lnsContractId.toString()), 1);
		expect(approvalTx).to.be.equal('SUCCESS');

		result = await contractExecuteFunction(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			600_000,
			'unstakeUnauthorizedNFT',
			[StkNFTE_TokenId.toSolidityAddress(), [15]],
		);

		if (result[0]?.status?.toString() != 'SUCCESS') {
			console.log('ERROR executing unstakeAnyNFT - expected success but got:', result);
			fail();
		}

		console.log('UnstakeAnyNFT - Tx id:', result[2]?.transactionId?.toString());

		// check totalItemsStaked
		itemsStaked = await contractExecuteQuery(
			lnsContractId,
			lazyNFTStakingIface,
			client,
			null,
			'totalItemsStaked',
		);

		expect(Number(itemsStaked[0])).to.be.equal(oldTotalItemsStaked);
	});
});

describe('Clean-up', () => {
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

			if (result[0]?.status.toString() !== 'SUCCESS') {console.log('Failed to remove LGS contract user:', result);}
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

			if (result[0]?.status.toString() !== 'SUCCESS') {console.log('Failed to remove LGS authorizer:', result);}
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

			if (result[0]?.status.toString() !== 'SUCCESS') {console.log('Failed to remove LGS admin:', result);}
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
			if (allowance.token_id == lazyTokenId.toString() && allowance.amount > 0) {outstandingAllowances.push(allowance.spender);}
		}

		// if the contract was created reset any $LAZY allowance for the operator
		if (
			lnsContractId &&
			outstandingAllowances.includes(lnsContractId.toString())
		) {
			operatorFtAllowances.push({
				tokenId: lazyTokenId,
				owner: operatorId,
				spender: AccountId.fromString(lnsContractId.toString()),
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

function calcRewards(
	baseRewardRate,
	activeBoostRate,
	timePassedInSeconds,
	distributionPeriod,
	periodsForBoost,
	maxBoosts,
	boostPercent,
	currentEpoch = 0,
) {
	const periodsPassed = Math.floor(Number(timePassedInSeconds) / Number(distributionPeriod));
	const claimBonus =
		Math.min(Math.floor(Number(periodsPassed) / Number(periodsForBoost)), Number(maxBoosts)) *
		Number(boostPercent);

	const earnRate = Math.floor(
		(Number(baseRewardRate) * (100 + Number(activeBoostRate)) * (100 + claimBonus)) / 10000,
	) / 2 ** Number(currentEpoch);

	return [periodsPassed * earnRate, earnRate];
}
