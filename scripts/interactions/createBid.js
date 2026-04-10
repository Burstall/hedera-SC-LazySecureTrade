/**
 * Create a Bid via BidderContract (stash)
 *
 * Usage: node createBid.js <stashContractId> <nftTokenId> <serial|"any"> <hbarAmount> <lazyAmount> <expiry> <minAcceptablePrice>
 *   - serial: comma-separated serials or "any" for collection-wide bid
 *   - hbarAmount/lazyAmount: in tinybars / smallest LAZY unit
 *   - expiry: unix timestamp (0 = no expiry)
 *   - minAcceptablePrice: minimum tinybar trade price for arbitrage (0 = any)
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
	if (args.length !== 7) {
		console.log('Usage: node createBid.js <stashContractId> <nftTokenId> <serial|"any"> <hbarAmount> <lazyAmount> <expiry> <minAcceptablePrice>');
		process.exit(1);
	}

	const stashContractId = ContractId.fromString(args[0]);
	const nftToken = TokenId.fromString(args[1]);
	const serials = args[2].toLowerCase() === 'any' ? [] : args[2].split(',').map(Number);
	const hbarAmount = parseInt(args[3]);
	const lazyAmount = parseInt(args[4]);
	const expiry = parseInt(args[5]);
	const minAcceptablePrice = parseInt(args[6]);

	const stashJson = JSON.parse(fs.readFileSync('./artifacts/contracts/BidderContract.sol/BidderContract.json'));
	const stashIface = new ethers.Interface(stashJson.abi);

	console.log('Environment:', env);
	console.log('Operator:', operatorId.toString());
	console.log('Stash:', stashContractId.toString());
	console.log('NFT Token:', nftToken.toString());
	console.log('Serials:', serials.length === 0 ? 'ANY' : serials.join(', '));
	console.log('HBAR Amount (tinybars):', hbarAmount);
	console.log('LAZY Amount:', lazyAmount);
	console.log('Expiry:', expiry === 0 ? 'Never' : new Date(expiry * 1000).toUTCString());
	console.log('Min Acceptable Price:', minAcceptablePrice);

	// Gas: 300k base + 950k if token association might be needed
	const gas = 1_500_000;

	const result = await contractExecuteFunction(
		stashContractId,
		stashIface,
		client,
		gas,
		'createBid',
		[nftToken.toSolidityAddress(), serials, hbarAmount, lazyAmount, expiry, minAcceptablePrice],
	);

	if (result[0]?.status?.toString() !== 'SUCCESS') {
		console.log('ERROR creating bid:', result);
		process.exit(1);
	}

	console.log('Bid created successfully.');
	console.log('Transaction ID:', result[2]?.transactionId?.toString());
	console.log('Bid ID:', result[1]?.[0]);
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
