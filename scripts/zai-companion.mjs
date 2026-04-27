#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import * as config from './lib/config.mjs';
import * as client from './lib/client.mjs';
import * as jobs from './lib/jobs.mjs';
import * as runner from './lib/runner.mjs';
import * as prompts from './lib/prompts.mjs';
import { parseFlags, FlagError } from './lib/flags.mjs';

const HELP = `zai-companion — sidekick runtime for the zai-plugin-cc Claude Code plugin

Usage:
  node zai-companion.mjs setup [--reset] [--key <api-key>]
  node zai-companion.mjs ask <message...>
  node zai-companion.mjs code     [--background|--wait] [--model <m>] <task...>
  node zai-companion.mjs review   [--background|--wait] [--base <ref>] [focus...]
  node zai-companion.mjs consult  [--background|--wait] <topic...>
  node zai-companion.mjs status   [job-id]
  node zai-companion.mjs result   <job-id>
  node zai-companion.mjs cancel   <job-id>

Default model mapping (Z.AI Coding Plan):
  ask      -> glm-4.5-air   (fast single-shot Q&A)
  code     -> glm-5.1       (latest flagship coding model)
  review   -> glm-5.1
  consult  -> glm-5.1
Per-mode overrides go in ~/.config/zai-plugin-cc/config.json under "models".
Per-call override: --model <id>   (e.g. glm-4.7, glm-5-turbo, glm-5)

Env:
  ZAI_API_KEY         Override stored API key
  ZAI_BASE_URL        Override base URL (default https://api.z.ai/api/anthropic)
  ZAI_DEFAULT_MODEL   Override model for code/review/consult (default glm-5.1)
  ZAI_LIGHT_MODEL     Override model for ask (default glm-4.5-air)
  ZAI_DEBUG=1         Trace HTTP requests
`;

