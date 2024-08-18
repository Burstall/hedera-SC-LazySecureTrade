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

const contractName = 'LazyDelegateRegistry';

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
	if (args.length != 3 || getArgFlag('h')) {
		console.log('Usage: checkDelegatedToForNFTSerial.js 0.0.LDR 0.0.TTT <serial>');
		console.log('       LDR is the LazyDelegateRegistry address');
		console.log('       TTT is the token address');
		console.log('       serial is the serial number of the NFT to check');
		return;
	}

	const contractId = ContractId.fromString(args[0]);
	const token = TokenId.fromString(args[1]);
	const serial = parseInt(args[2]);

	console.log('\n-Using ENIVRONMENT:', env);
	console.log('\n-Using Operator:', operatorId.toString());
	console.log('\n-Using Contract:', contractId.toString());
	console.log('\n-Checking Tokens:', token.toString());
	console.log('\n-Checking Serial:', serial);

	// import ABI
	const boostManagerJSON = JSON.parse(
		fs.readFileSync(
			`./artifacts/contracts/${contractName}.sol/${contractName}.json`,
		),
	);

	const boostManagerIface = new ethers.Interface(boostManagerJSON.abi);

	// query the EVM via mirror node (readOnlyEVMFromMirrorNode)
	const encodedCommand = boostManagerIface.encodeFunctionData(
		'getNFTDelegatedTo',
		[token.toSolidityAddress(), serial],
	);

	console.log(`Encoded Command: ${encodedCommand}`);

	const result = await readOnlyEVMFromMirrorNode(
		env,
		contractId,
		encodedCommand,
		operatorId,
		false,
	);

	const user = boostManagerIface.decodeFunctionResult(
		'getNFTDelegatedTo',
		result,
	);

	console.log(`NFT ${serial} is delegated to: ${AccountId.fromEvmAddress(user[0]).toString()}`);

	// use getNFTsDelegatedTo to get all NFTs delegated to a user
	const encodedCommand1 = boostManagerIface.encodeFunctionData(
		'getNFTsDelegatedTo',
		[user],
	);

	const result1 = await readOnlyEVMFromMirrorNode(
		env,
		contractId,
		encodedCommand1,
		operatorId,
		false,
	);

	const nfts = boostManagerIface.decodeFunctionResult(
		'getNFTsDelegatedTo',
		result1,
	);

	console.log(`NFTs delegated to ${AccountId.fromEvmAddress(user[0]).toString()}: ${nfts.map((n) => TokenId.fromSolidityAddress(n).toString()).join(', ')}`);

	// check totalSerialsDelegated
	const encodedCommand2 = boostManagerIface.encodeFunctionData(
		'totalSerialsDelegated',
		[],
	);

	const result2 = await readOnlyEVMFromMirrorNode(
		env,
		contractId,
		encodedCommand2,
		operatorId,
		false,
	);

	const totalSerialsDelegated = boostManagerIface.decodeFunctionResult(
		'totalSerialsDelegated',
		result2,
	);

	console.log(`(Global) Total Serials Delegated: ${totalSerialsDelegated}`);

};

main()
	.then(() => {
		process.exit(0);
	})
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
