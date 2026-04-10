/**
 * Detach BidderContract from Factory (IRREVERSIBLE)
 *
 * Usage: node detachFromFactory.js <stashContractId>
 *   - Permanently severs the stash's factory link
 *   - After detach: withdrawals work, factory-mediated flows (bids, arb) do not
 *   - Requires interactive confirmation
 */
const { Client, AccountId, PrivateKey, ContractId } = require('@hashgraph/sdk');
const { ethers } = require('ethers');
const fs = require('fs');
const readlineSync = require('readline-sync');
const { contractExecuteFunction } = require('../../utils/solidityHelpers');
require('dotenv').config();

async function main() {
	const operatorKey = PrivateKey.fromStringED25519(process.env.PRIVATE_KEY);
	const operatorId = AccountId.fromString(process.env.ACCOUNT_ID);
	const env = process.env.ENVIRONMENT ?? null;
	if (!env) { console.log('ERROR: ENVIRONMENT not set'); process.exit(1); }

	let client;
	if (env.toUpperCase() === 'TEST') client = Client.forTestnet();
	else if (env.toUpperCase() === 'MAIN') client = Client.forMainnet();
	else if (env.toUpperCase() === 'PREVIEW') client = Client.forPreviewnet();
	else if (env.toUpperCase() === 'LOCAL') {
		client = Client.forNetwork({ '127.0.0.1:50211': new AccountId(3) }).setMirrorNetwork('127.0.0.1:5600');
	}
	else { console.log('ERROR: Unsupported ENVIRONMENT'); process.exit(1); }
	client.setOperator(operatorId, operatorKey);

	const args = process.argv.slice(2);
	if (args.length !== 1) {
		console.log('Usage: node detachFromFactory.js <stashContractId>');
		process.exit(1);
	}

	const stashContractId = ContractId.fromString(args[0]);
	const stashJson = JSON.parse(fs.readFileSync('./artifacts/contracts/BidderContract.sol/BidderContract.json'));
	const stashIface = new ethers.Interface(stashJson.abi);

	console.log('Environment:', env);
	console.log('Operator:', operatorId.toString());
	console.log('Stash:', stashContractId.toString());
	console.log('\nWARNING: This is IRREVERSIBLE.');
	console.log('After detaching, the stash can no longer participate in bidding.');
	console.log('You will need to deploy a fresh stash to bid again.\n');

	const confirm = readlineSync.question('Type "DETACH" to confirm: ');
	if (confirm !== 'DETACH') {
		console.log('Aborted.');
		process.exit(0);
	}

	const result = await contractExecuteFunction(
		stashContractId,
		stashIface,
		client,
		200_000,
		'detachFromFactory',
		[],
	);

	if (result[0]?.status?.toString() !== 'SUCCESS') {
		console.log('ERROR detaching from factory:', result);
		process.exit(1);
	}

	console.log('Stash detached from factory successfully.');
	console.log('Transaction ID:', result[2]?.transactionId?.toString());
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
