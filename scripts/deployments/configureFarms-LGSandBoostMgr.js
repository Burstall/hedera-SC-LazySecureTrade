const {
	Client,
	AccountId,
	PrivateKey,
	ContractId,
} = require('@hashgraph/sdk');
const fs = require('fs');
const { ethers } = require('ethers');
const readlineSync = require('readline-sync');
const { contractExecuteFunction } = require('../../utils/solidityHelpers');
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

const boostManagerName = 'BoostManager';
const lazyGasStationName = 'LazyGasStation';
const factoryName = 'MissionFactory';

const env = process.env.ENVIRONMENT ?? null;

let factoryContractId, boostManagerId;
let client;
let lazyGasStationId;
let boostManagerIface, lazyGasStationIface;

try {
	factoryContractId = ContractId.fromString(process.env.MISSION_FACTORY_CONTRACT_ID);
	boostManagerId = ContractId.fromString(process.env.BOOST_MANAGER_CONTRACT_ID);
	lazyGasStationId = ContractId.fromString(process.env.LAZY_GAS_STATION_CONTRACT_ID);
}
catch (err) {
	console.log('ERROR: Must specify MISSION_FACTORY_CONTRACT_ID, BOOST_MANAGER_CONTRACT_ID, and LAZY_GAS_STATION_CONTRACT_ID in the .env file');
}

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

	console.log('\n-Using Factory Contract:', factoryContractId.toString());
	console.log('-Using Boost Manager Contract:', boostManagerId.toString());
	console.log('-Using Lazy Gas Station Contract:', lazyGasStationId.toString());

	const lazyGasStationJSON = JSON.parse(
		fs.readFileSync(
			`./artifacts/contracts/${lazyGasStationName}.sol/${lazyGasStationName}.json`,
		),
	);

	lazyGasStationIface = new ethers.Interface(lazyGasStationJSON.abi);

	const boostManagerJson = JSON.parse(
		fs.readFileSync(
			`./artifacts/contracts/${boostManagerName}.sol/${boostManagerName}.json`,
		),
	);

	boostManagerIface = new ethers.Interface(boostManagerJson.abi);

	const missionFactoryJSON = JSON.parse(
		fs.readFileSync(
			`./artifacts/contracts/${factoryName}.sol/${factoryName}.json`,
		),
	);

	const missionFactoryIface = new ethers.Interface(missionFactoryJSON.abi);

	const proceed = readlineSync.keyInYNStrict('Do you want to update the Boost Manager & Gas Station for this contract?');

	if (!proceed) {
		console.log('Exiting...');
		return;
	}

	const updateFactory = readlineSync.keyInYNStrict('Do you need to update the Factory as well (i.e. this is an upgrade)?');

	if (updateFactory) {
		// update the Boost Manager with the mission factory contract
		const rslt = await contractExecuteFunction(
			factoryContractId,
			missionFactoryIface,
			client,
			null,
			'updateBoostManager',
			[boostManagerId.toSolidityAddress()],
		);

		if (rslt[0]?.status?.toString() != 'SUCCESS') {
			console.log('Missioon Factory Update Failed:', rslt);
			return;
		}

		console.log('Boost Manager updated in Mission Factory:', rslt[2].transactionId.toString());
	}

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

main()
	.then(() => process.exit(0))
	.catch(error => {
		console.error(error);
		process.exit(1);
	});
