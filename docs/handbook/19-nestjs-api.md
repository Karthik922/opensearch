# Chapter 19 — Building the Products API in NestJS

This chapter walks through every endpoint of the products API: what the client sends, how the NestJS code turns it into an OpenSearch request, and what comes back. All the code is in `src/products/`.

## 19.1 The endpoints

| Method | Path | Purpose | OpenSearch API used |
|---|---|---|---|
| POST | `/products` | Create one product | `_create` |
| POST | `/products/bulk` | Create or overwrite many | `_bulk` |
| GET | `/products/search` | Search, filter, sort, paginate, facets | `_search` |
| GET | `/products/suggest` | Autocomplete | `_search` (`bool_prefix`) |
| GET | `/products/stats` | Catalog statistics | `_search` (aggregations, `size: 0`) |
| GET | `/products/:id` | Get one | `_doc` (get) |
| PUT | `/products/:id` | Replace | `_doc` (index) |
| PATCH | `/products/:id` | Partial update | `_update` |
| DELETE | `/products/:id` | Delete | `_doc` (delete) |
| GET | `/health` | API and cluster health | `_cluster/health` |

Swagger UI at `http://localhost:3000/docs` lets you try every endpoint in the browser. In the examples below, the API runs on port **3000**; use the port you started it on (for example 3001).

## 19.2 DTOs: validating input

A **DTO** (data transfer object) is a class describing the expected input. The global `ValidationPipe` (chapter 18.9) checks every request against it and responds with **400** and a list of problems if it doesn't match.

`src/products/dto/create-product.dto.ts`:

```ts
export class CreateProductDto {
  @ApiPropertyOptional({ description: 'Custom id. Auto-generated (UUID) when omitted.', example: 'p-1001' })
  @IsOptional()
  @IsString()
  id?: string;

  @ApiProperty({ example: 'Wireless Mouse' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional({ example: 'Ergonomic 2.4GHz wireless mouse with silent clicks' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ example: 'electronics' })
  @IsString()
  @IsNotEmpty()
  category: string;

  @ApiPropertyOptional({ example: ['computer', 'accessories'], type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiProperty({ example: 19.99 })
  @IsNumber()
  @Min(0)
  price: number;

  @ApiProperty({ example: 150 })
  @IsInt()
  @Min(0)
  stock: number;
}
```

- `class-validator` decorators (`@IsString`, `@Min`, ...) define the rules.
- `@ApiProperty` decorators feed Swagger.
- `inStock`, `createdAt` and `updatedAt` are **not** in the DTO: the server calculates them, so clients can't set wrong values.

`update-product.dto.ts` derives the other DTOs from it, so the rules are written once:

```ts
/** PUT body: every field required (full replacement). The id comes from the URL. */
export class ReplaceProductDto extends OmitType(CreateProductDto, ['id'] as const) {}

/** PATCH body: any subset of fields (partial edit). */
export class UpdateProductDto extends PartialType(ReplaceProductDto) {}
```

Query-string DTOs convert types. URL parameters are always strings, so `@Type(() => Number)` turns `"2"` into `2`, and a `@Transform` turns `"true"` into `true`:

```ts
@ApiPropertyOptional({ example: 10 })
@IsOptional()
@Type(() => Number)
@IsNumber()
minPrice?: number;

@ApiPropertyOptional({ example: true })
@IsOptional()
@Transform(({ value }) => (value === 'true' || value === true ? true : value === 'false' || value === false ? false : value))
@IsBoolean()
inStock?: boolean;

@ApiPropertyOptional({ default: 1, minimum: 1 })
@IsOptional()
@Type(() => Number)
@IsInt()
@Min(1)
page: number = 1;
```

## 19.3 Create a product — `POST /products`

```bash
curl -X POST http://localhost:3000/products \
  -H "Content-Type: application/json" \
  -d '{ "id": "p-1001", "name": "Wireless Mouse", "description": "Ergonomic wireless mouse", "category": "electronics", "tags": ["computer"], "price": 19.99, "stock": 150 }'
```

