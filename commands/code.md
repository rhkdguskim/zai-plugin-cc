---
description: Delegate a coding task to Z.AI (GLM-5.1). Routes through the zai-consultant subagent.
argument-hint: '[--wait|--background] [--model <id>] <task...>'
allowed-tools: Bash(node:*), Bash(git:*), AskUserQuestion, Agent
---

Invoke the `zai:zai-consultant` subagent via the `Agent` tool (`subagent_type: "zai:zai-consultant"`), forwarding the raw user request as the prompt. The subagent's only job is to call `node "${CLAUDE_PLUGIN_ROOT}/scripts/zai-companion.mjs" code ...` once and return its stdout verbatim. The final user-visible response must be Z.AI's output verbatim.

Raw user request:
$ARGUMENTS

<use_parallel_tool_calls>
If you intend to call multiple tools and there are no dependencies between the tool calls, make all of the independent tool calls in parallel. Prioritize calling tools simultaneously whenever the actions can be done in parallel rather than sequentially. For example, when reading 3 files, run 3 tool calls in parallel to read all 3 files into context at the same time. Maximize use of parallel tool calls where possible to increase speed and efficiency. However, if some tool calls depend on previous calls to inform dependent values like the parameters, do NOT call these tools in parallel and instead call them sequentially. Never use placeholders or guess missing parameters in tool calls.
</use_parallel_tool_calls>

Execution mode:

- If the request includes `--wait`, run the subagent in the foreground.
- If the request includes `--background`, run the subagent in the background.
- If neither flag is present, estimate task size. **If you read project files or check git state to estimate, issue those reads in parallel within a single message** — they are independent. Examples of independent measurement calls: `git status --short`, a single Glob for the affected area, two or three Read calls on referenced files. Do not parallelize the AskUserQuestion or the final Agent dispatch with this measurement batch — those are sequential.
- After measurement, decide: small + self-contained (one file or one function) → recommend foreground; otherwise → recommend background. Use `AskUserQuestion` exactly once with two choices, putting the recommended option first and suffixing it with `(Recommended)`:
  - `Wait for results`
  - `Run in background`

Argument handling:

- Preserve the user's arguments exactly when forwarding to the subagent.
- Do not strip `--wait` / `--background` / `--model` yourself — the subagent will route on them.
- Do not paraphrase, summarize, or rewrite the user's intent.

Operating rules:

- The companion runtime emits a `<zai_response …>BODY</zai_response>` envelope (foreground) or `<zai_dispatched …/>` (background). When you receive the foreground envelope, surface BODY to the user verbatim — do NOT echo the attribute line, do NOT paraphrase, do NOT summarize, do NOT translate. The model already produced its final answer in the user's language and shape.
- On a `<zai_dispatched job_id="…" .../>` line, tell the user the job started in the background and to use `/zai:status` or `/zai:result <id>`.
- On `<zai_error kind="auth" …>` (stderr), tell the user to run `/zai:setup`.
- On any other `<zai_error …>MSG</zai_error>`, surface MSG verbatim and stop.
- Do NOT implement the task yourself.
- If the user supplied no task body, ask what Z.AI should build.
