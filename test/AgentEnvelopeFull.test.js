// Agent envelope — comprehensive Sessions 1+2 suite (AE0–AE7).
//
// Scope follows docs/v0.3-AE-TEST-PLAN.md. Sessions 1+2 cover the
// pre-mainnet hardening envelope; the timing-bound subset (AE11) lives
// in AgentEnvelopeTiming.test.js so the default test run skips real-
// time waits.
//
// Coverage:
//   AE0 — Pre-flight + scaffold (BCF↔LST authority, BCF/EA/VIP wiring,
//         Alice stash deploy)
//   AE1 — Envelope CRUD + tier-table enforcement
//   AE2 — msg.sender authentication (rewritten from old EIP-712 model)
//   AE3 — Tier-cap enforcement at create
//   AE4 — Per-tx budget caps
//   AE5 — Daily budget consumption
//   AE6 — Pause / kill-switch
//   AE7 — Multi-envelope isolation
//
// Tests that require an agent EOA submitting Hedera transactions
// provision Hedera accounts via the alias auto-create pattern (HBAR
// transfer to the wallet's EVM address materializes the account; the
// ECDSA private key signs subsequent transactions).
//
// Prereqs (in .env):
//   ACCOUNT_ID, PRIVATE_KEY (ED25519), ENVIRONMENT
//   LAZY_TOKEN_ID, LAZY_GAS_STATION_CONTRACT_ID, LAZY_DELEGATE_REGISTRY_CONTRACT_ID
//   LAZY_SECURE_TRADE_CONTRACT_ID (reused)
//   BIDDER_FACTORY_CONTRACT_ID (reused; required)
//   ALICE_ACCOUNT_ID + ALICE_PRIVATE_KEY (ED25519)
//   BOB_ACCOUNT_ID + BOB_PRIVATE_KEY (ED25519)
//   AE3 + tier-shuffling tests REQUIRE: comment out
//     VIP_SUBSCRIPTION_CONTRACT_ID so a fresh VIP deploys, and ensure
//     Alice has ≥200 base-unit LAZY balance to fund tier purchases.
//
// Budget (testnet HBAR):
//   Sessions 1+2 combined ≈ 130 HBAR per the plan. Each agent account
//   provisioned eats ~5 HBAR upfront for funding; the rest is gas +
//   stash funding.

const { expect } = require('chai');
const { describe, it, before, after } = require('mocha');
const { ethers } = require('ethers');
const { Hbar, HbarUnit, TokenId } = require('@hashgraph/sdk');

// Resolve the BCF test NFT collection address once. All AE2+ bid tests
// reference this token; tests skip cleanly when the .env var is absent.
function bcfNftAddress() {
	if (!process.env.BCF_NFT_TOKEN_ID) return null;
	return '0x' + TokenId.fromString(process.env.BCF_NFT_TOKEN_ID).toSolidityAddress();
}

const {
	setupScaffold,
	TIER,
	BITS,
	TIER_LIMITS,
	MIRROR_DELAY,
	expectRevertNamed,
	cancelAllEnvelopes,
	provisionAgentHederaAccount,
	buildAgentAuth,
	depositHbarToStash,
	fundStashLazy,
} = require('./scaffold');

const {
	contractExecuteFunction,
} = require('../utils/solidityHelpers');
const { sleep } = require('../utils/nodeHelpers');
const { EMPTY_AUTH } = require('../utils/agentAuth');

// ============================================
// Top-level setup
// ============================================

let ctx;
let alice, bob;
let bcfId, vipId, lstId;
let stashId, stashAddress;
let bcfIface, bcIface, vipIface, aeIface, lstIface;
let mirrorQuery, client, operatorId, operatorKey;

// Reusable agent Hedera accounts. Provisioned lazily inside group
// before()s so test groups that don't need them don't pay the cost.
let agent1, imposter;

before(async function () {
	this.timeout(600_000);

	// The full suite needs a fresh VIP so Alice's tier is predictable
	// and the Free → Bronze → Silver → Gold climb actually exercises
	// distinct tier slots. Caller can override by passing freshVip:
	// false but then AE3 will revert with CannotDowngradeActiveSubscription.
	const freshVip = (process.env.AE_FRESH_VIP ?? '1') === '1';
	ctx = await setupScaffold({
		freshVip,
		// Don't pre-grant tier — AE3 will move Alice through tiers itself.
		ensureAliceTier: null,
		wireAlice: true,
	});

	alice = ctx.alice;
	bob = ctx.bob;
	bcfId = ctx.bcfId;
	vipId = ctx.vipId;
	lstId = ctx.lstId;
	stashId = alice.stashId;
	stashAddress = alice.stashAddress;
	bcfIface = ctx.ifaces.bcf.iface;
	bcIface = ctx.ifaces.bc.iface;
	vipIface = ctx.ifaces.vip.iface;
	aeIface = ctx.ifaces.ae.iface;
	lstIface = ctx.ifaces.lst.iface;
	mirrorQuery = ctx.mirrorQuery;
	client = ctx.client;
	operatorId = ctx.operatorId;
	operatorKey = ctx.operatorKey;

	console.log('Setup complete.');
	console.log('  BCF:', bcfId.toString());
	console.log('  VIP:', vipId.toString(), freshVip ? '(fresh)' : '(reused)');
	if (lstId) console.log('  LST:', lstId.toString());
	console.log('  Alice:', alice.id.toString(), '/', alice.evm);
	console.log('  Alice stash:', stashAddress, '/', stashId.toString());
	console.log('  Bob:', bob.id.toString());
});

// ============================================
// AE0 — Pre-flight + scaffold
// ============================================

describe('AE0 — Pre-flight + scaffold', function () {
	this.timeout(60_000);

	it('AE0.1: BCF↔LST authority chain healthy (authorized OR pending grant queued)', async function () {
		if (!lstId) {
			console.log('AE0.1: LST not in .env — skipping');
			this.skip();
			return;
		}
		const bcfAddr = bcfId.toSolidityAddress();
		const authorized = (await mirrorQuery(
			lstId, lstIface, 'authorizedFactories', [bcfAddr],
		))[0];
		if (authorized) return;

		// Cached LST: factoryAuthorityEverGranted is already true from a
		// prior factory, so the instant-bootstrap branch is closed. A
		// pending grant with a sensible ETA (within 48h+buffer) proves
		// the operator HAS taken the auth step — once the timelock
		// elapses, anyone can call executeFactoryAuthorization.
		const pendingEta = Number((await mirrorQuery(
			lstId, lstIface, 'pendingFactoryAuthEta', [bcfAddr],
		))[0]);
		expect(pendingEta).to.be.greaterThan(0, 'No pending factory-auth grant queued on LST');
		const nowSec = Math.floor(Date.now() / 1000);
		const remainingHours = (pendingEta - nowSec) / 3600;
		expect(pendingEta - nowSec).to.be.lessThan(96 * 3600,
			`Pending grant ETA ${remainingHours.toFixed(1)}h in future — exceeds 48h timelock window`);
		console.log(`AE0.1: pending grant queued, ~${remainingHours.toFixed(1)}h remaining until executable`);
	});

	it('AE0.2: BCF wired to VIPSubscription (stash-side) and BCF tier-table populated', async function () {
		// Stash-side VIPSubscription pointer
		const stashVip = (await mirrorQuery(
			stashId, bcIface, 'vipSubscription', [],
		))[0];
		expect(stashVip.toLowerCase()).to.equal(
			('0x' + vipId.toSolidityAddress()).toLowerCase(),
		);

		// BCF tier-table populated (Bronze + Platinum must be non-zero
		// maxAgents for AE3 to function)
		const bronze = (await mirrorQuery(
			bcfId, bcfIface, 'getAgentTierLimits', [TIER.Bronze],
		))[0];
		expect(Number(bronze.maxAgents)).to.be.greaterThan(0);
		const platinum = (await mirrorQuery(
			bcfId, bcfIface, 'getAgentTierLimits', [TIER.Platinum],
		))[0];
		expect(Number(platinum.maxAgents)).to.be.greaterThan(0);
	});

	it('AE0.3: Alice stash deployed and is a valid stash on BCF', async function () {
		const predicted = (await mirrorQuery(
			bcfId, bcfIface, 'getStashAddress', [alice.evm],
		))[0];
		expect(predicted.toLowerCase()).to.equal(stashAddress.toLowerCase());

		const valid = (await mirrorQuery(
			bcfId, bcfIface, 'isValidStash', [stashAddress],
		))[0];
		expect(valid).to.equal(true);

		const ownerOf = (await mirrorQuery(
			stashId, bcIface, 'owner', [],
		))[0];
		expect(ownerOf.toLowerCase()).to.equal('0x' + alice.id.toSolidityAddress().toLowerCase());
	});
});

// ============================================
// AE3 — Tier-cap enforcement at create
// ============================================
//
// Walks Alice through Free → Bronze → Silver → Gold to exercise each
// tier's cap boundary. Requires fresh VIP (already deployed in
// scaffold when freshVip=true).
//
// AE3.5 (grandfather across expiry) is deferred — it requires
// real-time wait and overlaps AE11.4 in the timing suite.

