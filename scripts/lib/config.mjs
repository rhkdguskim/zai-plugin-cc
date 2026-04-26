import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CONFIG_DIR = process.env.ZAI_CONFIG_DIR
  || path.join(os.homedir(), '.config', 'zai-plugin-cc');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

const DEFAULTS = {
  version: 1,
  base_url: 'https://api.z.ai/api/paas/v4',
  default_model: 'glm-4.6',
  light_model: 'glm-4.5-air',
  timeout_ms: 300000,
};

export function configPath() {
  return CONFIG_PATH;
}

export function fromEnv() {
  const apiKey = process.env.ZAI_API_KEY || process.env.ZAI_TOKEN;
  if (!apiKey) return null;
  return {
    ...DEFAULTS,
    api_key: apiKey,
    base_url: process.env.ZAI_BASE_URL || DEFAULTS.base_url,
    default_model: process.env.ZAI_DEFAULT_MODEL || DEFAULTS.default_model,
    light_model: process.env.ZAI_LIGHT_MODEL || DEFAULTS.light_model,
  };
}

export async function load() {
  const env = fromEnv();
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf8');
    const file = JSON.parse(raw);
    return { ...DEFAULTS, ...file, ...(env ?? {}) };
  } catch (err) {
    if (err.code === 'ENOENT') {
      if (env) return env;
      return null;
    }
    throw err;
  }
}

export async function save(cfg) {
  await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const merged = { ...DEFAULTS, ...cfg };
  await fs.writeFile(CONFIG_PATH, JSON.stringify(merged, null, 2), { mode: 0o600 });
  try {
    await fs.chmod(CONFIG_PATH, 0o600);
  } catch {}
  return merged;
}

export async function reset() {
  try {
    await fs.unlink(CONFIG_PATH);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

export function defaults() {
  return { ...DEFAULTS };
}
