// Comprehensive test suite for zai-plugin-cc.
//
// Coverage:
//   - Unit tests: parseFlags, prompts, config (save/load/migrate), jobs lifecycle.
//   - Live integration: client.verifyKey, client.chat, runner foreground/background,
//                       companion CLI dispatch, error paths.
//
// Live tests require a real Z.AI key. Pass it via ZAI_API_KEY in the env. If
// the key is missing, live tests are skipped (with a visible note) and unit
// tests still run. Tests that exercise the real API use glm-4.5-air for cost
// containment.
//
// Each test runs in an isolated tmp dir (ZAI_CONFIG_DIR + ZAI_JOBS_DIR) so
// it never touches the user's real config or repo.

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';

import { parseFlags, FlagError } from '../scripts/lib/flags.mjs';
import * as prompts from '../scripts/lib/prompts.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const COMPANION = path.join(ROOT, 'scripts', 'zai-companion.mjs');

const HAS_KEY = !!(process.env.ZAI_API_KEY || process.env.ZAI_TOKEN);
const TEST_LIGHT_MODEL = process.env.ZAI_TEST_LIGHT_MODEL || 'glm-4.5-air';

// ---- mini test harness ---------------------------------------------------

const results = [];
let activeTmpDirs = [];

function makeTmp(prefix = 'zai-test-') {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  activeTmpDirs.push(dir);
  return dir;
}

