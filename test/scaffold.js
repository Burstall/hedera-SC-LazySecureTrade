// Shared deploy/setup helpers for AgentEnvelope test suites.
//
// The smoke file (AgentEnvelope.test.js) and the comprehensive suite
// (AgentEnvelopeFull.test.js) share the same scaffold:
//   - Hedera client + operator
//   - ABIs for BCF / BidderContract / VIPSubscription / IAgentEnvelope / LST
//   - Cached test accounts (Alice + Bob) — created on first run, reused after
//   - BCF reused from .env, fail loud if absent
//   - VIPSubscription deployed fresh OR reused from .env (caller decides)
//   - Stash auto-deployed for Alice
//   - BCF tier-limits table populated (first-call-instant on a fresh BCF;
//     no-op via 48h timelock on a reused BCF — caller's job to know which)
//   - Optional: bring Alice up to a target VIP tier via either admin
//     `extendSubscription` (Bronze only — admin can't bump tier) or
//     `purchaseSubscription` (any tier — needs LAZY allowance to LGS).
//
// All exports are pure functions returning new objects — no module-level
// state. Caller threads the returned context object through their before()
// chain.

const fs = require('fs');
const { ethers } = require('ethers');
const { expect } = require('chai');
const {
	Client,
	AccountId,
	PrivateKey,
	TokenId,
	ContractId,
	ContractFunctionParameters,
	HbarUnit,
	Hbar,
	TransferTransaction,
	AccountInfoQuery,
} = require('@hashgraph/sdk');
const { fail } = require('assert');

const {
	contractDeployFunction,
	contractExecuteFunction,
	readOnlyEVMFromMirrorNode,
} = require('../utils/solidityHelpers');
const {
	accountCreator,
	sendHbar,
	setFTAllowance,
} = require('../utils/hederaHelpers');
const {
	checkMirrorBalance,
	checkMirrorHbarBalance,
} = require('../utils/hederaMirrorHelpers');
const { sleep } = require('../utils/nodeHelpers');

require('dotenv').config();

// ============================================
// Constants
// ============================================

const MIRROR_DELAY = Number(process.env.SLEEP_TIME) || 5500;

const TIER = { Free: 0, Bronze: 1, Silver: 2, Gold: 3, Platinum: 4 };

const ACTION = {
	BidCreate: 0,
	BidCancel: 1,
	TradeExecute: 2,
	TradeList: 3,
	TradeCancel: 4,
	Arbitrage: 5,
	AuctionCreate: 6,
	AuctionBid: 7,
	AuctionBuyNow: 8,
};

const BITS = {
	BidCreate: 1 << ACTION.BidCreate,
	BidCancel: 1 << ACTION.BidCancel,
	TradeExecute: 1 << ACTION.TradeExecute,
	TradeList: 1 << ACTION.TradeList,
	TradeCancel: 1 << ACTION.TradeCancel,
	Arbitrage: 1 << ACTION.Arbitrage,
	AuctionCreate: 1 << ACTION.AuctionCreate,
	AuctionBid: 1 << ACTION.AuctionBid,
	AuctionBuyNow: 1 << ACTION.AuctionBuyNow,
	All: 0xffffffff,
};

