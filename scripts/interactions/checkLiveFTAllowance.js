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
	console.log('ERROR: Must specify ACCOUNT_ID in the .env file');
}

const contractName = 'LazyAllowanceUtility';

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
	if (args.length != 4 || getArgFlag('h')) {
		console.log('Usage: checkLiveFTAllowance,js.js 0.0.CCC 0.0.TOKEN 0.0.OWNER 0.0.SPENDER');
		console.log('       CCC is the LazyAllowanceUtility address');
		console.log('       0.0.TOKEN is the FT token we are checking All Serials for');
		console.log('       0.0.OWNER is the owner of the NFT token(s)');
		console.log('       0.0.SPENDER is the spender of the NFT token');
		return;
	}

	const contractId = ContractId.fromString(args[0]);
	const token = TokenId.fromString(args[1]);
	const owner = AccountId.fromString(args[2]);
	const spender = AccountId.fromString(args[3]);

	console.log('\n-Using ENIVRONMENT:', env);
	console.log('\n-Using Operator:', operatorId.toString());
	console.log('\n-Using Contract:', contractId.toString());
	console.log('\n-Checking Token:', token.toString());
	console.log('\n-Checking Owner:', owner.toString());
	console.log('\n-Checking Spender:', spender.toString());

	// import ABI
	const boostManagerJSON = JSON.parse(
		fs.readFileSync(
			`./artifacts/contracts/${contractName}.sol/${contractName}.json`,
		),
	);

	const boostManagerIface = new ethers.Interface(boostManagerJSON.abi);

	// query the EVM via mirror node (readOnlyEVMFromMirrorNode)
	const encodedCommand = boostManagerIface.encodeFunctionData(
		'checkLiveAllowance',
		[token.toSolidityAddress(), owner.toSolidityAddress(), spender.toSolidityAddress()],
	);

	const result = await readOnlyEVMFromMirrorNode(
		env,
		contractId,
		encodedCommand,
		operatorId,
		false,
	);

	const approved = boostManagerIface.decodeFunctionResult(
		'checkLiveAllowance',
		result,
	);

	console.log('Live Allowance:', Number(approved[0]));

};


main()
	.then(() => {
		process.exit(0);
	})
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
