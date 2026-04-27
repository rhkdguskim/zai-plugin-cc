---
name: zai-prompting
description: Internal guidance for shaping requests into tighter Z.AI (GLM) prompts before forwarding through zai-companion
user-invocable: false
---

# GLM Prompting Guide

Use this skill only inside the `zai:zai-consultant` subagent — and only to **rewrite the user's request into a tighter prompt** before the single forwarding `Bash` call. Do not use it to do independent analysis or repo inspection.

## Why GLM-specific prompting matters

GLM-5.1 (heavy default) and GLM-4.5-Air (ask) respond best to **short, structured, imperative** prompts. Unlike Claude, they tend to:

- Over-explain when the prompt is vague — pin the format down explicitly.
- Drop into Chinese mid-response if the prompt mixes languages — keep one language.
- Pad code blocks with prose unless told otherwise — say "code first, no preamble".
- Hallucinate filenames freely if you don't anchor them — quote real paths.

## Rewrite recipes by mode

### `code` (GLM-5.1)

Original user request → rewritten prompt body:

```
Original: "이거 좀 다시 짜줘"
Rewrite:  "Rewrite the function below. Output: a single fenced code block with the
           full replacement. No preamble. Keep the public signature.

           <CODE OR PATH HERE>"
```

Anchors:

- "Output: …" line states the deliverable shape.
- "No preamble" cuts GLM's habit of restating the task.
- If the user pasted only a function name, do **not** invent the body — refuse with a 1-line clarifying question.

### `review` (GLM-5.1)

The companion script already collects the diff and wraps the user's free-text into a `Review the following git diff…` prompt with the section structure (Bugs, Security, Style/Maintainability, Tests). Your job here is only to add the user's **focus** text if they provided one — e.g., "extra focus: race conditions in db.go". Don't expand or rephrase the standard scaffold.

### `consult` (GLM-5.1)

```
Original: "큐 넣을지 SSE로 끝낼지"
Rewrite:  "Compare two options for the following problem. For each option give:
           1. one-paragraph sketch, 2. top 3 risks, 3. when it wins.
           End with a single recommendation and the decisive factor.

           Problem: <USER TEXT>"
```

Anchors:

- Numbered output structure pins GLM down.
- "End with a single recommendation" prevents fence-sitting.

### `ask` (GLM-4.5-Air)

Keep prompts short. The model is fast but loose — strip context that isn't load-bearing.

```
Original: "왜 이게 ReDoS 걱정되는거야 ^(a+)+$ 이거"
Rewrite:  "Why is the regex `^(a+)+$` ReDoS-vulnerable? Answer in 3 short
           bullets, then one mitigation."
```

## What to never put in the prompt

- The token, repo paths outside the working tree, or env values.
- "Pretend you are Claude" framing — let GLM be GLM.
- Long history of prior turns. The companion runs single-shot calls; there is no thread context to preserve.
- Internal tool names (`Bash`, `Read`, `Grep`). GLM cannot use them.

## Hard limits

- Total prompt body: aim for <8K characters. Hard fail >32K.
- One language per prompt. If the user mixed Korean + English, pick the dominant one and translate the rest.
- One ask per call. If the user packs 3 questions, return early and ask which one to forward.
