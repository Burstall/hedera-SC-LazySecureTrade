// Grant a paid VIP tier to a user WITHOUT charging $LAZY — the x402
// convenience-rail path (payment settled off-chain in HBAR/USDC, then the
// tier is granted on-chain). Calls VIPSubscription.grantSubscription.
//
// The caller is the .env operator. That account must be EITHER the contract
// owner OR the registered systemWallet (see setSystemWallet.js) — otherwise
// the call reverts NotAuthorizedGrantor. To exercise the backend path, set
// ACCOUNT_ID/PRIVATE_KEY to the system wallet's credentials.
//
// Tier transitions mirror purchaseSubscription:
//   none/expired → new sub | same tier → extend | lower→higher → upgrade
//   in place | higher active + lower grant → reverts (never downgrades).
//
// Requires .env:
//   VIP_SUBSCRIPTION_CONTRACT_ID
//   GRANT_USER    — beneficiary, as "0.0.x" account id or "0x..." address
//   GRANT_TIER    — bronze | silver | gold | platinum (or 1..4)
//   GRANT_MONTHS  — 30-day months to grant (1..12)
//
// Optional .env:
//   GRANT_REF     — correlation id for the off-chain payment. A 32-byte
//                   "0x.." hex is used verbatim; any other string is
//                   keccak256-hashed. Omitted → a one-off ref is derived
//                   (fine for manual comps; pass the real payment id for
//                   reconciliation). Refs are single-use (replay reverts).
//
// Usage:
//   node scripts/interactions/grantSubscription.js

const fs = require('fs');
const {
	Client,
	AccountId,
	PrivateKey,
	ContractId,
} = require('@hashgraph/sdk');
const { ethers } = require('ethers');
const {
	contractExecuteFunction,
	readOnlyEVMFromMirrorNode,
} = require('../../utils/solidityHelpers');
const { sleep } = require('../../utils/nodeHelpers');
require('dotenv').config();

const MIRROR_DELAY = Number(process.env.SLEEP_TIME) || 5500;
const TIER_NAMES = ['Free', 'Bronze', 'Silver', 'Gold', 'Platinum'];
const MAX_GRANT_MONTHS = 12;

function resolveAddress(raw) {
	if (!raw) throw new Error('GRANT_USER is required');
	if (raw.startsWith('0x')) return ethers.getAddress(raw);
	return ethers.getAddress('0x' + AccountId.fromString(raw).toSolidityAddress());
}

function resolveTier(raw) {
	if (!raw) throw new Error('GRANT_TIER is required');
	const asNum = Number(raw);
	if (Number.isInteger(asNum) && asNum >= 1 && asNum <= 4) return asNum;
	const idx = TIER_NAMES.findIndex((t) => t.toLowerCase() === String(raw).toLowerCase());
	if (idx >= 1) return idx;
	throw new Error(`GRANT_TIER invalid: "${raw}" (use bronze|silver|gold|platinum or 1..4)`);
}

function resolveRef(raw, user) {
	if (raw && /^0x[0-9a-fA-F]{64}$/.test(raw)) return raw;
	if (raw) return ethers.id(raw); // keccak256 of an arbitrary correlation string
	return ethers.id(`manual-grant:${user}:${Date.now()}`);
}

(async () => {
	const env = (process.env.ENVIRONMENT || 'test').toLowerCase();
	const operatorId = AccountId.fromString(process.env.ACCOUNT_ID);
	const operatorKey = PrivateKey.fromStringED25519(process.env.PRIVATE_KEY);
	const client = env === 'main' ? Client.forMainnet()
		: env === 'preview' ? Client.forPreviewnet()
			: Client.forTestnet();
	client.setOperator(operatorId, operatorKey);

	if (!process.env.VIP_SUBSCRIPTION_CONTRACT_ID) {
		console.error('Missing required .env key: VIP_SUBSCRIPTION_CONTRACT_ID');
		process.exit(1);
	}

	const vipId = ContractId.fromString(process.env.VIP_SUBSCRIPTION_CONTRACT_ID);
	const user = resolveAddress(process.env.GRANT_USER);
	const tier = resolveTier(process.env.GRANT_TIER);
	const months = Number(process.env.GRANT_MONTHS);
	if (!Number.isInteger(months) || months < 1 || months > MAX_GRANT_MONTHS) {
		console.error(`GRANT_MONTHS must be an integer 1..${MAX_GRANT_MONTHS} (got "${process.env.GRANT_MONTHS}")`);
		process.exit(1);
	}
	const ref = resolveRef(process.env.GRANT_REF, user);

	console.log('--- VIPSubscription grantSubscription ---');
	console.log('Environment:    ', env);
	console.log('Caller:         ', operatorId.toString(), '(must be owner or systemWallet)');
	console.log('VIPSubscription:', vipId.toString());
	console.log('Beneficiary:    ', user);
	console.log('Tier:           ', TIER_NAMES[tier], `(${tier})`);
	console.log('Months:         ', months);
	console.log('Ref:            ', ref);

	const vipJson = JSON.parse(fs.readFileSync(
		'./artifacts/contracts/VIPSubscription.sol/VIPSubscription.json', 'utf8',
	));
	const vipIface = new ethers.Interface(vipJson.abi);

	const resp = await contractExecuteFunction(
		vipId, vipIface, client, 300_000, 'grantSubscription', [user, tier, months, ref], 0, true,
	);
	const statusStr = resp?.[0]?.status?.toString?.() ?? '';
	if (statusStr !== 'SUCCESS') {
		throw new Error(`grantSubscription failed: status=${statusStr} name=${resp?.[0]?.status?.name ?? 'unknown'}`);
	}
	console.log('  grantSubscription OK');

	await sleep(MIRROR_DELAY);

	const view = async (fcn, args) => {
		const enc = vipIface.encodeFunctionData(fcn, args);
		const raw = await readOnlyEVMFromMirrorNode(env, vipId, enc, operatorId, false);
		return vipIface.decodeFunctionResult(fcn, raw);
	};

	const tierNow = Number((await view('getTierFor', [user]))[0]);
	const sub = (await view('subscriptionOf', [user]))[0];
	const expiresAt = Number(sub.expiresAt);

	console.log('\nMirror verification:');
	console.log('  getTierFor   =', TIER_NAMES[tierNow], `(${tierNow})`);
	console.log('  expiresAt    =', expiresAt, '→', new Date(expiresAt * 1000).toISOString());

	process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
