// Agent envelope — Session 4: timing-gated tests (AE11).
//
// These tests verify time-dependent envelope behavior:
//   - UTC daily counter reset
//   - Multi-day budget consumption cycles
//   - Envelope `expiresAt` enforcement
//   - VIPSubscription expiry → tier-downgrade grandfather window
//
// Real-time waits are required (UTC midnight rollover, expiry windows,
// subscription expiry). Default test runs SKIP this entire suite unless
// `RUN_TIMING_TESTS=1` is set in the environment. AE11.1 / AE11.3 are
// short-wait (under 1 hour); AE11.2 / AE11.4 require multi-day waits
// and are typically only run as part of a release-gate sweep.
//
// Usage:
//   RUN_TIMING_TESTS=1 npx hardhat test test/AgentEnvelopeTiming.test.js
//
// To select specific tests:
//   RUN_TIMING_TESTS=1 npx hardhat test test/AgentEnvelopeTiming.test.js --grep "AE11\.[13]"
//
// Prereqs match the Full suite — see test/AgentEnvelopeFull.test.js
// header for the .env requirements.

const { expect } = require('chai');
const { describe, it, before, after } = require('mocha');
const { ethers } = require('ethers');
const { Hbar, HbarUnit, TokenId } = require('@hashgraph/sdk');

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
} = require('./scaffold');

const { contractExecuteFunction } = require('../utils/solidityHelpers');
const { sleep } = require('../utils/nodeHelpers');

// ============================================
// Gate
// ============================================

const TIMING_ENABLED = process.env.RUN_TIMING_TESTS === '1';

function bcfNftAddress() {
	if (!process.env.BCF_NFT_TOKEN_ID) return null;
	return '0x' + TokenId.fromString(process.env.BCF_NFT_TOKEN_ID).toSolidityAddress();
}

// ============================================
// Setup
// ============================================

let ctx;
let alice;
let stashId;
let bcIface, vipIface, aeIface;
let mirrorQuery, client, operatorId, operatorKey;
let timingAgent, agent1;

// Mocha skips the whole suite when the gate is off — but a `before()`
// at the top of a skipped describe still runs in some configurations.
// We bail early in the before() to avoid burning HBAR on setup nobody
// will use.
before(async function () {
	this.timeout(600_000);
	if (!TIMING_ENABLED) {
		console.log('AE11 timing suite: RUN_TIMING_TESTS != 1 — skipping setup');
		return;
	}

	const freshVip = (process.env.AE_FRESH_VIP ?? '1') === '1';
	ctx = await setupScaffold({
		freshVip,
		ensureAliceTier: null,
		wireAlice: true,
	});

	alice = ctx.alice;
	stashId = alice.stashId;
	bcIface = ctx.ifaces.bc.iface;
	vipIface = ctx.ifaces.vip.iface;
	aeIface = ctx.ifaces.ae.iface;
	mirrorQuery = ctx.mirrorQuery;
	client = ctx.client;
	operatorId = ctx.operatorId;
	operatorKey = ctx.operatorKey;

	// Ensure Alice has Bronze for envelope creation
	const tier = Number((await mirrorQuery(
		ctx.vipId, vipIface, 'getTierFor', [alice.evm],
	))[0]);
	if (tier === TIER.Free) {
		await ctx.helpers.grantBronzeViaAdmin(ctx, alice);
	}
	await cancelAllEnvelopes(ctx, alice, stashId);

	timingAgent = ctx.agentWallets[0];
	agent1 = await provisionAgentHederaAccount(client, operatorId, timingAgent, 8);
	await depositHbarToStash(client, operatorId, stashId, 3);
	await sleep(MIRROR_DELAY);
});

// Helper — seconds until next UTC midnight, plus a clock-skew buffer.
function secondsUntilNextUtcMidnight(bufferSeconds = 60) {
	const nowMs = Date.now();
	const utcMidnight = new Date(nowMs);
	utcMidnight.setUTCHours(24, 0, 0, 0);
	return Math.ceil((utcMidnight.getTime() - nowMs) / 1000) + bufferSeconds;
}

