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
		console.log('Usage: checkLiveFTAllowances.js 0.0.CCC 0.0.TOKEN1,0.0.TOKEN2 0.0.OWNER1,0.0.OWNER2 0.0.SPENDER1,0.0.SPENDER2');
		console.log('       BATCH CHECK VERSION');
		console.log('       CCC is the LazyAllowanceUtility address');
		console.log('       0.0.TOKEN1,2,3 is the FT token  list we are checking for live allowances');
		console.log('       0.0.OWNER1,2,3 is the owner of the NFT token(s)');
		console.log('       0.0.SPENDER1,2,3 is the spender of the NFT token');
		return;
	}

	const contractId = ContractId.fromString(args[0]);
	const tokenList = args[1].split(',').map((t) => TokenId.fromString(t));
	const ownerList = args[2].split(',').map((t) => AccountId.fromString(t));
	const spenderList = args[3].split(',').map((t) => AccountId.fromString(t));

	console.log('\n-Using ENIVRONMENT:', env);
	console.log('\n-Using Operator:', operatorId.toString());
	console.log('\n-Using Contract:', contractId.toString());
	console.log('\n-Checking Token:', tokenList.map((t) => t.toString()).join(', '));
	console.log('\n-Checking Owner:', ownerList.map((t) => t.toString()).join(', '));
	console.log('\n-Checking Spender:', spenderList.map((t) => t.toString()).join(', '));

	// import ABI
	const boostManagerJSON = JSON.parse(
		fs.readFileSync(
			`./artifacts/contracts/${contractName}.sol/${contractName}.json`,
		),
	);

	const boostManagerIface = new ethers.Interface(boostManagerJSON.abi);

	// query the EVM via mirror node (readOnlyEVMFromMirrorNode)
	const encodedCommand = boostManagerIface.encodeFunctionData(
		'checkLiveAllowances',
		[
			tokenList.map((t) => t.toSolidityAddress()),
			ownerList.map((o) => o.toSolidityAddress()),
			spenderList.map((s) => s.toSolidityAddress()),
		],
	);

	const result = await readOnlyEVMFromMirrorNode(
		env,
		contractId,
		encodedCommand,
		operatorId,
		false,
	);

	const approved = boostManagerIface.decodeFunctionResult(
		'checkLiveAllowances',
		result,
	);

	for (let i = 0; i < tokenList.length; i++) {
		console.log('Token:', tokenList[i].toString(), 'Owner:', ownerList[i].toString(), 'Spender:', spenderList[i].toString(), 'Live Allowance:', Number(approved[0][i]));
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