// Tier limits used to populate BCF's table on a fresh deploy. The
// existing smoke file ships these values; we keep them stable so a
// session reusing the smoke-deployed BCF sees the same caps.
const TIER_LIMITS = {
	Free: {
		maxAgents: 0,
		dailyHbarCap: 0, dailyLazyCap: 0n,
		perTxHbarCap: 0, perTxLazyCap: 0n,
		maxExpiryWindow: 0,
	},
	Bronze: {
		maxAgents: 1,
		dailyHbarCap: Number(new Hbar(500, HbarUnit.Hbar).toTinybars()),
		dailyLazyCap: 5_000n * 10n ** 8n,
		perTxHbarCap: Number(new Hbar(200, HbarUnit.Hbar).toTinybars()),
		perTxLazyCap: 2_000n * 10n ** 8n,
		maxExpiryWindow: 365 * 24 * 60 * 60,
	},
	Silver: {
		maxAgents: 2,
		dailyHbarCap: Number(new Hbar(1500, HbarUnit.Hbar).toTinybars()),
		dailyLazyCap: 15_000n * 10n ** 8n,
		perTxHbarCap: Number(new Hbar(500, HbarUnit.Hbar).toTinybars()),
		perTxLazyCap: 5_000n * 10n ** 8n,
		maxExpiryWindow: 365 * 24 * 60 * 60,
	},
	Gold: {
		maxAgents: 3,
		dailyHbarCap: Number(new Hbar(3500, HbarUnit.Hbar).toTinybars()),
		dailyLazyCap: 35_000n * 10n ** 8n,
		perTxHbarCap: Number(new Hbar(1000, HbarUnit.Hbar).toTinybars()),
		perTxLazyCap: 10_000n * 10n ** 8n,
		maxExpiryWindow: 365 * 24 * 60 * 60,
	},
	Platinum: {
		maxAgents: 5,
		dailyHbarCap: Number(new Hbar(10000, HbarUnit.Hbar).toTinybars()),
		dailyLazyCap: 100_000n * 10n ** 8n,
		perTxHbarCap: Number(new Hbar(2500, HbarUnit.Hbar).toTinybars()),
		perTxLazyCap: 25_000n * 10n ** 8n,
		maxExpiryWindow: 365 * 24 * 60 * 60,
	},
};

function tierLimitsTuple(t) {
	return [
		t.maxAgents,
		t.dailyHbarCap,
		t.dailyLazyCap.toString(),
		t.perTxHbarCap,
		t.perTxLazyCap.toString(),
		t.maxExpiryWindow,
	];
}

// ============================================
// ABI loaders
// ============================================

function loadIfaces() {
	const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
	const bcf = read('./artifacts/contracts/BidderContractFactory.sol/BidderContractFactory.json');
	const bc = read('./artifacts/contracts/BidderContract.sol/BidderContract.json');
	const ae = read('./artifacts/contracts/interfaces/IAgentEnvelope.sol/IAgentEnvelope.json');
	const vip = read('./artifacts/contracts/VIPSubscription.sol/VIPSubscription.json');
	const lst = read('./artifacts/contracts/LazySecureTrade.sol/LazySecureTrade.json');
	const lgs = read('./artifacts/contracts/LazyGasStation.sol/LazyGasStation.json');
	const lazyCreator = read('./artifacts/contracts/legacy/LAZYTokenCreator.sol/LAZYTokenCreator.json');
	return {
		bcf: { iface: new ethers.Interface(bcf.abi), bytecode: bcf.bytecode },
		bc:  { iface: new ethers.Interface(bc.abi), bytecode: bc.bytecode },
		ae:  { iface: new ethers.Interface(ae.abi) },
		vip: { iface: new ethers.Interface(vip.abi), bytecode: vip.bytecode },
		lst: { iface: new ethers.Interface(lst.abi), bytecode: lst.bytecode },
		lgs: { iface: new ethers.Interface(lgs.abi), bytecode: lgs.bytecode },
		lazyCreator: { iface: new ethers.Interface(lazyCreator.abi) },
	};
}

// ============================================
// Mirror-query helper (3-retry with backoff)
// ============================================

function makeMirrorQuery(env, operatorId) {
	return async function mirrorQuery(contractId, iface, fcnName, params = []) {
		const encoded = iface.encodeFunctionData(fcnName, params);
		let lastErr;
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				const raw = await readOnlyEVMFromMirrorNode(
					env, contractId, encoded, operatorId, false,
				);
				return iface.decodeFunctionResult(fcnName, raw);
			}
			catch (e) {
				lastErr = e;
				await sleep(800 * (attempt + 1));
			}
		}
		throw lastErr;
	};
}

// ============================================
// Revert assertion
// ============================================

function expectRevertNamed(result, expectedName, extraIfaces = []) {
	const status = result?.[0]?.status;
	const name = status?.name?.toString?.();
	if (name === expectedName) return;
	const raw = status?.raw;
	if (raw && raw.length >= 10) {
		const selector = raw.slice(0, 10);
		for (const ifc of extraIfaces) {
			try {
				const e = ifc.getError(selector);
				if (e && e.name === expectedName) return;
			}
			// Selector miss — try next interface.
			catch (_) { /* eslint-disable-line no-empty */ }
		}
	}
	fail(`Expected revert ${expectedName}; got name=${name} raw=${raw}`);
}

