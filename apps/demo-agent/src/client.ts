export interface TreasuryClientOptions {
  baseUrl: string;
  apiKey?: string;
}

/** Thin fetch wrapper — the demo agent talks to Treasury exactly like any external caller would, over real HTTP. */
export class TreasuryClient {
  constructor(private readonly options: TreasuryClientOptions) {}

  withApiKey(apiKey: string): TreasuryClient {
    return new TreasuryClient({ ...this.options, apiKey });
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const headers: Record<string, string> = { ...extraHeaders };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.options.apiKey) headers['authorization'] = `Bearer ${this.options.apiKey}`;
    const res = await fetch(`${this.options.baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : undefined;
    return { status: res.status, body: json };
  }

  post(path: string, body?: unknown, extraHeaders?: Record<string, string>) {
    return this.request('POST', path, body, extraHeaders);
  }

  get(path: string) {
    return this.request('GET', path);
  }
}
