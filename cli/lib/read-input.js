// Reads a --body / payload argument in the three forms the CLI accepts:
//   @path   → read the file at <path>
//   -       → read stdin
//   <text>  → the literal string
// Returns the raw text (callers JSON.parse as needed) or null when no arg given.

import { readFile } from 'node:fs/promises';
import { UsageError } from './errors.js';
import path from 'node:path';

// Parse repeated --header "Name: value" flags into an ordered name→value map.
export function parseHeaderFlags(flags = []) {
  const out = {};
  for (const h of flags) {
    const i = h.indexOf(':');
    if (i < 0) throw new UsageError(`Invalid --header "${h}". Expected "Name: value".`);
    out[h.slice(0, i).trim()] = h.slice(i + 1).trim();
  }
  return out;
}

export async function readBodyArg(arg, projectRoot = process.cwd()) {
  if (arg == null) return null;

  if (arg === '-') return readStdin();

  if (arg.startsWith('@')) {
    const file = arg.slice(1);
    // Resolve relative @file against the user's real CWD, not the project root
    // (projectRoot is the API Testing directory — wrong for files the user created
    // in their shell's working directory).
    return readFile(path.isAbsolute(file) ? file : path.join(process.cwd(), file), 'utf8');
  }

  return arg;
}

function readStdin() {
  // Fail fast when stdin is a terminal — the process would block forever waiting
  // for EOF that never comes, with no prompt shown to the user.
  if (process.stdin.isTTY) {
    throw new UsageError('No input on stdin — pass --body @file, an inline value, or pipe a body.');
  }
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}
