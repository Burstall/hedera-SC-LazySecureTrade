const {
	ContractId,
	AccountId,
	Hbar,
	HbarUnit,
} = require('@hashgraph/sdk');
require('dotenv').config();
const { ethers } = require('ethers');
const { getArgFlag } = require('../../utils/nodeHelpers');
const { getBaseURL } = require('../../utils/hederaMirrorHelpers');
const { default: axios } = require('axios');
const { createDirectus, rest, readItems, staticToken, updateItem, createItem, createItems } = require('@directus/sdk');

const operatorId = process.env.ACCOUNT_ID ?? '0.0.888';
const env = process.env.SECURE_TRADE_ENV ?? null;
const eventsTable = process.env.SECURE_TRADE_EVENTS_TABLE ?? 'secureTradeEvents';
const cacheTable = process.env.SECURE_TRADE_CACHE_TABLE ?? 'SecureTradesCache';
const client = createDirectus(process.env.DIRECTUS_DB_URL).with(rest());
const writeClient = createDirectus(process.env.DIRECTUS_DB_URL).with(staticToken(process.env.DIRECTUS_TOKEN)).with(rest());
const supressLogs = process.env.SECURE_TRADE_SUPRESS_LOGS === '1' || process.env.SECURE_TRADE_SUPRESS_LOGS === 'true';

const main = async () => {

	const args = process.argv.slice(2);
	if ((args.length > 1) || getArgFlag('h')) {
		console.log('Usage: secureTradeEventScanner.js [0.0.STC]');
		console.log('       STC is the secure trade contract if not supplied will use LAZY_SECURE_TRADE_CONTRACT_ID from the .env file');
		return;
	}

	let secureTradeContract;

	// if an argument is passed use that as the contract id
	if (args.length == 0) {
		secureTradeContract = process.env.LAZY_SECURE_TRADE_CONTRACT_ID ?? null;
	}
	else {
		secureTradeContract = args[0];
	}

	if (!secureTradeContract) {
		console.log('ERROR: No secure trade contract provided');
		return;
	}

	// validate environment is in set of allowed values [mainnet, testnet, previewnet, local]
	if (!['mainnet', 'testnet', 'previewnet', 'local'].includes(env)) {
		console.log('ERROR: Invalid environment provided');
		return;
	}

	const contractId = ContractId.fromString(secureTradeContract);

	if (!supressLogs) console.log('\n-Using ENIVRONMENT:', env, 'operatorId:', operatorId, 'contractId:', contractId.toString());

	// look up the last hash from the EVENTS table
	const lastRecord = await getLastHashFromDirectus(contractId.toString());

	if (!lastRecord) {
		if (!supressLogs) console.log('INFO: No last timestamp found in the events table - fetching all logs');
	}
	else if (!supressLogs) {
		console.log('INFO: Last timestamp found in the events table:', lastRecord, '[', new Date(lastRecord * 1000).toUTCString(), ']');
	}

	const stcIface = new ethers.Interface(
		[
			'event TradeCreated(address indexed seller, address indexed buyer, address indexed token, uint256 serial, uint256 tinybarPrice, uint256 lazyPrice, uint256 expiryTime, uint256 nonce)',
			'event TradeCancelled(address indexed seller, address indexed token, uint256 serial, uint256 nonce)',
			'event TradeCompleted(address indexed seller, address indexed buyer, address indexed token, uint256 serial, uint256 nonce)',
		],
	);

	// Call the function to fetch logs
	let tradesMap = await getEventsFromMirror(contractId, stcIface, lastRecord);

	if (!supressLogs) console.log('Found', tradesMap.size, 'trades');

	// get the max nonce from the cache table
	const maxNonce = await getMaxNonceFromDirectus(contractId.toString());

	if (!supressLogs) console.log('Max nonce in cache table:', maxNonce);

	// filter out trades that have nonce less than the max nonce
	tradesMap = new Map([...tradesMap].filter(([, value]) => value.nonce > maxNonce));

	if (!supressLogs) console.log('POST FILTER: Found', tradesMap.size, 'trades');

	if (tradesMap) {
		// split the trades into batches of 100
		const tradesArray = Array.from(tradesMap.values());
		const batchSize = 100;
		for (let i = 0; i < tradesArray.length; i += batchSize) {
			const batch = tradesArray.slice(i, i + batchSize);
			await uploadTradesToDirectus(contractId.toString(), batch);
		}

		for (const [hash, trade] of tradesMap) {
			if (!supressLogs) console.log(hash, '->', trade.toString());
		}
	}
	else if (!supressLogs) { console.log('INFO: No new trades found'); }
};

