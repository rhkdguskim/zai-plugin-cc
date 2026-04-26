---
description: Ask Z.AI (GLM-4.5-Air) a quick, single-shot question. Foreground only, fast model.
argument-hint: '<message>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/zai-companion.mjs" ask "$ARGUMENTS"`

Return the command stdout to the user verbatim. Do not summarize, paraphrase, or add commentary before or after it.

If the command says the API key is missing, tell the user to run `/zai:setup`.
