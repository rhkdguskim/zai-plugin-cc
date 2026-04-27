// Flag parser for the zai-companion CLI.
//
// Supported forms:
//   --background, --wait, --reset, --json    boolean flags
//   --model glm-4.6     value via next argv
//   --model=glm-4.6     value via '=' form
//   --key sk-xxx        value via next argv
//   --key=sk-xxx        value via '=' form
//   --base main         value via next argv
//   --base=main         value via '=' form
//
// Anything not matching is collected as positional. Unknown long flags
// produce an explicit error so silent typos don't go unnoticed.

const VALUE_FLAGS = new Set(['--model', '--key', '--base']);
const BOOL_FLAGS  = new Set(['--background', '--wait', '--reset', '--json', '--human']);

const FLAG_TO_PROP = {
  '--background': 'background',
  '--wait':       'wait',
  '--reset':      'reset',
  '--json':       'json',
  '--human':      'human',
  '--model':      'model',
  '--key':        'key',
  '--base':       'base',
};

export class FlagError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FlagError';
  }
}

export function parseFlags(argv) {
  const flags = {};
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];

    if (typeof tok !== 'string') continue;

    // Long flag with embedded value: --name=value
    if (tok.startsWith('--') && tok.includes('=')) {
      const eq = tok.indexOf('=');
      const name = tok.slice(0, eq);
      const value = tok.slice(eq + 1);
      if (!VALUE_FLAGS.has(name)) {
        if (BOOL_FLAGS.has(name)) {
          throw new FlagError(`Boolean flag does not take a value: ${name}`);
        }
        throw new FlagError(`Unknown flag: ${name}`);
      }
      if (!value) throw new FlagError(`Missing value for ${name}`);
      flags[FLAG_TO_PROP[name]] = value;
      continue;
    }

    if (BOOL_FLAGS.has(tok)) {
      flags[FLAG_TO_PROP[tok]] = true;
      continue;
    }

    if (VALUE_FLAGS.has(tok)) {
      const next = argv[i + 1];
      if (next == null || next.startsWith('--')) {
        throw new FlagError(`Missing value for ${tok}`);
      }
      flags[FLAG_TO_PROP[tok]] = next;
      i += 1;
      continue;
    }

    if (tok.startsWith('--')) {
      throw new FlagError(`Unknown flag: ${tok}`);
    }

    // Treat empty strings as a no-op so that `bash` passes "" silently
    // (e.g. when $ARGUMENTS is empty in a slash command).
    if (tok === '') continue;

    positional.push(tok);
  }

  return { flags, positional };
}
