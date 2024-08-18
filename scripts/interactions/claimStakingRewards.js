const {
	Client,
	AccountId,
	PrivateKey,
	ContractId,
	TokenId,
} = require('@hashgraph/sdk');
require('dotenv').config();
const fs = require('fs');
const { ethers } = require('ethers');
const readlineSync = require('readline-sync');
const { getArgFlag } = require('../../utils/nodeHelpers');
const { contractExecuteFunction, readOnlyEVMFromMirrorNode } = require('../../utils/solidityHelpers');

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

const contractName = 'LazyNFTStaking';

const env = process.env.ENVIRONMENT ?? null;

let client;

const main = async () => {
	// configure the client object
	if (
		operatorKey === undefined ||
		operatorKey == null ||
		operatorId === undefined ||
		operatorId == null
	) {
		console.log(
			'Environment required, please specify PRIVATE_KEY & ACCOUNT_ID & SIGNING_KEY in the .env file',
		);
		process.exit(1);
	}

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

	const args = process.argv.slice(2);
	if (args.length != 5 || getArgFlag('h')) {
		console.log('Usage: claimStakingRewards.js 0.0.SSS');
		console.log('		0.0.SSS is the LazyNFTStaking contract to update');
		return;
	}

	const contractId = ContractId.fromString(args[0]);

	// get the users staking info

	// query the EVM via mirror node (readOnlyEVMFromMirrorNode)

	const encodedCommand = lnsIface.encodeFunctionData(
		'getBaseRewardRate',
		[operatorId.toSolidityAddress()],
	);

	let result = await readOnlyEVMFromMirrorNode(
		env,
		contractId,
		encodedCommand,
		operatorId,
		false,
	);

	const baseRewardRate = lnsIface.decodeFunctionResult(
		'getBaseRewardRate',
		result,
	);

	const encodedCommand2 = lnsIface.encodeFunctionData(
		'getActiveBoostRate',
		[operatorId.toSolidityAddress()],
	);

	const result2 = await readOnlyEVMFromMirrorNode(
		env,
		contractId,
		encodedCommand2,
		operatorId,
		false,
	);

	const activeBoostRate = lnsIface.decodeFunctionResult(
		'getActiveBoostRate',
		result2,
	);

	// calculateRewards

	const encodedCommand3 = lnsIface.encodeFunctionData(
		'calculateRewards',
		[operatorId.toSolidityAddress()],
	);

	const result3 = await readOnlyEVMFromMirrorNode(
		env,
		contractId,
		encodedCommand3,
		operatorId,
		false,
	);

	const rewards = lnsIface.decodeFunctionResult(
		'calculateRewards',
		result3,
	);

	// getStakedNFTs

	const encodedCommand4 = lnsIface.encodeFunctionData(
		'getStakedNFTs',
		[operatorId.toSolidityAddress()],
	);

	const result4 = await readOnlyEVMFromMirrorNode(
		env,
		contractId,
		encodedCommand4,
		operatorId,
		false,
	);

	const stakedNFTs = lnsIface.decodeFunctionResult(
		'getStakedNFTs',
		result4,
	);

	console.log('\n-**STAKING**');
	console.log('\n-Using ENIVRONMENT:', env);
	console.log('\n-Using Operator:', operatorId.toString());
	console.log('\n-Using Contract:', contractId.toString());
	console.log('\n-Base Reward Rate:', baseRewardRate);
	console.log('\n-Active Boost Rate:', activeBoostRate);
	console.log('\n-Lazy Earnt:', Number(rewards[0]));
	console.log('\n-Total Reward Rate:', Number(rewards[1]));
	console.log('\n-As Of:', Number(rewards[2]), `${new Date(Number(rewards[2]) * 1000).toISOString()}`);
	console.log('\n-Last Claim:', Number(rewards[3]), `${new Date(Number(rewards[3]) * 1000).toISOString()}`);
	// output stakedNFTs which is of type [address[] memory collections, uint256[][] memory serials]
	let stakedNFTString = '';
	for (let i = 0; i < stakedNFTs[0].length; i++) {
		stakedNFTString += `Collection: ${TokenId.fromSolidityAddress(stakedNFTs[0][i]).toString()} [`;
		stakedNFTString += `Serials: ${stakedNFTs[1][i].map(s => Number(s)).join(', ')}]\n`;
	}
	console.log('\n-Staked NFTs:\n' + stakedNFTString);

	// import ABI
	const lnsJSON = JSON.parse(
		fs.readFileSync(
			`./artifacts/contracts/${contractName}.sol/${contractName}.json`,
		),
	);

	const lnsIface = new ethers.Interface(lnsJSON.abi);


	const proceed = readlineSync.keyInYNStrict('Do you want to claim staking rewards (**HODL bonus will reset**)?');
	if (!proceed) {
		console.log('User Aborted');
		return;
	}


	const gas = 500_000;

	result = await contractExecuteFunction(
		contractId,
		lnsIface,
		client,
		gas,
		'claimRewards',
	);

	if (result[0]?.status?.toString() != 'SUCCESS') {
		console.log('Error staking:', result);
		return;
	}

	console.log('Claim executed. Transaction ID:', result[2]?.transactionId?.toString());

};


main()
	.then(() => {
		// eslint-disable-next-line no-useless-escape
		process.exit(0);
	})
	.catch(error => {
		console.error(error);
		process.exit(1);
	});