// Lenient revert matcher — accepts any of a set of names. Used for
// "owner-only" reverts where the contract may use OnlyOwner OR
// Ownable's revert string (Hedera testnet has surfaced both shapes
// in different consensus generations).
function expectRevertOneOf(result, expectedNames, extraIfaces = []) {
	const status = result?.[0]?.status;
	const name = status?.name?.toString?.();
	if (expectedNames.includes(name)) return;
	const raw = status?.raw;
	if (raw && raw.length >= 10) {
		const selector = raw.slice(0, 10);
		for (const ifc of extraIfaces) {
			try {
				const e = ifc.getError(selector);
				if (e && expectedNames.includes(e.name)) return;
			}
			// Selector miss — try next interface.
			catch (_) { /* eslint-disable-line no-empty */ }
		}
	}
	fail(`Expected revert in {${expectedNames.join(',')}}; got name=${name} raw=${raw}`);
}

// ============================================
// Account creation / topup
// ============================================

async function getOrCreateAccount(client, operatorKey, envIdKey, envPkKey, initialHbar = 100) {
	if (process.env[envIdKey] && process.env[envPkKey]) {
		return {
			id: AccountId.fromString(process.env[envIdKey]),
			pk: PrivateKey.fromStringED25519(process.env[envPkKey]),
		};
	}
	const [id, pk] = await accountCreator(client, operatorKey, initialHbar);
	return { id, pk };
}

async function topUpHbar(env, client, operatorId, accountId, targetHbar) {
	const bal = await checkMirrorHbarBalance(env, accountId);
	const target = Number(new Hbar(targetHbar, HbarUnit.Hbar).toTinybars());
	if (bal === null || Number(bal) < target / 2) {
		await sendHbar(client, operatorId, accountId, targetHbar, HbarUnit.Hbar);
		return true;
	}
	return false;
}

// ============================================
// VIPSubscription deploy / wire
// ============================================

async function deployFreshVip(client, ifaces, operatorId, operatorKey, lazyTokenId, lazyGasStationId) {
	const params = new ContractFunctionParameters()
		.addAddress(lazyTokenId.toSolidityAddress())
		.addAddress(lazyGasStationId.toSolidityAddress());
	const [vipId] = await contractDeployFunction(client, ifaces.vip.bytecode, 3_500_000, params);

	// Authorize VIP on LGS so purchaseSubscription can pull LAZY
	await contractExecuteFunction(
		lazyGasStationId, ifaces.lgs.iface, client, 200_000,
		'addContractUser', [vipId.toSolidityAddress()],
	);

	// Set monthly prices low enough for Alice's LAZY balance to cover
	// upgrades. 1 base unit per month satisfies MIN_MONTHLY_PRICE = 1.
	// Note: the 2000-bps annual-prepay discount applies pro-rata; at
	// 1-month / price 10, final = 10 × (1 - 166/10_000) = ~9 base units.
	const mult = 10 ** Number(process.env.LAZY_DECIMAL ?? process.env.LAZY_DECIMALS ?? 1);
	for (const [tier, price] of [
		[TIER.Bronze, 10 * mult],
		[TIER.Silver, 20 * mult],
		[TIER.Gold, 50 * mult],
		[TIER.Platinum, 100 * mult],
	]) {
		await contractExecuteFunction(
			vipId, ifaces.vip.iface, client, 200_000,
			'setMonthlyPrice', [tier, price],
		);
		await sleep(800);
	}
	return vipId;
}

// ============================================
// BCF tier-table population
// ============================================
//
// On a freshly-deployed BCF the first setAgentTierLimits call for each
// tier applies instantly (`agentTierConfigured[tier] = false`). On a
// reused BCF the second-call path queues a 48h timelock and does NOT
// affect the active table — so this is idempotent and cheap to retry.
async function ensureBcfTierLimits(client, bcfId, bcfIface) {
	for (const [name, tier] of [
		['Bronze', TIER.Bronze],
		['Silver', TIER.Silver],
		['Gold', TIER.Gold],
		['Platinum', TIER.Platinum],
	]) {
		await contractExecuteFunction(
			bcfId, bcfIface, client, 400_000,
			'setAgentTierLimits',
			[tier, tierLimitsTuple(TIER_LIMITS[name])],
		);
		await sleep(1500);
	}
}

