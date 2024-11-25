const {
	ContractId,
	AccountId,
	Hbar,
	HbarUnit,
} = require('@hashgraph/sdk');
require('dotenv').config();
const fs = require('fs');
const { ethers } = require('ethers');
const { getArgFlag } = require('../../utils/nodeHelpers');
const { getBaseURL } = require('../../utils/hederaMirrorHelpers');
const { default: axios } = require('axios');

const operatorId = process.env.ACCOUNT_ID ?? '0.0.888';

const contractName = 'LazySecureTrade';

const env = process.env.ENVIRONMENT ?? null;

const main = async () => {

	const args = process.argv.slice(2);
	if (args.length != 1 || getArgFlag('h')) {
		console.log('Usage: getLiveTradesFromEvents.js 0.0.STC');
		console.log('       STC is the secure trade contract');
		return;
	}

	const contractId = ContractId.fromString(args[0]);

	console.log('\n-Using ENIVRONMENT:', env);
	console.log('\n-Using Operator:', operatorId.toString());
	console.log('\n-Using Contract:', contractId.toString());

	// import ABI
	const stcJSON = JSON.parse(
		fs.readFileSync(
			`./artifacts/contracts/${contractName}.sol/${contractName}.json`,
		),
	);

	const stcIface = new ethers.Interface(stcJSON.abi);

	// Call the function to fetch logs
	const tradesMap = await getEventsFromMirror(contractId, stcIface);

	// filter out the completed and cancelled trades
	for (const trade of tradesMap) {
		if (trade[1].completed || trade[1].cancelled) {
			tradesMap.delete(trade[0]);
		}
	}

	if (tradesMap) {
		for (const [hash, trade] of tradesMap) {
			console.log(hash, '->', trade.toString());
		}
	}
	else { console.log('ERROR: No open trades found'); }
};

async function getEventsFromMirror(contractId, iface) {
	const baseUrl = getBaseURL(env);

	let url = `${baseUrl}/api/v1/contracts/${contractId.toString()}/results/logs?order=asc&limit=100`;

	const tradesMap = new Map();

	do {
		const response = await axios.get(url);
		const jsonResponse = response.data;
		jsonResponse.logs.forEach(log => {
			// decode the event data
			if (log.data == '0x') return;
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
				tradesMap.get(ethers.solidityPackedKeccak256(['address', 'uint256'], [event.args[2], event.args[3]]))?.complete();
				break;
			case 'TradeCancelled':
				tradesMap.get(ethers.solidityPackedKeccak256(['address', 'uint256'], [event.args[1], event.args[2]]))?.cancel();
				break;
			default:
				break;
			}
		});

		url = jsonResponse.next;
	}
	while (url);

	return tradesMap;
}

class TradeObject {
	constructor(seller, buyer, tokenId, serial, tinybarPrice, lazyPrice, expiryTime, nonce) {
		this.seller = seller;
		this.buyer = buyer;
		this.tokenId = tokenId;
		this.serial = parseInt(serial);
		this.tinybarPrice = Number(tinybarPrice);
		this.lazyPrice = Number(lazyPrice);
		this.expiryTime = expiryTime;
		this.nonce = nonce;

		this.completed = false;
		this.cancelled = false;
	}

	isPublicTrade() {
		return this.buyer != '0x';
	}

	complete() {
		this.completed = true;
	}

	cancel() {
		this.cancelled = true;
	}

	toString() {
		return `Seller: ${AccountId.fromEvmAddress(0, 0, this.seller).toString()}, Buyer: ${AccountId.fromEvmAddress(0, 0, this.buyer).toString()}, TokenId: ${this.tokenId}, Serial: ${this.serial}, Price: ${new Hbar(this.tinybarPrice, HbarUnit.Tinybar).toString()}, LazyPrice: ${this.lazyPrice / 10} $LAZY, ExpiryTime: ${this.expiryTime}, Nonce: ${this.nonce}, Completed: ${this.completed}, Cancelled: ${this.cancelled}`;
	}
}

main()
	.then(() => {
		process.exit(0);
	})
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
