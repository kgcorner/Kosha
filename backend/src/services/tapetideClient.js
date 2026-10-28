/**
 * Minimal client for Tapetide's remote MCP server (https://mcp.tapetide.com),
 * which is how Tapetide exposes its Indian stock data programmatically.
 *
 * Auth mirrors Tapetide's own npm bridge (`tapetide-mcp`): the personal token
 * from https://tapetide.com/settings/tokens (`tpt_rt_...`) is a *refresh*
 * token, exchanged at `POST /token` for a ~1h access token that is sent as
 * `Authorization: Bearer ...` on JSON-RPC `tools/call` requests to `/mcp`.
 *
 * Every successful tool call counts against the account's daily quota, so
 * callers should cache results (see FundamentalsService).
 */
export class TapetideError extends Error {
  constructor(message, { status = null, code = null, retryAfterSeconds = null } = {}) {
    super(message);
    this.name = "TapetideError";
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const PROTOCOL_VERSION = "2025-06-18";

export class TapetideClient {
  constructor({
    token,
    baseUrl = "https://mcp.tapetide.com",
    timeoutMs = 30000,
    fetch: fetchImpl = globalThis.fetch,
    now = Date.now,
    userAgent = "kosha/1.0 (+https://github.com/kgcorner/kosha)"
  } = {}) {
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
    this.now = now;
    this.userAgent = userAgent;
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;
    this.refreshing = null;
    this.requestId = 0;
  }

  get configured() {
    return Boolean(this.token);
  }

  /** Call one Tapetide tool and return its parsed JSON payload. */
  async callTool(name, args = {}) {
    if (!this.configured) {
      throw new TapetideError("Tapetide token is not configured (set TAPETIDE_TOKEN)", { code: "not_configured" });
    }
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: ++this.requestId,
      method: "tools/call",
      params: { name, arguments: args }
    });

    let response = await this.post(body, await this.getAccessToken());
    if (response.status === 401) {
      // Access token expired between check and use: refresh once and retry.
      this.accessToken = null;
      response = await this.post(body, await this.getAccessToken());
    }
    if (response.status === 429) {
      const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
      throw new TapetideError("Tapetide rate limit or daily quota reached", {
        status: 429,
        code: "rate_limited",
        retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : null
      });
    }
    const text = await response.text();
    if (!response.ok) {
      throw new TapetideError(`Tapetide HTTP ${response.status}: ${text.slice(0, 200)}`, { status: response.status });
    }

    const message = parseRpcMessage(text);
    if (message?.error) {
      throw new TapetideError(`Tapetide ${name} failed: ${message.error.message ?? JSON.stringify(message.error)}`, {
        code: message.error.code ?? null
      });
    }
    const result = message?.result;
    if (!result) throw new TapetideError(`Tapetide ${name} returned no result`);
    const payload = toolPayload(result);
    if (result.isError) {
      const detail = typeof payload === "string" ? payload : JSON.stringify(payload);
      throw new TapetideError(`Tapetide ${name} error: ${detail.slice(0, 300)}`, { code: "tool_error" });
    }
    return payload;
  }

  async post(body, accessToken) {
    return this.request(`${this.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": PROTOCOL_VERSION,
        "User-Agent": this.userAgent,
        Authorization: `Bearer ${accessToken}`
      },
      body,
      signal: AbortSignal.timeout(this.timeoutMs)
    });
  }

  async getAccessToken() {
    if (this.accessToken && this.now() < this.accessTokenExpiresAt) return this.accessToken;
    if (!this.refreshing) {
      this.refreshing = this.exchangeToken().finally(() => {
        this.refreshing = null;
      });
    }
    await this.refreshing;
    return this.accessToken;
  }

  // Network-level failures (DNS, refused, timeout) become a TapetideError that
  // names the host and the underlying cause instead of a bare "fetch failed".
  async request(url, init) {
    try {
      return await this.fetch(url, init);
    } catch (error) {
      const cause = error?.cause?.code ?? error?.cause?.message ?? error?.name ?? "";
      const detail = error?.name === "TimeoutError" ? `timed out after ${this.timeoutMs}ms` : `${error.message}${cause && !String(error.message).includes(cause) ? ` (${cause})` : ""}`;
      throw new TapetideError(`Could not reach Tapetide at ${new URL(url).origin}: ${detail}`, { code: "unreachable" });
    }
  }

  async exchangeToken() {
    const response = await this.request(`${this.baseUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": this.userAgent },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: this.token }),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new TapetideError(`Tapetide token exchange failed (HTTP ${response.status}): ${detail.slice(0, 200)}`, {
        status: response.status,
        code: "auth_failed"
      });
    }
    const data = await response.json();
    if (!data.access_token) throw new TapetideError("Tapetide token exchange returned no access_token", { code: "auth_failed" });
    this.accessToken = data.access_token;
    // Refresh 5 minutes early; default to 1h when expires_in is missing.
    const expiresIn = Number(data.expires_in) || 3600;
    this.accessTokenExpiresAt = this.now() + Math.max(expiresIn - 300, 30) * 1000;
  }
}

// The remote answers either plain JSON or an SSE stream ("data: {...}" lines);
// take the last JSON-RPC message in either case.
export function parseRpcMessage(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      /* fall through to SSE parsing */
    }
  }
  let last = null;
  for (const line of text.split(/\r?\n/)) {
    const data = line.startsWith("data:") ? line.slice(5).trim() : null;
    if (!data) continue;
    try {
      last = JSON.parse(data);
    } catch {
      /* keep-alive or partial event */
    }
  }
  return last;
}

// MCP tool results carry `structuredContent` and/or text content; Tapetide's
// text content is a JSON document. Return parsed JSON when possible.
export function toolPayload(result) {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const texts = (result.content ?? []).filter((part) => part?.type === "text").map((part) => part.text);
  if (texts.length === 0) return null;
  const joined = texts.join("\n");
  try {
    return JSON.parse(joined);
  } catch {
    return joined;
  }
}
