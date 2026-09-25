import { z } from 'zod';

const ConfigSchema = z.object({
  DATABASE_URL: z.string().min(1),
  API_PORT: z.coerce.number().int().positive().default(3000),
  API_LOG_LEVEL: z.string().default('info'),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return ConfigSchema.parse(env);
}