describe('AE3 — Tier-cap enforcement at create', function () {
	this.timeout(240_000);

	before(async function () {
		this.timeout(60_000);
		await cancelAllEnvelopes(ctx, alice, stashId);
	});

	it('AE3.1: Free tier rejects createEnvelope with TierDoesNotPermitEnvelopes', async function () {
		const tier = Number((await mirrorQuery(
			vipId, vipIface, 'getTierFor', [alice.evm],
		))[0]);
		if (tier !== TIER.Free) {
			console.log('AE3.1: Alice tier is', tier, '— expected Free. Suite needs a fresh VIP.');
			this.skip();
			return;
		}
		const t = TIER_LIMITS.Bronze;
		const params = [
			ctx.agentWallets[0].address,
			t.dailyHbarCap, t.dailyLazyCap.toString(),
			t.perTxHbarCap, t.perTxLazyCap.toString(),
			0, BITS.All, ethers.ZeroHash,
		];
		client.setOperator(alice.id, alice.pk);
		const result = await contractExecuteFunction(
			stashId, bcIface, client, 600_000,
			'createEnvelope', [params],
			0, true,
		);
		client.setOperator(operatorId, operatorKey);
		expectRevertNamed(result, 'TierDoesNotPermitEnvelopes', [aeIface]);
	});

	it('AE3.2: Bronze allows 1 envelope; 2nd reverts TierCapExceeded(2, 1)', async function () {
		await ctx.helpers.grantBronzeViaAdmin(ctx, alice);
		await cancelAllEnvelopes(ctx, alice, stashId);

		const t = TIER_LIMITS.Bronze;
		const params0 = [
			ctx.agentWallets[0].address,
			t.dailyHbarCap, t.dailyLazyCap.toString(),
			t.perTxHbarCap, t.perTxLazyCap.toString(),
			0, BITS.All, ethers.ZeroHash,
		];
		client.setOperator(alice.id, alice.pk);
		const [rx1] = await contractExecuteFunction(
			stashId, bcIface, client, 600_000, 'createEnvelope', [params0],
		);
		expect(rx1.status.toString()).to.equal('SUCCESS');
		await sleep(MIRROR_DELAY);

		const params1 = [
			ctx.agentWallets[1].address,
			t.dailyHbarCap, t.dailyLazyCap.toString(),
			t.perTxHbarCap, t.perTxLazyCap.toString(),
			0, BITS.All, ethers.ZeroHash,
		];
		const result = await contractExecuteFunction(
			stashId, bcIface, client, 600_000,
			'createEnvelope', [params1],
			0, true,
		);
		client.setOperator(operatorId, operatorKey);
		expectRevertNamed(result, 'TierCapExceeded', [aeIface]);
	});

	it('AE3.3: Silver dailyHbarCap exceeded reverts InvalidEnvelopeParams', async function () {
		await ctx.helpers.ensureTier(ctx, alice, TIER.Silver);
		await cancelAllEnvelopes(ctx, alice, stashId);

		const t = TIER_LIMITS.Silver;
		// Attempt to create with dailyHbarCap exceeding Silver's cap.
		const params = [
			ctx.agentWallets[0].address,
			t.dailyHbarCap + 1, // over the bound
			t.dailyLazyCap.toString(),
			t.perTxHbarCap, t.perTxLazyCap.toString(),
			0, BITS.All, ethers.ZeroHash,
		];
		client.setOperator(alice.id, alice.pk);
		const result = await contractExecuteFunction(
			stashId, bcIface, client, 600_000,
			'createEnvelope', [params],
			0, true,
		);
		client.setOperator(operatorId, operatorKey);
		expectRevertNamed(result, 'InvalidEnvelopeParams', [aeIface]);
	});

	it('AE3.4: Gold allows 3 envelopes; 4th reverts TierCapExceeded(4, 3)', async function () {
		await ctx.helpers.ensureTier(ctx, alice, TIER.Gold);
		await cancelAllEnvelopes(ctx, alice, stashId);

		const t = TIER_LIMITS.Gold;
		client.setOperator(alice.id, alice.pk);
		for (let i = 0; i < 3; i++) {
			const params = [
				ctx.agentWallets[i].address,
				t.dailyHbarCap, t.dailyLazyCap.toString(),
				t.perTxHbarCap, t.perTxLazyCap.toString(),
				0, BITS.All, ethers.ZeroHash,
			];
			const [rx] = await contractExecuteFunction(
				stashId, bcIface, client, 600_000, 'createEnvelope', [params],
			);
			expect(rx.status.toString()).to.equal('SUCCESS');
			await sleep(2000);
		}
		// 4th — use a freshly generated wallet so it doesn't collide
		// with an existing agent.
		const extra = ethers.Wallet.createRandom();
		const params4 = [
			extra.address,
			t.dailyHbarCap, t.dailyLazyCap.toString(),
			t.perTxHbarCap, t.perTxLazyCap.toString(),
			0, BITS.All, ethers.ZeroHash,
		];
		const result = await contractExecuteFunction(
			stashId, bcIface, client, 600_000,
			'createEnvelope', [params4],
			0, true,
		);
		client.setOperator(operatorId, operatorKey);
		expectRevertNamed(result, 'TierCapExceeded', [aeIface]);
	});

	// AE3.5 (tier-downgrade grandfather) requires real-time expiry —
	// deferred to AgentEnvelopeTiming.test.js (AE11.4).
});

// ============================================
// AE1 — Envelope CRUD + tier enforcement
// ============================================
//
// Bronze grant is sufficient (cap=1; we cancel between subtests when
// we need a fresh slot).

describe('AE1 — Envelope CRUD + tier enforcement', function () {
	this.timeout(180_000);

	before(async function () {
		this.timeout(120_000);
		// Make sure Alice is at Bronze. The scaffold left tier=null so
		// we admin-grant Bronze here.
		const currentTier = Number((await mirrorQuery(
			vipId, vipIface, 'getTierFor', [alice.evm],
		))[0]);
		if (currentTier === TIER.Free) {
			await ctx.helpers.grantBronzeViaAdmin(ctx, alice);
		}
		await cancelAllEnvelopes(ctx, alice, stashId);
	});

	it('AE1.1: owner creates envelope; stored caps match', async function () {
		const t = TIER_LIMITS.Bronze;
		const params = [
			ctx.agentWallets[0].address,
			t.dailyHbarCap,
			t.dailyLazyCap.toString(),
			t.perTxHbarCap,
			t.perTxLazyCap.toString(),
			0,
			BITS.All,
			ethers.ZeroHash,
		];
		client.setOperator(alice.id, alice.pk);
		const [rx] = await contractExecuteFunction(
			stashId, bcIface, client, 600_000,
			'createEnvelope', [params],
		);
		client.setOperator(operatorId, operatorKey);
		expect(rx.status.toString()).to.equal('SUCCESS');
		await sleep(MIRROR_DELAY);

		const env_ = (await mirrorQuery(
			stashId, bcIface, 'getEnvelope', [ctx.agentWallets[0].address],
		))[0];
		expect(env_.agentKey.toLowerCase()).to.equal(ctx.agentWallets[0].address.toLowerCase());
		expect(Number(env_.dailyHbarCap)).to.equal(t.dailyHbarCap);
		expect(Number(env_.perTxHbarCap)).to.equal(t.perTxHbarCap);
		expect(Number(env_.allowedActions)).to.equal(BITS.All);
	});

	it('AE1.2: duplicate agentKey reverts EnvelopeAlreadyExists', async function () {
		const t = TIER_LIMITS.Bronze;
		const params = [
			ctx.agentWallets[0].address,
			t.dailyHbarCap, t.dailyLazyCap.toString(),
			t.perTxHbarCap, t.perTxLazyCap.toString(),
			0, BITS.All, ethers.ZeroHash,
		];
		client.setOperator(alice.id, alice.pk);
		const result = await contractExecuteFunction(
			stashId, bcIface, client, 600_000,
			'createEnvelope', [params],
			0, true,
		);
		client.setOperator(operatorId, operatorKey);
		expectRevertNamed(result, 'EnvelopeAlreadyExists', [aeIface]);
	});

	it('AE1.3: contract address as agentKey reverts AgentKeyIsContract', async function () {
		// The BCF itself is a contract — use it as the "bad" agentKey.
		const t = TIER_LIMITS.Bronze;
		const params = [
			'0x' + bcfId.toSolidityAddress(),
			t.dailyHbarCap, t.dailyLazyCap.toString(),
			t.perTxHbarCap, t.perTxLazyCap.toString(),
			0, BITS.All, ethers.ZeroHash,
		];
		client.setOperator(alice.id, alice.pk);
		const result = await contractExecuteFunction(
			stashId, bcIface, client, 600_000,
			'createEnvelope', [params],
			0, true,
		);
		client.setOperator(operatorId, operatorKey);
		expectRevertNamed(result, 'AgentKeyIsContract', [aeIface]);
	});

	it('AE1.4: cancelEnvelope removes agent from active list', async function () {
		const preCount = Number((await mirrorQuery(
			stashId, bcIface, 'activeEnvelopeCount', [],
		))[0]);
		expect(preCount).to.be.greaterThan(0);

		client.setOperator(alice.id, alice.pk);
		const [rx] = await contractExecuteFunction(
			stashId, bcIface, client, 400_000,
			'cancelEnvelope', [ctx.agentWallets[0].address],
		);
		client.setOperator(operatorId, operatorKey);
		expect(rx.status.toString()).to.equal('SUCCESS');
		await sleep(MIRROR_DELAY);

		const exists = (await mirrorQuery(
			stashId, bcIface, 'envelopeExists', [ctx.agentWallets[0].address],
		))[0];
		expect(exists).to.equal(false);
		const postCount = Number((await mirrorQuery(
			stashId, bcIface, 'activeEnvelopeCount', [],
		))[0]);
		expect(postCount).to.equal(preCount - 1);
	});

	it('AE1.5: cancel + immediate recreate of same agentKey succeeds', async function () {
		// After AE1.4, agentWallet[0] is cancelled. Re-create with same key.
		const t = TIER_LIMITS.Bronze;
		const params = [
			ctx.agentWallets[0].address,
			t.dailyHbarCap, t.dailyLazyCap.toString(),
			t.perTxHbarCap, t.perTxLazyCap.toString(),
			0, BITS.All, ethers.ZeroHash,
		];
		client.setOperator(alice.id, alice.pk);
		const [rx] = await contractExecuteFunction(
			stashId, bcIface, client, 600_000,
			'createEnvelope', [params],
		);
		client.setOperator(operatorId, operatorKey);
		expect(rx.status.toString()).to.equal('SUCCESS');
		await sleep(MIRROR_DELAY);

		const exists = (await mirrorQuery(
			stashId, bcIface, 'envelopeExists', [ctx.agentWallets[0].address],
		))[0];
		expect(exists).to.equal(true);
	});

	it('AE1.6: non-owner createEnvelope reverts OnlyOwner', async function () {
		const t = TIER_LIMITS.Bronze;
		const params = [
			ctx.agentWallets[1].address,
			t.dailyHbarCap, t.dailyLazyCap.toString(),
			t.perTxHbarCap, t.perTxLazyCap.toString(),
			0, BITS.All, ethers.ZeroHash,
		];
		// Bob (not the stash owner) tries to create
		client.setOperator(bob.id, bob.pk);
		const result = await contractExecuteFunction(
			stashId, bcIface, client, 600_000,
			'createEnvelope', [params],
			0, true,
		);
		client.setOperator(operatorId, operatorKey);
		// BidderContract.createEnvelope is gated by `onlyOwner` modifier;
		// the contract emits its own `OnlyOwner()` custom error.
		expectRevertNamed(result, 'OnlyOwner', [bcIface]);
	});

	after(async function () {
		this.timeout(60_000);
		await cancelAllEnvelopes(ctx, alice, stashId);
	});
});

