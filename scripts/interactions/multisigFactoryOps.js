/**
 * Multisig Factory Operations
 * ============================
 *
 * Wraps protected BidderContractFactory owner functions behind
 * @lazysuperheroes/hedera-multisig threshold signature collection.
 *
 * Supported operations:
 *   --set-arb-bps <bps>         Propose arbitrage payout bps change (48h timelock)
 *   --apply-arb-bps             Apply a pending bps change (permissionless after ETA)
 *   --withdraw-profit <to> <amount>  Withdraw protocol profit to <to> (tinybars)
 *   --transfer-ownership <to>   Transfer factory ownership
 *
 * Prerequisites:
 *   - .env: ENVIRONMENT, ACCOUNT_ID, PRIVATE_KEY (operator for gas),
 *           BIDDER_FACTORY_CONTRACT_ID, FACTORY_MULTISIG_ACCOUNT_ID
 *   - The factory owner must be the multisig account
 *   - Signer keys: provide via prompts, encrypted files, or env vars
 *     using @lazysuperheroes/hedera-multisig key provider patterns
 *
 * Usage:
 *   node scripts/interactions/multisigFactoryOps.js --set-arb-bps 6000
 *   node scripts/interactions/multisigFactoryOps.js --withdraw-profit 0.0.1234 500000000
 *   node scripts/interactions/multisigFactoryOps.js --apply-arb-bps
 *   node scripts/interactions/multisigFactoryOps.js --transfer-ownership 0.0.9999
 */

const {
	Client,
	AccountId,
	PrivateKey,
	ContractId,
	ContractExecuteTransaction,
	TransactionId,
	Hbar,
	HbarUnit,
} = require('@hashgraph/sdk');
const { ethers } = require('ethers');
const fs = require('fs');
const readlineSync = require('readline-sync');
require('dotenv').config();

// Try to import hedera-multisig for coordinated signing
let multisigAvailable = false;
let WorkflowOrchestrator, PromptKeyProvider;
try {
	const hederaMultisig = require('@lazysuperheroes/hedera-multisig');
	WorkflowOrchestrator = hederaMultisig.WorkflowOrchestrator;
	PromptKeyProvider = hederaMultisig.PromptKeyProvider;
	multisigAvailable = true;
}
catch {
	console.log('WARNING: @lazysuperheroes/hedera-multisig not available.');
	console.log('Falling back to manual key collection mode.\n');
}

async function main() {
	// ===== Environment =====
	const operatorKey = PrivateKey.fromStringED25519(process.env.PRIVATE_KEY);
	const operatorId = AccountId.fromString(process.env.ACCOUNT_ID);
	const env = process.env.ENVIRONMENT;

	if (!env) {
		console.log('ERROR: ENVIRONMENT must be set');
		process.exit(1);
	}

	let client;
	if (env.toUpperCase() === 'TEST') client = Client.forTestnet();
	else if (env.toUpperCase() === 'MAIN') client = Client.forMainnet();
	else if (env.toUpperCase() === 'PREVIEW') client = Client.forPreviewnet();
	else {
		console.log(`ERROR: Unsupported ENVIRONMENT '${env}'`);
		process.exit(1);
	}
	client.setOperator(operatorId, operatorKey);

	const factoryContractId = ContractId.fromString(
		process.env.BIDDER_FACTORY_CONTRACT_ID ?? '',
	);
	const multisigAccountId = process.env.FACTORY_MULTISIG_ACCOUNT_ID
		? AccountId.fromString(process.env.FACTORY_MULTISIG_ACCOUNT_ID)
		: null;

	if (!factoryContractId) {
		console.log('ERROR: BIDDER_FACTORY_CONTRACT_ID required');
		process.exit(1);
	}

	const factoryJson = JSON.parse(
		fs.readFileSync('./artifacts/contracts/BidderContractFactory.sol/BidderContractFactory.json', 'utf8'),
	);
	const factoryIface = new ethers.Interface(factoryJson.abi);

	// ===== Parse operation =====
	const args = process.argv.slice(2);

	if (args.includes('--set-arb-bps')) {
		const bps = parseInt(args[args.indexOf('--set-arb-bps') + 1]);
		if (isNaN(bps) || bps < 0 || bps > 10000) {
			console.log('ERROR: --set-arb-bps requires a value 0-10000');
			process.exit(1);
		}
		await executeMultisigOp(
			client, operatorId, operatorKey, factoryContractId,
			multisigAccountId, factoryIface,
			'setArbitragePayoutBps', [bps],
			`Set arbitrage payout to ${bps} bps (${bps / 100}%)`,
		);
	}
	else if (args.includes('--apply-arb-bps')) {
		// This is permissionless (anyone can call after ETA) — no multisig needed
		console.log('Applying pending arbitrage payout bps change (permissionless)...');
		const callData = factoryIface.encodeFunctionData('executeArbPayoutBpsChange', []);
		const tx = new ContractExecuteTransaction()
			.setContractId(factoryContractId)
			.setGas(200_000)
			.setFunctionParameters(Buffer.from(callData.slice(2), 'hex'));
		const resp = await tx.execute(client);
		const receipt = await resp.getReceipt(client);
		console.log('Result:', receipt.status.toString());
	}
	else if (args.includes('--withdraw-profit')) {
		const toStr = args[args.indexOf('--withdraw-profit') + 1];
		const amountStr = args[args.indexOf('--withdraw-profit') + 2];
		if (!toStr || !amountStr) {
			console.log('ERROR: --withdraw-profit <accountId> <tinybarAmount>');
			process.exit(1);
		}
		const toId = AccountId.fromString(toStr);
		const amount = parseInt(amountStr);
		await executeMultisigOp(
			client, operatorId, operatorKey, factoryContractId,
			multisigAccountId, factoryIface,
			'withdrawProtocolProfit', [toId.toSolidityAddress(), amount],
			`Withdraw ${new Hbar(amount, HbarUnit.Tinybar).toString()} protocol profit to ${toStr}`,
		);
	}
	else if (args.includes('--transfer-ownership')) {
		const newOwnerStr = args[args.indexOf('--transfer-ownership') + 1];
		if (!newOwnerStr) {
			console.log('ERROR: --transfer-ownership <newOwnerAccountId>');
			process.exit(1);
		}
		const newOwnerId = AccountId.fromString(newOwnerStr);
		const confirm = readlineSync.question(
			`DANGER: Transfer ownership to ${newOwnerStr}? This is IRREVERSIBLE. Type "CONFIRM" to proceed: `,
		);
		if (confirm !== 'CONFIRM') {
			console.log('Aborted.');
			return;
		}
		await executeMultisigOp(
			client, operatorId, operatorKey, factoryContractId,
			multisigAccountId, factoryIface,
			'transferOwnership', [newOwnerId.toSolidityAddress()],
			`Transfer factory ownership to ${newOwnerStr}`,
		);
	}
	else {
		console.log('Usage:');
		console.log('  --set-arb-bps <bps>              Propose arbitrage payout bps change');
		console.log('  --apply-arb-bps                  Apply pending bps change (permissionless)');
		console.log('  --withdraw-profit <to> <amount>   Withdraw protocol profit');
		console.log('  --transfer-ownership <to>         Transfer factory ownership');
	}
}

