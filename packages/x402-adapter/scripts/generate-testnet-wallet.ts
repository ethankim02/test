import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

/**
 * Generates a fresh, throwaway Base Sepolia EOA for X402_PAYER_PRIVATE_KEY
 * and writes it directly to .env — it is never printed, logged, or
 * returned to the caller. Only the resulting public address is shown, so
 * it can be funded via https://faucet.circle.com.
 *
 * This key is for testnet use only. Never reuse it, never fund it with
 * real assets, and never fund an address generated this way on any
 * network other than Base Sepolia.
 *
 * Usage:
 *   pnpm --filter @x402-treasury/x402-adapter run testnet:wallet
 */
const repoRoot = resolve(import.meta.dirname, '../../..');
const envPath = resolve(repoRoot, '.env');
const envExamplePath = resolve(repoRoot, '.env.example');

const privateKey = generatePrivateKey();
const account = privateKeyToAccount(privateKey);

const base = existsSync(envPath)
  ? readFileSync(envPath, 'utf8')
  : existsSync(envExamplePath)
    ? readFileSync(envExamplePath, 'utf8')
    : '';

const line = `X402_PAYER_PRIVATE_KEY=${privateKey}`;
const updated = /^X402_PAYER_PRIVATE_KEY=.*$/m.test(base)
  ? base.replace(/^X402_PAYER_PRIVATE_KEY=.*$/m, line)
  : `${base.trimEnd()}\n${line}\n`;

writeFileSync(envPath, updated, { mode: 0o600 });

console.log('Generated a new throwaway Base Sepolia testnet wallet.');
console.log(`Address:  ${account.address}`);
console.log('Private key: written directly to .env (X402_PAYER_PRIVATE_KEY) — never printed here.');
console.log('');
console.log(
  `Fund this address with testnet USDC at https://faucet.circle.com (select Base Sepolia).`,
);
console.log('No testnet ETH is needed — the exact/EIP-3009 flow is gasless for the payer.');
