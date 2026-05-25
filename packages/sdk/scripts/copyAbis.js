#!/usr/bin/env node
/**
 * Extracts ABIs for the v0.3 marketplace surface from the parent Hardhat
 * artifacts directory and writes clean JSON arrays into packages/sdk/abi/.
 *
 * Run from packages/sdk via `npm run copy-abi` (also triggered by `prebuild`).
 * Bails if any artifact is missing so a stale SDK build cannot silently ship.
 */

const fs = require('fs');
const path = require('path');

const CONTRACTS = [
    'LazySecureTrade',
    'BidderContractFactory',
    'BidderContract',
    'EnglishAuction',
    'VIPSubscription',
];

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const ARTIFACTS_DIR = path.join(REPO_ROOT, 'artifacts', 'contracts');
const OUT_DIR = path.resolve(__dirname, '..', 'abi');

function readArtifact(name) {
    const artifactPath = path.join(ARTIFACTS_DIR, `${name}.sol`, `${name}.json`);
    if (!fs.existsSync(artifactPath)) {
        throw new Error(
            `Artifact not found: ${artifactPath}\n` +
            `Run \`yarn hardhat compile\` in the repo root first.`,
        );
    }
    const raw = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    if (!Array.isArray(raw.abi)) {
        throw new Error(`Artifact ${name} is missing an \`abi\` field`);
    }
    return raw.abi;
}

function hasPreBuiltAbis() {
    if (!fs.existsSync(OUT_DIR)) return false;
    return CONTRACTS.every((name) =>
        fs.existsSync(path.join(OUT_DIR, `${name}.json`)),
    );
}

function main() {
    // When installed from a git URL or extracted tarball, the parent
    // Hardhat artifacts/ directory is not present — only the SDK's own
    // pre-committed abi/ JSONs. In that case, skip extraction and rely
    // on the bundled ABIs (verified by hasPreBuiltAbis below).
    if (!fs.existsSync(ARTIFACTS_DIR)) {
        if (hasPreBuiltAbis()) {
            process.stdout.write(
                'Hardhat artifacts not found; using bundled ABIs in packages/sdk/abi/.\n',
            );
            return;
        }
        throw new Error(
            'Neither parent Hardhat artifacts nor bundled SDK ABIs are present.\n' +
            'Run `yarn hardhat compile` at the repo root, or install from a release ' +
            'that ships the ABIs.',
        );
    }

    fs.mkdirSync(OUT_DIR, { recursive: true });
    for (const name of CONTRACTS) {
        const abi = readArtifact(name);
        const outPath = path.join(OUT_DIR, `${name}.json`);
        fs.writeFileSync(outPath, `${JSON.stringify(abi, null, 2)}\n`);
        process.stdout.write(`  ${name} → ${path.relative(REPO_ROOT, outPath)}\n`);
    }
    process.stdout.write(`Wrote ${CONTRACTS.length} ABIs to ${path.relative(REPO_ROOT, OUT_DIR)}\n`);
}

main();
