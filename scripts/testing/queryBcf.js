const dotenv = require('dotenv');
dotenv.config();
const fs = require('fs');
const { Client, AccountId, PrivateKey, ContractId, ContractCallQuery } = require('@hashgraph/sdk');
const { ethers } = require('ethers');

(async () => {
	const lstJson = JSON.parse(fs.readFileSync('./artifacts/contracts/LazySecureTrade.sol/LazySecureTrade.json'));
	const iface = new ethers.Interface(lstJson.abi);
	const data = iface.encodeFunctionData('bcf', []);
	const operatorId = AccountId.fromString(process.env.ACCOUNT_ID);
	const operatorKey = PrivateKey.fromStringED25519(process.env.PRIVATE_KEY);
	const client = Client.forTestnet().setOperator(operatorId, operatorKey);
	const q = new ContractCallQuery()
		.setContractId(ContractId.fromString('0.0.9016858'))
		.setGas(200000)
		.setFunctionParameters(Buffer.from(data.slice(2), 'hex'));
	const result = await q.execute(client);
	const hex = '0x' + Buffer.from(result.bytes).toString('hex');
	const decoded = iface.decodeFunctionResult('bcf', hex);
	console.log('LST.bcf() =', decoded[0]);

	const data2 = iface.encodeFunctionData('pendingBcf', []);
	const q2 = new ContractCallQuery()
		.setContractId(ContractId.fromString('0.0.9016858'))
		.setGas(200000)
		.setFunctionParameters(Buffer.from(data2.slice(2), 'hex'));
	const r2 = await q2.execute(client);
	const d2 = iface.decodeFunctionResult('pendingBcf', '0x' + Buffer.from(r2.bytes).toString('hex'));
	console.log('LST.pendingBcf() =', d2[0]);
	process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
