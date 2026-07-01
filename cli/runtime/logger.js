// CLI logger. Two output channels, kept strictly separate so the CLI is both
// human-friendly and machine-drivable:
//
//   • stdout — the command's PRIMARY output only. In --json mode that's a single
//     JSON object; otherwise a human-readable report. Safe to pipe / parse.
//   • stderr — diagnostics (info/step/warn/error/debug). Never pollutes stdout.
//
// `--log <file>` tees every line (both channels, ANSI-stripped, timestamped) to a
// file — the "output log" for automation / CI runs.

import { appendFileSync } from 'node:fs';

// ESC is a control char; build the matcher from a string so the regex literal
// stays control-char-free (keeps eslint's no-control-regex happy).
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));

export const color = {
  bold: (s) => paint('1', s),
  dim: (s) => paint('2', s),
  red: (s) => paint('31', s),
  green: (s) => paint('32', s),
  yellow: (s) => paint('33', s),
  cyan: (s) => paint('36', s),
};

export function createLogger({ json = false, logFile = null, verbose = false } = {}) {
  const startTime = performance.now();

  const tee = (line) => {
    if (!logFile) return;
    try { appendFileSync(logFile, `${new Date().toISOString()} ${line.replace(ANSI, '')}\n`); }
    catch { /* logging must never crash the command */ }
  };

  const toErr = (line) => { process.stderr.write(line + '\n'); tee(line); };
  const toOut = (line) => { process.stdout.write(line + '\n'); tee(line); };

  return {
    json,
    // ── diagnostics → stderr ──
    info: (msg) => { if (!json) toErr(color.cyan('• ') + msg); else tee('• ' + msg); },
    step: (msg) => { if (!json) toErr(color.bold('  ▸ ') + msg); else tee(msg); },
    warn: (msg) => toErr(color.yellow('⚠ ') + msg),
    error: (msg) => toErr(color.red('✖ ') + msg),
    debug: (msg) => { if (verbose) toErr(color.dim('  ' + msg)); },

    // Phase banner — blank line + bold command header; stderr, suppressed in --json.
    banner(title) {
      if (json) return;
      toErr('');
      toErr(color.bold(color.cyan('▶') + ' ' + title));
    },

    // ── primary output → stdout ──
    out: (line = '') => toOut(line),

    // Horizontal rule — visual separator before totals; use inside result() render lambdas.
    rule: () => toOut(color.dim('  ' + '─'.repeat(52))),

    // "Next steps:" guidance block — stdout, suppressed in --json.
    nextSteps(steps) {
      if (json) return;
      toOut('');
      toOut(color.bold('Next steps:'));
      for (const s of steps) toOut(`  ${color.cyan('→')} ${s}`);
    },

    // Elapsed time since this logger was created (formatted for inline use).
    elapsed: () => color.dim(`${Math.round(performance.now() - startTime)}ms`),

    // Emit a command's result: one JSON object in --json mode, else render it
    // human-readably via the supplied function.
    result(obj, render) {
      if (json) toOut(JSON.stringify(obj, null, 2));
      else if (render) render(obj);
    },
  };
}
