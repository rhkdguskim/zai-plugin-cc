---
name: zai-cli-runtime
description: Internal helper contract for calling the zai-companion runtime from the zai-consultant subagent
user-invocable: false
---

# Z.AI Runtime

Use this skill only inside the `zai:zai-consultant` subagent.

## Primary helpers

- `node "${CLAUDE_PLUGIN_ROOT}/scripts/zai-companion.mjs" code    [--background] [--model <m>] <task>`
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/zai-companion.mjs" consult [--background] <topic>`
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/zai-companion.mjs" review  [--background] [--base <ref>]`
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/zai-companion.mjs" ask     <question>`

## Execution rules

- The consultant subagent is a forwarder, not an orchestrator. Its only job is to invoke one of the four helpers above **once** and return that stdout unchanged.
- Prefer the helper over hand-rolled `git`, direct curl to `api.z.ai`, or any other Bash activity.
- Do not call `setup`, `status`, `result`, or `cancel` from `zai:zai-consultant`. Those are user-facing slash commands only.
- Use exactly one helper invocation per delegation. If the user really needs two passes, return after the first and let the user re-invoke.
- You may use the `zai-prompting` skill to rewrite the user's request into a tighter prompt **before** the single helper call.
- That prompt drafting is the only Claude-side work allowed. Do not inspect the repo, solve the task yourself, or add independent analysis outside the forwarded prompt text.
- Leave `--model` unset by default. Add it only when the user explicitly asks for `glm-4.6`, `glm-4.5-air`, `glm-4.5-flash`, etc.

## Command selection

| User intent | Helper |
|-------------|--------|
| Write / patch / generate code | `code` |
| Review existing diff or branch | `review` |
| Discuss design / tradeoffs / strategy | `consult` |
| Quick factual or short answer | `ask` |

Default to `code` when the user is asking for a write-style task. Default to `consult` for open-ended design questions. Use `ask` only for clearly short single-shot questions.

## Routing flags

- `--background`: run in a Claude background task. Strip the flag from the natural-language task body.
- `--wait`: foreground. Strip it from the body.
- `--model <m>`: pass through to the helper. Strip from the body.
- `--base <ref>`: only valid for `review`. Pass through.

If neither `--background` nor `--wait` is present, the slash command itself decides via `AskUserQuestion`. By the time control reaches this subagent, that decision has already been made.

## Safety rules

- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the helper command exactly as-is.
- If the Bash call fails or the runtime cannot be invoked, return nothing.
- If the helper reports the API key is missing, return that message verbatim — the user will be told to run `/zai:setup`.