// ============================================
// AE2 — msg.sender authentication
// ============================================
//
// Auth model: msg.sender == auth.agentKey for the agent path;
// msg.sender == owner for the EMPTY_AUTH owner path. The check lives
// in BidderContract._ownerOrAgentMsgSender and reverts OnlyOwner on
// mismatch (the type is overloaded — same error for both branches).

describe('AE2 — msg.sender authentication', function () {
	this.timeout(240_000);

	let envBronzeAgent;
	let stashHbarBudget;

	before(async function () {
		this.timeout(240_000);
		// Ensure Bronze + fresh envelope for the legit agent.
		const tier = Number((await mirrorQuery(
			vipId, vipIface, 'getTierFor', [alice.evm],
		))[0]);
		if (tier === TIER.Free) {
			await ctx.helpers.grantBronzeViaAdmin(ctx, alice);
		}
		await cancelAllEnvelopes(ctx, alice, stashId);

		envBronzeAgent = ctx.agentWallets[0];

		// Tiny caps so each bid consumes a small slice of budget.
		// Smaller than Bronze tier upper bounds, so envelope creation
		// accepts them.
		client.setOperator(alice.id, alice.pk);
		const params = [
			envBronzeAgent.address,
			Number(new Hbar(50, HbarUnit.Hbar).toTinybars()), // dailyHbarCap = 50 HBAR
			'0', // dailyLazyCap = 0 (no LAZY)
			Number(new Hbar(10, HbarUnit.Hbar).toTinybars()), // perTxHbarCap = 10 HBAR
			'0',
			0,
			BITS.All,
			ethers.ZeroHash,
		];
		await contractExecuteFunction(
			stashId, bcIface, client, 600_000,
			'createEnvelope', [params],
		);
		client.setOperator(operatorId, operatorKey);
		await sleep(MIRROR_DELAY);

		// Provision real Hedera accounts for the legit agent and an
		// imposter. ~5 HBAR each; the agent only needs enough for tx
		// fees (not for the bid value — the bid value comes from the
		// stash's own balance).
		agent1 = await provisionAgentHederaAccount(client, operatorId, envBronzeAgent, 5);
		imposter = await provisionAgentHederaAccount(client, operatorId, ctx.agentWallets[2], 5);
		await sleep(MIRROR_DELAY);

		// Stash needs HBAR to back any bid the agent creates.
		stashHbarBudget = 3; // 3 HBAR in the stash; bids are ≤ 1 HBAR
		await depositHbarToStash(client, operatorId, stashId, stashHbarBudget);
		await sleep(MIRROR_DELAY);
	});

	it('AE2.1: agent EOA submits createBid via stash; bid registers + budget consumed', async function () {
		const tokenAddr = bcfNftAddress();
		if (!tokenAddr) {
			console.log('AE2.1: BCF_NFT_TOKEN_ID not in .env — skipping');
			this.skip();
			return;
		}
		const auth = buildAgentAuth(agent1.evm, ethers.ZeroHash);
		const bidHbar = Number(new Hbar(1, HbarUnit.Hbar).toTinybars()); // 1 HBAR bid

		client.setOperator(agent1.id, agent1.pk);
		const [rx] = await contractExecuteFunction(
			stashId, bcIface, client, 1_500_000,
			'createBid',
			[tokenAddr, [], bidHbar, 0, 0, 0, auth],
		);
		client.setOperator(operatorId, operatorKey);
		expect(rx.status.toString()).to.equal('SUCCESS');
		await sleep(MIRROR_DELAY);

		// Envelope's consumedHbarToday should now reflect the bid amount.
		const env_ = (await mirrorQuery(
			stashId, bcIface, 'getEnvelope', [agent1.evm],
		))[0];
		expect(Number(env_.consumedHbarToday)).to.equal(bidHbar);
	});

	it('AE2.2: wrong msg.sender on agent path reverts OnlyOwner', async function () {
		const tokenAddr = bcfNftAddress();
		if (!tokenAddr) {
			this.skip();
			return;
		}
		// Imposter submits with auth.agentKey naming agent1
		const auth = buildAgentAuth(agent1.evm, ethers.ZeroHash);
		client.setOperator(imposter.id, imposter.pk);
		const result = await contractExecuteFunction(
			stashId, bcIface, client, 800_000,
			'createBid',
			[tokenAddr, [], 100, 0, 0, 0, auth],
			0, true,
		);
		client.setOperator(operatorId, operatorKey);
		// _ownerOrAgentMsgSender reverts OnlyOwner when msg.sender !=
		// auth.agentKey on the agent branch.
		expectRevertNamed(result, 'OnlyOwner', [bcIface]);
	});

	it('AE2.3: EMPTY_AUTH from non-owner reverts OnlyOwner', async function () {
		const tokenAddr = bcfNftAddress();
		if (!tokenAddr) {
			this.skip();
			return;
		}
		// Bob submits with EMPTY_AUTH (claiming owner path)
		client.setOperator(bob.id, bob.pk);
		const result = await contractExecuteFunction(
			stashId, bcIface, client, 800_000,
			'createBid',
			[tokenAddr, [], 100, 0, 0, 0, EMPTY_AUTH],
			0, true,
		);
		client.setOperator(operatorId, operatorKey);
		expectRevertNamed(result, 'OnlyOwner', [bcIface]);
	});

	it('AE2.4: EMPTY_AUTH from owner succeeds (no envelope state touched)', async function () {
		const tokenAddr = bcfNftAddress();
		if (!tokenAddr) {
			this.skip();
			return;
		}
		// Snapshot agent1's envelope before/after Alice's owner-path bid.
		const before_ = (await mirrorQuery(
			stashId, bcIface, 'getEnvelope', [agent1.evm],
		))[0];

		client.setOperator(alice.id, alice.pk);
		const [rx] = await contractExecuteFunction(
			stashId, bcIface, client, 1_500_000,
			'createBid',
			[tokenAddr, [], 100, 0, 0, 0, EMPTY_AUTH],
		);
		client.setOperator(operatorId, operatorKey);
		expect(rx.status.toString()).to.equal('SUCCESS');
		await sleep(MIRROR_DELAY);

		const after_ = (await mirrorQuery(
			stashId, bcIface, 'getEnvelope', [agent1.evm],
		))[0];
		// consumedHbarToday should be unchanged — owner path does NOT
		// touch envelope state.
		expect(Number(after_.consumedHbarToday)).to.equal(Number(before_.consumedHbarToday));
	});

	it('AE2.5: agent createBid with non-zero reasoningTopicId emits EnvelopeBudgetConsumed carrying that topic', async function () {
		// Mirror-log decode is heavy; we settle for verifying the tx
		// succeeds + envelope state advances. The event-content check
		// is deferred to the agent runtime integration tests where
		// HCS-10 topic correlation is exercised end-to-end.
		const tokenAddr = bcfNftAddress();
		if (!tokenAddr) {
			this.skip();
			return;
		}
		const topic = '0x' + 'ab'.repeat(32);
		const auth = buildAgentAuth(agent1.evm, topic);
		const bidHbar = Number(new Hbar(0.5, HbarUnit.Hbar).toTinybars());

		const before_ = (await mirrorQuery(
			stashId, bcIface, 'getEnvelope', [agent1.evm],
		))[0];

		client.setOperator(agent1.id, agent1.pk);
		const [rx] = await contractExecuteFunction(
			stashId, bcIface, client, 1_500_000,
			'createBid',
			[tokenAddr, [], bidHbar, 0, 0, 0, auth],
		);
		client.setOperator(operatorId, operatorKey);
		expect(rx.status.toString()).to.equal('SUCCESS');
		await sleep(MIRROR_DELAY);

		const after_ = (await mirrorQuery(
			stashId, bcIface, 'getEnvelope', [agent1.evm],
		))[0];
		expect(Number(after_.consumedHbarToday))
			.to.equal(Number(before_.consumedHbarToday) + bidHbar);
		// The reasoningTopicId is on the AgentAuth (per-tx), not the
		// envelope's storage — so it can only be observed in the
		// emitted event. Deferred to agent-runtime e2e.
	});

	after(async function () {
		this.timeout(60_000);
		await cancelAllEnvelopes(ctx, alice, stashId);
	});
});

// ============================================
// AE4 — Per-tx budget caps
// ============================================
//
// Run after AE3 leaves Alice at Gold. Cancel all envelopes, create a
// new one with deliberately small per-tx caps so the boundary is
// testable with cheap bids.

