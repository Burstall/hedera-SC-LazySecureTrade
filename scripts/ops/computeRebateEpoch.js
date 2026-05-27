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
// SKELETON. The mirror-node-event-fetching + stake-history reconstruction
// are STUBBED — see TODO sections. The script structure is intentionally
// modular so each phase can be implemented + tested independently.

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
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
// Stake history reconstruction (STUB)
// ============================================

/**
 * Walk the mirror node for all `Staked` / `Unstaked` events from
 * LazyNFTStaking within the [start, end] window. Returns a per-NFT
 * timeline of (owner, period) tuples.
 *
 * TODO: implement against the actual LazyNFTStaking event schema.
 * Reference: hedera-SC-LAZY-Farms/contracts/LazyNFTStaking.sol
 *
 * Expected return shape:
 *   {
 *     "0xtoken|serial": [
 *       { owner: "0x...", stakedFrom: 1700000000, stakedTo: 1701000000 },
 *       { owner: "0x...", stakedFrom: 1702000000, stakedTo: null }, // still staked
 *     ],
 *     ...
 *   }
 */
async function reconstructStakeHistory(env, startSec, endSec) {
	console.warn('TODO: implement mirror-node stake-history reconstruction');
	console.warn('  Read Staked/Unstaked events from LazyNFTStaking in window');
	console.warn('  [' + new Date(startSec * 1000).toISOString() + ', '
		+ new Date(endSec * 1000).toISOString() + ']');
	return {};
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
		console.error('Usage: --start=<sec> --end=<sec> --pool-balance=<LAZY base units> [--out=<path>] [--execute]');
		process.exit(1);
	}

	const lshAddresses = {
		gen1: process.env.LSH_GEN1_EVM_ADDRESS || '',
		mutant: process.env.LSH_MUTANT_EVM_ADDRESS || '',
		gen2: process.env.LSH_GEN2_EVM_ADDRESS || '',
	};

	console.log('=== Rebate epoch compute ===');
	console.log('Window:        ', new Date(startSec * 1000).toISOString(), '→', new Date(endSec * 1000).toISOString());
	console.log('Pool balance:  ', poolBalance, 'LAZY base units');
	console.log('Min stake days:', minStakeDays);
	console.log('Mode:          ', args.execute ? '🔴 EXECUTE' : 'dry-run');

	// Phase 1 — reconstruct stake history from mirror
	const env = (process.env.ENVIRONMENT || 'test').toLowerCase();
	const history = await reconstructStakeHistory(env, startSec, endSec);

	// Phase 2 — compute time-weighted units per user
	const userUnits = computeTimeWeightedUnits(history, startSec, endSec, lshAddresses);
	console.log(`Eligible users: ${userUnits.size}`);

	// Phase 3 — allocate pool to users pro-rata of their units
	const { allocations, totalAllocated } = allocateLazy(userUnits, poolBalance);
	console.log(`Total allocated: ${totalAllocated} (of pool ${poolBalance})`);

	// Phase 4 — build Merkle tree
	const sortedUsers = [...allocations.keys()].sort();
	const leaves = sortedUsers.map((u) => hashLeaf(u, allocations.get(u)));
	const tree = leaves.length > 0 ? buildTree(leaves) : null;
	const root = tree ? tree[tree.length - 1][0] : ethers.ZeroHash;

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
	console.log(`Merkle root:      ${root}`);
	console.log(`Total allocated:  ${totalAllocated} LAZY base units`);

	if (!args.execute) {
		console.log('\nDry-run. Re-run with --execute to submit settleEpoch on-chain.');
		process.exit(0);
	}

	// Phase 6 — on-chain settleEpoch (requires the signer key)
	console.log('TODO: implement settleEpoch submission via signer key');
	console.log('  Signer key: ' + (process.env.REBATE_SIGNER_KEY ? 'set' : 'NOT SET'));
	console.log('  Rebate pool: ' + (process.env.LAZY_REBATE_POOL_CONTRACT_ID ?? 'NOT SET'));
	process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
