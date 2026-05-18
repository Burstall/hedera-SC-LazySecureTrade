const {
	AccountCreateTransaction,
	Hbar,
	PrivateKey,
	TokenCreateTransaction,
	TokenType,
	TransferTransaction,
	AccountAllowanceApproveTransaction,
	NftId,
	TokenMintTransaction,
	CustomRoyaltyFee,
	CustomFixedFee,
	TokenSupplyType,
	HbarUnit,
	TokenAssociateTransaction,
	// eslint-disable-next-line no-unused-vars
	Client,
	AccountId,
} = require('@hashgraph/sdk');

/**
 * Coerce a sender/receiver identifier to an AccountId. The SDK's transfer APIs
 * only accept `AccountId | string`; passing a ContractId/TokenId object falls
 * into the internal `AccountId.fromString(obj)` path which then crashes on
 * `text.startsWith(...)`. Hedera shares the entity-ID namespace across
 * account/contract/token, so the string form round-trips cleanly.
 */
function _toAccountId(id) {
	if (id instanceof AccountId) return id;
	if (typeof id === 'string') return AccountId.fromString(id);
	if (id && typeof id.toString === 'function') return AccountId.fromString(id.toString());
	throw new TypeError(`Cannot coerce ${typeof id} to AccountId`);
}

/**
 * Helper function to create new accounts
 * @param {Client} client Hedera Client
 * @param {PrivateKey} privateKey new accounts private key
 * @param {string | number} initialBalance initial balance in hbar
 * @returns {AccountId} the newly created Account ID object
 */
async function accountCreator(
	client,
	privateKey,
	initialBalance,
	maxTokenAssociations = 0,
) {
	const response = await new AccountCreateTransaction()
		.setInitialBalance(new Hbar(initialBalance))
		.setMaxAutomaticTokenAssociations(maxTokenAssociations)
		.setKey(privateKey.publicKey)
		.execute(client);
	const receipt = await response.getReceipt(client);
	return receipt.accountId;
}

/**
 * Helper function to create new fungible tokens
 * @param {Client} client Hedera Client
 * @param {AccountId} acct
 * @param {PrivateKey} supplyKey (if not provided, a new one will be generated)
 * @param {string | number} amount
 * @param {string} name
 * @param {string} symbol
 * @param {number} decimal
 * @returns {[string, TokenId]} status and token ID object
 */
// eslint-disable-next-line no-unused-vars
async function mintFT(
	client,
	acct,
	supplyKey = null,
	amount,
	name,
	symbol,
	decimal,
) {
	if (!supplyKey) supplyKey = PrivateKey.generateED25519();
	const tokenCreateTx = new TokenCreateTransaction()
		.setTokenName(name)
		.setTokenSymbol(symbol)
		.setTokenType(TokenType.FungibleCommon)
		.setDecimals(decimal)
		.setInitialSupply(amount)
		.setTreasuryAccountId(acct)
		.setSupplyKey(supplyKey)
		.freezeWith(client);

	const tokenCreateSubmit = await tokenCreateTx.execute(client);
	const tokenCreateRx = await tokenCreateSubmit.getReceipt(client);
	return [tokenCreateRx.status.toString(), tokenCreateRx.tokenId];
}

/**
 * Helper function to send FTs
 */
async function sendFT(client, FTTokenId, amount, sender, receiver, memo) {
	const transferTx = new TransferTransaction()
		.setTransactionMemo(memo)
		.addTokenTransfer(FTTokenId, receiver, amount)
		.addTokenTransfer(FTTokenId, sender, -amount);

	const txResp = await transferTx.freezeWith(client).execute(client);

	const transferRx = await txResp.getReceipt(client);
	return transferRx.status.toString();
}

/**
 * Helper function to send serials of the minted NFT by Alice for testing
 * Assumes sender minted the NFT/no royalty issues
 * @param {Client} client
 * @param {AccountId} sender
 * @param {AccountId} reciever
 * @param {TokenId} NFTTokenId
 * @param {Number[]} serials
 * @returns {String} status of the transaction
 */
