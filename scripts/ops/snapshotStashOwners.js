// Snapshot the BCF's stashOwnerOf mapping for a future BCF v2 migration.
//
// Reads `getAllStashes()` (or paginated equivalent) from the cached
// BCF, then resolves `stashOwnerOf(stash)` for each — mirror node
// only, no on-chain writes. Emits a JSON file that
// `replayStashOwners.js` consumes during the v2 cutover.
//
// Usage:
//   node scripts/ops/snapshotStashOwners.js [--out=./stash-snapshot-<ts>.json]
//
// Cost: 1 mirror request per page (200 stashes/page) + 1 per stash for
// the owner lookup. No HBAR. Safe to run during normal operations.

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const {
	Client,
	AccountId,
	PrivateKey,
	ContractId,
} = require('@hashgraph/sdk');
const { readOnlyEVMFromMirrorNode } = require('../../utils/solidityHelpers');
const { sleep } = require('../../utils/nodeHelpers');
require('dotenv').config();

const PAGE_SIZE = 200;

(async () => {
	// CLI: --out=<path>
	let outPath = null;
	for (const arg of process.argv.slice(2)) {
		if (arg.startsWith('--out=')) outPath = arg.slice('--out='.length);
	}
	if (!outPath) {
		const ts = new Date().toISOString().replace(/[:.]/g, '-');
		outPath = path.resolve(process.cwd(), `stash-snapshot-${ts}.json`);
	}

	const env = (process.env.ENVIRONMENT || 'test').toLowerCase();
	const operatorId = AccountId.fromString(process.env.ACCOUNT_ID);
	const operatorKey = PrivateKey.fromStringED25519(process.env.PRIVATE_KEY);
	const client = env === 'main' ? Client.forMainnet()
		: env === 'preview' ? Client.forPreviewnet()
			: Client.forTestnet();
	client.setOperator(operatorId, operatorKey);

	const bcfRaw = process.env.BIDDER_FACTORY_CONTRACT_ID
		|| process.env.BCF_CONTRACT_ID;
	if (!bcfRaw) {
		console.error('Missing BIDDER_FACTORY_CONTRACT_ID in .env');
		process.exit(1);
	}
	const bcfId = ContractId.fromString(bcfRaw);

	const bcfJson = JSON.parse(fs.readFileSync(
		'./artifacts/contracts/BidderContractFactory.sol/BidderContractFactory.json', 'utf8',
	));
	const bcfIface = new ethers.Interface(bcfJson.abi);

	async function call(fcn, params = []) {
		const data = bcfIface.encodeFunctionData(fcn, params);
		const raw = await readOnlyEVMFromMirrorNode(env, bcfId, data, operatorId, false);
		return bcfIface.decodeFunctionResult(fcn, raw);
	}

	console.log('=== BCF stash-owner snapshot ===');
	console.log('Network:', env);
	console.log('BCF:    ', bcfId.toString(), '/', '0x' + bcfId.toSolidityAddress());
	console.log('Output: ', outPath);
	console.log();

	const totalRaw = (await call('getStashCount'))[0];
	const total = Number(totalRaw);
	console.log(`Stashes deployed: ${total}`);
	if (total === 0) {
		console.log('Nothing to snapshot. Exiting.');
		process.exit(0);
	}

	const stashes = [];
	for (let offset = 0; offset < total; offset += PAGE_SIZE) {
		const limit = Math.min(PAGE_SIZE, total - offset);
		const page = (await call('getStashesPaginated', [offset, limit]))[0];
		stashes.push(...page);
		console.log(`  paginated ${offset + page.length}/${total}`);
		await sleep(200);
	}

	console.log(`Resolving owners for ${stashes.length} stashes...`);
	const owners = [];
	const failures = [];
	for (let i = 0; i < stashes.length; i++) {
		const stash = stashes[i];
		try {
			const owner = (await call('stashOwnerOf', [stash]))[0];
			if (owner === ethers.ZeroAddress) {
				failures.push({ stash, reason: 'zero owner' });
			} else {
				owners.push({ stash, owner });
			}
		}
		catch (e) {
			failures.push({ stash, reason: e.message });
		}
		if ((i + 1) % 25 === 0) {
			console.log(`  ${i + 1}/${stashes.length} resolved`);
			await sleep(150);
		}
	}

	const snapshot = {
		network: env,
		bcf: '0x' + bcfId.toSolidityAddress(),
		bcfEntity: bcfId.toString(),
		capturedAt: new Date().toISOString(),
		blockTimestamp: Math.floor(Date.now() / 1000),
		stashCount: stashes.length,
		resolvedOwners: owners.length,
		failures,
		entries: owners,
	};
	fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');

	console.log();
	console.log(`Wrote ${owners.length} (stash, owner) pairs to ${outPath}`);
	if (failures.length) {
		console.log(`⚠ ${failures.length} stash(es) had unresolved owners — inspect:`);
		failures.slice(0, 5).forEach((f) => console.log(` - ${f.stash}: ${f.reason}`));
		if (failures.length > 5) console.log(`   ...and ${failures.length - 5} more`);
	}
	process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