Controller:

```ts
@Post()
@ApiOperation({ summary: 'Create a product' })
create(@Body() dto: CreateProductDto) {
  return this.products.create(dto);
}
```

Service:

```ts
async create(dto: CreateProductDto): Promise<Product> {
  const { id = randomUUID(), ...fields } = dto;
  const now = new Date().toISOString();
  const doc = { ...fields, inStock: fields.stock > 0, createdAt: now, updatedAt: now };

  try {
    // `create` fails with 409 if the id already exists (unlike `index`, which overwrites)
    await this.client.create({ index: this.index, id, body: doc, refresh: 'wait_for' });
  } catch (err) {
    if (statusOf(err) === 409) throw new ConflictException(`Product "${id}" already exists`);
    throw err;
  }
  return { id, ...doc };
}
```

Step by step:

1. The `id` is taken out of the body: it becomes the document `_id`, not a field. If it's missing, a UUID is generated.
2. Server-side fields are added: `inStock` is derived from `stock`, and the timestamps are set.
3. `client.create` is `PUT products/_create/{id}`: it never overwrites (chapter 6.2).
4. `refresh: 'wait_for'` makes the product searchable before the response is sent.
5. A 409 from OpenSearch becomes a clear `ConflictException`.

Response `201`:

```json
{
  "id": "p-1001", "name": "Wireless Mouse", "description": "Ergonomic wireless mouse",
  "category": "electronics", "tags": ["computer"], "price": 19.99, "stock": 150,
  "inStock": true, "createdAt": "2026-10-24T10:00:00.000Z", "updatedAt": "2026-10-24T10:00:00.000Z"
}
```

## 19.4 Bulk insert — `POST /products/bulk`

```bash
curl -X POST http://localhost:3000/products/bulk \
  -H "Content-Type: application/json" \
  -d '[ { "id": "p-2001", "name": "Coffee Mug", "category": "kitchen", "price": 8.99, "stock": 300 },
        { "id": "p-2002", "name": "French Press", "category": "kitchen", "price": 27.5, "stock": 60 } ]'
```

```ts
@Post('bulk')
@ApiBody({ type: [CreateProductDto] })
bulkCreate(
  @Body(new ParseArrayPipe({ items: CreateProductDto, whitelist: true, forbidNonWhitelisted: true }))
  dtos: CreateProductDto[],
) {
  return this.products.bulkCreate(dtos);
}
```

`ParseArrayPipe` validates **each element** of the array against the DTO.

```ts
async bulkCreate(dtos: CreateProductDto[]) {
  const now = new Date().toISOString();
  const body = dtos.flatMap(({ id = randomUUID(), ...fields }) => [
    { index: { _index: this.index, _id: id } },                               // action line
    { ...fields, inStock: fields.stock > 0, createdAt: now, updatedAt: now }, // document line
  ]);
  const { body: res } = await this.client.bulk({ body, refresh: 'wait_for' });
  return {
    errors: res.errors,
    items: res.items.map((i: any) => ({ id: i.index._id, result: i.index.result, error: i.index.error?.reason })),
  };
}
```

`flatMap` produces the action/document pairs that `_bulk` expects (chapter 6.10). The response reports `errors` and a per-item `result` (`created` or `updated`) or `error`, because one bad document must not hide the others.

## 19.5 Get, replace, update and delete

