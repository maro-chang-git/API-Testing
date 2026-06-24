# API Test Cases Viewer

An interactive, dependency-free browser tool that generates test cases for any REST API endpoint by matching a general-purpose template library against a selected Swagger / OpenAPI spec — then lets you run the cases directly in the browser and export them to **JSON**, **Postman**, or **Karate**.

No build step, no npm install — it's plain ES modules served as static files.

## Features

- **Auto-generated test cases** — select an endpoint and the tool matches applicable templates from `data/templates.json` (happy-path, positive, negative, auth, boundary)
- **Swagger 2.0 *and* OpenAPI 3.x** — tags, endpoints, request bodies, security, and response schemas are read from either spec version
- **Try It tab** — configure auth, headers, query/path params, and request body, then send real requests from the browser
- **Response schema validation** — the response body is checked against the spec's response schema (resolving `$ref`s in both `#/definitions/` and `#/components/schemas/`)
- **Exploratory testing** — click ▶ on a row to run a case; the tool pre-fills auth, shows PASS/FAIL after the response, and lets you save the result back to the case
- **Generated cases** — a successful (or pasted) JSON response is analysed to derive data-driven cases (observed fields, types, collection sizes)
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
├── css/
│   └── styles.css                      # All styles
├── scripts/
│   ├── app.js                          # Orchestrator: cascade, filter, sort, render, results store, export wiring
│   ├── swagger-loader.js               # Fetch manifest + specs; extract tags & endpoints (Swagger 2 + OpenAPI 3)
│   ├── template-matcher.js             # Profile an endpoint, match templates, derive stable TC ids
│   ├── request-builder.js              # Try It tab — base URL, params, auth, headers, body, send, schema validation
│   ├── config-loader.js                # Load data/config.json merged over built-in defaults
│   ├── body-builder.js                 # Shared layer that builds valid / negative request bodies for exporters
│   ├── postman-collection-builder.js   # Postman v2.1 export + pm.test scripts + category ordering
│   ├── karate-feature-builder.js       # Karate .feature export
│   └── response-test-generator.js      # Exploratory: derive cases from a live / pasted response body
├── data/
│   ├── templates.json                  # General-purpose test case template library
│   └── config.json                     # Auth tokens, default headers, response-time threshold, path params
├── swaggers/
│   ├── index.json                      # Manifest — list of available specs
│   ├── testek.json                     # Testek Product Management API (Swagger 2.0)
│   ├── openapi3.json                   # Minimal OpenAPI 3 example
│   └── openfigi.json                   # OpenFIGI API (OpenAPI 3, real-world)
└── README.md
```

> `swaggers/*` and `TODO.md` are git-ignored — see `.gitignore`.

## Architecture & data flow

```
        swagger-loader ─┐
                        ▼
  user selections → template-matcher.profileEndpoint() → matchTemplates() → matched cases
                        │                                                        │
                        ▼                                                        ▼
                  request-builder (Try It)                              app.js render / filter / sort
                        │  send → response                                       │
                        ▼                                                        ▼
              response-test-generator                          body-builder ──┬─► postman-collection-builder
              (generated cases)                                               └─► karate-feature-builder
```

- **`app.js`** is the single orchestrator. It owns the swagger → tag → endpoint cascade, the filter/sort state, the rendered table, and the per-endpoint results store (persisted in `localStorage` under `apitest.results.v1`).
- **`body-builder.js`** is a format-agnostic middle layer: it turns a test case + a schema-derived example into a `{ kind, data }` body descriptor (valid / empty / object / malformed). Both the Postman and Karate exporters consume the same descriptor, so negative-body behaviour stays consistent across formats.
- **`config-loader.js`** loads `data/config.json` once at startup and deep-merges it over built-in defaults; every other module reads it synchronously via `getConfig()`.

## Template matching logic

When an endpoint is selected, `template-matcher.js` builds a profile from the swagger operation:

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

Each matched case gets a **stable id** derived from its template id (`TPL-HP-003` → `TC-HP-003`). Because saved results are keyed by `endpointKey + TC id`, this id must not depend on filter/sort order — see the note in `template-matcher.js`.

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
- **Authentication** — choose Bearer Token, API Key (header or query), Cookie, or Basic Auth; the matching header (or query param) updates automatically
- **Headers** — default headers (Accept, Content-Type) are added automatically; add custom headers with **+ Add** (later rows override earlier ones)
- **Request Body** — pre-filled with an example generated from the request schema
- **Send Request** — fires a `fetch()` and shows status, response headers, formatted body, and a **Schema** tab with validation results

### CORS

Browser `fetch()` is subject to CORS. If the API server doesn't send CORS headers, the request is blocked. Options:

1. Change the Base URL to a local instance of the API (e.g. `http://localhost:8080`)
2. Click **🔗 Proxy** to prefix the Base URL with the local dev-server proxy (`/proxy?url=`). The server forwards the request server-side, so CORS never applies. Because browsers won't let `fetch()` set a `Cookie` header, the Try It tab sends it as `X-Proxy-Cookie` and the proxy renames it back to `Cookie` before forwarding. This requires serving the page with `devserver.py` (below).
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
| **Export JSON** | `api-{method}-{endpoint}-testcases.json` | All cases (with saved results), ordered by category |
| **Export Postman** | `postman-{method}-{endpoint}.json` | Postman Collection v2.1, folders per category, every request carries `pm.test` scripts (status, response-time, body/shape assertions). Valid body fields become collection variables. |
| **Export Karate** | `karate-{method}-{endpoint}.feature` | One Karate `Feature` with a `Background` (url, tokens, path params, valid body) and a `@category`-tagged `Scenario` per case, including status, `responseTime`, and `match` assertions. |

All three reuse the same category ordering (`happy_path → positive → negative → auth → boundary → generated`) and the same body-builder layer, so the cases line up across formats.

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

Optional. Any key omitted falls back to the built-in default in `config-loader.js`.

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

## Running the viewer

It's a static site — serve the folder over HTTP. Use `devserver.py`, which serves
the files **and** exposes the `/proxy?url=` CORS proxy used by the **🔗 Proxy** button:

```powershell
$env:PORT = 5500
& "C:\Program Files\Python314\python.exe" .claude\devserver.py
```

Open **http://localhost:5500/index.html** in your browser. Press `Ctrl+C` to stop.

> Plain `python -m http.server 5500` also serves the page, but the **🔗 Proxy**
> button won't work without `devserver.py` providing the `/proxy` endpoint.
