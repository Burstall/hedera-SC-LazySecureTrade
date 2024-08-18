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
	if (args.length != 2 || getArgFlag('h')) {
		console.log('Usage: checkUserStateViaFactory.js 0.0.MMM 0.0.UUU');
		console.log('       MMM is the mission factory address');
		console.log('       UUU is the user address');
		return;
	}

	const contractId = ContractId.fromString(args[0]);
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

	const missionFactoryIface = new ethers.Interface(missionJSON.abi);

	// query the EVM via mirror node (readOnlyEVMFromMirrorNode) to know
	// 1) isAdmin

	let encodedCommand = missionFactoryIface.encodeFunctionData(
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

	const admin = missionFactoryIface.decodeFunctionResult(
		'isAdmin',
		result,
	);

	console.log('Is Admin?:', admin);

	// 2) isDeployer

	encodedCommand = missionFactoryIface.encodeFunctionData(
		'isDeployer',
		[userAddress.toSolidityAddress()],
	);

	result = await readOnlyEVMFromMirrorNode(
		env,
		contractId,
		encodedCommand,
		operatorId,
		false,
	);

	const deployer = missionFactoryIface.decodeFunctionResult(
		'isDeployer',
		result,
	);

	console.log('Is Deployer?', deployer);

	// 3) getLiveMissions

	encodedCommand = missionFactoryIface.encodeFunctionData(
		'getLiveMissions',
		[userAddress.toSolidityAddress()],
	);

	result = await readOnlyEVMFromMirrorNode(
		env,
		contractId,
		encodedCommand,
		operatorId,
		false,
	);

	const liveMissions = missionFactoryIface.decodeFunctionResult(
		'getLiveMissions',
		result,
	);

	// returns an array of mission addresses, an array of timestamps for completion, and an array of booleans
	console.log('Live Missions:', liveMissions);

	const missionList = liveMissions[0];
	const isBoostedList = liveMissions[2];

	// for each mission, get the mission details and if boosted get the type of boost.
	for (let i = 0; i < missionList.length; i++) {
		const missionAddress = missionList[i];
		encodedCommand = missionFactoryIface.encodeFunctionData(
			'getUsersMissionParticipation',
			[userAddress.toSolidityAddress(), missionAddress],
		);

		result = await readOnlyEVMFromMirrorNode(
			env,
			contractId,
			encodedCommand,
			operatorId,
			false,
		);

		const missionDetails = missionFactoryIface.decodeFunctionResult(
			'getUsersMissionParticipation',
			result,
		);

		console.log('\n\nMission:', missionAddress.toString());
		console.log('Details:', missionDetails);

		if (isBoostedList[i]) {
			encodedCommand = missionFactoryIface.encodeFunctionData(
				'getUsersBoostStatus',
				[userAddress.toSolidityAddress(), missionAddress],
			);

			result = await readOnlyEVMFromMirrorNode(
				env,
				contractId,
				encodedCommand,
				operatorId,
				false,
			);

			const boostType = missionFactoryIface.decodeFunctionResult(
				'getUsersBoostStatus',
				result,
			);

			console.log('Boost Type:', boostType);
		}
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
