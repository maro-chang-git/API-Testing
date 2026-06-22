# API Test Cases Viewer

An interactive tool that generates test cases for any REST API endpoint by matching a general template library against a selected Swagger spec, and lets you run them directly in the browser.

## Features

- **Auto-generated test cases** — select an endpoint and the tool matches applicable templates from `data/templates.json`
- **Try It tab** — configure auth, headers, request body, and send requests directly from the browser
- **Exploratory testing** — run a test case with one click; the tool pre-fills auth, then shows PASS/FAIL after the response and lets you save the result back to the TC
- **Result tracking** — filter test cases by Untested / Pass / Fail; results are included in the JSON export
- **CORS support** — the Base URL field is editable so you can point to a local instance or prefix a CORS proxy

## How it works

1. **Select a Swagger** — loads the API spec from `swaggers/`
2. **Select a Tag / Group** — filters endpoints to that resource group
3. **Select an Endpoint** — auto-generates test cases from `data/templates.json`
4. **Filter** by Category, Tag, Status Code, Result (pass/fail/untested), or free-text search
5. **Try It** — click the tab to configure and send requests; click ▶ on a row to run a specific test case
6. **Export JSON** — downloads all test cases (with results) as `api-{method}-{endpoint}-testcases.json`

## Project structure

```
API Testing/
├── index.html               # Entry point
├── css/
│   └── styles.css           # All styles
├── scripts/
│   ├── app.js               # Main app logic (cascade, filter, render, export)
│   ├── request-builder.js   # Try It tab — auth, headers, body, send, result comparison
│   ├── swagger-loader.js    # Fetches swagger files, extracts tags & endpoints
│   └── template-matcher.js  # Profiles an endpoint and matches templates
├── swaggers/
│   ├── index.json           # Manifest — list of available swagger files
│   └── testek.json          # Testek Product Management API spec
├── data/
│   └── templates.json       # General test case template library
└── README.md
```

## Template matching logic

When an endpoint is selected, `template-matcher.js` builds a profile from the swagger operation:

| Profile property | How it is derived |
|---|---|
| `method` | HTTP method (GET, POST, PUT, PATCH, DELETE) |
| `endpoint_type` | `list` (GET, no path params) · `detail` (GET, with path params) · `action` (all others) |
| `has_path_params` | Path contains `{param}` |
| `has_query_params` | Operation has `in: query` parameters |
| `has_body` | Operation has `in: body` parameter or `requestBody` |
| `auth_required` | Operation has a `security` definition |

Each template declares an `applies_to` rule. A template is matched only when **all** its conditions satisfy the endpoint profile.

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

## Try It tab

The **Try It** tab lets you send real HTTP requests against the selected endpoint.

- **Base URL** — pre-filled from the swagger spec; edit it to point to a local instance or a CORS proxy
- **Authentication** — choose Bearer Token, API Key, Cookie, or Basic Auth; the `Authorization` header updates automatically
- **Headers** — DEFAULT headers (Accept, Content-Type) are added automatically; add custom headers with **+ Add**
- **Request Body** — pre-filled with an example generated from the swagger schema
- **Send Request** — fires a `fetch()` and shows status, response headers, and formatted body

### CORS

Browser `fetch()` is subject to CORS restrictions. If the API server doesn't send CORS headers, the request is blocked. Options:

1. Change the Base URL to a local instance of the API (e.g. `http://localhost:8080`)
2. Prefix the Base URL with a CORS proxy (e.g. `https://corsproxy.io/?<original-url>`)
3. Install a browser extension that disables CORS checks (dev use only)

## Exploratory testing

Click **▶** on any test case row to run it in Try It:

- Auth settings are pre-configured based on the TC's auth category (missing / invalid / expired token)
- After the request completes, a PASS/FAIL comparison panel shows expected vs actual status
- Click **Save Result** to persist the result; the table row updates with a ✅ Pass or ❌ Fail badge
- Use the **Result** filter to view only untested, passing, or failing cases
- Results are included in the JSON export

## Adding a new Swagger

1. Drop the `.json` spec file into `swaggers/`
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
  "tag": "valid | invalid | missing | expired | not_found | malformed | duplicate",
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

## Running the viewer

Requires Python 3:

```powershell
& "C:\Program Files\Python314\python.exe" -m http.server 5500
```

Open **http://localhost:5500/index.html** in your browser. Press `Ctrl+C` to stop.
