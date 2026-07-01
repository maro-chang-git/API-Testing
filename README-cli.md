# API Testing — CLI mode

A headless, scriptable front-end to the same engine the browser app uses. It
generates test cases, fires live requests, validates responses, runs exploratory
testing and reports coverage — all from the terminal, with machine-readable
`--json` output so an **AI agent can drive it directly** (no browser, no LLM key).

> The browser app (`index.html`) is for interactive, visual work. The CLI is for
> speed, automation, logs, and AI-driven interaction with the tool's core features.

## Why a CLI

- **Fast & headless** — generate/export and run cases without opening a browser.
- **Scriptable & logged** — every command is non-interactive; `--log` tees a
  timestamped run log for CI.
- **AI-drivable** — `--json` gives one structured object per command on stdout;
  bodies pipe in via stdin / `@file`. The AI sends live requests, generates
  payloads, analyzes responses, debugs failures, updates specs, validates and
  updates test cases, runs exploratory testing, and evaluates coverage — all
  through these commands.

It reuses the browser's core modules unchanged (template matching, the Postman /
Karate exporters, schema validation, SSE parsing). A filesystem-backed `fetch`
shim (`cli/runtime/fs-fetch.js`) mirrors the dev server's contract: relative reads
come off disk, `/save` writes under `output/`, and live requests hit the network
directly (no CORS in Node, so no proxy needed).

## Requirements

- Node 18+ (developed on Node 24). **No extra dependencies** — argument parsing
  uses Node's built-in `util.parseArgs`; `fetch`/`performance` are Node globals.

## Quick start

```bash
# from the API Testing/ directory
node cli/index.js list                                   # available swaggers
node cli/index.js list --swagger testek                  # its tags + endpoints

# generate test cases (JSON + Postman + Karate) under output/testek/
node cli/index.js generate --swagger testek --endpoint "GET /me/profile" --postman --karate

# a realistic request body to tweak / pipe
node cli/index.js body --swagger testek --endpoint "POST /category"

# fire a live request and check it against the test case
node cli/index.js request --swagger testek --endpoint "GET /me/profile" --token "$TOKEN"
node cli/index.js request --swagger testek --endpoint "GET /me/profile" --case TC-AUTH-001

# exploratory: live response → derived assertions → folded into matching cases
node cli/index.js explore --swagger testek --endpoint "GET /me/profile" --token "$TOKEN" --save

# coverage across all endpoints
node cli/index.js coverage --swagger testek
```

Installed as a bin (`npm link` or via `package.json` `bin`), the same commands run
as `api-test <command> …`.

## Commands

| Command | Purpose |
|---|---|
| `list` | List swaggers, or the tags/endpoints of a swagger (`--swagger`). |
| `generate` | Generate test cases for an endpoint/tag/all → JSON file; add `--postman` / `--karate` (or `--format json,postman,karate`). Preserves saved run results across regenerations. |
| `body` | Print a realistic example request body (specs body if set, else from the schema). |
| `request` | Fire a live request; `--case TC-…` applies that case's auth preset and checks the response vs its expected status. Shows status, timing, headers, body, SSE reconstruction, schema validation. |
| `validate` | Validate a response body (`--body @file` / inline / stdin) against the spec's response schema for `--status`. |
| `explore` | Live request (or a `--body` sample) → derive data-driven assertions → fold into matching cases. `--save` re-writes the testcases JSON. |
| `coverage` | Per-endpoint category presence, auth-test coverage, and gaps (no-case / missing-auth endpoints). |
| `specs` | `specs get` prints effective values; `specs set` edits `output/{id}/specs.json` (`--base-url`, `--token`, `--request-type`, `--response-type`, `--auth-required`, `--header`, `--body`). |

### Target selection

Most commands accept one of:

- `--swagger <id>` — the swagger id from `swaggers/index.json` (default: first).
- `--endpoint "<METHOD> <path>"` — e.g. `--endpoint "GET /me/profile"`.
- `--tag <name>` — every endpoint under a tag.
- `--all` — every endpoint in the swagger.

### Global options

| Option | Meaning |
|---|---|
| `--json` | One machine-readable JSON object on stdout (diagnostics go to stderr). |
| `--log <file>` | Tee all output (timestamped, ANSI-stripped) to a log file. |
| `-v, --verbose` | Verbose diagnostics on stderr. |
| `--cwd <dir>` | Project root (default: the `API Testing` directory). |
| `-h, --help` | Show help. |

### Exit codes

`0` success (and the test case passed, if one was run) · `1` usage error **or** a
run test case failed · `2` a live request could not be made (network/URL error).

## AI / automation patterns

```bash
# discover, then generate everything as JSON for parsing
api-test list --json
api-test generate --swagger testek --all --json > cases.json

# generate a payload, edit it, send it
api-test body --swagger testek --endpoint "POST /category" > body.json
# …AI edits body.json…
api-test request --swagger testek --endpoint "POST /category" --token "$TOKEN" --body @body.json --json

# validate a captured response from another tool
curl -s "$API/me/profile" -H "Authorization: Bearer $TOKEN" \
  | api-test validate --swagger testek --endpoint "GET /me/profile" --status 200 --json

# run an auth test case in CI (non-zero exit on failure)
api-test request --swagger testek --endpoint "GET /me/profile" --case TC-AUTH-001 --log run.log
```

## Notes

- Outputs land under `output/{swaggerId}/` exactly like the browser's exports;
  `karate-config.js` is written once and never clobbered.
- `specs set` persists to `output/{id}/specs.json` — the same file the browser's
  "Save Specs" writes, so edits made in either place are picked up by the other.
- `--json` output never mixes with diagnostics; pipe stdout, watch stderr.
