# API Test Cases Viewer

An interactive browser tool that generates test cases for any REST API endpoint by matching a general-purpose template library against a selected Swagger / OpenAPI spec — then lets you run the cases directly in the browser and export them to **JSON**, **Postman**, or **Karate**.

Pure ES modules with no build step. Dev tooling (Vite, ESLint) is available via npm but not required to open the app.

## Features

- **Auto-generated test cases** — select an endpoint and the tool matches applicable templates from `data/templates.json` (happy-path, positive, negative, auth, boundary)
- **Swagger 2.0 *and* OpenAPI 3.x** — tags, endpoints, request bodies, security, and response schemas are read from either spec version
- **Try It tab** — configure auth, headers, query/path params, and request body, then send real requests from the browser. The auth style is pre-selected from the spec's security scheme, and the operation's `in: header` parameters (e.g. `anthropic-version`) are auto-added as editable, pre-filled header rows
- **Streaming (SSE) responses** — a `text/event-stream` response is parsed automatically: the reconstructed message text is shown above the raw event frames (both Anthropic and OpenAI delta shapes are supported)
- **Response schema validation** — the response body is checked against the spec's response schema (resolving `$ref`s in both `#/definitions/` and `#/components/schemas/`)
- **Exploratory testing** — click ▶ on a row to run a case; the tool pre-fills auth, shows PASS/FAIL after the response, and lets you save the result back to the case
- **Generated cases** — a successful (or pasted) JSON response is analysed to derive data-driven assertions (observed fields, types, collection sizes); these are **folded into the matching case as extra test scripts** (e.g. a 200 body's field/shape checks land on the happy-path GET case), so they run and export inside that case rather than as separate rows
- **Result tracking** — filter by Untested / Pass / Fail; results persist per endpoint in `localStorage` and are included in the JSON export
- **Three export formats** — JSON, a Postman Collection v2.1 (with `pm.test` scripts), and a Karate `.feature` file
- **Configurable defaults** — auth tokens, default headers, and the response-time threshold live in `data/config.json`
- **CORS handling** — the Base URL is editable and a one-click local dev-server proxy (`/proxy?url=`) prefix is provided

## How it works

1. **Select a Swagger** — loads the spec from `swaggers/`
2. **Select a Tag / Group** — filters endpoints to that resource group
3. **Select an Endpoint** — auto-generates test cases from `data/templates.json`
4. **Filter** by Category, Tag, Status Code, Result, or free-text; **sort** by clicking the ID / Method / Endpoint / Category / Tag / Expected Status headers
5. **Expand a row** — click it (Swagger-UI style) to see metadata and the exact test scripts that case will run / export
6. **Try It** — switch tabs to configure and send requests; click ▶ on a row to run a specific case
7. **Export** — JSON, Postman, or Karate

## Project structure

```
API Testing/
├── index.html                          # Entry point — Test Cases + Try It tabs
├── package.json                        # npm dev dependencies (Vite, ESLint, Vitest)
├── vite.config.js                      # Vite dev server — proxies /proxy & /save to Python server
├── eslint.config.js                    # ESLint flat config (targets scripts/)
├── css/                                # Styles, split by area, linked in cascade order from index.html
│   ├── base.css                        #   reset + body + header
│   ├── toolbar.css                     #   toolbar, tab switcher, filter bar, export buttons
│   ├── table.css                       #   summary cards, table, badges, expandable detail row
│   ├── tryit.css                       #   Try It request panes (endpoint, params, auth, headers, body, send)
│   └── response.css                    #   response + schema-validation panes
├── scripts/
│   ├── app.js                          # Orchestrator: cascade, filter, sort, render, results store, export wiring
│   ├── specs-store.js                  # Per-swagger specs file: scaffold, effective resolvers, save
│   ├── core/
│   │   ├── swagger-loader.js           #   Fetch manifest + specs; extract tags & endpoints (Swagger 2 + OpenAPI 3)
│   │   ├── template-matcher.js         #   Profile an endpoint, match templates, derive stable TC ids
│   │   ├── config-loader.js            #   Load data/config.json merged over built-in defaults
│   │   ├── case-order.js               #   CATEGORY_ORDER + categoryRank + compareTestCases (single source)
│   │   ├── case-expander.js            #   Expand the TPL-NEG-009 405 case into one per disallowed method
│   │   └── status-utils.js             #   statusClass + is2xx / is4xx range checks (shared)
│   ├── tryit/
│   │   ├── request-ui.js               #   Try It tab UI — base URL, params, auth, headers, body, send, sticky session
│   │   ├── request-core.js             #   DOM-free URL / header / body construction
│   │   ├── schema-validator.js         #   AJV response-schema validation + example builders
│   │   └── sse-parser.js               #   DOM-free text/event-stream parser (reconstructs streamed chat text)
│   ├── exporters/
│   │   ├── body-builder.js             #   Shared layer that builds valid / negative request bodies for exporters
│   │   ├── postman-collection-builder.js  # Postman v2.1 export + pm.test scripts
│   │   ├── karate-feature-builder.js   #   Karate .feature export
│   │   └── export-shared.js            #   De-duped body selection, assertion model, key parsing, filename slug
│   ├── generate/
│   │   ├── response-test-generator.js  #   Exploratory: derive cases from a live / pasted response body
│   │   └── case-folder.js              #   Fold generated assertions into the matching template case
│   ├── state/
│   │   └── results-store.js            #   localStorage load/persist + endpointKey
│   ├── ui/
│   │   ├── dom.js                      #   id helpers + esc() (single source)
│   │   ├── tabs.js                     #   activateTab / bindTabs
│   │   ├── filter-sort.js              #   pure filterAndSort(cases, filters, sort) → rows
│   │   └── table-render.js             #   renderTable / renderTcDetail / renderSummary / toggleDetail
│   └── vendor/                         # Pre-bundled AJV + SwaggerParser
├── tools/                              # Local Karate runner — setup-karate.ps1 / run-karate.ps1 (JRE + jar downloaded here, git-ignored)
├── tests/                              # Vitest unit tests (npm test) for the pure-logic modules
├── data/
│   ├── templates.json                  # General-purpose test case template library
│   └── config.json                     # Auth tokens, default headers, response-time threshold, path params
├── swaggers/
│   ├── index.json                      # Manifest — list of available specs
│   ├── testek.json                     # Testek Product Management API (Swagger 2.0)
│   ├── openapi3.json                   # Minimal OpenAPI 3 example
│   ├── openfigi.json                   # OpenFIGI API (OpenAPI 3, real-world)
│   └── feature-demo.json               # Anthropic API demo (multipart file upload + SSE stream chat)
├── output/                             # Generated per swagger (id from index.json)
│   └── {id}/
│       ├── specs.json                  # Swagger + endpoint specs + recorded baselines
│       ├── postman/postman-{method}-{slug}.json
│       └── karate/
│           ├── karate-{method}-{slug}.feature
│           └── karate-config.js        # shared base URL / credentials (written once, preserved on re-export)
└── README.md
```

> `swaggers/*`, `output/*`, `node_modules/`, and `TODO.md` are git-ignored — see `.gitignore`.

## Architecture & data flow

```
        core/swagger-loader ─┐
                             ▼
  user selections → core/template-matcher.profileEndpoint() → matchTemplates() → matched cases
                             │                                                        │
                             ▼                                                        ▼
                  tryit/request-ui (Try It)                            app.js → ui/ render / filter / sort
                             │  send → response                                       │
                             ▼                                                        ▼
              generate/response-test-generator                 exporters/body-builder ─┬─► exporters/postman-collection-builder
              (assertions folded via                                                   └─► exporters/karate-feature-builder
               generate/case-folder into the matching case)
```

Modules are grouped into folders by concern — `core/` (loaders, matcher, shared ordering/status helpers), `tryit/` (the Try It request UI + DOM-free core + schema validation), `exporters/` (the shared body-builder layer + Postman/Karate/JSON output), `generate/` (exploratory case derivation), `state/` (results store), and `ui/` (DOM helpers, tabs, table render, pure filter/sort). `app.js` and `specs-store.js` sit at the `scripts/` root.

- **`app.js`** is the single orchestrator. It owns the swagger → tag → endpoint cascade, the filter/sort state, the rendered table, and the per-endpoint results store (persisted in `localStorage` under `apitest.results.v1`).
- **`exporters/body-builder.js`** is a format-agnostic middle layer: it turns a test case + a schema-derived example into a `{ kind, data }` body descriptor (valid / empty / object / malformed). Both the Postman and Karate exporters consume the same descriptor, so negative-body behaviour stays consistent across formats.
- **`core/config-loader.js`** loads `data/config.json` once at startup and deep-merges it over built-in defaults; every other module reads it synchronously via `getConfig()`.
- **`core/case-order.js`** is the single source for the category ordering (`happy_path → positive → negative → auth → boundary → generated`) and `compareTestCases`.

## Template matching logic

When an endpoint is selected, `core/template-matcher.js` builds a profile from the swagger operation:

| Profile property | How it is derived |
|---|---|
| `method` | HTTP method (GET, POST, PUT, PATCH, DELETE) |
| `endpoint_type` | `list` (GET, no path params) · `detail` (GET, with path params) · `action` (all others) |
| `has_path_params` | Path contains `{param}` |
| `has_query_params` | Operation has an `in: query` parameter |
| `has_body` | Operation has an `in: body` parameter (Swagger 2) or a `requestBody` (OpenAPI 3) |
| `auth_required` | The operation **or the spec root** declares a non-empty `security` requirement. A `{}` entry (anonymous allowed) or an operation-level `security: []` (auth disabled) means **not** required. |
| `auth_type` | Name of the first security scheme (e.g. `OAuth2`, `ApiKeyAuth`, `cookieAuth`) |

Each template declares an `applies_to` rule. A template is matched only when **all** its conditions satisfy the endpoint profile.

Each matched case gets a **stable id** derived from its template id (`TPL-HP-003` → `TC-HP-003`). Because saved results are keyed by `endpointKey + TC id`, this id must not depend on filter/sort order — see the note in `core/template-matcher.js`.

## Template library (`data/templates.json`)

| ID | Category | Tag | Applies to |
|---|---|---|---|
| TPL-HP-001 | happy_path | valid | GET list — default params |
| TPL-HP-002 | happy_path | valid | GET detail — valid ID |
| TPL-HP-003 | happy_path | valid | POST — all required fields |
| TPL-HP-004 | happy_path | valid | PUT — replace existing resource |
| TPL-HP-005 | happy_path | valid | PATCH — partial update |
| TPL-HP-006 | happy_path | valid | DELETE — delete existing |
| TPL-POS-001 | positive | valid | GET list with query params — keyword filter |
| TPL-POS-002 | positive | valid | GET list with query params — explicit page & size |
| TPL-POS-003 | positive | valid | GET list with query params — sort ascending |
| TPL-POS-004 | positive | valid | GET list with query params — sort descending |
| TPL-POS-005 | positive | valid | POST with body — all optional fields |
| TPL-POS-006 | positive | valid | POST with body — required fields only |
| TPL-POS-007 | positive | valid | PUT/PATCH with body — single field update |
| TPL-POS-008 | positive | valid | PUT/PATCH with body — multiple field update |
| TPL-NEG-001 | negative | missing | POST/PUT/PATCH with body — missing required fields |
| TPL-NEG-002 | negative | invalid | POST/PUT/PATCH with body — invalid field types |
| TPL-NEG-003 | negative | invalid | POST/PUT/PATCH with body — out-of-range numbers |
| TPL-NEG-004 | negative | invalid | POST/PUT/PATCH with body — string exceeds max length |
| TPL-NEG-005 | negative | malformed | POST/PUT/PATCH — malformed JSON body |
| TPL-NEG-006 | negative | not_found | GET/PUT/PATCH/DELETE with path params — non-existent ID |
| TPL-NEG-007 | negative | invalid | GET/PUT/PATCH/DELETE with path params — invalid ID format |
| TPL-NEG-008 | negative | duplicate | POST — duplicate resource (409) |
| TPL-NEG-009 | negative | method_not_allowed | Any endpoint — disallowed HTTP method → 405 |
| TPL-AUTH-001 | auth | missing | All methods with auth — missing token → 401 |
| TPL-AUTH-002 | auth | invalid | All methods with auth — tampered token → 401 |
| TPL-AUTH-003 | auth | expired | All methods with auth — expired token → 401 |
| TPL-AUTH-004 | auth | invalid | All methods with auth — insufficient permissions → 403 |
| TPL-AUTH-005 | auth | invalid | GET/PUT/PATCH/DELETE with path params — access other user's resource → 403 |
| TPL-BND-001 | boundary | valid | GET list with query params — no-match search returns empty list |
| TPL-BND-002 | boundary | valid | GET list with query params — page beyond total |
| TPL-BND-003 | boundary | valid | GET list with query params — size covers all records |
| TPL-BND-004 | boundary | valid | POST/PUT/PATCH with body — string at max length |
| TPL-BND-005 | boundary | valid | POST/PUT/PATCH with body — number at minimum value |
| TPL-BND-006 | boundary | invalid | POST — extremely large payload |

For the matched **405** case (TPL-NEG-009), `app.js` expands it into one case per disallowed method — every standard HTTP method (POST/PUT/PATCH/DELETE/GET) not defined on that path — each with a method-suffixed id (e.g. `TC-NEG-009-POST`) so the exports send the right request. A GET-only path therefore yields four 405 cases (POST, PUT, PATCH, DELETE).

## Try It tab

The **Try It** tab sends real HTTP requests against the selected endpoint.

- **Base URL** — pre-filled from the spec (`schemes`/`host`/`basePath` for Swagger 2, `servers[].url` with `{variable}` defaults for OpenAPI 3); edit it to point to a local instance or a CORS proxy
- **Authentication** — choose Bearer Token, API Key (header or query), Cookie, or Basic Auth; the matching header (or query param) updates automatically. When the endpoint requires auth, the style is pre-selected from the spec's security scheme — an `apiKey`-in-header scheme fills its real header name (e.g. `x-api-key`) and sends the token raw (no `Bearer` prefix)
- **Headers** — default headers (Accept, Content-Type) are added automatically, and the operation's `in: header` parameters (e.g. `anthropic-version`, `anthropic-beta`) are pre-filled from their schema default/example as editable rows; add more with **+ Add** (later rows override earlier ones)
- **Request Body** — pre-filled with an example generated from the request schema
- **Send Request** — fires a `fetch()` and shows status, response headers, formatted body, and a **Schema** tab with validation results. A `text/event-stream` (SSE) response is detected automatically: the reconstructed message text is shown above the raw frames, and schema validation / data-driven generation are skipped (a stream carries no JSON body)

### CORS

Browser `fetch()` is subject to CORS. If the API server doesn't send CORS headers, the request is blocked. Options:

1. Change the Base URL to a local instance of the API (e.g. `http://localhost:8080`)
2. Click **🔗 Proxy** to prefix the Base URL with the local dev-server proxy (`/proxy?url=`). The server forwards the request server-side, so CORS never applies. Because browsers won't let `fetch()` set a `Cookie` header, the Try It tab sends it as `X-Proxy-Cookie` and the proxy renames it back to `Cookie` before forwarding. The proxy also drops the browser's `Origin`/`Referer`, so APIs that reject direct browser calls (e.g. Anthropic, which otherwise demands `anthropic-dangerous-direct-browser-access`) accept the forwarded request. This requires serving the page with `devserver.py` (below).
3. Install a browser extension that disables CORS checks (dev use only)

If the live call is blocked, you can still paste a sample JSON response into **Generate Test Cases** to derive generated cases offline.

## Exploratory testing

Click **▶** on any test case row to run it in Try It:

- Auth settings are pre-configured from the case's auth category (missing / invalid / expired)
- After the request completes, a PASS/FAIL panel compares expected vs actual status
- Click **Save Result** to persist it; the row updates with a ✅ Pass or ❌ Fail badge
- Use the **Result** filter to view only untested, passing, or failing cases
- Results survive navigation and page refresh (`localStorage`) and are included in the JSON export

## Exports

| Button | Output | Notes |
|---|---|---|
| **Export JSON** | `output/{id}/api-{method}-{endpoint}-testcases.json` | All cases (with saved results), ordered by category. Saved next to `specs.json`. |
| **Export Postman** | `output/{id}/postman/postman-{method}-{endpoint}.json` | Postman Collection v2.1, folders per category, every request carries `pm.test` scripts (status, response-time, body/shape assertions). Valid body fields become collection variables. |
| **Export Karate** | `output/{id}/karate/karate-{method}-{endpoint}.feature` | One Karate `Feature` with a `Background` (url, tokens, path params, valid body) and a `@category`-tagged `Scenario` per case, including status, `responseTime`, and `match` assertions. |

All three exports are **written to disk under `output/{id}/`** (the `id` from `swaggers/index.json`) via
the dev-server `POST /save` endpoint, and the Postman/Karate exports draw their base URL, auth tokens,
headers, request body, and path-param defaults from the [per-swagger specs file](#per-swagger-specs-file).
If the page isn't being served by `devserver.py` (so `/save` is unavailable), each export falls back to a
normal browser download.

All three reuse the same category ordering (`happy_path → positive → negative → auth → boundary → generated`) and the same body-builder layer, so the cases line up across formats. The Postman and Karate auth headers match the spec's security scheme — a Bearer `Authorization`, a raw apiKey header (e.g. `x-api-key`, no `Bearer` prefix), or a `Cookie` — and both include the operation's `in: header` parameters (e.g. `anthropic-version`) on every request, so the exported artifacts are runnable as-is. The Karate export also writes a shared **`karate-config.js`** (base URL + credentials) beside the feature files on the first export; it is preserved on re-export so hand-edited values survive.

You can execute a Postman export end-to-end with [newman](https://github.com/postmanlabs/newman) (a dev dependency):

```cmd
npm run newman -- output/{id}/postman/postman-{method}-{endpoint}.json
```

To execute a Karate `.feature`, install the project-local runner once — a portable Temurin 21 JRE + the Karate standalone jar, downloaded under `tools/` (git-ignored) — then run a feature:

```cmd
npm run karate:setup                                                  :: one-time, idempotent
npm run karate -- output/{id}/karate/karate-{method}-{endpoint}.feature
```

The runner points `karate.config.dir` at the feature's folder so the sibling `karate-config.js` is picked up, and writes an HTML report under that folder's `target/`.

Note that the bundled template library is general-purpose: against a specific real API some cases will report mismatches (e.g. a `POST` template expects `201` while the API returns `200`, or a streaming `text/event-stream` body isn't valid JSON for body-shape assertions). Tune `expected_status` in the spec / templates for the API under test.

## Per-swagger specs file

Each swagger gets an editable specs document at `output/{id}/specs.json` that is the **single source of
truth** for that API's test configuration and recorded baselines. It is scaffolded from the spec +
`data/config.json` the first time you select the swagger, and read back to drive both the Try It
defaults and the Postman/Karate exports. A value present in the file **overrides** the derived one
(effective value = `specs ?? config ?? spec`).

```jsonc
{
  "swaggerId": "testek", "title": "…", "file": "testek.json",
  "generatedAt": "…", "updatedAt": "…",

  "swagger": {                                   // ── Swagger specs ──
    "baseUrl": "https://api.example.com/v1",
    "auth": { "type": "OAuth2", "kind": "oauth2", "name": null, "in": "header",  // scheme name + kind (apiKey/http/oauth2) + apiKey header name + where the credential goes
              "token": "", "expiredToken": "", "invalidTokenValue": "invalid_token_tampered_xyz" },
    "headers": { "accept": "application/json", "contentType": "application/json" }
  },

  "endpoints": {                                 // keyed by "METHOD /path"
    "POST /products": {                          // ── Endpoint specs ──
      "method": "POST", "path": "/products", "summary": "…", "authRequired": true,
      "pathParams": {},
      "requestBody": { /* example from the request schema; used as the valid body in exports */ },
      "responses": { "200": { /* example from the 200 schema */ }, "error": { /* first 4xx schema */ } },
      "baseline": {                              // ── recorded snapshot (BaselineEntry) ──
        "status": 200, "responseTime": 123, "body": { /* actual response */ }, "recordedAt": "…"
      }
    }
  }
}
```

- **Save Specs** (toolbar) folds the auth **token** and the **request body** currently entered in the
  Try It tab into the model, then writes it to `output/{id}/specs.json`. The token is swagger-level (one
  per API); the request body is per-endpoint (the one for the selected endpoint). Auth-test presets
  (missing / invalid / expired) and non-JSON bodies are skipped so they can't clobber the real values.
  Nothing is captured or written until you click Save Specs.
- **Save as baseline** (Try It response panel) records the most recent live response — status,
  response time, body, timestamp — as that endpoint's `baseline`, for later regression comparison, and
  writes the specs file.
- Edit `specs.json` by hand (e.g. set a real `baseUrl` / `token` / `requestBody` / path-param value) and
  reload — the Try It tab and the next export pick up your edits.

Writing requires the dev server (it exposes `POST /save?path=output/…`, which only ever writes inside
`output/`). Without it, Save Specs is a no-op and exports fall back to a browser download.

## Adding a new Swagger

1. Drop the `.json` spec (Swagger 2.0 or OpenAPI 3.x) into `swaggers/`
2. Add an entry to `swaggers/index.json`:

```json
{ "id": "my-api", "file": "my-api.json", "title": "My API" }
```

The viewer picks it up immediately — no other changes needed.

## Adding or editing templates

Edit `data/templates.json`. Each template follows this schema:

```json
{
  "id": "TPL-XXX-000",
  "category": "happy_path | positive | negative | auth | boundary",
  "tag": "valid | invalid | missing | expired | not_found | malformed | duplicate | method_not_allowed",
  "applies_to": {
    "methods": ["GET", "POST", "PUT", "PATCH", "DELETE"],
    "auth_required": true,
    "endpoint_type": "list | detail",
    "has_path_params": true,
    "has_query_params": true,
    "has_body": true
  },
  "auth_status": "valid | missing | invalid | expired",
  "purpose": "What this test case verifies",
  "expected_status": 200,
  "notes": "Optional hints for the tester"
}
```

All `applies_to` properties except `methods` are optional — omit them to match unconditionally.

### Multiple expected statuses

`expected_status` may be a single number **or an array** of numbers when a case can legitimately pass with any of several codes:

```json
{ "id": "TPL-HP-006", "expected_status": [200, 204], "...": "DELETE — 200 with body or 204 no-content" }
{ "id": "TPL-NEG-001", "expected_status": [400, 422], "...": "validation error — 400 or 422" }
```

This flows through the whole tool consistently:

- **Run / Save Result** — a run passes if the actual status matches **any** listed code
- **Status Code filter** — a `[400, 422]` case shows under the `4xx` filter
- **Export Postman** — `pm.expect(pm.response.code).to.be.oneOf([400, 422])` (a single value still uses `pm.response.to.have.status(400)`)
- **Export Karate** — `Then assert responseStatus == 400 || responseStatus == 422` (a single value still uses `Then status 400`)

The **first** code in the array is the "primary" status, used to decide success-vs-negative request bodies and 2xx/4xx-shaped body assertions.

## Configuration (`data/config.json`)

Optional. Any key omitted falls back to the built-in default in `core/config-loader.js`.

```json
{
  "responseTimeThresholdMs": 2000,
  "headers": { "accept": "application/json", "contentType": "application/json" },
  "auth": {
    "token": "",
    "expiredToken": "",
    "invalidTokenValue": "invalid_token_tampered_xyz"
  },
  "pathParams": {}
}
```

These values seed the Try It defaults and the Postman/Karate exports (e.g. the `{{token}}` collection variable, the `responseTime <` assertion threshold).

## Testing & linting

The pure-logic modules are plain ES modules with no DOM, so they unit-test cleanly in Node. Tests live in `tests/` and run with [Vitest](https://vitest.dev/):

```cmd
npm test        # run the unit suite once (vitest run)
npm run lint    # ESLint over scripts/
```

The suite characterizes the behaviour that must stay stable across refactors: template matching + stable TC ids, the body-builder `{ kind, data }` descriptors, the pure `filterAndSort`, status classification, the 405 case expander, the generated-case folder, request-core URL/header/body construction, schema validation, the SSE stream parser, and the de-duped exporter helpers.

## Running the viewer

Two servers must run in parallel — Vite serves static files and the Python server handles CORS proxying and file saves.

**Terminal 1 — Vite dev server (port 5500):**
```cmd
npm run dev
```

**Terminal 2 — Python save/proxy server (port 5501):**
```cmd
npm run save-server
```

Open **http://localhost:5500/index.html**. Vite proxies `/proxy` and `/save` requests to the Python server automatically.

Without the Python server, the **🔗 Proxy** button and all disk saves (`specs.json`, Postman, Karate exports) silently fall back to browser downloads.

### Install dev dependencies (first time only)

```cmd
npm install
```
