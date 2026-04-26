---
description: Show active and recent Z.AI jobs for this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/zai-companion.mjs" status $ARGUMENTS`

If the user did not pass a job ID:

- Render the command output as a single Markdown table for the current and recent runs in this repo.
- Keep it compact. Preserve job ID, kind, status, model, and elapsed.

If the user did pass a job ID:

- Present the full command output to the user.
- Do not summarize or condense it.
