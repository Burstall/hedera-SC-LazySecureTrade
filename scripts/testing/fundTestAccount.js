// One-off HBAR top-up for test accounts when mirror balance reads are stale.
// Usage: node scripts/testing/fundTestAccount.js <accountId> <hbarAmount>
const dotenv = require('dotenv');
dotenv.config();
const { Client, AccountId, PrivateKey, Hbar, TransferTransaction } = require('@hashgraph/sdk');

(async () => {
	const [target, amount] = process.argv.slice(2);
	if (!target || !amount) {
		console.error('Usage: node scripts/testing/fundTestAccount.js <accountId> <hbarAmount>');
		process.exit(1);
	}
	const env = (process.env.ENVIRONMENT || 'test').toLowerCase();
	const operatorId = AccountId.fromString(process.env.ACCOUNT_ID);
	const operatorKey = PrivateKey.fromStringED25519(process.env.PRIVATE_KEY);
	const client = env === 'main' ? Client.forMainnet()
		: env === 'preview' ? Client.forPreviewnet()
		: Client.forTestnet();
	client.setOperator(operatorId, operatorKey);
	const targetId = AccountId.fromString(target);
	const hbarAmount = Number(amount);
	const tx = await new TransferTransaction()
		.addHbarTransfer(operatorId, new Hbar(-hbarAmount))
		.addHbarTransfer(targetId, new Hbar(hbarAmount))
		.execute(client);
	const rx = await tx.getReceipt(client);
	console.log(`Funded ${target} with ${hbarAmount} HBAR — status: ${rx.status.toString()}`);
	process.exit(0);
})().catch((e) => {
	console.error(e);
	process.exit(1);
});
