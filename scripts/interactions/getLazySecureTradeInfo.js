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
const { getTokenDetails } = require('../../utils/hederaMirrorHelpers');

// Get operator from .env file
let operatorId;
try {
	operatorId = AccountId.fromString(process.env.ACCOUNT_ID);
}
catch (err) {
	console.log('ERROR: Must specify ACCOUNT_ID in the .env file');
}

const contractName = 'LazySecureTrade';

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
		console.log('Usage: getLazySecureTradeInfo.js 0.0.LST');
		console.log('       LST is the mission factory address');
		return;
	}

	const contractId = ContractId.fromString(args[0]);

	console.log('\n-Using ENIVRONMENT:', env);
	console.log('\n-Using Operator:', operatorId.toString());
	console.log('\n-Using Contract:', contractId.toString());

	// import ABI
	const lstJSON = JSON.parse(
		fs.readFileSync(
			`./artifacts/contracts/${contractName}.sol/${contractName}.json`,
		),
	);

	const lazySecureTradeIface = new ethers.Interface(lstJSON.abi);

	// query the EVM via mirror node (readOnlyEVMFromMirrorNode) to know
	// 1) tradeNonce

	let encodedCommand = lazySecureTradeIface.encodeFunctionData(
		'tradeNonce',
		[],
	);

	let result = await readOnlyEVMFromMirrorNode(
		env,
		contractId,
		encodedCommand,
		operatorId,
		false,
	);

	const currentTradeNonce = lazySecureTradeIface.decodeFunctionResult(
		'tradeNonce',
		result,
	);

	console.log('Trade Nonce:', Number(currentTradeNonce[0]));

	// lazyToken
	encodedCommand = lazySecureTradeIface.encodeFunctionData(
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

	const lazyToken = lazySecureTradeIface.decodeFunctionResult(
		'lazyToken',
		result,
	);

	console.log('Lazy Token:', lazyToken
		? TokenId.fromSolidityAddress(lazyToken[0]).toString()
		: 'Not Set',
	);

	// get the $LAZY decimal from mirror node
	const lazyTokenDetails = await getTokenDetails(
		env,
		TokenId.fromSolidityAddress(lazyToken[0]).toString(),
	);

	const lazyTokenDecimals = lazyTokenDetails.decimals;

	// lazyCostForTrade

	encodedCommand = lazySecureTradeIface.encodeFunctionData(
		'lazyCostForTrade',
		[],
	);

	result = await readOnlyEVMFromMirrorNode(
		env,
		contractId,
		encodedCommand,
		operatorId,
		false,
	);

	const lazyCostForTrade = lazySecureTradeIface.decodeFunctionResult(
		'lazyCostForTrade',
		result,
	);

	console.log('Lazy Cost For Trade:', Number(lazyCostForTrade[0]) / 10 ** lazyTokenDecimals, '$LAZY');

	// lazyBurnPercentage
	encodedCommand = lazySecureTradeIface.encodeFunctionData(
		'lazyBurnPercentage',
		[],
	);

	result = await readOnlyEVMFromMirrorNode(
		env,
		contractId,
		encodedCommand,
		operatorId,
		false,
	);

	const lazyBurnPercentage = lazySecureTradeIface.decodeFunctionResult(
		'lazyBurnPercentage',
		result,
	);

	console.log('Lazy Burn Percentage:', Number(lazyBurnPercentage[0]), '%');

	// contractSunset
	encodedCommand = lazySecureTradeIface.encodeFunctionData(
		'contractSunset',
		[],
	);

	result = await readOnlyEVMFromMirrorNode(
		env,
		contractId,
		encodedCommand,
		operatorId,
		false,
	);

	const contractSunset = lazySecureTradeIface.decodeFunctionResult(
		'contractSunset',
		result,
	);

	console.log('Contract Sunset:', Number(contractSunset[0]), 'seconds', '(', new Date(Number(contractSunset[0]) * 1000).toUTCString(), ')');

	// LSH_GEN1
	encodedCommand = lazySecureTradeIface.encodeFunctionData(
		'LSH_GEN1',
		[],
	);

	result = await readOnlyEVMFromMirrorNode(
		env,
		contractId,
		encodedCommand,
		operatorId,
		false,
	);

	const LSH_GEN1 = lazySecureTradeIface.decodeFunctionResult(
		'LSH_GEN1',
		result,
	);

	console.log('LSH_GEN1:', LSH_GEN1
		? TokenId.fromSolidityAddress(LSH_GEN1[0]).toString()
		: 'Not Set',
	);

	// LSH_GEN2

	encodedCommand = lazySecureTradeIface.encodeFunctionData(
		'LSH_GEN2',
		[],
	);

	result = await readOnlyEVMFromMirrorNode(
		env,
		contractId,
		encodedCommand,
		operatorId,
		false,
	);

	const LSH_GEN2 = lazySecureTradeIface.decodeFunctionResult(
		'LSH_GEN2',
		result,
	);

	console.log('LSH_GEN2:', LSH_GEN2
		? TokenId.fromSolidityAddress(LSH_GEN2[0]).toString()
		: 'Not Set',
	);

	// lazyGasStation

	encodedCommand = lazySecureTradeIface.encodeFunctionData(
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

	const lazyGasStation = lazySecureTradeIface.decodeFunctionResult(
		'lazyGasStation',
		result,
	);

	console.log('Lazy Gas Station:', lazyGasStation
		? ContractId.fromEvmAddress(0, 0, lazyGasStation[0]).toString()
		: 'Not Set',
	);

	// lazyDelegateRegistry
	encodedCommand = lazySecureTradeIface.encodeFunctionData(
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

	const lazyDelegateRegistry = lazySecureTradeIface.decodeFunctionResult(
		'lazyDelegateRegistry',
		result,
	);

	console.log('Lazy Delegate Registry:', lazyDelegateRegistry
		? ContractId.fromEvmAddress(0, 0, lazyDelegateRegistry[0]).toString()
		: 'Not Set',
	);

	// TODO: on new release add getAdmins / getDeployers
};

main()
	.then(() => {
		process.exit(0);
	})
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
