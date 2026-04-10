/**
 * BidderContractFactory Event Scanner v0.3
 *
 * Scans Hedera Mirror Node for BidderContractFactory + stash events
 * and caches them in Directus DB. Companion to secureTradeEventScanner.js
 * which handles LST (v0.2) events.
 *
 * Scanned events (Factory):
 *   StashDeployed, BidCreated, BidCancelled, BidExecuted, BidExpired,
 *   ExpiredBidsCleanup, ArbitrageExecuted, ArbProfitClaimed,
 *   ProtocolProfitWithdrawn, ArbPayoutBpsChangePending, ArbPayoutBpsChanged,
 *   TradeCreatedFromStash
 *
 * Scanned events (Stash — per-stash contract):
 *   StashArbSettled, FactoryDetached
 *
 * Directus tables used:
 *   - BIDDER_FACTORY_EVENTS_TABLE  (env: BIDDER_FACTORY_EVENTS_TABLE)
 *     Tracks the scanner's last-scanned timestamp per contract + environment.
 *   - BIDDER_BIDS_CACHE_TABLE      (env: BIDDER_BIDS_CACHE_TABLE)
 *     Active/historical bid cache for frontend queries.
 *   - BIDDER_STASH_EVENTS_TABLE    (env: BIDDER_STASH_EVENTS_TABLE)
 *     Stash-level events (arbitrage settlements, detachments).
 *
 * See docs/DIRECTUS-MIGRATION-v0.3.md for the table schema definitions.
 *
 * Usage:
 *   node bidderFactoryEventScanner.js [0.0.FactoryContractId]
 *
 * .env:
 *   BIDDER_FACTORY_CONTRACT_ID=0.0.XXXX  (or pass on CLI)
 *   SECURE_TRADE_ENV=testnet|mainnet|previewnet
 *   BIDDER_FACTORY_EVENTS_TABLE=bidderFactoryEvents
 *   BIDDER_BIDS_CACHE_TABLE=bidderBidsCache
 *   BIDDER_STASH_EVENTS_TABLE=bidderStashEvents
 *   DIRECTUS_DB_URL=https://your-directus.example.com
 *   DIRECTUS_TOKEN=your-static-token
 *   SECURE_TRADE_SUPRESS_LOGS=0|1
 */

const { ContractId, Hbar, HbarUnit, TokenId } = require('@hashgraph/sdk');
require('dotenv').config();
const { ethers } = require('ethers');
const { default: axios } = require('axios');
const {
	createDirectus, rest, readItems, staticToken,
	updateItem, createItem, createItems,
} = require('@directus/sdk');

// ===== Config from .env =====
const env = process.env.SECURE_TRADE_ENV ?? null;
const factoryEventsTable = process.env.BIDDER_FACTORY_EVENTS_TABLE ?? 'bidderFactoryEvents';
const bidsCacheTable = process.env.BIDDER_BIDS_CACHE_TABLE ?? 'bidderBidsCache';
const stashEventsTable = process.env.BIDDER_STASH_EVENTS_TABLE ?? 'bidderStashEvents';
const suppressLogs = process.env.SECURE_TRADE_SUPRESS_LOGS === '1' || process.env.SECURE_TRADE_SUPRESS_LOGS === 'true';

const client = createDirectus(process.env.DIRECTUS_DB_URL).with(rest());
const writeClient = createDirectus(process.env.DIRECTUS_DB_URL)
	.with(staticToken(process.env.DIRECTUS_TOKEN))
	.with(rest());

// EVM → Hedera account resolution cache
const evmToHederaMap = new Map();
evmToHederaMap.set(ethers.ZeroAddress, '0.0.0');

