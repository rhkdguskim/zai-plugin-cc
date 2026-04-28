# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.2] - 2026-04-28

### Added
- Mock Z.AI server (`http.createServer` in-process) backing 9 new integration tests that drive the real companion CLI through the full flow without an API key. Asserts: per-mode hyperparameters land in the request body (temperature/top_p/max_tokens/stop_sequences), the envelope shape matches what `commands/*.md` parses, `--human` restores the legacy footer, `--model` overrides per-mode default, provider 401 prompt echoes never reach `err.message` or persisted job records, background lifecycle (`<zai_dispatched/>` → polled JSON status → `<zai_response>` via `/zai:result`) actually completes, `<zai_jobs count="0"/>` and `<zai_cancelled/>` envelope shapes.
- Reference parser for the `<zai_edit>` patch format (5 tests). Locks the `<<<<<<< SEARCH/REPLACE`/`CREATE/END`/self-closing-delete spec down so any future prompt edit that drops a marker name fails CI immediately.
- Streaming test mode: `ZAI_TEST_STREAM=1` writes per-test pass/fail lines as they happen, instead of buffering the whole report to the end. Useful for debugging long-running suites.

### Fixed
- **Integration deadlock**: an earlier draft of the integration tests used `spawnSync` to invoke the companion while holding the in-process mock HTTP server. `spawnSync` blocks the test runner's event loop, so the mock server couldn't accept the connection — and the companion sat waiting forever. Replaced with `runCompanionAsync` (uses `spawn` and resolves on `exit`).
- Parser test expectations: SEARCH/REPLACE/CREATE bodies include the `\n` immediately preceding the closing marker (every body line is newline-terminated, including the last one). The reference parser's slice boundaries now match that convention so an edit produced by GLM round-trips byte-identically through the Edit tool.

## [0.2.1] - 2026-04-28

### Changed
- **`/zai:code` now applies edits to the working tree.** Previously it printed code that the user had to paste manually. The slash command now parses GLM's `<zai_edit>` patches and applies them via Claude Code's `Read` / `Edit` / `Write` / `rm` tools, going through the normal permission flow.

### Added
- New patch format produced by GLM in code mode: `<zai_edit path="…" op="edit|create|delete">` with aider-style `<<<<<<< SEARCH … ======= … >>>>>>> REPLACE` and `<<<<<<< CREATE … >>>>>>> END` markers. Self-closing form for delete.
- `--advisory` flag on `/zai:code` to opt out of auto-apply and just print the plan.
- `<zai_clarify>question</zai_clarify>` block lets GLM ask one sharp clarifying question instead of guessing edits.

### Fixed
- `commands/code.md` had `Do NOT implement the task yourself` baked in and omitted `Edit`/`Write` from `allowed-tools`, so the slash command could never actually apply edits even if Claude wanted to. Both fixed.

## [0.2.0] - 2026-04-27

### Added
- Per-mode model map (`models.{ask,code,review,consult}`) with v2→v3 config migration (`06c8bd4`)
- SessionEnd hook (`hooks/hooks.json`) calling internal `__reconcile` (`5371f03`)
- `<use_parallel_tool_calls>` guidance in `commands/review.md` and `commands/code.md` (`5371f03`)
- `.claude-plugin/marketplace.json` so the repo is installable as a single-plugin marketplace (`42493b4`)
- Comprehensive test suite (`tests/test.mjs`) — 37 unit + 8 live (skipped without `ZAI_API_KEY`) (`5371f03`)

### Changed
- Default heavy model is now `glm-5.1` (was `glm-4.6`); `ask` stays on `glm-4.5-air` (`06c8bd4`)
- README, `--help` text, prompting/skill docs reflect the new model lineup (`06c8bd4`)
- Anthropic-compat endpoint (`/api/anthropic`) is the only supported base URL (`5371f03`)

### Fixed
- **CRITICAL**: `jobs.cancel` no longer broadcasts SIGTERM to all user processes via `process.kill(pid<=0)`. This bug previously force-quit the user's GUI session. (`4c85791`)
- Foreground jobs no longer record `process.pid` (would cause `/zai:cancel` to hit a recycled pid) (`4c85791`)
- Race between worker terminal write and cancel terminal write — both go through `finishIfRunning` (`4c85791`)
- Lost-update race in `jobs.update` — per-job `O_EXCL` lockfile (`4c85791`)
- `cmdAsk` now propagates `--model` flag through to `runForeground` (`5303b1f`)

### Security
- `safeKill(pid<=1)` chokepoint refuses broadcast pid values (`4c85791`)
- `verifyWorkerStillOurs(pid, jobId)` requires a live process whose `ps -ww` command line matches our worker for the specific `jobId` before signaling (`4c85791`)

[Unreleased]: https://github.com/rhkdguskim/zai-plugin-cc/compare/HEAD...HEAD