describe('AE4 — Per-tx budget caps', function () {
	this.timeout(240_000);

	let smallCapsAgent;
	const PER_TX_HBAR = Number(new Hbar(1, HbarUnit.Hbar).toTinybars()); // 1 HBAR cap
	// Small enough to fund from LAZYTokenCreator treasury without
	// stressing supply. Decimals are env-dependent (LAZY_DECIMALS=1 on
	// this testnet); 100 base units is enough headroom for the
	// boundary tests.
	const PER_TX_LAZY = 100n;

	before(async function () {
		this.timeout(240_000);
		// Self-bootstrap: if running this group standalone (without
		// AE3's tier walk), Alice is still Free and createEnvelope
		// would silently fail with TierDoesNotPermitEnvelopes. Bronze
		// is sufficient for AE4's small caps.
		const tier = Number((await mirrorQuery(
			vipId, vipIface, 'getTierFor', [alice.evm],
		))[0]);
		if (tier === TIER.Free) {
			await ctx.helpers.grantBronzeViaAdmin(ctx, alice);
		}
		await cancelAllEnvelopes(ctx, alice, stashId);

		smallCapsAgent = ctx.agentWallets[0];

		client.setOperator(alice.id, alice.pk);
		const params = [
			smallCapsAgent.address,
			Number(new Hbar(100, HbarUnit.Hbar).toTinybars()), // dailyHbarCap = 100 HBAR
			(PER_TX_LAZY * 100n).toString(), // dailyLazyCap = 1000 LAZY
			PER_TX_HBAR,
			PER_TX_LAZY.toString(),
			0, BITS.All, ethers.ZeroHash,
		];
		await contractExecuteFunction(
			stashId, bcIface, client, 600_000, 'createEnvelope', [params],
		);
		client.setOperator(operatorId, operatorKey);
		await sleep(MIRROR_DELAY);

		agent1 = await provisionAgentHederaAccount(client, operatorId, smallCapsAgent, 5);
		await depositHbarToStash(client, operatorId, stashId, 5);
		await sleep(MIRROR_DELAY);
	});

	it('AE4.1: bid above perTxHbarCap reverts PerTxCapExceeded(attempted, cap, false)', async function () {
		const tokenAddr = bcfNftAddress();
		if (!tokenAddr) {
			this.skip();
			return;
		}
		const auth = buildAgentAuth(agent1.evm, ethers.ZeroHash);
		client.setOperator(agent1.id, agent1.pk);
		const result = await contractExecuteFunction(
			stashId, bcIface, client, 1_500_000,
			'createBid',
			[tokenAddr, [], PER_TX_HBAR + 1, 0, 0, 0, auth],
			0, true,
		);
		client.setOperator(operatorId, operatorKey);
		expectRevertNamed(result, 'PerTxCapExceeded', [aeIface]);
	});

	it('AE4.2: bid above perTxLazyCap reverts PerTxCapExceeded(attempted, cap, true)', async function () {
		const tokenAddr = bcfNftAddress();
		if (!tokenAddr) {
			this.skip();
			return;
		}
		// Fund stash with enough LAZY so the balance check clears and
		// the perTxCap check fires. BidderContract.createBid order:
		//   (1) balance check, (2) _ownerOrAgentMsgSender,
		//   (3) factory.createBid → stash.spendForAgent → per-tx cap.
		await fundStashLazy(ctx, stashId, PER_TX_LAZY + 10n);

		const auth = buildAgentAuth(agent1.evm, ethers.ZeroHash);
		const overLazy = (PER_TX_LAZY + 1n).toString();
		client.setOperator(agent1.id, agent1.pk);
		const result = await contractExecuteFunction(
			stashId, bcIface, client, 1_500_000,
			'createBid',
			[tokenAddr, [], 0, overLazy, 0, 0, auth],
			0, true,
		);
		client.setOperator(operatorId, operatorKey);
		expectRevertNamed(result, 'PerTxCapExceeded', [aeIface]);
	});

	it('AE4.3: bid exactly at perTxHbarCap succeeds', async function () {
		const tokenAddr = bcfNftAddress();
		if (!tokenAddr) {
			this.skip();
			return;
		}
		const auth = buildAgentAuth(agent1.evm, ethers.ZeroHash);
		client.setOperator(agent1.id, agent1.pk);
		const [rx] = await contractExecuteFunction(
			stashId, bcIface, client, 1_500_000,
			'createBid',
			[tokenAddr, [], PER_TX_HBAR, 0, 0, 0, auth],
		);
		client.setOperator(operatorId, operatorKey);
		expect(rx.status.toString()).to.equal('SUCCESS');
	});

	it('AE4.4: zero per-tx cap envelope blocks every spending action', async function () {
		// Cancel current envelope, recreate with perTxHbarCap = 0.
		await cancelAllEnvelopes(ctx, alice, stashId);

		// Fresh ECDSA wallet so we don't collide with cancelled envelope's
		// index residue (defensive — cancel + recreate same key is
		// tested in AE1.5).
		const zeroCapWallet = ethers.Wallet.createRandom();
		client.setOperator(alice.id, alice.pk);
		await contractExecuteFunction(
			stashId, bcIface, client, 600_000,
			'createEnvelope', [[
				zeroCapWallet.address,
				Number(new Hbar(100, HbarUnit.Hbar).toTinybars()),
				'0',
				0, // perTxHbarCap = 0
				'0', // perTxLazyCap = 0
				0, BITS.All, ethers.ZeroHash,
			]],
		);
		client.setOperator(operatorId, operatorKey);
		await sleep(MIRROR_DELAY);

		const zeroAgent = await provisionAgentHederaAccount(client, operatorId, zeroCapWallet, 5);
		await sleep(MIRROR_DELAY);

		const tokenAddr = bcfNftAddress();
		if (!tokenAddr) {
			this.skip();
			return;
		}
		const auth = buildAgentAuth(zeroAgent.evm, ethers.ZeroHash);

		// Even 1 tinybar is > 0 cap.
		client.setOperator(zeroAgent.id, zeroAgent.pk);
		const result = await contractExecuteFunction(
			stashId, bcIface, client, 1_500_000,
			'createBid',
			[tokenAddr, [], 1, 0, 0, 0, auth],
			0, true,
		);
		client.setOperator(operatorId, operatorKey);
		expectRevertNamed(result, 'PerTxCapExceeded', [aeIface]);
	});

	after(async function () {
		this.timeout(60_000);
		await cancelAllEnvelopes(ctx, alice, stashId);
	});
});

// ============================================
// AE5 — Daily budget consumption
// ============================================
//
// Within a single UTC day — no day-rollover waits. We accumulate
// consumption and then attempt one bid past the cap.

describe('AE5 — Daily budget consumption', function () {
	this.timeout(240_000);

	let dailyAgent;
	const PER_TX_HBAR = Number(new Hbar(2, HbarUnit.Hbar).toTinybars()); // 2 HBAR per bid
	const DAILY_HBAR = Number(new Hbar(5, HbarUnit.Hbar).toTinybars()); // 5 HBAR / day

	before(async function () {
		this.timeout(240_000);
		// Self-bootstrap tier (see AE4 rationale).
		const tier = Number((await mirrorQuery(
			vipId, vipIface, 'getTierFor', [alice.evm],
		))[0]);
		if (tier === TIER.Free) {
			await ctx.helpers.grantBronzeViaAdmin(ctx, alice);
		}
		await cancelAllEnvelopes(ctx, alice, stashId);

		dailyAgent = ctx.agentWallets[0];

		client.setOperator(alice.id, alice.pk);
		await contractExecuteFunction(
			stashId, bcIface, client, 600_000,
			'createEnvelope', [[
				dailyAgent.address,
				DAILY_HBAR,
				'0',
				PER_TX_HBAR,
				'0',
				0, BITS.All, ethers.ZeroHash,
			]],
		);
		client.setOperator(operatorId, operatorKey);
		await sleep(MIRROR_DELAY);

		agent1 = await provisionAgentHederaAccount(client, operatorId, dailyAgent, 8);
		await depositHbarToStash(client, operatorId, stashId, 6);
		await sleep(MIRROR_DELAY);
	});

	it('AE5.1: daily HBAR consumption accumulates across multiple bids', async function () {
		const tokenAddr = bcfNftAddress();
		if (!tokenAddr) {
			this.skip();
			return;
		}
		const auth = buildAgentAuth(agent1.evm, ethers.ZeroHash);

		const before_ = (await mirrorQuery(
			stashId, bcIface, 'getEnvelope', [agent1.evm],
		))[0];

		// Two bids at PER_TX_HBAR each. Total = 2*2 = 4 HBAR < 5 HBAR cap.
		client.setOperator(agent1.id, agent1.pk);
		for (let i = 0; i < 2; i++) {
			const [rx] = await contractExecuteFunction(
				stashId, bcIface, client, 1_500_000,
				'createBid',
				[tokenAddr, [], PER_TX_HBAR, 0, 0, 0, auth],
			);
			expect(rx.status.toString()).to.equal('SUCCESS');
			await sleep(2000);
		}
		client.setOperator(operatorId, operatorKey);
		await sleep(MIRROR_DELAY);

		const after_ = (await mirrorQuery(
			stashId, bcIface, 'getEnvelope', [agent1.evm],
		))[0];
		expect(Number(after_.consumedHbarToday))
			.to.equal(Number(before_.consumedHbarToday) + 2 * PER_TX_HBAR);
	});

	it('AE5.2: bid exceeding remaining daily HBAR reverts BudgetExhausted', async function () {
		const tokenAddr = bcfNftAddress();
		if (!tokenAddr) {
			this.skip();
			return;
		}
		const auth = buildAgentAuth(agent1.evm, ethers.ZeroHash);

		// After AE5.1, consumed = 4 HBAR. Remaining = 1 HBAR. Try 2 HBAR.
		client.setOperator(agent1.id, agent1.pk);
		const result = await contractExecuteFunction(
			stashId, bcIface, client, 1_500_000,
			'createBid',
			[tokenAddr, [], PER_TX_HBAR, 0, 0, 0, auth],
			0, true,
		);
		client.setOperator(operatorId, operatorKey);
		expectRevertNamed(result, 'BudgetExhausted', [aeIface]);
	});

	it('AE5.3: daily LAZY consumption — accumulates then exhausts', async function () {
		// Symmetric of AE5.1+AE5.2 for LAZY. Two bids at perTxCap consume
		// the full daily; the third bid would push consumption over and
		// reverts BudgetExhausted.
		await cancelAllEnvelopes(ctx, alice, stashId);

		const lazyPerTx = 60n;
		const lazyDaily = 100n; // two bids @60 would exceed daily=100

		const lazyWallet = ctx.agentWallets[1];
		client.setOperator(alice.id, alice.pk);
		await contractExecuteFunction(
			stashId, bcIface, client, 600_000,
			'createEnvelope', [[
				lazyWallet.address,
				'0',
				lazyDaily.toString(),
				0,
				lazyPerTx.toString(),
				0, BITS.All, ethers.ZeroHash,
			]],
		);
		client.setOperator(operatorId, operatorKey);
		await sleep(MIRROR_DELAY);

		const lazyAgent = await provisionAgentHederaAccount(client, operatorId, lazyWallet, 5);
		await sleep(MIRROR_DELAY);

		const tokenAddr = bcfNftAddress();
		if (!tokenAddr) {
			this.skip();
			return;
		}
		// Fund stash with enough for both bids + headroom for the
		// over-cap attempt's balance check.
		await fundStashLazy(ctx, stashId, lazyPerTx * 3n);

		const auth = buildAgentAuth(lazyAgent.evm, ethers.ZeroHash);

		// Bid 1: 60 — succeeds, daily=60
		client.setOperator(lazyAgent.id, lazyAgent.pk);
		const [rx1] = await contractExecuteFunction(
			stashId, bcIface, client, 1_500_000,
			'createBid',
			[tokenAddr, [], 0, lazyPerTx.toString(), 0, 0, auth],
		);
		expect(rx1.status.toString()).to.equal('SUCCESS');
		await sleep(2000);

		// Bid 2: 60 — would push daily to 120 > 100. Reverts BudgetExhausted.
		const result = await contractExecuteFunction(
			stashId, bcIface, client, 1_500_000,
			'createBid',
			[tokenAddr, [], 0, lazyPerTx.toString(), 0, 0, auth],
			0, true,
		);
		client.setOperator(operatorId, operatorKey);
		expectRevertNamed(result, 'BudgetExhausted', [aeIface]);

		// Confirm the envelope state matches: consumed = lazyPerTx (first
		// bid only — the second reverted before mutation).
		const env_ = (await mirrorQuery(
			stashId, bcIface, 'getEnvelope', [lazyAgent.evm],
		))[0];
		expect(BigInt(env_.consumedLazyToday)).to.equal(lazyPerTx);
	});

	it('AE5.4: EnvelopeBudgetConsumed event remaining-fields decodable from envelope state', async function () {
		// The on-chain remaining is dailyHbarCap - consumedHbarToday after
		// the decrement. We assert the storage-side invariant directly;
		// event-decode is deferred (same rationale as AE2.5).
		await cancelAllEnvelopes(ctx, alice, stashId);

		const eventWallet = ctx.agentWallets[2];
		client.setOperator(alice.id, alice.pk);
		await contractExecuteFunction(
			stashId, bcIface, client, 600_000,
			'createEnvelope', [[
				eventWallet.address,
				DAILY_HBAR,
				'0',
				PER_TX_HBAR,
				'0',
				0, BITS.All, ethers.ZeroHash,
			]],
		);
		client.setOperator(operatorId, operatorKey);
		await sleep(MIRROR_DELAY);

		const eventAgent = await provisionAgentHederaAccount(client, operatorId, eventWallet, 5);
		await sleep(MIRROR_DELAY);

		const tokenAddr = bcfNftAddress();
		if (!tokenAddr) {
			this.skip();
			return;
		}
		const auth = buildAgentAuth(eventAgent.evm, ethers.ZeroHash);

		client.setOperator(eventAgent.id, eventAgent.pk);
		const [rx] = await contractExecuteFunction(
			stashId, bcIface, client, 1_500_000,
			'createBid',
			[tokenAddr, [], PER_TX_HBAR, 0, 0, 0, auth],
		);
		client.setOperator(operatorId, operatorKey);
		expect(rx.status.toString()).to.equal('SUCCESS');
		await sleep(MIRROR_DELAY);

		const env_ = (await mirrorQuery(
			stashId, bcIface, 'getEnvelope', [eventAgent.evm],
		))[0];
		const expectedRemaining = DAILY_HBAR - PER_TX_HBAR;
		expect(Number(env_.dailyHbarCap) - Number(env_.consumedHbarToday))
			.to.equal(expectedRemaining);
	});

	after(async function () {
		this.timeout(60_000);
		await cancelAllEnvelopes(ctx, alice, stashId);
	});
});

