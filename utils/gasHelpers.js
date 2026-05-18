const { readOnlyEVMFromMirrorNode } = require('./solidityHelpers');

const GAS_MULTIPLIER = 1.3;
const GAS_CAP = 14_500_000;

/**
 * Estimate gas for a contract function call using the Hedera mirror node.
 * Returns the mirror estimate × GAS_MULTIPLIER (capped), or the caller-supplied
 * fallback if the mirror estimate fails or returns a non-numeric value.
 *
 * @param {string} env - Environment ("test"|"main"|"preview"|"local")
 * @param {ContractId} contractId - Contract to call
 * @param {ethers.Interface} contractInterface - ABI interface
 * @param {AccountId} operatorId - The caller (from address) for the simulated call
 * @param {string} functionName - Function name
 * @param {Array} parameters - Function args
 * @param {number} fallbackGas - Gas limit to use if estimation fails
 * @param {number} [value=0] - msg.value for the simulated call (TINYBAR)
 * @returns {Promise<{gasLimit: number, isEstimated: boolean, estimatedGas?: number}>}
 */
async function estimateGas(env, contractId, contractInterface, operatorId, functionName, parameters, fallbackGas, value = 0) {
	const tag = `[gas:${functionName}]`;
	try {
		const encodedCommand = contractInterface.encodeFunctionData(functionName, parameters);

		const raw = await readOnlyEVMFromMirrorNode(
			env,
			contractId,
			encodedCommand,
			operatorId,
			true,
			Math.min(fallbackGas * 2, GAS_CAP),
			value,
		);

		const estimatedGas = Number(raw);
		if (!estimatedGas || isNaN(estimatedGas) || estimatedGas <= 0) {
			console.log(`${tag} no valid estimate (raw=${raw}), using fallback ${fallbackGas.toLocaleString()}`);
			return { gasLimit: fallbackGas, isEstimated: false };
		}

		const gasWithBuffer = Math.min(Math.ceil(estimatedGas * GAS_MULTIPLIER), GAS_CAP);
		console.log(`${tag} estimate=${estimatedGas.toLocaleString()} +${((GAS_MULTIPLIER - 1) * 100).toFixed(0)}%=${gasWithBuffer.toLocaleString()}`);

		return {
			gasLimit: gasWithBuffer,
			isEstimated: true,
			estimatedGas,
		};
	}
	catch (error) {
		console.log(`${tag} estimation failed (${error.message}), using fallback ${fallbackGas.toLocaleString()}`);
		return {
			gasLimit: fallbackGas,
			isEstimated: false,
		};
	}
}

/**
 * Log transaction result with gas usage comparison.
 * @param {Array} result - [receipt, returnValues, record] from contractExecuteFunction
 * @param {string} operation - Operation label for logs
 * @param {object} gasInfo - Output of estimateGas (gasLimit, isEstimated, estimatedGas)
 */
function logTransactionResult(result, operation, gasInfo) {
	const [status, , receipt] = result;
	const statusString = typeof status === 'object' && status.status
		? status.status.toString()
		: status?.toString();

	if (statusString === 'SUCCESS') {
		console.log(`${operation}: SUCCESS`);

		if (receipt?.transactionId) {
			console.log(`  txId: ${receipt.transactionId.toString()}`);
		}

		if (receipt?.contractFunctionResult?.gasUsed) {
			const gasUsed = Number(receipt.contractFunctionResult.gasUsed);
			const gasLimit = gasInfo.gasLimit;
			const efficiency = ((gasUsed / gasLimit) * 100).toFixed(1);
			console.log(`  gas: ${gasUsed.toLocaleString()} / ${gasLimit.toLocaleString()} (${efficiency}%)`);

			if (gasInfo.estimatedGas) {
				const accuracy = ((gasUsed / gasInfo.estimatedGas) * 100).toFixed(1);
				console.log(`  estimate accuracy: ${accuracy}% (used ${gasUsed.toLocaleString()} vs estimated ${gasInfo.estimatedGas.toLocaleString()})`);
			}
		}
	}
	else {
		console.log(`${operation}: FAILED — ${statusString?.name ?? statusString}`);
		if (result[1]) console.log(`  failed txId: ${result[1].toString()}`);
	}
}

module.exports = {
	estimateGas,
	logTransactionResult,
	GAS_MULTIPLIER,
	GAS_CAP,
};
