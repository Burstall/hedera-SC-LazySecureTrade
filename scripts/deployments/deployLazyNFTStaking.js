const {
	Client,
	AccountId,
	PrivateKey,
	ContractId,
	TokenId,
	ContractFunctionParameters,
} = require('@hashgraph/sdk');
const fs = require('fs');
const { ethers } = require('ethers');
const readlineSync = require('readline-sync');
const { contractDeployFunction, contractExecuteFunction } = require('../../utils/solidityHelpers');
// const { hethers } = require('@hashgraph/hethers');
require('dotenv').config();

// Get operator from .env file
let operatorKey;
let operatorId;
try {
	operatorKey = PrivateKey.fromStringED25519(process.env.PRIVATE_KEY);
	operatorId = AccountId.fromString(process.env.ACCOUNT_ID);
}
catch (err) {
	console.log('ERROR: Must specify PRIVATE_KEY & ACCOUNT_ID in the .env file');
}

const lazyContractCreator = 'LAZYTokenCreator';
const lazyGasStationName = 'LazyGasStation';
const contractName = 'LazyNFTStaking';
const lazyDelegateRegistryName = 'LazyDelegateRegistry';
const env = process.env.ENVIRONMENT ?? null;
const LAZY_BURN_PERCENT = process.env.LAZY_BURN_PERCENT ?? 0;
const LAZY_DECIMAL = process.env.LAZY_DECIMALS ?? 1;
const LAZY_STAKING_DISTRIBUTION_PERIOD =
	process.env.LAZY_STAKING_DISTRIBUTION_PERIOD ?? 86400;
const LAZY_STAKING_BOOST_CAP = process.env.LAZY_STAKING_BOOST_CAP ?? 500;
const LAZY_STAKING_PERIOD_FOR_BONUS =
	process.env.LAZY_STAKING_PERIOD_FOR_BONUS ?? 30;
const LAZY_STAKING_HODL_BONUS = process.env.LAZY_STAKING_HODL_BONUS ?? 25;
const LAZY_STAKING_MAX_BONUS_PERIODS =
	process.env.LAZY_STAKING_MAX_BONUS_PERIODS ?? 8;
const LAZY_MAX_SUPPLY = process.env.LAZY_MAX_SUPPLY ?? 250_000_000;
const LAZY_HALF_AFTER = process.env.LAZY_HALF_AFTER ?? 50_000_000;

let signingWallet;
let ldrId;
let lazyTokenId;
let client;
let lazySCT;
let lazyGasStationId;
let lazyIface, lazyGasStationIface;

