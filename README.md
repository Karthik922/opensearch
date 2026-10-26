# NestJS + OpenSearch API

A REST API built with **NestJS 11** that stores **products** in **OpenSearch 2.19**.
It can **create**, **read**, **search** (full-text, typo-tolerant, filters, sorting, paging, facets), **edit** (PATCH), **replace** (PUT) and **delete** records.

```
┌────────────┐   HTTP/JSON   ┌──────────────────┐   REST :9200   ┌──────────────┐
│  Client    │ ────────────▶ │  NestJS API :3000│ ─────────────▶ │  OpenSearch  │
│ curl/Postman│ ◀──────────── │  (this project)  │ ◀───────────── │  index:      │
└────────────┘               └──────────────────┘                │  "products"  │
                                                                 └──────────────┘
                              OpenSearch Dashboards :5601 (web UI to browse data)
```

## 📘 Learning guide

| Document | What it is |
|---|---|
| **[docs/OpenSearch-Complete-Guide.docx](docs/OpenSearch-Complete-Guide.docx)** | The complete Word guide (22 chapters, about 130 pages): Dev Tools, mappings, analysis, CRUD, every query type, filtering and facets, pagination, sorting, autocomplete, aggregations, relationships, SQL, NestJS API walkthrough, troubleshooting, cheat sheet |
| [docs/handbook/](docs/handbook/) | The same guide as Markdown chapters (the source of the Word file) |
| [docs/POSTGRES-TO-OPENSEARCH.md](docs/POSTGRES-TO-OPENSEARCH.md) | Storing relational PostgreSQL data in OpenSearch, with a runnable lab |
| [docs/OPENSEARCH-GUIDE.md](docs/OPENSEARCH-GUIDE.md) | A short quick-reference version |

All 283 Dev Tools examples in the guide were run against OpenSearch 2.19.1. They use a practice index, `learn_products`, which chapter 2 creates.

---

## 1. Contents