function fmtElapsed(start, end) {
  if (!start) return '-';
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  const ms = Math.max(0, e - s);
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function elapsedMs(start, end) {
  if (!start) return 0;
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  return Math.max(0, e - s);
}

function xmlAttr(value) {
  // Defensive escape for the model id, job id, and small number-like attrs.
  // None of these should ever contain XML metacharacters but the cost of
  // escaping is trivial and prevents downstream parsing surprises.
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Standard machine-readable response envelope. Claude Code reads this raw
// and pulls out only the body — no human chrome (model footer, separator
// dashes) lands in its context. Set --human to restore the legacy footer
// for terminal users.
function emitResponse({ body, model, jobId, kind, elapsedMs: ms, usage, human }) {
  if (human) {
    process.stdout.write((body ?? '') + '\n');
    process.stdout.write(`\n— glm/${model} · ${ms < 1000 ? ms + 'ms' : (ms/1000).toFixed(1) + 's'} · job ${jobId}\n`);
    return;
  }
  const usageAttr = usage && usage.input_tokens != null && usage.output_tokens != null
    ? ` input_tokens="${xmlAttr(usage.input_tokens)}" output_tokens="${xmlAttr(usage.output_tokens)}"` : '';
  process.stdout.write(
    `<zai_response kind="${xmlAttr(kind)}" model="${xmlAttr(model)}" job_id="${xmlAttr(jobId)}" elapsed_ms="${xmlAttr(ms)}"${usageAttr}>\n` +
    (body ?? '') +
    `\n</zai_response>\n`
  );
}

function emitError({ kind, status, message, jobId, human }) {
  if (human) {
    process.stderr.write(`✗ ${message}\n`);
    if (jobId) process.stderr.write(`  job ${jobId}\n`);
    return;
  }
  const idAttr = jobId ? ` job_id="${xmlAttr(jobId)}"` : '';
  const statusAttr = status != null ? ` status="${xmlAttr(status)}"` : '';
  process.stderr.write(
    `<zai_error kind="${xmlAttr(kind)}"${statusAttr}${idAttr}>\n` +
    (message ?? '') +
    `\n</zai_error>\n`
  );
}

async function cmdSetup(argv) {
  const { flags } = parseFlags(argv);
  if (flags.reset) {
    await config.reset();
    console.log('✓ Config removed.');
    return 0;
  }

  let apiKey = flags.key;
  if (!apiKey) {
    const env = config.fromEnv();
    if (env?.api_key) {
      apiKey = env.api_key;
      console.log('Using API key from environment.');
    }
  }

  if (!apiKey) {
    if (!input.isTTY) {
      console.error('No API key provided. Pass --key <key> or set ZAI_API_KEY.');
      console.error('Get one at: https://z.ai/model-api');
      return 2;
    }
    const rl = createInterface({ input, output });
    apiKey = (await rl.question('Z.AI API key (https://z.ai/model-api): ')).trim();
    rl.close();
  }
  if (!apiKey) {
    console.error('Empty key. Aborting.');
    return 2;
  }

  const baseDefaults = config.defaults();
  const baseUrl = process.env.ZAI_BASE_URL || baseDefaults.base_url;

  process.stdout.write('Verifying key against Z.AI Anthropic-compat surface...\n');
  const verdict = await client.verifyKey({ apiKey, baseUrl, model: baseDefaults.light_model });
  if (!verdict.ok) {
    console.error(`✗ Verification failed (HTTP ${verdict.status}): ${verdict.detail}`);
    console.error('  Key NOT saved.');
    if (verdict.status === 401 || verdict.status === 403) {
      console.error('  Hint: regenerate the key at https://z.ai/model-api');
    } else if (verdict.body?.error?.code === '1113') {
      console.error('  Hint: Coding Pro plan quota covers only the /api/anthropic endpoint.');
    }
    return 1;
  }

  // Preserve any user customization that already lived in the config file.
  const existing = (await config.load()) || {};
  await config.save({ ...baseDefaults, ...existing, api_key: apiKey, base_url: baseUrl });
  console.log(`✓ Key saved to ${config.configPath()} (mode 0600)`);
  console.log(`✓ Key accepted (probe model: ${verdict.model}).`);

  let models = [];
  try {
    models = await client.listModels({ apiKey, baseUrl });
  } catch {}
  if (models.length) {
    const sample = models.slice(0, 10).join(', ');
    console.log(`✓ Known models: ${sample}${models.length > 10 ? ` ... (+${models.length - 10})` : ''}`);
  }
  return 0;
}

async function cmdAsk(argv) {
  const { flags, positional } = parseFlags(argv);
  const question = positional.join(' ').trim();
  if (!question) {
    emitError({ kind: 'usage', message: 'Usage: ask <message>', human: flags.human });
    return 2;
  }
  try {
    const { job, out } = await runner.runForeground({
      kind: 'ask',
      messages: prompts.buildAsk(question),
      requestSummary: { question },
      model: flags.model,
    });
    emitResponse({
      body: out.text,
      model: out.model,
      jobId: job.id,
      kind: 'ask',
      elapsedMs: elapsedMs(job.started_at, job.ended_at),
      usage: out.usage,
      human: flags.human,
    });
    return 0;
  } catch (err) {
    emitError({
      kind: err.kind || 'runtime',
      status: err.status,
      message: err.message,
      jobId: err.jobId,
      human: flags.human,
    });
    return 1;
  }
}

async function dispatchTask(kind, argv, builder) {
  const { flags, positional } = parseFlags(argv);
  let body = positional.join(' ').trim();
  let extraContext = null;

  if (kind === 'review') {
    const base = flags.base || null;
    body = base ? `Review against base ${base}.` : 'Review the working tree changes.';
    try {
      let diff = '';
      if (base) {
        diff = execSync(`git diff ${base}...HEAD`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      } else {
        diff = execSync('git diff --no-color', { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
        const cached = execSync('git diff --no-color --cached', { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
        if (cached) diff += `\n\n--- staged ---\n${cached}`;
      }
      if (!diff.trim()) {
        emitError({ kind: 'no_diff', message: 'No git diff to review.', human: flags.human });
        return 1;
      }
      extraContext = diff;
    } catch (err) {
      emitError({ kind: 'diff_failed', message: `Failed to collect diff: ${err.message}`, human: flags.human });
      return 1;
    }
  } else if (!body) {
    emitError({ kind: 'usage', message: `Usage: ${kind} <input>`, human: flags.human });
    return 2;
  }

  const messages = builder(body, extraContext);
  const requestSummary = { kind, body, base: flags.base ?? null };

  if (flags.background) {
    try {
      const { jobId, model } = await runner.runBackground({
        kind,
        messages,
        requestSummary,
        model: flags.model,
      });
      // Background dispatch: emit a tiny envelope carrying just the job id
      // and the model so Claude knows what to poll. No human chrome.
      if (flags.human) {
        process.stdout.write(`job-id: ${jobId} (background, ${model})\n`);
        process.stdout.write('Check `/zai:status` or `/zai:result <id>`.\n');
      } else {
        process.stdout.write(
          `<zai_dispatched kind="${xmlAttr(kind)}" model="${xmlAttr(model)}" job_id="${xmlAttr(jobId)}" mode="background"/>\n`
        );
      }
      return 0;
    } catch (err) {
      emitError({
        kind: err.kind || 'runtime',
        status: err.status,
        message: err.message,
        jobId: err.jobId,
        human: flags.human,
      });
      return 1;
    }
  }

  try {
    const { job, out } = await runner.runForeground({
      kind,
      messages,
      requestSummary,
      model: flags.model,
    });
    emitResponse({
      body: out.text,
      model: out.model,
      jobId: job.id,
      kind,
      elapsedMs: elapsedMs(job.started_at, job.ended_at),
      usage: out.usage,
      human: flags.human,
    });
    return 0;
  } catch (err) {
    emitError({
      kind: err.kind || 'runtime',
      status: err.status,
      message: err.message,
      jobId: err.jobId,
      human: flags.human,
    });
    return 1;
  }
}

async function cmdStatus(argv) {
  const { flags, positional } = parseFlags(argv);
  if (positional[0]) {
    const j = await jobs.get(positional[0]);
    if (!j) {
      emitError({ kind: 'not_found', message: `job not found: ${positional[0]}`, jobId: positional[0], human: flags.human });
      return 1;
    }
    // Status reads of a single job emit JSON either way — it's already
    // machine-friendly and the data is exactly what callers need.
    process.stdout.write(JSON.stringify(j, null, flags.human ? 2 : 0) + '\n');
    return 0;
  }
  const all = await jobs.list({});
  if (!all.length) {
    if (flags.human) process.stdout.write('(no jobs)\n');
    else process.stdout.write('<zai_jobs count="0"/>\n');
    return 0;
  }
  if (flags.human) {
    const rows = all.slice(0, 20).map(j => (
      `${j.id}  ${(j.kind || '').padEnd(7)} ${(j.status || '').padEnd(9)} ${(j.model || '').padEnd(14)} ${fmtElapsed(j.started_at, j.ended_at)}`
    ));
    process.stdout.write('id'.padEnd(28) + 'kind   status    model         elapsed\n');
    process.stdout.write(rows.join('\n') + '\n');
    return 0;
  }
  // Compact JSON envelope: each row is one line, keys ordered for stable
  // diffs in test snapshots.
  const compact = all.slice(0, 20).map(j => ({
    id: j.id,
    kind: j.kind,
    status: j.status,
    model: j.model,
    started_at: j.started_at,
    ended_at: j.ended_at,
    bg: !!j.bg,
  }));
  process.stdout.write(`<zai_jobs count="${all.length}" shown="${compact.length}">\n`);
  for (const r of compact) process.stdout.write(JSON.stringify(r) + '\n');
  process.stdout.write('</zai_jobs>\n');
  return 0;
}

async function cmdResult(argv) {
  const { flags, positional } = parseFlags(argv);
  const id = positional[0];
  if (!id) { emitError({ kind: 'usage', message: 'Usage: result <job-id>', human: flags.human }); return 2; }
  const j = await jobs.get(id);
  if (!j) { emitError({ kind: 'not_found', message: `job not found: ${id}`, jobId: id, human: flags.human }); return 1; }
  if (j.status === 'running') {
    if (flags.human) process.stdout.write(`job ${id} still running (pid ${j.pid}). Try again shortly.\n`);
    else process.stdout.write(`<zai_pending kind="${xmlAttr(j.kind)}" job_id="${xmlAttr(id)}" model="${xmlAttr(j.model)}"/>\n`);
    return 0;
  }
  if (j.status === 'error') {
    emitError({
      kind: 'job_failed',
      message: j.error || 'job ended with error',
      jobId: id,
      human: flags.human,
    });
    return 1;
  }
  if (j.status === 'cancelled') {
    if (flags.human) process.stdout.write(`job ${id} was cancelled.\n`);
    else process.stdout.write(`<zai_cancelled job_id="${xmlAttr(id)}"/>\n`);
    return 0;
  }
  emitResponse({
    body: j.result ?? '',
    model: j.model,
    jobId: j.id,
    kind: j.kind,
    elapsedMs: elapsedMs(j.started_at, j.ended_at),
    usage: j.usage,
    human: flags.human,
  });
  return 0;
}

async function cmdCancel(argv) {
  const { flags, positional } = parseFlags(argv);
  const id = positional[0];
  if (!id) { emitError({ kind: 'usage', message: 'Usage: cancel <job-id>', human: flags.human }); return 2; }
  try {
    const j = await jobs.cancel(id);
    if (flags.human) process.stdout.write(`✓ ${id} → ${j.status}\n`);
    else process.stdout.write(`<zai_cancelled job_id="${xmlAttr(id)}" status="${xmlAttr(j.status)}"/>\n`);
    return 0;
  } catch (err) {
    emitError({
      kind: 'cancel_failed',
      message: err.message,
      jobId: id,
      human: flags.human,
    });
    return 1;
  }
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd || cmd === '-h' || cmd === '--help') {
    process.stdout.write(HELP);
    return 0;
  }

  // Best-effort GC of old jobs on every entry. Reconciliation of stale
  // 'running' records does NOT run here: a fresh background job has a brief
  // window between create() and the parent's pid stamp, and a reconcile
  // pass landing inside that window would falsely flip the new job to
  // 'error/orphaned'. The kill guard inside `cancel` itself already keeps
  // stale records from triggering the broadcast bug; full reconcile is
  // deferred to the SessionEnd hook (see `__reconcile`).
  jobs.gcOlderThanDays(14).catch(() => {});

  switch (cmd) {
    case 'setup':   return cmdSetup(rest);
    case 'ask':     return cmdAsk(rest);
    case 'code':    return dispatchTask('code', rest, prompts.buildCode);
    case 'review':  return dispatchTask('review', rest, prompts.buildReview);
    case 'consult': return dispatchTask('consult', rest, prompts.buildConsult);
    case 'status':  return cmdStatus(rest);
    case 'result':  return cmdResult(rest);
    case 'cancel':  return cmdCancel(rest);
    case '__worker': {
      const id = rest[0];
      if (!id) { console.error('worker: missing job id'); return 2; }
      await runner.runWorker(id);
      return 0;
    }
    case '__reconcile': {
      // Internal entrypoint for the SessionEnd hook. Flips orphaned 'running'
      // job records to status='error' so a later cancel cannot signal a
      // recycled pid. Always exits 0 — hook output is ignored either way.
      await jobs.reconcileStale().catch(() => {});
      return 0;
    }
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
      return 2;
  }
}

main().then(code => process.exit(code ?? 0)).catch(err => {
  if (err instanceof FlagError) {
    console.error(`✗ ${err.message}`);
    process.exit(2);
  }
  console.error(`✗ fatal: ${err.stack || err.message}`);
  process.exit(1);
});
