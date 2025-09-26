const {
	Client,
	AccountId,
	PrivateKey,
	Hbar,
	HbarUnit,
} = require('@hashgraph/sdk');
require('dotenv').config();
const { getArgFlag, getArg } = require('../../utils/nodeHelpers');
const readlineSync = require('readline-sync');
const { checkMirrorHbarBalance } = require('../../utils/hederaMirrorHelpers');
const { sweepHbar } = require('../../utils/hederaHelpers');

let operatorId;
let operatorKey;

try {
	operatorId = AccountId.fromString(process.env.ACCOUNT_ID);

	// Try to parse the operator key with gentle error handling
	const operatorKeyString = process.env.PRIVATE_KEY;
	if (!operatorKeyString) {
		throw new Error('PRIVATE_KEY not found in environment');
	}

	// Try Ed25519 first, then ECDSA as fallback
	try {
		operatorKey = PrivateKey.fromStringED25519(operatorKeyString);
		console.log('Successfully parsed operator key as Ed25519');
	}
	catch (err) {
		console.log('Failed to parse operator key as Ed25519, trying ECDSA...');
		try {
			operatorKey = PrivateKey.fromStringECDSA(operatorKeyString);
			console.log('Successfully parsed operator key as ECDSA');
		}
		catch (err2) {
			throw new Error(`Failed to parse operator key as both Ed25519 and ECDSA: ${err2.message}`);
		}
	}
}
catch (err) {
	console.log('ERROR: Must specify PRIVATE_KEY & ACCOUNT_ID in the .env file');
	console.log('Details:', err.message);
	process.exit(1);
}

async function scoopTestHbar() {
	// check args for an account ot send to and a percentage of the total to send
	const toAccount = getArg('to');
	const percent = Number(getArg('percent'));

	if (getArgFlag('h') || getArgFlag('help')) {
		console.log('Usage: node scoopTestHbar.js -to 0.0.1234 -percent 50');
		process.exit(0);
	}

	const to = AccountId.fromString(toAccount);
	const percentage = parseInt(percent);


	if (!toAccount) {
		console.log('ERROR: Must specify -to to send to an account');
		process.exit(1);
	}

	if (!percent) {
		console.log('ERROR: Must specify -percent to send a percentage of the total');
		process.exit(1);
	}

	// pull the SCOOP_ACCOUNTS from the .env file
	if (!process.env.SCOOP_ACCOUNTS) {
		console.log('ERROR: Must specify SCOOP_ACCOUNTS in the .env file');
		console.log('Please uncomment and set SCOOP_ACCOUNTS=0.0.1234,0.0.5678 in your .env file');
		process.exit(1);
	}

	const scoopAccounts = process.env.SCOOP_ACCOUNTS.split(',').map((account) => {
		return AccountId.fromString(account.trim());
	});

	// get the keys from the .env file with gentle error handling - try both key types
	if (!process.env.SCOOP_KEYS) {
		console.log('ERROR: Must specify SCOOP_KEYS in the .env file');
		console.log('Please uncomment and set SCOOP_KEYS with corresponding private keys in your .env file');
		process.exit(1);
	}

	const keys = [];
	const keyStrings = process.env.SCOOP_KEYS.split(',');
	keyStrings.forEach((keyString, index) => {
		let key = null;
		let keyValue = keyString;

		// If the key has a prefix like 'e:', extract the actual key value
		if (keyString.includes(':')) {
			keyValue = keyString.split(':')[1];
		}

		// Try ECDSA first if it starts with 'e' or looks like an ECDSA key
		if (keyString.startsWith('e') || keyString.startsWith('0x')) {
			try {
				key = PrivateKey.fromStringECDSA(keyValue);
				console.log(`Successfully parsed key ${index + 1} as ECDSA`);
			}
			catch (err) {
				console.log(`Failed to parse key ${index + 1} as ECDSA, trying Ed25519...`);
				try {
					key = PrivateKey.fromStringED25519(keyValue);
					console.log(`Successfully parsed key ${index + 1} as Ed25519`);
				}
				catch (err2) {
					console.error(`ERROR: Failed to parse key ${index + 1} as both ECDSA and Ed25519:`, err2.message);
					process.exit(1);
				}
			}
		}
		else {
			// Try Ed25519 first, then ECDSA as fallback
			try {
				key = PrivateKey.fromStringED25519(keyValue);
				console.log(`Successfully parsed key ${index + 1} as Ed25519`);
			}
			catch (err) {
				console.log(`Failed to parse key ${index + 1} as Ed25519, trying ECDSA...`);
				try {
					key = PrivateKey.fromStringECDSA(keyValue);
					console.log(`Successfully parsed key ${index + 1} as ECDSA`);
				}
				catch (err2) {
					console.error(`ERROR: Failed to parse key ${index + 1} as both Ed25519 and ECDSA:`, err2.message);
					process.exit(1);
				}
			}
		}

		if (key) {
			keys.push(key);
		}
	});

	// Validate that we have matching accounts and keys
	if (scoopAccounts.length !== keys.length) {
		console.error(`ERROR: Mismatch between SCOOP_ACCOUNTS (${scoopAccounts.length}) and SCOOP_KEYS (${keys.length})`);
		console.error('Each account must have a corresponding private key');
		process.exit(1);
	}

	console.log(`Successfully loaded ${scoopAccounts.length} accounts with matching private keys`);

	const balances = [];
	const sendAmounts = [];

	const client = Client.forTestnet();
	client.setOperator(operatorId, operatorKey);

	// get the balances of the accounts
	for (let i = 0; i < scoopAccounts.length; i++) {
		const balance = await checkMirrorHbarBalance('test', scoopAccounts[i]);
		balances.push(Number(balance));
		sendAmounts.push(Math.floor(Number(balance) * (percentage / 100)));
	}

	// display the balances we are pulling
	console.log('**TESTNET**');
	console.log('Sccop Accounts:', scoopAccounts.map((account) => account.toString()).join(', '));
	console.log('Balances:', balances.map((balance) => new Hbar(balance, HbarUnit.Tinybar).toString()).join(', '));
	console.log('Percent to send:', percentage, '%');
	console.log('Total to send:', new Hbar(balances.reduce((a, b) => a + b, 0), HbarUnit.Tinybar).toString());

	// confirm the send
	const confirm = readlineSync.keyInYNStrict('Send the above amounts?');
	if (!confirm) {
		console.log('Exiting');
		process.exit(0);
	}

	// send the amounts
	for (let i = 0; i < scoopAccounts.length; i++) {
		const amount = new Hbar(sendAmounts[i], HbarUnit.Tinybar);
		const result = await sweepHbar(client, scoopAccounts[i], keys[i], to, amount);
		console.log('Sent', amount.toString(), 'from', scoopAccounts[i].toString(), 'to', to.toString(), 'with result', result);
	}

}

scoopTestHbar()
	.then(() => {
		console.log('Done');
		process.exit(0);
	})
	.catch((err) => {
		console.error(err);
		process.exit(1);
	});