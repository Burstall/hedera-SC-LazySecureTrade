// One-shot helper: wire the locked default agent envelope tier table
// onto a freshly-deployed BidderContractFactory. The FIRST call per
// tier is instant (no timelock); subsequent re-runs against the same
// factory will queue a 48h timelock — operators wanting to adjust
// after launch should use the runbook flow at docs/v0.3-OPS-RUNBOOK.md §9.
//
// Usage:
//   node scripts/interactions/wireAgentTierLimits.js
//
// Requires (in .env):
//   ACCOUNT_ID, PRIVATE_KEY  (factory owner)
//   ENVIRONMENT              (test | main | preview | local)
//   BIDDER_FACTORY_CONTRACT_ID

const fs = require('fs');
const {
    Client,
    AccountId,
    PrivateKey,
    ContractId,
    HbarUnit,
    Hbar,
} = require('@hashgraph/sdk');
const { ethers } = require('ethers');
const { contractExecuteFunction } = require('../../utils/solidityHelpers');
require('dotenv').config();

// Tier enum mirror — contracts/interfaces/IVIPSubscription.sol
const TIER = { Free: 0, Bronze: 1, Silver: 2, Gold: 3, Platinum: 4 };

// Locked default table from docs/v0.3-WORKING-PLAN.md.
// uint96 fields cap at 7.9e28 — comfortably above any real cap.
function hbarTinybars(h) { return Number(new Hbar(h, HbarUnit.Hbar).toTinybars()); }
function lazyBaseUnits(units) { return (BigInt(units) * 10n ** 8n).toString(); }

const ONE_YEAR = 365 * 24 * 60 * 60;

const TIER_LIMITS = {
    // Free: zero-filled — leave at storage default. No call needed.
    Bronze: {
        tier: TIER.Bronze,
        maxAgents: 1,
        dailyHbarCap: hbarTinybars(500),
        dailyLazyCap: lazyBaseUnits(5_000),
        perTxHbarCap: hbarTinybars(200),
        perTxLazyCap: lazyBaseUnits(2_000),
        maxExpiryWindow: ONE_YEAR,
    },
    Silver: {
        tier: TIER.Silver,
        maxAgents: 2,
        dailyHbarCap: hbarTinybars(1_500),
        dailyLazyCap: lazyBaseUnits(15_000),
        perTxHbarCap: hbarTinybars(500),
        perTxLazyCap: lazyBaseUnits(5_000),
        maxExpiryWindow: ONE_YEAR,
    },
    Gold: {
        tier: TIER.Gold,
        maxAgents: 3,
        dailyHbarCap: hbarTinybars(3_500),
        dailyLazyCap: lazyBaseUnits(35_000),
        perTxHbarCap: hbarTinybars(1_000),
        perTxLazyCap: lazyBaseUnits(10_000),
        maxExpiryWindow: ONE_YEAR,
    },
    Platinum: {
        tier: TIER.Platinum,
        maxAgents: 5,
        dailyHbarCap: hbarTinybars(10_000),
        dailyLazyCap: lazyBaseUnits(100_000),
        perTxHbarCap: hbarTinybars(2_500),
        perTxLazyCap: lazyBaseUnits(25_000),
        maxExpiryWindow: ONE_YEAR,
    },
};

(async () => {
    const env = (process.env.ENVIRONMENT || 'test').toLowerCase();
    const operatorId = AccountId.fromString(process.env.ACCOUNT_ID);
    const operatorKey = PrivateKey.fromStringED25519(process.env.PRIVATE_KEY);
    const client = env === 'main' ? Client.forMainnet()
        : env === 'preview' ? Client.forPreviewnet()
        : Client.forTestnet();
    client.setOperator(operatorId, operatorKey);

    const factoryContractId = ContractId.fromString(
        process.env.BIDDER_FACTORY_CONTRACT_ID,
    );

    const bcfJson = JSON.parse(fs.readFileSync(
        './artifacts/contracts/BidderContractFactory.sol/BidderContractFactory.json',
        'utf8',
    ));
    const bcfIface = new ethers.Interface(bcfJson.abi);

    console.log('--- Agent envelope tier-table wiring ---');
    console.log('Environment:', env);
    console.log('Operator:', operatorId.toString());
    console.log('Factory:', factoryContractId.toString());
    console.log('');

    for (const name of ['Bronze', 'Silver', 'Gold', 'Platinum']) {
        const t = TIER_LIMITS[name];
        const limitsTuple = [
            t.maxAgents,
            t.dailyHbarCap,
            t.dailyLazyCap,
            t.perTxHbarCap,
            t.perTxLazyCap,
            t.maxExpiryWindow,
        ];
        console.log(`Setting ${name} (tier=${t.tier}): maxAgents=${t.maxAgents}, dailyHbar=${t.dailyHbarCap}, dailyLazy=${t.dailyLazyCap}`);
        const [rx] = await contractExecuteFunction(
            factoryContractId, bcfIface, client, 400_000,
            'setAgentTierLimits',
            [t.tier, limitsTuple],
        );
        console.log(`  → ${rx.status.toString()}`);
        await new Promise((r) => setTimeout(r, 2_000));
    }

    console.log('\n✅ Tier table wired. Free tier left at zero-filled default.');
    console.log('   To adjust later: same call → enters 48h timelock → executeAgentTierLimitsChange.');
    await client.close();
    process.exit(0);
})().catch((e) => {
    console.error('Wiring failed:', e);
    process.exit(1);
});
