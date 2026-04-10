/**
 * Cancel a Bid via BidderContract (stash)
 *
 * Usage: node cancelBid.js <stashContractId> <bidId>
 *   - bidId: bytes32 bid identifier
 */
const { Client, AccountId, PrivateKey, ContractId } = require('@hashgraph/sdk');
const { ethers } = require('ethers');
const fs = require('fs');
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
	if (args.length !== 2) {
		console.log('Usage: node cancelBid.js <stashContractId> <bidId>');
		process.exit(1);
	}

	const stashContractId = ContractId.fromString(args[0]);
	const bidId = args[1];

	if (!bidId.startsWith('0x') || bidId.length !== 66) {
		console.log('ERROR: bidId must be a bytes32 hex string (0x + 64 hex chars)');
		process.exit(1);
	}

	const stashJson = JSON.parse(fs.readFileSync('./artifacts/contracts/BidderContract.sol/BidderContract.json'));
	const stashIface = new ethers.Interface(stashJson.abi);

	console.log('Environment:', env);
	console.log('Operator:', operatorId.toString());
	console.log('Stash:', stashContractId.toString());
	console.log('Bid ID:', bidId);

	const result = await contractExecuteFunction(
		stashContractId,
		stashIface,
		client,
		300_000,
		'cancelBid',
		[bidId],
	);

	if (result[0]?.status?.toString() !== 'SUCCESS') {
		console.log('ERROR cancelling bid:', result);
		process.exit(1);
	}

	console.log('Bid cancelled successfully.');
	console.log('Transaction ID:', result[2]?.transactionId?.toString());
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