```ts
// GET /products/:id → GET products/_doc/{id}
async findOne(id: string): Promise<Product> {
  try {
    const { body } = await this.client.get({ index: this.index, id });
    return { id: body._id, ...(body._source as Omit<Product, 'id'>) };
  } catch (err) {
    if (statusOf(err) === 404) throw new NotFoundException(`Product "${id}" not found`);
    throw err;
  }
}

// PUT /products/:id → PUT products/_doc/{id} (full replace, keeps createdAt)
async replace(id: string, dto: ReplaceProductDto): Promise<Product> {
  const existing = await this.findOne(id);          // 404 if it doesn't exist
  const doc = { ...dto, inStock: dto.stock > 0, createdAt: existing.createdAt, updatedAt: new Date().toISOString() };
  await this.client.index({ index: this.index, id, body: doc, refresh: 'wait_for' });
  return { id, ...doc };
}

// PATCH /products/:id → POST products/_update/{id} with { doc }
async update(id: string, dto: UpdateProductDto): Promise<Product> {
  const partial: Record<string, unknown> = { ...dto, updatedAt: new Date().toISOString() };
  if (dto.stock !== undefined) partial.inStock = dto.stock > 0;
  try {
    const { body } = await this.client.update({
      index: this.index, id, body: { doc: partial }, refresh: 'wait_for',
      _source: 'true',                               // return the updated document
    });
    return { id, ...((body as any).get._source as Omit<Product, 'id'>) };
  } catch (err) {
    if (statusOf(err) === 404) throw new NotFoundException(`Product "${id}" not found`);
    throw err;
  }
}

// DELETE /products/:id → DELETE products/_doc/{id}
async remove(id: string) {
  try {
    await this.client.delete({ index: this.index, id, refresh: 'wait_for' });
    return { id, deleted: true };
  } catch (err) {
    if (statusOf(err) === 404) throw new NotFoundException(`Product "${id}" not found`);
    throw err;
  }
}
```

```bash
curl http://localhost:3000/products/p-1001
curl -X PATCH http://localhost:3000/products/p-1001 -H "Content-Type: application/json" -d '{ "price": 17.49 }'
curl -X PUT http://localhost:3000/products/p-2001 -H "Content-Type: application/json" -d '{ "name": "Travel Mug", "category": "kitchen", "price": 12.5, "stock": 80 }'
curl -X DELETE http://localhost:3000/products/p-2001
```

| | PATCH | PUT |
|---|---|---|
| Body | Only the fields to change | All required fields |
| Fields not sent | Kept | Removed (optional ones) |
| OpenSearch | `_update` with `doc` (merge) | `index` (replace) |
| Use for | Normal edits | Saving a complete record from a form |

> **Route order matters:** in the controller, `@Get('search')`, `@Get('suggest')` and `@Get('stats')` are declared **before** `@Get(':id')`. Otherwise `GET /products/stats` would match `:id` with `id = "stats"`.

## 19.6 Search — `GET /products/search`

This is the heart of the API. It combines chapters 8 to 16.

### Parameters

| Parameter | Example | Effect |
|---|---|---|
| `q` | `wireless mouse` | Full-text search over name (×3), tags (×2), description; typo tolerant |
| `category` | `electronics` | Exact category (facet filter) |
| `tags` | `gaming,audio` | Any of these tags (facet filter) |
| `minPrice`, `maxPrice` | `10`, `100` | Price range |
| `inStock` | `true` | Only in-stock (or out-of-stock) products |
| `sortBy` | `relevance`, `price`, `createdAt`, `name` | Sort field (default relevance) |
| `order` | `asc`, `desc` | Sort direction (default desc) |
| `page`, `size` | `2`, `10` | Page-number pagination (size max 100) |
| `cursor` | value of `nextCursor` | Cursor pagination (`search_after`); `page` is ignored |

### Step 1: build the query from the parameters

```ts
const must: any[] = [];
const filter: any[] = [];

if (dto.q) {
  must.push({
    multi_match: { query: dto.q, fields: ['name^3', 'description', 'tags^2'], fuzziness: 'AUTO' },
  });
}
if (dto.inStock !== undefined) filter.push({ term: { inStock: dto.inStock } });
if (dto.minPrice !== undefined || dto.maxPrice !== undefined) {
  filter.push({ range: { price: { gte: dto.minPrice, lte: dto.maxPrice } } });
}
```

- **Search text → `must`** (scored), **everything else → `filter`** (not scored, cached): chapter 7.2.
- A clause is only added when its parameter is present, so an empty request becomes `match_all`.
- A `range` with an `undefined` bound is fine: the JSON serializer drops `undefined`, so `{ gte: 10 }` alone means "10 or more".

