#!/usr/bin/env node
'use strict';

/**
 * Stash integrity audit.
 *
 * Stashes are per-user EIP-1167 minimal-proxy clones of BidderContract — they
 * CANNOT be source-verified on Sourcify (the bare ~45-byte proxy matches no
 * .sol). Instead, this audit asserts the invariant that actually matters: every
 * deployed stash's on-chain runtime is the *canonical* EIP-1167 proxy pointing
 * at the verified BidderContract implementation. Anything that isn't is a red
 * flag (rogue bytecode, wrong impl, partial deploy).
 *
 * It's free (mirror node + Sourcify reads only), so run it on a cron. Use
 * --since for an incremental sweep of newly deployed stashes.
 *
 * Discovery is via the factory's `StashDeployed(user, stash, deployer)` events
 * on the mirror node (gives the user→stash mapping for free).
 *
 * Usage:
 *   node scripts/testing/auditStashes.js
 *   node scripts/testing/auditStashes.js --since 1730000000.000000000   # incremental
 *   node scripts/testing/auditStashes.js --json
 *
 * Env: ENVIRONMENT, BIDDER_FACTORY_CONTRACT_ID, and the impl id
 * (BIDDER_IMPL_CONTRACT_ID or BIDDER_CONTRACT_IMPL_ID).
 */

require('dotenv').config();
const ethers = require('ethers');
const axios = require('axios');
const {
	resolveProxyStatus,
	checkVerified,
	chainIdForEnv,
} = require('@lazysuperheroes/hedera-verify');
const { getBaseURL, getContractEVMAddress } = require('../../utils/hederaMirrorHelpers');

function parseArgs(argv) {
	const flags = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--json') flags.json = true;
		else if (a.startsWith('--')) flags[a.slice(2)] = argv[++i];
	}
	return flags;
}

const STASH_DEPLOYED_TOPIC0 = ethers.id('StashDeployed(address,address,address)');

/** Fetch StashDeployed events (paginated), newest-first stopping behaviour off. */
async function fetchStashEvents(env, factoryId, sinceTimestamp) {
	const base = getBaseURL(env);
	let url = `${base}/api/v1/contracts/${factoryId}/results/logs?order=asc&limit=100`;
	if (sinceTimestamp) url += `&timestamp=gt:${sinceTimestamp}`;
	const out = [];
	while (url) {
		const { data } = await axios.get(url, { timeout: 30000 });
		for (const log of (data.logs || [])) {
			if (!log.topics || !log.topics[0] || log.topics[0].toLowerCase() !== STASH_DEPLOYED_TOPIC0.toLowerCase()) continue;
			out.push({
				user: '0x' + log.topics[1].slice(-40),
				stash: '0x' + log.topics[2].slice(-40),
				timestamp: log.timestamp,
			});
		}
		url = data.links && data.links.next ? base + data.links.next : null;
	}
	return out;
}

function pad(s, n) {
	s = String(s == null ? '' : s);
	return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

async function main() {
	const flags = parseArgs(process.argv.slice(2));
	const env = flags.env || process.env.ENVIRONMENT;
	const factoryId = process.env.BIDDER_FACTORY_CONTRACT_ID;
	const implId = process.env.BIDDER_IMPL_CONTRACT_ID || process.env.BIDDER_CONTRACT_IMPL_ID;

	if (!env) { console.error('ERROR: ENVIRONMENT not set (test|main|preview|local)'); process.exit(1); }
	if (!factoryId) { console.error('ERROR: BIDDER_FACTORY_CONTRACT_ID not set'); process.exit(1); }
	if (!implId) { console.error('ERROR: BIDDER_IMPL_CONTRACT_ID (or BIDDER_CONTRACT_IMPL_ID) not set'); process.exit(1); }

	const implEvm = await getContractEVMAddress(env, implId);
	if (!implEvm) { console.error(`ERROR: could not resolve impl ${implId} EVM address from mirror node`); process.exit(1); }

	// Check the implementation's Sourcify status ONCE (all stashes share it).
	const implRecord = await checkVerified({ chainId: chainIdForEnv(env), address: implEvm.toLowerCase() });
	const implMatch = implRecord ? (implRecord.match || implRecord.runtimeMatch) : null;

	console.log(`\nStash audit on '${env}'  (factory ${factoryId})`);
	console.log(`Implementation: BidderContract @ ${implEvm}  →  Sourcify: ${implMatch || 'NOT VERIFIED'}`);
	if (flags.since) console.log(`Incremental: stashes deployed after ${flags.since}`);

	const events = await fetchStashEvents(env, factoryId, flags.since);
	console.log(`Discovered ${events.length} stash(es) via StashDeployed events.\n`);

	const results = [];
	for (const ev of events) {
		// Skip per-stash impl re-check (same impl every time) — already known above.
		const r = await resolveProxyStatus({
			env,
			address: ev.stash,
			expectedImplementation: implEvm,
			checkImplementationVerified: false,
		});
		results.push({ ...ev, ...r, ok: r.isProxy && r.isCanonical });
	}

	if (flags.json) {
		console.log(JSON.stringify({ implementation: implEvm, implementationMatch: implMatch, stashes: results }, null, 2));
	}
	else {
		const line = '='.repeat(118);
		console.log(line);
		console.log(pad('Stash', 44) + pad('Owner', 44) + pad('Canonical proxy?', 18) + 'Note');
		console.log('-'.repeat(118));
		for (const r of results) {
			const verdict = r.ok ? 'OK' : (!r.isProxy ? 'NOT A PROXY' : 'WRONG IMPL');
			const note = r.ok ? '' : (!r.isProxy ? `runtime is not EIP-1167 (${r.bytecode ? r.bytecode.slice(0, 20) + '…' : 'no bytecode'})` : `points at ${r.implementation}, expected ${implEvm}`);
			console.log(pad(r.stash, 44) + pad(r.user, 44) + pad(r.ok ? '✓' : '✗ ' + verdict, 18) + note);
		}
		console.log(line);
		const bad = results.filter(r => !r.ok).length;
		console.log(`Summary: ${results.length - bad}/${results.length} canonical${bad ? `, ${bad} FLAGGED` : ''}; implementation ${implMatch || 'NOT VERIFIED'}\n`);
	}

	// Exit non-zero on any integrity violation OR if the shared impl isn't verified.
	const anyBad = results.some(r => !r.ok);
	process.exit(anyBad || !implMatch ? 1 : 0);
}

main().catch((err) => {
	console.error('\n❌ Stash audit crashed:', err.message || err);
	process.exit(1);
});