async function sendNFT(client, sender, reciever, NFTTokenId, serials) {
	// Coerce ContractId/TokenId/string → AccountId — same shape as sendHbar.
	// addNftTransfer's internal AccountId.fromString blows up on raw ContractId.
	const senderAcc = _toAccountId(sender);
	const receiverAcc = _toAccountId(reciever);

	// use inner/outer loop to maxSupply but in batches of 10
	let batch = 0;

	for (let outer = 0; outer < serials.length; outer += 10) {
		const transferTx = new TransferTransaction().setTransactionMemo(
			`TestFramework test NFT transfer (batch ${batch++})`,
		);
		for (let i = 0; i < 10 && outer + i < serials.length; i++) {
			const nft = new NftId(NFTTokenId, serials[outer + i]);
			transferTx.addNftTransfer(nft, senderAcc, receiverAcc);
		}

		const txResp = await transferTx.freezeWith(client).execute(client);

		const transferRx = await txResp.getReceipt(client);
		if (transferRx.status.toString() != 'SUCCESS') {
			return transferRx.status.toString();
		}
	}

	return 'SUCCESS';
}

/**
 * Helper function to send serials of the minted NFT to Alice for testing
 * @param {Client} client
 * @param {AccountId} sender
 * @param {AccountId} receiver
 * @param {PrivateKey} receiverKey
 * @param {TokenId} NFTTokenId
 * @param {Number[]} serials
 * @returns {String} status of the transaction
 */
async function sendNFTDefeatRoyalty(
	client,
	sender,
	receiver,
	receiverKey,
	NFTTokenId,
	serials,
) {
	const transferTx = new TransferTransaction()
		.setTransactionMemo('TestFramework test NFT transfer')
		.addHbarTransfer(receiver, new Hbar(-1, HbarUnit.Tinybar))
		.addHbarTransfer(sender, new Hbar(1, HbarUnit.Tinybar));

	for (let s = 0; s < serials.length; s++) {
		const nft = new NftId(NFTTokenId, serials[s]);
		transferTx.addNftTransfer(nft, sender, receiver);
	}

	const frozenTx = await transferTx.freezeWith(client);

	const signedTx = await frozenTx.sign(receiverKey);
	const txResp = await signedTx.execute(client);

	const transferRx = await txResp.getReceipt(client);
	return transferRx.status.toString();
}

async function sendNFTWithAllowance(
	client,
	NFTTokenId,
	serials,
	sender,
	receiver,
) {
	const transferTx = new TransferTransaction().setTransactionMemo(
		'TestFramework test NFT transfer (with Allowance)',
	);

	for (let s = 0; s < serials.length; s++) {
		const nft = new NftId(NFTTokenId, serials[s]);
		transferTx.addApprovedNftTransfer(nft, sender[s], receiver[s]);
	}

	const txResp = await transferTx.freezeWith(client).execute(client);

	const transferRx = await txResp.getReceipt(client);
	return transferRx.status.toString();
}

/**
 * Set all allowance for an NFT to contract
 * you can do multiples in a single tx
 * @param {Client} client
 * @param {TokenId[]} _tokenIdList
 * @param {AccountId} _ownerId
 * @param {AccountId} _spenderId
 * @returns {String} status of the transaction
 */
async function setNFTAllowanceAll(client, _tokenIdList, _ownerId, _spenderId) {
	// use an inner/outer loop to maxSupply but in batches of 20
	let batch = 0;
	for (let outer = 0; outer < _tokenIdList.length; outer += 20) {
		const approvalTx =
			new AccountAllowanceApproveTransaction().approveTokenNftAllowanceAllSerials(
				_tokenIdList[outer],
				_ownerId,
				_spenderId,
			);
		for (let i = 1; i < 20 && outer + i < _tokenIdList.length; i++) {
			approvalTx.approveTokenNftAllowanceAllSerials(
				_tokenIdList[outer + i],
				_ownerId,
				_spenderId,
			);
		}
		approvalTx.setTransactionMemo(
			`NFT  (all serials) allowance (batch ${batch++})`,
		);
		approvalTx.freezeWith(client);
		const exResp = await approvalTx.execute(client);
		const receipt = await exResp.getReceipt(client).catch((e) => {
			console.log(e);
			console.log('Allowance set **FAILED*');
		});
		if (receipt?.status.toString() != 'SUCCESS') {
			console.log('Allowance set **FAILED*', receipt);
			return 'FAILED';
		}
		console.log(
			'Allowance for token: ',
			_tokenIdList[outer].toString(),
			receipt.status.toString(),
		);
	}

	return 'SUCCESS';
}