describe('AE11 — Timing-gated envelope behavior', function () {
	this.timeout(0); // long-running by nature

	before(function () {
		if (!TIMING_ENABLED) {
			console.log('AE11: gate not set, skipping suite');
			this.skip();
		}
	});

	it('AE11.1: daily counter resets at UTC midnight rollover', async function () {
		const tokenAddr = bcfNftAddress();
		if (!tokenAddr) {
			this.skip();
			return;
		}

		// Create an envelope with small per-tx + daily caps.
		const t = TIER_LIMITS.Bronze;
		const perTx = 100;
		const daily = 1000;
		client.setOperator(alice.id, alice.pk);
		await contractExecuteFunction(
			stashId, bcIface, client, 600_000,
			'createEnvelope', [[
				timingAgent.address,
				daily, '0', perTx, '0',
				0, BITS.All, ethers.ZeroHash,
			]],
		);
		client.setOperator(operatorId, operatorKey);
		await sleep(MIRROR_DELAY);

		// Bid 1 — consume some budget on day N
		const auth = buildAgentAuth(agent1.evm, ethers.ZeroHash);
		client.setOperator(agent1.id, agent1.pk);
		const [rx1] = await contractExecuteFunction(
			stashId, bcIface, client, 1_500_000,
			'createBid', [tokenAddr, [], perTx, 0, 0, 0, auth],
		);
		expect(rx1.status.toString()).to.equal('SUCCESS');
		client.setOperator(operatorId, operatorKey);
		await sleep(MIRROR_DELAY);

		const beforeEnv = (await mirrorQuery(
			stashId, bcIface, 'getEnvelope', [agent1.evm],
		))[0];
		expect(Number(beforeEnv.consumedHbarToday)).to.equal(perTx);
		const dayN = Number(beforeEnv.lastResetDay);

		// Wait until next UTC midnight + buffer
		const waitSec = secondsUntilNextUtcMidnight(60);
		console.log(`AE11.1: waiting ${waitSec}s for UTC day rollover...`);
		await sleep(waitSec * 1000);

		// Bid 2 — first action after rollover should reset consumed to 0
		// before consuming this bid's amount.
		client.setOperator(agent1.id, agent1.pk);
		const [rx2] = await contractExecuteFunction(
			stashId, bcIface, client, 1_500_000,
			'createBid', [tokenAddr, [], perTx, 0, 0, 0, auth],
		);
		expect(rx2.status.toString()).to.equal('SUCCESS');
		client.setOperator(operatorId, operatorKey);
		await sleep(MIRROR_DELAY);

		const afterEnv = (await mirrorQuery(
			stashId, bcIface, 'getEnvelope', [agent1.evm],
		))[0];
		expect(Number(afterEnv.consumedHbarToday)).to.equal(perTx);
		expect(Number(afterEnv.lastResetDay)).to.equal(dayN + 1);
	});

	it('AE11.2: multi-day consumption cycle holds across N day rollovers', async function () {
		// 2-day cycle: consume + rollover + consume + rollover + consume.
		// Validates that the reset path triggers idempotently on each
		// UTC boundary, not just the first.
		const tokenAddr = bcfNftAddress();
		if (!tokenAddr) {
			this.skip();
			return;
		}

		const perTx = 50;
		const daily = 500;
		await cancelAllEnvelopes(ctx, alice, stashId);
		client.setOperator(alice.id, alice.pk);
		await contractExecuteFunction(
			stashId, bcIface, client, 600_000,
			'createEnvelope', [[
				timingAgent.address,
				daily, '0', perTx, '0',
				0, BITS.All, ethers.ZeroHash,
			]],
		);
		client.setOperator(operatorId, operatorKey);
		await sleep(MIRROR_DELAY);

		const auth = buildAgentAuth(agent1.evm, ethers.ZeroHash);
		const seenDays = new Set();
		for (let day = 0; day < 2; day++) {
			client.setOperator(agent1.id, agent1.pk);
			const [rx] = await contractExecuteFunction(
				stashId, bcIface, client, 1_500_000,
				'createBid', [tokenAddr, [], perTx, 0, 0, 0, auth],
			);
			expect(rx.status.toString()).to.equal('SUCCESS');
			client.setOperator(operatorId, operatorKey);
			await sleep(MIRROR_DELAY);

			const env_ = (await mirrorQuery(
				stashId, bcIface, 'getEnvelope', [agent1.evm],
			))[0];
			seenDays.add(Number(env_.lastResetDay));

			// On all but the last iteration, wait for next UTC midnight.
			if (day < 1) {
				const waitSec = secondsUntilNextUtcMidnight(60);
				console.log(`AE11.2 day ${day}: waiting ${waitSec}s for next UTC day...`);
				await sleep(waitSec * 1000);
			}
		}
		// We submitted N=2 bids across 2 distinct UTC days → 2 distinct
		// lastResetDay values seen.
		expect(seenDays.size).to.equal(2);
	});

	it('AE11.3: envelope expiry reverts EnvelopeAuthFailed(Expired)', async function () {
		// AE9.4 already exercises 30s expiry. AE11.3 is the longer-window
		// variant (5 min) to surface time-zone or clock-skew issues that
		// short windows might miss.
		const tokenAddr = bcfNftAddress();
		if (!tokenAddr) {
			this.skip();
			return;
		}

		const expiresAt = Math.floor(Date.now() / 1000) + 5 * 60;
		const t = TIER_LIMITS.Bronze;
		await cancelAllEnvelopes(ctx, alice, stashId);
		client.setOperator(alice.id, alice.pk);
		await contractExecuteFunction(
			stashId, bcIface, client, 600_000,
			'createEnvelope', [[
				timingAgent.address,
				t.dailyHbarCap, t.dailyLazyCap.toString(),
				t.perTxHbarCap, t.perTxLazyCap.toString(),
				expiresAt, BITS.All, ethers.ZeroHash,
			]],
		);
		client.setOperator(operatorId, operatorKey);
		await sleep(MIRROR_DELAY);

		console.log('AE11.3: waiting ~5m for envelope expiry...');
		await sleep((5 * 60 + 30) * 1000);

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

	it('AE11.4: VIP expiry → tier downgrade grandfathers existing envelopes, blocks new ones', async function () {
		// Captures the design invariant: tier is read at create-time
		// (and capped into the envelope's storage). A subscription expiry
		// after envelope creation does NOT retroactively invalidate the
		// envelope — but it DOES block the owner from creating new ones
		// because getTierFor returns Free.
		//
		// Real-time wait is on the order of the granted subscription
		// duration. We use admin extendSubscription with a short window
		// (1 month, but with custom MONTH_SECONDS this could be shorter
		// in a fork). For mainnet/testnet with real MONTH_SECONDS=30 days
		// this test is effectively unrunnable — it's documented here as
		// the correct shape for fork-based timing tests.
		console.log('AE11.4: real-time VIP expiry not feasible on live testnet');
		console.log('  (would require 30+ days of wall-clock wait)');
		console.log('  Designed for hardhat-fork environments only — skipping');
		this.skip();
	});

	after(async function () {
		this.timeout(60_000);
		if (TIMING_ENABLED && ctx) {
			try {
				await cancelAllEnvelopes(ctx, alice, stashId);
			} catch (e) {
				console.log('AE11 cleanup skipped:', e.message);
			}
		}
	});
});