// ===== Event ABI =====
const factoryIface = new ethers.Interface([
	// Stash deployment
	'event StashDeployed(address indexed user, address indexed stash, address indexed deployer)',

	// Bid lifecycle
	'event BidCreated(bytes32 indexed bidId, address indexed user, address indexed token, tuple(address user, address stash, uint256 hbarAmount, uint256 lazyAmount, uint256 expiry, address token, uint256[] serials, uint256 stashNonce, uint256 createdAt, uint256 minAcceptablePrice, uint8 status) details)',
	'event BidCancelled(bytes32 indexed bidId, address indexed user)',
	'event BidExecuted(bytes32 indexed bidId, address indexed executor, bytes32 tradeId, uint256 arbitrageProfit)',
	'event BidExpired(bytes32 indexed bidId, address indexed user)',
	'event ExpiredBidsCleanup(address indexed cleaner, uint256 cleanedCount)',

	// Trade from stash
	'event TradeCreatedFromStash(bytes32 indexed tradeId, address indexed stash, address indexed seller, address token, uint256 serial)',

	// Arbitrage
	'event ArbitrageExecuted(bytes32 indexed bidId, bytes32 indexed tradeId, address indexed arbitrageur, uint256 arbCut, uint256 protocolCut)',
	'event ArbProfitClaimed(address indexed arbitrageur, uint256 amount)',
	'event ProtocolProfitWithdrawn(address indexed to, uint256 amount)',

	// Governance
	'event ArbPayoutBpsChangePending(uint256 newBps, uint256 eta)',
	'event ArbPayoutBpsChanged(uint256 newBps)',
]);

const stashIface = new ethers.Interface([
	'event StashArbSettled(bytes32 indexed bidId, bytes32 indexed tradeId, uint256 hbarAmount, uint256 lazyAmount)',
	'event FactoryDetached(address indexed owner, address indexed formerFactory)',
]);

// ===== Main =====
const main = async () => {
	const args = process.argv.slice(2);
	if (args.includes('-h') || args.includes('--help')) {
		console.log('Usage: bidderFactoryEventScanner.js [0.0.FactoryContractId]');
		return;
	}

	let factoryContract = args[0] ?? process.env.BIDDER_FACTORY_CONTRACT_ID ?? null;
	if (!factoryContract) {
		console.log('ERROR: No factory contract provided');
		return;
	}

	if (!['mainnet', 'testnet', 'previewnet', 'local'].includes(env)) {
		console.log('ERROR: SECURE_TRADE_ENV must be one of mainnet|testnet|previewnet|local');
		return;
	}

	const contractId = ContractId.fromString(factoryContract);
	if (!suppressLogs) console.log('\n-Factory Event Scanner:', env, 'contract:', contractId.toString());

	// Get last timestamp from Directus
	const lastTimestamp = await getLastTimestamp(contractId.toString());
	if (!suppressLogs) {
		console.log(lastTimestamp
			? `Last timestamp: ${lastTimestamp} [${new Date(lastTimestamp * 1000).toUTCString()}]`
			: 'No previous scan — fetching all logs',
		);
	}

	// Scan factory events (emitted by the factory contract itself)
	const { bids, events, maxTimestamp } = await scanFactoryEvents(contractId, lastTimestamp);

	// S1: Scan stash-emitted events (StashArbSettled, FactoryDetached) via
	// topic-hash queries. These events live on individual stash contracts,
	// not the factory, so we use /api/v1/contracts/results/logs with a
	// topic0 filter instead of a contract-scoped endpoint.
	const stashEvents = await scanStashEventsByTopic(lastTimestamp);
	events.push(...stashEvents);

	if (!suppressLogs) console.log(`Found ${bids.length} bid events, ${events.length} other events (incl. ${stashEvents.length} stash-emitted)`);

	// Upload bids to cache
	if (bids.length > 0) {
		await uploadBidsToDirectus(contractId.toString(), bids);
	}

	// Upload non-bid events to stash events table
	if (events.length > 0) {
		await uploadStashEventsToDirectus(contractId.toString(), events);
	}

	// Update scanner timestamp
	if (maxTimestamp > 0) {
		await updateLastTimestamp(contractId.toString(), maxTimestamp);
	}

	if (!suppressLogs) console.log('Scan complete. Max timestamp:', maxTimestamp);
};

// ===== Event scanning =====

