/**
 * Claim Arbitrage Profit from BidderContractFactory
 *
 * Usage: node claimArbProfit.js <factoryContractId>
 *   - Claims all pending arbitrage profit for the caller (operator)
 */
const { Client, AccountId, PrivateKey, ContractId, Hbar, HbarUnit } = require('@hashgraph/sdk');
const { ethers } = require('ethers');
const fs = require('fs');
const { contractExecuteFunction, readOnlyEVMFromMirrorNode } = require('../../utils/solidityHelpers');
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
		console.log('Usage: node claimArbProfit.js <factoryContractId>');
		process.exit(1);
	}

	const factoryContractId = ContractId.fromString(args[0]);
	const factoryJson = JSON.parse(fs.readFileSync('./artifacts/contracts/BidderContractFactory.sol/BidderContractFactory.json'));
	const factoryIface = new ethers.Interface(factoryJson.abi);

	// Check pending profit via mirror node before claiming
	const encodedCheck = factoryIface.encodeFunctionData('pendingArbProfit', [operatorId.toSolidityAddress()]);
	const checkResult = await readOnlyEVMFromMirrorNode(env, factoryContractId, encodedCheck, operatorId, false);
	const pendingAmount = BigInt(factoryIface.decodeFunctionResult('pendingArbProfit', checkResult)[0]);

	console.log('Environment:', env);
	console.log('Operator:', operatorId.toString());
	console.log('Factory:', factoryContractId.toString());
	console.log('Pending Profit:', pendingAmount.toString(), 'tinybars', `(${new Hbar(Number(pendingAmount), HbarUnit.Tinybar).toString()})`);

	if (pendingAmount === 0n) {
		console.log('Nothing to claim.');
		process.exit(0);
	}

	const result = await contractExecuteFunction(
		factoryContractId,
		factoryIface,
		client,
		300_000,
		'claimArbProfit',
		[],
	);

	if (result[0]?.status?.toString() !== 'SUCCESS') {
		console.log('ERROR claiming profit:', result);
		process.exit(1);
	}

	console.log('Profit claimed successfully.');
	console.log('Transaction ID:', result[2]?.transactionId?.toString());
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