// ============================================
// Stash deploy
// ============================================

async function ensureStash(env, client, operatorId, operatorKey, bcfId, bcfIface, owner) {
	const mirrorQuery = makeMirrorQuery(env, operatorId);
	const stashAddress = (await mirrorQuery(
		bcfId, bcfIface, 'getStashAddress', [owner.id.toSolidityAddress()],
	))[0];
	const isValid = (await mirrorQuery(
		bcfId, bcfIface, 'isValidStash', [stashAddress],
	))[0];
	if (!isValid) {
		client.setOperator(owner.id, owner.pk);
		const [rx] = await contractExecuteFunction(
			bcfId, bcfIface, client, 2_000_000, 'deployStash', [],
		);
		expect(rx.status.toString()).to.equal('SUCCESS');
		client.setOperator(operatorId, operatorKey);
		await sleep(MIRROR_DELAY);
	}
	const stashEvm = stashAddress.toLowerCase().replace('0x', '');
	const stashId = ContractId.fromSolidityAddress(stashEvm);
	return { stashId, stashAddress };
}

// ============================================
// Tier management
// ============================================
//
// admin extendSubscription → Bronze only (preserves existing tier if
// any; defaults to Bronze for a fresh user). To reach Silver/Gold/
// Platinum the user must purchaseSubscription, which costs LAZY and
// needs an LGS allowance.

async function ensureTier(ctx, owner, targetTier) {
	const { env, client, operatorId, operatorKey, vipId, ifaces, mirrorQuery, lazyTokenId, lazyGasStationId } = ctx;
	if (!vipId) throw new Error('ensureTier requires vipId');

	// Read current tier
	const currentTier = Number((await mirrorQuery(
		vipId, ifaces.vip.iface, 'getTierFor', [owner.id.toSolidityAddress()],
	))[0]);

	// Already at target — nothing to do.
	if (currentTier === targetTier) return;

	if (targetTier === TIER.Free) {
		// Can't downgrade on-chain. Caller's only option is a fresh VIP
		// or letting the existing sub expire — out of scope here.
		if (currentTier !== TIER.Free) {
			throw new Error(`Cannot downgrade ${owner.id} from tier ${currentTier} to Free. Deploy a fresh VIPSubscription.`);
		}
		return;
	}

	if (targetTier < currentTier) {
		throw new Error(`Cannot downgrade ${owner.id} from tier ${currentTier} to ${targetTier}. VIPSubscription has no admin-downgrade path.`);
	}

	// Fund Alice's LAZY for the purchase. priceFor returns the
	// discounted price; the LGS allowance must cover ≥ that amount.
	const mult = 10n ** BigInt(Number(process.env.LAZY_DECIMAL ?? process.env.LAZY_DECIMALS ?? 1));
	// 100 LAZY base units (× decimals) headroom covers Bronze through
	// Platinum at the 1-month prices configured in deployFreshVip.
	const allowanceTarget = 200n * mult;

	// Ensure Alice is associated with LAZY (smoke setup usually does this,
	// but be defensive on first-time accounts).
	const aliceLazy = await checkMirrorBalance(env, owner.id, lazyTokenId);
	if (aliceLazy === null) {
		throw new Error(`Account ${owner.id} not associated with LAZY token. Associate first via owner.pk.`);
	}
	if (BigInt(aliceLazy) < allowanceTarget) {
		// Operator (LazyTokenCreator-style) tops up Alice. Use the
		// factory's authorized contract-user path on LGS if available,
		// else assume operator can transfer LAZY directly.
		throw new Error(`Account ${owner.id} has ${aliceLazy} LAZY base units, needs >= ${allowanceTarget}. Top up before running tier tests.`);
	}

	client.setOperator(owner.id, owner.pk);
	// SDK expects Number/Long for approveTokenAllowance; convert from BigInt.
	await setFTAllowance(client, lazyTokenId, owner.id, lazyGasStationId, Number(allowanceTarget));

	const [rx] = await contractExecuteFunction(
		vipId, ifaces.vip.iface, client, 1_000_000,
		'purchaseSubscription', [targetTier, 1, []],
	);
	expect(rx.status.toString()).to.equal('SUCCESS');
	client.setOperator(operatorId, operatorKey);
	await sleep(MIRROR_DELAY);
}

