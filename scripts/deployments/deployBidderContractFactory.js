const fs = require('fs');
const {
	Client,
	AccountId,
	PrivateKey,
	ContractId,
	TokenId,
	ContractFunctionParameters,
} = require('@hashgraph/sdk');
const { contractDeployFunction } = require('../../utils/solidityHelpers');
require('dotenv').config();

async function main() {
	// Get operator from .env file
	let operatorKey;
	let operatorId;
	try {
		operatorKey = PrivateKey.fromStringED25519(process.env.PRIVATE_KEY);
		operatorId = AccountId.fromString(process.env.ACCOUNT_ID);
	}
	catch (err) {
		console.log('ERROR: Must specify PRIVATE_KEY & ACCOUNT_ID in the .env file');
		process.exit(1);
	}

	// Get required contract addresses from .env
	const lstContractId = process.env.LST_CONTRACT_ID ? ContractId.fromString(process.env.LST_CONTRACT_ID) : null;
	const lazyTokenId = process.env.LAZY_TOKEN_ID ? TokenId.fromString(process.env.LAZY_TOKEN_ID) : null;
	const lazyGasStationId = process.env.LGS_CONTRACT_ID ? ContractId.fromString(process.env.LGS_CONTRACT_ID) : null;
	const lazyDelegateRegistryId = process.env.LDR_CONTRACT_ID ? ContractId.fromString(process.env.LDR_CONTRACT_ID) : null;

	if (!lstContractId || !lazyTokenId || !lazyGasStationId) {
		console.log('ERROR: Must specify LST_CONTRACT_ID, LAZY_TOKEN_ID, and LGS_CONTRACT_ID in .env file');
		process.exit(1);
	}

	// LazyDelegateRegistry is optional (use placeholder if not provided)
	const ldrAddress = lazyDelegateRegistryId
		? lazyDelegateRegistryId.toSolidityAddress()
		: '0x0000000000000000000000000000000000000167';

	// Honour ENVIRONMENT so this never silently misdeploys to testnet on a mainnet run.
	const env = process.env.ENVIRONMENT ?? null;
	if (!env) {
		console.log('ERROR: ENVIRONMENT must be set (test|main|preview|local) in .env');
		process.exit(1);
	}

	let client;
	if (env.toUpperCase() === 'TEST') {
		client = Client.forTestnet();
	}
	else if (env.toUpperCase() === 'MAIN') {
		client = Client.forMainnet();
	}
	else if (env.toUpperCase() === 'PREVIEW') {
		client = Client.forPreviewnet();
	}
	else if (env.toUpperCase() === 'LOCAL') {
		const node = { '127.0.0.1:50211': new AccountId(3) };
		client = Client.forNetwork(node).setMirrorNetwork('127.0.0.1:5600');
	}
	else {
		console.log(`ERROR: Invalid ENVIRONMENT '${env}'. Must be one of test|main|preview|local.`);
		process.exit(1);
	}
	client.setOperator(operatorId, operatorKey);

	console.log('\n=== Deploying BidderContract Implementation ===');
	console.log('Network:', env.toUpperCase());
	console.log('Operator:', operatorId.toString());
	console.log('LazySecureTrade:', lstContractId.toString());
	console.log('$LAZY Token:', lazyTokenId.toString());
	console.log('LazyGasStation:', lazyGasStationId.toString());
	console.log('LazyDelegateRegistry:', lazyDelegateRegistryId ? lazyDelegateRegistryId.toString() : 'Placeholder');

	// Deploy BidderContract implementation
	console.log('\n--- Deploying BidderContract Implementation ---');
	const bidderContractJson = JSON.parse(
		fs.readFileSync('./artifacts/contracts/BidderContract.sol/BidderContract.json', 'utf8'),
	);
	const bidderContractByteCode = bidderContractJson.bytecode;

	const bidderContractImplId = await contractDeployFunction(
		client,
		bidderContractByteCode,
		1500000,
		new ContractFunctionParameters(),
	);

	console.log('✅ BidderContract Implementation deployed:', bidderContractImplId.toString());

	// Deploy BidderContractFactory
	console.log('\n--- Deploying BidderContractFactory ---');
	const factoryJson = JSON.parse(
		fs.readFileSync('./artifacts/contracts/BidderContractFactory.sol/BidderContractFactory.json', 'utf8'),
	);
	const factoryByteCode = factoryJson.bytecode;

	const constructorParams = new ContractFunctionParameters()
		.addAddress(lstContractId.toSolidityAddress())
		.addAddress(lazyTokenId.toSolidityAddress())
		.addAddress(lazyGasStationId.toSolidityAddress())
		.addAddress(ldrAddress)
		.addAddress(bidderContractImplId.toSolidityAddress());

	const factoryContractId = await contractDeployFunction(
		client,
		factoryByteCode,
		1500000,
		constructorParams,
	);

	console.log('✅ BidderContractFactory deployed:', factoryContractId.toString());

	// Summary
	console.log('\n=== Deployment Complete ===');
	console.log('BidderContract Implementation:', bidderContractImplId.toString());
	console.log('BidderContractFactory:', factoryContractId.toString());
	console.log('\n📝 Add to your .env file:');
	console.log(`BIDDER_CONTRACT_IMPL_ID=${bidderContractImplId.toString()}`);
	console.log(`BIDDER_FACTORY_CONTRACT_ID=${factoryContractId.toString()}`);

	await client.close();
	process.exit(0);
}

main()
	.then(() => {
		console.log('\n✅ Deployment script completed successfully');
	})
	.catch((error) => {
		console.error('\n❌ Deployment failed:', error);
		process.exit(1);
	});
