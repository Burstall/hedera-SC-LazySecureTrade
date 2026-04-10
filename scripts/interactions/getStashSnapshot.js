/**
 * Get Stash Snapshot from BidderContractFactory (mirror node read)
 *
 * Usage: node getStashSnapshot.js <factoryContractId> <userAccountId>
 *   - Reads stash address, deployed status, HBAR/LAZY balances, and active bid IDs
 */
const { AccountId, ContractId, Hbar, HbarUnit } = require('@hashgraph/sdk');
const { ethers } = require('ethers');
const fs = require('fs');
const { readOnlyEVMFromMirrorNode } = require('../../utils/solidityHelpers');
require('dotenv').config();

async function main() {
	const operatorId = AccountId.fromString(process.env.ACCOUNT_ID);
	const env = process.env.ENVIRONMENT ?? null;
	if (!env) { console.log('ERROR: ENVIRONMENT not set'); process.exit(1); }

	const args = process.argv.slice(2);
	if (args.length !== 2) {
		console.log('Usage: node getStashSnapshot.js <factoryContractId> <userAccountId>');
		process.exit(1);
	}

	const factoryContractId = ContractId.fromString(args[0]);
	const userAccountId = AccountId.fromString(args[1]);

	const factoryJson = JSON.parse(fs.readFileSync('./artifacts/contracts/BidderContractFactory.sol/BidderContractFactory.json'));
	const factoryIface = new ethers.Interface(factoryJson.abi);

	console.log('Environment:', env);
	console.log('Factory:', factoryContractId.toString());
	console.log('User:', userAccountId.toString());

	const encoded = factoryIface.encodeFunctionData('getStashSnapshot', [userAccountId.toSolidityAddress()]);
	const result = await readOnlyEVMFromMirrorNode(env, factoryContractId, encoded, operatorId, false);
	const decoded = factoryIface.decodeFunctionResult('getStashSnapshot', result);

	const [stashAddress, deployed, hbarBalance, lazyBalance, activeBidIds] = decoded;

	console.log('\n=== Stash Snapshot ===');
	console.log('Stash Address:', stashAddress);
	console.log('Deployed:', deployed);
	console.log('HBAR Balance:', hbarBalance.toString(), 'tinybars', `(${new Hbar(Number(hbarBalance), HbarUnit.Tinybar).toString()})`);
	console.log('LAZY Balance:', lazyBalance.toString());
	console.log('Active Bids:', activeBidIds.length);

	if (activeBidIds.length > 0) {
		console.log('\nBid IDs:');
		for (let i = 0; i < activeBidIds.length; i++) {
			console.log(`  [${i}] ${activeBidIds[i]}`);
		}
	}
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
