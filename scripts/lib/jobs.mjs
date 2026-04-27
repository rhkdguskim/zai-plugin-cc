import { promises as fs } from 'node:fs';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

function detectRepoRoot() {
  try {
    const out = execSync('git rev-parse --show-toplevel', {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    return out || process.cwd();
  } catch {
    return process.cwd();
  }
}

function jobsDir() {
  if (process.env.ZAI_JOBS_DIR) return process.env.ZAI_JOBS_DIR;
  const root = detectRepoRoot();
  if (root && root !== os.homedir()) return path.join(root, '.zai', 'jobs');
  return path.join(os.homedir(), '.zai', 'jobs');
}

function ensureDir() {
  const dir = jobsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function newId() {
  const ts = Date.now().toString(36).padStart(9, '0');
  const rand = crypto.randomBytes(6).toString('hex');
  return `${ts}-${rand}`;
}

function jobPath(id) {
  return path.join(jobsDir(), `${id}.json`);
}

async function atomicWrite(p, data) {
  const tmp = `${p}.tmp-${process.pid}`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, p);
}

// Per-job advisory lock. The companion's parent process and the detached
// worker both call `update()` for the same job. Without serialization the
// classic read-modify-write race loses updates: e.g. parent reads the
// freshly-created record, worker writes `{status:'done'}`, parent then
// writes back its old read with `{pid, started_at}` patched in — silently
// reverting status to 'running' and dropping the worker's result.
//
// Implementation: O_EXCL lockfile per job-id, with a short retry loop. If
// the holder appears wedged (lock older than the steal window), we unlink
// and retry rather than deadlock.
const LOCK_RETRY_MS = 20;
const LOCK_STEAL_AFTER_MS = 1500;

async function withJobLock(id, fn) {
  const lockPath = jobPath(id) + '.lock';
  const startedAt = Date.now();
  while (true) {
    let fh;
    try {
      fh = await fs.open(lockPath, 'wx');
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // Steal the lock if it has been held longer than the steal window —
      // the holder almost certainly died mid-update.
      try {
        const st = await fs.stat(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STEAL_AFTER_MS) {
          try { await fs.unlink(lockPath); } catch {}
        }
      } catch {}
      if (Date.now() - startedAt > LOCK_STEAL_AFTER_MS * 4) {
        // Give up waiting; proceed without lock to avoid hanging the CLI.
        return fn();
      }
      await new Promise(r => setTimeout(r, LOCK_RETRY_MS));
      continue;
    }
    try {
      return await fn();
    } finally {
      try { await fh.close(); } catch {}
      try { await fs.unlink(lockPath); } catch {}
    }
  }
}

// Internal-only: refuse to forward broadcast pid values to the kernel.
// Centralized so a future contributor can't reintroduce the broadcast bug
// by adding another `process.kill(...)` call site without thinking about
// pid<=1. Throws on pid<=1 even though the caller catches — the throw is
// the audit trail you want to see in logs if it ever happens.
function safeKill(pid, signal) {
  if (!Number.isInteger(pid) || pid <= 1) {
    throw new Error(`safeKill refused pid=${pid} (broadcast/init guard)`);
  }
  return process.kill(pid, signal);
}

export async function create({ kind, request, model, bg = false }) {
  ensureDir();
  const id = newId();
  const record = {
    id,
    kind,
    status: 'running',
    model,
    created_at: new Date().toISOString(),
    started_at: null,
    ended_at: null,
    request,
    result: null,
    error: null,
    bg,
    pid: null,
    usage: null,
  };
  await atomicWrite(jobPath(id), JSON.stringify(record, null, 2));
  return record;
}

export async function get(id) {
  try {
    const raw = await fs.readFile(jobPath(id), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function list({ activeOnly = false } = {}) {
  ensureDir();
  const entries = await fs.readdir(jobsDir());
  const records = [];
  for (const f of entries) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(jobsDir(), f), 'utf8');
      const r = JSON.parse(raw);
      if (activeOnly && r.status !== 'running') continue;
      records.push(r);
    } catch {}
  }
  records.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  return records;
}

export async function update(id, patch) {
  return withJobLock(id, async () => {
    const cur = await get(id);
    if (!cur) throw new Error(`job not found: ${id}`);
    const next = { ...cur, ...patch };
    await atomicWrite(jobPath(id), JSON.stringify(next, null, 2));
    return next;
  });
}

// Conditional update: only writes if the current status is still 'running'.
// Used by both the worker (success/error) and `cancel` so concurrent
// terminal writes converge to whichever transition wins the lock — without
// later writes silently overwriting an already-terminal record (e.g. cancel
// flipping a record back to 'cancelled' after the worker wrote 'done').
export async function finishIfRunning(id, patch) {
  return withJobLock(id, async () => {
    const cur = await get(id);
    if (!cur) throw new Error(`job not found: ${id}`);
    if (cur.status !== 'running') return cur;
    const next = { ...cur, ...patch };
    await atomicWrite(jobPath(id), JSON.stringify(next, null, 2));
    return next;
  });
}

// Verify that `pid` still refers to a zai-companion worker for THIS job.
//
// Without this guard, a stale job record (from a worker that crashed before
// writing its terminal status, or a foreground PID that the OS later recycled)
// can lead `cancel()` to send SIGTERM to a completely unrelated process —
// including critical desktop processes. Worse, pid values of 0 or -1 turn
// `process.kill` into a broadcast: 0 hits the caller's process group, -1 hits
// every process the user owns (which on macOS force-quits the user's entire
// GUI session).
//
// Returns true ONLY when:
//   1. pid is a real positive integer above 1 (no init, no broadcast forms),
//   2. the process is alive and signalable by us (kill(pid, 0)),
//   3. the live process's command line still names our worker for this jobId.
function verifyWorkerStillOurs(pid, jobId) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); } catch { return false; }
  try {
    // `-ww` disables BSD ps's column truncation so the full argv is visible
    // even when the SessionEnd hook fires without a tty (and thus a 0-width
    // default). Without it, "node /long/.../zai-companion.mjs __worker <id>"
    // can be cut before the jobId, causing false negatives.
    const cmd = execSync(`ps -ww -p ${pid} -o command=`, {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    return cmd.includes('zai-companion') && cmd.includes(`__worker ${jobId}`);
  } catch {
    return false;
  }
}

export async function cancel(id) {
  const r = await get(id);
  if (!r) throw new Error(`job not found: ${id}`);
  if (r.status !== 'running') return r;
  // Only background jobs are signalable. Foreground jobs run inline in the
  // companion process and don't store a pid; reaching them here means the
  // foreground call already finished or crashed.
  if (r.bg && verifyWorkerStillOurs(r.pid, r.id)) {
    try { safeKill(r.pid, 'SIGTERM'); } catch {}
  }
  // finishIfRunning rather than update: if the worker raced past us and
  // wrote 'done' (or 'error') first, respect that instead of silently
  // clobbering the terminal record back to 'cancelled'.
  return finishIfRunning(id, { status: 'cancelled', ended_at: new Date().toISOString() });
}

// Sweep stale `status='running'` records. A worker that died before writing
// its terminal status leaves the record stuck — and its stored pid may now
// belong to an unrelated process. Mark such records as errored so subsequent
// status/result/cancel calls don't act on a recycled pid.
//
// `graceMs` exists because background jobs have a brief window between
// `jobs.create` and the parent's pid-stamping where a reconcile pass would
// see status='running' with pid=null and falsely conclude the worker is
// gone. Anything younger than the grace period is left alone.
export async function reconcileStale({ graceMs = 30_000 } = {}) {
  ensureDir();
  const entries = await fs.readdir(jobsDir());
  const now = Date.now();
  let reconciled = 0;
  for (const f of entries) {
    if (!f.endsWith('.json')) continue;
    let r;
    try {
      const raw = await fs.readFile(path.join(jobsDir(), f), 'utf8');
      r = JSON.parse(raw);
    } catch { continue; }
    if (r?.status !== 'running') continue;
    const startedAt = r.started_at ? Date.parse(r.started_at) : NaN;
    const createdAt = r.created_at ? Date.parse(r.created_at) : NaN;
    const anchor = Number.isFinite(startedAt) ? startedAt
                  : Number.isFinite(createdAt) ? createdAt
                  : now;
    if (now - anchor < graceMs) continue;
    // Foreground jobs that are still flagged 'running' here can only mean
    // the inline call crashed. Background jobs may have lost their worker.
    const stillOurs = r.bg && verifyWorkerStillOurs(r.pid, r.id);
    if (stillOurs) continue;
    try {
      await finishIfRunning(r.id, {
        status: 'error',
        error: 'orphaned (worker no longer running)',
        ended_at: new Date().toISOString(),
      });
      reconciled += 1;
    } catch {}
  }
  return reconciled;
}

export async function gcOlderThanDays(days = 14) {
  ensureDir();
  const entries = await fs.readdir(jobsDir());
  const cutoff = Date.now() - days * 86400_000;
  let removed = 0;
  for (const f of entries) {
    if (!f.endsWith('.json')) continue;
    const p = path.join(jobsDir(), f);
    try {
      const stat = await fs.stat(p);
      if (stat.mtimeMs < cutoff) {
        await fs.unlink(p);
        removed += 1;
      }
    } catch {}
  }
  return removed;
}

export function dir() {
  return jobsDir();
}
