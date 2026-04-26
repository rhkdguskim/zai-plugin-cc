---
description: Show the stored final output for a finished Z.AI job in this repository
argument-hint: '<job-id>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/zai-companion.mjs" result $ARGUMENTS`

Present the full command output to the user. Do not summarize or condense it. Preserve:

- Job ID, status, model, elapsed time
- The complete result payload (code blocks, file paths, recommendations)
- Any error messages

Follow-up: if the job is still running, the script says so — tell the user to wait and try again, or use `/zai:status` to monitor.
