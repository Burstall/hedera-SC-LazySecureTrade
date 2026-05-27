// Compute a rebate epoch — read mirror-node staking history, calculate
// per-user time-weighted average stake, apply the multiplier table,
// and emit a Merkle tree ready for `LazyRebatePool.settleEpoch`.
//
// This is the audit-trail-producing tool. The off-chain compute is
// where the team's accountability lives — the on-chain claim path is
// just "verify the proof and pay out." When users disagree about an
// amount, the JSON output of this script is the evidence.
//
// Usage:
//   node scripts/ops/computeRebateEpoch.js \
//     --start=<UNIX-SECONDS>      (epoch window start)
//     --end=<UNIX-SECONDS>        (epoch window end)
//     --pool-balance=<LAZY-AMOUNT> (total LAZY available for allocation;
//                                    typically the current rebate pool
//                                    balance from mirror)
//     [--min-stake-days=14]       (minimum stake duration for eligibility)
//     [--out=./rebate-epoch.json]
//     [--execute]                 (submit settleEpoch with the computed
//                                    root; default dry-run)
//
// What this script outputs (the audit trail):
//   {
//     epochWindow: { start, end },
//     poolBalance,
//     totalAllocated,
//     totalScaledUnits,
//     leaves: [
//       { user: "0x...", weight: N (scaled units), amount: LAZY-base-units },
//       ...
//     ],
//     tree: [...],
//     root: "0x...",
//     proofs: { "0xUserA": ["0x...", ...], ... }
//   }
//
// Required .env keys:
//   ENVIRONMENT                       (test|main|preview)
//   LAZY_NFT_STAKING_CONTRACT_ID      (the staking contract to walk)
//   LSH_GEN1_TOKEN_ID                  } needed to derive EVM addresses
//   LSH_GEN1_MUTANT_TOKEN_ID           } for the multiplier table
//   LSH_GEN2_TOKEN_ID                  }
//   For --execute mode:
//     LAZY_REBATE_POOL_CONTRACT_ID    (the pool that will settle)
//     ACCOUNT_ID + PRIVATE_KEY         (signer — must equal the pool's
//                                       configured signer)

const fs = require('fs');
const path = require('path');
const { default: axios } = require('axios');
const { ethers } = require('ethers');
const {
	Client,
	AccountId,
	PrivateKey,
	ContractId,
	TokenId,
} = require('@hashgraph/sdk');
require('dotenv').config();

// ============================================
// Multiplier table (must match LSHRebateMultipliers.sol)
// ============================================

const WEIGHT_SCALE = 10;
const WEIGHT_GEN1   = 50;   // 5.0 scaled units per token
const WEIGHT_MUTANT = 25;   // 2.5 scaled units per token
const WEIGHT_LSV    = 25;   // 2.5 scaled units per token
const WEIGHT_GEN2   = 10;   // 1.0 scaled unit per token

const LSV_MIN_SERIAL = 5001;
const LSV_MAX_SERIAL = 5100;

function multiplierFor(tokenEvm, serial, lshGen1Evm, lshMutantEvm, lshGen2Evm) {
	const t = tokenEvm.toLowerCase();
	if (t === lshGen1Evm.toLowerCase()) return WEIGHT_GEN1;
	if (t === lshMutantEvm.toLowerCase()) return WEIGHT_MUTANT;
	if (t === lshGen2Evm.toLowerCase()) {
		if (serial >= LSV_MIN_SERIAL && serial <= LSV_MAX_SERIAL) return WEIGHT_LSV;
		return WEIGHT_GEN2;
	}
	return 0;
}

// ============================================
// Merkle tree (OZ-compatible, sorted-pair hashing)
// ============================================

function hashLeaf(user, amount) {
	return ethers.solidityPackedKeccak256(['address', 'uint256'], [user, amount]);
}

function hashPair(a, b) {
	const [x, y] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
	return ethers.keccak256(ethers.concat([x, y]));
}

