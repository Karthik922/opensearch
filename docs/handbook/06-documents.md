# Chapter 6 — Documents: Create, Read, Update, Delete

This chapter covers every way to write and read individual documents. The examples use new IDs (`P100`, `P101`, ...) and delete them at the end, so the 20 practice products stay unchanged.

## 6.1 The document APIs at a glance

| Goal | Request | SQL equivalent |
|---|---|---|
| Create or replace with your own ID | `PUT index/_doc/ID` | `INSERT ... ON CONFLICT DO UPDATE` (whole row) |
| Create only (fail if the ID exists) | `PUT index/_create/ID` | `INSERT` |
| Create with an automatic ID | `POST index/_doc` | `INSERT` with a generated key |
| Read one | `GET index/_doc/ID` | `SELECT * WHERE id = ...` |
| Read several | `GET index/_mget` | `SELECT * WHERE id IN (...)` |
| Check existence | `HEAD index/_doc/ID` | `SELECT 1 WHERE id = ...` |
| Update some fields | `POST index/_update/ID` | `UPDATE ... SET a = ... WHERE id = ...` |
| Delete one | `DELETE index/_doc/ID` | `DELETE WHERE id = ...` |
| Many operations at once | `POST _bulk` | Batch statements |
| Update by condition | `POST index/_update_by_query` | `UPDATE ... WHERE ...` |
| Delete by condition | `POST index/_delete_by_query` | `DELETE ... WHERE ...` |

## 6.2 Create a document

### With your own ID — `PUT index/_doc/ID`

```http
PUT learn_products/_doc/P100
{
  "sku": "P100",
  "name": "Laptop Stand",
  "description": "Aluminium stand that raises your laptop to eye level.",
  "brand": "Rain Design",
  "category": "electronics",
  "tags": ["computer", "accessories"],
  "color": "silver",
  "price": 44.99,
  "rating": 4.7,
  "reviews": 640,
  "stock": 15,
  "inStock": true,
  "createdAt": "2026-10-20"
}
```

Response:

```json
{
  "_index": "learn_products",
  "_id": "P100",
  "_version": 1,
  "result": "created",
  "_shards": { "total": 1, "successful": 1, "failed": 0 },
  "_seq_no": 20,
  "_primary_term": 1
}
```

| Response field | Meaning |
|---|---|
| `result` | `created` the first time, `updated` if a document with this ID already existed and was **replaced** |
| `_version` | Increases by 1 on every change to this document |
| `_seq_no`, `_primary_term` | Position of this change in the shard's history; used for optimistic locking (6.7) |

> **Note:** `PUT _doc` **replaces the whole document**. If you `PUT` again with only `{ "sku": "P100", "name": "x" }`, every other field is gone. To change only some fields, use `_update` (6.5).

### Only if it doesn't exist — `PUT index/_create/ID`

```http
# expected error: P100 already exists (version_conflict_engine_exception, status 409)
PUT learn_products/_create/P100
{ "sku": "P100", "name": "Duplicate" }
```

`_create` protects against overwriting by accident. The NestJS API uses it for `POST /products`, and turns the 409 into a "Product already exists" error.

### With an automatic ID — `POST index/_doc`

```http
POST learn_products/_doc
{
  "sku": "P101",
  "name": "Desk Lamp",
  "category": "home",
  "price": 25.00,
  "stock": 40,
  "inStock": true,
  "createdAt": "2026-10-21"
}
```

The response contains a generated `_id` such as `"gOWWbqEBM8bu6xEsvj2f"`. Automatic IDs are slightly faster to index, but you need your own ID whenever you want to update the document later from another system (for example using the primary key from PostgreSQL).

## 6.3 Read documents

```http
# Full document with metadata
GET learn_products/_doc/P100

# Only the JSON (_source), no metadata
GET learn_products/_source/P100

# Only some fields
GET learn_products/_doc/P100?_source_includes=name,price,stock

# Everything except some fields
GET learn_products/_doc/P100?_source_excludes=description

# Does it exist? (200 or 404, no body)
HEAD learn_products/_doc/P100
```

