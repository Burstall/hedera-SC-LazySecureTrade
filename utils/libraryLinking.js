// Library linking for the size-split external libraries.
//
// `LSHTierLib.getTierFor` and `AgentEnvelopeLib.verifyAndConsume` are `public`
// (external, linked) so their bytecode is deployed ONCE and kept out of every
// caller — this is what keeps LazySecureTrade / EnglishAuction / BidderContract
// under the 24,576-byte EIP-170 limit (viaIR is mandatory here and inflates
// size, so inlining these two functions blew the budget).
//
// A linked contract's creation bytecode carries a 40-char placeholder
// `__$<34-hex>$__` (a 20-byte slot) wherever a library address belongs. Before
// deploying such a contract we must substitute the deployed library's EVM
// address into every placeholder, using the artifact's `linkReferences`
// (byte offsets). This module is the single source of truth for that.
//
// Which contracts need which libraries (from the artifacts' linkReferences):
//   LazySecureTrade      → LSHTierLib      (×1)
//   EnglishAuction       → LSHTierLib      (×1)
//   BidderContract       → AgentEnvelopeLib(×4)
//   BidderContractFactory/VIPSubscription/LazyRebatePool/... → none

const fs = require('fs');
const { ContractId } = require('@hashgraph/sdk');
const { contractDeployFunction } = require('./solidityHelpers');

const LSH_TIER_LIB_PATH = './artifacts/contracts/libraries/LSHTierLib.sol/LSHTierLib.json';
const AGENT_ENVELOPE_LIB_PATH = './artifacts/contracts/libraries/AgentEnvelopeLib.sol/AgentEnvelopeLib.json';

/**
 * Substitute deployed library addresses into a contract's creation bytecode.
 * @param {string} bytecode        Artifact creation bytecode ('0x…', with placeholders).
 * @param {object} linkReferences  Artifact `linkReferences` map.
 * @param {object} addressMap      { LibName: evmHex } where evmHex is 40 hex chars (0x optional).
 * @returns {string} Fully-linked bytecode ('0x…').
 */
function linkLibraries(bytecode, linkReferences, addressMap) {
	const prefix = bytecode.startsWith('0x') ? 2 : 0;
	let bc = bytecode;
	for (const path in (linkReferences || {})) {
		for (const libName in linkReferences[path]) {
			const raw = addressMap[libName];
			if (!raw) throw new Error(`linkLibraries: no address for library ${libName}`);
			const hex = raw.replace(/^0x/, '').toLowerCase();
			if (hex.length !== 40) throw new Error(`linkLibraries: bad address for ${libName}: ${raw}`);
			for (const { start, length } of linkReferences[path][libName]) {
				if (length !== 20) throw new Error(`linkLibraries: unexpected ref length ${length}`);
				const pos = prefix + start * 2;
				bc = bc.slice(0, pos) + hex + bc.slice(pos + length * 2);
			}
		}
	}
	if (/__\$[0-9a-fA-F]{34}\$__/.test(bc)) {
		throw new Error('linkLibraries: unresolved library placeholder(s) remain — missing address in addressMap');
	}
	return bc;
}

/**
 * Deploy (or reuse) the two external libraries and return their EVM addresses.
 * Reuses cached ids from .env when present (LSH_TIER_LIB_CONTRACT_ID /
 * AGENT_ENVELOPE_LIB_CONTRACT_ID) so grind runs don't redeploy them.
 * @param {Client} client Hedera client (operator set).
 * @returns {Promise<{LSHTierLib: string, AgentEnvelopeLib: string, ids: object}>}
 */
async function ensureLibraries(client) {
	const out = { ids: {} };

	async function one(name, envVar, path, gas) {
		const cached = process.env[envVar];
		if (cached) {
			const id = ContractId.fromString(cached);
			out.ids[name] = id;
			return id.toSolidityAddress();
		}
		const json = JSON.parse(fs.readFileSync(path, 'utf8'));
		const [id] = await contractDeployFunction(client, json.bytecode, gas);
		out.ids[name] = id;
		console.log(`Deployed library ${name}: ${id.toString()} (cache as ${envVar}=${id.toString()})`);
		return id.toSolidityAddress();
	}

	out.LSHTierLib = await one('LSHTierLib', 'LSH_TIER_LIB_CONTRACT_ID', LSH_TIER_LIB_PATH, 1_500_000);
	out.AgentEnvelopeLib = await one('AgentEnvelopeLib', 'AGENT_ENVELOPE_LIB_CONTRACT_ID', AGENT_ENVELOPE_LIB_PATH, 1_500_000);
	return out;
}

/**
 * Convenience: link an artifact's bytecode against a library address map.
 * @param {object} artifact  Parsed contract artifact (has .bytecode + .linkReferences).
 * @param {object} addressMap { LibName: evmHex }.
 * @returns {string} Linked bytecode.
 */
function linkedBytecode(artifact, addressMap) {
	return linkLibraries(artifact.bytecode, artifact.linkReferences, addressMap);
}

module.exports = { linkLibraries, ensureLibraries, linkedBytecode };
