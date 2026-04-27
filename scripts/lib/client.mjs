// Z.AI client targeting the Anthropic-compatible Messages API.
//
// Endpoint:  POST https://api.z.ai/api/anthropic/v1/messages
// Auth:      x-api-key + anthropic-version header
// Body:      { model, max_tokens (required), system?, messages: [...] }
// Response:  { content: [{type:'text', text:'...'}], stop_reason, usage: {input_tokens, output_tokens, ...} }
//
// This endpoint is the one covered by the GLM Coding plan / Coding Pro plan
// quota. The OpenAI-compat /api/paas/v4/* surface uses a separate pay-per-use
// balance and is not relevant here.

export class ZaiApiError extends Error {
  constructor(message, { status, body, kind } = {}) {
    super(message);
    this.name = 'ZaiApiError';
    this.status = status;
    this.body = body;
    this.kind = kind;
  }
}

function debug(...args) {
  if (process.env.ZAI_DEBUG === '1') {
    console.error('[zai-debug]', ...args);
  }
}

const ANTHROPIC_VERSION = '2023-06-01';

// Split an OpenAI-style messages array (which may contain role:'system')
// into the Anthropic shape: { system: string|undefined, messages: [...] }.
// Multiple system messages are concatenated with blank lines.
function splitSystem(messages) {
  const sys = [];
  const rest = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'system') {
      if (typeof m.content === 'string' && m.content) sys.push(m.content);
      continue;
    }
    rest.push(m);
  }
  return { system: sys.length ? sys.join('\n\n') : undefined, messages: rest };
}

function joinTextBlocks(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(b => b && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('');
}

export async function chat({
  apiKey,
  baseUrl,
  model,
  messages,
  system,
  temperature,
  maxTokens,
  signal,
  timeoutMs,
}) {
  if (!apiKey) throw new ZaiApiError('Z.AI API key is missing. Run /zai:setup.', { kind: 'auth' });
  const url = `${baseUrl.replace(/\/$/, '')}/v1/messages`;

  const split = splitSystem(messages || []);
  const finalSystem = system ?? split.system;
  const finalMessages = split.messages;

  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  const timer = timeoutMs ? setTimeout(() => ac.abort(new Error('timeout')), timeoutMs) : null;

  const body = {
    model,
    max_tokens: maxTokens ?? 4096,
    messages: finalMessages,
    ...(finalSystem ? { system: finalSystem } : {}),
    ...(temperature != null ? { temperature } : {}),
  };

  debug('POST', url, 'model=', model, 'msgs=', finalMessages.length, 'sys=', !!finalSystem);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new ZaiApiError('Z.AI request aborted (timeout or cancel).', { status: 0, kind: 'abort' });
    }
    throw new ZaiApiError(`Z.AI network error: ${err.message}`, { status: 0, kind: 'network' });
  } finally {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new ZaiApiError(
      `Z.AI returned non-JSON (status ${res.status}): ${text.slice(0, 200)}`,
      { status: res.status, body: text, kind: 'protocol' },
    );
  }

  if (!res.ok) {
    const detail = json?.error?.message || json?.message || `HTTP ${res.status}`;
    const code = json?.error?.code;
    let kind = 'api';
    if (res.status === 401 || res.status === 403) kind = 'auth';
    else if (res.status === 429) kind = 'rate_limit';
    else if (code === '1113') kind = 'quota';
    throw new ZaiApiError(`Z.AI error: ${detail}`, { status: res.status, body: json, kind });
  }

  const out = {
    text: joinTextBlocks(json?.content),
    stopReason: json?.stop_reason ?? null,
    usage: normalizeUsage(json?.usage),
    model: json?.model ?? model,
    raw: json,
  };
  if (!out.text) {
    debug('empty content. stop_reason=', json?.stop_reason, 'content=', JSON.stringify(json?.content));
  }
  return out;
}

function normalizeUsage(u) {
  if (!u || typeof u !== 'object') return null;
  return {
    input_tokens: u.input_tokens ?? null,
    output_tokens: u.output_tokens ?? null,
    cache_read_input_tokens: u.cache_read_input_tokens ?? null,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? null,
    raw: u,
  };
}

// Lightweight key check. The Anthropic surface does not expose a /models
// endpoint, so we send a 1-token dummy message. If the call is accepted,
// the key is valid for this surface; the response itself is discarded.
export async function verifyKey({ apiKey, baseUrl, model = 'glm-4.5-air' }) {
  const url = `${baseUrl.replace(/\/$/, '')}/v1/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    }),
  });
  const txt = await res.text();
  let json = {};
  try { json = txt ? JSON.parse(txt) : {}; } catch {}
  if (res.ok) return { ok: true, model: json?.model ?? model };
  const detail = json?.error?.message || `HTTP ${res.status}`;
  return { ok: false, status: res.status, detail, body: json };
}

// The Anthropic-compat surface has no /models endpoint, so we return the
// known catalog of GLM models that the Z.AI Coding Plan accepts. listModels()
// against the OpenAI-compat surface stays available but is treated as
// best-effort.
//
// Coding Plan (all tiers): glm-5.1, glm-5-turbo, glm-4.7, glm-4.6, glm-4.5-air
// Coding Pro/Max only:     glm-5
//
// glm-5.1 is the current flagship for code/agentic tasks; glm-4.5-air is
// the throughput-oriented light model used by /zai:ask. The older 4.x
// entries stay listed so users on legacy configs can still see them in
// /zai:setup output.
export const KNOWN_MODELS = [
  'glm-5.1',
  'glm-5-turbo',
  'glm-5',
  'glm-4.7',
  'glm-4.6',
  'glm-4.5-air',
];

export async function listModels({ apiKey, baseUrl }) {
  // baseUrl might be the Anthropic surface ("/api/anthropic"), in which case
  // /models does not exist. Try the sibling OpenAI surface as a best-effort
  // probe, but never let it fail the caller.
  const sibling = baseUrl.replace(/\/api\/anthropic\/?$/, '/api/paas/v4');
  if (sibling === baseUrl) {
    // Caller passed the OpenAI surface directly.
    return probeOpenAiModels({ apiKey, baseUrl });
  }
  try {
    const remote = await probeOpenAiModels({ apiKey, baseUrl: sibling });
    if (remote.length) return remote;
  } catch {}
  return [...KNOWN_MODELS];
}

async function probeOpenAiModels({ apiKey, baseUrl }) {
  const url = `${baseUrl.replace(/\/$/, '')}/models`;
  debug('GET', url);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  const text = await res.text();
  if (!res.ok) return [];
  try {
    const json = JSON.parse(text);
    const data = Array.isArray(json?.data) ? json.data : [];
    return data.map(m => m?.id).filter(Boolean);
  } catch {
    return [];
  }
}
