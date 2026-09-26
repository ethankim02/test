import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');

export interface ManagedProcess {
  name: string;
  child: ChildProcess;
  healthUrl: string;
}

/**
 * Spawns a workspace app's entrypoint via `tsx` (same runtime the rest of
 * this monorepo uses — see CONTRIBUTING.md) and waits for it to answer
 * its `/health` endpoint before returning. This is what makes
 * `pnpm demo:research` a genuine end-to-end demonstration over real HTTP
 * — the Treasury API and both demo providers are real separate processes,
 * not in-process function calls.
 */
export async function startProcess(
  name: string,
  entrypoint: string,
  port: number,
  env: Record<string, string>,
): Promise<ManagedProcess> {
  const child = spawn('node', ['--import', 'tsx', join(REPO_ROOT, entrypoint)], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdio: 'ignore',
  });

  const healthUrl = `http://127.0.0.1:${port}/health`;
  const deadline = Date.now() + 20_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(healthUrl);
      if (res.ok) return { name, child, healthUrl };
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  child.kill();
  throw new Error(
    `${name} did not become healthy at ${healthUrl} within 20s: ${String(lastError)}`,
  );
}

export function stopAll(processes: ManagedProcess[]): void {
  for (const p of processes) {
    p.child.kill();
  }
}
