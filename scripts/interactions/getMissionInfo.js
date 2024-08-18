const {
	AccountId,
	ContractId,
	TokenId,
} = require('@hashgraph/sdk');
require('dotenv').config();
const fs = require('fs');
const { ethers } = require('ethers');
const { readOnlyEVMFromMirrorNode } = require('../../utils/solidityHelpers');
const { getArgFlag } = require('../../utils/nodeHelpers');
const { getTokenDetails, getContractEVMAddress } = require('../../utils/hederaMirrorHelpers');

// Get operator from .env file
let operatorId;
try {
	operatorId = AccountId.fromString(process.env.ACCOUNT_ID);
}
catch (err) {
	console.log('ERROR: Must specify ACCOUNT_ID in the .env file');
}

const contractName = 'Mission';

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
		console.log('Usage: getMissionInfo.js 0.0.MMMM');
		console.log('       MMM is the mission address');
		return;
	}

	const missionIdEVMAddress = await getContractEVMAddress(env, args[0]);
	const contractId = ContractId.fromEvmAddress(0, 0, missionIdEVMAddress);

	console.log('\n-Using ENIVRONMENT:', env);
	console.log('\n-Using Operator:', operatorId.toString());
	console.log('\n-Using Contract:', contractId.toString(), 'HAPI:', args[0]);

	// import ABI
	const missionJSON = JSON.parse(
		fs.readFileSync(
			`./artifacts/contracts/${contractName}.sol/${contractName}.json`,
		),
	);

	const missionIface = new ethers.Interface(missionJSON.abi);

	// query the EVM via mirror node (readOnlyEVMFromMirrorNode) to know
	// 1) is mission paused

	let encodedCommand = missionIface.encodeFunctionData(
		'isPaused',
		[],
	);

	let result = await readOnlyEVMFromMirrorNode(
		env,
		contractId,
		encodedCommand,
		operatorId,
		false,
	);

	const missionPaused = missionIface.decodeFunctionResult('isPaused', result);

	console.log('Mission Paused:', missionPaused[0]);

	// 2) getSlotsRemaining

	encodedCommand = missionIface.encodeFunctionData(
		'getSlotsRemaining',
		[],
	);

	result = await readOnlyEVMFromMirrorNode(
		env,
		contractId,
		encodedCommand,
		operatorId,
		false,
	);

	const slotsRemaining = missionIface.decodeFunctionResult('getSlotsRemaining', result);

	console.log('Slots Remaining:', Number(slotsRemaining[0]));

	// get the lazy token id (lazyToken)

	encodedCommand = missionIface.encodeFunctionData(
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

	const lazyTokenObj = missionIface.decodeFunctionResult('lazyToken', result);
	const lazyToken = TokenId.fromSolidityAddress(lazyTokenObj[0]);

	// get the decimal of the lazyToken form mirror
	const lazyTokenDetails = await getTokenDetails(env, lazyToken);

	// 3) entryFee

	encodedCommand = missionIface.encodeFunctionData(
		'entryFee',
		[],
	);

	result = await readOnlyEVMFromMirrorNode(
		env,
		contractId,
		encodedCommand,
		operatorId,
		false,
	);

	const entryFee = missionIface.decodeFunctionResult('entryFee', result);

	console.log('Entry Fee:', Number(entryFee[0]) / Math.pow(10, lazyTokenDetails.decimals), `$${lazyTokenDetails.symbol}`);

	// 3.5) getDecrementDetails

	encodedCommand = missionIface.encodeFunctionData(
		'getDecrementDetails',
		[],
	);

	result = await readOnlyEVMFromMirrorNode(
		env,
		contractId,
		encodedCommand,
		operatorId,
		false,
	);

	const decrementDetails = missionIface.decodeFunctionResult('getDecrementDetails', result);

	const decrmentInternal = Number(decrementDetails[0]);
	const decrmentSartTime = Number(decrementDetails[1]);
	if (decrmentSartTime > 0) {
		console.log('**DUTCH AUCTION engaged');
		console.log('Decrement every:', decrmentInternal, 'seconds (', decrmentInternal / 60, 'minutes)');
		console.log('Decrement Start Time:', new Date(decrmentSartTime * 1000).toUTCString());
	}
	else {
		console.log('Fixed Cost Entry');
	}

	// 4) getUsersOnMission

	encodedCommand = missionIface.encodeFunctionData(
		'getUsersOnMission',
		[],
	);

	result = await readOnlyEVMFromMirrorNode(
		env,
		contractId,
		encodedCommand,
		operatorId,
		false,
	);

	const usersOnMission = missionIface.decodeFunctionResult('getUsersOnMission', result);

	console.log('Users on Mission:', usersOnMission[0]);

	// boostManager
	encodedCommand = missionIface.encodeFunctionData(
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

	const boostManager = missionIface.decodeFunctionResult('boostManager', result);

	console.log('Boost Manager:', ContractId.fromEvmAddress(0, 0, boostManager[0]).toString());

	// prngGenerator
	encodedCommand = missionIface.encodeFunctionData(
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

	const prngGenerator = missionIface.decodeFunctionResult('prngGenerator', result);

	console.log('PRNG Generator:', ContractId.fromEvmAddress(0, 0, prngGenerator[0]).toString());

	// missionFactory
	encodedCommand = missionIface.encodeFunctionData(
		'missionFactory',
		[],
	);

	result = await readOnlyEVMFromMirrorNode(
		env,
		contractId,
		encodedCommand,
		operatorId,
		false,
	);

	const missionFactory = missionIface.decodeFunctionResult('missionFactory', result);

	console.log('Mission Factory:', ContractId.fromEvmAddress(0, 0, missionFactory[0]).toString());

	// lazyGasStation
	encodedCommand = missionIface.encodeFunctionData(
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

	const lazyGasStation = missionIface.decodeFunctionResult('lazyGasStation', result);

	console.log('Lazy Gas Station:', ContractId.fromEvmAddress(0, 0, lazyGasStation[0]).toString());

	// lazyDelegateRegistry
	encodedCommand = missionIface.encodeFunctionData(
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

	const lazyDelegateRegistry = missionIface.decodeFunctionResult('lazyDelegateRegistry', result);

	console.log('Lazy Delegate Registry:', ContractId.fromEvmAddress(0, 0, lazyDelegateRegistry[0]).toString());

	// 5) getRewards

	encodedCommand = missionIface.encodeFunctionData(
		'getRewards',
		[],
	);

	result = await readOnlyEVMFromMirrorNode(
		env,
		contractId,
		encodedCommand,
		operatorId,
		false,
	);

	const rewards = missionIface.decodeFunctionResult('getRewards', result);

	console.log('Available Rewards:');
	for (let i = 0; i < rewards[0].length; i++) {
		console.log(`\tToken: ${TokenId.fromSolidityAddress(rewards[0][i])}`);
		console.log('\t\tSerials:', rewards[1][i].map(s => Number(s)).join(', '));

	}

	// 6) getRequirements

	encodedCommand = missionIface.encodeFunctionData(
		'getRequirements',
		[],
	);

	result = await readOnlyEVMFromMirrorNode(
		env,
		contractId,
		encodedCommand,
		operatorId,
		false,
	);

	const requirements = missionIface.decodeFunctionResult('getRequirements', result);

	console.log('Allowed Entry Collateral:');

	for (let i = 0; i < requirements[0].length; i++) {
		console.log(`\tToken: ${TokenId.fromSolidityAddress(requirements[0][i])}`);
		const serialLock = Boolean(requirements[1][i]);
		if (serialLock) {
			console.log('\t\tOnly Serials:', requirements[2][i].map(s => Number(s)).join(', '));
		}
		else {
			console.log('\t\tAll Serials');
		}
	}

	// 7) missionState

	encodedCommand = missionIface.encodeFunctionData(
		'missionState',
		[],
	);

	result = await readOnlyEVMFromMirrorNode(
		env,
		contractId,
		encodedCommand,
		operatorId,
		false,
	);

	const missionState = missionIface.decodeFunctionResult('missionState', result);

	console.log('Mission State:',
		'\n\tFactory:', ContractId.fromEvmAddress(0, 0, missionState[0]).toString(),
		'\n\tCreator:', AccountId.fromEvmAddress(0, 0, missionState[1]).toString(),
		'\n\tDuration:', Number(missionState[2], 'seconds (', Number(missionState[2]) / 60, 'minutes) or (', Number(missionState[2]) / 3600, 'hours)'),
		'\n\tEntry Fee:', Number(missionState[3]) / Math.pow(10, lazyTokenDetails.decimals), `$${lazyTokenDetails.symbol}`,
		'\n\tFee Burn Percentage:', Number(missionState[4], '%'),
		'\n\tLast Entry Timestamp:', new Date(Number(missionState[5]) * 1000).toUTCString(),
		'\n\tStart Timestamp:', Number(missionState[6]) ? new Date(Number(missionState[6]) * 1000).toUTCString() : 'UNSET',
		'\n\tMin Entry Fee:', Number(missionState[7]) / Math.pow(10, lazyTokenDetails.decimals), `$${lazyTokenDetails.symbol}`,
		'\n\tDecrement Amount:', Number(missionState[8]),
		'\n\tDecrement Interval:', Number(missionState[9], 'seconds (', Number(missionState[9]) / 60, 'minutes)'),
		'\n\tTotal Serials As Rewards:', Number(missionState[10]),
		'\n\tNb Of Rewards:', Number(missionState[11]),
		'\n\tNb Of Requirements:', Number(missionState[12]),
	);

};

main()
	.then(() => {
		process.exit(0);
	})
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
