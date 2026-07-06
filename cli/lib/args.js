'use strict';

/**
 * CLI argument parsing. Supports BOTH --flag=value and --flag value forms for
 * value flags (a real bug once: run.sh passed "--project X" and the parser
 * stored project=true, crashing Firestore with a non-string projectId).
 */

const VALUE_FLAGS = new Set(['project', 'sa', 'every']);

function parseArgs(argv, env = process.env) {
  const a = { flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      if (eq !== -1) {
        a.flags[t.slice(2, eq)] = t.slice(eq + 1);
      } else {
        const name = t.slice(2);
        const next = argv[i + 1];
        if (VALUE_FLAGS.has(name) && next !== undefined && !next.startsWith('--')) {
          a.flags[name] = next; i++;
        } else {
          a.flags[name] = true;
        }
      }
    } else if (!a.sheet) {
      a.sheet = t;
    }
  }
  if (!a.sheet && env.SHEET) a.sheet = env.SHEET;
  if (env.SHEETSYNC_AUTO && !('auto' in a.flags)) { a.flags.auto = true; a.flags.yes = true; }
  return a;
}

module.exports = { parseArgs, VALUE_FLAGS };
