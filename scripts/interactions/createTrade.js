const {
	Client,
	AccountId,
	PrivateKey,
	ContractId,
	TokenId,
	Hbar,
	HbarUnit,
} = require('@hashgraph/sdk');
require('dotenv').config();
const fs = require('fs');
const { ethers } = require('ethers');
const readlineSync = require('readline-sync');
const { contractExecuteFunction, readOnlyEVMFromMirrorNode } = require('../../utils/solidityHelpers');
const { getArgFlag } = require('../../utils/nodeHelpers');
const { getTokenDetails, checkNFTOwnership } = require('../../utils/hederaMirrorHelpers');
const { setNFTAllowanceAll, setFTAllowance } = require('../../utils/hederaHelpers');

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

const contractName = 'LazySecureTrade';
const LAZY_TOKEN_ID = process.env.LAZY_TOKEN_ID;
const LAZY_GAS_STATION_CONTRACT_ID = process.env.LAZY_GAS_STATION_CONTRACT_ID;

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
			'Environment required, please specify PRIVATE_KEY & ACCOUNT_ID in the .env file',
		);
		process.exit(1);
	}

	if (!LAZY_TOKEN_ID) {
		console.log('ERROR: Must specify LAZY_TOKEN_ID in the .env file');
		process.exit(1);
	}

	if (!LAZY_GAS_STATION_CONTRACT_ID) {
		console.log('ERROR: Must specify LAZY_GAS_STATION_CONTRACT_ID in the .env file');
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
	if (args.length != 1 || getArgFlag('h')) {
		console.log('Usage: createTrade.js 0.0.LST');
		console.log('		LST is the Lazy Secure Trade Contract address');
		console.log('		script runs in interactive mode');
		return;
	}

	// import ABI
	const lstJSON = JSON.parse(
		fs.readFileSync(
			`./artifacts/contracts/${contractName}.sol/${contractName}.json`,
		),
	);

	const lstIface = new ethers.Interface(lstJSON.abi);

	const contractId = ContractId.fromString(args[0]);
	const lazyToken = TokenId.fromString(LAZY_TOKEN_ID);

	console.log('\n-Using ENIVRONMENT:', env);
	console.log('\n-Using Operator:', operatorId.toString());
	console.log('\n-Using Contract:', contractId.toString());

	// get the $LAZY decimal from mirror node
	const lazyTokenDetails = await getTokenDetails(env, lazyToken);
	const lazyTokenDecimals = lazyTokenDetails.decimals;

	if (lazyTokenDecimals == null || lazyTokenDecimals == undefined) {
		console.log('ERROR: Unable to get $LAZY decimals');
		return;
	}

	// ask the user for the token to sell
	const tokenToSell = readlineSync.question('Enter the token to sell: ');
	const serialToSell = readlineSync.question('Enter the serial number: ');

	const token = TokenId.fromString(tokenToSell);
	const serial = parseInt(serialToSell);

	console.log('\n\t...checking user owns the token');

	const nftOwnershipDetails = await checkNFTOwnership(
		env,
		token,
		serial,
	);

	// check nftOwnershipDetails is not null and .account_id is the same as operatorId
	if (nftOwnershipDetails == null || nftOwnershipDetails == undefined) {
		console.log('ERROR: Unable to get NFT ownership details');
		return;
	}

	if (nftOwnershipDetails.owner.toString() != operatorId.toString()) {
		console.log('ERROR: Operator does not own the NFT');
		return;
	}

	// ask the user (strict y/n) if they want to sell to a specified accountc (or anyone)
	const sellToAnyone = readlineSync.keyInYNStrict('Do you want to sell to anyone (n = specific buyer)?');
	let sellTo = null;
	if (!sellToAnyone) {
		const userToSellTo = readlineSync.question('Enter the account to sell to: ');
		sellTo = AccountId.fromString(userToSellTo).toSolidityAddress();
	}
	else {
		sellTo = ethers.ZeroAddress;
	}

	// ask the user for the price in Hbar
	const priceInHbar = readlineSync.question('Enter the price in Hbar: ');

	const tinybars = Number(new Hbar(priceInHbar, HbarUnit.Hbar).toTinybars());

	// ask the user for the price in $LAZY
	const priceInLazy = readlineSync.question('Enter the price in $LAZY: ');

	const lazy = Math.floor(Number(priceInLazy) * 10 ** lazyTokenDecimals);

	if (!sellToAnyone && lazy == 0 && tinybars == 0) {
		console.log('ERROR: A price must be greater than 0 when buyer is not specified');
		return;
	}

	// ask the user for the expiry time (default 0 = no expiry)
	const expiryTime = readlineSync.question('Enter the expiry time (default 0): ');

	let expires = parseInt(expiryTime);

	if (isNaN(expires) || !expires || expires < 0) {
		expires = 0;
	}

	let payForAdvanced = false;
	let lazyCostForTrade = 0;
	if (sellToAnyone) {
		// check if the use has to pay for advanced trades
		// call areAdvancedTradesFree via mirror node

		let encodedCommand = lstIface.encodeFunctionData(
			'areAdvancedTradesFree',
			[operatorId.toSolidityAddress()],
		);

		const aF = await readOnlyEVMFromMirrorNode(
			env,
			contractId,
			encodedCommand,
			operatorId,
			false,
		);

		console.log('\n-Checking if user has to pay for advanced trades', aF);

		const advancedTradesFree = lstIface.decodeFunctionResult('areAdvancedTradesFree', aF);

		payForAdvanced = !advancedTradesFree[0];


		encodedCommand = lstIface.encodeFunctionData(
			'lazyCostForTrade',
			[],
		);

		const cS = await readOnlyEVMFromMirrorNode(
			env,
			contractId,
			encodedCommand,
			operatorId,
			false,
		);

		lazyCostForTrade = Number(lstIface.decodeFunctionResult('lazyCostForTrade', cS)[0]);
	}

	console.log('\n-Using Token:', token.toString());
	console.log('\n-Using Serial:', serial);
	console.log('\n-Selling to:', sellTo == ethers.ZeroAddress ? 'Anyone' : AccountId.fromEvmAddress(0, 0, sellTo).toString());
	console.log('\n-Price in Hbar:', new Hbar(priceInHbar, HbarUnit.Hbar).toString());
	console.log('\n-Price in $LAZY:', lazy / 10 ** lazyTokenDecimals);
	console.log('\n-Expiry time:', expires ? new Date(expires * 1000).toUTCString() : 'Never');

	if (sellToAnyone) {
		console.log('\n-User pays for advanced trades:', payForAdvanced ? 'Yes' : 'No');
		if (payForAdvanced) {
			console.log('\n-Lazy Cost For Advanced Trade:', lazyCostForTrade / 10 ** lazyTokenDecimals);
		}
	}

	const proceed = readlineSync.keyInYNStrict('Do you want to set allowances & create the trade?');
	if (!proceed) {
		console.log('User Aborted');
		return;
	}

	// set allowance for the contract to spend the NFT
	const nftApproval = await setNFTAllowanceAll(
		client,
		[TokenId.fromString(tokenToSell)],
		operatorId,
		AccountId.fromString(contractId.toString()),
	);

	console.log('\n-Setting NFT Allowance:', nftApproval);

	if (payForAdvanced) {
		// set allowance for LGS to spend $LAZY
		const lazyApproval = await setFTAllowance(
			client,
			TokenId.fromString(LAZY_TOKEN_ID),
			operatorId,
			AccountId.fromString(LAZY_GAS_STATION_CONTRACT_ID),
			lazyCostForTrade,
		);

		console.log('\n-Setting $LAZY Allowance:', lazyApproval);
	}

	// check if the token is already associated using isTokenAssociated via mirror node
	const encodedCommand = lstIface.encodeFunctionData(
		'isTokenAssociated',
		[token.toSolidityAddress()],
	);

	const isTokenAssociated = await readOnlyEVMFromMirrorNode(
		env,
		contractId,
		encodedCommand,
		operatorId,
		false,
	);

	const associated = lstIface.decodeFunctionResult('isTokenAssociated', isTokenAssociated);

	let gas = 500_000;

	if (!associated[0]) {
		gas += 950_000;
	}

	if (payForAdvanced) {
		gas += 200_000;
	}

	const result = await contractExecuteFunction(
		contractId,
		lstIface,
		client,
		gas,
		'createTrade',
		[
			token.toSolidityAddress(),
			sellTo,
			serial,
			tinybars,
			lazy,
			expires,
		],
	);

	if (result[0]?.status?.toString() != 'SUCCESS') {
		console.log('Error creating trade:', result);
		return;
	}

	console.log('Trade Created. Transaction ID:', result[2]?.transactionId?.toString());
	console.log('Trade ID:', result[1]?.toString());
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
