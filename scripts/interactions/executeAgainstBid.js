/**
 * Execute Against a Bid (seller-initiated) via BidderContractFactory
 *
 * Usage: node executeAgainstBid.js <factoryContractId> <bidId> <nftTokenId> <serial>
 *   - Seller calls this to sell their NFT directly to a bidder at the bid price
 *   - Seller must have NFT allowance set for the LST contract
 */
const { Client, AccountId, PrivateKey, ContractId, TokenId } = require('@hashgraph/sdk');
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
	if (args.length !== 4) {
		console.log('Usage: node executeAgainstBid.js <factoryContractId> <bidId> <nftTokenId> <serial>');
		process.exit(1);
	}

	const factoryContractId = ContractId.fromString(args[0]);
	const bidId = args[1];
	const nftToken = TokenId.fromString(args[2]);
	const serial = parseInt(args[3]);

	const factoryJson = JSON.parse(fs.readFileSync('./artifacts/contracts/BidderContractFactory.sol/BidderContractFactory.json'));
	const factoryIface = new ethers.Interface(factoryJson.abi);

	console.log('Environment:', env);
	console.log('Operator (seller):', operatorId.toString());
	console.log('Factory:', factoryContractId.toString());
	console.log('Bid ID:', bidId);
	console.log('NFT Token:', nftToken.toString());
	console.log('Serial:', serial);

	const result = await contractExecuteFunction(
		factoryContractId,
		factoryIface,
		client,
		1_500_000,
		'executeAgainstBid',
		[bidId, nftToken.toSolidityAddress(), serial],
	);

	if (result[0]?.status?.toString() !== 'SUCCESS') {
		console.log('ERROR executing against bid:', result);
		process.exit(1);
	}

	console.log('Bid executed successfully.');
	console.log('Transaction ID:', result[2]?.transactionId?.toString());
	console.log('Trade ID:', result[1]?.[0]);
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
