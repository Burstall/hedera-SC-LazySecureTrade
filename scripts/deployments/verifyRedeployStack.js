'use strict';
/**
 * Sourcify-verify the full v0.3 stack, INCLUDING the externally-linked
 * contracts. LazySecureTrade / EnglishAuction (link LSHTierLib) and
 * BidderContract (links AgentEnvelopeLib) are compiled UNLINKED by Hardhat
 * (empty settings.libraries, __$hash$__ placeholders) and linked at deploy
 * time by utils/libraryLinking.js. Sourcify recompiles from the build-info
 * stdJsonInput, so we must inject the deployed library addresses into
 * settings.libraries or the recompiled bytecode keeps placeholders and never
 * matches. The @lazysuperheroes/hedera-verify engine has no library support,
 * so we do the injection here and hand it a pre-resolved `build`.
 *
 * Linked contracts land a RUNTIME "match" (not "exact_match"): the metadata
 * CBOR was baked pre-link (empty libraries), so the metadata hash can't match
 * a deploy-time-linked contract. Non-linked contracts get "exact_match".
 *
 * Usage: node scripts/deployments/verifyRedeployStack.js
 */
const fs = require('fs');
const { verifyContract } = require('@lazysuperheroes/hedera-verify');
const { resolveBuildInfo } = require('@lazysuperheroes/hedera-verify/src/buildInfo');
require('dotenv').config();

const env = (process.env.ENVIRONMENT || 'test').toLowerCase();
const entityNum = (id) => id.split('.')[2];
const longZero = (id) => '0x' + BigInt(entityNum(id)).toString(16).padStart(40, '0');

// Deployed library addresses (long-zero EVM) keyed by library name.
const LIBS = {
	LSHTierLib: longZero(process.env.LSH_TIER_LIB_CONTRACT_ID),
	AgentEnvelopeLib: longZero(process.env.AGENT_ENVELOPE_LIB_CONTRACT_ID),
};

const TARGETS = [
	{ name: 'LazySecureTrade', idVar: 'LAZY_SECURE_TRADE_CONTRACT_ID' },   // links LSHTierLib
	{ name: 'EnglishAuction', idVar: 'ENGLISH_AUCTION_CONTRACT_ID' },      // links LSHTierLib
	{ name: 'BidderContract', idVar: 'BIDDER_CONTRACT_IMPL_ID' },          // links AgentEnvelopeLib
	{ name: 'BidderContractFactory', idVar: 'BIDDER_FACTORY_CONTRACT_ID' },
	{ name: 'VIPSubscription', idVar: 'VIP_SUBSCRIPTION_CONTRACT_ID' },
	{ name: 'LazyRebatePool', idVar: 'LAZY_REBATE_POOL_CONTRACT_ID' },
	{ name: 'LSHTierLib', idVar: 'LSH_TIER_LIB_CONTRACT_ID' },
	{ name: 'AgentEnvelopeLib', idVar: 'AGENT_ENVELOPE_LIB_CONTRACT_ID' },
];

function artifactPath(name) {
	// Contracts live under contracts/<name>.sol/, libraries under
	// contracts/libraries/<name>.sol/. Return the first that exists.
	return [
		`./artifacts/contracts/${name}.sol/${name}.json`,
		`./artifacts/contracts/libraries/${name}.sol/${name}.json`,
	].find((p) => fs.existsSync(p));
}

function injectLibraries(build, contractName) {
	const artPath = artifactPath(contractName);
	if (!artPath) return false;
	const linkRefs = (JSON.parse(fs.readFileSync(artPath, 'utf8')).linkReferences) || {};
	if (Object.keys(linkRefs).length === 0) return false;
	const libs = {};
	for (const srcPath of Object.keys(linkRefs)) {
		for (const libName of Object.keys(linkRefs[srcPath])) {
			if (!LIBS[libName]) throw new Error(`No deployed address for linked library ${libName}`);
			(libs[srcPath] = libs[srcPath] || {})[libName] = LIBS[libName];
		}
	}
	build.stdJsonInput.settings = build.stdJsonInput.settings || {};
	build.stdJsonInput.settings.libraries = libs;
	return libs;
}

(async () => {
	console.log(`Verifying v0.3 stack on Sourcify (${env}). Libs: LSHTierLib=${LIBS.LSHTierLib} AgentEnvelopeLib=${LIBS.AgentEnvelopeLib}\n`);
	const results = [];
	for (const t of TARGETS) {
		const id = process.env[t.idVar];
		if (!id) { console.log(`skip ${t.name} — ${t.idVar} unset`); continue; }
		const build = resolveBuildInfo({ contractName: t.name });
		const injected = injectLibraries(build, t.name);
		if (injected) console.log(`[${t.name}] linked → ${JSON.stringify(injected)}`);
		const r = await verifyContract({
			build, env, contractId: id, contractName: t.name,
			initialDelayMs: 0, attempts: 3, retryDelayMs: 8000,
		});
		results.push({ name: t.name, id, status: r.status, match: r.match, url: r.repoUrl });
	}
	console.log('\n=== SUMMARY ===');
	for (const r of results) {
		console.log(`  ${r.name.padEnd(24)} ${r.id.padEnd(13)} ${r.status}${r.match ? ` (${r.match})` : ''}${r.url ? '  ' + r.url : ''}`);
	}
	const bad = results.filter((r) => !['verified', 'already_verified', 'pending'].includes(r.status));
	process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
