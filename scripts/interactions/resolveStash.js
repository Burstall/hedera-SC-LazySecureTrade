#!/usr/bin/env node
'use strict';

/**
 * Resolve a stash to its (verified) implementation — the reference for how the
 * DApp should present a stash.
 *
 * A stash is an EIP-1167 minimal-proxy clone of BidderContract, so it can't be
 * source-verified on Sourcify and shows "unverified" on HashScan. But the proxy
 * bytecode embeds the implementation address, and the implementation IS verified
 * — so the frontend reads the impl out of the bytecode and presents the stash
 * with BidderContract's name + ABI (exactly what Etherscan's "Read as Proxy"
 * does). This script demonstrates that resolution via
 * @lazysuperheroes/hedera-verify's `resolveProxyStatus`.
 *
 * Usage:
 *   node scripts/interactions/resolveStash.js 0.0.9130719
 *   node scripts/interactions/resolveStash.js 0x607bc8772f1838f3eeccd3ab11d96b8b7d4e83e0
 *   node scripts/interactions/resolveStash.js --user 0xabd6353c6891d7222f40165b762ef52ffde51c95
 *
 * Env: ENVIRONMENT, and (for --user) BIDDER_FACTORY_CONTRACT_ID + ACCOUNT_ID.
 * The impl id (BIDDER_IMPL_CONTRACT_ID / BIDDER_CONTRACT_IMPL_ID) is optional —
 * if set, the resolver also confirms the stash points at the *expected* impl.
 */

require('dotenv').config();
const fs = require('fs');
const ethers = require('ethers');
const { ContractId, AccountId } = require('@hashgraph/sdk');
const { resolveProxyStatus } = require('@lazysuperheroes/hedera-verify');
const { getContractEVMAddress } = require('../../utils/hederaMirrorHelpers');
const { readOnlyEVMFromMirrorNode } = require('../../utils/solidityHelpers');

const ABI_HINT = 'abi/BidderContract.json (or artifacts/contracts/BidderContract.sol/BidderContract.json)';

function parseArgs(argv) {
	const positional = [];
	const flags = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith('--')) flags[a.slice(2)] = argv[++i];
		else positional.push(a);
	}
	return { positional, flags };
}

/** Compute a user's stash address via the factory's getStashAddress() view. */
async function stashAddressForUser(env, factoryId, userEvm) {
	const factoryJson = JSON.parse(
		fs.readFileSync('./artifacts/contracts/BidderContractFactory.sol/BidderContractFactory.json', 'utf8'),
	);
	const iface = new ethers.Interface(factoryJson.abi);
	const data = iface.encodeFunctionData('getStashAddress', [userEvm]);
	const from = AccountId.fromString(process.env.ACCOUNT_ID);
	const result = await readOnlyEVMFromMirrorNode(env, ContractId.fromString(factoryId), data, from, false);
	const [addr] = iface.decodeFunctionResult('getStashAddress', result);
	return addr;
}

async function main() {
	const { positional, flags } = parseArgs(process.argv.slice(2));
	const env = flags.env || process.env.ENVIRONMENT;
	if (!env) { console.error('ERROR: ENVIRONMENT not set (test|main|preview|local)'); process.exit(1); }

	let target = positional[0];
	if (flags.user) {
		const factoryId = process.env.BIDDER_FACTORY_CONTRACT_ID;
		if (!factoryId) { console.error('ERROR: --user needs BIDDER_FACTORY_CONTRACT_ID'); process.exit(1); }
		target = await stashAddressForUser(env, factoryId, flags.user);
		console.log(`getStashAddress(${flags.user}) → ${target}`);
	}
	if (!target) {
		console.error('Usage: node scripts/interactions/resolveStash.js <stashId|0xaddr>  |  --user <0xaddr>');
		process.exit(1);
	}

	const implId = process.env.BIDDER_IMPL_CONTRACT_ID || process.env.BIDDER_CONTRACT_IMPL_ID;
	const expectedImpl = implId ? await getContractEVMAddress(env, implId) : undefined;

	const isAddr = /^0x[0-9a-fA-F]{40}$/.test(target);
	const r = await resolveProxyStatus({
		env,
		address: isAddr ? target : undefined,
		contractId: isAddr ? undefined : target,
		expectedImplementation: expectedImpl,
	});

	console.log('\n--- Stash resolution (what the DApp should render) ---');
	console.log('stash:                ', r.address);
	console.log('is EIP-1167 proxy:    ', r.isProxy);
	console.log('implementation:       ', r.implementation || '(not a proxy)');
	if (expectedImpl) console.log('matches expected impl:', r.isCanonical, `(expected ${expectedImpl})`);
	console.log('impl verified:        ', r.implementationVerified, r.implementationMatch ? `(${r.implementationMatch})` : '');
	console.log('HashScan:             ', r.hashscanUrl);
	if (r.isProxy && r.implementationVerified) {
		console.log(`\n→ Frontend: label this stash "BidderContract", load its ABI from`);
		console.log(`  ${ABI_HINT}, and bind it to ${r.address} for read/write.`);
	}
	else if (r.isProxy) {
		console.log('\n→ Stash is a clean proxy, but its implementation is NOT verified on Sourcify.');
	}
	else {
		console.log('\n→ This address is NOT an EIP-1167 minimal proxy — do not treat it as a stash.');
	}

	process.exit(r.isProxy && (!expectedImpl || r.isCanonical) ? 0 : 1);
}

main().catch((err) => {
	console.error('\n❌ resolveStash crashed:', err.message || err);
	process.exit(1);
});