async function scanFactoryEvents(contractId, lastTimestamp) {
	const baseUrl = getBaseURL();
	let url = lastTimestamp
		? `${baseUrl}/api/v1/contracts/${contractId.toString()}/results/logs?order=asc&limit=100&timestamp=gt:${lastTimestamp}`
		: `${baseUrl}/api/v1/contracts/${contractId.toString()}/results/logs?order=asc&limit=100`;

	const bids = [];
	const events = [];
	let maxTimestamp = 0;

	do {
		if (!suppressLogs) console.log('Fetching:', url);
		const response = await axios.get(url);
		const jsonResponse = response.data;

		for (const log of jsonResponse.logs) {
			if (log.data === '0x') continue;
			if (log.timestamp > maxTimestamp) maxTimestamp = log.timestamp;

			// Try factory events first
			let event;
			try {
				event = factoryIface.parseLog({ topics: log.topics, data: log.data });
			}
			catch {
				// Try stash events (if the scanner is also watching stash addresses)
				try {
					event = stashIface.parseLog({ topics: log.topics, data: log.data });
				}
				catch {
					if (!suppressLogs) console.log('Unknown event at', log.timestamp);
					continue;
				}
			}

			switch (event.name) {
			case 'BidCreated': {
				const details = event.args[3]; // BidDetails tuple
				// S2: persist serials array as JSON for frontend bid discovery
				const serialsArr = details.serials ? details.serials.map(s => Number(s)) : [];
				bids.push({
					bidId: event.args[0],
					user: await resolveAccount(event.args[1]),
					token: await resolveToken(event.args[2]),
					hbarAmount: Number(details.hbarAmount),
					lazyAmount: Number(details.lazyAmount),
					expiry: Number(details.expiry),
					minAcceptablePrice: Number(details.minAcceptablePrice),
					serials: JSON.stringify(serialsArr),
					status: 'Active',
					stash: details.stash,
					timestamp: log.timestamp,
				});
				break;
			}
			case 'BidCancelled':
				await markBidStatus(contractId.toString(), event.args[0], 'Cancelled');
				break;
			case 'BidExecuted':
				await markBidStatus(contractId.toString(), event.args[0], 'Executed');
				events.push({
					type: 'BidExecuted',
					bidId: event.args[0],
					executor: await resolveAccount(event.args[1]),
					tradeId: event.args[2],
					arbitrageProfit: Number(event.args[3]),
					timestamp: log.timestamp,
				});
				break;
			case 'BidExpired':
				await markBidStatus(contractId.toString(), event.args[0], 'Expired');
				break;
			case 'ArbitrageExecuted':
				events.push({
					type: 'ArbitrageExecuted',
					bidId: event.args[0],
					tradeId: event.args[1],
					arbitrageur: await resolveAccount(event.args[2]),
					arbCut: Number(event.args[3]),
					protocolCut: Number(event.args[4]),
					timestamp: log.timestamp,
				});
				break;
			case 'StashDeployed':
				events.push({
					type: 'StashDeployed',
					user: await resolveAccount(event.args[0]),
					stash: event.args[1],
					deployer: await resolveAccount(event.args[2]),
					timestamp: log.timestamp,
				});
				break;
			case 'TradeCreatedFromStash':
				events.push({
					type: 'TradeCreatedFromStash',
					tradeId: event.args[0],
					stash: event.args[1],
					seller: await resolveAccount(event.args[2]),
					token: await resolveToken(event.args[3]),
					serial: Number(event.args[4]),
					timestamp: log.timestamp,
				});
				break;
			case 'StashArbSettled':
				events.push({
					type: 'StashArbSettled',
					bidId: event.args[0],
					tradeId: event.args[1],
					hbarAmount: Number(event.args[2]),
					lazyAmount: Number(event.args[3]),
					timestamp: log.timestamp,
				});
				break;
			case 'FactoryDetached':
				events.push({
					type: 'FactoryDetached',
					owner: await resolveAccount(event.args[0]),
					formerFactory: event.args[1],
					timestamp: log.timestamp,
				});
				break;
			case 'ArbProfitClaimed':
				events.push({
					type: 'ArbProfitClaimed',
					arbitrageur: await resolveAccount(event.args[0]),
					amount: Number(event.args[1]),
					timestamp: log.timestamp,
				});
				break;
			case 'ProtocolProfitWithdrawn':
				events.push({
					type: 'ProtocolProfitWithdrawn',
					to: await resolveAccount(event.args[0]),
					amount: Number(event.args[1]),
					timestamp: log.timestamp,
				});
				break;
			// S3: previously unhandled governance + cleanup events
			case 'ExpiredBidsCleanup':
				events.push({
					type: 'ExpiredBidsCleanup',
					cleaner: await resolveAccount(event.args[0]),
					cleanedCount: Number(event.args[1]),
					timestamp: log.timestamp,
				});
				break;
			case 'ArbPayoutBpsChangePending':
				events.push({
					type: 'ArbPayoutBpsChangePending',
					newBps: Number(event.args[0]),
					eta: Number(event.args[1]),
					timestamp: log.timestamp,
				});
				break;
			case 'ArbPayoutBpsChanged':
				events.push({
					type: 'ArbPayoutBpsChanged',
					newBps: Number(event.args[0]),
					timestamp: log.timestamp,
				});
				break;
			default:
				if (!suppressLogs) console.log('Unhandled event:', event.name);
			}
		}

		if (!jsonResponse.links?.next) break;
		url = `${baseUrl}${jsonResponse.links.next}`;
	}
	while (url);

	return { bids, events, maxTimestamp };
}

