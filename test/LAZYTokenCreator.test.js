const {
	Client,
	AccountId,
	PrivateKey,
	ContractCreateFlow,
	ContractFunctionParameters,
	ContractCallQuery,
	Hbar,
	ContractExecuteTransaction,
	AccountCreateTransaction,
	StatusError,
	HbarUnit,
	AccountInfoQuery,
	// eslint-disable-next-line no-unused-vars
	TransactionReceipt,
	TransferTransaction,
	// eslint-disable-next-line no-unused-vars
	TokenId,
	ContractInfoQuery,
	// eslint-disable-next-line no-unused-vars
	ContractId,
	// eslint-disable-next-line no-unused-vars
	TransactionRecord,
	TokenAssociateTransaction,
	ReceiptStatusError,
	TransactionId,
} = require('@hashgraph/sdk');
const fs = require('fs');
const { ethers } = require('ethers');
const { expect } = require('chai');
const { describe, it, after } = require('mocha');

require('dotenv').config();

// Get operator from .env file
let operatorKey = PrivateKey.fromString(process.env.PRIVATE_KEY);
let operatorId = AccountId.fromString(process.env.ACCOUNT_ID);
const contractName = 'LAZYTokenCreator';
const env = process.env.ENVIRONMENT ?? null;

const addressRegex = /(\d+\.\d+\.[1-9]\d+)/i;

// reused variable
let contractId;
let contractAddress;
let iface;
let alicePK, aliceId;
let bobPk, bobId;
let tokenId;
let tokenIdSolidityAddr;
let tokenDecimal;
let contractFTSupply = 0;
let operatorAcctFTSupply = 0;
const amountForBob = 5;
let client;

