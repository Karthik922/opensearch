# Chapter 18 — NestJS + OpenSearch: Project Setup

This chapter explains how the NestJS application in this repository connects to OpenSearch. Chapter 19 builds the API on top of it.

## 18.1 Architecture

```text
 Client (browser, mobile app, Postman)
    │  HTTP / JSON
    ▼
 ┌──────────────────────────── NestJS ──────────────────────────────┐
 │  ProductsController   routes, request validation (DTOs)          │
 │        │                                                          │
 │  ProductsService      builds OpenSearch requests, maps responses │
 │        │                                                          │
 │  OpenSearchModule     one shared OpenSearch Client (global)      │
 └────────┼──────────────────────────────────────────────────────────┘
          │  HTTP / JSON (REST)
          ▼
     OpenSearch :9200   index "products" (alias → products_v2)
```

| Layer | Responsibility | File |
|---|---|---|
| Controller | HTTP routes, parameters, status codes, Swagger docs | `src/products/products.controller.ts` |
| DTOs | Shape and validation of request bodies and query strings | `src/products/dto/*.ts` |
| Service | All OpenSearch logic: queries, mapping, error translation | `src/products/products.service.ts` |
| Mapping | The index schema | `src/products/products.mapping.ts` |
| OpenSearch module | Creates and shares the client | `src/opensearch/opensearch.module.ts` |
| Bootstrap | Validation pipe, Swagger, port | `src/main.ts` |

## 18.2 Create a project from scratch (for your own projects)

```bash
npm i -g @nestjs/cli
nest new my-search-api
cd my-search-api
npm install @opensearch-project/opensearch @nestjs/config class-validator class-transformer @nestjs/swagger
```

| Package | Purpose |
|---|---|
| `@opensearch-project/opensearch` | The official OpenSearch client for Node.js |
| `@nestjs/config` | Reads configuration from `.env` and environment variables |
| `class-validator`, `class-transformer` | Validate and convert incoming data in DTOs |
| `@nestjs/swagger` | Generates interactive API docs at `/docs` |

Generate the products feature:

```bash
nest g module products
nest g controller products
nest g service products
```

## 18.3 Configuration

`.env` (local development):

```text
PORT=3000
OPENSEARCH_NODE=http://localhost:9200
OPENSEARCH_USERNAME=
OPENSEARCH_PASSWORD=
OPENSEARCH_INDEX=products
```

In Docker Compose, the API container gets `OPENSEARCH_NODE=http://opensearch:9200`. `opensearch` is the service name, which resolves to the OpenSearch container inside the Docker network. `localhost` inside a container would point to the container itself.

`ConfigModule.forRoot({ isGlobal: true })` in `app.module.ts` loads `.env` and makes `ConfigService` available everywhere. Real environment variables take precedence over `.env` values.

## 18.4 The OpenSearch module: one shared client

Create **one** client for the whole application and share it through dependency injection. The client keeps a pool of HTTP connections; creating a client per request would waste resources.

`src/opensearch/opensearch.constants.ts`:

```ts
export const OPENSEARCH_CLIENT = Symbol('OPENSEARCH_CLIENT');
```

`src/opensearch/opensearch.module.ts`:

```ts
import { Global, Inject, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from '@opensearch-project/opensearch';
import { OPENSEARCH_CLIENT } from './opensearch.constants';

@Global()                                   // available in every module without importing it
@Module({
  providers: [
    {
      provide: OPENSEARCH_CLIENT,           // the injection token
      inject: [ConfigService],
      useFactory: (config: ConfigService): Client => {
        const node = config.get<string>('OPENSEARCH_NODE', 'http://localhost:9200');
        const username = config.get<string>('OPENSEARCH_USERNAME');
        const password = config.get<string>('OPENSEARCH_PASSWORD');

        Logger.log(`Connecting to OpenSearch at ${node}`, 'OpenSearchModule');
        return new Client({
          node,
          ...(username && password ? { auth: { username, password } } : {}),
          // Accept self-signed certs when the security plugin is enabled (dev only)
          ssl: { rejectUnauthorized: false },
        });
      },
    },
  ],
  exports: [OPENSEARCH_CLIENT],
})
export class OpenSearchModule implements OnApplicationShutdown {
  constructor(@Inject(OPENSEARCH_CLIENT) private readonly client: Client) {}

  async onApplicationShutdown() {
    await this.client.close();              // close connections on shutdown
  }
}
```