/**
 * Remove NFT allowances that have been set.
 *
 * AccountAllowanceApproveTransaction requires the OWNER's signature to
 * modify the owner's own allowances. If the client's operator is not the
 * owner (e.g. cleanup is being driven by a payer that's funding gas), pass
 * the owner's PrivateKey(s) via `signerKeys` so we can sign explicitly
 * before execution. Backward-compatible: existing callers that switch the
 * client operator to the owner can leave signerKeys empty.
 *
 * @param {*} client
 * @param {*} _allowanceList an object of type {tokenId, owner, spender}
 * @param {PrivateKey[]} [signerKeys=[]] additional signers for the tx
 * @returns {String} status of the transaction
 */
async function clearNFTAllowances(client, _allowanceList, signerKeys = []) {
	// use an inner/outer loop to maxSupply but in batches of 20
	let batch = 0;
	const _tokenIdList = [];
	for (let outer = 0; outer < _allowanceList.length; outer += 20) {
		const approvalTx =
			new AccountAllowanceApproveTransaction().deleteTokenNftAllowanceAllSerials(
				_allowanceList[outer].tokenId,
				_allowanceList[outer].owner,
				_allowanceList[outer].spender,
			);
		_tokenIdList.push(
			`NFT-token:${_allowanceList[outer].tokenId.toString()}-spender:${_allowanceList[
				outer
			].spender.toString()}}`,
		);
		for (let i = 1; i < 20 && outer + i < _allowanceList.length; i++) {
			approvalTx.deleteTokenNftAllowanceAllSerials(
				_allowanceList[outer + i].tokenId,
				_allowanceList[outer + i].owner,
				_allowanceList[outer + i].spender,
			);
			_tokenIdList.push(
				`NFT-token:${_allowanceList[outer + i].tokenId.toString()}-spender:${_allowanceList[
					outer + i
				].spender.toString()}`,
			);
		}
		approvalTx.setTransactionMemo(
			`NFT  (all serials) allowance deletion (batch ${batch++})`,
		);
		approvalTx.freezeWith(client);
		let toExecute = approvalTx;
		for (const key of signerKeys) {
			toExecute = await toExecute.sign(key);
		}
		const exResp = await toExecute.execute(client);
		const receipt = await exResp.getReceipt(client).catch((e) => {
			console.log(e);
			console.log('Allowance set **FAILED*');
		});
		if (receipt?.status.toString() != 'SUCCESS') {
			console.log('Allowance set **FAILED*', receipt);
			return 'FAILED';
		}
		/* console.log(
			'Allowance for token: ',
			_tokenIdList,
			receipt.status.toString(),
		);
		*/
	}

	return 'SUCCESS';
}

/**
 * Remove FT allowances that have been set. See clearNFTAllowances for
 * the rationale on `signerKeys`.
 * @param {*} client
 * @param {*} _allowanceList an object of type {tokenId, owner, spender}
 * @param {PrivateKey[]} [signerKeys=[]] additional signers for the tx
 */
