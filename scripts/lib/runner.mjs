import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as jobs from './jobs.mjs';
import * as client from './client.mjs';
import { load as loadConfig } from './config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPANION = path.resolve(__dirname, '..', 'zai-companion.mjs');

function pickModel(cfg, requested, kind) {
  if (requested) return requested;
  if (kind === 'ask') return cfg.light_model || cfg.default_model;
  return cfg.default_model;
}

export async function runForeground({ kind, messages, requestSummary, model }) {
  const cfg = await loadConfig();
  if (!cfg?.api_key) {
    throw new Error('Z.AI API key not configured. Run /zai:setup.');
  }
  const useModel = pickModel(cfg, model, kind);
  const startedAt = Date.now();
  const job = await jobs.create({ kind, request: requestSummary, model: useModel });
  await jobs.update(job.id, { started_at: new Date(startedAt).toISOString(), pid: process.pid });
  try {
    const out = await client.chat({
      apiKey: cfg.api_key,
      baseUrl: cfg.base_url,
      model: useModel,
      messages,
      timeoutMs: cfg.timeout_ms,
    });
    await jobs.update(job.id, {
      status: 'done',
      result: out.text,
      usage: out.usage,
      ended_at: new Date().toISOString(),
    });
    return { job, out };
  } catch (err) {
    await jobs.update(job.id, {
      status: 'error',
      error: err.message,
      ended_at: new Date().toISOString(),
    });
    throw err;
  }
}

export async function runBackground({ kind, messages, requestSummary, model }) {
  const cfg = await loadConfig();
  if (!cfg?.api_key) {
    throw new Error('Z.AI API key not configured. Run /zai:setup.');
  }
  const useModel = pickModel(cfg, model, kind);
  const job = await jobs.create({ kind, request: requestSummary, model: useModel });
  // Persist messages alongside job for the worker to pick up.
  await jobs.update(job.id, { request: { ...requestSummary, messages } });
  const child = spawn(process.execPath, [COMPANION, '__worker', job.id], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  await jobs.update(job.id, { pid: child.pid, started_at: new Date().toISOString() });
  return { jobId: job.id, model: useModel };
}

export async function runWorker(jobId) {
  const cfg = await loadConfig();
  const job = await jobs.get(jobId);
  if (!job) throw new Error(`worker: job ${jobId} not found`);
  try {
    const out = await client.chat({
      apiKey: cfg.api_key,
      baseUrl: cfg.base_url,
      model: job.model,
      messages: job.request?.messages || [],
      timeoutMs: cfg.timeout_ms,
    });
    await jobs.update(jobId, {
      status: 'done',
      result: out.text,
      usage: out.usage,
      ended_at: new Date().toISOString(),
    });
  } catch (err) {
    await jobs.update(jobId, {
      status: 'error',
      error: err.message,
      ended_at: new Date().toISOString(),
    });
  }
}
