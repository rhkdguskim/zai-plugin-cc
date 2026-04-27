import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as jobs from './jobs.mjs';
import * as client from './client.mjs';
import { load as loadConfig } from './config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPANION = path.resolve(__dirname, '..', 'zai-companion.mjs');

// Resolution order:
//   1. explicit per-call `--model` flag,
//   2. per-mode entry in cfg.models[kind],
//   3. legacy fallbacks (light_model for ask, default_model otherwise).
// Step 2 is what lets a user route ask to glm-4.5-air for speed while
// sending code/review/consult to glm-5.1 — without either path needing
// to know about the other.
//
// Exported for unit tests; the runtime calls it internally.
export function pickModel(cfg, requested, kind) {
  if (requested) return requested;
  const fromMap = cfg && cfg.models && cfg.models[kind];
  if (fromMap) return fromMap;
  if (kind === 'ask') return cfg?.light_model || cfg?.default_model;
  return cfg?.default_model;
}

// Per-mode sampling hyperparameters. Each mode is tuned for a different
// shape of output (deterministic code vs exploratory consult) — see
// config.mjs::DEFAULT_PARAMS for the rationale. The returned object is
// always fully populated (temperature, top_p, max_tokens) so callers
// don't need to handle missing keys.
//
// Exported for unit tests.
export function pickParams(cfg, kind) {
  const fromMap = cfg && cfg.params && cfg.params[kind];
  if (fromMap) return { ...fromMap };
  // Conservative fallback when the config predates v4 and somehow slipped
  // past the migration: mirror the heavy-mode defaults.
  return { temperature: 0.3, top_p: 0.9, max_tokens: 4096 };
}

export async function runForeground({ kind, messages, requestSummary, model }) {
  const cfg = await loadConfig();
  if (!cfg?.api_key) {
    throw new Error('Z.AI API key not configured. Run /zai:setup.');
  }
  const useModel = pickModel(cfg, model, kind);
  const params = pickParams(cfg, kind);
  const job0 = await jobs.create({ kind, request: requestSummary, model: useModel, bg: false });
  // Deliberately do NOT store process.pid for foreground jobs. The companion
  // script exits as soon as the foreground call finishes; storing its pid
  // means that any future `cancel` request would target whatever unrelated
  // process the OS later assigns to that recycled pid.
  const job1 = await jobs.update(job0.id, {
    started_at: new Date().toISOString(),
    params,
  });
  try {
    const out = await client.chat({
      apiKey: cfg.api_key,
      baseUrl: cfg.base_url,
      model: useModel,
      messages,
      temperature: params.temperature,
      topP: params.top_p,
      maxTokens: params.max_tokens,
      stopSequences: cfg.stop_sequences,
      timeoutMs: cfg.timeout_ms,
    });
    // finishIfRunning rather than update so a concurrent cancel that already
    // wrote 'cancelled' isn't silently overwritten back to 'done'.
    const job = await jobs.finishIfRunning(job1.id, {
      status: 'done',
      result: out.text,
      usage: out.usage,
      ended_at: new Date().toISOString(),
    });
    return { job, out };
  } catch (err) {
    const job = await jobs.finishIfRunning(job1.id, {
      status: 'error',
      error: err.message,
      ended_at: new Date().toISOString(),
    });
    err.jobId = job.id;
    throw err;
  }
}

export async function runBackground({ kind, messages, requestSummary, model }) {
  const cfg = await loadConfig();
  if (!cfg?.api_key) {
    throw new Error('Z.AI API key not configured. Run /zai:setup.');
  }
  const useModel = pickModel(cfg, model, kind);
  const params = pickParams(cfg, kind);
  const job = await jobs.create({ kind, request: requestSummary, model: useModel, bg: true });
  // Persist messages alongside job for the worker to pick up. This must be
  // done BEFORE spawning so the worker doesn't race past us and read an
  // incomplete record. params + stop_sequences are stamped here so the
  // worker uses the exact same hyperparams the foreground path would have.
  await jobs.update(job.id, {
    request: { ...requestSummary, messages },
    params,
    stop_sequences: cfg.stop_sequences,
  });
  const child = spawn(process.execPath, [COMPANION, '__worker', job.id], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  // child.pid can be undefined if spawn failed silently — write null in that
  // case so cancel() never tries to signal an unknown value.
  const pid = Number.isInteger(child.pid) && child.pid > 1 ? child.pid : null;
  // A very fast worker (rare with a real network call, possible with mocked
  // ones) could write its terminal status before we land this stamp. Use
  // finishIfRunning so we don't revert a 'done' record back to 'running'
  // just to add pid/started_at.
  await jobs.finishIfRunning(job.id, { pid, started_at: new Date().toISOString() });
  return { jobId: job.id, model: useModel };
}

export async function runWorker(jobId) {
  const cfg = await loadConfig();
  const job = await jobs.get(jobId);
  if (!job) throw new Error(`worker: job ${jobId} not found`);
  // Prefer the params stamped on the job at spawn time over re-resolving
  // from the current config, in case the user's config changed between
  // dispatch and worker pickup.
  const params = job.params || pickParams(cfg, job.kind);
  const stopSequences = Array.isArray(job.stop_sequences)
    ? job.stop_sequences : cfg.stop_sequences;
  try {
    const out = await client.chat({
      apiKey: cfg.api_key,
      baseUrl: cfg.base_url,
      model: job.model,
      messages: job.request?.messages || [],
      temperature: params.temperature,
      topP: params.top_p,
      maxTokens: params.max_tokens,
      stopSequences,
      timeoutMs: cfg.timeout_ms,
    });
    // finishIfRunning is the convergence point with cancel(): if the user
    // cancelled while we were mid-fetch, the record already reads
    // 'cancelled' and we leave it alone instead of overwriting with 'done'.
    await jobs.finishIfRunning(jobId, {
      status: 'done',
      result: out.text,
      usage: out.usage,
      ended_at: new Date().toISOString(),
    });
  } catch (err) {
    await jobs.finishIfRunning(jobId, {
      status: 'error',
      error: err.message,
      ended_at: new Date().toISOString(),
    });
  }
}