// Lightweight admin path — sufficient for Bronze.
async function grantBronzeViaAdmin(ctx, owner, months = 6) {
	const { client, vipId, ifaces } = ctx;
	await contractExecuteFunction(
		vipId, ifaces.vip.iface, client, 200_000,
		'extendSubscription', [owner.id.toSolidityAddress(), months],
	);
	await sleep(MIRROR_DELAY);
}

// ============================================
// Stash subsystem wiring
// ============================================

async function wireStashSubsystems(ctx, owner, stashId, { vip = true, ea = false } = {}) {
	const { client, operatorId, operatorKey, vipId, ifaces } = ctx;
	client.setOperator(owner.id, owner.pk);
	if (vip && vipId) {
		await contractExecuteFunction(
			stashId, ifaces.bc.iface, client, 200_000,
			'setVipSubscription', [vipId.toSolidityAddress()],
		);
	}
	if (ea && process.env.ENGLISH_AUCTION_CONTRACT_ID) {
		const eaId = ContractId.fromString(process.env.ENGLISH_AUCTION_CONTRACT_ID);
		await contractExecuteFunction(
			stashId, ifaces.bc.iface, client, 200_000,
			'setEnglishAuction', [eaId.toSolidityAddress()],
		);
	}
	client.setOperator(operatorId, operatorKey);
	await sleep(MIRROR_DELAY);
}

// ============================================
// Envelope cleanup
// ============================================

async function cancelAllEnvelopes(ctx, owner, stashId) {
	const { client, operatorId, operatorKey, mirrorQuery, ifaces } = ctx;
	client.setOperator(owner.id, owner.pk);
	let safety = 10;
	while (safety-- > 0) {
		const count = Number((await mirrorQuery(
			stashId, ifaces.bc.iface, 'activeEnvelopeCount', [],
		))[0]);
		if (count === 0) break;
		const agent = (await mirrorQuery(
			stashId, ifaces.bc.iface, 'activeAgentAt', [0],
		))[0];
		await contractExecuteFunction(
			stashId, ifaces.bc.iface, client, 400_000,
			'cancelEnvelope', [agent],
		);
		await sleep(MIRROR_DELAY);
	}
	client.setOperator(operatorId, operatorKey);
}

// ============================================
// Agent Hedera-account provisioning
// ============================================
//
// The agent envelope auth model is `msg.sender == agentKey`. So an
// agent EOA can only act on its envelope by submitting a Hedera tx
// from a Hedera account whose EVM-address equivalent is the wallet's
// address. We provision such accounts via the alias auto-create
// pattern: HBAR transfer to the alias address materializes a Hedera
// account; subsequent SDK calls using PrivateKey.fromStringECDSA
// sign as that account.

async function provisionAgentHederaAccount(client, operatorId, wallet, fundHbar = 5) {
	const ecdsaKey = PrivateKey.fromStringECDSA(wallet.privateKey);
	// Step 1 — funding: address the soon-to-exist account by alias-key
	// (a derivable form Hedera consensus accepts as a *receiver*). The
	// transfer auto-creates the account with the ECDSA key as its key.
	const aliasAccountId = ecdsaKey.publicKey.toAccountId(0, 0);

	const transferResp = await new TransferTransaction()
		.addHbarTransfer(operatorId, new Hbar(-fundHbar))
		.addHbarTransfer(aliasAccountId, new Hbar(fundHbar))
		.freezeWith(client)
		.execute(client);
	await transferResp.getReceipt(client);

	// Step 2 — resolve numeric form for use as PAYER. The SDK rejects
	// alias-key AccountIds in `setOperator` (no checksum) and Hedera
	// consensus rejects `AccountId.fromEvmAddress` long-zero forms at
	// precheck (PAYER_ACCOUNT_NOT_FOUND). AccountInfoQuery on the alias
	// returns the actual `0.0.<num>` form — that's what works.
	const info = await new AccountInfoQuery()
		.setAccountId(aliasAccountId)
		.execute(client);

	return {
		id: info.accountId,
		pk: ecdsaKey,
		evm: wallet.address.toLowerCase(),
		wallet,
	};
}

