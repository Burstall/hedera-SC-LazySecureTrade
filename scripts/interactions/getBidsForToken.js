/**
 * Get Bids for Token (paginated) from BidderContractFactory (mirror node read)
 *
 * Usage: node getBidsForToken.js <factoryContractId> <nftTokenId> [offset] [limit]
 *   - offset: starting index (default 0)
 *   - limit: max results, 1-200 (default 50)
 */
const { AccountId, ContractId, TokenId } = require('@hashgraph/sdk');
const { ethers } = require('ethers');
const fs = require('fs');
const { readOnlyEVMFromMirrorNode } = require('../../utils/solidityHelpers');
require('dotenv').config();

async function main() {
	const operatorId = AccountId.fromString(process.env.ACCOUNT_ID);
	const env = process.env.ENVIRONMENT ?? null;
	if (!env) { console.log('ERROR: ENVIRONMENT not set'); process.exit(1); }

	const args = process.argv.slice(2);
	if (args.length < 2 || args.length > 4) {
		console.log('Usage: node getBidsForToken.js <factoryContractId> <nftTokenId> [offset] [limit]');
		process.exit(1);
	}

	const factoryContractId = ContractId.fromString(args[0]);
	const nftToken = TokenId.fromString(args[1]);
	const offset = args.length >= 3 ? parseInt(args[2]) : 0;
	const limit = args.length >= 4 ? parseInt(args[3]) : 50;

	const factoryJson = JSON.parse(fs.readFileSync('./artifacts/contracts/BidderContractFactory.sol/BidderContractFactory.json'));
	const factoryIface = new ethers.Interface(factoryJson.abi);

	console.log('Environment:', env);
	console.log('Factory:', factoryContractId.toString());
	console.log('NFT Token:', nftToken.toString());
	console.log('Offset:', offset, '| Limit:', limit);

	const encoded = factoryIface.encodeFunctionData('getBidsForTokenPaginated', [
		nftToken.toSolidityAddress(),
		offset,
		limit,
	]);
	const result = await readOnlyEVMFromMirrorNode(env, factoryContractId, encoded, operatorId, false);
	const decoded = factoryIface.decodeFunctionResult('getBidsForTokenPaginated', result);
	const bidIds = decoded[0];

	console.log('\n=== Bids for Token ===');
	console.log('Results:', bidIds.length);

	if (bidIds.length > 0) {
		for (let i = 0; i < bidIds.length; i++) {
			console.log(`  [${offset + i}] ${bidIds[i]}`);
		}
		if (bidIds.length === limit) {
			console.log(`\nMore results may exist. Next: node getBidsForToken.js ${args[0]} ${args[1]} ${offset + limit} ${limit}`);
		}
	}
	else {
		console.log('No bids found at this offset.');
	}
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
