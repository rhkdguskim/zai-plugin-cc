---
description: Show the stored final output for a finished Z.AI job in this repository
argument-hint: '<job-id>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/zai-companion.mjs" result $ARGUMENTS`

Output handling:

- On `<zai_response kind="…" model="…" job_id="…" elapsed_ms="…">BODY</zai_response>` — print BODY verbatim. Preserve code blocks and section headers.
- On `<zai_pending kind="…" job_id="…" .../>` — tell the user the job is still running; suggest `/zai:status` to monitor.
- On `<zai_cancelled job_id="…"/>` — tell the user the job was cancelled.
- On `<zai_error kind="…" …>MSG</zai_error>` — surface MSG verbatim and stop.

Do NOT paraphrase, summarize, or translate the response body.
