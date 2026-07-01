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
  timestamped run log.
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

## Workflow

Each step writes machine-readable JSON to stdout. The AI reads that output,
decides what to change, edits files or re-runs commands, then moves to the next
step. Pass `--json` on every command to get the structured result; pass `--log
<file>` to tee a timestamped, ANSI-stripped run log alongside it.

---

### Step 0 — Configure the swagger (once)

Set the real base URL, auth token, and any fixed headers before running anything.
The values persist in `output/{id}/specs.json` and are picked up by every
subsequent command.

```bash
node cli/index.js specs set --swagger testek \
  --base-url "https://api.example.com" \
  --token "$TOKEN"

node cli/index.js specs get --swagger testek --json
# AI reads: { baseUrl, token, headers, authRequired }
# AI checks: baseUrl is not blank, token is set.
# If not: re-run specs set with the correct values before continuing.
```

---

### Step 1 — Discover

```bash
node cli/index.js list --json
# AI reads: [{ id, title, file }]
# AI picks the target swagger id for all subsequent steps.

node cli/index.js list --swagger testek --json
# AI reads: { tags, endpoints: [{ method, path, tags, summary }] }
# AI builds a work list: which endpoints to test, which tags to focus on.
```

---

### Step 2 — Generate test cases

Start with a single endpoint to verify output before running the whole swagger.

```bash
# Single endpoint — JSON output only:
node cli/index.js generate --swagger testek --endpoint "GET /me/profile" --json
# AI reads: [{ id, endpoint, category, expected_status, description }]
# AI checks: are all 5 categories present? (happy_path, positive, negative, auth, boundary)

# Single endpoint — also write Postman + Karate files:
node cli/index.js generate --swagger testek --endpoint "GET /me/profile" --postman --karate --json

# All endpoints at once (after single-endpoint check looks good):
node cli/index.js generate --swagger testek --all --postman --karate --json > cases.json
# AI reviews cases.json: are all 5 categories present for every key endpoint?
# If auth cases are absent from an endpoint, flag it — explore (Step 3) will
# fire a live request and auto-promote it to auth-required if the API returns 401/403.
```

---

### Step 3 — Seed with real data (explore + save)

`explore --save` fires a live request against the endpoint, derives field-presence
and type assertions from the real JSON response, and folds them into the matching
template case in `output/{id}/testcases.json`. This is the CLI equivalent of
building an `api_data/` scaffold: you start with schema-generated skeletons and
enrich them with what the API actually returns.

```bash
node cli/index.js explore --swagger testek \
  --endpoint "GET /me/profile" --token "$TOKEN" --save --json
# AI reads: { assertions: [...], folded: 3, saved: true }
# AI checks: folded > 0 means assertions were derived and written.
# If folded: 0, the response may have been empty or an error — investigate
# with Step 4 before re-exploring.

# Seed every endpoint at once:
node cli/index.js explore --swagger testek --all --token "$TOKEN" --save --json
```

---

### Step 4 — Execute test cases

```bash
# Run all template cases for one endpoint:
node cli/index.js request --swagger testek \
  --endpoint "GET /me/profile" --token "$TOKEN" --json
# AI reads: { status, ok, timing_ms, headers, body, case: { id, passed, expected_status } }
# If ok: false or case.passed: false → AI inspects body/headers, adjusts specs
# or the request body, then retries.

# Run a specific named case (exit 1 if status ≠ expected):
node cli/index.js request --swagger testek \
  --endpoint "GET /me/profile" --case TC-AUTH-001 --json --log run.log
```

`--case` behavior: if the id exists, applies that case's auth preset and exits 1
when the actual response status ≠ `expected_status`. If the id does not exist,
exits 1 with an error message on stderr.

A 401 / 403 live response automatically promotes the endpoint to auth-required
and adds auth test cases — same as the browser's Try It tab.

---

### Step 5 — Validate captured responses

```bash
curl -s "$API/me/profile" -H "Authorization: Bearer $TOKEN" \
  | node cli/index.js validate --swagger testek \
      --endpoint "GET /me/profile" --status 200 --json
# AI reads: { valid, errors: [{ message, path }] }
# If valid: false → AI reads errors, edits the body or the spec, re-validates.

# Validate a file captured by another tool:
node cli/index.js validate --swagger testek \
  --endpoint "POST /category" --status 201 --body @resp.json --json
```

---

### Step 6 — Review coverage

```bash
node cli/index.js coverage --swagger testek --json
# AI reads: { total, covered, uncovered, gaps: [{ endpoint, missing: [category] }] }
# For each gap: AI runs explore --save on that endpoint, then re-checks coverage.
# Repeat until uncovered: 0 or the remaining gaps are intentional.
```

---

### Step 7 — Run the exported collection

```bash
# Newman / Postman (requires: npm install -g newman newman-reporter-htmlextra)
npm run newman -- output/testek/testek-collection.json

# With environment file + HTML report:
npx newman run output/testek/testek-collection.json \
  -e output/testek/environment.json \
  --reporters cli,htmlextra \
  --reporter-htmlextra-export output/testek/report.html
# AI reads newman-report.json → identifies failing requests → loops back to Step 4.

# Karate (run once: npm run karate:setup  — downloads the JAR under tools/)
npm run karate -- output/testek/testek.feature
```

---

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

### Test categories

`generate` produces cases in up to six categories per endpoint, depending on the
method and what the spec declares:

