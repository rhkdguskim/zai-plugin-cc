---
description: Cancel an active background Z.AI job in this repository
argument-hint: '<job-id>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/zai-companion.mjs" cancel $ARGUMENTS`

Output handling:

- On `<zai_cancelled job_id="…" status="cancelled"/>` (or `status="done"`/`"error"` if the job already finished) — tell the user the resulting state in one sentence.
- On `<zai_error kind="…" …>MSG</zai_error>` — surface MSG verbatim.