// Build an AgentAuth tuple for an agent-mediated call.
function buildAgentAuth(agentKey, reasoningTopicId = '0x0000000000000000000000000000000000000000000000000000000000000000') {
	return [agentKey, reasoningTopicId];
}

// ============================================
// Stash HBAR funding (so agent createBid has backing)
// ============================================

async function depositHbarToStash(client, fromAccountId, stashId, hbar) {
	// `sendHbar` from hederaHelpers normalizes any entity-id (Contract /
	// Account / Token) to AccountId.fromString(<id>.toString()) — the
	// numeric form Hedera consensus accepts directly. The earlier
	// pattern using AccountId.fromEvmAddress here works for some
	// receivers but not all, depending on whether the EVM→numeric
	// mapping has been cached by mirror nodes.
	await sendHbar(client, fromAccountId, stashId, hbar, HbarUnit.Hbar);
}

// ============================================
// Stash LAZY funding
// ============================================
//
// BidderContract.createBid checks `IERC20(lazyToken).balanceOf(stash)
// < lazyAmount` BEFORE invoking the envelope `spendForAgent` callback.
// To exercise the per-tx + daily LAZY cap branches, the stash must
// hold enough LAZY to clear the balance check first.
//
// LAZYTokenCreator.transferHTS is the treasury-funded transfer wrapper
// used across the test suite (e.g. BCF P5.9 funds Bob's stash this
// way). Requires LAZY_SCT_CONTRACT_ID in .env.

async function fundStashLazy(ctx, stashId, baseUnits) {
	const { client, ifaces, lazyTokenId, operatorId, operatorKey } = ctx;
	if (!process.env.LAZY_SCT_CONTRACT_ID) {
		throw new Error('fundStashLazy requires LAZY_SCT_CONTRACT_ID in .env');
	}
	if (!lazyTokenId) {
		throw new Error('fundStashLazy requires LAZY_TOKEN_ID in .env');
	}
	const lazySct = ContractId.fromString(process.env.LAZY_SCT_CONTRACT_ID);
	const stashEvm = '0x' + stashId.toSolidityAddress();
	client.setOperator(operatorId, operatorKey);
	await contractExecuteFunction(
		lazySct, ifaces.lazyCreator.iface, client, 400_000,
		'transferHTS',
		[lazyTokenId.toSolidityAddress(), stashEvm, Number(baseUnits)],
	);
	await sleep(MIRROR_DELAY);
}

// ============================================
// Top-level setup
// ============================================

