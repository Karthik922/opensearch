# Chapter 20 — Getting Data In, Testing and Deployment

## 20.1 Five ways to insert data

| Way | When | How |
|---|---|---|
| API, one by one | Normal application writes | `POST /products` → `client.create` |
| API, bulk | Imports from a file or an admin screen | `POST /products/bulk` → `client.bulk` |
| Dev Tools | Experiments, fixes, demos | `PUT index/_doc/id`, `POST _bulk` |
| Script from a database | Initial load or resync from PostgreSQL/MySQL | `npm run sync:pg` (below) |
| Pipeline tools | Continuous sync at scale | Logstash, OpenSearch Data Prepper, Debezium (CDC) |

### Import a JSON file through the API

The Postman folder contains `sample-products.json` (15 products). Load it with the bulk endpoint:

```bash
curl -X POST http://localhost:3000/products/bulk \
  -H "Content-Type: application/json" \
  --data-binary @postman/sample-products.json
```

PowerShell:

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3000/products/bulk `
  -ContentType "application/json" -InFile postman/sample-products.json
```

### Import an NDJSON file directly into OpenSearch

If the file is already in bulk format (action line + document line):

```bash
curl -X POST "http://localhost:9200/_bulk" \
  -H "Content-Type: application/x-ndjson" \
  --data-binary @products.ndjson
```

Use `--data-binary` (not `-d`): `-d` strips the newlines that NDJSON needs.

### Large imports from Node.js

The client has a bulk helper that splits a large stream into batches, retries on 429 and reports failures:

```ts
const result = await client.helpers.bulk({
  datasource: products,                         // an array, or an async iterator / stream
  onDocument: (doc) => ({ index: { _index: 'products', _id: doc.id } }),
  flushBytes: 5_000_000,                        // send a request every ~5 MB
  concurrency: 3,                               // parallel requests
  onDrop: (failed) => console.error('Failed', failed.document.id, failed.error),
});
console.log(result);                            // { total, successful, failed, time, ... }
```

## 20.2 From PostgreSQL to OpenSearch

The repository includes a PostgreSQL database with related tables (customers, orders, order items, products) and a sync script:

```bash
docker compose up -d postgres
npm run sync:pg
```

The script lets **PostgreSQL do the JOINs** and returns ready-made JSON documents with `json_build_object` and `json_agg`, then bulk-loads them into three indices that show different modelling techniques. Read `docs/POSTGRES-TO-OPENSEARCH.md` for:

- denormalizing tables into documents
- `nested` order items
- parent/child with the `join` field
- keeping OpenSearch in sync: dual writes, polling on `updated_at`, the outbox pattern, change data capture (Debezium)
- updating copied data with `_update_by_query`

## 20.3 Testing the API

### Swagger UI

Open `http://localhost:3000/docs`, choose an endpoint, click **Try it out**, fill in the parameters and click **Execute**. Swagger shows the request URL, the curl command and the response.

### Postman

`postman/nest-opensearch-api.postman_collection.json` contains 38 requests covering every endpoint, including error cases (400, 404, 409), facets and cursor paging. Every request has test scripts:

1. In Postman, click **Import** and drop in the collection and `postman/local.postman_environment.json`.
2. Select the environment and set `baseUrl` (for example `http://localhost:3000`).
3. Run **0. Setup → Seed sample data (bulk)** first, then any request, or run the whole collection with the Collection Runner.

An example of a Postman test script:

```js
pm.test("Status is 200", () => pm.response.to.have.status(200));
const b = pm.response.json();
pm.test("Has nextCursor", () => pm.expect(b.nextCursor).to.be.a("string"));
pm.collectionVariables.set("cursor", b.nextCursor);   // used by the next request
```

### Command line (CI)

```bash
npx newman run postman/nest-opensearch-api.postman_collection.json --env-var baseUrl=http://localhost:3000
```

Newman prints a summary table; the run for this guide passed **38 requests and 72 assertions**.

### Unit tests with a mocked client

Because the client is injected through a token, tests can replace it with a mock:

```ts
const client = { search: jest.fn().mockResolvedValue({ body: { hits: { total: { value: 0 }, hits: [] }, aggregations: { /* ... */ } } }) };

const moduleRef = await Test.createTestingModule({
  providers: [
    ProductsService,
    { provide: OPENSEARCH_CLIENT, useValue: client },
    { provide: ConfigService, useValue: { get: (_key: string, def: string) => def } },
  ],
}).compile();

const service = moduleRef.get(ProductsService);
await service.suggest('wire', 5);
expect(client.search.mock.calls[0][0].body.query.multi_match.type).toBe('bool_prefix');
```

For integration tests, run a real OpenSearch container (for example with Testcontainers or the `docker-compose.yml` service) and create a separate test index.

## 20.4 Running everything with Docker Compose

```bash
docker compose up -d --build
```

| Service | Container | Port |
|---|---|---|
| OpenSearch | `opensearch` | 9200 |
| OpenSearch Dashboards | `opensearch-dashboards` | 5601 |
| PostgreSQL (lab) | `shop-postgres` | 5434 |
| NestJS API | `nest-opensearch-api` | `${API_PORT:-3000}` |

If port 3000 is already in use: `API_PORT=3001 docker compose up -d --build` (PowerShell: `$env:API_PORT=3001; docker compose up -d --build`).

The API service waits for OpenSearch to be healthy before starting:

```yaml
api:
  build: .
  environment:
    - OPENSEARCH_NODE=http://opensearch:9200
  depends_on:
    opensearch:
      condition: service_healthy     # uses the opensearch healthcheck
```

The `Dockerfile` uses a two-stage build: the first stage installs all dependencies and compiles TypeScript, and the second contains only `dist/` and production dependencies, running as the non-root `node` user.

Useful commands:

```bash
docker compose ps                    # status
docker compose logs -f api           # API logs
docker compose restart api           # restart the API only
docker compose up -d --build api     # rebuild after code changes
docker compose down                  # stop (data is kept in volumes)
docker compose down -v               # stop and DELETE all data
```

## 20.5 Production checklist

| Area | Do |
|---|---|
| Security | Enable the security plugin (remove `DISABLE_SECURITY_PLUGIN`), use HTTPS, a strong `OPENSEARCH_INITIAL_ADMIN_PASSWORD`, a dedicated API user with only the permissions it needs |
| Network | Don't expose port 9200 or 5601 to the internet |
| Availability | At least 3 nodes, `number_of_replicas: 1` or more |
| Memory | Heap = 50% of RAM (max ~31 GB); leave the rest for the file-system cache |
| Backups | Configure snapshots (`_snapshot` API) to S3, Azure, GCS or a shared file system |
| Index design | Explicit mappings, aliases for every index the app uses, a reindex plan |
| Monitoring | Cluster health, heap, disk (keep below 75–80%), search latency, rejected requests |
| API | Rate-limit search endpoints, cap `size` and pagination depth, hide internal errors, log slow queries |