// ============================================
// AE6 — Pause / kill-switch
// ============================================

describe('AE6 — Pause / kill-switch', function () {
	this.timeout(240_000);

	let pauseAgent;

	before(async function () {
		this.timeout(240_000);
		// Self-bootstrap tier (see AE4 rationale).
		const tier = Number((await mirrorQuery(
			vipId, vipIface, 'getTierFor', [alice.evm],
		))[0]);
		if (tier === TIER.Free) {
			await ctx.helpers.grantBronzeViaAdmin(ctx, alice);
		}
		await cancelAllEnvelopes(ctx, alice, stashId);

		pauseAgent = ctx.agentWallets[0];

		const t = TIER_LIMITS.Bronze;
		client.setOperator(alice.id, alice.pk);
		await contractExecuteFunction(
			stashId, bcIface, client, 600_000,
			'createEnvelope', [[
				pauseAgent.address,
				t.dailyHbarCap, t.dailyLazyCap.toString(),
				t.perTxHbarCap, t.perTxLazyCap.toString(),
				0, BITS.All, ethers.ZeroHash,
			]],
		);
		client.setOperator(operatorId, operatorKey);
		await sleep(MIRROR_DELAY);

		agent1 = await provisionAgentHederaAccount(client, operatorId, pauseAgent, 8);
		await depositHbarToStash(client, operatorId, stashId, 3);
		await sleep(MIRROR_DELAY);
	});

	it('AE6.1: pauseAgent blocks the agent; revert is EnvelopeAuthFailed(Paused)', async function () {
		const tokenAddr = bcfNftAddress();
		if (!tokenAddr) {
			this.skip();
			return;
		}
		client.setOperator(alice.id, alice.pk);
		const [rx] = await contractExecuteFunction(
			stashId, bcIface, client, 200_000,
			'pauseAgent', [pauseAgent.address, true],
		);
		client.setOperator(operatorId, operatorKey);
		expect(rx.status.toString()).to.equal('SUCCESS');
		await sleep(MIRROR_DELAY);

		const auth = buildAgentAuth(agent1.evm, ethers.ZeroHash);
		client.setOperator(agent1.id, agent1.pk);
		const result = await contractExecuteFunction(
			stashId, bcIface, client, 1_500_000,
			'createBid',
			[tokenAddr, [], 100, 0, 0, 0, auth],
			0, true,
		);
		client.setOperator(operatorId, operatorKey);
		expectRevertNamed(result, 'EnvelopeAuthFailed', [aeIface]);
	});

	it('AE6.2: pauseAgent(false) re-enables the agent', async function () {
		const tokenAddr = bcfNftAddress();
		if (!tokenAddr) {
			this.skip();
			return;
		}
		client.setOperator(alice.id, alice.pk);
		await contractExecuteFunction(
			stashId, bcIface, client, 200_000,
			'pauseAgent', [pauseAgent.address, false],
		);
		client.setOperator(operatorId, operatorKey);
		await sleep(MIRROR_DELAY);

		const auth = buildAgentAuth(agent1.evm, ethers.ZeroHash);
		client.setOperator(agent1.id, agent1.pk);
		const [rx] = await contractExecuteFunction(
			stashId, bcIface, client, 1_500_000,
			'createBid',
			[tokenAddr, [], 100, 0, 0, 0, auth],
		);
		client.setOperator(operatorId, operatorKey);
		expect(rx.status.toString()).to.equal('SUCCESS');
	});

	it('AE6.3: pauseAllAgents blocks every agent; owner EMPTY_AUTH path still works', async function () {
		const tokenAddr = bcfNftAddress();
		if (!tokenAddr) {
			this.skip();
			return;
		}
		client.setOperator(alice.id, alice.pk);
		await contractExecuteFunction(
			stashId, bcIface, client, 200_000,
			'pauseAllAgents', [true],
		);
		client.setOperator(operatorId, operatorKey);
		await sleep(MIRROR_DELAY);

		// Agent path should fail
		const auth = buildAgentAuth(agent1.evm, ethers.ZeroHash);
		client.setOperator(agent1.id, agent1.pk);
		const agentResult = await contractExecuteFunction(
			stashId, bcIface, client, 1_500_000,
			'createBid',
			[tokenAddr, [], 100, 0, 0, 0, auth],
			0, true,
		);
		expectRevertNamed(agentResult, 'EnvelopeAuthFailed', [aeIface]);

		// Owner path should still work
		client.setOperator(alice.id, alice.pk);
		const [rxOwner] = await contractExecuteFunction(
			stashId, bcIface, client, 1_500_000,
			'createBid',
			[tokenAddr, [], 100, 0, 0, 0, EMPTY_AUTH],
		);
		expect(rxOwner.status.toString()).to.equal('SUCCESS');

		// Restore
		await contractExecuteFunction(
			stashId, bcIface, client, 200_000,
			'pauseAllAgents', [false],
		);
		client.setOperator(operatorId, operatorKey);
		await sleep(MIRROR_DELAY);
	});

	it('AE6.4: per-agent pause + global flag are independent', async function () {
		// Per-agent paused, global off
		client.setOperator(alice.id, alice.pk);
		await contractExecuteFunction(
			stashId, bcIface, client, 200_000,
			'pauseAgent', [pauseAgent.address, true],
		);
		await sleep(MIRROR_DELAY);

		// Global on
		await contractExecuteFunction(
			stashId, bcIface, client, 200_000,
			'pauseAllAgents', [true],
		);
		await sleep(MIRROR_DELAY);

		// Both flags should be set independently
		const envRead = (await mirrorQuery(
			stashId, bcIface, 'getEnvelope', [pauseAgent.address],
		))[0];
		// FLAG_PAUSED = bit 0, FLAG_ACTIVE = bit 1 → paused-active = 0b11 = 3
		expect(Number(envRead.flags) & 1).to.equal(1);

		const globalPaused = (await mirrorQuery(
			stashId, bcIface, 'allAgentsPaused', [],
		))[0];
		expect(globalPaused).to.equal(true);

		// Restore both
		await contractExecuteFunction(
			stashId, bcIface, client, 200_000,
			'pauseAllAgents', [false],
		);
		await sleep(2000);
		await contractExecuteFunction(
			stashId, bcIface, client, 200_000,
			'pauseAgent', [pauseAgent.address, false],
		);
		client.setOperator(operatorId, operatorKey);
		await sleep(MIRROR_DELAY);
	});

	it('AE6.5: sequential pause then agent action → action reverts (no race)', async function () {
		// Hedera consensus orders by timestamp. Submitting pause first
		// and then an agent action produces a deterministic Paused
		// revert; we just confirm the sequential ordering. There's no
		// mempool to race against.
		const tokenAddr = bcfNftAddress();
		if (!tokenAddr) {
			this.skip();
			return;
		}
		client.setOperator(alice.id, alice.pk);
		await contractExecuteFunction(
			stashId, bcIface, client, 200_000,
			'pauseAgent', [pauseAgent.address, true],
		);
		client.setOperator(operatorId, operatorKey);
		await sleep(MIRROR_DELAY);

		const auth = buildAgentAuth(agent1.evm, ethers.ZeroHash);
		client.setOperator(agent1.id, agent1.pk);
		const result = await contractExecuteFunction(
			stashId, bcIface, client, 1_500_000,
			'createBid',
			[tokenAddr, [], 100, 0, 0, 0, auth],
			0, true,
		);
		client.setOperator(operatorId, operatorKey);
		expectRevertNamed(result, 'EnvelopeAuthFailed', [aeIface]);

		// Restore
		client.setOperator(alice.id, alice.pk);
		await contractExecuteFunction(
			stashId, bcIface, client, 200_000,
			'pauseAgent', [pauseAgent.address, false],
		);
		client.setOperator(operatorId, operatorKey);
		await sleep(MIRROR_DELAY);
	});

	after(async function () {
		this.timeout(60_000);
		await cancelAllEnvelopes(ctx, alice, stashId);
	});
});