1. [Project structure](#2-project-structure)
2. [Run everything with Docker Compose](#3-run-everything-with-docker-compose-recommended)
3. [Run the API locally (OpenSearch in Docker)](#4-run-the-api-locally-opensearch-in-docker)
4. [Configuration](#5-configuration)
5. [Data model and index mapping](#6-data-model-and-index-mapping)
6. [API reference](#7-api-reference)
   - [How to create a record](#71-create-a-record)
   - [How to create many records (bulk)](#72-create-many-records-bulk)
   - [How to get a record](#73-get-a-record-by-id)
   - [How to search](#74-search)
   - [How to edit (partial update)](#75-edit-a-record-partial-update--patch)
   - [How to update (full replace)](#76-update-a-record-full-replace--put)
   - [How to delete](#77-delete-a-record)
   - [Health check](#78-health-check)
7. [Errors](#8-errors)
8. [Talking to OpenSearch directly](#9-talking-to-opensearch-directly-without-the-api)
9. [Enabling OpenSearch security (production)](#10-enabling-opensearch-security-production)
10. [Troubleshooting](#11-troubleshooting)

---

## 2. Project structure

```
opensearch/
├── docker-compose.yml          # OpenSearch + Dashboards + API
├── Dockerfile                  # Multi-stage build for the API
├── .env / .env.example         # Local config
├── requests.http               # Ready-to-run requests (VS Code REST Client / JetBrains)
└── src/
    ├── main.ts                 # Bootstrap, validation pipe, Swagger at /docs
    ├── app.module.ts
    ├── health/health.controller.ts
    ├── opensearch/
    │   ├── opensearch.module.ts     # Global module that provides the OpenSearch Client
    │   └── opensearch.constants.ts  # Injection token
    └── products/
        ├── products.controller.ts   # HTTP routes
        ├── products.service.ts      # All OpenSearch queries live here
        ├── products.mapping.ts      # Index settings + field mapping
        ├── product.interface.ts
        └── dto/
            ├── create-product.dto.ts
            ├── update-product.dto.ts   # ReplaceProductDto (PUT) + UpdateProductDto (PATCH)
            └── search-product.dto.ts   # Query-string params for /search
```

On startup, `ProductsService` waits for OpenSearch (retries for up to ~60 s) and **creates the `products` index with its mapping** if it does not exist.

---

## 3. Run everything with Docker Compose (recommended)

Requirements: Docker Desktop (give it at least 4 GB RAM).

```bash
# 1. Pull the OpenSearch images (only needed once)
docker pull opensearchproject/opensearch:2.19.1
docker pull opensearchproject/opensearch-dashboards:2.19.1

# 2. Build the API image and start all three containers
docker compose up -d --build

# 3. Watch the logs until you see "API running on http://localhost:3000"
docker compose logs -f api
```

| Service                | URL                              |
|------------------------|----------------------------------|
| NestJS API             | http://localhost:3000            |
| Swagger UI (try it)    | http://localhost:3000/docs       |
| OpenSearch REST        | http://localhost:9200            |
| OpenSearch Dashboards  | http://localhost:5601            |

Useful commands:

```bash
docker compose ps                 # status
docker compose logs -f opensearch # OpenSearch logs
docker compose restart api        # restart only the API
docker compose down               # stop (data is kept in the opensearch-data volume)
docker compose down -v            # stop AND delete all OpenSearch data
```

> **Port 3000 already in use?** Pick another host port with `API_PORT`: in bash, `API_PORT=3001 docker compose up -d --build`; in PowerShell, `$env:API_PORT=3001; docker compose up -d --build`. You can also put `API_PORT=3001` in `.env`.

> **Linux hosts only:** OpenSearch needs `sudo sysctl -w vm.max_map_count=262144`. Docker Desktop on Windows/macOS already handles this.

---

## 4. Run the API locally (OpenSearch in Docker)

Handy while developing (hot reload):

```bash
docker compose up -d opensearch opensearch-dashboards   # only the database + UI
npm install
npm run start:dev                                       # http://localhost:3000
```

Scripts: `npm run build`, `npm run start`, `npm run start:dev` (watch), `npm run start:prod` (runs `dist/main`).

---

## 5. Configuration

Environment variables (from `.env` locally, or `environment:` in `docker-compose.yml`):

| Variable              | Default                  | Description                                   |
|-----------------------|--------------------------|-----------------------------------------------|
| `PORT`                | `3000`                   | API port                                      |
| `OPENSEARCH_NODE`     | `http://localhost:9200`  | OpenSearch URL (`http://opensearch:9200` in Compose) |
| `OPENSEARCH_USERNAME` | *(empty)*                | Only when the security plugin is enabled      |
| `OPENSEARCH_PASSWORD` | *(empty)*                | Only when the security plugin is enabled      |
| `OPENSEARCH_INDEX`    | `products`               | Index name                                    |

---

## 6. Data model and index mapping

A product document:

| Field         | Type (OpenSearch)            | Required on create | Notes |
|---------------|------------------------------|--------------------|-------|
| `id`          | document `_id`               | no                 | Your own id, or a UUID is generated |
| `name`        | `text` + `name.keyword`      | yes                | Full-text searchable; `.keyword` used for sorting |
| `description` | `text`                       | no                 | Full-text searchable |
| `category`    | `keyword`                    | yes                | Exact-match filter + facet |
| `tags`        | `keyword` (array)            | no                 | Exact-match filter |
| `price`       | `float`                      | yes                | ≥ 0, range filter, sortable |
| `stock`       | `integer`                    | yes                | ≥ 0 |
| `inStock`     | `boolean`                    | — (computed)       | `stock > 0`, set by the API |
| `createdAt`   | `date`                       | — (computed)       | Set on create, kept on PUT |
| `updatedAt`   | `date`                       | — (computed)       | Set on every write |

**`text` vs `keyword`:** `text` fields are analysed (split into words, lower-cased), so you can run full-text search on them. `keyword` fields are stored exactly as given, so they work for exact filters, sorting and aggregations.

To change the mapping, edit `src/products/products.mapping.ts`. You can't change the type of an existing field, so delete the index and restart the API (`curl -X DELETE localhost:9200/products`) or reindex.

---

## 7. API reference

Base URL: `http://localhost:3000`. Every request and response body is JSON. The examples below use `curl` (bash). On **Windows PowerShell**, use `curl.exe` and put the JSON in a file (`-d "@body.json"`), or use the PowerShell examples in [7.1](#71-create-a-record).

Writes use `refresh=wait_for`, so a record shows up in search **as soon as the write request returns**.

### 7.1 Create a record

`POST /products`

```bash
curl -X POST http://localhost:3000/products \
  -H "Content-Type: application/json" \
  -d '{
    "id": "p-1001",
    "name": "Wireless Mouse",
    "description": "Ergonomic 2.4GHz wireless mouse with silent clicks",
    "category": "electronics",
    "tags": ["computer", "accessories"],
    "price": 19.99,
    "stock": 150
  }'
```

Response `201 Created`:

```json
{
  "id": "p-1001",
  "name": "Wireless Mouse",
  "description": "Ergonomic 2.4GHz wireless mouse with silent clicks",
  "category": "electronics",
  "tags": ["computer", "accessories"],
  "price": 19.99,
  "stock": 150,
  "inStock": true,
  "createdAt": "2026-10-22T15:09:14.127Z",
  "updatedAt": "2026-10-22T15:09:14.127Z"
}
```

- Leave out `"id"` and a UUID is generated for you.
- Creating an `id` that already exists returns **409 Conflict**. It never silently overwrites.
- Unknown fields or invalid values return **400** with a list of messages.

PowerShell version:

```powershell
$body = @{
  name = "Wireless Mouse"; category = "electronics"; price = 19.99; stock = 150
  tags = @("computer","accessories")
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://localhost:3000/products -ContentType "application/json" -Body $body
```

### 7.2 Create many records (bulk)

`POST /products/bulk` takes an array of the same objects. It uses the OpenSearch `_bulk` API, so it **creates new records or overwrites existing ones**.

```bash
curl -X POST http://localhost:3000/products/bulk \
  -H "Content-Type: application/json" \
  -d '[
    {"id":"p-1002","name":"Mechanical Keyboard","description":"RGB backlit mechanical keyboard, blue switches","category":"electronics","tags":["computer","gaming"],"price":79.5,"stock":40},
    {"id":"p-1003","name":"Gaming Headset","description":"Surround sound headset with noise cancelling mic","category":"electronics","tags":["gaming","audio"],"price":59,"stock":0},
    {"id":"p-2001","name":"Coffee Mug","description":"Ceramic mug, 350ml","category":"kitchen","tags":["home"],"price":8.99,"stock":300}
  ]'
```

```json
{
  "errors": false,
  "items": [
    { "id": "p-1002", "result": "created" },
    { "id": "p-1003", "result": "created" },
    { "id": "p-2001", "result": "created" }
  ]
}
```

### 7.3 Get a record by id

`GET /products/:id`

```bash
curl http://localhost:3000/products/p-1001
```

Returns the product, or **404** if it does not exist.

### 7.4 Search

`GET /products/search` takes query-string parameters. Every parameter is optional and they can be combined; all filters must match (AND).

| Param      | Example              | What it does |
|------------|----------------------|--------------|
| `q`        | `wireless mouse`     | Full-text search across `name` (weight ×3), `tags` (×2) and `description`. **Typo tolerant** (`fuzziness: AUTO`), so `wirless mous` still finds "Wireless Mouse". |
| `category` | `electronics`        | Exact category |
| `tags`     | `gaming,audio`       | Has **any** of the given tags |
| `minPrice` | `10`                 | `price >= minPrice` |
| `maxPrice` | `100`                | `price <= maxPrice` |
| `inStock`  | `true` / `false`     | Only products with or without stock |
| `sortBy`   | `relevance` (default), `price`, `createdAt`, `name` | Sort field |
| `order`    | `desc` (default), `asc` | Sort direction (ignored for `relevance`) |
| `page`     | `1` (default)        | Page number, starting at 1 |
| `size`     | `10` (default, max 100) | Results per page |
| `cursor`   | `nextCursor` from the previous response | Cursor pagination (`search_after`) for infinite scroll or deep pages; `page` is ignored |

With no parameters, it lists every product.

**Examples**

```bash
# Full-text (with a typo)
curl "http://localhost:3000/products/search?q=wirless%20mous"

# Electronics in stock between 10 and 100, cheapest first
curl "http://localhost:3000/products/search?category=electronics&inStock=true&minPrice=10&maxPrice=100&sortBy=price&order=asc"

# Anything tagged gaming, 5 per page, page 2
curl "http://localhost:3000/products/search?tags=gaming&size=5&page=2"

# Newest first
curl "http://localhost:3000/products/search?sortBy=createdAt&order=desc"

# List everything
curl "http://localhost:3000/products/search"

# Cursor paging: pass nextCursor back with the same sort parameters
curl "http://localhost:3000/products/search?sortBy=price&order=asc&size=5&cursor=WzE4LCJwLTIwMDEiXQ"
```

**Response**

```json
{
  "total": 2,
  "page": 1,
  "size": 10,
  "totalPages": 1,
  "nextCursor": null,
  "items": [
    {
      "id": "p-1001",
      "score": 4.96,
      "name": "Wireless Mouse",
      "description": "Ergonomic 2.4GHz wireless mouse with silent clicks",
      "category": "electronics",
      "tags": ["computer", "accessories"],
      "price": 19.99,
      "stock": 150,
      "inStock": true,
      "createdAt": "2026-10-22T15:09:14.127Z",
      "updatedAt": "2026-10-22T15:09:14.127Z",
      "highlight": {
        "name": ["<em>Wireless</em> <em>Mouse</em>"],
        "description": ["Ergonomic 2.4GHz <em>wireless</em> <em>mouse</em> with silent clicks"]
      }
    }
  ],
  "facets": {
    "categories": [{ "category": "electronics", "count": 2 }],
    "tags": [{ "tag": "computer", "count": 2 }, { "tag": "accessories", "count": 1 }],
    "price": { "count": 2, "min": 19.99, "max": 25.99, "avg": 22.99, "sum": 45.98 }
  }
}
```

- `score` is the relevance score. It is `null` when you sort by something other than relevance.
- `highlight` shows the matched words wrapped in `<em>`. It is only included when `q` is used.
- `nextCursor` is set when there may be more results; send it back as `cursor` to get the next page. It is `null` on the last page.
- `facets` are counts across **all** matching records, not just the current page. You can use them for filter sidebars. Selecting a `category` or `tags` doesn't shrink its own facet, so the sidebar keeps showing the other options (multi-select facets via `post_filter`).

**The OpenSearch query this builds** (for `q=mouse&category=electronics&minPrice=10`, shortened):

```json
{
  "from": 0, "size": 10, "track_total_hits": true,
  "query": {
    "bool": {
      "must":   [{ "multi_match": { "query": "mouse", "fields": ["name^3","description","tags^2"], "fuzziness": "AUTO" } }],
      "filter": [{ "range": { "price": { "gte": 10 } } }]
    }
  },
  "post_filter": { "bool": { "filter": [{ "term": { "category": "electronics" } }] } },
  "sort": [{ "_score": { "order": "desc" } }, { "_id": { "order": "asc" } }],
  "highlight": { "fields": { "name": {}, "description": {} } },
  "aggs": {
    "categories": { "filter": { "match_all": {} }, "aggs": { "values": { "terms": { "field": "category", "size": 50 } } } },
    "tags":       { "filter": { "bool": { "filter": [{ "term": { "category": "electronics" } }] } }, "aggs": { "values": { "terms": { "field": "tags", "size": 50 } } } },
    "price":      { "filter": { "bool": { "filter": [{ "term": { "category": "electronics" } }] } }, "aggs": { "stats": { "stats": { "field": "price" } } } }
  }
}
```

`must` clauses affect the relevance score. `filter` clauses only include or exclude documents, and OpenSearch caches them, which makes them fast. The full explanation is in chapter 19 of the guide.

### 7.5 Edit a record (partial update) — PATCH

`PATCH /products/:id`: send **only the fields you want to change**. Everything else stays as it is.

```bash
curl -X PATCH http://localhost:3000/products/p-1001 \
  -H "Content-Type: application/json" \
  -d '{ "price": 17.49, "stock": 0 }'
```

```json
{
  "id": "p-1001",
  "name": "Wireless Mouse",
  "price": 17.49,
  "stock": 0,
  "inStock": false,
  "createdAt": "2026-10-22T15:09:14.127Z",
  "updatedAt": "2026-10-22T15:09:17.145Z",
  "...": "other fields unchanged"
}
```

`inStock` and `updatedAt` are recalculated for you. Returns **404** if the id does not exist.

### 7.6 Update a record (full replace) — PUT

`PUT /products/:id`: send the **whole** record (`name`, `category`, `price` and `stock` are required). Any optional field you leave out (`description`, `tags`) is **removed**. `createdAt` is kept.

```bash
curl -X PUT http://localhost:3000/products/p-2001 \
  -H "Content-Type: application/json" \
  -d '{ "name": "Travel Mug", "category": "kitchen", "price": 12.5, "stock": 80 }'
```

Returns the new record, or **404** if the id does not exist.

**PATCH or PUT?** Use **PATCH** for normal edits, such as changing the price or the stock. Use **PUT** when the client holds the complete record and wants it saved exactly as sent.

### 7.7 Delete a record

`DELETE /products/:id`

```bash
curl -X DELETE http://localhost:3000/products/p-2001
```

```json
{ "id": "p-2001", "deleted": true }
```

Returns **404** if the id does not exist.

### 7.8 Health check

```bash
curl http://localhost:3000/health
```

```json
{ "api": "ok", "opensearch": { "cluster": "opensearch-cluster", "status": "yellow" } }
```

`yellow` is normal for a single-node cluster: OpenSearch has nowhere to put replica shards.

---

### 7.8a Autocomplete

`GET /products/suggest?q=<what the user typed>&size=5` returns product names that match while the user is typing. It uses a `search_as_you_type` sub-field, `name.autocomplete`.

```bash
curl "http://localhost:3000/products/suggest?q=mech%20key&size=3"
```

```json
[
  { "id": "p-1002", "price": 79.5, "name": "Mechanical Keyboard", "category": "electronics" },
  { "id": "p-1010", "price": 79.5, "name": "Mechanical Keyboard K2", "category": "electronics" }
]
```

### 7.8b Catalog statistics

`GET /products/stats` returns dashboard numbers computed with aggregations: totals, out-of-stock count, inventory value, price stats, per-category stats, price ranges, products per month and top tags.

```bash
curl http://localhost:3000/products/stats
```

### 7.9 Postman collection and sample data

The `postman/` folder contains:

| File | What it is |
|------|------------|
| `nest-opensearch-api.postman_collection.json` | 38 requests covering every endpoint (including autocomplete, stats, facets and cursor paging), success and error cases, each with tests |
| `local.postman_environment.json` | Environment with `baseUrl` |
| `sample-products.json` | 15 sample products (electronics, kitchen, books, sports, fashion). Paste it into `POST /products/bulk` |

1. In Postman, click **Import** and drop in both `.json` files from `postman/`.
2. Select the **NestJS OpenSearch - Local** environment. Set `baseUrl` to `http://localhost:3000`, or to whatever port the API runs on.
3. Run **0. Setup → Seed sample data (bulk)** first. After that, run requests one by one, or click **Run collection** to run them all.

To run it from the command line:

```bash
npx newman run postman/nest-opensearch-api.postman_collection.json --env-var baseUrl=http://localhost:3000
```

---

## 8. Errors

Every error uses the standard NestJS shape:

```json
{ "message": "Product \"p-9\" not found", "error": "Not Found", "statusCode": 404 }
```

| Status | When |
|--------|------|
| 400 | Invalid body or query (`message` is an array of reasons), or unknown fields were sent |
| 404 | No record with that id |
| 409 | `POST /products` with an id that already exists |
| 500 | OpenSearch is unreachable or rejected the request (see the API logs) |

---

## 9. Talking to OpenSearch directly (without the API)

> 📘 To learn OpenSearch itself (indices, mappings, Query DSL, aggregations, SQL, internals), read **[docs/OPENSEARCH-GUIDE.md](docs/OPENSEARCH-GUIDE.md)**.
>
> 🔗 To store **PostgreSQL tables with relationships** in OpenSearch (denormalize, `nested`, parent/child, keeping them in sync), read **[docs/POSTGRES-TO-OPENSEARCH.md](docs/POSTGRES-TO-OPENSEARCH.md)**. It comes with a runnable lab: the `postgres` service in Compose on port 5434, plus `npm run sync:pg`.

Useful for debugging:

```bash
curl localhost:9200                                    # cluster info
curl "localhost:9200/_cat/indices?v"                   # list indices
curl localhost:9200/products/_mapping?pretty           # field mapping
curl localhost:9200/products/_count                    # number of docs
curl "localhost:9200/products/_search?pretty&q=mouse"  # quick search
curl localhost:9200/products/_doc/p-1001?pretty        # one document
curl -X DELETE localhost:9200/products                 # delete the index (the API recreates it on restart)
```

Or open **OpenSearch Dashboards** at http://localhost:5601 → *Dev Tools*, and run:

```
GET products/_search
{
  "query": { "match": { "name": "mouse" } }
}
```

To browse documents, go to *Dashboards Management → Index patterns → Create* and enter `products`, then open *Discover*.

---

## 10. Enabling OpenSearch security (production)

The Compose file turns off the security plugin (plain HTTP, no login) to keep development simple. **Do not expose it like this in production.** To turn security on:

1. In `docker-compose.yml`, remove `DISABLE_SECURITY_PLUGIN` and `DISABLE_INSTALL_DEMO_CONFIG` from the `opensearch` service, and add
   `OPENSEARCH_INITIAL_ADMIN_PASSWORD=<StrongPassw0rd!>`. The password must be at least 8 characters and mix upper case, lower case, digits and symbols.
2. Change the healthcheck to `curl -sk -u admin:<password> https://localhost:9200/_cluster/health ...`.
3. In the `api` service, set:
   ```
   OPENSEARCH_NODE=https://opensearch:9200
   OPENSEARCH_USERNAME=admin
   OPENSEARCH_PASSWORD=<StrongPassw0rd!>
   ```
4. In `opensearch-dashboards`, remove `DISABLE_SECURITY_DASHBOARDS_PLUGIN` and set `OPENSEARCH_HOSTS=["https://opensearch:9200"]`.

The demo config uses self-signed certificates. The client is set to accept them (`rejectUnauthorized: false` in `opensearch.module.ts`). In real production, use proper certificates and turn that option back on.

---

## 11. Troubleshooting

| Problem | Fix |
|---------|-----|
| `docker pull` / build: `TLS handshake timeout` | Docker cannot reach Docker Hub. Restart Docker Desktop, check your VPN, proxy or DNS (*Settings → Resources → Network*), then try again. |
| OpenSearch container exits with code 137 | Not enough memory. Give Docker more RAM, or lower `-Xms/-Xmx` in `OPENSEARCH_JAVA_OPTS`. |
| `max virtual memory areas vm.max_map_count [65530] is too low` | Linux only: `sudo sysctl -w vm.max_map_count=262144` |
| API logs `OpenSearch not ready (attempt n/30)` | Normal while OpenSearch boots (about 20–40 s). It only gives up after about 60 s. |
| `EADDRINUSE :3000` | Another app is using port 3000. Set `PORT=3001` in `.env`, or change the Compose port mapping. |
| Search can't find a field you added | Add the field to `products.mapping.ts`, then delete and recreate the index (see §6). |
