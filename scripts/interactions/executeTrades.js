const {
	Client,
	AccountId,
	PrivateKey,
	ContractId,
	TokenId,
	HbarUnit,
} = require('@hashgraph/sdk');
require('dotenv').config();
const fs = require('fs');
const { ethers } = require('ethers');
const readlineSync = require('readline-sync');
const { contractExecuteFunction, readOnlyEVMFromMirrorNode } = require('../../utils/solidityHelpers');
const { getArgFlag, isBytes32 } = require('../../utils/nodeHelpers');
const { checkMirrorBalance, checkMirrorHbarBalance } = require('../../utils/hederaMirrorHelpers');
const { setFTAllowance, setHbarAllowance, associateTokenToAccount } = require('../../utils/hederaHelpers');

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
	if (args.length < 2 || getArgFlag('h')) {
		console.log('Usage: executeTrades.js 0.0.LST [-i | hash1 hash2 ...]');
		console.log('		LST is the Lazy Secure Trade Contract address');
		console.log('		-i to interactively enter tokens/serials to obtain hashes');
		console.log('		hash1 hash2 ... are the hashes of the trades to execute (max 5)');
		console.log('		Example: executeTrades.js 0.0.123456 0xabc123... 0xdef456...');
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

	let hashes = [];

	if (getArgFlag('i')) {
		// Interactive mode - get trade hashes from token/serial pairs
		console.log('\n=== Interactive Mode ===');
		const numTrades = parseInt(readlineSync.question('How many trades to execute (max 5)? '));

		if (numTrades <= 0 || numTrades > 5) {
			console.log('ERROR: Number of trades must be between 1 and 5');
			return;
		}

		for (let i = 0; i < numTrades; i++) {
			console.log(`\n--- Trade ${i + 1} ---`);
			const tokenToExecute = readlineSync.question('Enter the token address: ');
			const serialToExecute = readlineSync.question('Enter the serial number: ');

			const token = TokenId.fromString(tokenToExecute);
			const serial = parseInt(serialToExecute);

			console.log('-Using Token:', token.toString());
			console.log('-Using Serial:', serial);

			const hash = ethers.solidityPackedKeccak256(['address', 'uint256'], [token.toSolidityAddress(), serial]);
			hashes.push(hash);

			console.log('-Generated Hash:', hash);
		}
	}
	else {
		// Use provided hashes
		hashes = args.slice(1);

		if (hashes.length > 5) {
			console.log('ERROR: Maximum 5 trades can be executed in one batch');
			return;
		}

		// Validate all hashes
		for (const hash of hashes) {
			if (!isBytes32(hash)) {
				console.log(`ERROR: Invalid hash format: ${hash}`);
				return;
			}
		}
	}

	console.log(`\n-Executing ${hashes.length} trades with hashes:`, hashes);

	// Verify all trades exist and calculate total costs
	console.log('\n=== Verifying Trades ===');
	let totalHbarNeeded = 0;
	let totalLazyNeeded = 0;
	const tradeDetails = [];

	for (let i = 0; i < hashes.length; i++) {
		const hash = hashes[i];
		console.log(`\nChecking trade ${i + 1}: ${hash}`);

		const eC = lstIface.encodeFunctionData('getTrade', [hash]);
		const cS = await readOnlyEVMFromMirrorNode(env, contractId, eC, operatorId, false);
		const tradeDets = lstIface.decodeFunctionResult('getTrade', cS)[0];

		// check if the trade exists [seller <> ZeroAddress]
		if (tradeDets[0] == ethers.ZeroAddress) {
			console.log(`ERROR: Trade ${i + 1} does not exist - exiting`);
			return;
		}

		// check if user can execute (is buyer or open trade)
		const isBuyer = tradeDets[1].slice(2).toLowerCase() == operatorId.toSolidityAddress();
		const isOpenTrade = tradeDets[1] == ethers.ZeroAddress;

		if (!isBuyer && !isOpenTrade) {
			console.log(`ERROR: Operator is not the buyer for trade ${i + 1} and it's not an open trade - unable to execute - exiting`);
			return;
		}

		const tinybarPrice = BigInt(tradeDets[4]);
		const lazyPrice = BigInt(tradeDets[5]);

		totalHbarNeeded += tinybarPrice;
		totalLazyNeeded += lazyPrice;

		tradeDetails.push({
			seller: tradeDets[0],
			buyer: tradeDets[1],
			token: tradeDets[2],
			serial: tradeDets[3],
			tinybarPrice: tinybarPrice,
			lazyPrice: lazyPrice,
			expiryTime: tradeDets[6],
		});

		console.log(`✓ Trade ${i + 1} verified - can execute`);
		console.log(`  Seller: ${tradeDets[0]}`);
		console.log(`  Buyer: ${tradeDets[1]}`);
		console.log(`  Token: ${tradeDets[2]}`);
		console.log(`  Serial: ${tradeDets[3]}`);
		console.log(`  HBAR Price: ${Number(tinybarPrice) / 100_000_000} HBAR`);
		console.log(`  LAZY Price: ${lazyPrice} LAZY`);
	}

	console.log('\n=== Total Cost Summary ===');
	console.log(`Total HBAR needed: ${Number(totalHbarNeeded) / 100_000_000} HBAR`);
	console.log(`Total LAZY needed: ${totalLazyNeeded} LAZY`);

	// Check balances and set allowances
	console.log('\n=== Checking Balances and Setting Allowances ===');

	// Check HBAR balance
	if (totalHbarNeeded > 0) {
		const hbarBalance = await checkMirrorHbarBalance(operatorId.toString());
		console.log(`Current HBAR balance: ${hbarBalance / 100_000_000} HBAR`);

		if (BigInt(hbarBalance) < totalHbarNeeded) {
			console.log('ERROR: Insufficient HBAR balance');
			return;
		}

		// Set HBAR allowance for the total amount needed
		const hbarAllowanceNeeded = Number(totalHbarNeeded) / 100_000_000;
		console.log(`Setting HBAR allowance for ${hbarAllowanceNeeded} HBAR...`);

		await setHbarAllowance(client, operatorId, contractId, hbarAllowanceNeeded, HbarUnit.Hbar);
		console.log('✓ HBAR allowance set');
	}

	// Check LAZY balance and set allowance
	if (totalLazyNeeded > 0) {
		const lazyBalance = await checkMirrorBalance(operatorId.toString(), LAZY_TOKEN_ID);
		console.log(`Current LAZY balance: ${lazyBalance} LAZY`);

		if (BigInt(lazyBalance) < totalLazyNeeded) {
			console.log('ERROR: Insufficient LAZY balance');
			return;
		}

		console.log(`Setting LAZY allowance for ${totalLazyNeeded} LAZY...`);
		await setFTAllowance(client, TokenId.fromString(LAZY_TOKEN_ID), operatorId, contractId, Number(totalLazyNeeded));
		console.log('✓ LAZY allowance set');
	}

	// Associate tokens if needed
	console.log('\n=== Checking Token Associations ===');
	const uniqueTokens = [...new Set(tradeDetails.map(trade => trade.token))];

	for (const tokenAddr of uniqueTokens) {
		try {
			const tokenId = TokenId.fromSolidityAddress(tokenAddr);
			console.log(`Associating token ${tokenId.toString()}...`);
			await associateTokenToAccount(client, operatorId, operatorKey, [tokenId]);
			console.log(`✓ Token ${tokenId.toString()} associated`);
		}
		catch (error) {
			console.log(`Note: Token association may have failed (probably already associated): ${error.message}`);
		}
	}

	const proceed = readlineSync.keyInYNStrict(`Do you want to execute all ${hashes.length} trades?`);
	if (!proceed) {
		console.log('User Aborted');
		return;
	}

	// Calculate gas needed
	const gas = 500_000 + (hashes.length * 100_000);

	console.log('\n=== Executing Batch Trade ===');
	const result = await contractExecuteFunction(
		contractId,
		lstIface,
		client,
		gas,
		'executeTrades',
		[hashes],
		Number(totalHbarNeeded),
		HbarUnit.Tinybar,
	);

	if (result[0]?.status?.toString() != 'SUCCESS') {
		console.log('Error executing trades:', result);
		return;
	}

	console.log(`✓ ${hashes.length} trades executed successfully!`);
	console.log('Transaction ID:', result[2]?.transactionId?.toString());
	console.log(`Total paid: ${Number(totalHbarNeeded) / 100_000_000} HBAR + ${totalLazyNeeded} LAZY`);
};

main()
	.then(() => {
		process.exit(0);
	})
	.catch(error => {
		console.error(error);
		process.exit(1);
	});