const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';

const useColor = process.stdout.isTTY;
function c(code: string, s: string): string {
  return useColor ? `${code}${s}${RESET}` : s;
}

export const bold = (s: string) => c(BOLD, s);
export const dim = (s: string) => c(DIM, s);
export const green = (s: string) => c(GREEN, s);
export const red = (s: string) => c(RED, s);
export const yellow = (s: string) => c(YELLOW, s);
export const cyan = (s: string) => c(CYAN, s);

export function rule(): void {
  console.log(dim('─'.repeat(56)));
}

export function heading(title: string): void {
  rule();
  console.log(bold(title));
  rule();
}

export function kv(label: string, value: string, width = 14): void {
  console.log(`${label.padEnd(width)} ${value}`);
}

export function check(ok: boolean, label: string): void {
  console.log(`${ok ? green('✓') : red('✗')} ${label}`);
}