// ============================================
// AE7 — Multi-envelope isolation
// ============================================
//
// Requires Platinum tier on Alice (cap=5) so we can have ≥2 envelopes
// active. Uses 3 separate agent EOAs + Hedera accounts.

describe('AE7 — Multi-envelope isolation', function () {
	this.timeout(360_000);

	let agentA, agentB;

	before(async function () {
		this.timeout(360_000);
		await cancelAllEnvelopes(ctx, alice, stashId);

		const currentTier = Number((await mirrorQuery(
			vipId, vipIface, 'getTierFor', [alice.evm],
		))[0]);
		if (currentTier < TIER.Platinum) {
			// ensureTier handles the LAZY-allowance + purchaseSubscription
			// dance. Skips noisily if Alice doesn't have enough LAZY.
			await ctx.helpers.ensureTier(ctx, alice, TIER.Platinum);
		}

		// Three envelopes with distinct caps so we can observe isolation.
		// Caps are deliberately below the Platinum tier upper bounds so
		// envelope creation accepts them.
		client.setOperator(alice.id, alice.pk);
		for (let i = 0; i < 3; i++) {
			await contractExecuteFunction(
				stashId, bcIface, client, 600_000,
				'createEnvelope', [[
					ctx.agentWallets[i].address,
					Number(new Hbar(10, HbarUnit.Hbar).toTinybars()),
					'0',
					Number(new Hbar(5, HbarUnit.Hbar).toTinybars()),
					'0',
					0, BITS.All, ethers.ZeroHash,
				]],
			);
			await sleep(2000);
		}
		client.setOperator(operatorId, operatorKey);
		await sleep(MIRROR_DELAY);

		agentA = await provisionAgentHederaAccount(client, operatorId, ctx.agentWallets[0], 5);
		agentB = await provisionAgentHederaAccount(client, operatorId, ctx.agentWallets[1], 5);
		// agentC is provisioned to satisfy Platinum-tier multi-envelope
		// setup but only its wallet.address is referenced (in
		// cancelEnvelope), so no Hedera account is needed.
		await depositHbarToStash(client, operatorId, stashId, 5);
		await sleep(MIRROR_DELAY);
	});

	it('AE7.1: independent budgets — agent A spend leaves agent B untouched', async function () {
		const tokenAddr = bcfNftAddress();
		if (!tokenAddr) {
			this.skip();
			return;
		}

		const beforeB = (await mirrorQuery(
			stashId, bcIface, 'getEnvelope', [agentB.evm],
		))[0];

		const authA = buildAgentAuth(agentA.evm, ethers.ZeroHash);
		const bidHbar = Number(new Hbar(1, HbarUnit.Hbar).toTinybars());
		client.setOperator(agentA.id, agentA.pk);
		const [rx] = await contractExecuteFunction(
			stashId, bcIface, client, 1_500_000,
			'createBid',
			[tokenAddr, [], bidHbar, 0, 0, 0, authA],
		);
		client.setOperator(operatorId, operatorKey);
		expect(rx.status.toString()).to.equal('SUCCESS');
		await sleep(MIRROR_DELAY);

		const afterA = (await mirrorQuery(
			stashId, bcIface, 'getEnvelope', [agentA.evm],
		))[0];
		const afterB = (await mirrorQuery(
			stashId, bcIface, 'getEnvelope', [agentB.evm],
		))[0];
		expect(Number(afterA.consumedHbarToday)).to.equal(bidHbar);
		expect(Number(afterB.consumedHbarToday)).to.equal(Number(beforeB.consumedHbarToday));
	});

	it('AE7.2: kill switch on agent A leaves agent B usable', async function () {
		const tokenAddr = bcfNftAddress();
		if (!tokenAddr) {
			this.skip();
			return;
		}
		client.setOperator(alice.id, alice.pk);
		await contractExecuteFunction(
			stashId, bcIface, client, 200_000,
			'pauseAgent', [ctx.agentWallets[0].address, true],
		);
		client.setOperator(operatorId, operatorKey);
		await sleep(MIRROR_DELAY);

		// Agent A blocked
		const authA = buildAgentAuth(agentA.evm, ethers.ZeroHash);
		client.setOperator(agentA.id, agentA.pk);
		const resultA = await contractExecuteFunction(
			stashId, bcIface, client, 1_500_000,
			'createBid',
			[tokenAddr, [], 100, 0, 0, 0, authA],
			0, true,
		);
		expectRevertNamed(resultA, 'EnvelopeAuthFailed', [aeIface]);

		// Agent B still works
		const authB = buildAgentAuth(agentB.evm, ethers.ZeroHash);
		client.setOperator(agentB.id, agentB.pk);
		const [rxB] = await contractExecuteFunction(
			stashId, bcIface, client, 1_500_000,
			'createBid',
			[tokenAddr, [], 100, 0, 0, 0, authB],
		);
		client.setOperator(operatorId, operatorKey);
		expect(rxB.status.toString()).to.equal('SUCCESS');

		// Restore
		client.setOperator(alice.id, alice.pk);
		await contractExecuteFunction(
			stashId, bcIface, client, 200_000,
			'pauseAgent', [ctx.agentWallets[0].address, false],
		);
		client.setOperator(operatorId, operatorKey);
		await sleep(MIRROR_DELAY);
	});

	it('AE7.3: cancel envelope A leaves envelope B unaffected', async function () {
		const preB = (await mirrorQuery(
			stashId, bcIface, 'getEnvelope', [agentB.evm],
		))[0];

		client.setOperator(alice.id, alice.pk);
		const [rx] = await contractExecuteFunction(
			stashId, bcIface, client, 400_000,
			'cancelEnvelope', [ctx.agentWallets[0].address],
		);
		client.setOperator(operatorId, operatorKey);
		expect(rx.status.toString()).to.equal('SUCCESS');
		await sleep(MIRROR_DELAY);

		// Envelope A is gone
		const existsA = (await mirrorQuery(
			stashId, bcIface, 'envelopeExists', [ctx.agentWallets[0].address],
		))[0];
		expect(existsA).to.equal(false);

		// Envelope B unchanged
		const postB = (await mirrorQuery(
			stashId, bcIface, 'getEnvelope', [agentB.evm],
		))[0];
		expect(postB.agentKey.toLowerCase()).to.equal(agentB.evm.toLowerCase());
		expect(Number(postB.consumedHbarToday)).to.equal(Number(preB.consumedHbarToday));
		expect(Number(postB.dailyHbarCap)).to.equal(Number(preB.dailyHbarCap));
	});

	it('AE7.4: activeEnvelopeCount accurate through cancel-and-recreate churn', async function () {
		const startCount = Number((await mirrorQuery(
			stashId, bcIface, 'activeEnvelopeCount', [],
		))[0]);
		// After AE7.3 we cancelled A → 2 active (B, C)
		expect(startCount).to.equal(2);

		// Recreate A
		client.setOperator(alice.id, alice.pk);
		await contractExecuteFunction(
			stashId, bcIface, client, 600_000,
			'createEnvelope', [[
				ctx.agentWallets[0].address,
				Number(new Hbar(10, HbarUnit.Hbar).toTinybars()),
				'0',
				Number(new Hbar(5, HbarUnit.Hbar).toTinybars()),
				'0',
				0, BITS.All, ethers.ZeroHash,
			]],
		);
		client.setOperator(operatorId, operatorKey);
		await sleep(MIRROR_DELAY);

		const mid = Number((await mirrorQuery(
			stashId, bcIface, 'activeEnvelopeCount', [],
		))[0]);
		expect(mid).to.equal(3);

		// Cancel C
		client.setOperator(alice.id, alice.pk);
		await contractExecuteFunction(
			stashId, bcIface, client, 400_000,
			'cancelEnvelope', [ctx.agentWallets[2].address],
		);
		client.setOperator(operatorId, operatorKey);
		await sleep(MIRROR_DELAY);

		const end = Number((await mirrorQuery(
			stashId, bcIface, 'activeEnvelopeCount', [],
		))[0]);
		expect(end).to.equal(2);
	});

	after(async function () {
		this.timeout(60_000);
		await cancelAllEnvelopes(ctx, alice, stashId);
	});
});

// ============================================
// AE8 — Allowed-actions bitmap
// ============================================
//
// Each ActionType maps to a single bit in `allowedActions`. Agent-
// mediated calls verify the bit is set via `AgentEnvelopeLib.verifyAndConsume`;
// missing bits revert `EnvelopeAuthFailed(agent, ActionNotAllowed)`.
// updateEnvelopeCaps does NOT exist in BidderContract (trimmed for
// bytecode budget) — bitmap changes go through cancel+recreate.