async function getEventsFromMirror(contractId, iface, lastTimestamp) {
	const baseUrl = getBaseURL(env);

	let url;

	if (!lastTimestamp) {
		// pull logs from the beginning
		url = `${baseUrl}/api/v1/contracts/${contractId.toString()}/results/logs?order=asc&limit=100`;
	}
	else {
		// pull logs from the last timestamp
		url = `${baseUrl}/api/v1/contracts/${contractId.toString()}/results/logs?order=asc&limit=100&timestamp=gt:${lastTimestamp}`;
	}

	const tradesMap = new Map();
	let maxTimestamp = 0;

	do {
		const response = await axios.get(url);
		const jsonResponse = response.data;
		jsonResponse.logs.forEach(log => {
			// decode the event data
			if (log.data == '0x') return;

			// update the max timestamp
			if (log.timestamp > maxTimestamp) {
				maxTimestamp = log.timestamp;
			}
			const event = iface.parseLog({ topics: log.topics, data: log.data });

			/*
			 struct Trade {
			0	address seller;
			1	address buyer;
			2	address token;
			3	uint256 serial;
			4	uint256 tinybarPrice;
			5	uint256 lazyPrice;
			6	uint256 expiryTime;
			7	uint256 nonce;
			}
			*/

			/*
			 event TradeCompleted(
			0	address indexed seller,
			1	address indexed buyer,
			2	address indexed token,
			3	uint256 serial,
			4	uint256 nonce
			);
			*/

			/*
			 event TradeCancelled(
			0	address indexed seller,
			1	address indexed token,
			2	uint256 serial,
			3	uint256 nonce
			);*/

			// hash = ethers.solidityPackedKeccak256(['address', 'uint256'], [token.toSolidityAddress(), serial]);
			switch (event.name) {
			case 'TradeCreated':
				tradesMap.set(ethers.solidityPackedKeccak256(['address', 'uint256'], [event.args[2], event.args[3]]), new TradeObject(
					event.args[0],
					event.args[1],
					event.args[2],
					event.args[3],
					event.args[4],
					event.args[5],
					event.args[6],
					event.args[7],
				));
				break;
			case 'TradeCompleted':
				// if the trade is not in the map then it was created before the last timestamp
				// so we just need to update the DB with markTradeAsCompletedInDb
				if (!tradesMap.has(ethers.solidityPackedKeccak256(['address', 'uint256'], [event.args[2], event.args[3]]))) {
					markTradeAsCompletedOrCancelledInDb(contractId.toString(), event.args[2], Number(event.args[3]), Number(event.args[4]), true);
					return;
				}
				tradesMap.get(ethers.solidityPackedKeccak256(['address', 'uint256'], [event.args[2], event.args[3]]))?.complete();
				break;
			case 'TradeCancelled':
				// if the trade is not in the map then it was created before the last timestamp
				// so we just need to update the DB with markTradeAsCancelledInDb
				if (!tradesMap.has(ethers.solidityPackedKeccak256(['address', 'uint256'], [event.args[1], event.args[2]]))) {
					markTradeAsCompletedOrCancelledInDb(contractId.toString(), event.args[1], Number(event.args[2]), Number(event.args[3]), false);
					return;
				}
				tradesMap.get(ethers.solidityPackedKeccak256(['address', 'uint256'], [event.args[1], event.args[2]]))?.cancel();
				break;
			default:
				break;
			}
		});

		url = jsonResponse.next;
	}
	while (url);

	// post the last timestamp to the events table to enable status to persist across restarts
	if (maxTimestamp != 0) await postLastestTimestampToDirectus(contractId.toString(), maxTimestamp);

	return tradesMap;
}

async function postLastestTimestampToDirectus(tradeContractId, timestamp) {
	const response = await client.request(readItems(eventsTable, {
		fields: ['id'],
		filter: {
			tradeContract: {
				_eq: tradeContractId.toString(),
			},
			environment: {
				_eq: env,
			},
		},
		limit: 1,
	}));

	if (!response || response.length == 0) {
		await writeClient.request(createItem(eventsTable, { tradeContract: tradeContractId, lastTimestamp: timestamp, environment: env }));
	}
	else {
		await writeClient.request(updateItem(eventsTable, response[0].id, { lastTimestamp: timestamp }));
	}
}

