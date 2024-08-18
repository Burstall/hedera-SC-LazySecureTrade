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
const { generateStakingRewardProof, Stake } = require('../../utils/LazyNFTStakingHelper');
const { contractExecuteFunction } = require('../../utils/solidityHelpers');
const { checkHbarAllowances } = require('../../utils/hederaMirrorHelpers');
const { setHbarAllowance } = require('../../utils/hederaHelpers');

// Get operator from .env file
let operatorKey;
let operatorId;
let signingKey;
try {
	operatorKey = PrivateKey.fromStringED25519(process.env.PRIVATE_KEY);
	operatorId = AccountId.fromString(process.env.ACCOUNT_ID);
	// EDCSA key - ED25519 key is not supported
	signingKey = PrivateKey.fromStringECDSA(process.env.SIGNING_KEY);
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
		operatorId == null ||
		signingKey === undefined ||
		signingKey == null
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
		console.log('Usage: unstakeNFT.js 0.0.SSS 0.0.CCC1,0.0.CCC2,0.0.CCC3 S1,S2:S3,S4, R1,R2:R3,R4 <boostRate>');
		console.log('		0.0.SSS is the LazyNFTStaking contract to update');
		console.log('		0.0.CCC1,0.0.CCC2,0.0.CCC3 is the collections to add to the the message (comma separated - no spaces)');
		console.log('		S1,S2:S3,S4 is the list of serials (comma separated arrays - no spaces then colon seperated)');
		console.log('		R1,R2:R3,R4 is the list of reward rates (comma separated arrays - no spaces then colon seperated)');
		console.log('		<boostRate> is the boost rate for the message');
		console.log('		Example: unstakeNFT.js 0.0.123 0.0.456,0.0.789 1,2,5:3,4,9 5,10,1:20,2,4 100');
		return;
	}

	const contractId = ContractId.fromString(args[0]);
	const tokenList = args[1].split(',').map((t) => TokenId.fromString(t));
	const tokenListAsSolidity = tokenList.map((t) => t.toSolidityAddress());
	// split serials by : then each array by , to get an array of arrays
	const serialArrayList = args[2].split(':').map((s) => s.split(',').map((i) => parseInt(i)));
	const rewardRates = args[3].split(':').map((r) => r.split(',').map((i) => parseInt(i)));
	const boostRate = parseInt(args[3]);

	// check reward rates length is same as token list
	if (tokenList.length !== rewardRates.length) {
		console.log('Error: Reward rates length must match token list length');
		return;
	}

	console.log('\n-**UNSTAKING**');
	console.log('\n-Using ENIVRONMENT:', env);
	console.log('\n-Using Operator:', operatorId.toString());
	console.log('\n-Using Contract:', contractId.toString());
	console.log('\n-Collection(s):', tokenList.map((t) => t.toString()).join(', '));
	console.log('\n-Serials:', serialArrayList);
	console.log('\n-Reward Rate:', rewardRates);
	console.log('\n-Boost Rate:', boostRate);

	// import ABI
	const lnsJSON = JSON.parse(
		fs.readFileSync(
			`./artifacts/contracts/${contractName}.sol/${contractName}.json`,
		),
	);

	const lnsIface = new ethers.Interface(lnsJSON.abi);

	// gather the Staking objects
	const stakes = [];

	for (let i = 0; i < tokenList.length; i++) {
		stakes.push(new Stake(tokenListAsSolidity[i], serialArrayList[i], rewardRates[i]));
		console.log('Preparing to Unstake:', stakes[i]);
	}

	let proceed = readlineSync.keyInYNStrict('Do you want to update the Staked Collections?');
	if (!proceed) {
		console.log('User Aborted');
		return;
	}

	// check an allowance is set to the staking contract
	let found = false;

	const mirrorHbarAllowances = await checkHbarAllowances(env, operatorId);
	for (let a = 0; a < mirrorHbarAllowances.length; a++) {
		const allowance = mirrorHbarAllowances[a];
		// console.log('Hbar Allowance found:', allowance.owner, allowance.spender);
		if (allowance.spender == contractId.toString()) {
			if (allowance.amount >= 10) {
				console.log('FOUND: Sufficient Hbar allowance to Staking Contract', allowance.amount);
				found = true;
			}
		}
	}

	if (!found) {
		console.log('ERROR: Insufficient HBAR allowance to Staking Contract');
		proceed = readlineSync.keyInYNStrict('Do you want to set the allowance?');
		if (!proceed) {
			console.log('User Aborted');
			return;
		}
		// set allowance to the Gas Station for the fee
		const res = await setHbarAllowance(
			client,
			operatorId,
			contractId,
			10,
		);

		if (res != 'SUCCESS') {
			console.log('Error setting HBAR allowance to Staking Contract:', res);
			return;
		}

		console.log('ALLOWANCE SET: 10 tinybar allowance to Staking Contract');
	}

	// to create the signature we need to pack the variables and hash them in the same order and manner as the contract
	const rewardProof = await generateStakingRewardProof(
		operatorId,
		boostRate,
		signingKey,
		stakes,
	);

	const gas = tokenList.length * 400_000 + 400_000;

	const result = await contractExecuteFunction(
		contractId,
		lnsIface,
		client,
		gas,
		'unstake',
		[stakes, rewardProof],
	);

	if (result[0]?.status?.toString() != 'SUCCESS') {
		console.log('Error staking:', result);
		return;
	}

	console.log('UNSTAKE. Transaction ID:', result[2]?.transactionId?.toString());

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
