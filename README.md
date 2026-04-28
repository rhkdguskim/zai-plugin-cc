# zai-plugin-cc

> A Claude Code plugin that pipes **Z.AI's GLM-5.1 / GLM-4.5-Air** models into your Claude Code session as a sidecar brain — code generation, code review, and design consultation.

[![test](https://github.com/rhkdguskim/zai-plugin-cc/actions/workflows/test.yml/badge.svg)](https://github.com/rhkdguskim/zai-plugin-cc/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

`zai-plugin-cc` is an **enterprise-grade, zero-dependency Claude Code plugin** that lets the main Claude Code session delegate heavy work — patches, reviews, design consults — to GLM models running on Z.AI's Anthropic-compatible endpoint, without leaking out of the Coding Plan quota or polluting the main agent's context.

**Tags / topics:** `claude-code` · `claude-code-plugin` · `anthropic` · `glm` · `glm-5.1` · `glm-4.5-air` · `zai` · `z-ai` · `sidecar` · `code-review` · `mcp` · `claude-code-marketplace`

---

## Why this plugin

- **Separation of concerns.** Your main Claude session keeps short-context and stays cheap. Long, expensive model work (multi-file refactors, full diff reviews, open-ended design exploration) is routed to GLM-5.1 in a child process. Auth failures, model errors, and rate limits never break the main thread.
- **Token-efficient by design.** Sidecar stdout is a machine-readable XML envelope (`<zai_response …>BODY</zai_response>`) — Claude reads only the body. No "GLM said:" framing, no human-only footer, no double-summarization. About 20 tokens saved per call versus a free-form footer.
- **Per-mode model + sampling tuning.** `code` and `review` run on the deterministic side (low temperature, high `top_p`, big `max_tokens`); `consult` runs hotter to surface tradeoffs; `ask` clamps to ~120 words on the fast model. Each mode is independently overridable.
- **Hardened cancellation.** A previous `process.kill(pid, 'SIGTERM')` path could broadcast SIGTERM to every user process when `pid <= 0` — closing the entire macOS GUI session. The runtime now refuses any pid ≤ 1, verifies the live process is genuinely our worker for the specific job id (via `ps -ww`), and converges concurrent terminal writes through a single `finishIfRunning` helper.
- **Single-binary install.** Pure Node 18+ built-ins. No `npm install`. No lockfile. The plugin is the repo.

## Installation

### From this repo's local marketplace

```bash
claude plugin marketplace add rhkdguskim/zai-plugin-cc
claude plugin install zai@zai-plugin-cc
```

(Or with a local path: `claude plugin marketplace add /path/to/zai-plugin-cc`.)

### Register your Z.AI API key

```text
/zai:setup
```

Claude Code will prompt for the key. The runtime stores it in `~/.config/zai-plugin-cc/config.json` (mode `0600`) and verifies connectivity against `glm-4.5-air` on the Anthropic-compat endpoint.

For non-interactive environments:

```bash
export ZAI_API_KEY=sk-zai-xxxxxxxxx
```

Get a key from <https://z.ai/model-api>.

## Slash commands

| Command | Purpose | Default model |
|---|---|---|
| `/zai:setup` | Register or refresh the API key | — |
| `/zai:ask <message>` | Single-shot Q&A (≤120 words) | `glm-4.5-air` |
| `/zai:code [--wait\|--background] [--advisory] [--model <id>] <task>` | Code generation / multi-file refactor — applies edits to the working tree | `glm-5.1` |
| `/zai:review [--wait\|--background] [--base <ref>] [focus]` | Third-party diff review | `glm-5.1` |
| `/zai:consult [--wait\|--background] <topic>` | Design / strategy consult | `glm-5.1` |
| `/zai:status [job-id]` | List or inspect background jobs | — |
| `/zai:result <job-id>` | Print a finished job's stored output | — |
| `/zai:cancel <job-id>` | Cancel a running background job | — |

## Model mapping (Z.AI Coding Plan)

| Mode | Model | Why |
|---|---|---|
| `ask` | `glm-4.5-air` | Single-shot Q&A; throughput first, also cheap |
| `code` | `glm-5.1` | Flagship coding model; multi-file refactor / long-horizon agentic |
| `review` | `glm-5.1` | Review = reasoning-heavy; section-anchored output |
| `consult` | `glm-5.1` | Long tradeoff exploration |

- One-off override: `/zai:code --model glm-4.7 …` (also `glm-5-turbo`, `glm-5` (Pro/Max), `glm-4.6`, `glm-4.5-air`).
- Permanent override: edit `~/.config/zai-plugin-cc/config.json` under `models.<mode>`, or set `ZAI_DEFAULT_MODEL` / `ZAI_LIGHT_MODEL`.

## Per-mode sampling hyperparameters

Tuned defaults per mode (override under `params.<mode>` in the config file):

| Mode | `temperature` | `top_p` | `max_tokens` | Rationale |
|---|---|---|---|---|
| `ask` | 0.2 | 0.8 | 512 | Determinism + brevity; output cap forces 3-bullet shape |
| `code` | 0.2 | 0.95 | 8192 | Code shouldn't be creative; long patches need headroom |
| `review` | 0.3 | 0.9 | 4096 | Mild diversity to surface varied issue classes |
| `consult` | 0.6 | 0.95 | 4096 | Genuine tradeoff exploration |

A shared `stop_sequences` list (`</zai_response>`, `</zai_error>`, `Let me know if you`, `Hope this helps`) clips boilerplate that GLM occasionally adds despite the system prompt.

## Output envelope (token-efficient)

The runtime emits one of these on stdout/stderr — Claude Code reads only the body:

```text
<zai_response kind="code" model="glm-5.1" job_id="abc-123" elapsed_ms="2410" input_tokens="312" output_tokens="884">
…answer body…
</zai_response>
```

```text
<zai_dispatched kind="consult" model="glm-5.1" job_id="abc-123" mode="background"/>
<zai_pending      kind="code"    job_id="abc-123" model="glm-5.1"/>
<zai_cancelled    job_id="abc-123" status="cancelled"/>
<zai_jobs count="3" shown="3"> …one JSON object per line… </zai_jobs>
<zai_error        kind="auth" status="401" job_id="abc-123">…short categorized message (no provider echo)…</zai_error>
```

For terminal users who want the legacy human-readable footer back, every command accepts `--human`.

## How `/zai:code` actually changes files

`/zai:code` is **not** advisory by default — it edits the working tree. The flow:

1. The companion calls GLM-5.1 with a system prompt that mandates a structured patch format. GLM emits zero or more `<zai_edit>` blocks (and nothing else).
2. The slash command parses each block and applies it via Claude Code's own `Read` / `Edit` / `Write` / `rm` tools, which means every change still goes through Claude Code's normal permission flow.

Patch shapes GLM emits:

```text
<zai_edit path="src/foo.ts" op="edit">
<<<<<<< SEARCH
exact text from the current file
=======
new text
>>>>>>> REPLACE
</zai_edit>

<zai_edit path="src/new-file.ts" op="create">
<<<<<<< CREATE
full file contents
>>>>>>> END
</zai_edit>

<zai_edit path="src/dead.ts" op="delete"/>
```

Pass `--advisory` to skip the apply step and just print the edit plan. Background jobs are advisory by default — the user has moved on, so `/zai:result <id>` shows the plan and the user decides what to do.

If the SEARCH block doesn't match the file byte-for-byte (the apply tool fails closed in this case), the slash command reports the failed file path and continues with the remaining `<zai_edit>` blocks instead of guessing.

## Performance: parallel tool calling

`/zai:review` and `/zai:code` follow Anthropic's [parallel tool calling guidance](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices#optimize-parallel-tool-calling): independent measurement calls (`git status --short`, `git diff --shortstat`, `git diff --shortstat --cached`) are dispatched in a single message. The dispatch step that follows is correctly serialized because it depends on the user's `AskUserQuestion` answer.

## Security

- API key is stored only in `~/.config/zai-plugin-cc/config.json` with mode `0600`.
- Nothing about the user's repo is sent to Z.AI except what the user explicitly delegates. The single automatic attachment is the `git diff` selected by `/zai:review`.
- Provider error free-text is **never** persisted into job records — `client.mjs` redacts to a stable category sentence (`auth` / `rate_limit` / `quota` / `protocol` / `api`) so a misbehaving upstream that echoes prompt fragments cannot leak them onto disk via `jobs.update({error})`.
- `process.kill` is wrapped by `safeKill(pid, signal)` which throws on `pid <= 1` — broadcasting SIGTERM to every user process is impossible by construction.
- Background workers are verified by **command-line match** (`ps -ww -p <pid>` must contain `__worker <jobId>`) before any signal is sent. PID recycling cannot redirect a `/zai:cancel` to an unrelated process.

## Architecture

```text
zai-plugin-cc/
├── .claude-plugin/
│   ├── plugin.json              plugin manifest
│   └── marketplace.json         single-plugin local marketplace
├── agents/zai-consultant.md     thin Bash forwarder subagent
├── commands/                    8 slash commands
├── skills/
│   ├── zai-cli-runtime/         internal: helper-call contract
│   └── zai-prompting/           internal: GLM prompt-shaping rules
├── hooks/hooks.json             SessionEnd → __reconcile (orphan cleanup)
├── scripts/
│   ├── zai-companion.mjs        single CLI entrypoint (subcommands + envelope)
│   └── lib/
│       ├── config.mjs           v4 schema with models + params + stop_sequences
│       ├── client.mjs           Z.AI Anthropic-compat fetch + redacted errors
│       ├── jobs.mjs             O_EXCL lockfile + verify-then-signal cancel
│       ├── runner.mjs           foreground / background / worker
│       ├── prompts.mjs          per-mode system prompts (no preamble, fixed sections)
│       └── flags.mjs            CLI flag parser
├── tests/test.mjs               42 unit + 8 live (skip without ZAI_API_KEY)
├── .github/workflows/test.yml   CI on every push / PR
├── package.json                 zero-dep, type:module, engines.node>=18
└── CHANGELOG.md, LICENSE
```

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `ZAI_API_KEY` | — | API key (overrides stored config) |
| `ZAI_BASE_URL` | `https://api.z.ai/api/anthropic` | Anthropic-compat endpoint covered by the GLM Coding Plan |
| `ZAI_DEFAULT_MODEL` | `glm-5.1` | Model for `code` / `review` / `consult` |
| `ZAI_LIGHT_MODEL` | `glm-4.5-air` | Model for `ask` |
| `ZAI_DEBUG` | — | `1` traces HTTP requests to stderr |
| `ZAI_CONFIG_DIR` | `~/.config/zai-plugin-cc` | Config file location |
| `ZAI_JOBS_DIR` | `<repo>/.zai/jobs` | Background job state |

## Running tests

```bash
node tests/test.mjs              # unit tests (fast, offline)
ZAI_API_KEY=… node tests/test.mjs # also runs live integration tests
```

CI runs the unit tests on every push/PR via `.github/workflows/test.yml`. Live tests are skipped without a key.

## Roadmap

| Slot | Notes |
|---|---|
| Streaming (SSE) | currently emits full payload at the end |
| Stop-hook auto-review gate | SessionEnd cleans up orphans; auto-review is not wired |
| `--resume-last` (multi-turn) | every call is single-shot today |
| Multi-profile (personal vs corporate keys) | single key today |
| Tool use / function-calling delegation | not in scope for MVP |
| Retry / backoff on 429/503 | classification only today |
| Cost estimation per call | usage tokens captured; pricing model not wired |

## License

MIT — see [LICENSE](LICENSE).
