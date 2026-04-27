import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CONFIG_DIR = process.env.ZAI_CONFIG_DIR
  || path.join(os.homedir(), '.config', 'zai-plugin-cc');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

// Per-mode model mapping. The Z.AI Coding Plan currently bundles GLM-5.1,
// GLM-5-Turbo, GLM-4.7, GLM-4.6, GLM-4.5-Air; GLM-5 is gated to Pro/Max.
// We pick GLM-5.1 — the latest flagship coding/reasoning model — for the
// heavy modes (code/review/consult), and keep GLM-4.5-Air for `ask` because
// short single-shot Q&A favors throughput over depth (5.1 is the slowest in
// its tier). Users override per-mode via config or per-call via --model.
const DEFAULT_MODELS = {
  ask:     'glm-4.5-air',
  code:    'glm-5.1',
  review:  'glm-5.1',
  consult: 'glm-5.1',
};

// Per-mode sampling hyperparameters. Tuned for Claude-as-consumer:
//   * `ask`     — single-shot factual Q&A. Determinism + brevity. Hard cap
//                 at 512 tokens forces the model to compress to bullets.
//   * `code`    — code generation. Determinism (creativity hurts code), but
//                 a high max_tokens cap so long patches don't truncate.
//   * `review`  — edge-case finding. Mild diversity (top_p 0.9) lets the
//                 model surface varied issue classes without hallucinating.
//   * `consult` — design exploration. Higher temperature for genuine
//                 tradeoff exploration; capped output length.
//
// `stop_sequences` clip stray boilerplate that GLM still emits despite the
// system prompt — common patterns like "Let me know if you have…" and
// model-fabricated XML envelope close tags.
const DEFAULT_PARAMS = {
  ask:     { temperature: 0.2, top_p: 0.8,  max_tokens: 512  },
  code:    { temperature: 0.2, top_p: 0.95, max_tokens: 8192 },
  review:  { temperature: 0.3, top_p: 0.9,  max_tokens: 4096 },
  consult: { temperature: 0.6, top_p: 0.95, max_tokens: 4096 },
};

const DEFAULT_STOP_SEQUENCES = [
  '</zai_response>',
  '</zai_error>',
  'Let me know if you',
  'Hope this helps',
];

const DEFAULTS = {
  version: 4,
  base_url: 'https://api.z.ai/api/anthropic',
  models: { ...DEFAULT_MODELS },
  params: { ...DEFAULT_PARAMS },
  stop_sequences: [...DEFAULT_STOP_SEQUENCES],
  // Legacy fallbacks kept so older config files and ZAI_DEFAULT_MODEL /
  // ZAI_LIGHT_MODEL env vars still steer the per-mode map when explicitly
  // set. New installs read straight from `models`.
  default_model: 'glm-5.1',
  light_model:   'glm-4.5-air',
  timeout_ms: 300000,
};

export function configPath() {
  return CONFIG_PATH;
}

export function fromEnv() {
  const apiKey = process.env.ZAI_API_KEY || process.env.ZAI_TOKEN;
  if (!apiKey) return null;
  const out = { api_key: apiKey };
  if (process.env.ZAI_BASE_URL) out.base_url = process.env.ZAI_BASE_URL;
  const heavy = process.env.ZAI_DEFAULT_MODEL || null;
  const light = process.env.ZAI_LIGHT_MODEL   || null;
  if (heavy) out.default_model = heavy;
  if (light) out.light_model = light;
  // Only emit a `models` partial when the user actually set an env var,
  // so an unrelated env (e.g. just ZAI_API_KEY) cannot clobber the
  // per-mode map written to the config file.
  const partial = {};
  if (heavy) {
    partial.code = heavy;
    partial.review = heavy;
    partial.consult = heavy;
  }
  if (light) partial.ask = light;
  if (Object.keys(partial).length) out.models = partial;
  return out;
}

