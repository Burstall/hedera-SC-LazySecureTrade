/**
 * Rescue NFT from BidderContract (emergency escape hatch)
 *
 * Usage: node rescueNFT.js <stashContractId> <nftTokenId> <serial> <toAccountId> [hbarValue]
 *   - hbarValue: tinybar value for royalty engine (default 1 = CUSTODY_HOP_TINYBAR)
 *   - Uses TokenStakerV2.moveNFTs for proper Hedera royalty handling
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
	if (args.length < 4 || args.length > 5) {
		console.log('Usage: node rescueNFT.js <stashContractId> <nftTokenId> <serial> <toAccountId> [hbarValue]');
		console.log('       hbarValue: tinybar for royalty engine (default 1)');
		process.exit(1);
	}

	const stashContractId = ContractId.fromString(args[0]);
	const nftToken = TokenId.fromString(args[1]);
	const serial = parseInt(args[2]);
	const toAccountId = AccountId.fromString(args[3]);
	const hbarValue = args.length === 5 ? parseInt(args[4]) : 1;

	const stashJson = JSON.parse(fs.readFileSync('./artifacts/contracts/BidderContract.sol/BidderContract.json'));
	const stashIface = new ethers.Interface(stashJson.abi);

	console.log('Environment:', env);
	console.log('Operator:', operatorId.toString());
	console.log('Stash:', stashContractId.toString());
	console.log('NFT Token:', nftToken.toString());
	console.log('Serial:', serial);
	console.log('To:', toAccountId.toString());
	console.log('HBAR Value:', hbarValue, 'tinybars');

	const result = await contractExecuteFunction(
		stashContractId,
		stashIface,
		client,
		1_000_000,
		'rescueNFT',
		[nftToken.toSolidityAddress(), serial, toAccountId.toSolidityAddress(), hbarValue],
	);

	if (result[0]?.status?.toString() !== 'SUCCESS') {
		console.log('ERROR rescuing NFT:', result);
		process.exit(1);
	}

	console.log('NFT rescued successfully.');
	console.log('Transaction ID:', result[2]?.transactionId?.toString());
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
