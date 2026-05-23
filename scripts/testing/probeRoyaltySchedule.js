// Quick sanity check: read the royalty fee schedule for an HTS NFT
// collection via mirror node. EnglishAuction's settle flow will manually
// pay royalty using these values, so we need to confirm we can read them
// reliably + that they have the shape we expect.
//
// Usage:
//   node scripts/testing/probeRoyaltySchedule.js [tokenId]
//   (defaults to BCF_NFT_TOKEN_ID from .env)

const { AccountId, TokenId } = require('@hashgraph/sdk');
require('dotenv').config();

(async () => {
	const env = (process.env.ENVIRONMENT || 'test').toLowerCase();
	const tokenArg = process.argv[2] || process.env.BCF_NFT_TOKEN_ID;
	if (!tokenArg) {
		console.error('Usage: node scripts/testing/probeRoyaltySchedule.js [tokenId]');
		console.error('No tokenId given and BCF_NFT_TOKEN_ID not set in .env');
		process.exit(1);
	}
	const tokenId = TokenId.fromString(tokenArg);
	const mirrorBase = env === 'main' ? 'https://mainnet.mirrornode.hedera.com'
		: env === 'preview' ? 'https://previewnet.mirrornode.hedera.com'
		: 'https://testnet.mirrornode.hedera.com';

	const url = `${mirrorBase}/api/v1/tokens/${tokenId.toString()}`;
	console.log('Fetching:', url);
	const res = await fetch(url);
	if (!res.ok) {
		console.error('Mirror returned', res.status, await res.text());
		process.exit(1);
	}
	const data = await res.json();

	console.log('\n=== Token info ===');
	console.log('name:        ', data.name);
	console.log('symbol:      ', data.symbol);
	console.log('type:        ', data.type);
	console.log('treasury:    ', data.treasury_account_id);
	console.log('total_supply:', data.total_supply);

	console.log('\n=== Custom fees ===');
	const fees = data.custom_fees || {};
	console.log('created_timestamp:', fees.created_timestamp);
	console.log('royalty_fees count:', (fees.royalty_fees || []).length);

	if (fees.royalty_fees && fees.royalty_fees.length > 0) {
		fees.royalty_fees.forEach((f, i) => {
			console.log(`\n  [${i}]`);
			console.log('    numerator:        ', f.amount?.numerator);
			console.log('    denominator:      ', f.amount?.denominator);
			console.log('    bps equivalent:   ', Math.floor((f.amount?.numerator / f.amount?.denominator) * 10000), 'bps');
			console.log('    collector_account:', f.collector_account_id);
			console.log('    fallback_fee:     ', JSON.stringify(f.fallback_fee));
		});
	}
	else {
		console.log('  (no royalty fees configured on this collection)');
	}

	console.log('\n=== Verdict ===');
	if (fees.royalty_fees && fees.royalty_fees.length > 0) {
		const f = fees.royalty_fees[0];
		const bps = Math.floor((f.amount.numerator / f.amount.denominator) * 10000);
		console.log(`Royalty: ${bps} bps to ${f.collector_account_id}`);
		console.log('EnglishAuction will snapshot (collector_account, bps) at createAuction');
		console.log('and pay royalty manually at settle via direct HBAR/LAZY transfer.');
	}
	else {
		console.log('No royalty configured. EnglishAuction snapshot will store address(0) +');
		console.log('0 bps, and settle will skip the royalty branch.');
	}
	process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
