---
description: Delegate a coding task to Z.AI (GLM-4.6). Routes through the zai-consultant subagent.
argument-hint: '[--wait|--background] [--model <m>] <task...>'
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `zai:zai-consultant` subagent via the `Agent` tool (`subagent_type: "zai:zai-consultant"`), forwarding the raw user request as the prompt. The subagent's only job is to call `node "${CLAUDE_PLUGIN_ROOT}/scripts/zai-companion.mjs" code ...` once and return its stdout verbatim. The final user-visible response must be Z.AI's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--wait`, run the subagent in the foreground.
- If the request includes `--background`, run the subagent in the background.
- If neither flag is present, estimate the size of the requested task. If it is small and self-contained (one file or one function), recommend foreground; otherwise recommend background. Use `AskUserQuestion` exactly once with two choices, putting the recommended option first and suffixing it with `(Recommended)`:
  - `Wait for results`
  - `Run in background`

Argument handling:

- Preserve the user's arguments exactly when forwarding to the subagent.
- Do not strip `--wait` / `--background` / `--model` yourself — the subagent will route on them.
- Do not paraphrase, summarize, or rewrite the user's intent.

Operating rules:

- Return Z.AI's output verbatim.
- Do not implement the task yourself.
- If the runtime says the API key is missing, stop and tell the user to run `/zai:setup`.
- If the user supplied no task body, ask what Z.AI should build.
