import { ExactEvmScheme } from '@x402/evm';
import { x402Client } from '@x402/core/client';
import { wrapFetchWithPayment } from '@x402/fetch';
import { privateKeyToAccount } from 'viem/accounts';

/**
 * Proves the RealX402Adapter construction path against the real,
 * installed @x402/* SDK — everything short of the actual network hop —
 * then attempts one live reachability check against the public
 * facilitator so the exact boundary between "code is correct" and
 * "this environment can/cannot reach Base Sepolia" is never ambiguous.
 *
 * Never run this expecting it to move real funds: it makes no
 * transaction of any kind, only (a) constructs the signer/client chain
 * and (b) does a GET against the facilitator's discovery endpoint.
 *
 * Usage:
 *   pnpm --filter @x402-treasury/x402-adapter run testnet:check
 *
 * With no env vars set, this uses Anvil/Foundry's well-known default
 * test account #0 private key — a value published in Foundry's own
 * documentation, used by essentially every local EVM dev tool, and
 * holding no real funds on any network — purely so the construction
 * path can be exercised without requiring a real key just to prove the
 * code compiles and runs against the real SDK. Set X402_PAYER_PRIVATE_KEY
 * to use your own funded Base Sepolia key instead (see docs/RESEARCH.md §12
 * and docs/DEMO.md "Base Sepolia setup checklist").
 */

const NETWORK = 'eip155:84532'; // Base Sepolia — the only network this project supports for real settlement.
const FACILITATOR_URL = process.env['X402_FACILITATOR_URL'] ?? 'https://x402.org/facilitator';

const WELL_KNOWN_PUBLIC_TEST_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;

const operatorKey = process.env['X402_PAYER_PRIVATE_KEY'];
const usingRealKey = Boolean(operatorKey);
const privateKey = (operatorKey ?? WELL_KNOWN_PUBLIC_TEST_KEY) as `0x${string}`;

console.log('=== x402 Real Adapter Readiness Check (Base Sepolia) ===');
console.log(`Network:      ${NETWORK}`);
console.log(`Facilitator:  ${FACILITATOR_URL}`);
console.log(
  `Signer key:   ${usingRealKey ? 'operator-provided (X402_PAYER_PRIVATE_KEY)' : 'Anvil well-known PUBLIC test key #0 — construction check only, do not fund this address'}`,
);

const account = privateKeyToAccount(privateKey);
console.log(`Derived addr: ${account.address}`);

const client = new x402Client().register(NETWORK, new ExactEvmScheme(account));
const payFetch = wrapFetchWithPayment(fetch, client);
void payFetch; // constructed successfully; not invoked here (no resource server URL to call against in isolation)
console.log(
  '\n✓ Construction path succeeded: privateKeyToAccount -> ExactEvmScheme -> x402Client -> wrapFetchWithPayment',
);
console.log(
  '  (all four are real exports of the installed @x402/evm, @x402/core, @x402/fetch packages)',
);

console.log(`\nAttempting live reachability check against ${FACILITATOR_URL}/supported ...`);
try {
  const res = await fetch(`${FACILITATOR_URL}/supported`, { signal: AbortSignal.timeout(8000) });
  const body = await res.text();
  const blockedByEgressPolicy = res.status === 403 && /not in allowlist/i.test(body);

  if (res.ok) {
    console.log(`✓ Reached facilitator: HTTP ${res.status}`);
    console.log(body.slice(0, 1000));
    console.log(
      '\nNetwork access confirmed. A real payment flow can proceed from this environment.',
    );
  } else if (blockedByEgressPolicy) {
    console.log(`✗ Blocked by this environment's own network egress policy (HTTP ${res.status}):`);
    console.log(`  ${body.trim()}`);
    console.log(
      "\nThis is NOT a code, key, or credential problem — it's this sandbox's outbound network policy.",
    );
    console.log(
      "The host needs to be added to this environment's egress allowlist (x402.org, plus a Base",
    );
    console.log(
      'Sepolia RPC host and a block explorer host for full verification), or this script needs to be',
    );
    console.log('run from an environment/machine that already has outbound internet access.');
    process.exitCode = 1;
  } else {
    console.log(`✗ Facilitator responded with an unexpected status: HTTP ${res.status}`);
    console.log(body.slice(0, 1000));
    process.exitCode = 1;
  }
} catch (err) {
  console.log(`✗ Could not reach ${FACILITATOR_URL} from this environment.`);
  console.log(`  ${err instanceof Error ? err.message : String(err)}`);
  console.log(
    '\nThis is the expected result in a network-sandboxed environment whose egress policy blocks',
  );
  console.log(
    'blockchain-related hosts (facilitators, RPC endpoints, block explorers) — it is not a code, key,',
  );
  console.log(
    'or credential problem. Run this same script from a machine/environment with outbound internet',
  );
  console.log('access to proceed to an actual testnet settlement.');
  process.exitCode = 1;
}
