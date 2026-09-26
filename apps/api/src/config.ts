import { z } from 'zod';

const ConfigSchema = z.object({
  DATABASE_URL: z.string().min(1),
  API_PORT: z.coerce.number().int().positive().default(3000),
  API_LOG_LEVEL: z.string().default('info'),
  // "mock" (default — used by every automated test and pnpm demo:*) or
  // "real" (Base Sepolia only, manual use — see docs/DEMO.md "REAL BASE
  // TESTNET x402 DEMO"). Explicitly opt-in: nothing flips this on by
  // itself. See docs/RESEARCH.md §12/§13 and docs/THREAT_MODEL.md.
  X402_ADAPTER_MODE: z.enum(['mock', 'real']).default('mock'),
  X402_NETWORK: z.string().default('eip155:84532'),
  X402_FACILITATOR_URL: z.string().optional(),
  X402_PAYER_PRIVATE_KEY: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const config = ConfigSchema.parse(env);
  if (config.X402_ADAPTER_MODE === 'real') {
    if (!config.X402_FACILITATOR_URL || !config.X402_PAYER_PRIVATE_KEY) {
      throw new Error(
        'X402_ADAPTER_MODE=real requires X402_FACILITATOR_URL and X402_PAYER_PRIVATE_KEY to be set — see docs/DEMO.md "REAL BASE TESTNET x402 DEMO".',
      );
    }
  }
  return config;
}