function buildTree(leaves) {
	let layer = [...leaves];
	const tree = [layer];
	while (layer.length > 1) {
		const next = [];
		for (let i = 0; i < layer.length; i += 2) {
			if (i + 1 === layer.length) next.push(layer[i]);
			else next.push(hashPair(layer[i], layer[i + 1]));
		}
		layer = next;
		tree.push(layer);
	}
	return tree;
}

function getProof(tree, leaf) {
	let idx = tree[0].indexOf(leaf);
	if (idx < 0) throw new Error('Leaf not in tree');
	const proof = [];
	for (let layer = 0; layer < tree.length - 1; layer++) {
		const sibling = idx % 2 === 0 ? idx + 1 : idx - 1;
		if (sibling < tree[layer].length) proof.push(tree[layer][sibling]);
		idx = Math.floor(idx / 2);
	}
	return proof;
}

// ============================================
// Mirror node — fetch staking events
// ============================================

const STAKING_IFACE = new ethers.Interface([
	'event StakedNFT(address _user, address collection, uint256[] serials, uint256[] rewards)',
	'event UnstakedNFT(address _user, address collection, uint256[] serials, uint256[] rewards)',
]);

function getMirrorBase(env) {
	const e = env.toLowerCase();
	if (e === 'test' || e === 'testnet') return 'https://testnet.mirrornode.hedera.com';
	if (e === 'main' || e === 'mainnet') return 'https://mainnet-public.mirrornode.hedera.com';
	if (e === 'preview' || e === 'previewnet') return 'https://previewnet.mirrornode.hedera.com';
	throw new Error(`Unsupported ENVIRONMENT: ${env}`);
}

/**
 * Walk all StakedNFT / UnstakedNFT events from the staking contract
 * up to `endSec`. We don't filter on `gte:startSec` at the mirror layer
 * because we need pre-window stake openings to know which NFTs were
 * already staked when the window began. The downstream
 * `computeTimeWeightedUnits` step clamps each period to the window.
 *
 * Returns: { "<tokenEvmLower>|<serial>": [ { owner, stakedFrom, stakedTo|null }, ... ] }
 */
async function reconstructStakeHistory(env, stakingContractId, endSec) {
	const baseUrl = getMirrorBase(env);
	let url = `${baseUrl}/api/v1/contracts/${stakingContractId.toString()}/results/logs`
		+ `?order=asc&limit=100&timestamp=lte:${endSec}`;

	const history = {};
	// Track currently-open periods so UnstakedNFT can close the right one
	// in O(1). Key is the same "tokenEvmLower|serial" used in history.
	const openPeriods = new Map();
	let logCount = 0;

	while (url) {
		const response = await axios.get(url);
		const data = response.data;

		for (const log of data.logs ?? []) {
			if (log.data === '0x') continue;
			let parsed;
			try {
				parsed = STAKING_IFACE.parseLog({ topics: log.topics, data: log.data });
			} catch {
				continue; // not a staking event we care about
			}
			// ethers v6 returns null (not throws) when the topic doesn't
			// match a known event in the interface — handle both shapes.
			if (!parsed) continue;
			logCount++;
			const ts = Math.floor(Number(log.timestamp.split('.')[0]));
			const user = parsed.args[0].toLowerCase();
			const collection = parsed.args[1].toLowerCase();
			const serials = parsed.args[2].map((s) => Number(s));

			for (const serial of serials) {
				const key = `${collection}|${serial}`;
				if (parsed.name === 'StakedNFT') {
					if (!history[key]) history[key] = [];
					// Defensive: if a stake event arrives while a period is
					// already open for this NFT, leave the existing period
					// alone (it would be a contract bug, but we don't want
					// to double-count).
					if (openPeriods.has(key)) continue;
					const period = { owner: user, stakedFrom: ts, stakedTo: null };
					history[key].push(period);
					openPeriods.set(key, period);
				} else if (parsed.name === 'UnstakedNFT') {
					const period = openPeriods.get(key);
					if (period) {
						period.stakedTo = ts;
						openPeriods.delete(key);
					}
					// If no open period found, the unstake predates our
					// scan window — ignore.
				}
			}
		}

		url = data.links?.next ? `${baseUrl}${data.links.next}` : null;
	}

	return { history, logCount };
}