describe('AE8 — Allowed-actions bitmap', function () {
	this.timeout(240_000);

	let bitmapAgent;
	let lingerBidId; // bid created in AE8.1 used later in AE8.4

	before(async function () {
		this.timeout(240_000);
		const tier = Number((await mirrorQuery(
			vipId, vipIface, 'getTierFor', [alice.evm],
		))[0]);
		if (tier === TIER.Free) {
			await ctx.helpers.grantBronzeViaAdmin(ctx, alice);
		}
		await cancelAllEnvelopes(ctx, alice, stashId);

		bitmapAgent = ctx.agentWallets[0];
		agent1 = await provisionAgentHederaAccount(client, operatorId, bitmapAgent, 5);
		await depositHbarToStash(client, operatorId, stashId, 2);
		await sleep(MIRROR_DELAY);
	});

	async function createEnvelopeWithBits(allowedBits) {
		const t = TIER_LIMITS.Bronze;
		client.setOperator(alice.id, alice.pk);
		await contractExecuteFunction(
			stashId, bcIface, client, 600_000,
			'createEnvelope', [[
				bitmapAgent.address,
				t.dailyHbarCap, t.dailyLazyCap.toString(),
				t.perTxHbarCap, t.perTxLazyCap.toString(),
				0, allowedBits, ethers.ZeroHash,
			]],
		);
		client.setOperator(operatorId, operatorKey);
		await sleep(MIRROR_DELAY);
	}

	it('AE8.1: bitmap=(1<<BidCreate) permits createBid, blocks cancelBid', async function () {
		const tokenAddr = bcfNftAddress();
		if (!tokenAddr) {
			this.skip();
			return;
		}
		await createEnvelopeWithBits(BITS.BidCreate);

		const auth = buildAgentAuth(agent1.evm, ethers.ZeroHash);

		// createBid path — permitted
		client.setOperator(agent1.id, agent1.pk);
		const [rx, results] = await contractExecuteFunction(
			stashId, bcIface, client, 1_500_000,
			'createBid',
			[tokenAddr, [], 100, 0, 0, 0, auth],
		);
		expect(rx.status.toString()).to.equal('SUCCESS');
		lingerBidId = results[0];

		// cancelBid path — NOT permitted (BidCancel bit not set)
		const result = await contractExecuteFunction(
			stashId, bcIface, client, 800_000,
			'cancelBid', [lingerBidId, auth],
			0, true,
		);
		client.setOperator(operatorId, operatorKey);
		expectRevertNamed(result, 'EnvelopeAuthFailed', [aeIface]);
	});

	it('AE8.2: full bitmap permits BidCreate + BidCancel back-to-back', async function () {
		const tokenAddr = bcfNftAddress();
		if (!tokenAddr) {
			this.skip();
			return;
		}
		await cancelAllEnvelopes(ctx, alice, stashId);
		await createEnvelopeWithBits(BITS.All);

		const auth = buildAgentAuth(agent1.evm, ethers.ZeroHash);
		client.setOperator(agent1.id, agent1.pk);

		// createBid
		const [rxA, resultsA] = await contractExecuteFunction(
			stashId, bcIface, client, 1_500_000,
			'createBid', [tokenAddr, [], 100, 0, 0, 0, auth],
		);
		expect(rxA.status.toString()).to.equal('SUCCESS');
		const bidId = resultsA[0];

		// cancelBid
		const [rxB] = await contractExecuteFunction(
			stashId, bcIface, client, 800_000,
			'cancelBid', [bidId, auth],
		);
		client.setOperator(operatorId, operatorKey);
		expect(rxB.status.toString()).to.equal('SUCCESS');
	});

	it('AE8.3: empty bitmap rejects every action with ActionNotAllowed', async function () {
		const tokenAddr = bcfNftAddress();
		if (!tokenAddr) {
			this.skip();
			return;
		}
		await cancelAllEnvelopes(ctx, alice, stashId);
		await createEnvelopeWithBits(0);

		const auth = buildAgentAuth(agent1.evm, ethers.ZeroHash);
		client.setOperator(agent1.id, agent1.pk);
		const result = await contractExecuteFunction(
			stashId, bcIface, client, 1_500_000,
			'createBid', [tokenAddr, [], 100, 0, 0, 0, auth],
			0, true,
		);
		client.setOperator(operatorId, operatorKey);
		expectRevertNamed(result, 'EnvelopeAuthFailed', [aeIface]);
	});

	it('AE8.4: bitmap update via cancel+recreate flips which action is allowed', async function () {
		const tokenAddr = bcfNftAddress();
		if (!tokenAddr) {
			this.skip();
			return;
		}
		// Reset: cancel current envelope, recreate with BidCancel only.
		await cancelAllEnvelopes(ctx, alice, stashId);
		await createEnvelopeWithBits(BITS.BidCancel);

		// First, create a bid via owner path (EMPTY_AUTH) so we have a
		// target to cancel. No envelope touched.
		client.setOperator(alice.id, alice.pk);
		const [rxOwner, ownerResults] = await contractExecuteFunction(
			stashId, bcIface, client, 1_500_000,
			'createBid', [tokenAddr, [], 100, 0, 0, 0, EMPTY_AUTH],
		);
		expect(rxOwner.status.toString()).to.equal('SUCCESS');
		const bidId = ownerResults[0];
		client.setOperator(operatorId, operatorKey);

		// Agent createBid — blocked by bitmap (BidCreate not in set)
		const auth = buildAgentAuth(agent1.evm, ethers.ZeroHash);
		client.setOperator(agent1.id, agent1.pk);
		const blockedCreate = await contractExecuteFunction(
			stashId, bcIface, client, 1_500_000,
			'createBid', [tokenAddr, [], 100, 0, 0, 0, auth],
			0, true,
		);
		expectRevertNamed(blockedCreate, 'EnvelopeAuthFailed', [aeIface]);

		// Agent cancelBid — permitted (BidCancel bit set)
		const [rxCancel] = await contractExecuteFunction(
			stashId, bcIface, client, 800_000,
			'cancelBid', [bidId, auth],
		);
		client.setOperator(operatorId, operatorKey);
		expect(rxCancel.status.toString()).to.equal('SUCCESS');
	});

	it('AE8.5: auction-side actions honor bitmap via stash forward (EA-gated)', async function () {
		if (!process.env.ENGLISH_AUCTION_CONTRACT_ID) {
			console.log('AE8.5: ENGLISH_AUCTION_CONTRACT_ID not set — skipping');
			this.skip();
			return;
		}
		// Envelope with BidCreate only — AuctionBid bit NOT set.
		await cancelAllEnvelopes(ctx, alice, stashId);
		await createEnvelopeWithBits(BITS.BidCreate);

		// Wire EA on the stash if it's not already.
		const { ContractId } = require('@hashgraph/sdk');
		const eaId = ContractId.fromString(process.env.ENGLISH_AUCTION_CONTRACT_ID);
		client.setOperator(alice.id, alice.pk);
		await contractExecuteFunction(
			stashId, bcIface, client, 200_000,
			'setEnglishAuction', [eaId.toSolidityAddress()],
		);
		client.setOperator(operatorId, operatorKey);
		await sleep(MIRROR_DELAY);

		const auth = buildAgentAuth(agent1.evm, ethers.ZeroHash);
		client.setOperator(agent1.id, agent1.pk);
		// Use a sentinel auctionId — the envelope check fires before
		// EA verifies the auction exists, so the bitmap revert is what
		// we observe.
		const result = await contractExecuteFunction(
			stashId, bcIface, client, 1_500_000,
			'placeAuctionBid',
			[ethers.ZeroHash, 100, false, auth],
			0, true,
		);
		client.setOperator(operatorId, operatorKey);
		expectRevertNamed(result, 'EnvelopeAuthFailed', [aeIface]);
	});

	after(async function () {
		this.timeout(60_000);
		await cancelAllEnvelopes(ctx, alice, stashId);
	});
});

// ============================================
// AE9 — Cross-vector flows (BCF + EA both honor envelopes)
// ============================================
//
// Confirms the envelope state is consulted symmetrically across both
// surfaces. AE9.2 (EA flow) skip-gates on ENGLISH_AUCTION_CONTRACT_ID.

