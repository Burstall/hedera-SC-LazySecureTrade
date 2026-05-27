// Replay a BCF stash-owner snapshot into a new BCF.
//
// Consumes the JSON produced by `snapshotStashOwners.js` and either:
//   (a) `--dry-run` (default): prints the calls that WOULD be made.
//   (b) submits `seedStashOwners(address[], address[])` to the v2 BCF
//       in batches of `--batch-size` (default 50).
//
// **REQUIRES** the v2 BCF to expose `seedStashOwners(address[] stashes,
// address[] owners) external onlyOwner`. Current BCF does NOT have this
// — see `docs/v0.3-OPS-RUNBOOK.md` §2 for the design discussion. Until
// the function ships, this script is a dry-run planning tool only.
//
// Usage:
//   node scripts/ops/replayStashOwners.js --in=./stash-snapshot.json [--bcf-v2=0.0.X] [--batch-size=50] [--execute]
//
// Without --execute, no transactions are submitted.

const fs = require('fs');
const { ethers } = require('ethers');
const {
	Client,
	AccountId,
	PrivateKey,
	ContractId,
} = require('@hashgraph/sdk');
const { contractExecuteFunction } = require('../../utils/solidityHelpers');
const { sleep } = require('../../utils/nodeHelpers');
require('dotenv').config();

(async () => {
	let inPath = null;
	let bcfV2Raw = null;
	let batchSize = 50;
	let execute = false;
	for (const arg of process.argv.slice(2)) {
		if (arg.startsWith('--in=')) inPath = arg.slice('--in='.length);
		else if (arg.startsWith('--bcf-v2=')) bcfV2Raw = arg.slice('--bcf-v2='.length);
		else if (arg.startsWith('--batch-size=')) batchSize = Number(arg.slice('--batch-size='.length));
		else if (arg === '--execute') execute = true;
	}
	if (!inPath) {
		console.error('Missing --in=<snapshot.json>');
		process.exit(1);
	}

	const snapshot = JSON.parse(fs.readFileSync(inPath, 'utf8'));
	console.log('=== BCF stash-owner replay ===');
	console.log('Snapshot:    ', inPath);
	console.log('Captured at: ', snapshot.capturedAt);
	console.log('Source BCF:  ', snapshot.bcfEntity, '/', snapshot.bcf);
	console.log('Entries:     ', snapshot.entries.length);
	console.log('Batch size:  ', batchSize);
	console.log('Mode:        ', execute ? '🔴 EXECUTE (mutates v2)' : 'dry-run');
	console.log();

	const batches = [];
	for (let i = 0; i < snapshot.entries.length; i += batchSize) {
		const slice = snapshot.entries.slice(i, i + batchSize);
		batches.push({
			stashes: slice.map((e) => e.stash),
			owners: slice.map((e) => e.owner),
		});
	}
	console.log(`Planned: ${batches.length} seedStashOwners() call(s)`);
	batches.forEach((b, i) => {
		console.log(`  batch ${i + 1}/${batches.length}: ${b.stashes.length} entries`);
	});

	if (!execute) {
		console.log('\nDry-run complete. Re-run with --execute --bcf-v2=<v2 id> to submit.');
		process.exit(0);
	}

	if (!bcfV2Raw) {
		console.error('--execute requires --bcf-v2=<v2 BCF contract id>');
		process.exit(1);
	}

	const env = (process.env.ENVIRONMENT || 'test').toLowerCase();
	const operatorId = AccountId.fromString(process.env.ACCOUNT_ID);
	const operatorKey = PrivateKey.fromStringED25519(process.env.PRIVATE_KEY);
	const client = env === 'main' ? Client.forMainnet()
		: env === 'preview' ? Client.forPreviewnet()
			: Client.forTestnet();
	client.setOperator(operatorId, operatorKey);

	const bcfV2Id = ContractId.fromString(bcfV2Raw);
	const bcfJson = JSON.parse(fs.readFileSync(
		'./artifacts/contracts/BidderContractFactory.sol/BidderContractFactory.json', 'utf8',
	));
	const bcfIface = new ethers.Interface(bcfJson.abi);

	// Sanity: confirm v2 has seedStashOwners. If not, fail loud.
	let hasSeedFn = false;
	try {
		bcfIface.getFunction('seedStashOwners');
		hasSeedFn = true;
	}
	catch (_) { /* missing */ }
	if (!hasSeedFn) {
		console.error('Compiled BCF ABI has no `seedStashOwners`. Add the function to BCF, recompile, then re-run.');
		console.error('See docs/v0.3-OPS-RUNBOOK.md §2 "Replay phase — `seedStashOwners` design sketch".');
		process.exit(1);
	}

	for (let i = 0; i < batches.length; i++) {
		const b = batches[i];
		console.log(`Submitting batch ${i + 1}/${batches.length} (${b.stashes.length} entries)...`);
		const [rx] = await contractExecuteFunction(
			bcfV2Id, bcfIface, client, 2_000_000,
			'seedStashOwners', [b.stashes, b.owners],
		);
		if (rx.status.toString() !== 'SUCCESS') {
			console.error(`Batch ${i + 1} failed: ${rx.status.toString()}`);
			process.exit(1);
		}
		await sleep(2000);
	}
	console.log('\nReplay complete.');
	process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
