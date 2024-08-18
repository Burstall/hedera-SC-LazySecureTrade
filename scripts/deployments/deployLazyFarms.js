const {
	Client,
	AccountId,
	PrivateKey,
	ContractId,
	TokenId,
	ContractFunctionParameters,
} = require('@hashgraph/sdk');
const fs = require('fs');
const { ethers } = require('ethers');
const readlineSync = require('readline-sync');
const { contractDeployFunction, contractExecuteFunction } = require('../../utils/solidityHelpers');
// const { hethers } = require('@hashgraph/hethers');
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
const contractName = 'MissionFactory';
const lazyContractCreator = 'LAZYTokenCreator';
const boostManagerName = 'BoostManager';
const lazyGasStationName = 'LazyGasStation';
const prngName = 'PrngSystemContract';
const missionTemplateName = 'Mission';
const lazyDelegateRegistryName = 'LazyDelegateRegistry';

const env = process.env.ENVIRONMENT ?? null;
const LAZY_BURN_PERCENT = process.env.LAZY_BURN_PERCENT ?? 25;
const LAZY_DECIMAL = process.env.LAZY_DECIMALS ?? 1;

let factoryContractId, boostManagerId, prngId, missionTemplateId, ldrId;
let lazyTokenId;
let client;
let lazySCT;
let lazyGasStationId;
let lazyIface, boostManagerIface, lazyGasStationIface;