/**
 * S1: Scan stash-emitted events (StashArbSettled, FactoryDetached) across
 * ALL stash contracts by querying the mirror node with topic0 filters.
 *
 * The mirror node endpoint /api/v1/contracts/results/logs supports a
 * `topic0` parameter to find logs by event signature hash across all
 * contracts, not just one. This lets us discover stash events without
 * iterating every deployed stash address individually.
 */
async function scanStashEventsByTopic(lastTimestamp) {
	const baseUrl = getBaseURL();
	const stashEvents = [];

	// Topic0 hashes for stash events
	const stashArbSettledTopic = ethers.id('StashArbSettled(bytes32,bytes32,uint256,uint256)');
	const factoryDetachedTopic = ethers.id('FactoryDetached(address,address)');

	for (const topic0 of [stashArbSettledTopic, factoryDetachedTopic]) {
		let url = lastTimestamp
			? `${baseUrl}/api/v1/contracts/results/logs?topic0=${topic0}&order=asc&limit=100&timestamp=gt:${lastTimestamp}`
			: `${baseUrl}/api/v1/contracts/results/logs?topic0=${topic0}&order=asc&limit=100`;

		do {
			try {
				if (!suppressLogs) console.log('Stash topic scan:', url);
				const response = await axios.get(url);
				const jsonResponse = response.data;

				for (const log of jsonResponse.logs) {
					if (log.data === '0x') continue;
					try {
						const event = stashIface.parseLog({ topics: log.topics, data: log.data });
						switch (event.name) {
						case 'StashArbSettled':
							stashEvents.push({
								type: 'StashArbSettled',
								bidId: event.args[0],
								tradeId: event.args[1],
								hbarAmount: Number(event.args[2]),
								lazyAmount: Number(event.args[3]),
								contract: log.address,
								timestamp: log.timestamp,
							});
							break;
						case 'FactoryDetached':
							stashEvents.push({
								type: 'FactoryDetached',
								owner: await resolveAccount(event.args[0]),
								formerFactory: event.args[1],
								contract: log.address,
								timestamp: log.timestamp,
							});
							break;
						}
					}
					catch { /* skip unparseable logs */ }
				}

				if (!jsonResponse.links?.next) break;
				url = `${baseUrl}${jsonResponse.links.next}`;
			}
			catch (err) {
				if (!suppressLogs) console.log('Stash topic scan error:', err.message);
				break;
			}
		}
		while (url);
	}

	return stashEvents;
}

// ===== Directus operations =====

async function getLastTimestamp(contractIdStr) {
	try {
		const response = await client.request(readItems(factoryEventsTable, {
			fields: ['lastTimestamp'],
			filter: {
				factoryContract: { _eq: contractIdStr },
				environment: { _eq: env },
			},
			limit: 1,
		}));
		if (!response || response.length === 0 || response[0].lastTimestamp === '0') return null;
		return response[0].lastTimestamp;
	}
	catch (err) {
		console.error('ERROR reading last timestamp:', err.message);
		return null;
	}
}

