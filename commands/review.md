---
description: Run a Z.AI (GLM-5.1) code review against local git state. Review-only, no patches.
argument-hint: '[--wait|--background] [--base <ref>] [focus...]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a Z.AI review through the shared companion runtime.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:

- This command is review-only.
- Do not fix issues, apply patches, or suggest you are about to make changes.
- Your only job is to run the review and return Z.AI's output verbatim.

<use_parallel_tool_calls>
If you intend to call multiple tools and there are no dependencies between the tool calls, make all of the independent tool calls in parallel. Prioritize calling tools simultaneously whenever the actions can be done in parallel rather than sequentially. For example, when reading 3 files, run 3 tool calls in parallel to read all 3 files into context at the same time. Maximize use of parallel tool calls where possible to increase speed and efficiency. However, if some tool calls depend on previous calls to inform dependent values like the parameters, do NOT call these tools in parallel and instead call them sequentially. Never use placeholders or guess missing parameters in tool calls.
</use_parallel_tool_calls>

Execution mode rules:

- If the raw arguments include `--wait`, run in foreground.
- If the raw arguments include `--background`, run in a Claude background task.
- Otherwise, **measure the review size in a single parallel batch** (these calls are independent — issue them in one message with multiple Bash tool uses):
  - Working-tree path: `git status --short --untracked-files=all`, `git diff --shortstat`, `git diff --shortstat --cached`.
  - Base-branch path: `git status --short --untracked-files=all`, `git diff --shortstat <base>...HEAD`.
  - Pick the path based on whether `--base <ref>` is in `$ARGUMENTS`; do not run both paths.
  - Recommend `Wait` only if the review is roughly 1-2 files; otherwise recommend `Run in background`.
- After the measurement returns, call `AskUserQuestion` exactly once with two options. Put the recommended one first with `(Recommended)`:
  - `Wait for results`
  - `Run in background`
- The companion-runtime invocation that follows depends on the AskUserQuestion answer — that step is sequential, not parallel with the measurement.

Foreground flow:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/zai-companion.mjs" review $ARGUMENTS
```

Background flow:

```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/zai-companion.mjs" review $ARGUMENTS`,
  description: "Z.AI review",
  run_in_background: true
})
```

Output handling (foreground):

- Stdout will be a `<zai_response kind="review" …>BODY</zai_response>` envelope. Print BODY verbatim — do NOT echo the attribute line, do NOT add a "Z.AI says:" wrapper, do NOT translate or paraphrase, do NOT add a closing summary.
- The BODY is already structured under `## Bugs`, `## Security`, `## Style/Maintainability`, `## Tests`. Preserve that structure.

Output handling (background):

- Stdout will be a `<zai_dispatched kind="review" model="…" job_id="…" mode="background"/>` line. Tell the user: "Z.AI review started in the background. Check `/zai:status` or `/zai:result <id>`."

Errors:

- On `<zai_error kind="auth" …>` (stderr) — tell the user to run `/zai:setup`.
- On `<zai_error kind="no_diff" …>` — tell the user there is nothing to review.
- On any other `<zai_error …>MSG</zai_error>` — surface MSG verbatim and stop.