const main = async () => {
	// configure the client object
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
	}
	else {
		console.log(
			'ERROR: Must specify either MAIN or TEST or LOCAL as environment in .env file',
		);
		return;
	}

	client.setOperator(operatorId, operatorKey);
	// deploy the contract
	console.log('\n-Using Operator:', operatorId.toString());

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
		console.log('LAZY_SCT_CONTRACT_ID ->', process.env.LAZY_SCT_CONTRACT_ID);
		console.log('LAZY_TOKEN_ID ->', process.env.LAZY_TOKEN_ID);
		const proceed = readlineSync.keyInYNStrict('No LAZY SCT found, do you want to deploy it and mint $LAZY?');

		if (!proceed) {
			console.log('Aborting');
			return;
		}

		const lazyJson = JSON.parse(
			fs.readFileSync(
				`./artifacts/contracts/legacy/${lazyContractCreator}.sol/${lazyContractCreator}.json`,
			),
		);

		const lazyContractBytecode = lazyJson.bytecode;
		lazyIface = new ethers.Interface(lazyJson.abi);

		console.log(
			'\n- Deploying contract...',
			lazyContractCreator,
			'\n\tgas@',
			800_000,
		);

		[lazySCT] = await contractDeployFunction(client, lazyContractBytecode);

		console.log(
			`Lazy Token Creator contract created with ID: ${lazySCT} / ${lazySCT.toSolidityAddress()}`,
		);

		// mint the $LAZY FT
		await mintLazy(
			'Test_Lazy',
			'TLazy',
			'Test Lazy FT',
			2_500_000_000,
			LAZY_DECIMAL,
			2_500_000_000,
			30,
		);
		console.log('$LAZY Token minted:', lazyTokenId.toString());
	}

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
		console.log('LAZY_GAS_STATION_CONTRACT_ID ->', process.env.LAZY_GAS_STATION_CONTRACT_ID);
		const proceed = readlineSync.keyInYNStrict('No Lazy Gas Station found, do you want to deploy it?');

		if (!proceed) {
			console.log('Aborting');
			return;
		}

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
	}

	if (process.env.LAZY_DELEGATE_REGISTRY_CONTRACT_ID) {
		console.log(
			'\n-Using existing Lazy Delegate Registry:',
			process.env.LAZY_DELEGATE_REGISTRY_CONTRACT_ID,
		);
		ldrId = ContractId.fromString(
			process.env.LAZY_DELEGATE_REGISTRY_CONTRACT_ID,
		);
	}
	else {
		console.log('LAZY_DELEGATE_REGISTRY_CONTRACT_ID ->', process.env.LAZY_DELEGATE_REGISTRY_CONTRACT_ID);
		const proceed = readlineSync.keyInYNStrict('No Lazy Delegate Registry found, do you want to deploy it?');

		if (!proceed) {
			console.log('Aborting');
			return;
		}

		const gasLimit = 500_000;

		const ldrJson = JSON.parse(
			fs.readFileSync(
				`./artifacts/contracts/${lazyDelegateRegistryName}.sol/${lazyDelegateRegistryName}.json`,
			),
		);

		const ldrBytecode = ldrJson.bytecode;

		console.log('\n- Deploying contract...', lazyDelegateRegistryName, '\n\tgas@', gasLimit);

		[ldrId] = await contractDeployFunction(client, ldrBytecode, gasLimit);

		console.log(
			`Lazy Delegate Registry contract created with ID: ${ldrId} / ${ldrId.toSolidityAddress()}`,
		);
	}

	const boostManagerJson = JSON.parse(
		fs.readFileSync(
			`./artifacts/contracts/${boostManagerName}.sol/${boostManagerName}.json`,
		),
	);

	boostManagerIface = new ethers.Interface(boostManagerJson.abi);

	if (process.env.BOOST_MANAGER_CONTRACT_ID) {
		console.log(
			'\n-Using existing Boost Manager:',
			process.env.BOOST_MANAGER_CONTRACT_ID,
		);
		boostManagerId = ContractId.fromString(
			process.env.BOOST_MANAGER_CONTRACT_ID,
		);
	}
	else {
		console.log('BOOST_MANAGER_CONTRACT_ID ->', process.env.BOOST_MANAGER_CONTRACT_ID);
		console.log('LAZY_BURN_PERCENT (env) ->', process.env.LAZY_BURN_PERCENT);
		console.log('LAZY_BURN_PERCENT (to use) ->', LAZY_BURN_PERCENT);

		const proceed = readlineSync.keyInYNStrict('No Boost Manager found, do you want to deploy it?');

		if (!proceed) {
			console.log('Aborting');
			return;
		}

		const gasLimit = 1_800_000;
		console.log(
			'\n- Deploying contract...',
			boostManagerName,
			'\n\tgas@',
			gasLimit,
		);

		const boostManagerBytecode = boostManagerJson.bytecode;

		const boostManagerParams = new ContractFunctionParameters()
			.addAddress(lazyTokenId.toSolidityAddress())
			.addAddress(lazyGasStationId.toSolidityAddress())
			.addAddress(ldrId.toSolidityAddress())
			.addUint256(LAZY_BURN_PERCENT);

		[boostManagerId] = await contractDeployFunction(
			client,
			boostManagerBytecode,
			gasLimit,
			boostManagerParams,
		);

		console.log(
			`Boost Manager contract created with ID: ${boostManagerId} / ${boostManagerId.toSolidityAddress()}`,
		);
	}

	if (process.env.PRNG_CONTRACT_ID) {
		console.log('\n-Using existing PRNG:', process.env.PRNG_CONTRACT_ID);
		prngId = ContractId.fromString(process.env.PRNG_CONTRACT_ID);
	}
	else {
		console.log('PRNG_CONTRACT_ID ->', process.env.PRNG_CONTRACT_ID);
		const proceed = readlineSync.keyInYNStrict('No PRNG found, do you want to deploy it?');

		if (!proceed) {
			console.log('Aborting');
			return;
		}

		const gasLimit = 800_000;
		console.log('\n- Deploying contract...', prngName, '\n\tgas@', gasLimit);
		const prngJson = JSON.parse(
			fs.readFileSync(
				`./artifacts/contracts/${prngName}.sol/${prngName}.json`,
			),
		);

		const prngBytecode = prngJson.bytecode;

		[prngId] = await contractDeployFunction(client, prngBytecode, gasLimit);

		console.log(
			`PRNG contract created with ID: ${prngId} / ${prngId.toSolidityAddress()}`,
		);
	}

	const proceed = readlineSync.keyInYNStrict('Do you want to deploy the Mission Factory (and mission template)?');

	if (!proceed) {
		console.log('Aborting');
		return;
	}

	const gasLimit = 1_500_000;

	// deploy mission template
	const missionTemplateJson = JSON.parse(
		fs.readFileSync(
			`./artifacts/contracts/${missionTemplateName}.sol/${missionTemplateName}.json`,
		),
	);

	const missionTemplateBytecode = missionTemplateJson.bytecode;

	console.log(
		'\n- Deploying contract...',
		missionTemplateName,
		'\n\tgas@',
		gasLimit,
	);

	[missionTemplateId] = await contractDeployFunction(
		client,
		missionTemplateBytecode,
		gasLimit,
	);

	console.log(
		`Mission Template contract created with ID: ${missionTemplateId} / ${missionTemplateId.toSolidityAddress()}`,
	);

	// now deploy main contract
	const missionFactoryJson = JSON.parse(
		fs.readFileSync(
			`./artifacts/contracts/${contractName}.sol/${contractName}.json`,
		),
	);

	const contractBytecode = missionFactoryJson.bytecode;

	console.log(
		'\n- Deploying contract...',
		contractName,
		'\n\tgas@',
		gasLimit,
	);

	const constructorParams = new ContractFunctionParameters()
		.addAddress(lazyTokenId.toSolidityAddress())
		.addAddress(boostManagerId.toSolidityAddress())
		.addAddress(lazyGasStationId.toSolidityAddress())
		.addAddress(missionTemplateId.toSolidityAddress())
		.addAddress(prngId.toSolidityAddress())
		.addAddress(ldrId.toSolidityAddress());

	[factoryContractId] = await contractDeployFunction(
		client,
		contractBytecode,
		gasLimit,
		constructorParams,
	);


	console.log(`Mission Factory Contract created with ID: ${factoryContractId} / ${factoryContractId.toSolidityAddress()}`);

	// update the Boost Manager with the mission factory contract
	let rslt = await contractExecuteFunction(
		boostManagerId,
		boostManagerIface,
		client,
		null,
		'setMissionFactory',
		[factoryContractId.toSolidityAddress()],
	);

	if (rslt[0]?.status?.toString() != 'SUCCESS') {
		console.log('Boost Manager failed to connect to Mission Factory:', rslt);
		return;
	}

	console.log('Boost Manager connected to Mission Factory:', rslt[2].transactionId.toString());

	// add the Mission Factory to the lazy gas station as an authorizer
	rslt = await contractExecuteFunction(
		lazyGasStationId,
		lazyGasStationIface,
		client,
		null,
		'addAuthorizer',
		[factoryContractId.toSolidityAddress()],
	);

	if (rslt[0]?.status.toString() != 'SUCCESS') {
		console.log('ERROR adding factory to LGS:', rslt);
		return;
	}

	console.log('Mission Factory added to Lazy Gas Station:', rslt[2].transactionId.toString());

	// add the Boost Manager to the lazy gas station as a contract user
	rslt = await contractExecuteFunction(
		lazyGasStationId,
		lazyGasStationIface,
		client,
		null,
		'addContractUser',
		[boostManagerId.toSolidityAddress()],
	);

	if (rslt[0]?.status.toString() != 'SUCCESS') {
		console.log('ERROR adding Boost Manager to LGS:', rslt);
		return;
	}

	console.log('Boost Manager added to Lazy Gas Station:', rslt[2].transactionId.toString());

};

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

main()
	.then(() => process.exit(0))
	.catch(error => {
		console.error(error);
		process.exit(1);
	});