function migrate(cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg;
  const next = { ...cfg };
  // v1 -> v2: switch from OpenAI-compat surface to Anthropic-compat surface,
  // which is the only one covered by the GLM Coding plan quota.
  if (next.base_url && /\/api\/paas\/v4\/?$/.test(next.base_url)) {
    next.base_url = next.base_url.replace(/\/api\/paas\/v4\/?$/, '/api/anthropic');
  }
  if (!next.base_url) next.base_url = DEFAULTS.base_url;
  // v2 -> v3: introduce `models` per-mode map. Populate from the v2
  // default_model/light_model so we don't silently change behavior for
  // users who deliberately picked an older model (e.g. glm-4.6).
  if (!next.models || typeof next.models !== 'object') {
    const heavy = next.default_model || DEFAULTS.default_model;
    const light = next.light_model   || DEFAULTS.light_model;
    next.models = {
      ask:     light,
      code:    heavy,
      review:  heavy,
      consult: heavy,
    };
  } else {
    // Fill in any missing modes with the defaults so a partial map written
    // by a user can't break callers that expect every kind to resolve.
    next.models = { ...DEFAULT_MODELS, ...next.models };
  }
  // v3 -> v4: introduce `params` per-mode hyperparameter map and a shared
  // `stop_sequences` list. Existing v3 configs that lack these fields get
  // the tuned defaults; partial maps a user wrote get filled in to avoid
  // breaking callers that expect every mode to resolve.
  if (!next.params || typeof next.params !== 'object') {
    next.params = { ...DEFAULT_PARAMS };
  } else {
    next.params = {
      ask:     { ...DEFAULT_PARAMS.ask,     ...(next.params.ask     || {}) },
      code:    { ...DEFAULT_PARAMS.code,    ...(next.params.code    || {}) },
      review:  { ...DEFAULT_PARAMS.review,  ...(next.params.review  || {}) },
      consult: { ...DEFAULT_PARAMS.consult, ...(next.params.consult || {}) },
    };
  }
  if (!Array.isArray(next.stop_sequences)) {
    next.stop_sequences = [...DEFAULT_STOP_SEQUENCES];
  }
  if (!next.version || next.version < 4) next.version = 4;
  return next;
}

// Three-way merge of the per-mode model map: defaults → file → env.
// Each layer can carry a partial map (env in particular usually does, since
// only ZAI_DEFAULT_MODEL or ZAI_LIGHT_MODEL may be set), so we merge by
// keys instead of letting a later spread wipe the entire object.
function mergeModels(file, env) {
  return {
    ...DEFAULT_MODELS,
    ...((file && file.models) || {}),
    ...((env && env.models) || {}),
  };
}

// Per-mode hyperparameter merge. Same three-way logic as mergeModels but
// merges INSIDE each mode object so a user can override (say) just
// `params.code.max_tokens` without nuking temperature/top_p.
function mergeParams(file) {
  const filePartial = (file && file.params) || {};
  return {
    ask:     { ...DEFAULT_PARAMS.ask,     ...(filePartial.ask     || {}) },
    code:    { ...DEFAULT_PARAMS.code,    ...(filePartial.code    || {}) },
    review:  { ...DEFAULT_PARAMS.review,  ...(filePartial.review  || {}) },
    consult: { ...DEFAULT_PARAMS.consult, ...(filePartial.consult || {}) },
  };
}

export async function load() {
  const env = fromEnv();
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf8');
    const file = JSON.parse(raw);
    // Migrate the file *before* layering DEFAULTS in: a v2 record without a
    // `models` map needs migrate() to see that absence so it can populate
    // the new map from the user's existing default_model/light_model. If we
    // merged DEFAULTS first, migrate() would see DEFAULTS.models and skip
    // the rebuild — silently upgrading a user pinned at glm-4.6 to glm-5.1.
    const migrated = migrate(file);
    const merged = { ...DEFAULTS, ...migrated, ...(env ?? {}) };
    merged.models = mergeModels(migrated, env);
    merged.params = mergeParams(migrated);
    if (!Array.isArray(merged.stop_sequences)) {
      merged.stop_sequences = [...DEFAULT_STOP_SEQUENCES];
    }
    return merged;
  } catch (err) {
    if (err.code === 'ENOENT') {
      if (env) {
        const synth = { ...DEFAULTS, ...env };
        synth.models = mergeModels(null, env);
        synth.params = mergeParams(null);
        synth.stop_sequences = [...DEFAULT_STOP_SEQUENCES];
        return synth;
      }
      return null;
    }
    throw err;
  }
}

export async function save(cfg) {
  await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const migrated = migrate(cfg);
  const merged = { ...DEFAULTS, ...migrated };
  merged.models = mergeModels(migrated, null);
  merged.params = mergeParams(migrated);
  if (!Array.isArray(merged.stop_sequences)) {
    merged.stop_sequences = [...DEFAULT_STOP_SEQUENCES];
  }
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
  return {
    ...DEFAULTS,
    models: { ...DEFAULT_MODELS },
    params: mergeParams(null),
    stop_sequences: [...DEFAULT_STOP_SEQUENCES],
  };
}
