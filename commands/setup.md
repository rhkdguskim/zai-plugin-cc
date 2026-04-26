---
description: Register or refresh your Z.AI API key and verify connectivity to GLM models
argument-hint: '[--reset] [--key <api-key>]'
allowed-tools: Bash(node:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/zai-companion.mjs" setup $ARGUMENTS
```

Behavior:

- If the runtime says no key is configured and no key was passed, the script will prompt for one on stdin. In Claude Code that prompt will not echo cleanly — instead, ask the user via `AskUserQuestion`:
  - Question: "Paste your Z.AI API key (https://z.ai/model-api). It will be stored in `~/.config/zai-plugin-cc/config.json` with mode 0600."
  - When the user supplies the key, rerun:

    ```bash
    node "${CLAUDE_PLUGIN_ROOT}/scripts/zai-companion.mjs" setup --key <key>
    ```

- Present the script output to the user. Do not summarize or hide the available-models line.
- If the verification fails, surface the exact error and the hint to check their key at https://z.ai/model-api.
- If `--reset` was passed, just relay the script output (the file was removed).
