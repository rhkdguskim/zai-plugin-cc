---
description: Show active and recent Z.AI jobs for this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/zai-companion.mjs" status $ARGUMENTS`

Output handling:

- If the user passed a job-id: stdout is a JSON object representing that job. Render it as a compact two-column key/value Markdown list. Preserve `id`, `kind`, `status`, `model`, `started_at`, `ended_at`, `bg`, and `usage` if present.
- If no job-id: stdout is `<zai_jobs count="N" shown="M">` followed by one JSON object per line, then `</zai_jobs>`. Render the lines as a single Markdown table with columns: id, kind, status, model, elapsed (computed from started_at/ended_at). If `count="0"` (or `<zai_jobs count="0"/>`) say "(no jobs)".

Do not paraphrase or invent rows. Drop nothing.
