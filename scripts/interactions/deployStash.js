/**
 * Deploy a Stash (BidderContract) via BidderContractFactory
 *
 * Usage: node deployStash.js <factoryContractId>
 *   - Deploys a stash for the operator. If one already exists, prints it and exits.
 */
const { Client, AccountId, PrivateKey, ContractId } = require('@hashgraph/sdk');
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
		console.log('Usage: node deployStash.js <factoryContractId>');
		process.exit(1);
	}

	const factoryContractId = ContractId.fromString(args[0]);
	const factoryJson = JSON.parse(fs.readFileSync('./artifacts/contracts/BidderContractFactory.sol/BidderContractFactory.json'));
	const factoryIface = new ethers.Interface(factoryJson.abi);

	console.log('Environment:', env);
	console.log('Operator:', operatorId.toString());
	console.log('Factory:', factoryContractId.toString());

	// Check if stash already exists via mirror node
	const encodedCheck = factoryIface.encodeFunctionData('getStashOf', [operatorId.toSolidityAddress()]);
	const checkResult = await readOnlyEVMFromMirrorNode(env, factoryContractId, encodedCheck, operatorId, false);
	const existingStash = factoryIface.decodeFunctionResult('getStashOf', checkResult)[0];

	if (existingStash !== ethers.ZeroAddress) {
		console.log('Stash already deployed at:', existingStash);
		console.log('No action needed.');
		process.exit(0);
	}

	console.log('No stash found. Deploying...');

	const result = await contractExecuteFunction(
		factoryContractId,
		factoryIface,
		client,
		1_500_000,
		'deployStash',
		[],
	);

	if (result[0]?.status?.toString() !== 'SUCCESS') {
		console.log('ERROR deploying stash:', result);
		process.exit(1);
	}

	console.log('Stash deployed successfully.');
	console.log('Transaction ID:', result[2]?.transactionId?.toString());
	console.log('Stash Address:', result[1]?.[0]);
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
