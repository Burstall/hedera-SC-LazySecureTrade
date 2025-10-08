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
		console.log('Usage: createBatchTrade.js 0.0.LST');
		console.log('		LST is the Lazy Secure Trade Contract address');
		console.log('		Interactive mode will guide you through creating a batch trade');
		return;
	}

	// import ABI
	const lstJSON = JSON.parse(
		fs.readFileSync(
			`./artifacts/contracts/${contractName}.sol/${contractName}.json`,
		),
	);

	const lstIface = ethers.Interface.from(lstJSON.abi);
	const contractId = ContractId.fromString(args[0]);

	console.log('\n-Using Operator:', operatorId.toString());
	console.log('\n-Using LST Contract:', contractId.toString());

	console.log('\n=== Creating Batch Trade ===');
	console.log('A batch trade allows you to sell multiple NFTs as a single atomic transaction');
	console.log('All NFTs must be sold together or the transaction fails');
	console.log('Maximum 22 NFTs per batch');

	// Get buyer address
	let buyerAddr = ethers.ZeroAddress;
	const isOpenTrade = readlineSync.keyInYNStrict('Is this an open market trade (anyone can buy)?');

	if (!isOpenTrade) {
		const buyerInput = readlineSync.question('Enter buyer address (0.0.XXXX): ');
		const buyerId = AccountId.fromString(buyerInput);
		buyerAddr = buyerId.toSolidityAddress();
		console.log('-Buyer:', buyerAddr);
	}
	else {
		console.log('-Open market trade (buyer: anyone)');
	}

	// Get expiry time
	let expiryTime = 0;
	const hasExpiry = readlineSync.keyInYNStrict('Does this trade have an expiry time?');

	if (hasExpiry) {
		const hours = parseInt(readlineSync.question('Expiry in hours from now: '));
		expiryTime = Math.floor(Date.now() / 1000) + (hours * 3600);
		console.log('-Expiry time:', new Date(expiryTime * 1000).toISOString());
	}

	// Get number of token types
	const numTokenTypes = parseInt(readlineSync.question('How many different token types in this batch (max 10)? '));

	if (numTokenTypes <= 0 || numTokenTypes > 10) {
		console.log('ERROR: Number of token types must be between 1 and 10');
		return;
	}

	const tokens = [];
	const serials = [];
	const tinybarPrices = [];
	const lazyPrices = [];
	let totalItems = 0;

	// Collect data for each token type
	for (let t = 0; t < numTokenTypes; t++) {
		console.log(`\n--- Token Type ${t + 1} ---`);

		const tokenInput = readlineSync.question('Enter token address (0.0.XXXX): ');
		const tokenId = TokenId.fromString(tokenInput);
		const tokenAddr = tokenId.toSolidityAddress();
		tokens.push(tokenAddr);

		console.log('-Token:', tokenId.toString());

		// Get token details
		const tokenDetails = await getTokenDetails(tokenId.toString());
		console.log(`-Token Name: ${tokenDetails.name} (${tokenDetails.symbol})`);

		// Get number of NFTs for this token
		const numNFTs = parseInt(readlineSync.question(`How many NFTs of token ${tokenId.toString()}? `));

		if (numNFTs <= 0) {
			console.log('ERROR: Must specify at least 1 NFT');
			return;
		}

		totalItems += numNFTs;
		if (totalItems > 22) {
			console.log('ERROR: Total NFTs across all tokens cannot exceed 22');
			return;
		}

		const tokenSerials = [];
		const tokenTinybarPrices = [];
		const tokenLazyPrices = [];

		// Collect data for each NFT of this token
		for (let n = 0; n < numNFTs; n++) {
			console.log(`\n  NFT ${n + 1} of ${numNFTs} for token ${tokenId.toString()}`);

			const serial = parseInt(readlineSync.question('  Serial number: '));
			tokenSerials.push(serial);

			// Verify ownership
			const ownership = await checkNFTOwnership(tokenId.toString(), serial, operatorId.toString());
			if (!ownership.isOwned) {
				console.log(`ERROR: You do not own serial ${serial} of token ${tokenId.toString()}`);
				return;
			}
			console.log(`  ✓ Ownership verified for serial ${serial}`);

			const hbarPrice = parseFloat(readlineSync.question('  Price in HBAR (0 for free): '));
			const tinybarPrice = Math.floor(hbarPrice * 100_000_000);
			tokenTinybarPrices.push(tinybarPrice);

			const lazyPrice = parseInt(readlineSync.question('  Price in LAZY tokens (0 for none): '));
			tokenLazyPrices.push(lazyPrice);

			console.log(`  -Serial: ${serial}, HBAR: ${hbarPrice}, LAZY: ${lazyPrice}`);
		}

		serials.push(tokenSerials);
		tinybarPrices.push(tokenTinybarPrices);
		lazyPrices.push(tokenLazyPrices);
	}

	console.log('\n=== Batch Trade Summary ===');
	console.log(`Total NFTs: ${totalItems}`);
	console.log(`Token types: ${numTokenTypes}`);
	console.log(`Buyer: ${buyerAddr === ethers.ZeroAddress ? 'Open market' : buyerAddr}`);
	console.log(`Expiry: ${expiryTime === 0 ? 'No expiry' : new Date(expiryTime * 1000).toISOString()}`);

	for (let t = 0; t < numTokenTypes; t++) {
		const tokenId = TokenId.fromSolidityAddress(tokens[t]);
		console.log(`\nToken ${t + 1}: ${tokenId.toString()}`);
		for (let n = 0; n < serials[t].length; n++) {
			const hbarPrice = tinybarPrices[t][n] / 100_000_000;
			console.log(`  Serial ${serials[t][n]}: ${hbarPrice} HBAR + ${lazyPrices[t][n]} LAZY`);
		}
	}

	// Check if we need $LAZY for gas (open market trades)
	if (buyerAddr === ethers.ZeroAddress) {
		console.log('\n=== Setting LAZY Allowance for Gas ===');
		console.log('Open market trades require LAZY tokens for gas');

		// Check if user has LSH tokens for free trades
		const eCFreeTrades = lstIface.encodeFunctionData('areAdvancedTradesFree', [operatorId.toSolidityAddress()]);
		const cSFreeTrades = await readOnlyEVMFromMirrorNode(env, contractId, eCFreeTrades, operatorId, false);
		const areTradesFree = lstIface.decodeFunctionResult('areAdvancedTradesFree', cSFreeTrades)[0];

		if (areTradesFree) {
			console.log('✓ You own LSH tokens - batch trade creation is FREE!');
		}
		else {
			const eLazyCost = lstIface.encodeFunctionData('lazyCostForTrade', []);
			const cSLazyCost = await readOnlyEVMFromMirrorNode(env, contractId, eLazyCost, operatorId, false);
			const lazyCostPerTrade = lstIface.decodeFunctionResult('lazyCostForTrade', cSLazyCost)[0];

			console.log(`$LAZY cost per individual trade: ${lazyCostPerTrade}`);
			console.log('Note: Batch trades use a different fee structure - setting allowance for safety');

			// Conservative allowance
			const lazyAllowance = Number(lazyCostPerTrade) * 5;
			console.log(`Setting LAZY allowance for ${lazyAllowance} tokens...`);

			await setFTAllowance(client, TokenId.fromString(LAZY_TOKEN_ID), operatorId, ContractId.fromString(LAZY_GAS_STATION_CONTRACT_ID), lazyAllowance);
			console.log('✓ LAZY allowance set');
		}
	}

	// Set NFT allowances
	console.log('\n=== Setting NFT Allowances ===');
	const uniqueTokens = [...new Set(tokens)];

	for (const tokenAddr of uniqueTokens) {
		const tokenId = TokenId.fromSolidityAddress(tokenAddr);
		console.log(`Setting allowance for token ${tokenId.toString()}...`);
		await setNFTAllowanceAll(client, tokenId, operatorId, contractId);
		console.log(`✓ Allowance set for ${tokenId.toString()}`);
	}

	const proceed = readlineSync.keyInYNStrict(`Create batch trade with ${totalItems} NFTs?`);
	if (!proceed) {
		console.log('User Aborted');
		return;
	}

	const gas = 800_000 + (totalItems * 50_000);
	console.log(`\nUsing gas limit: ${gas}`);

	console.log('\n=== Creating Batch Trade ===');
	const result = await contractExecuteFunction(
		contractId,
		lstIface,
		client,
		gas,
		'createBatchTrade',
		[
			tokens,
			serials,
			tinybarPrices,
			lazyPrices,
			buyerAddr,
			expiryTime,
		],
	);

	if (result[0]?.status?.toString() != 'SUCCESS') {
		console.log('Error creating batch trade:', result);
		return;
	}

	console.log('✓ Batch trade created successfully!');
	console.log('Transaction ID:', result[2]?.transactionId?.toString());

	// Try to extract batch ID from events
	console.log('\nNote: The batch trade ID can be found in the transaction logs/events');
	console.log('Use getBatchTradesForUser or similar queries to retrieve the batch ID');
};

main()
	.then(() => {
		process.exit(0);
	})
	.catch(error => {
		console.error(error);
		process.exit(1);
	});