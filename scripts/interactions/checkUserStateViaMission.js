const {
	AccountId,
	ContractId,
} = require('@hashgraph/sdk');
require('dotenv').config();
const fs = require('fs');
const { ethers } = require('ethers');
const { readOnlyEVMFromMirrorNode } = require('../../utils/solidityHelpers');
const { getArgFlag } = require('../../utils/nodeHelpers');
const { getContractEVMAddress } = require('../../utils/hederaMirrorHelpers');

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
	if (args.length != 2 || getArgFlag('h')) {
		console.log('Usage: checkUserStateViaFactory.js 0.0.MMM 0.0.UUU');
		console.log('       MMM is the mission address');
		console.log('       UUU is the user address');
		return;
	}

	const missionIdEVMAddress = await getContractEVMAddress(env, args[0]);
	const contractId = ContractId.fromEvmAddress(0, 0, missionIdEVMAddress);
	const userAddress = AccountId.fromString(args[1]);

	console.log('\n-Using ENIVRONMENT:', env);
	console.log('\n-Using Operator:', operatorId.toString());
	console.log('\n-Using Contract:', contractId.toString());
	console.log('\n-Checking User:', userAddress.toString());

	// import ABI
	const missionJSON = JSON.parse(
		fs.readFileSync(
			`./artifacts/contracts/${contractName}.sol/${contractName}.json`,
		),
	);

	const missionIface = new ethers.Interface(missionJSON.abi);

	// query the EVM via mirror node (readOnlyEVMFromMirrorNode) to know
	// 1) isAdmin

	let encodedCommand = missionIface.encodeFunctionData(
		'isAdmin',
		[userAddress.toSolidityAddress()],
	);

	let result = await readOnlyEVMFromMirrorNode(
		env,
		contractId,
		encodedCommand,
		operatorId,
		false,
	);

	const admin = missionIface.decodeFunctionResult(
		'isAdmin',
		result,
	);

	console.log('Is Admin?:', admin);

	// 2) isParticipant

	encodedCommand = missionIface.encodeFunctionData(
		'isParticipant',
		[userAddress.toSolidityAddress()],
	);

	result = await readOnlyEVMFromMirrorNode(
		env,
		contractId,
		encodedCommand,
		operatorId,
		false,
	);

	const participant = missionIface.decodeFunctionResult(
		'isParticipant',
		result,
	);

	console.log('Is Participant?', participant);

	if (!participant) {
		console.log('User is not partipating in this mission');
		return;
	}

	// 3) getMissionParticipation

	encodedCommand = missionIface.encodeFunctionData(
		'getMissionParticipation',
		[userAddress.toSolidityAddress()],
	);

	result = await readOnlyEVMFromMirrorNode(
		env,
		contractId,
		encodedCommand,
		operatorId,
		false,
	);

	const participationDetails = missionIface.decodeFunctionResult(
		'getMissionParticipation',
		result,
	);

	// returns an array of mission addresses, an array of timestamps for completion, and an array of booleans
	console.log('Mission Participation:', participationDetails);

	const isBoostedList = Boolean(participationDetails[4]);

	if (isBoostedList) {
		encodedCommand = missionIface.encodeFunctionData(
			'getUsersBoostInfo',
			[userAddress.toSolidityAddress()],
		);

		result = await readOnlyEVMFromMirrorNode(
			env,
			contractId,
			encodedCommand,
			operatorId,
			false,
		);

		const boostType = missionIface.decodeFunctionResult(
			'getUsersBoostInfo',
			result,
		);

		console.log('Boost Type:', boostType);
	}

};

main()
	.then(() => {
		process.exit(0);
	})
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
