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

// Get operator from .env file
let operatorId;
try {
	operatorId = AccountId.fromString(process.env.ACCOUNT_ID);
}
catch (err) {
	console.log('ERROR: Must specify PRIVATE_KEY & ACCOUNT_ID in the .env file');
}

const contractName = 'LazyNFTStaking';

const env = process.env.ENVIRONMENT ?? null;

const main = async () => {
	// configure the client object
	if (
		operatorId === undefined ||
		operatorId == null
	) {
		console.log(
			'Environment required, please specify PRIVATE_KEY & ACCOUNT_ID in the .env file',
		);
		process.exit(1);
	}

	const args = process.argv.slice(2);
	if (args.length != 2 || getArgFlag('h')) {
		console.log('Usage: getTotalCollectionStaked.js 0.0.LNS 0.0.CCC');
		console.log('       LNS is the LazyStakingNFTs Contract address');
		console.log('	    CCC is the Collection address');
		return;
	}

	const contractId = ContractId.fromString(args[0]);
	const token = TokenId.fromString(args[1]);

	console.log('\n-Using ENIVRONMENT:', env);
	console.log('\n-Using Operator:', operatorId.toString());
	console.log('\n-Using Contract:', contractId.toString());
	console.log('\n-Checking Staked Serials For:', token.toString());

	// import ABI
	const boostManagerJSON = JSON.parse(
		fs.readFileSync(
			`./artifacts/contracts/${contractName}.sol/${contractName}.json`,
		),
	);

	const boostManagerIface = new ethers.Interface(boostManagerJSON.abi);

	// query the EVM via mirror node (readOnlyEVMFromMirrorNode)

	const encodedCommand = boostManagerIface.encodeFunctionData(
		'getNumStakedNFTs',
		[token.toSolidityAddress()],
	);

	const result = await readOnlyEVMFromMirrorNode(
		env,
		contractId,
		encodedCommand,
		operatorId,
		false,
	);

	const totalStaked = boostManagerIface.decodeFunctionResult(
		'getNumStakedNFTs',
		result,
	);
	console.log(`Total Staked (${token.toString()}):`, totalStaked);

	// now get totalItemsStaked the public variable
	const encodedCommand2 = boostManagerIface.encodeFunctionData(
		'totalItemsStaked',
		[],
	);

	const result2 = await readOnlyEVMFromMirrorNode(
		env,
		contractId,
		encodedCommand2,
		operatorId,
		false,
	);

	const totalStaked2 = boostManagerIface.decodeFunctionResult(
		'totalItemsStaked',
		result2,
	);

	console.log('Total Items Staked:', totalStaked2);
};

main()
	.then(() => {
		process.exit(0);
	})
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
