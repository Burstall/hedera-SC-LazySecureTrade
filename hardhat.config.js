require('hardhat-contract-sizer');
require('@nomicfoundation/hardhat-toolbox');
require('hardhat-docgen');
require('dotenv').config();

// Hedera JSON-RPC relays (Hashio public endpoints). Used only by the
// hardhat-verify plugin path — verification is read-only (it just fetches the
// deployed bytecode), so no `accounts` key / private key is required here.
// Override any endpoint via *_RPC_URL env vars if you run your own relay.
const HEDERA_NETWORKS = {
	testnet: { url: process.env.TESTNET_RPC_URL || 'https://testnet.hashio.io/api', chainId: 296 },
	mainnet: { url: process.env.MAINNET_RPC_URL || 'https://mainnet.hashio.io/api', chainId: 295 },
	previewnet: { url: process.env.PREVIEWNET_RPC_URL || 'https://previewnet.hashio.io/api', chainId: 297 },
};

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
	mocha: {
		timeout: 100000000,
		slow: 100000,
	},
	solidity: {
		version: '0.8.18',
		settings: {
			optimizer: {
				enabled: true,
				runs: 200,
			},
			viaIR: true,
		},
	},
	// Named Hedera networks so `npx hardhat verify --network testnet <addr>`
	// knows which chain to target. The repo's deploy/test flow uses
	// @hashgraph/sdk directly and does NOT rely on these — they exist purely
	// for the manual hardhat-verify fallback. The primary verification path is
	// utils/sourcifyVerify.js (direct Sourcify V2 API).
	networks: HEDERA_NETWORKS,
	// HashScan now delegates verification to the public Sourcify (sourcify.dev),
	// which natively supports Hedera mainnet (295) / testnet (296).
	sourcify: {
		enabled: true,
		apiUrl: 'https://sourcify.dev/server',
		browserUrl: 'https://repo.sourcify.dev',
	},
	// NOTE: to use `npx hardhat verify` cleanly you want
	// @nomicfoundation/hardhat-verify >= 2.0 (the bundled toolbox v3 ships
	// 1.1.x). After upgrading, uncomment the line below so the verify task
	// skips the Etherscan leg (Hedera has no Etherscan-style explorer):
	//   yarn add -D @nomicfoundation/hardhat-verify@^2.0.0
	// etherscan: { enabled: false },
	contractSizer: {
		alphaSort: true,
		runOnCompile: true,
		disambiguatePaths: false,
		strict: true,
	},
	docgen: {
		path: './docs/generated',
		clear: true,
		runOnCompile: true,
	},
};
