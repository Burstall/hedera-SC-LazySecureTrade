// Register (or rotate) the x402 convenience-rail system wallet on
// VIPSubscription. The system wallet is a limited backend signer allowed
// to call `grantSubscription` (grant a paid tier WITHOUT $LAZY after an
// off-chain HBAR/USDC payment) — it has NO owner powers and cannot touch
// funds. Pass address(0) to DISABLE the system-grant path.
//
// Must be run by the contract owner (the .env operator).
//
// Requires .env:
//   VIP_SUBSCRIPTION_CONTRACT_ID
//   VIP_SYSTEM_WALLET   — the backend wallet, as either a Hedera account
//                         id ("0.0.x") or an EVM address ("0x...").
//                         Use "0" or "0x0" to disable the system path.
//
// Usage:
//   node scripts/interactions/setSystemWallet.js

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
const ZERO_ADDR = '0x' + '0'.repeat(40);

// Accept either a Hedera account id ("0.0.x") or an EVM address ("0x..").
// "0" / "0x0" / empty → zero address (disable).
function resolveWallet(raw) {
	if (!raw || raw === '0' || raw === '0x0' || raw === ZERO_ADDR) return ZERO_ADDR;
	if (raw.startsWith('0x')) return ethers.getAddress(raw);
	return ethers.getAddress('0x' + AccountId.fromString(raw).toSolidityAddress());
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
	const wallet = resolveWallet(process.env.VIP_SYSTEM_WALLET);

	console.log('--- VIPSubscription setSystemWallet ---');
	console.log('Environment:    ', env);
	console.log('Operator (owner):', operatorId.toString());
	console.log('VIPSubscription:', vipId.toString());
	console.log('System wallet:  ', wallet, wallet === ZERO_ADDR ? '(DISABLES system grants)' : '');

	const vipJson = JSON.parse(fs.readFileSync(
		'./artifacts/contracts/VIPSubscription.sol/VIPSubscription.json', 'utf8',
	));
	const vipIface = new ethers.Interface(vipJson.abi);

	const resp = await contractExecuteFunction(
		vipId, vipIface, client, 200_000, 'setSystemWallet', [wallet], 0, true,
	);
	const statusStr = resp?.[0]?.status?.toString?.() ?? '';
	if (statusStr !== 'SUCCESS') {
		throw new Error(`setSystemWallet failed: status=${statusStr} name=${resp?.[0]?.status?.name ?? 'unknown'}`);
	}
	console.log('  setSystemWallet OK');

	await sleep(MIRROR_DELAY);

	const enc = vipIface.encodeFunctionData('systemWallet', []);
	const raw = await readOnlyEVMFromMirrorNode(env, vipId, enc, operatorId, false);
	const onChain = vipIface.decodeFunctionResult('systemWallet', raw)[0];

	console.log('\nMirror verification:');
	console.log('  systemWallet =', onChain, onChain.toLowerCase() === wallet.toLowerCase() ? 'OK' : 'MISMATCH');

	process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