async function clearFTAllowances(client, _allowanceList, signerKeys = []) {
	// use an inner/outer loop to maxSupply but in batches of 20
	let batch = 0;
	const _tokenIdList = [];
	const listToProcess = [];

	// get uniqe list from _allowanceList and put into listToProcess
	const hashList = [];
	for (let i = 0; i < _allowanceList.length; i++) {
		const item = _allowanceList[i];
		const hash = `${item.tokenId.toString()}-${item.spender.toString()}-${item.owner.toString()}`;
		if (!hashList.includes(hash)) {
			console.log('Adding allowance to clear', hash);
			hashList.push(hash);
			listToProcess.push(item);
		}
		else {
			console.log('Duplicate allowance', hash);
		}
	}

	for (let outer = 0; outer < listToProcess.length; outer += 20) {
		const approvalTx =
			new AccountAllowanceApproveTransaction().approveTokenAllowance(
				listToProcess[outer].tokenId,
				listToProcess[outer].owner,
				listToProcess[outer].spender,
				0,
			);
		_tokenIdList.push(
			`FT-Token:${listToProcess[outer].tokenId.toString()}-spender:${listToProcess[
				outer
			].spender.toString()}`,
		);
		for (let i = 1; i < 20 && outer + i < listToProcess.length; i++) {
			approvalTx.approveTokenAllowance(
				listToProcess[outer + i].tokenId,
				listToProcess[outer + i].owner,
				listToProcess[outer + i].spender,
				0,
			);
			_tokenIdList.push(
				`FT-Token:${listToProcess[outer + i].tokenId.toString()}-spender:${listToProcess[
					outer + i
				].spender.toString()}`,
			);
		}
		approvalTx.setTransactionMemo(`FT allowance reset (batch ${batch++})`);
		approvalTx.freezeWith(client);
		let toExecute = approvalTx;
		for (const key of signerKeys) {
			toExecute = await toExecute.sign(key);
		}
		const exResp = await toExecute.execute(client);
		const receipt = await exResp.getReceipt(client).catch((e) => {
			console.log(e);
			console.log('Allowance set **FAILED*');
		});
		if (receipt?.status.toString() != 'SUCCESS') {
			console.log('Allowance set **FAILED*', receipt);
			return 'FAILED';
		}
		console.log(
			'Allowance for token: ',
			_tokenIdList,
			receipt.status.toString(),
		);
	}

	return 'SUCCESS';
}

/**
 * Generic helper to clear hbar allowances
 * @param {*} client
 * @param {*} _allowanceList an object of type {owner, spender}
 */
async function clearHbarAllowances(client, _allowanceList) {
	// use an inner/outer loop to maxSupply but in batches of 20
	let batch = 0;
	for (let outer = 0; outer < _allowanceList.length; outer += 20) {
		const approvalTx =
			new AccountAllowanceApproveTransaction().approveHbarAllowance(
				_allowanceList[outer].owner,
				_allowanceList[outer].spender,
				new Hbar(0, HbarUnit.Tinybar),
			);
		for (let i = 1; i < 20 && outer + i < _allowanceList.length; i++) {
			approvalTx.approveHbarAllowance(
				_allowanceList[outer + i].owner,
				_allowanceList[outer + i].spender,
				new Hbar(0, HbarUnit.Tinybar),
			);
		}
		approvalTx.setTransactionMemo(`Hbar allowance reset (batch ${batch++})`);
		approvalTx.freezeWith(client);
		const exResp = await approvalTx.execute(client);
		const receipt = await exResp.getReceipt(client).catch((e) => {
			console.log(e);
			console.log('Allowance set **FAILED*');
		});
		if (receipt?.status.toString() != 'SUCCESS') {
			console.log('Allowance set **FAILED*', receipt);
			return 'FAILED';
		}
	}

	return 'SUCCESS';
}

/**
 * Set allowance for the list of serials to addresses
 * @param {Client} client
 * @param {TokenId} _tokenId
 * @param {AccountId} _ownerId
 * @param {AccountId[]} _spenderIdArray
 * @param {Number[]} _serialArray
 * @returns {String} status of the transaction
 */
