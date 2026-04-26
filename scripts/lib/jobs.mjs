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

export async function create({ kind, request, model }) {
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
  const cur = await get(id);
  if (!cur) throw new Error(`job not found: ${id}`);
  const next = { ...cur, ...patch };
  await atomicWrite(jobPath(id), JSON.stringify(next, null, 2));
  return next;
}

export async function cancel(id) {
  const r = await get(id);
  if (!r) throw new Error(`job not found: ${id}`);
  if (r.status !== 'running') return r;
  if (r.pid) {
    try { process.kill(r.pid, 'SIGTERM'); } catch {}
  }
  return update(id, { status: 'cancelled', ended_at: new Date().toISOString() });
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
