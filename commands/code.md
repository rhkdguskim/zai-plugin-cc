---
description: Delegate a coding task to Z.AI (GLM-5.1) and APPLY the resulting edits to the working tree.
argument-hint: '[--wait|--background] [--advisory] [--model <id>] <task...>'
allowed-tools: Bash(node:*), Bash(git:*), Bash(rm:*), Read, Edit, Write, AskUserQuestion, Agent
---

Invoke the `zai:zai-consultant` subagent via the `Agent` tool (`subagent_type: "zai:zai-consultant"`), forwarding the raw user request as the prompt. The subagent's only job is to call `node "${CLAUDE_PLUGIN_ROOT}/scripts/zai-companion.mjs" code ...` once and return its stdout verbatim.

Raw user request:
$ARGUMENTS

<use_parallel_tool_calls>
If you intend to call multiple tools and there are no dependencies between the tool calls, make all of the independent tool calls in parallel. Prioritize calling tools simultaneously whenever the actions can be done in parallel rather than sequentially. For example, when reading 3 files, run 3 tool calls in parallel to read all 3 files into context at the same time. Maximize use of parallel tool calls where possible to increase speed and efficiency. However, if some tool calls depend on previous calls to inform dependent values like the parameters, do NOT call these tools in parallel and instead call them sequentially. Never use placeholders or guess missing parameters in tool calls.
</use_parallel_tool_calls>

## Execution mode

- If the request includes `--wait`, run the subagent in the foreground.
- If the request includes `--background`, run the subagent in the background. Background mode is **advisory only** — the apply step below does not run because the user has already moved on. Tell the user to view the result with `/zai:result <id>` and decide whether to apply manually.
- If the request includes `--advisory`, skip the apply step even in foreground (just print Z.AI's edit plan).
- If neither `--wait` nor `--background` is present, estimate task size. If you read project files or check git state to estimate, issue those reads in parallel within a single message — they are independent. Examples: `git status --short`, a single Glob, two or three Read calls. Do not parallelize the AskUserQuestion or the final Agent dispatch with this measurement batch — those are sequential.
- After measurement, if small + self-contained → recommend foreground; otherwise → recommend background. Use `AskUserQuestion` exactly once with two choices, putting the recommended option first and suffixing it with `(Recommended)`:
  - `Wait for results`
  - `Run in background`

## Argument handling

- Preserve the user's arguments exactly when forwarding to the subagent.
- Do not strip `--wait` / `--background` / `--model` / `--advisory` yourself — the subagent and downstream commands route on them.
- Do not paraphrase, summarize, or rewrite the user's intent.

## Foreground apply procedure (the new contract)

You will receive an envelope on stdout. Two shapes are possible:

1. `<zai_response kind="code" model="…" job_id="…" elapsed_ms="…">BODY</zai_response>`
   - The BODY contains zero or more `<zai_edit path="…" op="edit|create|delete">…</zai_edit>` blocks, OR a single `<zai_clarify>question</zai_clarify>`.
2. `<zai_dispatched kind="code" model="…" job_id="…" mode="background"/>` — background path; tell the user to use `/zai:result <id>` and stop.

If the BODY is a `<zai_clarify>`, surface that question to the user verbatim and stop. Do NOT apply anything.

Otherwise, for each `<zai_edit>` block in document order, **apply the change**:

### `op="edit"` — surgical search-and-replace

The block contains an aider-style fenced patch:

```text
<<<<<<< SEARCH
<old text — must match the file byte-for-byte>
=======
<new text>
>>>>>>> REPLACE
```

Procedure:
1. **Read** the file at `path` (path is repo-relative).
2. Use the **Edit** tool with `old_string` = the SEARCH block content (everything between `<<<<<<< SEARCH\n` and `\n=======`), `new_string` = the REPLACE block content (everything between `\n=======\n` and `\n>>>>>>> REPLACE`). Preserve exact whitespace.
3. If the Edit tool reports "string not found" or "string is not unique", do NOT retry blindly — report the failure to the user with the file path and a short note ("SEARCH block did not match — re-run with `--advisory` to inspect"), then continue with the remaining `<zai_edit>` blocks.

If the same file appears in multiple `op="edit"` blocks, apply them in order. Re-Read between applications only if a later SEARCH overlaps with an earlier change.

### `op="create"` — new file or full rewrite

The block contains:

```text
<<<<<<< CREATE
<full file content>
>>>>>>> END
```

Procedure:
1. Use the **Write** tool with `file_path` = `path` and `content` = everything between `<<<<<<< CREATE\n` and `\n>>>>>>> END`.
2. If the file already exists, Write replaces it. If a Read of the same file occurred earlier in this turn, that Read covers Write's "must read first" requirement.

### `op="delete"` — remove a file

The block is self-closing: `<zai_edit path="…" op="delete"/>`. Use **Bash** with `rm "<path>"` (quoted to handle spaces). Do not use `rm -rf`.

## After applying

Print one short summary block to the user:

```
Applied N changes from glm/<model> (job <id>):
  - edited:  path/a.ts, path/b.ts
  - created: path/new.ts
  - deleted: path/dead.ts
  - failed:  path/c.ts (SEARCH did not match)
```

Do NOT echo the raw `<zai_edit>` blocks back. Do NOT paste GLM's response verbatim. The summary above is the user-facing output.

## Errors

- On `<zai_error kind="auth" …>` (stderr), tell the user to run `/zai:setup` and stop.
- On any other `<zai_error …>MSG</zai_error>`, surface MSG verbatim and stop.
- If the BODY is empty or contains no recognizable `<zai_edit>` / `<zai_clarify>` tags, print: "GLM returned no actionable patch. Re-run with `/zai:code --advisory` to inspect the raw response."

## Operating rules

- Never invent edits Z.AI didn't ask for.
- Never apply edits when in `--background` or `--advisory` mode.
- If the user supplied no task body, ask what Z.AI should build.
