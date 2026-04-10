/**
 * Factory Multisig Owner Setup
 * ============================
 *
 * Creates a Hedera native threshold-key account (M-of-N) using
 * @lazysuperheroes/hedera-multisig and transfers BidderContractFactory
 * ownership to it.
 *
 * After running this script:
 * - The factory owner is a threshold key account requiring M signatures
 * - Protected operations (setArbitragePayoutBps, withdrawProtocolProfit,
 *   transferOwnership) all require the threshold to be met
 * - Use multisigFactoryOps.js for day-to-day multisig-protected calls
 *
 * Prerequisites:
 *   - .env must have: ENVIRONMENT, ACCOUNT_ID, PRIVATE_KEY
 *   - Factory must be deployed (BIDDER_FACTORY_CONTRACT_ID in .env)
 *   - Signer keys must be available (ED25519 or ECDSA)
 *
 * Usage:
 *   node scripts/deployments/setupFactoryMultisig.js
 */

const {
	Client,
	AccountId,
	PrivateKey,
	AccountCreateTransaction,
	Hbar,
	HbarUnit,
	KeyList,
	ContractId,
	ContractExecuteTransaction,
} = require('@hashgraph/sdk');
const { ethers } = require('ethers');
const fs = require('fs');
const readlineSync = require('readline-sync');
require('dotenv').config();

async function main() {
	// ===== Environment setup =====
	const operatorKey = PrivateKey.fromStringED25519(process.env.PRIVATE_KEY);
	const operatorId = AccountId.fromString(process.env.ACCOUNT_ID);
	const env = process.env.ENVIRONMENT;

	if (!env) {
		console.log('ERROR: ENVIRONMENT must be set in .env');
		process.exit(1);
	}

	let client;
	if (env.toUpperCase() === 'TEST') client = Client.forTestnet();
	else if (env.toUpperCase() === 'MAIN') client = Client.forMainnet();
	else if (env.toUpperCase() === 'PREVIEW') client = Client.forPreviewnet();
	else {
		console.log(`ERROR: Unsupported ENVIRONMENT '${env}' for multisig setup`);
		process.exit(1);
	}
	client.setOperator(operatorId, operatorKey);

	const factoryContractId = process.env.BIDDER_FACTORY_CONTRACT_ID
		? ContractId.fromString(process.env.BIDDER_FACTORY_CONTRACT_ID)
		: null;

	if (!factoryContractId) {
		console.log('ERROR: BIDDER_FACTORY_CONTRACT_ID must be set in .env');
		process.exit(1);
	}

	console.log('\n=== Factory Multisig Owner Setup ===');
	console.log('Network:', env.toUpperCase());
	console.log('Operator:', operatorId.toString());
	console.log('Factory:', factoryContractId.toString());

	// ===== Step 1: Collect signer public keys =====
	console.log('\n--- Step 1: Configure threshold key signers ---');

	const signerCount = readlineSync.questionInt('How many total signers? (e.g., 3): ');
	const threshold = readlineSync.questionInt(`Threshold (M of ${signerCount})? (e.g., 2): `);

	if (threshold < 1 || threshold > signerCount) {
		console.log(`ERROR: Threshold must be between 1 and ${signerCount}`);
		process.exit(1);
	}

	const publicKeys = [];

	// Always include the operator as the first signer
	console.log(`\nSigner 1 (operator): ${operatorId.toString()}`);
	publicKeys.push(operatorKey.publicKey);

	for (let i = 2; i <= signerCount; i++) {
		const keyType = readlineSync.question(`Signer ${i} — enter ED25519 public key (hex) or "generate" to create a new key: `);

		if (keyType.toLowerCase() === 'generate') {
			const newKey = PrivateKey.generateED25519();
			console.log(`  Generated signer ${i}:`);
			console.log(`    Public:  ${newKey.publicKey.toString()}`);
			console.log(`    Private: ${newKey.toString()}`);
			console.log('    *** SAVE THE PRIVATE KEY SECURELY — it will not be shown again ***');
			publicKeys.push(newKey.publicKey);
		}
		else {
			try {
				const pubKey = PrivateKey.fromStringED25519(keyType).publicKey;
				publicKeys.push(pubKey);
				console.log(`  Signer ${i} added: ${pubKey.toString()}`);
			}
			catch {
				// Try as a public key directly
				try {
					const { PublicKey } = require('@hashgraph/sdk');
					const pubKey = PublicKey.fromString(keyType);
					publicKeys.push(pubKey);
					console.log(`  Signer ${i} added: ${pubKey.toString()}`);
				}
				catch (err2) {
					console.log(`ERROR: Invalid key for signer ${i}:`, err2.message);
					process.exit(1);
				}
			}
		}
	}

	// ===== Step 2: Create the threshold key =====
	console.log(`\n--- Step 2: Creating ${threshold}-of-${signerCount} threshold key account ---`);

	const thresholdKey = new KeyList(publicKeys, threshold);

	const createTx = new AccountCreateTransaction()
		.setKey(thresholdKey)
		.setInitialBalance(new Hbar(10, HbarUnit.Hbar))
		.setMaxAutomaticTokenAssociations(5)
		.setAccountMemo(`LST Factory Multisig (${threshold}/${signerCount})`);

	const createResp = await createTx.execute(client);
	const createReceipt = await createResp.getReceipt(client);
	const multisigAccountId = createReceipt.accountId;

	console.log(`Multisig account created: ${multisigAccountId.toString()}`);
	console.log(`  Threshold: ${threshold}-of-${signerCount}`);
	console.log(`  EVM address: 0x${multisigAccountId.toSolidityAddress()}`);

	// ===== Step 3: Transfer factory ownership =====
	console.log('\n--- Step 3: Transferring factory ownership ---');

	const confirm = readlineSync.question(
		`Transfer ownership of factory ${factoryContractId.toString()} to ${multisigAccountId.toString()}? (yes/no): `,
	);

	if (confirm.toLowerCase() !== 'yes') {
		console.log('Aborted. Multisig account was created but ownership NOT transferred.');
		console.log('You can manually call transferOwnership later.');
		return;
	}

	const factoryJson = JSON.parse(
		fs.readFileSync('./artifacts/contracts/BidderContractFactory.sol/BidderContractFactory.json', 'utf8'),
	);
	const factoryIface = new ethers.Interface(factoryJson.abi);

	const transferData = factoryIface.encodeFunctionData('transferOwnership', [
		multisigAccountId.toSolidityAddress(),
	]);

	const transferTx = new ContractExecuteTransaction()
		.setContractId(factoryContractId)
		.setGas(200_000)
		.setFunctionParameters(Buffer.from(transferData.slice(2), 'hex'));

	const transferResp = await transferTx.execute(client);
	const transferReceipt = await transferResp.getReceipt(client);

	console.log('Ownership transferred!', transferReceipt.status.toString());

	// ===== Summary =====
	console.log('\n=== Setup Complete ===');
	console.log(`Factory: ${factoryContractId.toString()}`);
	console.log(`New owner: ${multisigAccountId.toString()} (${threshold}-of-${signerCount})`);
	console.log('\nAdd to your .env:');
	console.log(`FACTORY_MULTISIG_ACCOUNT_ID=${multisigAccountId.toString()}`);
	console.log(`FACTORY_MULTISIG_THRESHOLD=${threshold}`);
	console.log('\nUse scripts/interactions/multisigFactoryOps.js for protected operations.');
	console.log('Each operation will require signature collection from the threshold signers.');
}

main().catch((err) => {
	console.error('FATAL:', err);
	process.exit(1);
});
