export class ZaiApiError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'ZaiApiError';
    this.status = status;
    this.body = body;
  }
}

function debug(...args) {
  if (process.env.ZAI_DEBUG === '1') {
    console.error('[zai-debug]', ...args);
  }
}

export async function chat({ apiKey, baseUrl, model, messages, temperature, maxTokens, signal, timeoutMs }) {
  if (!apiKey) throw new ZaiApiError('Z.AI API key is missing. Run /zai:setup.');
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;

  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  const timer = timeoutMs ? setTimeout(() => ac.abort(new Error('timeout')), timeoutMs) : null;

  debug('POST', url, 'model=', model, 'messages=', messages.length);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        ...(temperature != null ? { temperature } : {}),
        ...(maxTokens != null ? { max_tokens: maxTokens } : {}),
        stream: false,
      }),
      signal: ac.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new ZaiApiError('Z.AI request aborted (timeout or cancel).', { status: 0 });
    }
    throw new ZaiApiError(`Z.AI network error: ${err.message}`, { status: 0 });
  } finally {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new ZaiApiError(`Z.AI returned non-JSON (status ${res.status}): ${text.slice(0, 200)}`, { status: res.status, body: text });
  }

  if (!res.ok) {
    const detail = json?.error?.message || json?.message || `HTTP ${res.status}`;
    throw new ZaiApiError(`Z.AI error: ${detail}`, { status: res.status, body: json });
  }

  const choice = json?.choices?.[0];
  const content = choice?.message?.content ?? '';
  return {
    text: typeof content === 'string' ? content : JSON.stringify(content),
    usage: json?.usage ?? null,
    model: json?.model ?? model,
    raw: json,
  };
}

export async function listModels({ apiKey, baseUrl }) {
  if (!apiKey) throw new ZaiApiError('Z.AI API key is missing.');
  const url = `${baseUrl.replace(/\/$/, '')}/models`;
  debug('GET', url);
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${apiKey}` },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new ZaiApiError(`Z.AI /models failed: HTTP ${res.status} ${text.slice(0, 200)}`, { status: res.status });
  }
  try {
    const json = JSON.parse(text);
    const data = Array.isArray(json?.data) ? json.data : [];
    return data.map(m => m?.id).filter(Boolean);
  } catch {
    return [];
  }
}
