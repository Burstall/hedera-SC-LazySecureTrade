// One-off operator refill from a SCOOP account.
// Usage: node scripts/testing/refillOperator.js <scoopAccountId> <scoopPrivateKeyIndex> <hbarAmount>
// scoopPrivateKeyIndex matches the comma-separated position in SCOOP_KEYS.
const dotenv = require('dotenv');
dotenv.config();
const { Client, AccountId, PrivateKey, Hbar, TransferTransaction } = require('@hashgraph/sdk');

function parseScoopKey(rawKey) {
	if (rawKey.startsWith('ecdsa:')) {
		return PrivateKey.fromStringECDSA(rawKey.slice('ecdsa:'.length));
	}
	return PrivateKey.fromStringED25519(rawKey);
}

(async () => {
	const [scoopId, keyIdxRaw, amountRaw] = process.argv.slice(2);
	if (!scoopId || !keyIdxRaw || !amountRaw) {
		console.error('Usage: node scripts/testing/refillOperator.js <scoopAccountId> <keyIndex> <hbarAmount>');
		process.exit(1);
	}
	const keyIdx = Number(keyIdxRaw);
	const amount = Number(amountRaw);
	const env = (process.env.ENVIRONMENT || 'test').toLowerCase();
	const operatorId = AccountId.fromString(process.env.ACCOUNT_ID);
	const scoopKeys = (process.env.SCOOP_KEYS || '').split(',').map((k) => k.trim());
	if (!scoopKeys[keyIdx]) {
		console.error('No SCOOP key at index', keyIdx);
		process.exit(1);
	}
	const scoopKey = parseScoopKey(scoopKeys[keyIdx]);
	const scoopAccountId = AccountId.fromString(scoopId);
	const client = env === 'main' ? Client.forMainnet()
		: env === 'preview' ? Client.forPreviewnet()
		: Client.forTestnet();
	client.setOperator(scoopAccountId, scoopKey);
	const tx = await new TransferTransaction()
		.addHbarTransfer(scoopAccountId, new Hbar(-amount))
		.addHbarTransfer(operatorId, new Hbar(amount))
		.execute(client);
	const rx = await tx.getReceipt(client);
	console.log(`Refilled operator ${operatorId} with ${amount} HBAR from ${scoopId} — status: ${rx.status.toString()}`);
	process.exit(0);
})().catch((e) => {
	console.error(e);
	process.exit(1);
});