async function updateLastTimestamp(contractIdStr, timestamp) {
	try {
		const existing = await client.request(readItems(factoryEventsTable, {
			fields: ['id'],
			filter: {
				factoryContract: { _eq: contractIdStr },
				environment: { _eq: env },
			},
			limit: 1,
		}));

		if (!existing || existing.length === 0) {
			await writeClient.request(createItem(factoryEventsTable, {
				factoryContract: contractIdStr,
				lastTimestamp: timestamp,
				environment: env,
			}));
		}
		else {
			await writeClient.request(updateItem(factoryEventsTable, existing[0].id, {
				lastTimestamp: timestamp,
			}));
		}
	}
	catch (err) {
		console.error('ERROR updating timestamp:', err.message);
	}
}

async function uploadBidsToDirectus(contractIdStr, bids) {
	const records = bids.map(b => ({
		factoryContract: contractIdStr,
		bidId: b.bidId,
		user: b.user,
		token: b.token,
		stash: b.stash,
		hbarAmount: b.hbarAmount,
		lazyAmount: b.lazyAmount,
		expiry: b.expiry,
		minAcceptablePrice: b.minAcceptablePrice,
		serials: b.serials, // S2: JSON string of serial numbers (or "[]" for any-serial)
		status: b.status,
		environment: env,
		timestamp: b.timestamp,
	}));

	try {
		// Batch in groups of 100
		for (let i = 0; i < records.length; i += 100) {
			const batch = records.slice(i, i + 100);
			const data = await writeClient.request(createItems(bidsCacheTable, batch));
			if (!suppressLogs) console.log('Uploaded', data?.length, 'bids to Directus');
		}
	}
	catch (err) {
		console.error('ERROR uploading bids:', err.message);
	}
}

async function markBidStatus(contractIdStr, bidId, status) {
	try {
		const response = await client.request(readItems(bidsCacheTable, {
			fields: ['id'],
			filter: {
				factoryContract: { _eq: contractIdStr },
				bidId: { _eq: bidId },
				environment: { _eq: env },
			},
			limit: 1,
		}));

		if (response && response.length > 0) {
			await writeClient.request(updateItem(bidsCacheTable, response[0].id, { status }));
		}
	}
	catch (err) {
		console.error('ERROR marking bid status:', err.message);
	}
}

async function uploadStashEventsToDirectus(contractIdStr, events) {
	const records = events.map(e => ({
		factoryContract: contractIdStr,
		eventType: e.type,
		data: JSON.stringify(e),
		environment: env,
		timestamp: e.timestamp,
	}));

	try {
		for (let i = 0; i < records.length; i += 100) {
			const batch = records.slice(i, i + 100);
			const data = await writeClient.request(createItems(stashEventsTable, batch));
			if (!suppressLogs) console.log('Uploaded', data?.length, 'events to Directus');
		}
	}
	catch (err) {
		console.error('ERROR uploading events:', err.message);
	}
}

// ===== Helpers =====

async function resolveAccount(evmAddress) {
	if (evmToHederaMap.has(evmAddress)) return evmToHederaMap.get(evmAddress);
	const baseUrl = getBaseURL();
	// S4: try /accounts first (EOAs), then /contracts (stash clones, factory)
	try {
		const acct = (await axios.get(`${baseUrl}/api/v1/accounts/${evmAddress}`)).data.account;
		evmToHederaMap.set(evmAddress, acct);
		return acct;
	}
	catch {
		try {
			const contract = (await axios.get(`${baseUrl}/api/v1/contracts/${evmAddress}`)).data.contract_id;
			if (contract) {
				evmToHederaMap.set(evmAddress, contract);
				return contract;
			}
		}
		catch { /* fall through */ }
		return evmAddress; // fallback to raw EVM address
	}
}

async function resolveToken(evmAddress) {
	try {
		return TokenId.fromSolidityAddress(evmAddress).toString();
	}
	catch {
		return evmAddress;
	}
}

function getBaseURL() {
	switch (env) {
	case 'mainnet': return 'https://mainnet-public.mirrornode.hedera.com';
	case 'testnet': return 'https://testnet.mirrornode.hedera.com';
	case 'previewnet': return 'https://previewnet.mirrornode.hedera.com';
	case 'local': return 'http://localhost:5551';
	default: throw new Error(`Unknown environment: ${env}`);
	}
}

main()
	.then(() => {
		if (!suppressLogs) console.log('INFO: Completed @', new Date().toUTCString());
		process.exit(0);
	})
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