async function setNFTAllowance(
	client,
	_tokenId,
	_ownerId,
	_spenderIdArray,
	_serialArray,
) {
	if (_spenderIdArray.length != _serialArray.length) {
		console.log('ERROR: Spender and Serials must be the same length');
		return 'ERROR';
	}
	const approvalTx = new AccountAllowanceApproveTransaction();

	for (let i = 0; i < _spenderIdArray.length; i++) {
		approvalTx.approveTokenNftAllowance(
			new NftId(_tokenId, _serialArray[i]),
			_ownerId,
			_spenderIdArray[i],
		);
	}

	approvalTx.freezeWith(client);
	const exResp = await approvalTx.execute(client);
	const receipt = await exResp.getReceipt(client).catch((e) => {
		console.log(e);
		console.log('Allowance set **FAILED*');
	});

	console.log(
		'Allowance for token: ',
		_tokenId.toString(),
		_serialArray,
		receipt.status.toString(),
	);
	return receipt.status.toString();
}

/**
 * setup an FT allowance
 * @param {Client} client
 * @param {TokenId} _tokenId token to approve
 * @param {AccountId} _ownerId account owning the token
 * @param {*} _spenderId the spender to authorize
 * @param {Number} amount amount to approve
 */
async function setFTAllowance(client, _tokenId, _ownerId, _spenderId, amount) {
	const approvalTx =
		new AccountAllowanceApproveTransaction().approveTokenAllowance(
			_tokenId,
			_ownerId,
			_spenderId,
			amount,
		);
	approvalTx.freezeWith(client);
	const exResp = await approvalTx.execute(client);
	const receipt = await exResp.getReceipt(client).catch((e) => {
		console.log(e);
		console.log('FT Allowance set **FAILED**');
	});

	console.log(
		'FT Allowance:',
		_tokenId.toString(),
		amount,
		'owner',
		_ownerId.toString(),
		'for',
		_spenderId.toString(),
		receipt?.status.toString(),
	);
	return receipt.status.toString();
}

/**
 * setup an HBAR allowance
 * @param {Client} client
 * @param {AccountId} _ownerId account owning the hbar
 * @param {AccountId} _spenderId the spender to authorize
 * @param {Number} amount amount to approve
 * @param {HbarUnit} hbarUnit defaults to Tinybar
 * @returns {String} status of the transaction
 */
async function setHbarAllowance(client, _ownerId, _spenderId, amount, hbarUnit = HbarUnit.Tinybar) {
	const approvalTx =
		new AccountAllowanceApproveTransaction().approveHbarAllowance(
			_ownerId,
			_spenderId,
			new Hbar(amount, hbarUnit),
		);
	approvalTx.freezeWith(client);
	const exResp = await approvalTx.execute(client);
	const receipt = await exResp.getReceipt(client).catch((e) => {
		console.log(e);
		console.log('HBAR Allowance set **FAILED**');
	});

	console.log(
		'HBAR Allowance:',
		amount,
		'owner',
		_ownerId.toString(),
		'for',
		_spenderId.toString(),
		receipt?.status.toString(),
	);
	return receipt.status.toString();
}

/**
 * Helper to send hbar
 * @param {Client} client
 * @param {AccountId} _sender
 * @param {AccountId} _receiver
 * @param {Number} _amt
 * @param {HbarUnit} hbarUnit
 * @returns {String} status of the transaction
 */
async function sendHbar(
	client,
	_sender,
	_receiver,
	_amt,
	hbarUnit = HbarUnit.Tinybar,
) {
	const sender = _toAccountId(_sender);
	const receiver = _toAccountId(_receiver);
	const transferTx = await new TransferTransaction()
		.addHbarTransfer(receiver, new Hbar(_amt, hbarUnit))
		.addHbarTransfer(sender, new Hbar(_amt, hbarUnit).negated())
		.freezeWith(client)
		.execute(client);

	const transferRx = await transferTx.getReceipt(client);

	return transferRx.status.toString();
}

/**
 * Helper method for token association
 * @param {Client} client
 * @param {AccountId} account
 * @param {PrivateKey} key
 * @param {TokenId} tokenToAssociate
 * @returns {any} expected to be a string 'SUCCESS' implioes it worked
 */
