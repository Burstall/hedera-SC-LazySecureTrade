// Deploy EnglishAuction standalone.
//
// Constructor params: LAZY token, LazyGasStation, LazyDelegateRegistry,
// LSH_GEN1/MUTANT/GEN2, LazyNFTStaking (optional, address(0) = opt out).
//
// Post-deploy wiring:
//   1. LST owner: LST.authorizeFactory? — NO, EnglishAuction does not
//      route through LST. It's a standalone listing surface.
//   2. EnglishAuction owner: setBcf(<BCF address>) — first-time wire-up
//      is INSTANT (no timelock). Required so the auction's self-bid
//      gate resolves stash → human via the same beneficial-owner
//      pattern as LST.
//   3. EnglishAuction owner: setVipSubscription(<VIP address>) — if
//      VIPSubscription is deployed and you want paid-tier discounts
//      applied at settle.
//   4. Send HBAR to the EnglishAuction contract (~10 HBAR) so it can
//      pay the 1-tinybar custody hops on NFT escrow/release. Use
//      LazyGasStation's refill flow or a direct transfer.
//   5. Frontend / SDK: discover deployed address via .env or registry.
//
// Usage:
//   node scripts/deployments/deployEnglishAuction.js

const fs = require('fs');
const {
	Client,
	AccountId,
	PrivateKey,
	ContractId,
	TokenId,
	ContractFunctionParameters,
	Hbar,
	HbarUnit,
} = require('@hashgraph/sdk');
const { contractDeployFunction, contractExecuteFunction } = require('../../utils/solidityHelpers');
const { ensureLibraries, linkLibraries } = require('../../utils/libraryLinking');
const { sendHbar } = require('../../utils/hederaHelpers');
const { ethers } = require('ethers');
require('dotenv').config();

(async () => {
	const env = (process.env.ENVIRONMENT || 'test').toLowerCase();
	const operatorId = AccountId.fromString(process.env.ACCOUNT_ID);
	const operatorKey = PrivateKey.fromStringED25519(process.env.PRIVATE_KEY);
	const client = env === 'main' ? Client.forMainnet()
		: env === 'preview' ? Client.forPreviewnet()
			: Client.forTestnet();
	client.setOperator(operatorId, operatorKey);

	const lazyTokenId = TokenId.fromString(process.env.LAZY_TOKEN_ID);
	const lazyGasStationId = ContractId.fromString(process.env.LAZY_GAS_STATION_CONTRACT_ID);
	const lazyDelegateRegistryId = ContractId.fromString(process.env.LAZY_DELEGATE_REGISTRY_CONTRACT_ID);
	const lshGen1Token = TokenId.fromString(process.env.LSH_GEN1_TOKEN_ID || process.env.BCF_NFT_TOKEN_ID);
	const lshMutantToken = TokenId.fromString(process.env.LSH_GEN1_MUTANT_TOKEN_ID || process.env.BCF_NFT_TOKEN_ID);
	const lshGen2Token = TokenId.fromString(process.env.LSH_GEN2_TOKEN_ID || process.env.BCF_NFT_TOKEN_ID);
	const stakingAddress = process.env.LAZY_NFT_STAKING_CONTRACT_ID
		? ContractId.fromString(process.env.LAZY_NFT_STAKING_CONTRACT_ID).toSolidityAddress()
		: '0000000000000000000000000000000000000000';

	console.log('--- EnglishAuction deploy ---');
	console.log('Environment:', env);
	console.log('Operator:', operatorId.toString());
	console.log('LAZY Token:', lazyTokenId.toString());
	console.log('LazyGasStation:', lazyGasStationId.toString());
	console.log('LazyDelegateRegistry:', lazyDelegateRegistryId.toString());
	console.log('LSH Gen1:', lshGen1Token.toString());
	console.log('LSH Mutant:', lshMutantToken.toString());
	console.log('LSH Gen2:', lshGen2Token.toString());
	console.log('LazyNFTStaking:', process.env.LAZY_NFT_STAKING_CONTRACT_ID || '(opt-out via address(0))');

	const auctionJson = JSON.parse(fs.readFileSync(
		'./artifacts/contracts/EnglishAuction.sol/EnglishAuction.json', 'utf8',
	));
	const auctionIface = new ethers.Interface(auctionJson.abi);

	const params = new ContractFunctionParameters()
		.addAddress(lazyTokenId.toSolidityAddress())
		.addAddress(lazyGasStationId.toSolidityAddress())
		.addAddress(lazyDelegateRegistryId.toSolidityAddress())
		.addAddress(lshGen1Token.toSolidityAddress())
		.addAddress(lshMutantToken.toSolidityAddress())
		.addAddress(lshGen2Token.toSolidityAddress())
		.addAddress(stakingAddress);

	// EnglishAuction links LSHTierLib (getTierFor is external/linked to keep EA
	// under the 24,576-byte limit). Deploy/reuse the library + link the bytecode.
	const eaLibs = await ensureLibraries(client);
	const [auctionContractId, auctionAddr] = await contractDeployFunction(
		client, linkLibraries(auctionJson.bytecode, auctionJson.linkReferences, eaLibs), 8_000_000, params,
	);
	console.log(`\n✅ EnglishAuction deployed: ${auctionContractId.toString()} / ${auctionAddr}`);

	// Register as LGS contract user (so we can pull LAZY for FT bundles
	// + LAZY-denominated auctions).
	const lgsJson = JSON.parse(fs.readFileSync(
		'./artifacts/contracts/LazyGasStation.sol/LazyGasStation.json', 'utf8',
	));
	const lgsIface = new ethers.Interface(lgsJson.abi);
	await contractExecuteFunction(
		lazyGasStationId, lgsIface, client, 200_000,
		'addContractUser', [auctionContractId.toSolidityAddress()],
	);
	console.log('✅ EnglishAuction registered as LGS contract user');

	// Fund the contract with HBAR for the custody-hop tinybar on each
	// NFT escrow leg. 10 HBAR ≈ 10^9 escrows.
	await sendHbar(client, operatorId, auctionContractId, 10, HbarUnit.Hbar);
	console.log('✅ Funded contract with 10 HBAR for custody hops');

	void auctionIface;

	console.log('\n📝 Add to .env:');
	console.log(`ENGLISH_AUCTION_CONTRACT_ID=${auctionContractId.toString()}`);
	console.log('\n📝 Post-deploy wiring (owner must execute):');
	console.log(`  EnglishAuction.setBcf(<BCF_CONTRACT_ID>)`);
	console.log(`    — instant on first call. Subsequent rotations are 48h timelocked.`);
	console.log(`    — required for stash → human beneficial-owner resolution.`);
	console.log(`  EnglishAuction.setVipSubscription(<VIP_SUBSCRIPTION_CONTRACT_ID>)`);
	console.log(`    — optional. Wires paid-tier discounts into settle.`);
	console.log(`  EnglishAuction.setDurationLimits(minDuration, maxDuration, maxExtensionWindow)`);
	console.log(`    — optional. Defaults: 1h / 7d / 24h.`);
	console.log(`  EnglishAuction.setDefaults(minStepBps, antiSnipeWindow, antiSnipeExtension)`);
	console.log(`    — optional. Defaults: 200 bps / 10 min / 10 min.`);
	console.log(`  EnglishAuction.setProtocolFeeBps(bps)`);
	console.log(`    — optional. Default 100 (1%). Cap 1000 (10%).`);
	console.log(`  EnglishAuction.setSettlementBountyBps(bps)`);
	console.log(`    — optional. Default 10 (0.1%). Cap 500 (5%).`);

	process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
