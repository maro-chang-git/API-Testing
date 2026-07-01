#!/usr/bin/env node
// API Testing — CLI mode.
//
// A headless, scriptable front-end to the same core the browser app uses
// (generation, exports, live requests, validation, coverage). Built to be driven
// fast by an AI agent: every command supports --json for machine-readable output,
// and reads stdin / writes files without a browser in the loop.
//
// Usage:  node cli/index.js <command> [options]   (or `api-test <command>` once linked)

import { parseArgs } from 'node:util';
import { createContext } from './runtime/context.js';
import { createLogger, color } from './runtime/logger.js';
import { UsageError } from './lib/errors.js';

// Union of every command's flags. parseArgs is strict, so a typo'd flag is caught
// rather than silently ignored. Each command reads only the flags it needs.
const OPTIONS = {
  // global
  swagger: { type: 'string' },
  tag: { type: 'string' },
  endpoint: { type: 'string' },
  all: { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
  log: { type: 'string' },
  verbose: { type: 'boolean', short: 'v', default: false },
  cwd: { type: 'string' },
  out: { type: 'string' },
  help: { type: 'boolean', short: 'h', default: false },
  // generate / export
  postman: { type: 'boolean', default: false },
  karate: { type: 'boolean', default: false },
  format: { type: 'string' },
  // request / explore / validate
  case: { type: 'string' },
  'base-url': { type: 'string' },
  token: { type: 'string' },
  body: { type: 'string' },
  header: { type: 'string', multiple: true },
  status: { type: 'string' },
  save: { type: 'boolean', default: false },
  // specs set
  'request-type': { type: 'string' },
  'response-type': { type: 'string' },
  'auth-required': { type: 'string' },
};

const COMMANDS = ['list', 'generate', 'body', 'request', 'validate', 'explore', 'coverage', 'specs'];

const HELP = `${color.bold('API Testing — CLI mode')}

Usage: api-test <command> [options]

Commands:
  list        List swaggers, or the tags/endpoints of a swagger
  generate    Generate test cases for endpoint(s) → JSON (+ Postman / Karate)
  body        Print a realistic example request body for an endpoint
  request     Fire a live HTTP request (optionally for a specific test case)
  validate    Validate a response body against the spec's response schema
  explore     Live request → derive assertions → fold into matching cases
  coverage    Report test coverage across a swagger's endpoints
  specs       Get/set output/{id}/specs.json (base URL, auth, types, headers…)

Target selection (most commands):
  --swagger <id>            Swagger id from swaggers/index.json (default: first)
  --endpoint "<M> <path>"   e.g. --endpoint "GET /me/profile"
  --tag <name>              All endpoints under a tag
  --all                     All endpoints in the swagger

Global options:
  --json                    Machine-readable output (one JSON object on stdout)
  --log <file>              Tee all output to a log file (timestamped)
  -v, --verbose             Verbose diagnostics on stderr
  --cwd <dir>               Project root (default: the API Testing directory)
  -h, --help                Show this help

Examples:
  api-test list
  api-test list --swagger testek
  api-test generate --swagger testek --endpoint "GET /me/profile" --json
  api-test generate --swagger testek --all --postman --karate
  api-test body --swagger testek --endpoint "POST /category"
  api-test request --swagger testek --endpoint "GET /me/profile" --token "$TOKEN"
  api-test request --swagger testek --endpoint "GET /me/profile" --case TC-AUTH-001
  api-test validate --swagger testek --endpoint "GET /me/profile" --status 200 --body @resp.json
  api-test explore --swagger testek --endpoint "GET /me/profile" --token "$TOKEN" --save
  api-test coverage --swagger testek
  api-test specs get --swagger testek
  api-test specs set --swagger testek --token "$TOKEN" --base-url https://api.example.com
`;

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (e) {
    throw new UsageError(e.message);
  }
  const args = { ...parsed.values, _: parsed.positionals };
  const command = args._[0];

  if (args.help || !command) {
    process.stdout.write(HELP);
    return 0;
  }
  if (!COMMANDS.includes(command)) {
    throw new UsageError(`Unknown command "${command}". Run with --help for the command list.`);
  }

  const logger = createLogger({ json: args.json, logFile: args.log, verbose: args.verbose });
  const ctx = await createContext({ cwd: args.cwd });

  const { run } = await import(`./commands/${command}.js`);
  const code = await run(ctx, args, logger);
  return code ?? 0;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    const isUsage = err instanceof UsageError;
    // In --json mode a parse error has no logger yet; print a JSON error to stderr.
    process.stderr.write(`${color.red('✖')} ${err.message}\n`);
    if (process.argv.includes('--verbose') || process.argv.includes('-v')) {
      process.stderr.write((err.stack || '') + '\n');
    }
    process.exit(isUsage ? 1 : 2);
  });
