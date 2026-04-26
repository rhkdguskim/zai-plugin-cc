---
description: Open-ended design / strategy consultation with Z.AI (GLM-4.6). Background-friendly.
argument-hint: '[--wait|--background] <topic...>'
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

- Return Z.AI's output verbatim. Do not paraphrase or summarize.
- Do not turn the consultation into an implementation task.
- If the runtime says the API key is missing, stop and tell the user to run `/zai:setup`.
- If the user supplied no topic, ask what Z.AI should consult on.