`GET _doc` response:

```json
{
  "_index": "learn_products",
  "_id": "P100",
  "_version": 1,
  "_seq_no": 20,
  "_primary_term": 1,
  "found": true,
  "_source": { "sku": "P100", "name": "Laptop Stand", ... }
}
```

A missing document returns status 404 with `"found": false`:

```http
# expected error: no document with this ID (404, found: false)
GET learn_products/_doc/DOES-NOT-EXIST
```

> **Note:** `GET _doc/ID` is **real-time**: it returns the latest version immediately, even before a refresh. Searches only see the document after the next refresh (chapter 1.9).

### Several documents at once — `_mget`

```http
GET learn_products/_mget
{
  "ids": ["P001", "P014", "P100", "MISSING"]
}

# With per-document source filtering, across indices
GET _mget
{
  "docs": [
    { "_index": "learn_products", "_id": "P001", "_source": ["name", "price"] },
    { "_index": "learn_products", "_id": "P014", "_source": ["name"] }
  ]
}
```

Each entry in the response has `"found": true` or `false`. One round trip is much faster than many single `GET`s.

## 6.4 Replace a document

`PUT _doc` with an existing ID replaces the document completely and increases `_version`:

```http
PUT learn_products/_doc/P100
{
  "sku": "P100",
  "name": "Laptop Stand Pro",
  "description": "Adjustable aluminium stand with a cable organiser.",
  "brand": "Rain Design",
  "category": "electronics",
  "tags": ["computer", "accessories"],
  "color": "silver",
  "price": 59.99,
  "rating": 4.7,
  "reviews": 640,
  "stock": 15,
  "inStock": true,
  "createdAt": "2026-10-20"
}
```

→ `"result": "updated"`, `"_version": 2`

## 6.5 Update some fields — `_update`

### Partial update with `doc`

Only the fields you send change; everything else stays the same. OpenSearch merges your object into the stored document:

```http
POST learn_products/_update/P100
{
  "doc": {
    "price": 54.99,
    "tags": ["computer", "accessories", "sale"]
  }
}
```

→ `"result": "updated"`. If nothing actually changed, the result is `"noop"` and no new version is written.

> **Note:** Arrays are **replaced, not merged**. To add one tag, send the complete new array, or use a script.

Return the updated document in the response:

```http
POST learn_products/_update/P100?_source=true
{
  "doc": { "stock": 14 }
}
```

The response then contains `get._source` with the full updated document. The NestJS API uses this for `PATCH /products/:id`.

### Update with a script

Scripts (written in the **Painless** language) calculate the new values from the current document. `ctx._source` is the document, and `params` passes values in safely:

```http
# Decrease stock by the quantity ordered, and keep inStock consistent
POST learn_products/_update/P100
{
  "script": {
    "source": "ctx._source.stock -= params.qty; ctx._source.inStock = ctx._source.stock > 0",
    "params": { "qty": 4 }
  }
}

# Add a tag only if it isn't already there
POST learn_products/_update/P100
{
  "script": {
    "source": "if (!ctx._source.tags.contains(params.tag)) { ctx._source.tags.add(params.tag) }",
    "params": { "tag": "bestseller" }
  }
}

# Remove a field
POST learn_products/_update/P100
{
  "script": "ctx._source.remove('color')"
}
```

> **Note:** Always pass changing values through `params` instead of building the script string. OpenSearch compiles and caches each distinct script; a script containing a different number every time is recompiled every time and can hit the compilation limit.

Painless essentials:

| Code | Meaning |
|---|---|
| `ctx._source.field` | Read or write a field of the document |
| `ctx._source.list.add(x)` / `.remove(i)` / `.contains(x)` | List operations |
| `ctx._source.remove('field')` | Delete a field |
| `ctx.op = 'delete'` | Delete the whole document |
| `ctx.op = 'none'` | Do nothing (no new version) |
| `params.name` | A value passed in `params` |
| `if (...) { ... } else { ... }`, `for (...)`, `==`, `&&`, `\|\|` | Java-like syntax |

