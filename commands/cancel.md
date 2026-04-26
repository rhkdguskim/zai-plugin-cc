---
description: Cancel an active background Z.AI job in this repository
argument-hint: '<job-id>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/zai-companion.mjs" cancel $ARGUMENTS`
