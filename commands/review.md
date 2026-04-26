---
description: Run a Z.AI (GLM-4.6) code review against local git state. Review-only, no patches.
argument-hint: '[--wait|--background] [--base <ref>]'
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

Execution mode rules:

- If the raw arguments include `--wait`, run in foreground.
- If the raw arguments include `--background`, run in a Claude background task.
- Otherwise, estimate the review size:
  - Use `git status --short --untracked-files=all` and `git diff --shortstat` (and `--cached`) for working-tree review.
  - For base-branch review, use `git diff --shortstat <base>...HEAD`.
  - Recommend `Wait` only if the review is roughly 1-2 files; otherwise recommend `Run in background`.
- Use `AskUserQuestion` exactly once with two options, putting the recommended one first with `(Recommended)`:
  - `Wait for results`
  - `Run in background`

Foreground flow:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/zai-companion.mjs" review $ARGUMENTS
```

Return the command stdout verbatim, exactly as-is. Do not paraphrase, summarize, or add commentary.

Background flow:

```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/zai-companion.mjs" review $ARGUMENTS`,
  description: "Z.AI review",
  run_in_background: true
})
```

After launching, tell the user: "Z.AI review started in the background. Check `/zai:status` for progress."

If the runtime says the API key is missing, tell the user to run `/zai:setup`.