| Category | What it tests | Typical status |
|---|---|---|
| `happy_path` | Valid request, correct auth | 2xx |
| `positive` | Required fields only, valid enum values | 2xx |
| `negative` | Bad format, special chars, wrong URL | 400 / 404 |
| `auth` | Missing / expired / invalid token | 401 / 403 |
| `boundary` | Min/max length, null, empty, zero | 400 / 2xx |
| `generated` | Data-driven assertions from `explore --save` | (mirrors live) |

A 401 / 403 live response from `request` auto-promotes the endpoint to
auth-required and adds the `auth` cases, same as the browser's Try It tab.

### Options per command

```
generate
  --swagger <id>                 target swagger (default: first)
  --endpoint "METHOD /path"      single endpoint
  --tag <name>                   all endpoints under a tag
  --all                          every endpoint in the swagger
  --postman                      also write a Postman collection
  --karate                       also write a Karate .feature file
  --format json,postman,karate   alternative to the above flags

body
  --swagger <id>
  --endpoint "METHOD /path"

request
  --swagger <id>
  --endpoint "METHOD /path"
  --case TC-…        apply this case's auth preset; exit 1 if status ≠ expected
  --token <value>    override the effective token for this run
  --body @file       request body from file (use @- for stdin)
  --body <json>      request body inline

validate
  --swagger <id>
  --endpoint "METHOD /path"
  --status <code>    expected response status (used to pick the response schema)
  --body @file       response body from file; omit to read from stdin

explore
  --swagger <id>
  --endpoint "METHOD /path"  |  --tag <name>  |  --all
  --token <value>
  --body @file               supply a body sample instead of firing a live request
  --save                     re-write testcases JSON with the folded assertions

coverage
  --swagger <id>

specs get
  --swagger <id>

specs set
  --swagger <id>
  --base-url <url>
  --token <value>
  --header <name>=<value>      (repeatable)
  --body <json>
  --request-type <type>
  --response-type <type>
  --auth-required true|false
```

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

## JSON output schemas (`--json`)

The shape of stdout for each command. Diagnostics always go to stderr — stdout is
safe to pipe or capture.

```
list (no --swagger):
[{ "id": "testek", "title": "TestEK API", "file": "swaggers/testek.json" }]

list --swagger <id>:
{ "tags": ["Users", "Products"],
  "endpoints": [{ "method": "GET", "path": "/me/profile", "tags": [...], "summary": "..." }] }

generate:
[{ "id": "TC-HP-001", "endpoint": "GET /me/profile",
   "category": "happy_path", "expected_status": 200, "description": "..." }]

body:
{ "contentType": "application/json", "body": { ... } }

request:
{ "status": 200, "ok": true, "timing_ms": 123,
  "headers": { ... }, "body": { ... },
  "case": { "id": "TC-AUTH-001", "passed": true, "expected_status": 401 } }

validate:
{ "valid": true, "errors": [] }
{ "valid": false, "errors": [{ "message": "must be string", "path": "/name" }] }

explore:
{ "assertions": [...], "folded": 3, "saved": true }

coverage:
{ "total": 12, "covered": 10, "uncovered": 2,
  "gaps": [{ "endpoint": "POST /category", "missing": ["auth"] }] }

specs get:
{ "baseUrl": "https://...", "token": "...", "headers": { ... }, "authRequired": true }
```

## AI / automation patterns

### Pattern A — Full discovery-to-coverage loop

```bash
# Step 1: discover
api-test list --json
api-test list --swagger testek --json

# Step 2: generate everything
api-test generate --swagger testek --all --postman --karate --json > cases.json
# AI reviews cases.json — notes which endpoints are missing auth/boundary cases

# Step 3: seed with real data
api-test explore --swagger testek --all --token "$TOKEN" --save --json

# Step 6: coverage check — repeat Steps 3→6 until gaps are closed
api-test coverage --swagger testek --json
```

### Pattern B — Investigate a failing case

```bash
api-test request --swagger testek \
  --endpoint "POST /category" --case TC-AUTH-001 --json 2>err.log
# AI reads JSON: ok:false, status:500 → inspects body, edits body.json

api-test request --swagger testek \
  --endpoint "POST /category" --body @body.json --token "$TOKEN" --json
# Retry after fix; repeat until case.passed: true
```

### Pattern C — Validate an externally captured response

```bash
curl -s "$API/products" -H "Authorization: Bearer $TOKEN" > resp.json

api-test validate --swagger testek \
  --endpoint "GET /products" --status 200 --body @resp.json --json
# AI reads { valid, errors } — reports schema violations and their JSON paths
```

### Pattern D — Generate payload, AI edits, send

```bash
# Get a realistic request body from the spec
api-test body --swagger testek --endpoint "POST /category" --json > body.json

# …AI replaces placeholder values with real data…

api-test request --swagger testek \
  --endpoint "POST /category" --token "$TOKEN" --body @body.json --json
```

## Notes

- Outputs land under `output/{swaggerId}/` exactly like the browser's exports;
  `karate-config.js` is written once and never clobbered.
- `specs set` persists to `output/{id}/specs.json` — the same file the browser's
  "Save Specs" writes, so edits made in either place are picked up by the other.
- `explore --save` rewrites `output/{id}/testcases.json` in place. It folds
  derived assertions into the matching template case without touching other cases.
- `--json` output never mixes with diagnostics; pipe stdout, watch stderr.