async function associateTokenToAccount(client, account, key, tokenToAssociate) {
	return associateTokensToAccount(client, account, key, [tokenToAssociate]);
}

/**
 * Helper method for token association
 * @param {Client} client
 * @param {AccountId} account
 * @param {PrivateKey} key
 * @param {[TokenId]} tokensToAssociate an array of TokenIds to associate
 * @returns {any} expected to be a string 'SUCCESS' implioes it worked
 */
async function associateTokensToAccount(
	client,
	account,
	key,
	tokensToAssociate,
) {
	// now associate the token to the operator account
	const associateToken = await new TokenAssociateTransaction()
		.setAccountId(account)
		.setTokenIds(tokensToAssociate)
		.freezeWith(client)
		.sign(key);

	const associateTokenTx = await associateToken.execute(client);
	const associateTokenRx = await associateTokenTx.getReceipt(client);

	const associateTokenStatus = associateTokenRx.status;

	return associateTokenStatus.toString();
}

/**
 * Helper function to mint an NFT and a serial on to that token
 * Using royalties to test the (potentially) more complicated case
 * @param {Client} client
 * @param {AccountId} minterId
 * @param {string} name
 * @param {string} symbol
 * @param {number} maxSupply the max supply of the NFT and the number it will mint (default: 10)
 * @param {number} maxTxFee the max fee for the transaction (default: 50)
 * @param {PrivateKey} supplyKey (if not provided, a new one will be generated)
 * @param {CustomRoyaltyFee} fee (if not provided, a new one will be generated pointing to the minter)
 * @param {boolean} noFallback (if true, will skip the fallback fee but not the royalty fee)
 * @param {boolean} skipFee (if true, will skip the royalty fee)
 */
async function mintNFT(
	client,
	minterId,
	name,
	symbol,
	maxSupply = 10,
	maxTxFee = 50,
	supplyKey = null,
	fee = null,
	noFallback = false,
	skipFee = false,
	// Number of serials to pre-mint at creation. Defaults to maxSupply so
	// existing callers (LST tests etc.) keep their current behaviour. Pass
	// a smaller value to leave headroom for runtime mintAdditionalSerial.
	initialMintCount = null,
) {
	if (initialMintCount === null) initialMintCount = maxSupply;
	if (!supplyKey) supplyKey = PrivateKey.generateED25519();

	if (!fee) {
		fee = new CustomRoyaltyFee()
			.setNumerator(2 * 100)
			.setDenominator(10000)
			.setFeeCollectorAccountId(minterId);

		if (!noFallback) {
			fee.setFallbackFee(new CustomFixedFee().setHbarAmount(new Hbar(5)));
		}
	}

	const tokenCreateTx = new TokenCreateTransaction()
		.setTokenType(TokenType.NonFungibleUnique)
		.setTokenName(name)
		.setTokenSymbol(symbol)
		.setInitialSupply(0)
		.setMaxSupply(maxSupply)
		.setSupplyType(TokenSupplyType.Finite)
		.setTreasuryAccountId(minterId)
		.setAutoRenewAccountId(minterId)
		.setSupplyKey(supplyKey)
		.setMaxTransactionFee(new Hbar(maxTxFee, HbarUnit.Hbar));

	if (!skipFee) {
		tokenCreateTx.setCustomFees([fee]);
	}

	const executionResponse = await tokenCreateTx.execute(client);

	/* Get the receipt of the transaction */
	const createTokenRx = await executionResponse
		.getReceipt(client)
		.catch((e) => {
			console.log(e);
			console.log('Token Create **FAILED*');
		});

	/* Get the token ID from the receipt */
	const NFTTokenId = createTokenRx.tokenId;

	// Pre-mint `initialMintCount` serials in batches of 10. Callers can
	// leave headroom under maxSupply for runtime mintAdditionalSerial.
	if (initialMintCount === 0) {
		return ['SUCCESS', NFTTokenId];
	}
	let mintRx;
	for (let outer = 0; outer < initialMintCount; outer += 10) {
		const tokenMintTx = new TokenMintTransaction()
			.setTokenId(NFTTokenId)
			.setMaxTransactionFee(new Hbar(maxTxFee, HbarUnit.Hbar));
		for (let i = 0; i < 10 && outer + i < initialMintCount; i++) {
			tokenMintTx.addMetadata(
				Buffer.from(
					'ipfs://bafybeihbyr6ldwpowrejyzq623lv374kggemmvebdyanrayuviufdhi6xu/metadata.json',
				),
			);
		}

		tokenMintTx.freezeWith(client);
		const tokenMintSubmit = await (
			await tokenMintTx.sign(supplyKey)
		).execute(client);
		mintRx = await tokenMintSubmit.getReceipt(client);
	}

	return [mintRx.status.toString(), NFTTokenId];
}

