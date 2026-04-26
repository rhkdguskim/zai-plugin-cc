const SYSTEM_BASE = `You are GLM operating as a sidekick brain to a developer working inside Claude Code.
Be direct, technical, and concise. When you write code, output it inside fenced blocks with the language tag.
If the request is ambiguous, ask one sharp clarifying question instead of guessing.`;

export function buildAsk(question) {
  return [
    { role: 'system', content: `${SYSTEM_BASE}\n\nMode: ASK. Answer in 1-3 short paragraphs. No preamble.` },
    { role: 'user', content: question },
  ];
}

export function buildCode(task, context) {
  const userParts = [task];
  if (context) userParts.push(`\n---\nRelevant context:\n${context}`);
  return [
    { role: 'system', content: `${SYSTEM_BASE}\n\nMode: CODE. Think briefly, then output the final code or patch. Prefer minimal diffs over rewriting.` },
    { role: 'user', content: userParts.join('\n') },
  ];
}

export function buildReview(diff, focus) {
  const userParts = [
    'Review the following git diff. Group findings under: Bugs, Security, Style/Maintainability, Tests. Cite file:line where possible. Skip nitpicks.',
  ];
  if (focus) userParts.push(`Extra focus: ${focus}`);
  userParts.push('\n--- DIFF ---');
  userParts.push(diff);
  return [
    { role: 'system', content: `${SYSTEM_BASE}\n\nMode: REVIEW. Be a strict but fair second reviewer.` },
    { role: 'user', content: userParts.join('\n') },
  ];
}

export function buildConsult(topic, context) {
  const userParts = [topic];
  if (context) userParts.push(`\nContext:\n${context}`);
  return [
    { role: 'system', content: `${SYSTEM_BASE}\n\nMode: CONSULT. Explore options, name tradeoffs explicitly, then give a recommendation. Do not produce code unless asked.` },
    { role: 'user', content: userParts.join('\n') },
  ];
}