async function markTradeAsCompletedOrCancelledInDb(tradeContractId, tokenId, serial, nonce, completed = true) {
	// find the primary key of the trade in the cache table
	const response = await client.request(readItems(cacheTable, {
		fields: ['id'],
		filter: {
			tradeContract: {
				_eq: tradeContractId.toString(),
			},
			tokenId: {
				_eq: tokenId.toString(),
			},
			serial: {
				_eq: Number(serial),
			},
			nonce: {
				_eq: Number(nonce),
			},
			environment: {
				_eq: env,
			},
		},
		limit: 1,
	}));

	if (response.data.length == 0) {
		console.log('ERROR: Trade not found in cache table');
		return;
	}

	if (completed) {
		await writeClient.request(updateItem(cacheTable, response.data[0].id, { completed: true }));
	}
	else {
		await writeClient.request(updateItem(cacheTable, response.data[0].id, { cancelled: true }));
	}
}

async function getMaxNonceFromDirectus(tradeContractId) {
	const response = await client.request(readItems(cacheTable, {
		fields: ['nonce'],
		filter: {
			tradeContract: {
				_eq: tradeContractId.toString(),
			},
			environment: {
				_eq: env,
			},
		},
		sort: ['-nonce'],
		limit: 1,
	}));

	if (!response || response.length == 0) {
		return 0;
	}

	return response[0].nonce;
}

/**
 * Uploads the trade to the directus cache table
 * @param {String} tradeContractId
 * @param {TradeObject[]} trades
 */
async function uploadTradesToDirectus(tradeContractId, trades) {
	if (trades.length == 0) return;

	const tradesToUpload = trades.map(trade => {
		return {
			tradeContract: tradeContractId,
			seller: trade.seller,
			buyer: trade.buyer,
			token: trade.tokenId,
			serial: trade.serial,
			tinybarPrice: trade.tinybarPrice,
			lazyPrice: trade.lazyPrice,
			expiryTime: trade.expiryTime,
			nonce: trade.nonce,
			environment: env,
			completed: trade.completed,
			canceled: trade.canceled,
		};
	});

	try {
		const data = await writeClient.request(createItems(cacheTable, tradesToUpload));

		console.log('INFO: Uploaded', data?.length, 'trades to Directus');
	}
	catch (error) {
		if (error?.response?.statusText == 'Bad Request') {
			console.log('ERROR: Bad Request', error.response);
			const item = trades.pop();
			console.log('Retrying without', item);
			await uploadTradesToDirectus(tradeContractId, trades);
		}
		else {
			console.error(error);
		}
	}
}


async function getLastHashFromDirectus(tradeContractId) {
	const response = await client.request(readItems(eventsTable, {
		fields: ['lastTimestamp'],
		filter: {
			tradeContract: {
				_eq: tradeContractId.toString(),
			},
			environment: {
				_eq: env,
			},
		},
	}));

	if (!response || response.length == 0 || response[0].lastTimestamp == '0') {
		return null;
	}

	return response[0].lastTimestamp;
}

class TradeObject {
	constructor(seller, buyer, tokenId, serial, tinybarPrice, lazyPrice, expiryTime, nonce) {
		this.seller = AccountId.fromEvmAddress(0, 0, seller).toString();
		this.buyer = AccountId.fromEvmAddress(0, 0, buyer).toString();
		this.tokenId = AccountId.fromEvmAddress(0, 0, tokenId).toString();
		this.serial = parseInt(serial);
		this.tinybarPrice = Number(tinybarPrice);
		this.lazyPrice = Number(lazyPrice);
		this.expiryTime = Number(expiryTime);
		this.nonce = Number(nonce);

		this.completed = false;
		this.canceled = false;
	}

	isPublicTrade() {
		return this.buyer != '0x';
	}

	complete() {
		this.completed = true;
	}

	cancel() {
		this.canceled = true;
	}

	toString() {
		return `Seller: ${this.seller}, Buyer: ${this.buyer}, TokenId: ${this.tokenId}, Serial: ${this.serial}, Price: ${new Hbar(this.tinybarPrice, HbarUnit.Tinybar).toString()}, LazyPrice: ${this.lazyPrice / 10} $LAZY, ExpiryTime: ${this.expiryTime ? new Date(this.expiryTime * 1000).toUTCString() : 'NONE'}, Nonce: ${this.nonce}, Completed: ${this.completed}, Cancelled: ${this.canceled}`;
	}
}

main()
	.then(() => {
		if (!supressLogs) console.log('INFO: Completed @', new Date().toUTCString());
		process.exit(0);
	})
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
