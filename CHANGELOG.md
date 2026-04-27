# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
