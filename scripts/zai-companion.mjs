#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import * as config from './lib/config.mjs';
import * as client from './lib/client.mjs';
import * as jobs from './lib/jobs.mjs';
import * as runner from './lib/runner.mjs';
import * as prompts from './lib/prompts.mjs';

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

Env:
  ZAI_API_KEY         Override stored API key
  ZAI_BASE_URL        Override base URL (default https://api.z.ai/api/paas/v4)
  ZAI_DEFAULT_MODEL   Default model for code/review/consult (default glm-4.6)
  ZAI_LIGHT_MODEL     Default model for ask (default glm-4.5-air)
  ZAI_DEBUG=1         Trace HTTP requests
`;

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--background') flags.background = true;
    else if (a === '--wait') flags.wait = true;
    else if (a === '--model') flags.model = argv[++i];
    else if (a === '--base') flags.base = argv[++i];
    else if (a === '--key') flags.key = argv[++i];
    else if (a === '--reset') flags.reset = true;
    else if (a === '--json') flags.json = true;
    else positional.push(a);
  }
  return { flags, positional };
}

function fmtElapsed(start, end) {
  if (!start) return '-';
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  const ms = Math.max(0, e - s);
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
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

  process.stdout.write('Verifying key against Z.AI...\n');
  let models = [];
  try {
    models = await client.listModels({ apiKey, baseUrl });
  } catch (err) {
    console.error(`✗ Verification failed: ${err.message}`);
    console.error('  (key NOT saved)');
    return 1;
  }

  await config.save({ ...baseDefaults, api_key: apiKey, base_url: baseUrl });
  console.log(`✓ Key saved to ${config.configPath()} (mode 0600)`);
  if (models.length) {
    const sample = models.slice(0, 8).join(', ');
    console.log(`✓ Available models: ${sample}${models.length > 8 ? ` ... (+${models.length - 8})` : ''}`);
  } else {
    console.log('✓ Key accepted (no model list returned).');
  }
  return 0;
}

async function cmdAsk(argv) {
  const { positional } = parseFlags(argv);
  const question = positional.join(' ').trim();
  if (!question) {
    console.error('Usage: ask <message>');
    return 2;
  }
  try {
    const { job, out } = await runner.runForeground({
      kind: 'ask',
      messages: prompts.buildAsk(question),
      requestSummary: { question },
    });
    process.stdout.write(out.text + '\n');
    process.stdout.write(`\n— glm/${out.model} · ${fmtElapsed(job.started_at)} · job ${job.id}\n`);
    return 0;
  } catch (err) {
    console.error(`✗ ${err.message}`);
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
        console.error('No git diff to review.');
        return 1;
      }
      extraContext = diff;
    } catch (err) {
      console.error(`✗ Failed to collect diff: ${err.message}`);
      return 1;
    }
  } else if (!body) {
    console.error(`Usage: ${kind} <input>`);
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
      console.log(`job-id: ${jobId} (background, ${model})`);
      console.log('Check `/zai:status` or `/zai:result <id>`.');
      return 0;
    } catch (err) {
      console.error(`✗ ${err.message}`);
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
    process.stdout.write(out.text + '\n');
    process.stdout.write(`\n— glm/${out.model} · ${fmtElapsed(job.started_at)} · job ${job.id}\n`);
    return 0;
  } catch (err) {
    console.error(`✗ ${err.message}`);
    return 1;
  }
}

async function cmdStatus(argv) {
  const { positional } = parseFlags(argv);
  if (positional[0]) {
    const j = await jobs.get(positional[0]);
    if (!j) { console.error(`job not found: ${positional[0]}`); return 1; }
    console.log(JSON.stringify(j, null, 2));
    return 0;
  }
  const all = await jobs.list({});
  if (!all.length) { console.log('(no jobs)'); return 0; }
  const rows = all.slice(0, 20).map(j => {
    return `${j.id}  ${j.kind.padEnd(7)} ${j.status.padEnd(9)} ${j.model.padEnd(14)} ${fmtElapsed(j.started_at, j.ended_at)}`;
  });
  console.log('id'.padEnd(28) + 'kind   status    model         elapsed');
  console.log(rows.join('\n'));
  return 0;
}

async function cmdResult(argv) {
  const { positional } = parseFlags(argv);
  const id = positional[0];
  if (!id) { console.error('Usage: result <job-id>'); return 2; }
  const j = await jobs.get(id);
  if (!j) { console.error(`job not found: ${id}`); return 1; }
  if (j.status === 'running') {
    console.log(`job ${id} still running (pid ${j.pid}). Try again shortly.`);
    return 0;
  }
  if (j.status === 'error') {
    console.error(`job ${id} errored: ${j.error}`);
    return 1;
  }
  if (j.status === 'cancelled') {
    console.log(`job ${id} was cancelled.`);
    return 0;
  }
  process.stdout.write((j.result ?? '') + '\n');
  process.stdout.write(`\n— glm/${j.model} · ${fmtElapsed(j.started_at, j.ended_at)} · job ${j.id}\n`);
  return 0;
}

async function cmdCancel(argv) {
  const { positional } = parseFlags(argv);
  const id = positional[0];
  if (!id) { console.error('Usage: cancel <job-id>'); return 2; }
  try {
    const j = await jobs.cancel(id);
    console.log(`✓ ${id} → ${j.status}`);
    return 0;
  } catch (err) {
    console.error(`✗ ${err.message}`);
    return 1;
  }
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd || cmd === '-h' || cmd === '--help') {
    process.stdout.write(HELP);
    return 0;
  }

  // Best-effort GC of old jobs on every entry
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
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
      return 2;
  }
}

main().then(code => process.exit(code ?? 0)).catch(err => {
  console.error(`✗ fatal: ${err.stack || err.message}`);
  process.exit(1);
});