async function setupScaffold(options = {}) {
	const {
		freshVip = false,
		// Numeric TIER.* or null (skip tier provisioning).
		ensureAliceTier: targetTier = null,
		configureBcfTiers = true,
		wireAlice = true,
	} = options;

	const env = (process.env.ENVIRONMENT ?? 'test').toLowerCase();

	const operatorId = AccountId.fromString(process.env.ACCOUNT_ID);
	const operatorKey = PrivateKey.fromStringED25519(process.env.PRIVATE_KEY);

	const client = env === 'main' ? Client.forMainnet()
		: env === 'preview' ? Client.forPreviewnet()
			: Client.forTestnet();
	client.setOperator(operatorId, operatorKey);

	const ifaces = loadIfaces();
	const mirrorQuery = makeMirrorQuery(env, operatorId);

	// --- BCF (reused; must be cached) ---
	const cachedBcf = process.env.BIDDER_FACTORY_CONTRACT_ID
        || process.env.BCF_CONTRACT_ID;
	if (!cachedBcf) {
		throw new Error('AgentEnvelope tests require a cached BCF. '
            + 'Run BidderContractFactory.test.js once to provision, '
            + 'cache BIDDER_FACTORY_CONTRACT_ID in .env, then re-run.');
	}
	const bcfId = ContractId.fromString(cachedBcf);

	// --- LST + LAZY + LGS handles (used for tier purchases + AE0 checks) ---
	const lstId = process.env.LAZY_SECURE_TRADE_CONTRACT_ID
		? ContractId.fromString(process.env.LAZY_SECURE_TRADE_CONTRACT_ID)
		: null;
	const lazyTokenId = process.env.LAZY_TOKEN_ID
		? TokenId.fromString(process.env.LAZY_TOKEN_ID)
		: null;
	const lazyGasStationId = process.env.LAZY_GAS_STATION_CONTRACT_ID
		? ContractId.fromString(process.env.LAZY_GAS_STATION_CONTRACT_ID)
		: null;

	// --- VIPSubscription (fresh or cached) ---
	let vipId;
	if (freshVip) {
		if (!lazyTokenId || !lazyGasStationId) {
			throw new Error('freshVip requires LAZY_TOKEN_ID + LAZY_GAS_STATION_CONTRACT_ID in .env.');
		}
		vipId = await deployFreshVip(client, ifaces, operatorId, operatorKey, lazyTokenId, lazyGasStationId);
	}
	else {
		if (!process.env.VIP_SUBSCRIPTION_CONTRACT_ID) {
			throw new Error('AgentEnvelope tests require VIP_SUBSCRIPTION_CONTRACT_ID in .env '
                + '(or pass freshVip: true to deploy one).');
		}
		vipId = ContractId.fromString(process.env.VIP_SUBSCRIPTION_CONTRACT_ID);
	}

	// --- Accounts ---
	const alice = await getOrCreateAccount(client, operatorKey, 'ALICE_ACCOUNT_ID', 'ALICE_PRIVATE_KEY', 100);
	const bob = await getOrCreateAccount(client, operatorKey, 'BOB_ACCOUNT_ID', 'BOB_PRIVATE_KEY', 100);

	// --- Top up Alice + Bob HBAR (BCF cleanup may have swept them) ---
	await topUpHbar(env, client, operatorId, alice.id, 100);
	await topUpHbar(env, client, operatorId, bob.id, 50);

	// --- BCF tier-table (idempotent — no-op on reused BCF) ---
	if (configureBcfTiers) {
		await ensureBcfTierLimits(client, bcfId, ifaces.bcf.iface);
	}

	// --- Stash for Alice ---
	const aliceStash = await ensureStash(
		env, client, operatorId, operatorKey,
		bcfId, ifaces.bcf.iface, alice,
	);

	// --- Agent wallets (ECDSA — Hedera supports both, msg.sender-only auth) ---
	const agentWallet1 = ethers.Wallet.createRandom();
	const agentWallet2 = ethers.Wallet.createRandom();
	const agentWallet3 = ethers.Wallet.createRandom();

	const ctx = {
		env, client, operatorId, operatorKey,
		bcfId, vipId, lstId, lazyTokenId, lazyGasStationId,
		ifaces, mirrorQuery,
		alice: { ...alice, evm: alice.id.toSolidityAddress(), stashId: aliceStash.stashId, stashAddress: aliceStash.stashAddress },
		bob: { ...bob, evm: bob.id.toSolidityAddress() },
		agentWallets: [agentWallet1, agentWallet2, agentWallet3],
		helpers: {
			mirrorQuery,
			expectRevertNamed,
			expectRevertOneOf,
			sleep,
			cancelAllEnvelopes,
			ensureTier,
			grantBronzeViaAdmin,
			wireStashSubsystems,
		},
		constants: { TIER, ACTION, BITS, TIER_LIMITS, MIRROR_DELAY },
	};

	// Wire VIP on Alice's stash if requested + bring her up to the
	// target tier (caller's choice — null skips both).
	if (wireAlice) {
		await wireStashSubsystems(ctx, ctx.alice, ctx.alice.stashId, { vip: true });
	}
	if (targetTier !== null) {
		// Bootstrap: admin grants Bronze first (which seeds tier=Bronze
		// for a fresh user), then purchaseSubscription climbs higher.
		if (targetTier !== TIER.Free) {
			await grantBronzeViaAdmin(ctx, ctx.alice);
			if (targetTier > TIER.Bronze) {
				await ensureTier(ctx, ctx.alice, targetTier);
			}
		}
	}

	return ctx;
}

module.exports = {
	setupScaffold,
	// re-exports for tests that want them directly
	TIER,
	ACTION,
	BITS,
	TIER_LIMITS,
	tierLimitsTuple,
	MIRROR_DELAY,
	loadIfaces,
	makeMirrorQuery,
	expectRevertNamed,
	expectRevertOneOf,
	ensureStash,
	cancelAllEnvelopes,
	provisionAgentHederaAccount,
	buildAgentAuth,
	depositHbarToStash,
	fundStashLazy,
};
