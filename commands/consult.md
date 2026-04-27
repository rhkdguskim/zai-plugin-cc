---
description: Open-ended design / strategy consultation with Z.AI (GLM-5.1). Background-friendly.
argument-hint: '[--wait|--background] [--model <id>] <topic...>'
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `zai:zai-consultant` subagent via the `Agent` tool (`subagent_type: "zai:zai-consultant"`), forwarding the raw user request as the prompt. The subagent's only job is to call `node "${CLAUDE_PLUGIN_ROOT}/scripts/zai-companion.mjs" consult ...` once and return its stdout verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--wait`, run the subagent in the foreground.
- If the request includes `--background`, run the subagent in the background.
- If neither flag is present, default to background (consultations tend to be long). Use `AskUserQuestion` exactly once:
  - `Run in background (Recommended)`
  - `Wait for results`

Operating rules:

- The companion runtime emits a `<zai_response kind="consult" …>BODY</zai_response>` envelope (foreground) or `<zai_dispatched …/>` (background). When you receive the foreground envelope, surface BODY to the user verbatim — do NOT echo the attribute line, do NOT paraphrase, do NOT summarize, do NOT translate. The model already produced the `## Options` / `## Tradeoffs` / `## Recommendation` structure.
- On `<zai_dispatched job_id="…" .../>`, tell the user the consultation started in the background and to use `/zai:status` or `/zai:result <id>`.
- On `<zai_error kind="auth" …>` (stderr), tell the user to run `/zai:setup`.
- On any other `<zai_error …>MSG</zai_error>`, surface MSG verbatim and stop.
- Do NOT turn the consultation into an implementation task.
- If the user supplied no topic, ask what Z.AI should consult on.

Parallel-tool note (Codex review #9):

- consult has no measurement step, so there is no parallel-batch shape to apply here. Do NOT parallelize the `AskUserQuestion` with the `Agent` dispatch — they are dependent (the dispatch needs the answer).
