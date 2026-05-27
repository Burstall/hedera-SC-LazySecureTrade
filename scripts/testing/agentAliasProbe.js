// Smoke test for the agent Hedera-account provisioning pattern.
//
// Verifies that ecdsaKey.publicKey.toAccountId(0, 0) can be used as a
// payer immediately after an HBAR transfer auto-creates the account.
// If this script completes with SUCCESS, the AgentEnvelopeFull test
// suite's `provisionAgentHederaAccount` is wired correctly.
//
// Cost: ~3 HBAR (2 for funding + ~1 for the probe tx).
//
// Usage:
//   node scripts/testing/agentAliasProbe.js

const {
	Client,
	AccountId,
	PrivateKey,
	Hbar,
	HbarUnit,
	TransferTransaction,
	AccountInfoQuery,
} = require('@hashgraph/sdk');
const { ethers } = require('ethers');
require('dotenv').config();

(async () => {
	const env = (process.env.ENVIRONMENT || 'test').toLowerCase();
	const operatorId = AccountId.fromString(process.env.ACCOUNT_ID);
	const operatorKey = PrivateKey.fromStringED25519(process.env.PRIVATE_KEY);
	const client = env === 'main' ? Client.forMainnet()
		: env === 'preview' ? Client.forPreviewnet()
			: Client.forTestnet();
	client.setOperator(operatorId, operatorKey);

	const wallet = ethers.Wallet.createRandom();
	const ecdsaKey = PrivateKey.fromStringECDSA(wallet.privateKey);
	const aliasAccountId = ecdsaKey.publicKey.toAccountId(0, 0);

	console.log('=== Agent alias-key probe ===');
	console.log('Wallet EVM address:', wallet.address);
	console.log('ECDSA pubkey:', ecdsaKey.publicKey.toString());
	console.log('Alias AccountId (string):', aliasAccountId.toString());
	console.log('Alias AccountId.alias:', aliasAccountId.aliasKey?.toString?.());

	// Step 1: auto-create the alias account via HBAR transfer.
	console.log('\n--- Step 1: transfer to alias (auto-create) ---');
	const transferTx = new TransferTransaction()
		.addHbarTransfer(operatorId, new Hbar(-3))
		.addHbarTransfer(aliasAccountId, new Hbar(3))
		.freezeWith(client);
	const transferResp = await transferTx.execute(client);
	const transferReceipt = await transferResp.getReceipt(client);
	console.log('Transfer status:', transferReceipt.status.toString());

	// Step 2: resolve alias → numeric AccountId via AccountInfoQuery.
	// The SDK won't accept an alias-key AccountId as the operator (no
	// checksum support on aliases) — so we resolve the numeric form
	// first and use that for setOperator.
	console.log('\n--- Step 2: resolve alias → numeric ---');
	let numericAccountId;
	try {
		const info = await new AccountInfoQuery()
			.setAccountId(aliasAccountId)
			.execute(client);
		numericAccountId = info.accountId;
		console.log('Resolved numeric AccountId:', numericAccountId.toString());
		console.log('Balance:', info.balance.toString());
		console.log('Contract EVM address (msg.sender):', info.contractAccountId);
	}
	catch (e) {
		console.error('AccountInfoQuery FAILED:', e.message);
		process.exit(1);
	}

	// Step 3: submit a benign tx FROM the agent account as payer.
	// Self-transfer of 1 tinybar — minimal cost, exercises the
	// "agent-as-payer" pre-check.
	console.log('\n--- Step 3: submit tx as agent (payer = numeric) ---');
	client.setOperator(numericAccountId, ecdsaKey);
	try {
		const probeTx = new TransferTransaction()
			.addHbarTransfer(numericAccountId, new Hbar(-1, HbarUnit.Tinybar))
			.addHbarTransfer(operatorId, new Hbar(1, HbarUnit.Tinybar))
			.freezeWith(client);
		const probeResp = await probeTx.execute(client);
		const probeReceipt = await probeResp.getReceipt(client);
		console.log('Probe tx status:', probeReceipt.status.toString());
		console.log('\n✅ Agent-as-payer works via numeric form. Scaffold pattern confirmed.');
	}
	catch (e) {
		console.error('\n❌ Probe tx FAILED as agent payer:', e.message);
		console.error('   → scaffold provisionAgentHederaAccount needs another approach.');
		process.exit(1);
	}

	process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
