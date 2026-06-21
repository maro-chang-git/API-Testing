# API Test Cases — Testek Product Management

A structured test case reference for the [Testek Product Management REST API](https://testek.vn/lab/api/v0/prod-man/swagger-ui.html), with an interactive HTML viewer.

## Files

| File | Purpose |
|---|---|
| `testcases.json` | Source of truth — all test cases as structured data |
| `testcases.html` | Interactive viewer with filters and sorting |

## Test case structure

Each entry in `testcases.json` follows this schema:

```json
{
  "id": "TC-PRD-001",
  "group": "Product",
  "method": "POST",
  "endpoint": "/product",
  "summary": "Create a new product",
  "auth_type": "bearer_token",
  "auth_status": "valid",
  "category": "happy_path",
  "purpose": "Successfully create a product with all required fields",
  "expected_status": 201,
  "notes": ""
}
```

**`auth_status` values:** `valid` · `missing` · `invalid` · `expired`

**`category` values:** `happy_path` · `auth` · `validation` · `error_handling` · `boundary`

## Running the viewer

Requires Python 3. Run from the project folder:

```powershell
& "C:\Program Files\Python314\python.exe" -m http.server 5500
```

Then open **http://localhost:5500/testcases.html** in your browser.

Press `Ctrl+C` to stop the server.

## Extending to other API groups

Add new entries to the `testcases` array in `testcases.json`. The HTML viewer loads the file dynamically — no changes to the HTML needed.

Suggested groups to add next (from the Swagger spec):

- Category · Customer · Employee · Supplier · Order
- User · Group · Policy · Resource
- Auth (`/login-with-local`, `/refresh-token`, `/me/logout`)

## API reference

- **Base URL:** `https://testek.vn/lab/api/v0/prod-man`
- **Auth:** Bearer token via `Authorization: Bearer <token>` header
- **Response envelope:** `{ code, data, message }`
- **Swagger UI:** https://testek.vn/lab/api/v0/prod-man/swagger-ui.html