/**
 * Spend FTs on behalf of the sender
 * @param {Client} client
 * @param {TokenId} FTTokenId
 * @param {number} amount
 * @param {AccountId} sender
 * @param {AccountId} receiver
 * @returns {String} status of the transaction
 */
async function sendFTWithAllowance(
	client,
	FTTokenId,
	amount,
	sender,
	receiver,
	memo,
) {
	const transferTx = new TransferTransaction()
		.setTransactionMemo(memo)
		.addTokenTransfer(FTTokenId, receiver, amount)
		.addApprovedTokenTransfer(FTTokenId, sender, -amount);

	const txResp = await transferTx.freezeWith(client).execute(client);

	const transferRx = await txResp.getReceipt(client);
	return transferRx.status.toString();
}

/**
 * Mint one additional serial to an existing NFT collection. The treasury
 * must be `client.operator` (or the supply key must be a multisig that
 * the operator can sign on behalf of). Uses the existing supply key from
 * the original mint so reused-collection tests can append serials.
 * @param {Client} client
 * @param {TokenId} tokenId
 * @param {PrivateKey} supplyKey the supply key from the original mint
 * @param {string} metadataURI optional IPFS pointer (default: project placeholder)
 * @returns {number} the newly minted serial number
 */
async function mintAdditionalSerial(
	client,
	tokenId,
	supplyKey,
	metadataURI = 'ipfs://bafybeihbyr6ldwpowrejyzq623lv374kggemmvebdyanrayuviufdhi6xu/metadata.json',
) {
	const mintTx = new TokenMintTransaction()
		.setTokenId(tokenId)
		.addMetadata(Buffer.from(metadataURI))
		.setMaxTransactionFee(new Hbar(10, HbarUnit.Hbar));

	mintTx.freezeWith(client);
	const signed = await mintTx.sign(supplyKey);
	const resp = await signed.execute(client);
	const receipt = await resp.getReceipt(client);
	return receipt.serials[0].toNumber();
}

/**
 * Sweep back hbar from an account
 * @param {Client} client
 * @param {AccountId} sourceId
 * @param {PrivateKey} sourcePK
 * @param {AccountId} targetId
 * @param {Hbar} amount
 */
async function sweepHbar(client, sourceId, sourcePK, targetId, amount) {
	const sweepTx = new TransferTransaction()
		.addHbarTransfer(targetId, amount)
		.addHbarTransfer(sourceId, amount.negated())
		.freezeWith(client);

	const signedTx = await sweepTx.sign(sourcePK);
	const txResp = await signedTx.execute(client);

	const transferRx = await txResp.getReceipt(client);
	return transferRx.status.toString();
}

module.exports = {
	accountCreator,
	mintFT,
	sendFT,
	sendNFT,
	sendNFTWithAllowance,
	setNFTAllowanceAll,
	setNFTAllowance,
	setFTAllowance,
	setHbarAllowance,
	sendHbar,
	associateTokenToAccount,
	associateTokensToAccount,
	mintNFT,
	sendFTWithAllowance,
	sendNFTDefeatRoyalty,
	clearNFTAllowances,
	clearFTAllowances,
	clearHbarAllowances,
	sweepHbar,
	mintAdditionalSerial,
};