Key points:

- **`useFactory`** builds the client once, at startup, from the configuration.
- **A `Symbol` token** (`OPENSEARCH_CLIENT`) avoids name clashes. Inject it with `@Inject(OPENSEARCH_CLIENT)`.
- **`@Global()`** means feature modules don't need to import `OpenSearchModule`.
- **`onApplicationShutdown`** closes the connections. `app.enableShutdownHooks()` in `main.ts` makes Nest call it when the process stops.
- **Production:** use HTTPS, real credentials (or AWS SigV4 for Amazon OpenSearch Service), and keep `rejectUnauthorized: true` with a proper CA certificate.

Useful client options:

```ts
new Client({
  node: 'https://search.example.com:9200',     // or nodes: [url1, url2] for several nodes
  auth: { username: 'api', password: process.env.OPENSEARCH_PASSWORD! },
  ssl: { ca: fs.readFileSync('root-ca.pem'), rejectUnauthorized: true },
  maxRetries: 3,                               // retry on connection errors
  requestTimeout: 10_000,                      // milliseconds
  compression: 'gzip',                         // compress request bodies
});
```

## 18.5 How client calls map to REST requests

Every client method corresponds to one REST endpoint. The method's parameters become the path and query string, and `body` is the JSON body:

| Dev Tools | Node.js client |
|---|---|
| `GET products/_doc/P001` | `client.get({ index: 'products', id: 'P001' })` |
| `PUT products/_create/P001` + body | `client.create({ index: 'products', id: 'P001', body })` |
| `PUT products/_doc/P001` + body | `client.index({ index: 'products', id: 'P001', body })` |
| `POST products/_update/P001` + `{ doc }` | `client.update({ index: 'products', id: 'P001', body: { doc } })` |
| `DELETE products/_doc/P001` | `client.delete({ index: 'products', id: 'P001' })` |
| `GET products/_search` + body | `client.search({ index: 'products', body })` |
| `GET products/_count` + body | `client.count({ index: 'products', body })` |
| `POST _bulk` + NDJSON | `client.bulk({ body: [action, doc, action, doc, ...] })` |
| `HEAD products` | `client.indices.exists({ index: 'products' })` |
| `PUT products` + body | `client.indices.create({ index: 'products', body })` |
| `PUT products/_mapping` + body | `client.indices.putMapping({ index: 'products', body })` |
| `POST products/_update_by_query` | `client.updateByQuery({ index: 'products', body })` |
| `GET _cluster/health` | `client.cluster.health()` |
| `?refresh=wait_for` | `refresh: 'wait_for'` parameter |

The response object (client version 2.x):

```ts
const response = await client.search({ index: 'products', body: { query: { match_all: {} } } });
response.statusCode;      // 200
response.body;            // the JSON response, exactly as in Dev Tools
response.body.hits.hits;  // the documents
```

For `_bulk`, the client accepts an **array of objects** and converts it to NDJSON for you.

## 18.6 Error handling

When OpenSearch returns an error status, the client throws a `ResponseError`:

```ts
try {
  await client.get({ index: 'products', id: 'missing' });
} catch (err) {
  err.meta.statusCode;   // 404
  err.meta.body;         // the OpenSearch error JSON
  err.message;           // a summary, e.g. "Response Error"
}
```

The service converts the statuses it expects into NestJS HTTP exceptions:

```ts
function statusOf(err: unknown): number | undefined {
  return (err as { meta?: { statusCode?: number } })?.meta?.statusCode;
}

// in findOne():
catch (err) {
  if (statusOf(err) === 404) throw new NotFoundException(`Product "${id}" not found`);
  throw err;
}
```

| OpenSearch status | Thrown as | API response |
|---|---|---|
| 404 on get/update/delete | `NotFoundException` | 404 `Product "x" not found` |
| 409 on create | `ConflictException` | 409 `Product "x" already exists` |
| Others (400 bad query, 500, ...) | Rethrown unchanged | NestJS passes the status and message through |

> **Production tip:** add a global exception filter that logs OpenSearch errors and returns a generic message, so internal details (index names, query syntax) don't reach API clients.

## 18.7 Creating the index at startup

The service implements `OnModuleInit`. NestJS calls `onModuleInit()` once, before the app starts accepting requests:

```ts
async onModuleInit() {
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      const { body: exists } = await this.client.indices.exists({ index: this.index });
      if (!exists) {
        await this.client.indices.create({ index: this.index, body: PRODUCTS_INDEX_BODY });
        this.logger.log(`Created index "${this.index}"`);
      } else {
        this.logger.log(`Index "${this.index}" already exists`);
        await this.addMissingAutocompleteField();
      }
      return;
    } catch (err) {
      this.logger.warn(`OpenSearch not ready (attempt ${attempt}/30): ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error('Could not connect to OpenSearch');
}
```

- **Retries:** OpenSearch takes 20–40 seconds to start. In Docker Compose, the API may start first, so it retries every 2 seconds for up to a minute.
- **Create if missing:** a fresh environment gets the correct mapping automatically.
- **Migrate if needed:** `addMissingAutocompleteField()` adds the `name.autocomplete` sub-field to indices created by an older version of the app (chapter 4.6).

> **For larger projects:** keep mappings in versioned files and create indices with a migration script or CI step, using aliases (chapter 3.7). Creating indices from application startup is convenient for small services, but with several app instances you need to make sure only one of them changes the mapping.

## 18.8 The mapping as code

`src/products/products.mapping.ts`:

```ts
export const PRODUCTS_INDEX_BODY = {
  settings: { number_of_shards: 1, number_of_replicas: 0 },
  mappings: {
    properties: {
      name: {
        type: 'text',
        fields: {
          keyword: { type: 'keyword' },                  // sorting, aggregations
          autocomplete: { type: 'search_as_you_type' },  // /products/suggest
        },
      },
      description: { type: 'text' },
      category: { type: 'keyword' },
      tags: { type: 'keyword' },
      price: { type: 'float' },
      stock: { type: 'integer' },
      inStock: { type: 'boolean' },
      createdAt: { type: 'date' },
      updatedAt: { type: 'date' },
    },
  },
};
```

Every field type follows the rules from chapter 4: `keyword` for filters, facets and sorting, `text` for search, numbers for ranges, and `date` for dates.

## 18.9 Bootstrap: validation and Swagger

`src/main.ts`:

```ts
const app = await NestFactory.create(AppModule);

app.enableCors();
app.enableShutdownHooks();
app.useGlobalPipes(
  new ValidationPipe({
    whitelist: true,            // strip properties that aren't in the DTO
    forbidNonWhitelisted: true, // ...or reject them with 400
    transform: true,            // convert query strings to numbers/booleans, apply defaults
  }),
);

const config = new DocumentBuilder().setTitle('NestJS + OpenSearch API').setVersion('1.0').build();
SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));

await app.listen(Number(process.env.PORT ?? 3000));
```

`forbidNonWhitelisted` matters for OpenSearch: with a `strict` mapping, unknown fields would fail anyway, and with a dynamic mapping they would silently create new fields. Rejecting them at the API is clearer and safer.

`transform: true` turns `?page=2&inStock=true` (strings in the URL) into the number `2` and the boolean `true`, as declared in the DTO.
