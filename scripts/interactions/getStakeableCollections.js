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
	if (args.length != 1 || getArgFlag('h')) {
		console.log('Usage: getStakableCollections.js 0.0.LNS');
		console.log('       LNS is the LazyStakingNFTs Contract address');
		return;
	}

	const contractId = ContractId.fromString(args[0]);

	console.log('\n-Using ENIVRONMENT:', env);
	console.log('\n-Using Operator:', operatorId.toString());
	console.log('\n-Using Contract:', contractId.toString());

	// import ABI
	const boostManagerJSON = JSON.parse(
		fs.readFileSync(
			`./artifacts/contracts/${contractName}.sol/${contractName}.json`,
		),
	);

	const boostManagerIface = new ethers.Interface(boostManagerJSON.abi);

	// query the EVM via mirror node (readOnlyEVMFromMirrorNode)

	const encodedCommand = boostManagerIface.encodeFunctionData(
		'getStakableCollections',
		[],
	);

	const result = await readOnlyEVMFromMirrorNode(
		env,
		contractId,
		encodedCommand,
		operatorId,
		false,
	);

	const tokens = boostManagerIface.decodeFunctionResult(
		'getStakableCollections',
		result,
	);
	console.log('Raw:', tokens);
	console.log('Stakeable Collections:', tokens[0].map((u) => TokenId.fromString(u).toString()).join(', '));

};

main()
	.then(() => {
		process.exit(0);
	})
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