### Step 2: facet filters go to `post_filter`

```ts
const categoryFilter = dto.category ? { term: { category: dto.category } } : undefined;
const tagsFilter = dto.tags ? { terms: { tags: dto.tags.split(',').map((t) => t.trim()) } } : undefined;
const facetFilters = [categoryFilter, tagsFilter].filter(Boolean);
const allOf = (clauses: any[]) => (clauses.length ? { bool: { filter: clauses } } : { match_all: {} });
```

Category and tags are **facets**: the UI shows their counts. As explained in chapter 11.5, they're applied with `post_filter`, and each facet aggregation applies only the *other* facet's filter. That way the category list still shows all categories while one is selected.

### Step 3: sort with a tie-breaker

```ts
const SORT_FIELDS = { price: 'price', createdAt: 'createdAt', name: 'name.keyword' } as const;

const sortField = dto.sortBy === 'relevance' ? '_score' : SORT_FIELDS[dto.sortBy];
const sort = [
  sortField === '_score' ? { _score: { order: 'desc' } } : { [sortField]: { order: dto.order } },
  { _id: { order: 'asc' } }, // tie-breaker: stable order + unique search_after cursor
];
```

- The API exposes friendly names (`name`) and maps them to real fields (`name.keyword`, because text fields can't be sorted: chapter 13.4).
- A whitelist (`SORT_FIELDS` plus the DTO's `@IsIn`) prevents clients from sorting on arbitrary fields.
- `_id` as the last key makes the order deterministic (chapter 12.1) and every cursor unique.

### Step 4: the request

```ts
const searchAfter = dto.cursor ? decodeCursor(dto.cursor) : undefined;

const { body } = await this.client.search({
  index: this.index,
  body: {
    ...(searchAfter ? { search_after: searchAfter } : { from: (dto.page - 1) * dto.size }),
    size: dto.size,
    track_total_hits: true,
    query: must.length || filter.length ? { bool: { must, filter } } : { match_all: {} },
    ...(facetFilters.length ? { post_filter: allOf(facetFilters) } : {}),
    sort,
    ...(dto.q ? { highlight: { fields: { name: {}, description: {} } } } : {}),
    aggs: {
      categories: { filter: allOf([tagsFilter].filter(Boolean)),   aggs: { values: { terms: { field: 'category', size: 50 } } } },
      tags:       { filter: allOf([categoryFilter].filter(Boolean)), aggs: { values: { terms: { field: 'tags', size: 50 } } } },
      price:      { filter: allOf(facetFilters),                     aggs: { stats: { stats: { field: 'price' } } } },
    },
  },
});
```

For `GET /products/search?q=wireless&category=electronics&maxPrice=100&sortBy=price&order=asc`, the body sent to OpenSearch is:

```json
{
  "from": 0,
  "size": 10,
  "track_total_hits": true,
  "query": {
    "bool": {
      "must":   [ { "multi_match": { "query": "wireless", "fields": ["name^3", "description", "tags^2"], "fuzziness": "AUTO" } } ],
      "filter": [ { "range": { "price": { "lte": 100 } } } ]
    }
  },
  "post_filter": { "bool": { "filter": [ { "term": { "category": "electronics" } } ] } },
  "sort": [ { "price": { "order": "asc" } }, { "_id": { "order": "asc" } } ],
  "highlight": { "fields": { "name": {}, "description": {} } },
  "aggs": {
    "categories": { "filter": { "match_all": {} }, "aggs": { "values": { "terms": { "field": "category", "size": 50 } } } },
    "tags":       { "filter": { "bool": { "filter": [ { "term": { "category": "electronics" } } ] } }, "aggs": { "values": { "terms": { "field": "tags", "size": 50 } } } },
    "price":      { "filter": { "bool": { "filter": [ { "term": { "category": "electronics" } } ] } }, "aggs": { "stats": { "stats": { "field": "price" } } } }
  }
}
```

> **Debugging tip:** to see the exact body your service sends, temporarily add `console.log(JSON.stringify(body, null, 2))` before `client.search`, then paste the JSON into Dev Tools under `GET products/_search`.

### Step 5: shape the response

```ts
const total = typeof body.hits.total === 'number' ? body.hits.total : body.hits.total.value;
const hits = body.hits.hits as any[];
const aggs = body.aggregations as any;
const last = hits[hits.length - 1];
return {
  total,
  page: searchAfter ? undefined : dto.page,
  size: dto.size,
  totalPages: Math.ceil(total / dto.size),
  nextCursor: hits.length === dto.size && last ? encodeCursor(last.sort) : null,
  items: hits.map((h) => ({ id: h._id, score: h._score, ...h._source, ...(h.highlight ? { highlight: h.highlight } : {}) })),
  facets: {
    categories: aggs.categories.values.buckets.map((b: any) => ({ category: b.key, count: b.doc_count })),
    tags: aggs.tags.values.buckets.map((b: any) => ({ tag: b.key, count: b.doc_count })),
    price: aggs.price.stats,
  },
};
```

The API never returns the raw OpenSearch response. It returns a stable, documented shape, so you can change the index or the query later without breaking clients.

A real response from the project's data (shortened):

```json
{
  "total": 3,
  "page": 1,
  "size": 10,
  "totalPages": 1,
  "nextCursor": null,
  "items": [
    {
      "id": "p-1001", "score": null, "name": "Wireless Mouse", "category": "electronics", "price": 17.49,
      "highlight": {
        "name": ["<em>Wireless</em> Mouse"],
        "description": ["Ergonomic 2.4GHz <em>wireless</em> mouse with silent clicks and USB receiver"]
      }
    },
    { "id": "p-1009", "score": null, "name": "Wireless Mouse M2", "price": 19.99, "...": "..." },
    { "id": "1", "score": null, "name": "Wireless Mouse", "price": 25.99, "...": "..." }
  ],
  "facets": {
    "categories": [ { "category": "electronics", "count": 3 } ],
    "tags":       [ { "tag": "accessories", "count": 2 }, { "tag": "computer", "count": 2 } ],
    "price":      { "count": 3, "min": 17.489999771118164, "max": 25.989999771118164, "avg": 21.15666, "sum": 63.46999 }
  }
}
```

Notes on this response:

- `score` is `null` because the results are sorted by price, not relevance (chapter 13.1).
- The price facet shows values like `17.489999771118164`: the `products` index stores `price` as `float`, which can't represent 17.49 exactly (chapter 4.9). Round in the API or the UI, or use `scaled_float` in a new index.

### Cursor pagination

```ts
/** The cursor is the `sort` array of the last hit, base64url-encoded so it is URL safe. */
function encodeCursor(sortValues: unknown[]): string {
  return Buffer.from(JSON.stringify(sortValues)).toString('base64url');
}

function decodeCursor(cursor: string): unknown[] {
  try {
    const values = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(values)) return values;
  } catch {
    // fall through
  }
  throw new BadRequestException('Invalid cursor');
}
```

The client never needs to know what's inside the cursor:

```bash
# First page
curl "http://localhost:3000/products/search?sortBy=price&order=asc&size=5"
# → { ..., "nextCursor": "WzE4LCJwLTIwMDEiXQ" }

# Next page: send the cursor back with the SAME sort parameters
curl "http://localhost:3000/products/search?sortBy=price&order=asc&size=5&cursor=WzE4LCJwLTIwMDEiXQ"
```

Decoded, `WzE4LCJwLTIwMDEiXQ` is simply `[18,"p-2001"]`: the price and `_id` of the last product on the first page.

`nextCursor` is `null` when the page has fewer than `size` items, which means there are no more pages. The Postman collection walks every page and checks that no product is skipped or repeated.

## 19.7 Autocomplete — `GET /products/suggest`

```ts
async suggest(q: string, size: number) {
  const { body } = await this.client.search({
    index: this.index,
    body: {
      size,
      _source: ['name', 'category', 'price'],          // only what the dropdown needs
      query: {
        multi_match: {
          query: q,
          type: 'bool_prefix',
          fields: ['name.autocomplete', 'name.autocomplete._2gram', 'name.autocomplete._3gram'],
        },
      },
    },
  });
  return (body.hits.hits as any[]).map((h) => ({ id: h._id, ...h._source }));
}
```

```bash
curl "http://localhost:3000/products/suggest?q=mech%20key&size=3"
```

```json
[
  { "id": "p-1002", "price": 79.5, "name": "Mechanical Keyboard", "category": "electronics" },
  { "id": "p-1010", "price": 79.5, "name": "Mechanical Keyboard K2", "category": "electronics" }
]
```

In the frontend, call it on each keystroke with a **debounce** of about 150–250 ms, and cancel the previous request when a new one starts.

## 19.8 Statistics — `GET /products/stats`

`stats()` runs one `size: 0` search with several aggregations (chapter 16) and turns the buckets into simple JSON:

```bash
curl http://localhost:3000/products/stats
```

A real response (shortened):

```json
{
  "totalProducts": 30,
  "outOfStock": 8,
  "inventoryValue": 54103.92,
  "price": { "min": 8.99, "max": 329, "avg": 68.42 },
  "byCategory": [
    { "category": "electronics", "products": 14, "avgPrice": 93.38, "unitsInStock": 574, "outOfStock": 4 },
    { "category": "kitchen", "products": 7, "avgPrice": 31.78, "unitsInStock": 546, "outOfStock": 0 }
  ],
  "priceRanges": [
    { "range": "under 25", "products": 10 },
    { "range": "25 to 100", "products": 16 },
    { "range": "100 and above", "products": 4 }
  ],
  "createdPerMonth": [ { "month": "2026-10", "products": 27 } ],
  "topTags": [ { "tag": "computer", "products": 8 }, { "tag": "accessories", "products": 4 } ]
}
```

`createdPerMonth` counts 27 of the 30 products because three older documents have no `createdAt`. Aggregations simply skip documents without the field.

Two lessons from this endpoint, both from real bugs:

1. The `inventory_value` script checks `doc['price'].size() == 0 || doc['stock'].size() == 0` first. Older documents without `stock` otherwise made the whole request fail.
2. `created_per_month` (a `date_histogram`) is listed **before** `price_ranges` (a `range`), to avoid the OpenSearch 2.19.1 aggregation bug described in chapter 16.6.

## 19.9 Health — `GET /health`

```ts
@Get()
async check() {
  const { body } = await this.client.cluster.health();
  return { api: 'ok', opensearch: { cluster: body.cluster_name, status: body.status } };
}
```

Load balancers and Docker health checks can call this endpoint.

## 19.10 Adding your own endpoint: a step-by-step recipe

Example: "**GET /products/categories** — list all categories with their number of products".

1. **Try the query in Dev Tools first** until it returns what you need:

```text
GET products/_search
{ "size": 0, "aggs": { "categories": { "terms": { "field": "category", "size": 100 } } } }
```

2. **Add a service method** that sends the same body and maps the response:

```ts
async categories() {
  const { body } = await this.client.search({
    index: this.index,
    body: { size: 0, aggs: { categories: { terms: { field: 'category', size: 100 } } } },
  });
  return (body.aggregations as any).categories.buckets.map((b: any) => ({ category: b.key, products: b.doc_count }));
}
```

3. **Add a route** in the controller, above `@Get(':id')`:

```ts
@Get('categories')
@ApiOperation({ summary: 'All categories with product counts' })
categories() {
  return this.products.categories();
}
```

4. **Add a DTO** if the endpoint takes parameters, with validation decorators.
5. **Test it** in Swagger (`/docs`) and add a request to the Postman collection.

This pattern (Dev Tools first, then the service, then the controller) works for every OpenSearch feature in this guide.
