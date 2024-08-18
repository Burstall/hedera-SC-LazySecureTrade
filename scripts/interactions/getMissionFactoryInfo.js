const {
	AccountId,
	ContractId,
} = require('@hashgraph/sdk');
require('dotenv').config();
const fs = require('fs');
const { ethers } = require('ethers');
const { readOnlyEVMFromMirrorNode } = require('../../utils/solidityHelpers');
const { getArgFlag } = require('../../utils/nodeHelpers');

// Get operator from .env file
let operatorId;
try {
	operatorId = AccountId.fromString(process.env.ACCOUNT_ID);
}
catch (err) {
	console.log('ERROR: Must specify ACCOUNT_ID in the .env file');
}

const contractName = 'MissionFactory';

const env = process.env.ENVIRONMENT ?? null;

const main = async () => {
	// configure the client object
	if (
		operatorId === undefined ||
		operatorId == null
	) {
		console.log(
			'Environment required, please specify ACCOUNT_ID in the .env file',
		);
		process.exit(1);
	}

	const args = process.argv.slice(2);
	if (args.length != 1 || getArgFlag('h')) {
		console.log('Usage: getMissionFactoryInfo.js 0.0.MMMM');
		console.log('       MMM is the mission factory address');
		return;
	}

	const contractId = ContractId.fromString(args[0]);

	console.log('\n-Using ENIVRONMENT:', env);
	console.log('\n-Using Operator:', operatorId.toString());
	console.log('\n-Using Contract:', contractId.toString());

	// import ABI
	const missionJSON = JSON.parse(
		fs.readFileSync(
			`./artifacts/contracts/${contractName}.sol/${contractName}.json`,
		),
	);

	const missionFactoryIface = new ethers.Interface(missionJSON.abi);

	// query the EVM via mirror node (readOnlyEVMFromMirrorNode) to know
	// 1) getDeployedMissions

	let encodedCommand = missionFactoryIface.encodeFunctionData(
		'getDeployedMissions',
		[],
	);

	let result = await readOnlyEVMFromMirrorNode(
		env,
		contractId,
		encodedCommand,
		operatorId,
		false,
	);

	const deployedMissions = missionFactoryIface.decodeFunctionResult(
		'getDeployedMissions',
		result,
	);

	console.log('Deployed Missions:', deployedMissions);

	// 2) getAvailableSlots

	encodedCommand = missionFactoryIface.encodeFunctionData(
		'getAvailableSlots',
		[],
	);

	result = await readOnlyEVMFromMirrorNode(
		env,
		contractId,
		encodedCommand,
		operatorId,
		false,
	);

	const availableSlots = missionFactoryIface.decodeFunctionResult(
		'getAvailableSlots',
		result,
	);

	console.log('Available Slots:', availableSlots);

	// lazyToken
	encodedCommand = missionFactoryIface.encodeFunctionData(
		'lazyToken',
		[],
	);

	result = await readOnlyEVMFromMirrorNode(
		env,
		contractId,
		encodedCommand,
		operatorId,
		false,
	);

	const lazyToken = missionFactoryIface.decodeFunctionResult(
		'lazyToken',
		result,
	);

	console.log('Lazy Token:', lazyToken
		? ContractId.fromEvmAddress(0, 0, lazyToken[0]).toString()
		: 'Not Set',
	);

	// boostManager
	encodedCommand = missionFactoryIface.encodeFunctionData(
		'boostManager',
		[],
	);

	result = await readOnlyEVMFromMirrorNode(
		env,
		contractId,
		encodedCommand,
		operatorId,
		false,
	);

	const boostManager = missionFactoryIface.decodeFunctionResult(
		'boostManager',
		result,
	);

	console.log('Boost Manager:', boostManager
		? ContractId.fromEvmAddress(0, 0, boostManager[0]).toString()
		: 'Not Set',
	);

	// lazyGasStation

	encodedCommand = missionFactoryIface.encodeFunctionData(
		'lazyGasStation',
		[],
	);

	result = await readOnlyEVMFromMirrorNode(
		env,
		contractId,
		encodedCommand,
		operatorId,
		false,
	);

	const lazyGasStation = missionFactoryIface.decodeFunctionResult(
		'lazyGasStation',
		result,
	);

	console.log('Lazy Gas Station:', lazyGasStation
		? ContractId.fromEvmAddress(0, 0, lazyGasStation[0]).toString()
		: 'Not Set',
	);

	// prngGenerator
	encodedCommand = missionFactoryIface.encodeFunctionData(
		'prngGenerator',
		[],
	);

	result = await readOnlyEVMFromMirrorNode(
		env,
		contractId,
		encodedCommand,
		operatorId,
		false,
	);

	const prngGenerator = missionFactoryIface.decodeFunctionResult(
		'prngGenerator',
		result,
	);

	console.log('PRNG Generator:', prngGenerator
		? ContractId.fromEvmAddress(0, 0, prngGenerator[0]).toString()
		: 'Not Set',
	);

	// missionTemplate
	encodedCommand = missionFactoryIface.encodeFunctionData(
		'missionTemplate',
		[],
	);

	result = await readOnlyEVMFromMirrorNode(
		env,
		contractId,
		encodedCommand,
		operatorId,
		false,
	);

	const missionTemplate = missionFactoryIface.decodeFunctionResult(
		'missionTemplate',
		result,
	);

	console.log('Mission Template:', missionTemplate
		? ContractId.fromEvmAddress(0, 0, missionTemplate[0]).toString()
		: 'Not Set',
	);

	// lazyDelegateRegistry
	encodedCommand = missionFactoryIface.encodeFunctionData(
		'lazyDelegateRegistry',
		[],
	);

	result = await readOnlyEVMFromMirrorNode(
		env,
		contractId,
		encodedCommand,
		operatorId,
		false,
	);

	const lazyDelegateRegistry = missionFactoryIface.decodeFunctionResult(
		'lazyDelegateRegistry',
		result,
	);

	console.log('Lazy Delegate Registry:', lazyDelegateRegistry
		? ContractId.fromEvmAddress(0, 0, lazyDelegateRegistry[0]).toString()
		: 'Not Set',
	);

	// TODO: on new release add getAdmins / getDeployers
};

main()
	.then(() => {
		process.exit(0);
	})
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
