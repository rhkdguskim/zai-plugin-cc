---
description: Ask Z.AI (GLM-4.5-Air) a quick, single-shot question. Foreground only, fast model.
argument-hint: '<message>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/zai-companion.mjs" ask "$ARGUMENTS"`

The runtime emits a machine envelope. Parse it as follows and present ONLY the body to the user — no preamble, no summary, no "GLM said:" wrapper.

- On `<zai_response …>BODY</zai_response>` (stdout): print BODY verbatim. Do NOT echo the attribute line.
- On `<zai_error kind="auth" …>MSG</zai_error>` (stderr): tell the user to run `/zai:setup`.
- On any other `<zai_error …>MSG</zai_error>`: surface MSG verbatim and stop.
- Do NOT paraphrase, translate, summarize, or quote the user's question back.
