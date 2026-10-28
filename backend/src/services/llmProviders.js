/**
 * LLM access through any OpenAI-compatible /chat/completions endpoint, so the
 * project is not tied to one vendor:
 *   OpenRouter  https://openrouter.ai/api/v1   (OPENROUTER_API_KEY; any model,
 *               e.g. "google/gemini-2.5-flash", "anthropic/claude-sonnet-4.5")
 *   LM Studio   http://127.0.0.1:1234/v1       (local, no key)
 *   Ollama      http://127.0.0.1:11434/v1      (local, no key)
 *
 * `generateJson({ system, prompt, schema, schemaName })` returns parsed JSON;
 * `describe()` returns { provider, model } for caching and display.
 */
export class LlmError extends Error {
  constructor(message, { code = null } = {}) {
    super(message);
    this.name = "LlmError";
    this.code = code;
  }
}

export class OpenAICompatibleProvider {
  constructor({
    baseUrl = "https://openrouter.ai/api/v1",
    model,
    apiKey = null,
    requiresKey = null,
    temperature = 0.2,
    maxTokens = 4096,
    timeoutMs = 300000,
    appName = "Kosha",
    appUrl = "https://github.com/kgcorner/kosha",
    fetch: fetchImpl = globalThis.fetch
  }) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.model = model;
    this.apiKey = apiKey;
    // Hosted endpoints need a key; local servers (localhost) do not.
    this.requiresKey = requiresKey ?? !isLocal(this.baseUrl);
    this.temperature = temperature ?? 0.2;
    this.maxTokens = maxTokens ?? 4096;
    this.timeoutMs = timeoutMs ?? 300000;
    this.appName = appName;
    this.appUrl = appUrl;
    this.fetch = fetchImpl;
    // Remember when an endpoint/model rejects json_schema so we stop sending it.
    this.schemaUnsupported = false;
  }

  describe() {
    return { provider: providerLabel(this.baseUrl), model: this.model };
  }

  get configured() {
    return Boolean(this.model) && (!this.requiresKey || Boolean(this.apiKey));
  }

  async generateJson({ system, prompt, schema, schemaName = "result" }) {
    if (!this.model) throw new LlmError("LLM model is not configured (llm.model)", { code: "not_configured" });
    if (this.requiresKey && !this.apiKey) {
      throw new LlmError(`LLM API key is not set for ${this.baseUrl} (e.g. OPENROUTER_API_KEY)`, { code: "not_configured" });
    }
    const messages = [
      { role: "system", content: system },
      { role: "user", content: prompt }
    ];
    // Prefer strict JSON schema; fall back to plain JSON mode, then to no
    // response_format at all, for models/servers that reject the richer modes.
    const formats = [];
    if (schema && !this.schemaUnsupported) {
      formats.push({ type: "json_schema", json_schema: { name: schemaName, strict: true, schema } });
    }
    formats.push({ type: "json_object" }, null);

    let lastError = null;
    for (const format of formats) {
      const response = await this.post({
        model: this.model,
        temperature: this.temperature,
        max_tokens: this.maxTokens,
        messages: format?.type === "json_schema" || !schema
          ? messages
          : [messages[0], { role: "user", content: `${prompt}\n\nRespond with JSON matching this schema:\n${JSON.stringify(schema)}` }],
        ...(format ? { response_format: format } : {})
      });
      if (response.ok) {
        const payload = await response.json();
        if (payload?.error) throw new LlmError(`LLM error: ${payload.error.message ?? JSON.stringify(payload.error)}`, { code: "request_failed" });
        return parseJsonText(payload?.choices?.[0]?.message?.content, "LLM");
      }
      const detail = (await response.text()).slice(0, 300);
      if (response.status === 401 || response.status === 403) {
        throw new LlmError(`LLM authentication failed (HTTP ${response.status}): ${detail}`, { code: "not_configured" });
      }
      if (response.status === 429) throw new LlmError(`LLM rate limited: ${detail}`, { code: "rate_limited" });
      lastError = new LlmError(`LLM request failed (HTTP ${response.status}): ${detail}`, { code: "request_failed" });
      // Only a 400/422 suggests the response_format was the problem; retry simpler.
      if (response.status !== 400 && response.status !== 422) throw lastError;
      if (format?.type === "json_schema") this.schemaUnsupported = true;
    }
    throw lastError;
  }

  async post(body) {
    try {
      return await this.fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
          // OpenRouter app attribution headers (ignored by other servers).
          "HTTP-Referer": this.appUrl,
          "X-Title": this.appName
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      throw new LlmError(`LLM unreachable at ${this.baseUrl}: ${error.message}`, { code: "unreachable" });
    }
  }
}

function isLocal(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local");
  } catch {
    return false;
  }
}

function providerLabel(baseUrl) {
  if (/openrouter\.ai/.test(baseUrl)) return "openrouter";
  return isLocal(baseUrl) ? "local" : "openai-compatible";
}

export function createLlmProvider(configuration = {}, env = process.env) {
  const provider = configuration.provider ?? "openai-compatible";
  if (!["openai-compatible", "openrouter", "lmstudio", "ollama"].includes(provider)) {
    throw new Error(`Unknown llm.provider "${provider}" (use "openai-compatible")`);
  }
  const keyEnv = configuration.api_key_env ?? (provider === "openrouter" ? "OPENROUTER_API_KEY" : null);
  return new OpenAICompatibleProvider({
    baseUrl: configuration.base_url ?? "https://openrouter.ai/api/v1",
    model: configuration.model,
    apiKey: keyEnv ? env[keyEnv] ?? null : null,
    requiresKey: configuration.requires_key,
    temperature: configuration.temperature,
    maxTokens: configuration.max_output_tokens,
    timeoutMs: configuration.timeout_ms
  });
}

// Models sometimes wrap JSON in ``` fences or add prose around it.
export function parseJsonText(text, label = "LLM") {
  if (typeof text !== "string" || !text.trim()) throw new LlmError(`${label} returned an empty response`, { code: "bad_output" });
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
    throw new LlmError(`${label} returned invalid JSON: ${candidate.slice(0, 200)}`, { code: "bad_output" });
  }
}