/**
 * Execute a factory function that requires multisig owner signature.
 *
 * If @lazysuperheroes/hedera-multisig is available, uses the
 * WorkflowOrchestrator for coordinated threshold signing.
 * Otherwise falls back to manual key collection (prompts for
 * each signer's private key).
 */
async function executeMultisigOp(
	client, operatorId, operatorKey, factoryContractId,
	multisigAccountId, factoryIface, fcnName, params, description,
) {
	console.log(`\n=== Multisig Operation: ${description} ===`);
	console.log('Function:', fcnName);
	console.log('Factory:', factoryContractId.toString());

	const callData = factoryIface.encodeFunctionData(fcnName, params);

	if (multisigAvailable && multisigAccountId) {
		// ===== Coordinated signing via hedera-multisig =====
		console.log('Using @lazysuperheroes/hedera-multisig for threshold signing');
		console.log('Multisig account:', multisigAccountId.toString());

		try {
			const orchestrator = new WorkflowOrchestrator({
				network: process.env.ENVIRONMENT?.toLowerCase(),
				operatorId: operatorId.toString(),
				operatorKey: operatorKey.toString(),
			});

			// Build the transaction
			const tx = new ContractExecuteTransaction()
				.setContractId(factoryContractId)
				.setGas(300_000)
				.setFunctionParameters(Buffer.from(callData.slice(2), 'hex'))
				.setTransactionId(TransactionId.generate(multisigAccountId))
				.setNodeAccountIds([new AccountId(3)])
				.freezeWith(client);

			// Use the orchestrator to collect signatures and execute
			const result = await orchestrator.execute(tx);
			console.log('Result:', result?.status?.toString() ?? 'submitted');
		}
		catch (err) {
			console.error('Multisig execution failed:', err.message);
			console.log('\nFalling back to manual key collection...');
			await manualMultisigExecute(client, factoryContractId, callData, multisigAccountId);
		}
	}
	else if (multisigAccountId) {
		// ===== Manual key collection fallback =====
		console.log('Manual key collection mode (hedera-multisig not available)');
		await manualMultisigExecute(client, factoryContractId, callData, multisigAccountId);
	}
	else {
		// ===== Single-signer mode (no multisig configured) =====
		console.log('WARNING: No multisig configured — executing with single operator key');
		console.log('This is NOT recommended for mainnet.');
		const tx = new ContractExecuteTransaction()
			.setContractId(factoryContractId)
			.setGas(300_000)
			.setFunctionParameters(Buffer.from(callData.slice(2), 'hex'));
		const resp = await tx.execute(client);
		const receipt = await resp.getReceipt(client);
		console.log('Result:', receipt.status.toString());
	}
}

/**
 * Manual threshold signing: freeze the transaction, prompt for each
 * signer's key, collect signatures, and submit.
 */
async function manualMultisigExecute(client, factoryContractId, callData, multisigAccountId) {
	const tx = new ContractExecuteTransaction()
		.setContractId(factoryContractId)
		.setGas(300_000)
		.setFunctionParameters(Buffer.from(callData.slice(2), 'hex'))
		.setTransactionId(TransactionId.generate(multisigAccountId))
		.setNodeAccountIds([new AccountId(3)])
		.freezeWith(client);

	console.log('\nTransaction frozen. Collecting signatures...');
	console.log('Transaction ID:', tx.transactionId.toString());

	const signerCount = readlineSync.questionInt('How many signers will sign? ');

	for (let i = 0; i < signerCount; i++) {
		const keyStr = readlineSync.question(
			`Signer ${i + 1} private key (ED25519 hex): `,
			{ hideEchoBack: true },
		);
		try {
			const signerKey = PrivateKey.fromStringED25519(keyStr);
			await tx.sign(signerKey);
			console.log(`  Signer ${i + 1} signed`);
		}
		catch (err) {
			console.log(`  ERROR signing with signer ${i + 1}:`, err.message);
		}
	}

	console.log('Submitting signed transaction...');
	const resp = await tx.execute(client);
	const receipt = await resp.getReceipt(client);
	console.log('Result:', receipt.status.toString());
}

main().catch((err) => {
	console.error('FATAL:', err);
	process.exit(1);
});
