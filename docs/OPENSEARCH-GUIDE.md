# OpenSearch — A Hands-On Guide

Every example here runs in **OpenSearch Dashboards → Dev Tools** (http://localhost:5601 → ☰ menu → *Management → Dev Tools*) against the `products` index this project creates.
Seed it first with Postman (`0. Setup → Seed sample data`) so the results match.

---

## Contents

1. [The mental model: OpenSearch vs SQL](#1-the-mental-model-opensearch-vs-sql)
2. [Anatomy of a request — where is the "table"?](#2-anatomy-of-a-request--where-is-the-table)
3. [Indices (tables)](#3-indices-tables)
4. [Mappings (the schema) and text vs keyword](#4-mappings-the-schema-and-text-vs-keyword)
5. [Documents: create, read, update, delete](#5-documents-create-read-update-delete)
6. [Searching — the Query DSL](#6-searching--the-query-dsl)
7. [Shaping results: paging, sorting, fields, highlight](#7-shaping-results-paging-sorting-fields-highlight)
8. [Aggregations (GROUP BY)](#8-aggregations-group-by)
9. [Bulk operations, update/delete by query](#9-bulk-operations-updatedelete-by-query)
10. [Using SQL and PPL directly](#10-using-sql-and-ppl-directly)
11. [How it works inside: shards, inverted index, refresh](#11-how-it-works-inside)
12. [Cluster and admin commands](#12-cluster-and-admin-commands)
13. [How the NestJS code maps to all this](#13-how-the-nestjs-code-maps-to-all-this)
14. [Practice exercises](#14-practice-exercises)

---

## 1. The mental model: OpenSearch vs SQL

OpenSearch is a **search engine and document store**. You send it JSON documents, and it indexes every field so you can search them quickly. You talk to it over HTTP with JSON.

| SQL (MySQL / Postgres) | OpenSearch | In this project |
|---|---|---|
| Database server | **Cluster** (one or more **nodes**) | `opensearch-cluster`, one node |
| Table | **Index** | `products` |
| Row | **Document** (a JSON object) | `{ "name": "Wireless Mouse", ... }` |
| Primary key | `_id` | `p-1001` |
| Column | **Field** | `name`, `price`, ... |
| Schema (`CREATE TABLE`) | **Mapping** | `src/products/products.mapping.ts` |
| `SELECT ... WHERE` | **Query DSL** (`_search`) | `ProductsService.search()` |
| `GROUP BY`, `COUNT`, `AVG` | **Aggregations** (`aggs`) | the `facets` in search results |
| `INSERT` | `PUT index/_doc/id` or `POST index/_doc` | `create()` |
| `UPDATE` | `POST index/_update/id` | `update()` |
| `DELETE` | `DELETE index/_doc/id` | `remove()` |
| Index (B-tree) | **Inverted index** (built for every field automatically) | — |
| Partition | **Shard** | 1 shard |
| Replica / read copy | **Replica shard** | 0 replicas |

**What OpenSearch is good at:** full-text search, relevance ranking, typo tolerance, filtering and faceting over millions of documents, logs, analytics.
**What it is weak at:** JOINs, multi-document transactions, and strong consistency. A common pattern keeps the source of truth in SQL and copies data into OpenSearch for searching.

---

## 2. Anatomy of a request — where is the "table"?

Every request has this shape:

```
METHOD  /<index>/<_endpoint>/<id>?<params>
{ JSON body }
```

**The index (table) comes first in the path.** If you leave it out, the request runs against the whole cluster:

```
GET _search                    ← searches EVERY index in the cluster
GET products/_search           ← searches only the products index
GET products,orders/_search    ← two indices
GET prod*/_search              ← wildcard: every index starting with "prod"
```

That is why your query worked without a table name. `GET _search { "query": { "match_all": {} } }` returns documents from **all** indices. On this machine that means `products` **plus** internal ones like `.kibana_1`, `.plugins-ml-config` and `top_queries-*`. Look at the `_index` field on each hit:

```json
"hits": [
  { "_index": ".kibana_1",  "_id": "config:2.19.1", ... },
  { "_index": "products",   "_id": "p-1001", "_source": { "name": "Wireless Mouse", ... } }
]
```

Indices whose names start with `.` are system indices that OpenSearch and Dashboards create for themselves. Don't modify them.

**Always put the index name first:**

```
GET products/_search
{
  "query": { "match_all": {} }
}
```

### Reading a search response

```json
{
  "took": 3,                       // milliseconds
  "timed_out": false,
  "_shards": { "total": 1, "successful": 1, "failed": 0 },
  "hits": {
    "total": { "value": 15, "relation": "eq" },   // how many documents matched
    "max_score": 1.0,
    "hits": [                                     // the documents (only 10 by default!)
      {
        "_index": "products",                     // which index (table)
        "_id": "p-1001",                          // primary key
        "_score": 1.0,                            // relevance score
        "_source": { "name": "Wireless Mouse", "price": 19.99, ... }  // your JSON
      }
    ]
  }
}
```

> By default `_search` returns only **10** hits. Use `"size": 50` to get more (see §7).

### Dev Tools tips
- Put the cursor inside a request and press **Ctrl+Enter** (or click ▶) to run it.
- Leave a blank line between requests. Start comments with `#`.
- `?pretty` isn't needed in Dev Tools. With curl, add `?pretty` for readable output.

The same request with curl:

```bash
curl -X GET "localhost:9200/products/_search?pretty" -H "Content-Type: application/json" -d '{"query":{"match_all":{}}}'
```

---

## 3. Indices (tables)

```
# List all indices (like SHOW TABLES)
GET _cat/indices?v

# Only yours (hide system indices)
GET _cat/indices/products?v

# Does it exist?
HEAD products

# Settings + mapping (like DESCRIBE TABLE)
GET products

# Create a new index with a schema (like CREATE TABLE)
PUT orders
{
  "settings": { "number_of_shards": 1, "number_of_replicas": 0 },
  "mappings": {
    "properties": {
      "orderNo":    { "type": "keyword" },
      "customer":   { "type": "text" },
      "total":      { "type": "float" },
      "status":     { "type": "keyword" },
      "createdAt":  { "type": "date" }
    }
  }
}

# Count rows (SELECT COUNT(*))
GET orders/_count

# Delete the whole index (DROP TABLE) — irreversible!
DELETE orders
```

### Aliases: a second name for an index

```
POST _aliases
{ "actions": [ { "add": { "index": "products", "alias": "catalog" } } ] }

GET catalog/_search            # same as products/_search
```

You can use aliases to reindex without downtime. Build `products_v2`, then move the alias from `products_v1` to `products_v2` in a single action.

---

## 4. Mappings (the schema) and text vs keyword

```
GET products/_mapping
```

### Common field types

| Type | Use for | Example |
|---|---|---|
| `text` | Free text you want to **search words in** | name, description |
| `keyword` | Exact values: ids, statuses, categories, tags. Used for **filtering, sorting and aggregations** | category, tags |
| `integer`, `long`, `float`, `double` | Numbers, range queries | price, stock |
| `boolean` | true/false | inStock |
| `date` | ISO dates or epoch millis | createdAt |
| `object` / `nested` | Sub-objects / arrays of objects you query independently | address, line items |
| `geo_point` | lat/lon | store location |

### The most important concept: text vs keyword

When you save a `text` field, OpenSearch runs it through an **analyzer**. The analyzer splits the value into lower-case words (tokens) and stores those words. A `keyword` field is stored exactly as given. See it yourself:

```
POST products/_analyze
{ "field": "name", "text": "Wireless Mouse-2.4GHz" }
# → tokens: "wireless", "mouse", "2.4ghz"      (text: split + lower-cased)

POST products/_analyze
{ "field": "category", "text": "Electronics Gear" }
# → token: "Electronics Gear"                  (keyword: unchanged)
```

Consequences:
- `match` on `name` finds "Wireless Mouse" when you search `mouse`, `MOUSE` or `wireless mouse`.
- `term` on `category` is **exact and case-sensitive**. `"electronics"` matches, but `"Electronics"` returns 0 hits.
- You **can't sort or aggregate on a `text` field**. That's why `name` also has a sub-field, **`name.keyword`**, which we use for sorting by name:

```json
"name": { "type": "text", "fields": { "keyword": { "type": "keyword" } } }
```

### Dynamic mapping

If you index a field that isn't in the mapping, OpenSearch guesses its type. A string becomes `text` with a `.keyword` sub-field, and a number becomes `long` or `float`. That's convenient, but the guesses can be wrong, so define your mapping up front, as `products.mapping.ts` does.

> You **can add** new fields to an existing mapping, but you **cannot change** the type of an existing field. To change one, create a new index with the new mapping and run `POST _reindex` (§9).

```
# Add a new field to an existing index
PUT products/_mapping
{ "properties": { "brand": { "type": "keyword" } } }
```

---

## 5. Documents: create, read, update, delete

```
# INSERT with your own id (creates, or OVERWRITES if the id exists)
PUT products/_doc/p-9001
{ "name": "Laptop Stand", "category": "electronics", "price": 29.99, "stock": 10, "inStock": true }

# INSERT only if the id does NOT exist yet (otherwise 409 conflict) — the API uses this
PUT products/_create/p-9001
{ "name": "Laptop Stand", "category": "electronics", "price": 29.99, "stock": 10, "inStock": true }

# INSERT with an auto-generated id
POST products/_doc
{ "name": "Phone Case", "category": "electronics", "price": 9.99, "stock": 200, "inStock": true }

# SELECT * WHERE _id = ...
GET products/_doc/p-9001

# Only the JSON, no metadata
GET products/_source/p-9001

# Several ids at once
GET products/_mget
{ "ids": ["p-1001", "p-3001", "p-9001"] }

# UPDATE some fields (partial merge) — the API's PATCH
POST products/_update/p-9001
{ "doc": { "price": 24.99, "stock": 0, "inStock": false } }

# UPDATE with a script (e.g. stock = stock - 1)
POST products/_update/p-1001
{ "script": { "source": "ctx._source.stock -= params.n", "params": { "n": 1 } } }

# UPSERT: update if it exists, otherwise insert this document
POST products/_update/p-9002
{
  "doc":    { "price": 5 },
  "upsert": { "name": "Sticker Pack", "category": "fashion", "price": 5, "stock": 1000, "inStock": true }
}

# DELETE one document
DELETE products/_doc/p-9001
```

**Versioning.** Every write increases the document's `_version`, `_seq_no` and `_primary_term`. For optimistic locking, pass `?if_seq_no=..&if_primary_term=..`. The write fails with 409 if someone else changed the document first.

---

## 6. Searching — the Query DSL

All searches use `GET <index>/_search` with a `"query"`. Queries come in two kinds:

| Kind | Asks | Affects `_score`? | Use for |
|---|---|---|---|
| **Full-text** (`match`, `multi_match`, `match_phrase`) | "How **well** does it match?" | Yes | `text` fields, user search boxes |
| **Term-level** (`term`, `terms`, `range`, `exists`, `prefix`, `wildcard`) | "Does it match **exactly**? Yes/no" | No (when placed in `filter`) | `keyword`, numbers, dates, booleans |

### 6.1 Full-text

```
# Any of the words (OR) — "coffee" OR "mug"
GET products/_search
{ "query": { "match": { "name": "coffee mug" } } }

# All of the words (AND)
GET products/_search
{ "query": { "match": { "name": { "query": "coffee mug", "operator": "and" } } } }

# Typo tolerant ("mechanicl keybord" → Mechanical Keyboard)
GET products/_search
{ "query": { "match": { "name": { "query": "mechanicl keybord", "fuzziness": "AUTO" } } } }

# Exact phrase, words in this order
GET products/_search
{ "query": { "match_phrase": { "description": "wireless mouse" } } }

# Several fields; ^3 means a match in name counts 3x more toward the score
GET products/_search
{
  "query": {
    "multi_match": {
      "query": "computer",
      "fields": ["name^3", "description", "tags^2"]
    }
  }
}

# Google-like syntax: + (AND), | (OR), -exclude, "phrases"
# "coffee -mug" → contains coffee but NOT mug → French Press
# (default_operator "and" matters: with the default "or" it means "coffee OR NOT mug")
GET products/_search
{
  "query": {
    "simple_query_string": {
      "query": "coffee -mug",
      "fields": ["name", "description"],
      "default_operator": "and"
    }
  }
}
```

### 6.2 Exact / term-level (SQL `WHERE col = ...`)

```
# WHERE category = 'books'
GET products/_search
{ "query": { "term": { "category": "books" } } }

# WHERE tags IN ('gaming', 'audio')
GET products/_search
{ "query": { "terms": { "tags": ["gaming", "audio"] } } }

# WHERE price BETWEEN 20 AND 50   (gt, gte, lt, lte)
GET products/_search
{ "query": { "range": { "price": { "gte": 20, "lte": 50 } } } }

# Dates: created in the last 7 days
GET products/_search
{ "query": { "range": { "createdAt": { "gte": "now-7d/d" } } } }

# WHERE description IS NOT NULL
GET products/_search
{ "query": { "exists": { "field": "description" } } }

# LIKE 'Wire%'   (on the keyword sub-field)
GET products/_search
{ "query": { "prefix": { "name.keyword": "Wire" } } }

# LIKE '%Mug%'  (slow on big data — avoid leading *)
GET products/_search
{ "query": { "wildcard": { "name.keyword": "*Mug*" } } }

# WHERE _id IN (...)
GET products/_search
{ "query": { "ids": { "values": ["p-1001", "p-2002"] } } }
```

### 6.3 Combining: the `bool` query (SQL `AND` / `OR` / `NOT`)

```
GET products/_search
{
  "query": {
    "bool": {
      "must":     [ { "match": { "description": "computer" } } ],   // AND, adds to the score
      "filter":   [                                                 // AND, no score, cached → fast
        { "term":  { "category": "electronics" } },
        { "term":  { "inStock": true } },
        { "range": { "price": { "lte": 100 } } }
      ],
      "should":   [ { "term": { "tags": "gaming" } } ],             // OR / "nice to have": boosts the score
      "must_not": [ { "term": { "tags": "audio" } } ]               // NOT
    }
  }
}
```

The SQL equivalent:

```sql
SELECT * FROM products
WHERE description LIKE '%computer%' AND category = 'electronics'
  AND inStock = true AND price <= 100 AND NOT 'audio' IN tags
ORDER BY relevance  -- products tagged "gaming" rank higher
```

> **Rule of thumb:** put user-typed search text in `must`, and put everything else (dropdowns, checkboxes, ranges) in `filter`.

`should` used alone, with no `must` or `filter`, means OR:

```
# WHERE category = 'books' OR price > 200
GET products/_search
{
  "query": {
    "bool": {
      "should": [
        { "term":  { "category": "books" } },
        { "range": { "price": { "gt": 200 } } }
      ],
      "minimum_should_match": 1
    }
  }
}
```

### 6.4 Why is this result first? (`_score`)

The score comes from **BM25**, which considers how often the word appears in the field, how rare the word is across all documents, and how short the field is. To see the calculation:

```
GET products/_search
{ "explain": true, "query": { "match": { "name": "mouse" } } }
```

---

## 7. Shaping results: paging, sorting, fields, highlight

```
GET products/_search
{
  "from": 0,                                   // OFFSET
  "size": 5,                                   // LIMIT (default 10)
  "_source": ["name", "price"],                // SELECT name, price
  "sort": [ { "price": "asc" }, { "name.keyword": "asc" } ],   // ORDER BY
  "track_total_hits": true,                    // exact total even when > 10,000
  "query": { "match": { "description": "steel" } },
  "highlight": { "fields": { "description": {} } }             // matched words in <em>
}
```

- `from + size` is limited to **10,000** by default. For deep paging or exports, use **`search_after`**: sort on a unique tie-breaker, then pass the `sort` values of the last hit:

```
GET products/_search
{ "size": 5, "sort": [ { "price": "asc" }, { "_id": "asc" } ] }

# next page → copy the "sort" array of the last hit, e.g. [24.0, "p-4002"]
GET products/_search
{ "size": 5, "sort": [ { "price": "asc" }, { "_id": "asc" } ], "search_after": [24.0, "p-4002"] }
```

- Sorting by any field other than `_score` sets `_score` to `null`. That is expected.
- `GET products/_count` with a `query` returns only the number of matches.

---

## 8. Aggregations (GROUP BY)

Aggregations compute statistics over **all** matching documents. Set `"size": 0` when you only need the statistics and not the documents.

```
# SELECT category, COUNT(*), AVG(price) FROM products GROUP BY category
GET products/_search
{
  "size": 0,
  "aggs": {
    "by_category": {
      "terms": { "field": "category" },
      "aggs": { "avg_price": { "avg": { "field": "price" } } }
    }
  }
}

# min / max / avg / sum / count in one go
GET products/_search
{ "size": 0, "aggs": { "price_stats": { "stats": { "field": "price" } } } }

# Price buckets: < 20, 20–100, ≥ 100
GET products/_search
{
  "size": 0,
  "aggs": {
    "price_ranges": {
      "range": { "field": "price", "ranges": [ { "to": 20 }, { "from": 20, "to": 100 }, { "from": 100 } ] }
    }
  }
}

# Products created per day
GET products/_search
{
  "size": 0,
  "aggs": { "per_day": { "date_histogram": { "field": "createdAt", "calendar_interval": "day" } } }
}

# Aggregations respect the query: tag counts for in-stock electronics only
GET products/_search
{
  "size": 0,
  "query": { "bool": { "filter": [ { "term": { "category": "electronics" } }, { "term": { "inStock": true } } ] } },
  "aggs": { "tags": { "terms": { "field": "tags", "size": 20 } } }
}

# Distinct count (approximate): COUNT(DISTINCT category)
GET products/_search
{ "size": 0, "aggs": { "categories": { "cardinality": { "field": "category" } } } }
```

> Aggregations need `keyword`, numeric, date or boolean fields. Running a `terms` aggregation on a `text` field returns an error.

---

## 9. Bulk operations, update/delete by query

```
# Bulk: one action line + one document line per item (NDJSON — must end with a newline)
POST _bulk
{ "index":  { "_index": "products", "_id": "p-9101" } }
{ "name": "Notebook", "category": "books", "price": 3.5, "stock": 80, "inStock": true }
{ "create": { "_index": "products", "_id": "p-9102" } }
{ "name": "Pen Set", "category": "books", "price": 6, "stock": 0, "inStock": false }
{ "update": { "_index": "products", "_id": "p-9101" } }
{ "doc": { "price": 3.0 } }
{ "delete": { "_index": "products", "_id": "p-9102" } }

# UPDATE products SET price = price * 0.9 WHERE category = 'kitchen'
POST products/_update_by_query
{
  "query":  { "term": { "category": "kitchen" } },
  "script": { "source": "ctx._source.price = Math.round(ctx._source.price * 90) / 100.0" }
}

# DELETE FROM products WHERE stock = 0 AND category = 'books'
POST products/_delete_by_query
{ "query": { "bool": { "filter": [ { "term": { "stock": 0 } }, { "term": { "category": "books" } } ] } } }

# Copy data into a new index (e.g. after changing the mapping)
POST _reindex
{ "source": { "index": "products" }, "dest": { "index": "products_v2" } }
```

---

## 10. Using SQL and PPL directly

OpenSearch includes a **SQL plugin**, so you can query with the SQL you already know. It translates SQL into the Query DSL.

```
POST _plugins/_sql?format=csv
{ "query": "SELECT name, price FROM products WHERE category = 'books' ORDER BY price DESC" }

POST _plugins/_sql?format=csv
{ "query": "SELECT category, COUNT(*) AS total, AVG(price) AS avg_price FROM products GROUP BY category" }

# See the Query DSL that SQL turns into — a great way to learn DSL
POST _plugins/_sql/_explain
{ "query": "SELECT name FROM products WHERE price > 50" }
```

The default output format is `jdbc` (JSON with `schema` and `datarows`). Other formats are `csv`, `raw` and `json`.

**PPL** (Piped Processing Language) is a pipe-style alternative:

```
POST _plugins/_ppl?format=csv
{ "query": "source=products | where price > 100 | fields name, price | sort - price" }
```

Dashboards also has a **Query Workbench** page for running SQL and PPL interactively (☰ → *OpenSearch Plugins → Query Workbench*).

> SQL is convenient for exploring data. Your application code (the NestJS service) uses the Query DSL, because only the DSL exposes everything: fuzziness, boosting, highlighting and aggregations.

---

## 11. How it works inside

### Inverted index
For each `text` field, OpenSearch builds a word → documents list, like the index at the back of a book:

```
"wireless" → [p-1001]
"mouse"    → [p-1001]
"coffee"   → [p-2001, p-2002]
"steel"    → [p-2002, p-2003]
```

A search for `coffee` looks up one entry instead of scanning every row. That's why search stays fast on millions of documents. `keyword`, numeric and date fields also get structures for exact lookups, sorting and aggregations (called *doc values*).

### Shards and replicas
- An index is split into **primary shards**. Each shard is a self-contained index (a Lucene index), and the shards can live on different nodes. You choose the number when you create the index, and it can't easily change afterwards.
- A **replica** is a copy of a primary shard on *another* node. It provides failover and extra read capacity.
- Your setup has one node, 1 primary shard and 0 replicas.

```
GET _cat/shards/products?v
```

### Cluster health colours
| Colour | Meaning |
|---|---|
| 🟢 green | All primary and replica shards are allocated |
| 🟡 yellow | All primaries are allocated, but some replicas aren't. **Normal on a single node**, because a replica can't sit on the same node as its primary. |
| 🔴 red | At least one primary shard is missing, so some data is unavailable |

### Near-real-time: refresh
A newly written document becomes searchable after the next **refresh** (every 1 s by default). `GET _doc/id` sees it immediately. That's why the NestJS API writes with `refresh: 'wait_for'`: the request waits until the document is searchable before returning.

```
POST products/_refresh      # force a refresh now
```

### Write path (simplified)
`write` → in-memory buffer + transaction log (translog, for durability) → **refresh** (searchable) → **flush** (fsync segments to disk) → background **merge** of small segments.

---

## 12. Cluster and admin commands

```
GET /                                 # version and cluster name
GET _cluster/health                   # green / yellow / red
GET _cat/nodes?v                      # nodes, CPU, heap, RAM
GET _cat/indices?v&s=index            # indices sorted by name
GET _cat/indices?v&expand_wildcards=all   # include hidden/system indices
GET _cat/count/products?v
GET _cat/aliases?v
GET products/_settings
GET products/_stats
GET _nodes/stats/jvm                  # memory usage
GET _cat/plugins?v                    # installed plugins (sql, ml, alerting, ...)
```

---

## 13. How the NestJS code maps to all this

| API endpoint | OpenSearch call in `products.service.ts` | Dev Tools equivalent |
|---|---|---|
| startup | `indices.exists` / `indices.create` | `HEAD products` / `PUT products {mapping}` |
| `POST /products` | `client.create({ id, body, refresh })` | `PUT products/_create/<id>` |
| `POST /products/bulk` | `client.bulk({ body })` | `POST _bulk` |
| `GET /products/:id` | `client.get({ id })` | `GET products/_doc/<id>` |
| `GET /products/search` | `client.search({ body: { query: { bool: { must, filter } }, sort, aggs, highlight } })` | `GET products/_search` (§6–8) |
| `PATCH /products/:id` | `client.update({ body: { doc } })` | `POST products/_update/<id>` |
| `PUT /products/:id` | `client.index({ id, body })` | `PUT products/_doc/<id>` |
| `DELETE /products/:id` | `client.delete({ id })` | `DELETE products/_doc/<id>` |

To see the exact DSL that `/products/search?q=computer&category=electronics&maxPrice=100` sends, open the README (§7.4), or add a `console.log(JSON.stringify(body))` in `search()`.

---

## 14. Practice exercises

Try each one in Dev Tools. The answers are below.

1. Find all products in the `sports` category, cheapest first.
2. Find products whose description contains "steel", showing only `name` and `price`.
3. Count the out-of-stock products.
4. Show the average price per category, sorted by average price (highest first).
5. Find electronics under 50 that are in stock **or** tagged `gaming`.
6. Increase the stock of `p-4003` by 5 using a script.
7. Find "Clean Code" while spelling it "Claen Cod".

<details>
<summary>Answers</summary>

```
# 1
GET products/_search
{ "query": { "term": { "category": "sports" } }, "sort": [ { "price": "asc" } ] }

# 2
GET products/_search
{ "_source": ["name", "price"], "query": { "match": { "description": "steel" } } }

# 3
GET products/_count
{ "query": { "term": { "inStock": false } } }

# 4
GET products/_search
{
  "size": 0,
  "aggs": {
    "by_category": {
      "terms": { "field": "category", "order": { "avg_price": "desc" } },
      "aggs": { "avg_price": { "avg": { "field": "price" } } }
    }
  }
}

# 5
GET products/_search
{
  "query": {
    "bool": {
      "filter": [ { "term": { "category": "electronics" } }, { "range": { "price": { "lt": 50 } } } ],
      "should": [ { "term": { "inStock": true } }, { "term": { "tags": "gaming" } } ],
      "minimum_should_match": 1
    }
  }
}

# 6
POST products/_update/p-4003
{ "script": { "source": "ctx._source.stock += 5; ctx._source.inStock = ctx._source.stock > 0" } }

# 7
GET products/_search
{ "query": { "match": { "name": { "query": "Claen Cod", "fuzziness": "AUTO" } } } }
```
</details>

---

**Further reading:** the official docs at https://docs.opensearch.org/ — start with *Query DSL*, *Aggregations* and *Mappings*.