/**
 * Compute time-weighted stake per (user, NFT) for an epoch window.
 *
 * For each NFT's timeline:
 *   - clamp each (owner, period) to the epoch window
 *   - assign that user's account `(periodSeconds / epochSeconds)` units
 *     of stake for that NFT
 *
 * Then sum across users + apply the multiplier table.
 *
 * Returns: { user => totalScaledUnits }
 */
function computeTimeWeightedUnits(history, startSec, endSec, lshAddresses) {
	const epochSeconds = endSec - startSec;
	const userUnits = new Map();

	for (const [key, periods] of Object.entries(history)) {
		const [tokenEvm, serialStr] = key.split('|');
		const serial = Number(serialStr);
		const tokenMultiplier = multiplierFor(
			tokenEvm, serial,
			lshAddresses.gen1, lshAddresses.mutant, lshAddresses.gen2,
		);
		if (tokenMultiplier === 0) continue;

		// Aggregate this NFT's stake time per owner (clamped to window)
		const ownerSeconds = new Map();
		for (const period of periods) {
			const from = Math.max(period.stakedFrom, startSec);
			const to = Math.min(period.stakedTo ?? endSec, endSec);
			if (to <= from) continue;
			const dur = to - from;
			ownerSeconds.set(period.owner, (ownerSeconds.get(period.owner) || 0) + dur);
		}

		// Convert per-owner seconds into per-owner stake-units for this NFT
		for (const [owner, seconds] of ownerSeconds.entries()) {
			const weightedUnits = (tokenMultiplier * seconds) / epochSeconds;
			userUnits.set(owner, (userUnits.get(owner) || 0) + weightedUnits);
		}
	}

	// Snap to integers (lose <1 unit precision — acceptable; total stays
	// pro-rata)
	const snapped = new Map();
	for (const [u, units] of userUnits.entries()) {
		const intUnits = Math.floor(units);
		if (intUnits > 0) snapped.set(u, intUnits);
	}
	return snapped;
}

// ============================================
// Allocation (units → LAZY)
// ============================================

function allocateLazy(userUnits, poolBalance) {
	let totalUnits = 0;
	for (const u of userUnits.values()) totalUnits += u;
	if (totalUnits === 0) return { allocations: new Map(), totalAllocated: 0n };

	const allocations = new Map();
	let totalAllocated = 0n;
	const poolBalanceBig = BigInt(poolBalance);
	const totalUnitsBig = BigInt(totalUnits);
	for (const [user, units] of userUnits.entries()) {
		const amount = (poolBalanceBig * BigInt(units)) / totalUnitsBig;
		if (amount > 0n) {
			allocations.set(user, amount);
			totalAllocated += amount;
		}
	}
	return { allocations, totalAllocated };
}

// ============================================
// Min-stake-days filter
// ============================================

/**
 * Drop NFT periods that don't cross `minStakeDaysSec` of clamped
 * duration within the window. Mirrors the on-chain UX gate that
 * "<14 days of stake in the epoch = no credit."
 */
function applyMinStakeFilter(history, startSec, endSec, minStakeDaysSec) {
	const filtered = {};
	let dropped = 0;
	for (const [key, periods] of Object.entries(history)) {
		const kept = [];
		for (const period of periods) {
			const from = Math.max(period.stakedFrom, startSec);
			const to = Math.min(period.stakedTo ?? endSec, endSec);
			if (to - from >= minStakeDaysSec) kept.push(period);
			else dropped++;
		}
		if (kept.length > 0) filtered[key] = kept;
	}
	return { filtered, dropped };
}

// ============================================
// On-chain settleEpoch
// ============================================