const main = async () => {
	// configure the client object
	if (
		operatorKey === undefined ||
		operatorKey == null ||
		operatorId === undefined ||
		operatorId == null
	) {
		console.log(
			'Environment required, please specify PRIVATE_KEY & ACCOUNT_ID in the .env file',
		);
		process.exit(1);
	}

	console.log('\n-Using ENIVRONMENT:', env);

	if (env.toUpperCase() == 'TEST') {
		client = Client.forTestnet();
		console.log('testing in *TESTNET*');
	}
	else if (env.toUpperCase() == 'MAIN') {
		client = Client.forMainnet();
		console.log('testing in *MAINNET*');
	}
	else if (env.toUpperCase() == 'PREVIEW') {
		client = Client.forPreviewnet();
		console.log('testing in *PREVIEWNET*');
	}
	else if (env.toUpperCase() == 'LOCAL') {
		const node = { '127.0.0.1:50211': new AccountId(3) };
		client = Client.forNetwork(node).setMirrorNetwork('127.0.0.1:5600');
		console.log('testing in *LOCAL*');
	}
	else {
		console.log(
			'ERROR: Must specify either MAIN or TEST or LOCAL as environment in .env file',
		);
		return;
	}

	client.setOperator(operatorId, operatorKey);
	// deploy the contract
	console.log('\n-Using Operator:', operatorId.toString());

	if (process.env.LAZY_SCT_CONTRACT_ID && process.env.LAZY_TOKEN_ID) {
		console.log(
			'\n-Using existing LAZY SCT:',
			process.env.LAZY_SCT_CONTRACT_ID,
		);
		lazySCT = ContractId.fromString(process.env.LAZY_SCT_CONTRACT_ID);

		lazyTokenId = TokenId.fromString(process.env.LAZY_TOKEN_ID);
		console.log('\n-Using existing LAZY Token ID:', lazyTokenId.toString());
	}
	else {
		console.log('LAZY_SCT_CONTRACT_ID ->', process.env.LAZY_SCT_CONTRACT_ID);
		console.log('LAZY_TOKEN_ID ->', process.env.LAZY_TOKEN_ID);
		const proceed = readlineSync.keyInYNStrict('No LAZY SCT found, do you want to deploy it and mint $LAZY?');

		if (!proceed) {
			console.log('Aborting');
			return;
		}

		const lazyJson = JSON.parse(
			fs.readFileSync(
				`./artifacts/contracts/legacy/${lazyContractCreator}.sol/${lazyContractCreator}.json`,
			),
		);

		const lazyContractBytecode = lazyJson.bytecode;
		lazyIface = new ethers.Interface(lazyJson.abi);

		console.log(
			'\n- Deploying contract...',
			lazyContractCreator,
			'\n\tgas@',
			800_000,
		);

		[lazySCT] = await contractDeployFunction(client, lazyContractBytecode);

		console.log(
			`Lazy Token Creator contract created with ID: ${lazySCT} / ${lazySCT.toSolidityAddress()}`,
		);

		// mint the $LAZY FT
		await mintLazy(
			'Test_Lazy',
			'TLazy',
			'Test Lazy FT',
			2_500_000_000,
			LAZY_DECIMAL,
			2_500_000_000,
			30,
		);
		console.log('$LAZY Token minted:', lazyTokenId.toString());
	}

	const lazyGasStationJSON = JSON.parse(
		fs.readFileSync(
			`./artifacts/contracts/${lazyGasStationName}.sol/${lazyGasStationName}.json`,
		),
	);

	lazyGasStationIface = new ethers.Interface(lazyGasStationJSON.abi);

	if (process.env.LAZY_GAS_STATION_CONTRACT_ID) {
		console.log(
			'\n-Using existing Lazy Gas Station:',
			process.env.LAZY_GAS_STATION_CONTRACT_ID,
		);
		lazyGasStationId = ContractId.fromString(
			process.env.LAZY_GAS_STATION_CONTRACT_ID,
		);
	}
	else {
		console.log('LAZY_GAS_STATION_CONTRACT_ID ->', process.env.LAZY_GAS_STATION_CONTRACT_ID);
		const proceed = readlineSync.keyInYNStrict('No Lazy Gas Station found, do you want to deploy it?');

		if (!proceed) {
			console.log('Aborting');
			return;
		}

		const gasLimit = 1_500_000;
		console.log(
			'\n- Deploying contract...',
			lazyGasStationName,
			'\n\tgas@',
			gasLimit,
		);

		const lazyGasStationBytecode = lazyGasStationJSON.bytecode;

		const lazyGasStationParams = new ContractFunctionParameters()
			.addAddress(lazyTokenId.toSolidityAddress())
			.addAddress(lazySCT.toSolidityAddress());

		[lazyGasStationId] = await contractDeployFunction(
			client,
			lazyGasStationBytecode,
			gasLimit,
			lazyGasStationParams,
		);

		console.log(
			`Lazy Gas Station contract created with ID: ${lazyGasStationId} / ${lazyGasStationId.toSolidityAddress()}`,
		);
	}

	if (process.env.LAZY_DELEGATE_REGISTRY_CONTRACT_ID) {
		console.log(
			'\n-Using existing Lazy Delegate Registry:',
			process.env.LAZY_DELEGATE_REGISTRY_CONTRACT_ID,
		);
		ldrId = ContractId.fromString(
			process.env.LAZY_DELEGATE_REGISTRY_CONTRACT_ID,
		);
	}
	else {
		console.log('LAZY_DELEGATE_REGISTRY_CONTRACT_ID ->', process.env.LAZY_DELEGATE_REGISTRY_CONTRACT_ID);
		const proceed = readlineSync.keyInYNStrict('No Lazy Delegate Registry found, do you want to deploy it?');

		if (!proceed) {
			console.log('Aborting');
			return;
		}

		const gasLimit = 500_000;

		const ldrJson = JSON.parse(
			fs.readFileSync(
				`./artifacts/contracts/${lazyDelegateRegistryName}.sol/${lazyDelegateRegistryName}.json`,
			),
		);

		const ldrBytecode = ldrJson.bytecode;

		console.log('\n- Deploying contract...', lazyDelegateRegistryName, '\n\tgas@', gasLimit);

		[ldrId] = await contractDeployFunction(client, ldrBytecode, gasLimit);

		console.log(
			`Lazy Delegate Registry contract created with ID: ${ldrId} / ${ldrId.toSolidityAddress()}`,
		);
	}

	if (process.env.SIGNING_WALLET) {
		console.log('\n-Using existing SIGNING_WALLET from file');
		signingWallet = PrivateKey.fromStringECDSA(process.env.SIGNING_WALLET);
	}
	else {
		let proceed = readlineSync.keyInYNStrict('No SIGNING_WALLET found, do you want to create one?');

		if (!proceed) {
			console.log('Aborting');
			return;
		}

		signingWallet = PrivateKey.generateECDSA();

		console.log('REMEMBER THIS KEY HAS VALUE - PROTECT IT');

		proceed = readlineSync.keyInYNStrict('Do you want to print the SIGNING_WALLET to a console?');

		if (proceed) {
			console.log(signingWallet.toString());
		}
		else {
			proceed = readlineSync.keyInYNStrict('Do you want to save the SIGNING_WALLET (unecrypted) to a file?');

			if (proceed) {
				fs.writeFileSync('./signingWallet.key', signingWallet.toString());
			}
		}
	}

	console.log(
		`Off-chain signing wallet created: 0x${signingWallet.publicKey.toEvmAddress()}`,
	);

	console.log('BURN_PERCENT:', LAZY_BURN_PERCENT);
	console.log('STAKING_DISTRIBUTION_PERIOD:', LAZY_STAKING_DISTRIBUTION_PERIOD);
	console.log('STAKING_BOOST_CAP:', LAZY_STAKING_BOOST_CAP);
	console.log('STAKING_PERIOD_FOR_BONUS:', LAZY_STAKING_PERIOD_FOR_BONUS);
	console.log('STAKING_HODL_BONUS:', LAZY_STAKING_HODL_BONUS);
	console.log('STAKING_MAX_BONUS_PERIODS:', LAZY_STAKING_MAX_BONUS_PERIODS);
	console.log('MAX_SUPPLY:', LAZY_MAX_SUPPLY);
	console.log('HALF_AFTER:', LAZY_HALF_AFTER);


	const proceed = readlineSync.keyInYNStrict('Do you want to deploy Lazy NFT Staking Contract?');

	if (!proceed) {
		console.log('Aborting');
		return;
	}

	const gasLimit = 2_500_000;

	// now deploy main contract
	const lazyNFTStakerJson = JSON.parse(
		fs.readFileSync(
			`./artifacts/contracts/${contractName}.sol/${contractName}.json`,
		),
	);

	const contractBytecode = lazyNFTStakerJson.bytecode;

	console.log(
		'\n- Deploying contract...',
		contractName,
		'\n\tgas@',
		gasLimit,
	);

	const constructorParams = new ContractFunctionParameters()
		.addAddress(lazyTokenId.toSolidityAddress())
		.addAddress(lazyGasStationId.toSolidityAddress())
		.addAddress(ldrId.toSolidityAddress())
		.addAddress(signingWallet.publicKey.toEvmAddress())
		.addUint256(LAZY_BURN_PERCENT)
		.addUint256(LAZY_STAKING_DISTRIBUTION_PERIOD)
		.addUint32(LAZY_STAKING_BOOST_CAP)
		.addUint16(LAZY_STAKING_PERIOD_FOR_BONUS)
		.addUint16(LAZY_STAKING_HODL_BONUS)
		.addUint16(LAZY_STAKING_MAX_BONUS_PERIODS)
		.addUint256(LAZY_MAX_SUPPLY * 10 ** LAZY_DECIMAL)
		.addUint256(LAZY_HALF_AFTER * 10 ** LAZY_DECIMAL);

	const [lnsContractId, lnsContractAddress] = await contractDeployFunction(
		client,
		contractBytecode,
		gasLimit,
		constructorParams,
	);

	console.log(
		`Lazy NFT Staking Contract created with ID: ${lnsContractId} / ${lnsContractAddress}`,
	);

	// add the Mission Factory to the lazy gas station as an authorizer
	const rslt = await contractExecuteFunction(
		lazyGasStationId,
		lazyGasStationIface,
		client,
		null,
		'addContractUser',
		[lnsContractId.toSolidityAddress()],
	);

	if (rslt[0]?.status.toString() != 'SUCCESS') {
		console.log('ERROR adding LNS to LGS:', rslt);
	}

	console.log('Lazy NFT Staking added to Lazy Gas Station:', rslt[2].transactionId.toString());

};

/**
 * Helper function to encpapsualte minting an FT
 * @param {string} tokenName
 * @param {string} tokenSymbol
 * @param {string} tokenMemo
 * @param {number} tokenInitalSupply
 * @param {number} tokenDecimal
 * @param {number} tokenMaxSupply
 * @param {number} payment
 */
async function mintLazy(
	tokenName,
	tokenSymbol,
	tokenMemo,
	tokenInitalSupply,
	decimal,
	tokenMaxSupply,
	payment,
) {
	const gasLim = 800000;
	// call associate method
	const params = [
		tokenName,
		tokenSymbol,
		tokenMemo,
		tokenInitalSupply,
		decimal,
		tokenMaxSupply,
	];

	const [, , createTokenRecord] = await contractExecuteFunction(
		lazySCT,
		lazyIface,
		client,
		gasLim,
		'createFungibleWithBurn',
		params,
		payment,
	);
	const tokenIdSolidityAddr =
		createTokenRecord.contractFunctionResult.getAddress(0);
	lazyTokenId = TokenId.fromSolidityAddress(tokenIdSolidityAddr);
}

main()
	.then(() => process.exit(0))
	.catch(error => {
		console.error(error);
		process.exit(1);
	});