### Upsert: update, or create if missing

```http
POST learn_products/_update/P102
{
  "doc": { "stock": 10, "inStock": true },
  "upsert": {
    "sku": "P102",
    "name": "Webcam HD",
    "category": "electronics",
    "price": 39.00,
    "stock": 10,
    "inStock": true,
    "createdAt": "2026-10-22"
  }
}
```

The first run creates P102 from `upsert`. Later runs apply `doc` to the existing document. To use the same `doc` for both, write `"doc_as_upsert": true` instead of a separate `upsert` object.

### What `_update` does internally

An update is not done in place: OpenSearch reads the current document, applies your change, and **indexes a complete new version**. `_update` saves you the network round trips, but the cost on the server is the same as a full replace.

## 6.6 Delete a document

```http
DELETE learn_products/_doc/P102
```

→ `"result": "deleted"`. Deleting a missing ID returns 404 with `"result": "not_found"`.

## 6.7 Optimistic concurrency control

Two users load P100 (`_seq_no` 25), both change it, and both save. Without protection, the second save silently overwrites the first. Pass the `_seq_no` and `_primary_term` you read; the write then fails if anybody else changed the document in between:

```http
GET learn_products/_doc/P100
```

Read `_seq_no` and `_primary_term` from the response, then:

```text
PUT learn_products/_doc/P100?if_seq_no=25&if_primary_term=1
{ ...the whole document... }
```

If the document changed since you read it, the response is **409 version_conflict_engine_exception**. Your application then reloads the document and tries again (or shows a message to the user).

For `_update`, use `?retry_on_conflict=3` to let OpenSearch retry automatically when two updates collide. That's safe for scripts like `stock -= 1`, which are recalculated on each retry.

## 6.8 Refresh control on writes

| Parameter | Behaviour | Use when |
|---|---|---|
| *(none)* | Return immediately; searchable within about 1 second | Default; best throughput |
| `?refresh=wait_for` | Wait until the next scheduled refresh makes the change searchable | The user must see their change in a search right after saving (the NestJS API uses this) |
| `?refresh=true` | Force an immediate refresh of the shard | Tests and demos only: expensive under load |

## 6.9 Routing

By default, the shard for a document is chosen by hashing its `_id`. With `?routing=value`, OpenSearch hashes your value instead, so all documents with the same routing value land on the same shard. That's required for parent/child joins (chapter 15) and can speed up searches that always filter by one tenant or customer. A document indexed with routing must also be read, updated and deleted with the same routing value.

## 6.10 Bulk — many operations in one request

`_bulk` performs many index, create, update and delete operations in one HTTP request. It's **the** way to load data: often 10–100 times faster than one request per document.

The body is **NDJSON** (newline-delimited JSON): one action line, followed (except for delete) by one data line. Every line must be a single line of JSON, and the body must end with a newline.

```http
POST _bulk
{ "index":  { "_index": "learn_products", "_id": "P103" } }
{ "sku": "P103", "name": "HDMI Cable 2m", "category": "electronics", "price": 9.99, "stock": 300, "inStock": true, "createdAt": "2026-10-22" }
{ "create": { "_index": "learn_products", "_id": "P104" } }
{ "sku": "P104", "name": "Mouse Pad XL", "category": "electronics", "price": 14.99, "stock": 120, "inStock": true, "createdAt": "2026-10-22" }
{ "update": { "_index": "learn_products", "_id": "P103" } }
{ "doc": { "price": 8.99 } }
{ "delete": { "_index": "learn_products", "_id": "P104" } }
```

| Action | Data line | Behaviour |
|---|---|---|
| `index` | The document | Create or replace |
| `create` | The document | Create only; fails for this item if the ID exists |
| `update` | `{ "doc": {...} }` or `{ "script": {...} }`, optionally with `upsert` | Partial update |
| `delete` | *(none)* | Delete |

If every action uses the same index, put it in the URL and leave it out of the action lines:

```http
POST learn_products/_bulk
{ "index": { "_id": "P105" } }
{ "sku": "P105", "name": "USB Hub", "category": "electronics", "price": 19.99, "stock": 50, "inStock": true, "createdAt": "2026-10-22" }
{ "delete": { "_id": "P105" } }
```

### Reading the bulk response

```json
{
  "took": 12,
  "errors": false,
  "items": [
    { "index":  { "_id": "P103", "result": "created", "status": 201 } },
    { "create": { "_id": "P104", "result": "created", "status": 201 } },
    { "update": { "_id": "P103", "result": "updated", "status": 200 } },
    { "delete": { "_id": "P104", "result": "deleted", "status": 200 } }
  ]
}
```

> **Important:** a bulk request returns **HTTP 200 even when some items fail**. Always check the top-level `"errors"` flag, and if it's `true`, look at each item's `error`. The NestJS service and the Postgres sync script in this project both do this.

Bulk sizing guidelines:

- Send **1,000–5,000 documents** or **5–15 MB** per request, then measure and adjust.
- Use several parallel bulk requests to load faster, and back off (wait and retry) on HTTP 429.
- For a huge initial import, temporarily set `refresh_interval: -1` and `number_of_replicas: 0` (chapter 3.4).

## 6.11 Update by query

Update every document that matches a query, like `UPDATE ... WHERE`:

```http
# 10% discount on all kitchen products that are in stock
POST learn_products/_update_by_query?refresh=true
{
  "query": {
    "bool": {
      "filter": [
        { "term": { "category": "kitchen" } },
        { "term": { "inStock": true } }
      ]
    }
  },
  "script": {
    "source": "ctx._source.price = Math.round(ctx._source.price * params.factor * 100) / 100.0",
    "params": { "factor": 0.9 }
  }
}
```

→ `"updated": 4` (the out-of-stock frying pan is skipped). Undo it so the later chapters see the original prices:

```http
POST learn_products/_update_by_query?refresh=true
{
  "query": {
    "bool": {
      "filter": [
        { "term": { "category": "kitchen" } },
        { "term": { "inStock": true } }
      ]
    }
  },
  "script": {
    "source": "ctx._source.price = params.prices[ctx._id]",
    "params": { "prices": { "P009": 249.00, "P010": 29.90, "P011": 6.99, "P012": 54.00 } }
  }
}
```

Useful options:

| Option | Effect |
|---|---|
| `?conflicts=proceed` | Skip documents that change while the update runs, instead of aborting |
| `?wait_for_completion=false` | Run as a background **task**; the response contains a task ID |
| `?slices=auto` | Split the work into parallel slices |
| No `query` and no `script` | Re-index every document in place, for example after adding a multi-field (chapter 4.6) |

Follow a background task:

```text
GET _tasks/<task id from the response>
```

## 6.12 Delete by query

```http
# Delete all practice documents created in this chapter (P100–P199)
POST learn_products/_delete_by_query?refresh=true
{
  "query": {
    "bool": {
      "should": [
        { "prefix": { "sku": "P1" } },
        { "term": { "name.keyword": "Desk Lamp" } }
      ],
      "minimum_should_match": 1
    }
  }
}

GET learn_products/_count
```

→ The count is back to **20**.

> **Note:** Deleted documents are only marked as deleted. Their disk space is freed later, when segments are merged. To empty an index completely, deleting and recreating the index is faster than `_delete_by_query` with `match_all`.

## 6.13 Summary

| I want to | Use |
|---|---|
| Insert a new record, never overwrite | `PUT index/_create/ID` |
| Save a record whether or not it exists | `PUT index/_doc/ID` |
| Change some fields | `POST index/_update/ID` with `doc` |
| Change a value based on its current value | `_update` with `script` and `params` |
| Insert or update | `_update` with `upsert` or `doc_as_upsert` |
| Load or sync many records | `_bulk`, and check `errors` in the response |
| Change or delete records matching a condition | `_update_by_query`, `_delete_by_query` |
| Prevent lost updates | `if_seq_no` + `if_primary_term`, or `retry_on_conflict` |