async function submitSettleEpoch(env, poolId, root, totalAllocated) {
	const operatorId = AccountId.fromString(process.env.ACCOUNT_ID);
	const operatorKey = PrivateKey.fromStringED25519(process.env.PRIVATE_KEY);
	const client = env === 'main' ? Client.forMainnet()
		: env === 'preview' ? Client.forPreviewnet()
			: Client.forTestnet();
	client.setOperator(operatorId, operatorKey);

	const rpJson = JSON.parse(fs.readFileSync(
		'./artifacts/contracts/LazyRebatePool.sol/LazyRebatePool.json', 'utf8',
	));
	const rpIface = new ethers.Interface(rpJson.abi);
	const { contractExecuteFunction } = require('../../utils/solidityHelpers');

	console.log('Submitting settleEpoch...');
	const resp = await contractExecuteFunction(
		poolId, rpIface, client, 400_000,
		'settleEpoch', [root, totalAllocated.toString()], 0, true,
	);
	const status = resp?.[0]?.status;
	const statusStr = status?.toString?.() ?? '';
	const errName = status?.name;
	if (statusStr !== 'SUCCESS') {
		throw new Error(`settleEpoch failed: status=${statusStr} name=${errName ?? 'unknown'}`);
	}
	console.log('settleEpoch: OK');
}

// ============================================
// Main
// ============================================