function cleanup() {
  for (const d of activeTmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
  activeTmpDirs = [];
}

async function test(name, fn, { live = false } = {}) {
  if (live && !HAS_KEY) {
    results.push({ name, status: 'skip', reason: 'no ZAI_API_KEY' });
    return;
  }
  const start = Date.now();
  try {
    await fn();
    results.push({ name, status: 'pass', ms: Date.now() - start });
  } catch (err) {
    results.push({
      name,
      status: 'fail',
      ms: Date.now() - start,
      message: err.message,
      stack: err.stack,
    });
  }
}

function runCompanion(args, env = {}) {
  const res = spawnSync(process.execPath, [COMPANION, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { code: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function spawnCompanion(args, env = {}) {
  return spawn(process.execPath, [COMPANION, ...args], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function readUntilExit(child) {
  let out = '', err = '';
  child.stdout.on('data', d => { out += d.toString(); });
  child.stderr.on('data', d => { err += d.toString(); });
  const code = await new Promise(resolve => child.on('exit', resolve));
  return { code, stdout: out, stderr: err };
}

// ---- Unit tests: parseFlags ---------------------------------------------

await test('parseFlags: bare positional', () => {
  const { flags, positional } = parseFlags(['hello', 'world']);
  assert.deepEqual(flags, {});
  assert.deepEqual(positional, ['hello', 'world']);
});

await test('parseFlags: --background --wait booleans', () => {
  const { flags, positional } = parseFlags(['--background', 'task', '--wait']);
  assert.equal(flags.background, true);
  assert.equal(flags.wait, true);
  assert.deepEqual(positional, ['task']);
});

await test('parseFlags: --model glm-4.6 (space form)', () => {
  const { flags } = parseFlags(['--model', 'glm-4.6', 'do thing']);
  assert.equal(flags.model, 'glm-4.6');
});

await test('parseFlags: --model=glm-4.6 (= form)', () => {
  const { flags } = parseFlags(['--model=glm-4.6']);
  assert.equal(flags.model, 'glm-4.6');
});

await test('parseFlags: --base main passthrough', () => {
  const { flags } = parseFlags(['--base', 'main']);
  assert.equal(flags.base, 'main');
});

await test('parseFlags: empty string is ignored (slash-command $ARGUMENTS empty)', () => {
  const { flags, positional } = parseFlags(['', 'real', '']);
  assert.deepEqual(flags, {});
  assert.deepEqual(positional, ['real']);
});

await test('parseFlags: unknown flag rejected', () => {
  assert.throws(() => parseFlags(['--foo', 'x']), FlagError);
});

await test('parseFlags: --model with no value rejected', () => {
  assert.throws(() => parseFlags(['--model']), FlagError);
});

await test('parseFlags: --model followed by another flag rejected', () => {
  assert.throws(() => parseFlags(['--model', '--wait']), FlagError);
});

await test('parseFlags: bool flag with value rejected', () => {
  assert.throws(() => parseFlags(['--background=true']), FlagError);
});

await test('parseFlags: --key=value', () => {
  const { flags } = parseFlags(['--key=sk-xxxxx']);
  assert.equal(flags.key, 'sk-xxxxx');
});

// ---- Unit tests: prompts -------------------------------------------------

await test('prompts.buildAsk produces system + user with no-preamble anchor', () => {
  const m = prompts.buildAsk('hello');
  assert.equal(m.length, 2);
  assert.equal(m[0].role, 'system');
  assert.equal(m[1].role, 'user');
  assert.match(m[0].content, /Mode: ASK/);
  assert.match(m[0].content, /NO preamble/i);
  assert.match(m[0].content, /3 short bullets/);
  assert.equal(m[1].content, 'hello');
});

await test('prompts.buildCode mandates the <zai_edit> apply format', () => {
  const m = prompts.buildCode('refactor', 'context-blob');
  assert.match(m[0].content, /Mode: CODE/);
  // The system prompt must spell out the three ops and the aider markers
  // verbatim, so GLM emits exactly what commands/code.md parses.
  assert.match(m[0].content, /<zai_edit path=/);
  assert.match(m[0].content, /op="edit"/);
  assert.match(m[0].content, /op="create"/);
  assert.match(m[0].content, /op="delete"/);
  assert.match(m[0].content, /<<<<<<< SEARCH/);
  assert.match(m[0].content, />>>>>>> REPLACE/);
  assert.match(m[0].content, /<<<<<<< CREATE/);
  assert.match(m[0].content, />>>>>>> END/);
  assert.match(m[0].content, /<zai_clarify>/);
  // The code-mode override must explicitly forbid bare fenced blocks
  // (BASE allows them for prose modes; code mode only emits <zai_edit>).
  assert.match(m[0].content, /NO fenced code blocks outside <zai_edit>/);
  assert.match(m[0].content, /Speak in patches, not in prose/);
  // User content still carries the context blob.
  assert.equal(m[1].role, 'user');
  assert.match(m[1].content, /context-blob/);
});

await test('prompts.buildReview pins exact section headers', () => {
  const m = prompts.buildReview('--- diff text ---', 'race conditions');
  // The section names are now real H2 headers, not a sentence.
  assert.match(m[1].content, /## Bugs/);
  assert.match(m[1].content, /## Security/);
  assert.match(m[1].content, /## Style\/Maintainability/);
  assert.match(m[1].content, /## Tests/);
  assert.match(m[1].content, /diff text/);
  assert.match(m[1].content, /Extra focus: race conditions/);
});

await test('prompts.buildConsult pins Options/Tradeoffs/Recommendation', () => {
  const m = prompts.buildConsult('SSE vs queue');
  assert.match(m[0].content, /Mode: CONSULT/);
  assert.match(m[0].content, /## Options/);
  assert.match(m[0].content, /## Tradeoffs/);
  assert.match(m[0].content, /## Recommendation/);
});

// ---- Unit tests: config (with isolated tmp dir) -------------------------

await test('config: save -> load roundtrip', async () => {
  const dir = makeTmp('zai-cfg-');
  process.env.ZAI_CONFIG_DIR = dir;
  delete process.env.ZAI_API_KEY;
  delete process.env.ZAI_TOKEN;
  const cfg = await import('../scripts/lib/config.mjs?cfg=' + Date.now());
  await cfg.save({ api_key: 'sk-test', base_url: 'https://example/api/anthropic' });
  const loaded = await cfg.load();
  assert.equal(loaded.api_key, 'sk-test');
  assert.equal(loaded.base_url, 'https://example/api/anthropic');
  // file mode should be 0600
  const stat = await fs.stat(path.join(dir, 'config.json'));
  assert.equal(stat.mode & 0o777, 0o600);
});

await test('config: migrates legacy /paas/v4 to /anthropic and to v4', async () => {
  const dir = makeTmp('zai-cfg-mig-');
  process.env.ZAI_CONFIG_DIR = dir;
  await fs.writeFile(
    path.join(dir, 'config.json'),
    JSON.stringify({ version: 1, api_key: 'sk-x', base_url: 'https://api.z.ai/api/paas/v4' }),
  );
  const cfg = await import('../scripts/lib/config.mjs?mig=' + Date.now());
  const loaded = await cfg.load();
  assert.equal(loaded.base_url, 'https://api.z.ai/api/anthropic');
  assert.equal(loaded.version, 4);
  assert.ok(loaded.models && loaded.models.code, 'v3 must populate per-mode model map');
  assert.ok(loaded.params && loaded.params.code, 'v4 must populate per-mode param map');
});

await test('config: v2 -> v3 preserves user-picked default_model', async () => {
  // A user who deliberately chose glm-4.6 in v2 should not be silently
  // upgraded to glm-5.1 by the migration. Their pick must propagate into
  // the new per-mode map.
  const dir = makeTmp('zai-cfg-v2-');
  process.env.ZAI_CONFIG_DIR = dir;
  delete process.env.ZAI_API_KEY;
  delete process.env.ZAI_TOKEN;
  delete process.env.ZAI_DEFAULT_MODEL;
  delete process.env.ZAI_LIGHT_MODEL;
  await fs.writeFile(
    path.join(dir, 'config.json'),
    JSON.stringify({
      version: 2,
      api_key: 'sk-x',
      base_url: 'https://api.z.ai/api/anthropic',
      default_model: 'glm-4.6',
      light_model: 'glm-4.5-air',
    }),
  );
  const cfg = await import('../scripts/lib/config.mjs?v2=' + Date.now());
  const loaded = await cfg.load();
  assert.equal(loaded.version, 4);
  assert.equal(loaded.models.code, 'glm-4.6');
  assert.equal(loaded.models.review, 'glm-4.6');
  assert.equal(loaded.models.consult, 'glm-4.6');
  assert.equal(loaded.models.ask, 'glm-4.5-air');
});

await test('config: fresh install picks glm-5.1 / glm-4.5-air defaults', async () => {
  const dir = makeTmp('zai-cfg-fresh-');
  process.env.ZAI_CONFIG_DIR = dir;
  delete process.env.ZAI_API_KEY;
  delete process.env.ZAI_TOKEN;
  delete process.env.ZAI_DEFAULT_MODEL;
  delete process.env.ZAI_LIGHT_MODEL;
  const cfg = await import('../scripts/lib/config.mjs?fresh=' + Date.now());
  await cfg.save({ api_key: 'sk-fresh' });
  const loaded = await cfg.load();
  assert.equal(loaded.models.code, 'glm-5.1');
  assert.equal(loaded.models.review, 'glm-5.1');
  assert.equal(loaded.models.consult, 'glm-5.1');
  assert.equal(loaded.models.ask, 'glm-4.5-air');
});

await test('config: env var overrides stored', async () => {
  const dir = makeTmp('zai-cfg-env-');
  process.env.ZAI_CONFIG_DIR = dir;
  process.env.ZAI_API_KEY = 'sk-env';
  await fs.writeFile(
    path.join(dir, 'config.json'),
    JSON.stringify({ api_key: 'sk-stored', base_url: 'https://api.z.ai/api/anthropic' }),
  );
  const cfg = await import('../scripts/lib/config.mjs?env=' + Date.now());
  const loaded = await cfg.load();
  assert.equal(loaded.api_key, 'sk-env');
  delete process.env.ZAI_API_KEY;
});

await test('runner.pickModel: --model override wins', async () => {
  const { pickModel } = await import('../scripts/lib/runner.mjs?pm1=' + Date.now());
  const cfg = { models: { code: 'glm-5.1', ask: 'glm-4.5-air' }, default_model: 'glm-5.1', light_model: 'glm-4.5-air' };
  assert.equal(pickModel(cfg, 'glm-4.7', 'code'), 'glm-4.7');
  assert.equal(pickModel(cfg, 'glm-5-turbo', 'ask'), 'glm-5-turbo');
});

await test('runner.pickModel: per-mode map routes code -> 5.1, ask -> 4.5-air', async () => {
  const { pickModel } = await import('../scripts/lib/runner.mjs?pm2=' + Date.now());
  const cfg = {
    models: { code: 'glm-5.1', review: 'glm-5.1', consult: 'glm-5.1', ask: 'glm-4.5-air' },
    default_model: 'glm-5.1',
    light_model: 'glm-4.5-air',
  };
  assert.equal(pickModel(cfg, null, 'code'), 'glm-5.1');
  assert.equal(pickModel(cfg, null, 'review'), 'glm-5.1');
  assert.equal(pickModel(cfg, null, 'consult'), 'glm-5.1');
  assert.equal(pickModel(cfg, null, 'ask'), 'glm-4.5-air');
});

await test('runner.pickModel: legacy config without models map still resolves', async () => {
  const { pickModel } = await import('../scripts/lib/runner.mjs?pm3=' + Date.now());
  const legacy = { default_model: 'glm-4.6', light_model: 'glm-4.5-air' };
  assert.equal(pickModel(legacy, null, 'code'), 'glm-4.6');
  assert.equal(pickModel(legacy, null, 'ask'), 'glm-4.5-air');
});

await test('runner.pickParams: each mode has its tuned hyperparameters', async () => {
  const { pickParams } = await import('../scripts/lib/runner.mjs?pp1=' + Date.now());
  const cfg = {
    params: {
      ask:     { temperature: 0.2, top_p: 0.8,  max_tokens: 512  },
      code:    { temperature: 0.2, top_p: 0.95, max_tokens: 8192 },
      review:  { temperature: 0.3, top_p: 0.9,  max_tokens: 4096 },
      consult: { temperature: 0.6, top_p: 0.95, max_tokens: 4096 },
    },
  };
  assert.deepEqual(pickParams(cfg, 'ask'),     { temperature: 0.2, top_p: 0.8,  max_tokens: 512  });
  assert.deepEqual(pickParams(cfg, 'code'),    { temperature: 0.2, top_p: 0.95, max_tokens: 8192 });
  assert.deepEqual(pickParams(cfg, 'review'),  { temperature: 0.3, top_p: 0.9,  max_tokens: 4096 });
  assert.deepEqual(pickParams(cfg, 'consult'), { temperature: 0.6, top_p: 0.95, max_tokens: 4096 });
});

await test('config: v3 -> v4 fills in params + stop_sequences', async () => {
  const dir = makeTmp('zai-cfg-v3-');
  process.env.ZAI_CONFIG_DIR = dir;
  delete process.env.ZAI_API_KEY;
  delete process.env.ZAI_TOKEN;
  delete process.env.ZAI_DEFAULT_MODEL;
  delete process.env.ZAI_LIGHT_MODEL;
  await fs.writeFile(
    path.join(dir, 'config.json'),
    JSON.stringify({
      version: 3,
      api_key: 'sk-x',
      base_url: 'https://api.z.ai/api/anthropic',
      models: { ask: 'glm-4.5-air', code: 'glm-4.6', review: 'glm-4.6', consult: 'glm-4.6' },
    }),
  );
  const cfg = await import('../scripts/lib/config.mjs?v3=' + Date.now());
  const loaded = await cfg.load();
  assert.equal(loaded.version, 4);
  // Existing model pick is preserved
  assert.equal(loaded.models.code, 'glm-4.6');
  // Tuned params now present
  assert.equal(loaded.params.ask.max_tokens, 512);
  assert.equal(loaded.params.code.max_tokens, 8192);
  assert.equal(loaded.params.code.temperature, 0.2);
  assert.equal(loaded.params.consult.temperature, 0.6);
  assert.ok(Array.isArray(loaded.stop_sequences));
  assert.ok(loaded.stop_sequences.includes('</zai_response>'));
});

await test('config: partial params override merges into per-mode map', async () => {
  const dir = makeTmp('zai-cfg-partparams-');
  process.env.ZAI_CONFIG_DIR = dir;
  delete process.env.ZAI_API_KEY;
  await fs.writeFile(
    path.join(dir, 'config.json'),
    JSON.stringify({
      version: 4,
      api_key: 'sk-x',
      base_url: 'https://api.z.ai/api/anthropic',
      models: { ask: 'glm-4.5-air', code: 'glm-5.1', review: 'glm-5.1', consult: 'glm-5.1' },
      // Only change one knob; the other knobs must keep their defaults.
      params: { code: { max_tokens: 12000 } },
    }),
  );
  const cfg = await import('../scripts/lib/config.mjs?pp=' + Date.now());
  const loaded = await cfg.load();
  assert.equal(loaded.params.code.max_tokens, 12000);
  assert.equal(loaded.params.code.temperature, 0.2); // untouched default
  assert.equal(loaded.params.code.top_p, 0.95);      // untouched default
});

await test('config: ZAI_DEFAULT_MODEL env steers per-mode map', async () => {
  const dir = makeTmp('zai-cfg-envmodel-');
  process.env.ZAI_CONFIG_DIR = dir;
  process.env.ZAI_API_KEY = 'sk-env';
  process.env.ZAI_DEFAULT_MODEL = 'glm-4.7';
  process.env.ZAI_LIGHT_MODEL = 'glm-4.5-air';
  const cfg = await import('../scripts/lib/config.mjs?envm=' + Date.now());
  const loaded = await cfg.load();
  assert.equal(loaded.models.code, 'glm-4.7');
  assert.equal(loaded.models.review, 'glm-4.7');
  assert.equal(loaded.models.consult, 'glm-4.7');
  assert.equal(loaded.models.ask, 'glm-4.5-air');
  delete process.env.ZAI_API_KEY;
  delete process.env.ZAI_DEFAULT_MODEL;
  delete process.env.ZAI_LIGHT_MODEL;
});

// ---- Unit tests: jobs (with isolated tmp dir) ---------------------------

await test('jobs: create -> get -> update -> list', async () => {
  const dir = makeTmp('zai-jobs-');
  process.env.ZAI_JOBS_DIR = dir;
  const jobs = await import('../scripts/lib/jobs.mjs?j=' + Date.now());
  const j = await jobs.create({ kind: 'ask', request: { q: 'hi' }, model: 'glm-4.5-air' });
  assert.equal(j.status, 'running');
  const got = await jobs.get(j.id);
  assert.equal(got.id, j.id);
  await jobs.update(j.id, { status: 'done', result: 'ok' });
  const after = await jobs.get(j.id);
  assert.equal(after.status, 'done');
  assert.equal(after.result, 'ok');
  const all = await jobs.list({});
  assert.ok(all.some(r => r.id === j.id));
});

await test('jobs: cancel sets status=cancelled without signaling unverified pid', async () => {
  const dir = makeTmp('zai-jobs-cancel-');
  process.env.ZAI_JOBS_DIR = dir;
  const jobs = await import('../scripts/lib/jobs.mjs?jc=' + Date.now());
  const j = await jobs.create({ kind: 'code', request: {}, model: 'glm-4.6', bg: true });
  // Earlier versions of this test injected pid:-1, which under the old
  // cancel() implementation called process.kill(-1, 'SIGTERM') and
  // broadcast SIGTERM to every process the test runner's user owned —
  // closing the entire desktop session. Use a known-dead pid instead and
  // confirm cancel refuses to signal anything that doesn't verify as
  // ours.
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  await new Promise(resolve => child.on('exit', resolve));
  await jobs.update(j.id, { pid: child.pid });
  const out = await jobs.cancel(j.id);
  assert.equal(out.status, 'cancelled');
});

await test('jobs: cancel refuses to signal pid 0 / -1 even if injected', async () => {
  const dir = makeTmp('zai-jobs-cancel-broadcast-');
  process.env.ZAI_JOBS_DIR = dir;
  const jobs = await import('../scripts/lib/jobs.mjs?jcb=' + Date.now());
  for (const badPid of [0, -1, 1, 1.5, 'abc']) {
    const j = await jobs.create({ kind: 'code', request: {}, model: 'glm-4.6', bg: true });
    await jobs.update(j.id, { pid: badPid });
    // If cancel ever forwarded these to process.kill the test runner would
    // be killed before the assertion ran. Reaching the next line proves
    // the guard short-circuited.
    const out = await jobs.cancel(j.id);
    assert.equal(out.status, 'cancelled');
  }
});

await test('jobs: reconcileStale flips orphaned running jobs to error', async () => {
  const dir = makeTmp('zai-jobs-reconcile-');
  process.env.ZAI_JOBS_DIR = dir;
  const jobs = await import('../scripts/lib/jobs.mjs?jr=' + Date.now());
  const j = await jobs.create({ kind: 'code', request: {}, model: 'glm-4.6', bg: true });
  // Stamp it with a freshly-dead pid; reconcile should flip it. The default
  // grace period would protect a job this young, so pass graceMs:0 to
  // exercise the orphan path without sleeping.
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  await new Promise(resolve => child.on('exit', resolve));
  await jobs.update(j.id, { pid: child.pid });
  const flipped = await jobs.reconcileStale({ graceMs: 0 });
  assert.ok(flipped >= 1);
  const after = await jobs.get(j.id);
  assert.equal(after.status, 'error');
  assert.match(after.error, /orphaned/);
});

await test('jobs: reconcileStale respects grace period for fresh jobs', async () => {
  const dir = makeTmp('zai-jobs-grace-');
  process.env.ZAI_JOBS_DIR = dir;
  const jobs = await import('../scripts/lib/jobs.mjs?jrg=' + Date.now());
  // Brand-new background job, no pid stamped yet — the exact window
  // reconcile must not touch.
  const j = await jobs.create({ kind: 'code', request: {}, model: 'glm-4.6', bg: true });
  const flipped = await jobs.reconcileStale(); // default 30s grace
  assert.equal(flipped, 0);
  const after = await jobs.get(j.id);
  assert.equal(after.status, 'running');
});

await test('jobs: finishIfRunning skips already-terminal records', async () => {
  const dir = makeTmp('zai-jobs-fin-');
  process.env.ZAI_JOBS_DIR = dir;
  const jobs = await import('../scripts/lib/jobs.mjs?jf=' + Date.now());
  const j = await jobs.create({ kind: 'code', request: {}, model: 'glm-4.6', bg: true });
  await jobs.update(j.id, { status: 'cancelled', ended_at: new Date().toISOString() });
  const out = await jobs.finishIfRunning(j.id, {
    status: 'done',
    result: 'should-not-stick',
    ended_at: new Date().toISOString(),
  });
  assert.equal(out.status, 'cancelled');
  assert.notEqual(out.result, 'should-not-stick');
});

await test('jobs: update is serialized under the per-id lock', async () => {
  const dir = makeTmp('zai-jobs-lock-');
  process.env.ZAI_JOBS_DIR = dir;
  const jobs = await import('../scripts/lib/jobs.mjs?jl=' + Date.now());
  const j = await jobs.create({ kind: 'code', request: {}, model: 'glm-4.6', bg: true });
  // 50 concurrent updates each appending one element to a JSON array. Without
  // the lock we'd see lost updates and end up with fewer than 50 entries.
  await Promise.all(Array.from({ length: 50 }, (_, i) =>
    jobs.update(j.id, { [`k${i}`]: i }),
  ));
  const after = await jobs.get(j.id);
  for (let i = 0; i < 50; i += 1) {
    assert.equal(after[`k${i}`], i, `lost update for k${i}`);
  }
});

await test('jobs: get(non-existent) returns null', async () => {
  const dir = makeTmp('zai-jobs-miss-');
  process.env.ZAI_JOBS_DIR = dir;
  const jobs = await import('../scripts/lib/jobs.mjs?jm=' + Date.now());
  const r = await jobs.get('nope');
  assert.equal(r, null);
});

// ---- Companion CLI: error paths (no key needed) -------------------------

await test('CLI: --help prints usage', () => {
  const { code, stdout } = runCompanion(['--help']);
  assert.equal(code, 0);
  assert.match(stdout, /zai-companion/);
});

await test('CLI: unknown subcommand exits 2', () => {
  const { code, stderr } = runCompanion(['totally-not-a-command']);
  assert.equal(code, 2);
  assert.match(stderr, /Unknown command/);
});

await test('CLI: ask with no body emits zai_error envelope (kind=usage)', () => {
  const tmpCfg = makeTmp('zai-noargs-');
  const { code, stderr } = runCompanion(['ask'], { ZAI_CONFIG_DIR: tmpCfg, ZAI_API_KEY: 'x' });
  assert.equal(code, 2);
  assert.match(stderr, /<zai_error\b[^>]*kind="usage"/);
  assert.match(stderr, /Usage: ask/);
  assert.match(stderr, /<\/zai_error>/);
});

await test('CLI: --human flag restores legacy stderr format', () => {
  const tmpCfg = makeTmp('zai-human-');
  const { code, stderr } = runCompanion(['ask', '--human'], { ZAI_CONFIG_DIR: tmpCfg, ZAI_API_KEY: 'x' });
  assert.equal(code, 2);
  assert.match(stderr, /^✗ /m);
  assert.doesNotMatch(stderr, /<zai_error/);
});

await test('CLI: unknown flag exits 2 (FlagError)', () => {
  const tmpCfg = makeTmp('zai-uflag-');
  const { code, stderr } = runCompanion(['ask', '--zz', 'x'], { ZAI_CONFIG_DIR: tmpCfg, ZAI_API_KEY: 'x' });
  assert.equal(code, 2);
  assert.match(stderr, /Unknown flag/);
});

await test('CLI: missing API key surfaces helpful message via envelope', () => {
  const tmpCfg = makeTmp('zai-nokey-');
  const env = { ZAI_CONFIG_DIR: tmpCfg };
  delete env.ZAI_API_KEY;
  delete env.ZAI_TOKEN;
  const res = spawnSync(process.execPath, [COMPANION, 'ask', 'hi'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /<zai_error/);
  assert.match(res.stderr, /API key|setup/i);
});

await test('client.redactProviderDetail: never echoes provider free-text', async () => {
  // The redacted public message must be a stable category sentence, not the
  // provider's detail string — that string can echo fragments of the user's
  // prompt.
  const c = await import('../scripts/lib/client.mjs?red=' + Date.now());
  // The redactor is module-private; verify via the public surface: simulate
  // a 401 by hitting an unreachable URL with a bad key. The thrown
  // ZaiApiError.message must not contain the provider's "detail" because
  // we never reach the provider, but the call should still classify as
  // network-kind without leaking anything either.
  await assert.rejects(
    () => c.chat({
      apiKey: 'sk-bogus',
      baseUrl: 'http://127.0.0.1:1', // closed port
      model: 'glm-4.5-air',
      messages: [{ role: 'user', content: 'PROMPT_THAT_MUST_NOT_LEAK_xyz123' }],
      maxTokens: 4,
      timeoutMs: 1500,
    }),
    err => {
      assert.ok(err.name === 'ZaiApiError');
      // Whatever path we took, the user's prompt fragment must NOT appear
      // in err.message — that's the field we persist on jobs.
      assert.doesNotMatch(err.message, /PROMPT_THAT_MUST_NOT_LEAK_xyz123/);
      return true;
    },
  );
});

// ---- Live: verifyKey -----------------------------------------------------

await test('live: client.verifyKey accepts the real key', async () => {
  const client = await import('../scripts/lib/client.mjs');
  const r = await client.verifyKey({
    apiKey: process.env.ZAI_API_KEY,
    baseUrl: 'https://api.z.ai/api/anthropic',
    model: TEST_LIGHT_MODEL,
  });
  assert.equal(r.ok, true);
}, { live: true });

await test('live: client.verifyKey rejects a bad key', async () => {
  const client = await import('../scripts/lib/client.mjs');
  const r = await client.verifyKey({
    apiKey: 'definitely-not-a-real-key',
    baseUrl: 'https://api.z.ai/api/anthropic',
    model: TEST_LIGHT_MODEL,
  });
  assert.equal(r.ok, false);
}, { live: true });

// ---- Live: client.chat round-trip ---------------------------------------

await test('live: client.chat returns text for ping', async () => {
  const client = await import('../scripts/lib/client.mjs');
  const out = await client.chat({
    apiKey: process.env.ZAI_API_KEY,
    baseUrl: 'https://api.z.ai/api/anthropic',
    model: TEST_LIGHT_MODEL,
    messages: [
      { role: 'system', content: 'Reply with exactly one word.' },
      { role: 'user', content: 'Reply: PING' },
    ],
    maxTokens: 16,
    timeoutMs: 60000,
  });
  assert.equal(typeof out.text, 'string');
  assert.ok(out.text.length > 0, 'expected non-empty text');
  assert.ok(out.usage && out.usage.input_tokens != null, 'expected usage tokens');
}, { live: true });

await test('live: client.chat surfaces auth error with kind=auth', async () => {
  const client = await import('../scripts/lib/client.mjs');
  await assert.rejects(
    () => client.chat({
      apiKey: 'totally-bogus',
      baseUrl: 'https://api.z.ai/api/anthropic',
      model: TEST_LIGHT_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 8,
      timeoutMs: 30000,
    }),
    err => err.name === 'ZaiApiError' && (err.kind === 'auth' || err.status === 401),
  );
}, { live: true });

// ---- Live: companion CLI E2E --------------------------------------------

await test('live: CLI setup --key persists config to tmp dir', async () => {
  const cfgDir = makeTmp('zai-live-setup-');
  const { code, stdout, stderr } = runCompanion(['setup', '--key', process.env.ZAI_API_KEY], {
    ZAI_CONFIG_DIR: cfgDir,
  });
  assert.equal(code, 0, `setup failed: ${stderr}`);
  assert.match(stdout, /Key saved/);
  const file = path.join(cfgDir, 'config.json');
  assert.ok(existsSync(file));
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(saved.base_url, 'https://api.z.ai/api/anthropic');
}, { live: true });

await test('live: CLI ask returns Z.AI text', async () => {
  const cfgDir = makeTmp('zai-live-ask-');
  const jobsDir = makeTmp('zai-live-ask-jobs-');
  const { code, stdout } = runCompanion(
    ['ask', '--model', TEST_LIGHT_MODEL, 'Reply with exactly: PONG'],
    { ZAI_CONFIG_DIR: cfgDir, ZAI_JOBS_DIR: jobsDir },
  );
  assert.equal(code, 0);
  assert.match(stdout, /PONG/i);
  assert.match(stdout, /glm\//);
}, { live: true });

await test('live: CLI background lifecycle (code -> status -> result)', async () => {
  const cfgDir = makeTmp('zai-live-bg-cfg-');
  const jobsDir = makeTmp('zai-live-bg-jobs-');
  const env = { ZAI_CONFIG_DIR: cfgDir, ZAI_JOBS_DIR: jobsDir };

  const launch = runCompanion(
    ['code', '--background', '--model', TEST_LIGHT_MODEL, 'Output exactly: HELLO'],
    env,
  );
  assert.equal(launch.code, 0);
  const m = launch.stdout.match(/job-id:\s*(\S+)/);
  assert.ok(m, 'expected job-id in launch stdout');
  const jobId = m[1];

  let status = 'running';
  for (let i = 0; i < 20 && status === 'running'; i += 1) {
    await wait(1500);
    const s = runCompanion(['status', jobId], env);
    try {
      const j = JSON.parse(s.stdout);
      status = j.status;
    } catch {}
  }
  assert.equal(status, 'done', `job did not finish; last status=${status}`);

  const r = runCompanion(['result', jobId], env);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /HELLO/);
}, { live: true });

await test('live: CLI cancel halts a running background job', async () => {
  const cfgDir = makeTmp('zai-live-cancel-cfg-');
  const jobsDir = makeTmp('zai-live-cancel-jobs-');
  const env = { ZAI_CONFIG_DIR: cfgDir, ZAI_JOBS_DIR: jobsDir };

  const launch = runCompanion(
    ['consult', '--background', '--model', TEST_LIGHT_MODEL, 'Write 5000 words on lattice theory.'],
    env,
  );
  const m = launch.stdout.match(/job-id:\s*(\S+)/);
  const jobId = m[1];

  await wait(200);
  const c = runCompanion(['cancel', jobId], env);
  assert.equal(c.code, 0);
  assert.match(c.stdout, /cancelled/);

  const s = runCompanion(['status', jobId], env);
  const j = JSON.parse(s.stdout);
  assert.ok(['cancelled', 'done', 'error'].includes(j.status));
}, { live: true });

// ---- report --------------------------------------------------------------

cleanup();

const pass = results.filter(r => r.status === 'pass').length;
const fail = results.filter(r => r.status === 'fail').length;
const skip = results.filter(r => r.status === 'skip').length;

for (const r of results) {
  const icon = r.status === 'pass' ? '✓' : r.status === 'fail' ? '✗' : '∘';
  const ms = r.ms != null ? `(${r.ms}ms)` : '';
  const reason = r.status === 'skip' ? `  [skip: ${r.reason}]` : '';
  console.log(`${icon} ${r.name} ${ms}${reason}`);
  if (r.status === 'fail') {
    console.log(`  ${r.message}`);
    if (process.env.ZAI_TEST_VERBOSE === '1' && r.stack) {
      console.log(r.stack.split('\n').slice(1).map(l => `    ${l}`).join('\n'));
    }
  }
}

console.log('');
console.log(`Total: ${results.length}  pass: ${pass}  fail: ${fail}  skip: ${skip}`);
if (!HAS_KEY) {
  console.log('(set ZAI_API_KEY to enable live tests)');
}
process.exit(fail === 0 ? 0 : 1);