describe('Deployment: ', function() {
	it('Should deploy the contract and setup conditions', async function() {
		if (contractName === undefined || contractName == null) {
			console.log('Environment required, please specify CONTRACT_NAME for ABI in the .env file');
			process.exit(1);
		}
		if (operatorKey === undefined || operatorKey == null || operatorId === undefined || operatorId == null) {
			console.log('Environment required, please specify PRIVATE_KEY & ACCOUNT_ID in the .env file');
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
		else if (env.toUpperCase() == 'LOCAL') {
			const node = { '127.0.0.1:50211': new AccountId(3) };
			client = Client.forNetwork(node).setMirrorNetwork('127.0.0.1:5600');
			console.log('testing in *LOCAL*');
			// baseUrl = 'http://localhost:5551';
			const rootId = AccountId.fromString('0.0.2');
			const rootKey = PrivateKey.fromString('302e020100300506032b65700422042091132178e72057a1d7528025956fe39b0b847f200ab59b2fdd367017f3087137');

			// create an operator account on the local node and use this for testing as operator
			client.setOperator(rootId, rootKey);
			operatorKey = PrivateKey.generateED25519();
			operatorId = await accountCreator(operatorKey, 1000);
		}
		else {
			console.log('ERROR: Must specify either MAIN or TEST or LOCAL as environment in .env file');
			return;
		}

		client.setOperator(operatorId, operatorKey);
		// deploy the contract
		console.log('\n-Using Operator:', operatorId.toString());

		const json = JSON.parse(fs.readFileSync(`./artifacts/contracts/${contractName}.sol/${contractName}.json`));

		// import ABI
		iface = new ethers.Interface(json.abi);

		const contractBytecode = json.bytecode;
		const gasLimit = 1200000;

		console.log('\n- Deploying contract...', contractName, '\n\tgas@', gasLimit);

		await contractDeployFcn(contractBytecode, gasLimit);

		console.log(`Contract created with ID: ${contractId} / ${contractAddress}`);

		console.log('\n-Testing:', contractName);
		// create Alice account
		alicePK = PrivateKey.generateED25519();
		aliceId = await accountCreator(alicePK, 10);
		console.log('Alice account ID:', aliceId.toString(), '\nkey:', alicePK.toString());

		// create Bob account
		bobPk = PrivateKey.generateED25519();
		bobId = await accountCreator(bobPk, 10);
		console.log('Bob account ID:', bobId.toString(), '\nkey:', bobPk.toString());

		expect(contractId.toString().match(addressRegex).length == 2).to.be.true;
	});
});

describe('Mint the fungible token', function() {
	it('Check only owner can call to mint', async function() {
		client.setOperator(aliceId, alicePK);
		let errorCount = 0;
		try {
			await mintFungible('Alice', 'AT', 'Memo', 10, 0, 0, 30);
		}
		catch (err) {
			errorCount++;
			expect(err instanceof StatusError).to.be.true;
		}
		expect(errorCount).to.be.equal(1);
	});


	it('Owner mints a FT', async function() {
		contractFTSupply = 2500000000;
		client.setOperator(operatorId, operatorKey);
		tokenDecimal = 1;
		await mintFungible('TestToken', 'TT', 'Test Token', contractFTSupply, tokenDecimal, contractFTSupply, 30);
		console.log('Token minted:', tokenId.toString());
		expect(tokenId.toString().match(addressRegex).length == 2).to.be.true;
	});

	it('Ensure the balance of FT is correct', async function() {
		const [contractTokenBal] = await getContractBalance(contractId, tokenId);
		expect(contractTokenBal == contractFTSupply).to.be.true;
	});
});

describe('Interaction: ', function() {
	it('Associate token to Operator, Alice & Bob', async function() {
		client.setOperator(operatorId, operatorKey);
		let result = await associateTokenToAccount(operatorId, operatorKey);
		expect(result).to.be.equal('SUCCESS');

		client.setOperator(aliceId, alicePK);
		result = await associateTokenToAccount(aliceId, alicePK);
		expect(result).to.be.equal('SUCCESS');

		client.setOperator(bobId, bobPk);
		result = await associateTokenToAccount(bobId, bobPk);
		expect(result).to.be.equal('SUCCESS');
	});

	it('Transfer Fungible using HTS', async function() {
		client.setOperator(operatorId, operatorKey);

		const amount = 10 * (10 ** tokenDecimal);
		contractFTSupply -= amount;
		operatorAcctFTSupply += amount;

		const result = await transferFungibleWithHTS(operatorId, amount);
		const [acctTokenBal] = await getAccountBalance(operatorId);

		expect(result).to.be.equal('SUCCESS');
		expect(acctTokenBal == operatorAcctFTSupply).to.be.true;
	});

	it('Execute Burn (via wipe)', async function() {
		client.setOperator(operatorId, operatorKey);

		const amount = 6 * (10 ** tokenDecimal);
		operatorAcctFTSupply -= amount;

		const result = await executeBurnWithWipe(amount);
		const [acctTokenBal] = await getAccountBalance(operatorId);

		expect(result).to.be.equal('SUCCESS');
		expect(acctTokenBal == operatorAcctFTSupply).to.be.true;
	});

	it('Check Allowance WL is empty', async function() {
		client.setOperator(operatorId, operatorKey);

		const wl = await getAllowanceWL();

		expect(wl.length).to.be.equal(0);
	});

	it('Add Alice to Allowance WL', async function() {
		client.setOperator(operatorId, operatorKey);

		await addAddressToWL(aliceId);
	});

	it('Verify the Allowance WL', async function() {
		client.setOperator(operatorId, operatorKey);

		const wl = await getAllowanceWL();

		expect(wl.length).to.be.equal(1);
		expect(wl[0].toUpperCase() == ('0x' + aliceId.toSolidityAddress()).toUpperCase()).to.be.true;

		let status = await checkIfWL(aliceId);
		expect(status[0]).to.be.true;

		status = await checkIfWL(operatorId);
		expect(status[0]).to.be.false;
	});

	it('Test unable to set allowance for operator as not on WL', async function() {
		client.setOperator(operatorId, operatorKey);

		let errorCount = 0;
		try {
			await approveAllowance(operatorId, amountForBob);
		}
		catch (err) {
			errorCount++;
			expect(err instanceof ReceiptStatusError).to.be.true;
		}
		expect(errorCount).to.be.equal(1);
	});

	it('Test unable to send using allowance if unset', async function() {
		client.setOperator(operatorId, operatorKey);

		// check allowance is zero
		const allowance = await checkAllowance(operatorId);
		expect(allowance).to.be.equal(0);

		// expect it to fail when used given 0
		let errorCount = 0;
		try {
			await testUsingApproval(contractId, bobId, 5, operatorId, operatorKey);
		}
		catch (err) {
			if (err instanceof ReceiptStatusError && (err.status._code == 7 || err.status._code == 292)) {
				errorCount++;
			}
		}
		expect(errorCount).to.be.equal(1);
	});

	it('Approve allowance for Alice', async function() {
		client.setOperator(operatorId, operatorKey);
		const result = await approveAllowance(aliceId, amountForBob);
		expect(result).to.be.equal('SUCCESS');
	});

	it('Test allowance for Alice to send FT to Bob', async function() {
		client.setOperator(aliceId, alicePK);

		contractFTSupply -= amountForBob * (10 ** tokenDecimal);

		const result = await testUsingApproval(contractId, bobId, amountForBob, aliceId, alicePK);
		const [acctTokenBal] = await getAccountBalance(bobId);

		expect(result).to.be.equal('SUCCESS');
		expect(acctTokenBal == (amountForBob * (10 ** tokenDecimal))).to.be.true;
	});

	it('Test send with allowance **used up** for Alice', async function() {
		client.setOperator(aliceId, alicePK);

		// check allowance is zero
		const allowance = await checkAllowance(operatorId);
		expect(allowance).to.be.equal(0);

		// expect it to fail when used given 0
		let errorCount = 0;
		try {
			await testUsingApproval(contractId, bobId, 5, aliceId, alicePK);
		}
		catch (err) {
			if (err instanceof ReceiptStatusError && (err.status._code == 7 || err.status._code == 292)) {
				errorCount++;
			}
		}
		expect(errorCount).to.be.equal(1);
	});

	it('Remove Alice from Allowance WL', async function() {
		client.setOperator(operatorId, operatorKey);

		const result = await removeAddressFromWL(aliceId);
		expect(result).to.be.equal('SUCCESS');
	});

	it('Send Hbar to the contract', async function() {
		client.setOperator(operatorId, operatorKey);

		const amount = 10;
		const result = await hbarTransferFcn(operatorId, operatorKey, contractId, amount);

		expect(result).to.be.equal('SUCCESS');

	});

	it('Retrieve Hbar with transfer', async function() {
		client.setOperator(operatorId, operatorKey);

		const amount = 4;
		const result = await transferHbarFromContract(amount);

		expect(result).to.be.equal('SUCCESS');
	});

	it('Check Alice can not execute sensitive calls', async function() {
		client.setOperator(aliceId, alicePK);

		let errorCount = 0;
		try {
			await transferFungibleWithHTS(aliceId, 1);
		}
		catch (err) {
			errorCount++;
		}
		try {
			await addAddressToWL(aliceId);
		}
		catch (err) {
			errorCount++;
		}
		try {
			await transferHbarFromContract(0.1);
		}
		catch (err) {
			errorCount++;
		}

		expect(errorCount).to.be.equal(3);

	});

	it('Check Alice *CAN* execute non-sensitive calls', async function() {
		client.setOperator(aliceId, alicePK);

		const wl = await getAllowanceWL();

		expect(wl.length).to.be.equal(0);

		const status = await checkIfWL(aliceId);
		expect(status[0]).to.be.false;

		const allowance = await checkAllowance(aliceId);
		expect(allowance).to.be.equal(0);
	});

	it('Check Bob *CAN* burn his tokens', async function() {
		client.setOperator(bobId, bobPk);

		const result = await executeBurnWithWipe(amountForBob * (10 ** tokenDecimal));
		const [acctTokenBal] = await getAccountBalance(bobId);

		expect(result).to.be.equal('SUCCESS');
		expect(acctTokenBal == 0).to.be.true;
	});

	after('Retrieve any hbar spent', async function() {
		// get Alice balance
		const [, aliceHbarBal] = await getAccountBalance(aliceId);
		// SDK transfer back to operator
		let receipt = await hbarTransferFcn(aliceId, alicePK, operatorId, aliceHbarBal.toBigNumber().minus(0.01));
		console.log('Clean-up -> Retrieve hbar from Alice');
		expect(receipt == 'SUCCESS').to.be.true;

		// get bob balance
		const [, bobHbarBal] = await getAccountBalance(aliceId);
		// SDK transfer back to operator
		receipt = await hbarTransferFcn(bobId, bobPk, operatorId, bobHbarBal.toBigNumber().minus(0.01));
		console.log('Clean-up -> Retrieve hbar from Bob');
		expect(receipt == 'SUCCESS').to.be.true;

		client.setOperator(operatorId, operatorKey);
		let [, contractHbarBal] = await getContractBalance(contractId);
		const result = await transferHbarFromContract(Number(contractHbarBal.toTinybars()), HbarUnit.Tinybar);
		console.log('Clean-up -> Retrieve hbar from Contract');
		[, contractHbarBal] = await getContractBalance(contractId);
		console.log('Contract ending hbar balance:', contractHbarBal.toString());
		expect(result).to.be.equal('SUCCESS');
	});
});

/**
 * Helper function to deploy the contract
 * @param {string} bytecode bytecode from compiled SOL file
 * @param {number} gasLim gas limit as a number
 */
async function contractDeployFcn(bytecode, gasLim) {
	const contractCreateTx = await new ContractCreateFlow()
		.setBytecode(bytecode)
		.setGas(gasLim);
	const contractCreateSubmit = await contractCreateTx.execute(client);
	const contractCreateRx = await contractCreateSubmit.getReceipt(client);
	contractId = contractCreateRx.contractId;
	contractAddress = contractId.toSolidityAddress();
}


/**
 * Helper function for calling the contract methods
 * @param {ContractId} cId the contract to call
 * @param {number | Long.Long} gasLim the max gas
 * @param {string} fcnName name of the function to call
 * @param {Object[]} params the function arguments
 * @param {string | number | Hbar | Long.Long | BigNumber} amountHbar the amount of hbar to send in the methos call
 * @returns {[TransactionReceipt, any, TransactionRecord]} the transaction receipt and any decoded results
 */
async function contractExecuteFcn(cId, gasLim, fcnName, params, amountHbar = 0) {
	const encodedCommand = iface.encodeFunctionData(fcnName, params);
	// convert to UINT8ARRAY after stripping the '0x'
	const contractExecuteTx = await new ContractExecuteTransaction()
		.setContractId(cId)
		.setGas(gasLim)
		.setFunctionParameters(Buffer.from(encodedCommand.slice(2), 'hex'))
		.setPayableAmount(amountHbar)
		.execute(client);

	const contractExecuteRx = await contractExecuteTx.getReceipt(client);
	// get the results of the function call;
	const record = await contractExecuteTx.getRecord(client);

	let contractResults;
	try {
		contractResults = iface.decodeFunctionResult(fcnName, record.contractFunctionResult.bytes);
	}
	catch (e) {
		if (e.data == '0x') {
			console.log(contractExecuteTx.transactionId.toString(), 'No data returned from contract - check the call');
		}
		else {
			console.log('Error', contractExecuteTx.transactionId.toString(), e);
			console.log(iface.parseError(record.contractFunctionResult.bytes));
		}
	}
	// console.log('Contract Results:', contractResults);
	return [contractExecuteRx, contractResults, record];
}

/**
 * Helper function to create new accounts
 * @param {PrivateKey} privateKey new accounts private key
 * @param {string | number} initialBalance initial balance in hbar
 * @returns {AccountId} the nrewly created Account ID object
 */
async function accountCreator(privateKey, initialBalance) {
	const response = await new AccountCreateTransaction()
		.setInitialBalance(new Hbar(initialBalance))
		.setMaxAutomaticTokenAssociations(10)
		.setKey(privateKey.publicKey)
		.execute(client);
	const receipt = await response.getReceipt(client);
	return receipt.accountId;
}

/**
 * Helper function to retrieve accoutn balance
 * @param {AccountId} acctId the account to check
 * @returns {[number, Hbar]} balance of the FT token (without decimals) and balance of Hbar in account as array
 */
async function getAccountBalance(acctId) {

	const query = new AccountInfoQuery()
		.setAccountId(acctId);

	const info = await query.execute(client);

	let balance;
	const tokenMap = info.tokenRelationships;
	// This is in process of deprecation sadly so may need to be adjusted.
	const tokenBal = tokenMap.get(tokenId.toString());
	if (tokenBal) {
		balance = tokenBal.balance;
	}
	else {
		balance = -1;
	}


	return [balance, info.balance];
}

/**
 * Helper function to get the FT & hbar balance of the contract
 * @returns {[number | Long.Long, Hbar]} The balance of the FT (without decimals)  & Hbar at the SC
 */
async function getContractBalance() {

	const query = new ContractInfoQuery()
		.setContractId(contractId);

	const info = await query.execute(client);

	let balance;

	const tokenMap = info.tokenRelationships;
	const tokenBal = tokenMap.get(tokenId.toString());
	if (tokenBal) {
		balance = tokenBal.balance;
	}
	else {
		balance = -1;
	}

	return [balance, info.balance];
}

/**
 * Helper function to send hbar
 * @param {AccountId} sender sender address
 * @param {AccountId} receiver receiver address
 * @param {string | number | BigNumber} amount the amounbt to send
 * @returns {any} expect a string of SUCCESS
 */
async function hbarTransferFcn(sender, senderPK, receiver, amount) {
	const transferTx = new TransferTransaction()
		.addHbarTransfer(sender, -amount)
		.addHbarTransfer(receiver, amount)
		.freezeWith(client);
	const transferSign = await transferTx.sign(senderPK);
	const transferSubmit = await transferSign.execute(client);
	const transferRx = await transferSubmit.getReceipt(client);
	return transferRx.status.toString();
}

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
async function mintFungible(tokenName, tokenSymbol, tokenMemo, tokenInitalSupply, decimal, tokenMaxSupply, payment) {
	const gasLim = 800000;
	// call associate method
	const params = new ContractFunctionParameters()
		.addString(tokenName)
		.addString(tokenSymbol)
		.addString(tokenMemo)
		.addUint256(tokenInitalSupply)
		.addUint256(decimal)
		.addUint32(tokenMaxSupply);

	const [ , , createTokenRecord] = await contractExecuteFcn(contractId, gasLim, 'createFungibleWithBurn', params, payment);

	tokenIdSolidityAddr = createTokenRecord.contractFunctionResult.getAddress(0);
	tokenId = TokenId.fromSolidityAddress(tokenIdSolidityAddr);
}

/**
 * Helper method for token association
 * @param {AccountId} account
 * @param {PrivateKey} key
 * @returns {any} expected to be a string 'SUCCESS' implioes it worked
 */
async function associateTokenToAccount(account, key) {
	// now associate the token to the operator account
	const associateToken = await new TokenAssociateTransaction()
		.setAccountId(account)
		.setTokenIds([tokenId])
		.freezeWith(client)
		.sign(key);

	const associateTokenTx = await associateToken.execute(client);
	const associateTokenRx = await associateTokenTx.getReceipt(client);

	const associateTokenStatus = associateTokenRx.status;

	return associateTokenStatus.toString();
}

/**
 * Helper method to transfer FT using HTS
 * @param {AccountId} receiver
 * @param {number} amount amount of the FT to transfer as 'whole units' decimals added in the method
 * @returns {any} expected to be a string 'SUCCESS' implioes it worked
 */
async function transferFungibleWithHTS(receiver, amount) {

	const gasLim = 600000;
	const params = new ContractFunctionParameters()
		.addAddress(tokenIdSolidityAddr)
		.addAddress(receiver.toSolidityAddress())
		.addInt64(amount);
	const [tokenTransferRx, , ] = await contractExecuteFcn(contractId, gasLim, 'transferHTS', params);
	const tokenTransferStatus = tokenTransferRx.status;

	return tokenTransferStatus.toString();
}

async function executeBurnWithWipe(amount) {
	const gasLim = 500000;
	const params = new ContractFunctionParameters()
		.addAddress(tokenIdSolidityAddr)
		.addUint32(amount);
	const [burnTxRx, , ] = await contractExecuteFcn(contractId, gasLim, 'burn', params);
	return burnTxRx.status.toString();
}

/**
 * Helper method to return the array of addresses in the WL
 */
async function getAllowanceWL() {
	// generate function call with function name and parameters
	const functionCallAsUint8Array = iface.encodeFunctionData('getAllowanceWhitelist', []);
	// query the contract
	const contractCall = await new ContractCallQuery()
		.setContractId(contractId)
		.setFunctionParameters(functionCallAsUint8Array)
		.setMaxQueryPayment(new Hbar(2))
		.setGas(100000)
		.execute(client);

	const results = iface.parseCallResult(contractCall.bytes);
	const wlAccountsEVM = results.wl;

	return wlAccountsEVM;
}

async function transferHbarFromContract(amount, units = HbarUnit.Hbar) {
	const gasLim = 400000;
	const params = new ContractFunctionParameters()
		.addAddress(operatorId.toSolidityAddress())
		.addUint256(new Hbar(amount, units).toTinybars());
	const [callHbarRx, , ] = await contractExecuteFcn(contractId, gasLim, 'transferHbar', params);
	return callHbarRx.status.toString();
}

async function addAddressToWL(address) {
	const gasLim = 400000;
	const params = new ContractFunctionParameters()
		.addAddress(address.toSolidityAddress());
	const [callHbarRx, , ] = await contractExecuteFcn(contractId, gasLim, 'addAllowanceWhitelist', params);
	return callHbarRx.status.toString();
}

async function checkIfWL(address) {
	const functionCallAsUint8Array = iface.encodeFunctionData('isAddressWL', [address.toSolidityAddress()]);
	const contractCall = await new ContractCallQuery()
		.setContractId(contractId)
		.setFunctionParameters(functionCallAsUint8Array)
		.setMaxQueryPayment(new Hbar(2))
		.setGas(100000)
		.execute(client);

	return await iface.parseCallResult(contractCall.bytes);
}

/**
 * Helper method to check the allowance on an account
 * @param {AccountId} spender check allowance for this potential spender
 * @returns {Number} the allowance of the FT for the designated spender
 */
async function checkAllowance(spender) {
	const gasLim = 400000;
	const params = new ContractFunctionParameters()
		.addAddress(tokenIdSolidityAddr)
		.addAddress(spender.toSolidityAddress());
	const [, contractOutput] = await contractExecuteFcn(contractId, gasLim, 'checkAllowance', params);

	return Number(contractOutput.amount);
}

/**
 * Function to test using approvals granted
 * @param {AccountId} from The account that owns the tokens
 * @param {AccountId} to The account receiving the tokens
 * @param {Number} amount amount of token to send
 * @param {AccountId} authSpender the account ofd the authorised spender who must create the tx ID & sign
 * @param {PrivateKey} authSpenderKey the key to sign with.
 */
async function testUsingApproval(from, to, amount, authSpender, authSpenderKey) {
	const transferTx = new TransferTransaction()
		.addApprovedTokenTransfer(tokenId, from, -amount * (10 ** tokenDecimal))
		.addTokenTransfer(tokenId, to, amount * (10 ** tokenDecimal))
		// signing account must generate the tx ID (currently undocumented - raised with hedera)
		.setTransactionId(TransactionId.generate(authSpender))
		.setTransactionMemo('Spending with allowances')
		.freezeWith(client);
	const transferSign = await transferTx.sign(authSpenderKey);
	const transferSubmit = await transferSign.execute(client);
	const transferRx = await transferSubmit.getReceipt(client);
	return transferRx.status.toString();
}

async function approveAllowance(spender, amount) {
	const gasLim = 800000;
	const params = new ContractFunctionParameters()
		.addAddress(tokenIdSolidityAddr)
		.addAddress(spender.toSolidityAddress())
		.addUint256(amount * (10 ** tokenDecimal));
	const [callHbarRx, , ] = await contractExecuteFcn(contractId, gasLim, 'approveAllowance', params);
	return callHbarRx.status.toString();

}

async function removeAddressFromWL(address) {
	const gasLim = 400000;
	const params = new ContractFunctionParameters()
		.addAddress(address.toSolidityAddress());
	const [callHbarRx, , ] = await contractExecuteFcn(contractId, gasLim, 'removeAllowanceWhitelist', params);
	return callHbarRx.status.toString();
}