(async () => {
	// CLI arg parsing
	const args = {};
	for (const a of process.argv.slice(2)) {
		const m = a.match(/^--([^=]+)=(.*)$/);
		if (m) args[m[1]] = m[2];
		else if (a === '--execute') args.execute = true;
	}

	const startSec = Number(args.start);
	const endSec = Number(args.end);
	const poolBalance = args['pool-balance'];
	const minStakeDays = Number(args['min-stake-days'] ?? 14);
	const outPath = args.out
		|| path.resolve(process.cwd(), `rebate-epoch-${startSec}-${endSec}.json`);

	if (!startSec || !endSec || !poolBalance) {
		console.error('Usage: --start=<sec> --end=<sec> --pool-balance=<LAZY base units> [--min-stake-days=14] [--out=<path>] [--execute]');
		process.exit(1);
	}
	if (endSec <= startSec) {
		console.error(`end (${endSec}) must be > start (${startSec})`);
		process.exit(1);
	}

	const env = (process.env.ENVIRONMENT || 'test').toLowerCase();

	if (!process.env.LAZY_NFT_STAKING_CONTRACT_ID) {
		console.error('Missing LAZY_NFT_STAKING_CONTRACT_ID in .env');
		process.exit(1);
	}
	const stakingContractId = ContractId.fromString(process.env.LAZY_NFT_STAKING_CONTRACT_ID);

	const requiredLshKeys = ['LSH_GEN1_TOKEN_ID', 'LSH_GEN1_MUTANT_TOKEN_ID', 'LSH_GEN2_TOKEN_ID'];
	const missingLsh = requiredLshKeys.filter((k) => !process.env[k]);
	if (missingLsh.length) {
		console.error(`Missing LSH token IDs in .env: ${missingLsh.join(', ')}`);
		process.exit(1);
	}

	const lshAddresses = {
		gen1: '0x' + TokenId.fromString(process.env.LSH_GEN1_TOKEN_ID).toSolidityAddress(),
		mutant: '0x' + TokenId.fromString(process.env.LSH_GEN1_MUTANT_TOKEN_ID).toSolidityAddress(),
		gen2: '0x' + TokenId.fromString(process.env.LSH_GEN2_TOKEN_ID).toSolidityAddress(),
	};

	console.log('=== Rebate epoch compute ===');
	console.log('Window:        ', new Date(startSec * 1000).toISOString(), '→', new Date(endSec * 1000).toISOString());
	console.log('Pool balance:  ', poolBalance, 'LAZY base units');
	console.log('Min stake days:', minStakeDays);
	console.log('Staking:       ', stakingContractId.toString());
	console.log('LSH Gen1:      ', lshAddresses.gen1);
	console.log('LSH Mutant:    ', lshAddresses.mutant);
	console.log('LSH Gen2:      ', lshAddresses.gen2);
	console.log('Mode:          ', args.execute ? 'EXECUTE' : 'dry-run');

	// Phase 1 — reconstruct stake history from mirror
	console.log('\n[Phase 1] Reconstructing stake history from mirror...');
	const { history, logCount } = await reconstructStakeHistory(env, stakingContractId, endSec);
	console.log(`  ${logCount} staking events parsed across ${Object.keys(history).length} unique NFTs`);

	// Phase 1b — drop sub-min-stake periods
	const minStakeSec = minStakeDays * 24 * 60 * 60;
	const { filtered, dropped } = applyMinStakeFilter(history, startSec, endSec, minStakeSec);
	if (dropped > 0) console.log(`  Dropped ${dropped} sub-${minStakeDays}d periods`);

	// Phase 2 — compute time-weighted units per user
	console.log('\n[Phase 2] Computing time-weighted units per user...');
	const userUnits = computeTimeWeightedUnits(filtered, startSec, endSec, lshAddresses);
	console.log(`  Eligible users: ${userUnits.size}`);

	// Phase 3 — allocate pool to users pro-rata of their units
	console.log('\n[Phase 3] Allocating pool pro-rata...');
	const { allocations, totalAllocated } = allocateLazy(userUnits, poolBalance);
	console.log(`  Total allocated: ${totalAllocated} (of pool ${poolBalance})`);

	// Phase 4 — build Merkle tree
	console.log('\n[Phase 4] Building Merkle tree...');
	const sortedUsers = [...allocations.keys()].sort();
	const leaves = sortedUsers.map((u) => hashLeaf(u, allocations.get(u)));
	const tree = leaves.length > 0 ? buildTree(leaves) : null;
	const root = tree ? tree[tree.length - 1][0] : ethers.ZeroHash;
	console.log(`  Root: ${root}`);
	console.log(`  Leaves: ${leaves.length}`);

	// Phase 5 — emit JSON audit log
	const proofs = {};
	for (const u of sortedUsers) {
		proofs[u] = getProof(tree, hashLeaf(u, allocations.get(u)));
	}
	const audit = {
		epochWindow: { start: startSec, end: endSec },
		poolBalance,
		totalAllocated: totalAllocated.toString(),
		totalScaledUnits: Array.from(userUnits.values()).reduce((a, b) => a + b, 0),
		minStakeDays,
		multiplierTable: {
			WEIGHT_GEN1, WEIGHT_MUTANT, WEIGHT_LSV, WEIGHT_GEN2, WEIGHT_SCALE,
			LSV_MIN_SERIAL, LSV_MAX_SERIAL,
		},
		stakingContract: stakingContractId.toString(),
		lshAddresses,
		root,
		leafCount: leaves.length,
		entries: sortedUsers.map((u) => ({
			user: u,
			weight: userUnits.get(u),
			amount: allocations.get(u).toString(),
		})),
		proofs,
		computedAt: new Date().toISOString(),
	};
	fs.writeFileSync(outPath, JSON.stringify(audit, null, 2) + '\n', 'utf8');
	console.log(`\nWrote audit JSON: ${outPath}`);

	if (!args.execute) {
		console.log('\nDry-run. Re-run with --execute to submit settleEpoch on-chain.');
		process.exit(0);
	}

	// Phase 6 — on-chain settleEpoch
	if (!process.env.LAZY_REBATE_POOL_CONTRACT_ID) {
		console.error('LAZY_REBATE_POOL_CONTRACT_ID not set — cannot submit settleEpoch');
		process.exit(1);
	}
	const poolId = ContractId.fromString(process.env.LAZY_REBATE_POOL_CONTRACT_ID);
	console.log(`\n[Phase 6] Submitting settleEpoch to ${poolId.toString()}...`);
	await submitSettleEpoch(env, poolId, root, totalAllocated);

	process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