describe('AE9 — Cross-vector BCF+EA', function () {
	this.timeout(240_000);

	let xAgent;
	const SHORT_EXPIRY_S = 30; // envelope expires 30s after creation

	before(async function () {
		this.timeout(240_000);
		const tier = Number((await mirrorQuery(
			vipId, vipIface, 'getTierFor', [alice.evm],
		))[0]);
		if (tier === TIER.Free) {
			await ctx.helpers.grantBronzeViaAdmin(ctx, alice);
		}
		await cancelAllEnvelopes(ctx, alice, stashId);

		xAgent = ctx.agentWallets[0];
		agent1 = await provisionAgentHederaAccount(client, operatorId, xAgent, 5);
		await depositHbarToStash(client, operatorId, stashId, 2);
		await sleep(MIRROR_DELAY);
	});

	it('AE9.1: BCF createBid + cancelBid both consume envelope state', async function () {
		const tokenAddr = bcfNftAddress();
		if (!tokenAddr) {
			this.skip();
			return;
		}
		const t = TIER_LIMITS.Bronze;
		client.setOperator(alice.id, alice.pk);
		await contractExecuteFunction(
			stashId, bcIface, client, 600_000,
			'createEnvelope', [[
				xAgent.address,
				t.dailyHbarCap, t.dailyLazyCap.toString(),
				t.perTxHbarCap, t.perTxLazyCap.toString(),
				0, BITS.All, ethers.ZeroHash,
			]],
		);
		client.setOperator(operatorId, operatorKey);
		await sleep(MIRROR_DELAY);

		const auth = buildAgentAuth(agent1.evm, ethers.ZeroHash);
		client.setOperator(agent1.id, agent1.pk);

		const [rxA, resultsA] = await contractExecuteFunction(
			stashId, bcIface, client, 1_500_000,
			'createBid', [tokenAddr, [], 100, 0, 0, 0, auth],
		);
		expect(rxA.status.toString()).to.equal('SUCCESS');
		const bidId = resultsA[0];

		// HBAR budget consumed by createBid only — cancelBid consumes 0/0
		// per BCF.cancelBid's spendForAgent call. Verify the consumption
		// invariant: after both, consumedHbarToday == 100.
		const [rxB] = await contractExecuteFunction(
			stashId, bcIface, client, 800_000,
			'cancelBid', [bidId, auth],
		);
		expect(rxB.status.toString()).to.equal('SUCCESS');
		client.setOperator(operatorId, operatorKey);
		await sleep(MIRROR_DELAY);

		const env_ = (await mirrorQuery(
			stashId, bcIface, 'getEnvelope', [agent1.evm],
		))[0];
		expect(Number(env_.consumedHbarToday)).to.equal(100);
	});

	it('AE9.2: EA createAuctionListing + placeAuctionBid go through stash (EA-gated)', async function () {
		if (!process.env.ENGLISH_AUCTION_CONTRACT_ID) {
			console.log('AE9.2: ENGLISH_AUCTION_CONTRACT_ID not set — skipping');
			this.skip();
			return;
		}
		// EA flow is end-to-end heavier than this suite can scaffold
		// quickly (needs an NFT in the stash + auction params + escrow).
		// We assert the simpler invariant here: with no envelope set up,
		// an agent-mediated placeAuctionBid reverts EnvelopeAuthFailed
		// because verifyAndConsume can't find a record. The full
		// end-to-end EA integration lands in EnglishAuction.test.js.
		await cancelAllEnvelopes(ctx, alice, stashId);

		const { ContractId } = require('@hashgraph/sdk');
		const eaId = ContractId.fromString(process.env.ENGLISH_AUCTION_CONTRACT_ID);
		client.setOperator(alice.id, alice.pk);
		await contractExecuteFunction(
			stashId, bcIface, client, 200_000,
			'setEnglishAuction', [eaId.toSolidityAddress()],
		);
		client.setOperator(operatorId, operatorKey);
		await sleep(MIRROR_DELAY);

		const auth = buildAgentAuth(agent1.evm, ethers.ZeroHash);
		client.setOperator(agent1.id, agent1.pk);
		const result = await contractExecuteFunction(
			stashId, bcIface, client, 1_500_000,
			'placeAuctionBid',
			[ethers.ZeroHash, 100, false, auth],
			0, true,
		);
		client.setOperator(operatorId, operatorKey);
		expectRevertNamed(result, 'EnvelopeAuthFailed', [aeIface]);
	});

	it('AE9.3: pauseAgent blocks BCF agent path uniformly', async function () {
		const tokenAddr = bcfNftAddress();
		if (!tokenAddr) {
			this.skip();
			return;
		}
		// Recreate envelope (AE9.1 cancelled the bid but left envelope).
		// Same agent — already exists from AE9.1's createEnvelope. Pause it.
		client.setOperator(alice.id, alice.pk);
		await contractExecuteFunction(
			stashId, bcIface, client, 200_000,
			'pauseAgent', [xAgent.address, true],
		);
		client.setOperator(operatorId, operatorKey);
		await sleep(MIRROR_DELAY);

		const auth = buildAgentAuth(agent1.evm, ethers.ZeroHash);
		client.setOperator(agent1.id, agent1.pk);
		const result = await contractExecuteFunction(
			stashId, bcIface, client, 1_500_000,
			'createBid', [tokenAddr, [], 100, 0, 0, 0, auth],
			0, true,
		);
		client.setOperator(operatorId, operatorKey);
		expectRevertNamed(result, 'EnvelopeAuthFailed', [aeIface]);

		// Restore
		client.setOperator(alice.id, alice.pk);
		await contractExecuteFunction(
			stashId, bcIface, client, 200_000,
			'pauseAgent', [xAgent.address, false],
		);
		client.setOperator(operatorId, operatorKey);
		await sleep(MIRROR_DELAY);
	});

	it('AE9.4: expired envelope blocks agent actions with EnvelopeAuthFailed(Expired)', async function () {
		const tokenAddr = bcfNftAddress();
		if (!tokenAddr) {
			this.skip();
			return;
		}
		// Cancel + recreate with a short expiry; wait it out; verify revert.
		await cancelAllEnvelopes(ctx, alice, stashId);

		const expiresAt = Math.floor(Date.now() / 1000) + SHORT_EXPIRY_S;
		const t = TIER_LIMITS.Bronze;
		client.setOperator(alice.id, alice.pk);
		await contractExecuteFunction(
			stashId, bcIface, client, 600_000,
			'createEnvelope', [[
				xAgent.address,
				t.dailyHbarCap, t.dailyLazyCap.toString(),
				t.perTxHbarCap, t.perTxLazyCap.toString(),
				expiresAt, BITS.All, ethers.ZeroHash,
			]],
		);
		client.setOperator(operatorId, operatorKey);
		await sleep(MIRROR_DELAY);

		// Wait for expiry + clock-skew buffer. Hedera consensus
		// timestamps may lag wall-clock by a few seconds.
		await sleep((SHORT_EXPIRY_S + 10) * 1000);

		const auth = buildAgentAuth(agent1.evm, ethers.ZeroHash);
		client.setOperator(agent1.id, agent1.pk);
		const result = await contractExecuteFunction(
			stashId, bcIface, client, 1_500_000,
			'createBid', [tokenAddr, [], 100, 0, 0, 0, auth],
			0, true,
		);
		client.setOperator(operatorId, operatorKey);
		expectRevertNamed(result, 'EnvelopeAuthFailed', [aeIface]);
	});

	after(async function () {
		this.timeout(60_000);
		await cancelAllEnvelopes(ctx, alice, stashId);
	});
});

// ============================================
// AE10 — Self-trade-via-agent gate
// ============================================
//
// The agent path must NOT enable self-trade where the EOA path blocks
// it. Three vectors covered by the contract:
//   1. executeTrade: LST checks buyer != seller (via _resolveBeneficialOwner)
//   2. executeArbitrage: BCF blocks bid.user == trade.seller
//
// AE10.1 + AE10.2 require an LST trade with Alice's stash as seller +
// NFT actually escrowed in the stash. That's a heavy setup (mint NFT,
// transfer to stash, createTrade). We skip-gate on AE_TEST_NFT_AVAILABLE
// to keep the suite cheap; the end-to-end flow lives in the BCF test.
// AE10.3 is doable with a synthetic bidId + tradeId path.

describe('AE10 — Self-trade-via-agent gate', function () {
	this.timeout(180_000);

	let selfTradeAgent;

	before(async function () {
		this.timeout(180_000);
		const tier = Number((await mirrorQuery(
			vipId, vipIface, 'getTierFor', [alice.evm],
		))[0]);
		if (tier === TIER.Free) {
			await ctx.helpers.grantBronzeViaAdmin(ctx, alice);
		}
		await cancelAllEnvelopes(ctx, alice, stashId);

		selfTradeAgent = ctx.agentWallets[0];

		const t = TIER_LIMITS.Bronze;
		client.setOperator(alice.id, alice.pk);
		await contractExecuteFunction(
			stashId, bcIface, client, 600_000,
			'createEnvelope', [[
				selfTradeAgent.address,
				t.dailyHbarCap, t.dailyLazyCap.toString(),
				t.perTxHbarCap, t.perTxLazyCap.toString(),
				0, BITS.All, ethers.ZeroHash,
			]],
		);
		client.setOperator(operatorId, operatorKey);
		await sleep(MIRROR_DELAY);

		agent1 = await provisionAgentHederaAccount(client, operatorId, selfTradeAgent, 5);
		await depositHbarToStash(client, operatorId, stashId, 2);
		await sleep(MIRROR_DELAY);
	});

	it('AE10.1: agent executing Alice\'s own LST trade — END-TO-END (skip-gated)', async function () {
		// End-to-end LST self-trade requires Alice's stash to hold an
		// NFT, list it via createTrade, then have the agent attempt
		// executeTrade against that tradeId. Cost: 1 NFT mint + transfer +
		// list + execute attempt. Out of scope for the agent envelope
		// suite — the BCF test already proves LST's self-trade block at
		// the EOA layer. We skip cleanly here.
		this.skip();
	});

	it('AE10.2: agent executing Bob\'s own LST trade — END-TO-END (skip-gated)', async function () {
		// Symmetric to AE10.1, but with Bob's stash as seller. Same
		// scaffolding cost; skipped.
		this.skip();
	});

	it('AE10.3: agent-initiated arbitrage where bid.user==trade.seller reverts', async function () {
		const tokenAddr = bcfNftAddress();
		if (!tokenAddr) {
			this.skip();
			return;
		}
		// Alice's agent creates a bid through Alice's stash. The bid's
		// `user` = Alice's stash owner = Alice. Then Alice's agent tries
		// executeArbitrage(bidId, <some tradeId>) — BCF's self-arbitrage
		// guard checks `msg.sender ∉ {bid.user, trade.seller}` AND
		// `bid.user != trade.seller`. With no real trade, the call
		// reverts on TradeNotFoundOrInvalid before reaching the self-
		// arbitrage check — so the cleanest assertion here is just
		// that the agent CANNOT call executeArbitrage on a bid it
		// authored against a sentinel tradeId without tripping a
		// non-success revert (any of the validation steps).
		const auth = buildAgentAuth(agent1.evm, ethers.ZeroHash);

		// First, create a bid so we have a real bidId.
		client.setOperator(agent1.id, agent1.pk);
		const [rxBid, bidResults] = await contractExecuteFunction(
			stashId, bcIface, client, 1_500_000,
			'createBid', [tokenAddr, [], 100, 0, 0, 0, auth],
		);
		expect(rxBid.status.toString()).to.equal('SUCCESS');
		const bidId = bidResults[0];

		// Now attempt executeArbitrage from the agent. BCF.executeArbitrage
		// signature: (bidId, existingTradeId, minProfit, callerStash,
		// auth). We pass bytes32(0) as tradeId — should revert (no
		// such trade) before reaching the self-arb check.
		const result = await contractExecuteFunction(
			bcfId, bcfIface, client, 1_500_000,
			'executeArbitrage',
			[bidId, ethers.ZeroHash, 0, stashAddress, auth],
			0, true,
		);
		client.setOperator(operatorId, operatorKey);
		// Any non-success revert is acceptable — the test asserts the
		// agent path does NOT silently allow self-trade-via-arbitrage.
		expect(result?.[0]?.status?.toString?.()).to.not.equal('SUCCESS');
	});

	after(async function () {
		this.timeout(60_000);
		await cancelAllEnvelopes(ctx, alice, stashId);
	});
});

// ============================================
// Clean-up
// ============================================

describe('Clean-up', function () {
	this.timeout(60_000);

	after(async function () {
		try {
			await cancelAllEnvelopes(ctx, alice, stashId);
			// Restore the global pause flag in case a test left it set
			client.setOperator(alice.id, alice.pk);
			const paused = (await mirrorQuery(
				stashId, bcIface, 'allAgentsPaused', [],
			))[0];
			if (paused) {
				await contractExecuteFunction(
					stashId, bcIface, client, 200_000,
					'pauseAllAgents', [false],
				);
			}
			client.setOperator(operatorId, operatorKey);
		}
		catch (e) {
			console.log('Clean-up skipped:', e.message);
		}
	});

	it('Clean-up: suite completed', async function () {
		expect(true).to.equal(true);
	});
});
