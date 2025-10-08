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
		console.log('Usage: createMultipleTrades.js 0.0.LST');
		console.log('		LST is the Lazy Secure Trade Contract address');
		console.log('		Interactive mode will guide you through creating multiple individual trades');
		console.log('		Note: These are independent trades, not atomic like batch trades');
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

	console.log('\n=== Creating Multiple Individual Trades ===');
	console.log('This creates multiple independent trades in one transaction');
	console.log('Each trade is separate - buyers can purchase them individually');
	console.log('Unlike batch trades, these do not need to be bought together');

	// Get buyer address
	let buyerAddr = ethers.ZeroAddress;
	const isOpenTrade = readlineSync.keyInYNStrict('Are these open market trades (anyone can buy)?');

	if (!isOpenTrade) {
		const buyerInput = readlineSync.question('Enter buyer address for ALL trades (0.0.XXXX): ');
		const buyerId = AccountId.fromString(buyerInput);
		buyerAddr = buyerId.toSolidityAddress();
		console.log('-Buyer for all trades:', buyerAddr);
	}
	else {
		console.log('-Open market trades (buyer: anyone)');
	}

	// Get expiry time
	let expiryTime = 0;
	const hasExpiry = readlineSync.keyInYNStrict('Do these trades have an expiry time?');

	if (hasExpiry) {
		const hours = parseInt(readlineSync.question('Expiry in hours from now: '));
		expiryTime = Math.floor(Date.now() / 1000) + (hours * 3600);
		console.log('-Expiry time:', new Date(expiryTime * 1000).toISOString());
	}

	// Get number of unique token types
	const numTokenTypes = parseInt(readlineSync.question('How many different token types (max 10)? '));

	if (numTokenTypes <= 0 || numTokenTypes > 10) {
		console.log('ERROR: Number of token types must be between 1 and 10');
		return;
	}

	const uniqueTokens = [];
	const serialsPerToken = [];
	const tinybarPricesPerToken = [];
	const lazyPricesPerToken = [];
	let totalTrades = 0;

	// Collect data for each token type
	for (let t = 0; t < numTokenTypes; t++) {
		console.log(`\n--- Token Type ${t + 1} ---`);

		const tokenInput = readlineSync.question('Enter token address (0.0.XXXX): ');
		const tokenId = TokenId.fromString(tokenInput);
		const tokenAddr = tokenId.toSolidityAddress();
		uniqueTokens.push(tokenAddr);

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

		totalTrades += numNFTs;
		if (totalTrades > 50) {
			console.log('ERROR: Total trades cannot exceed 50 for gas efficiency');
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

		serialsPerToken.push(tokenSerials);
		tinybarPricesPerToken.push(tokenTinybarPrices);
		lazyPricesPerToken.push(tokenLazyPrices);
	}

	console.log('\n=== Multiple Trades Summary ===');
	console.log(`Total individual trades: ${totalTrades}`);
	console.log(`Token types: ${numTokenTypes}`);
	console.log(`Buyer: ${buyerAddr === ethers.ZeroAddress ? 'Open market' : buyerAddr}`);
	console.log(`Expiry: ${expiryTime === 0 ? 'No expiry' : new Date(expiryTime * 1000).toISOString()}`);

	for (let t = 0; t < numTokenTypes; t++) {
		const tokenId = TokenId.fromSolidityAddress(uniqueTokens[t]);
		console.log(`\nToken ${t + 1}: ${tokenId.toString()}`);
		for (let n = 0; n < serialsPerToken[t].length; n++) {
			const hbarPrice = tinybarPricesPerToken[t][n] / 100_000_000;
			console.log(`  Serial ${serialsPerToken[t][n]}: ${hbarPrice} HBAR + ${lazyPricesPerToken[t][n]} LAZY`);
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
			console.log('✓ You own LSH tokens - trade creation is FREE!');
		}
		else {
			const eLazyCost = lstIface.encodeFunctionData('lazyCostForTrade', []);
			const cSLazyCost = await readOnlyEVMFromMirrorNode(env, contractId, eLazyCost, operatorId, false);
			const lazyCostPerTrade = lstIface.decodeFunctionResult('lazyCostForTrade', cSLazyCost)[0];

			const totalLazyCost = Number(lazyCostPerTrade) * totalTrades;
			console.log(`$LAZY cost per trade: ${lazyCostPerTrade}`);
			console.log(`Total $LAZY needed: ${totalLazyCost} tokens`);

			await setFTAllowance(client, TokenId.fromString(LAZY_TOKEN_ID), operatorId, ContractId.fromString(LAZY_GAS_STATION_CONTRACT_ID), totalLazyCost);
			console.log('✓ LAZY allowance set');
		}
	}

	// Set NFT allowances
	console.log('\n=== Setting NFT Allowances ===');

	for (const tokenAddr of uniqueTokens) {
		const tokenId = TokenId.fromSolidityAddress(tokenAddr);
		console.log(`Setting allowance for token ${tokenId.toString()}...`);
		await setNFTAllowanceAll(client, tokenId, operatorId, contractId);
		console.log(`✓ Allowance set for ${tokenId.toString()}`);
	}

	const proceed = readlineSync.keyInYNStrict(`Create ${totalTrades} individual trades?`);
	if (!proceed) {
		console.log('User Aborted');
		return;
	}

	const gas = 500_000 + (totalTrades * 80_000);
	console.log(`\nUsing gas limit: ${gas}`);

	console.log('\n=== Creating Multiple Trades ===');
	const result = await contractExecuteFunction(
		contractId,
		lstIface,
		client,
		gas,
		'createMultipleTrades',
		[
			uniqueTokens,
			serialsPerToken,
			buyerAddr,
			tinybarPricesPerToken,
			lazyPricesPerToken,
			expiryTime,
		],
	);

	if (result[0]?.status?.toString() != 'SUCCESS') {
		console.log('Error creating multiple trades:', result);
		return;
	}

	console.log(`✓ ${totalTrades} individual trades created successfully!`);
	console.log('Transaction ID:', result[2]?.transactionId?.toString());
	console.log('\nNote: Each trade is independent and can be purchased separately');
	console.log('Use existing scripts like executeTrade.js or cancelTrade.js to manage individual trades');
};

main()
	.then(() => {
		process.exit(0);
	})
	.catch(error => {
		console.error(error);
		process.exit(1);
	});