# API Test Cases Viewer

An interactive tool that generates test cases for any REST API endpoint by matching a general template library against a selected Swagger spec.

## How it works

1. **Select a Swagger** — loads the API spec from `swaggers/`
2. **Select a Tag / Group** — filters endpoints to that resource group
3. **Select an Endpoint** — the tool inspects the operation and auto-generates applicable test cases from `data/templates.json`
4. **Filter** results by Auth Status, Category, Status Code, or free-text search
5. **Export JSON** — downloads `api-{method}-{endpoint}-testcases.json`

## Project structure

```
API Testing/
├── index.html               # Entry point
├── css/
│   └── styles.css           # All styles
├── scripts/
│   ├── app.js               # Main app logic (cascade, filter, render, export)
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

Each template in `data/templates.json` declares an `applies_to` rule. A template is matched only when **all** its conditions satisfy the endpoint profile.

## Template library (`data/templates.json`)

| ID | Category | Applies to |
|---|---|---|
| TPL-AUTH-001 | auth | All methods with auth — missing token |
| TPL-AUTH-002 | auth | All methods with auth — invalid token |
| TPL-AUTH-003 | auth | All methods with auth — expired token |
| TPL-GET-LIST-001 | happy_path | GET list — default params |
| TPL-GET-LIST-002 | happy_path | GET list with query params — keyword filter |
| TPL-GET-LIST-003 | happy_path | GET list with query params — empty result |
| TPL-GET-LIST-004 | boundary | GET list with query params — out-of-range pagination |
| TPL-GET-ID-001 | happy_path | GET detail — valid ID |
| TPL-GET-ID-002 | error_handling | GET detail — non-existent ID |
| TPL-GET-ID-003 | validation | GET detail — invalid ID format |
| TPL-POST-001 | happy_path | POST — valid body |
| TPL-POST-002 | validation | POST with body — missing required fields |
| TPL-POST-003 | validation | POST with body — invalid field types |
| TPL-PUT-001 | happy_path | PUT/PATCH — update existing |
| TPL-PUT-002 | error_handling | PUT/PATCH with path params — not found |
| TPL-PUT-003 | validation | PUT/PATCH with body — invalid fields |
| TPL-DELETE-001 | happy_path | DELETE — delete existing |
| TPL-DELETE-002 | error_handling | DELETE with path params — not found |
| TPL-DELETE-003 | error_handling | DELETE — verify resource gone after deletion |

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
  "category": "happy_path | auth | validation | error_handling | boundary",
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
