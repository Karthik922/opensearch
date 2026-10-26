# Chapter 22 — Cheat Sheet

## 22.1 SQL → OpenSearch

| SQL | OpenSearch (Dev Tools) |
|---|---|
| `SHOW TABLES` | `GET _cat/indices?v` |
| `CREATE TABLE t (...)` | `PUT t { "mappings": { "properties": { ... } } }` |
| `DESCRIBE t` | `GET t/_mapping` |
| `ALTER TABLE t ADD COLUMN c` | `PUT t/_mapping { "properties": { "c": { "type": ... } } }` |
| `DROP TABLE t` | `DELETE t` |
| `INSERT` (fail if exists) | `PUT t/_create/ID { ... }` |
| `INSERT` or replace | `PUT t/_doc/ID { ... }` |
| `INSERT` with generated key | `POST t/_doc { ... }` |
| `UPDATE t SET a = 1 WHERE id = X` | `POST t/_update/X { "doc": { "a": 1 } }` |
| `UPDATE ... WHERE condition` | `POST t/_update_by_query { "query": ..., "script": ... }` |
| `DELETE WHERE id = X` | `DELETE t/_doc/X` |
| `DELETE WHERE condition` | `POST t/_delete_by_query { "query": ... }` |
| `SELECT * WHERE id = X` | `GET t/_doc/X` |
| `SELECT * WHERE id IN (...)` | `GET t/_mget { "ids": [...] }` |
| `SELECT a, b` | `"_source": ["a", "b"]` |
| `WHERE a = 'x'` | `{ "term": { "a": "x" } }` (keyword field) |
| `WHERE a IN ('x', 'y')` | `{ "terms": { "a": ["x", "y"] } }` |
| `WHERE n BETWEEN 1 AND 5` | `{ "range": { "n": { "gte": 1, "lte": 5 } } }` |
| `WHERE a IS NOT NULL` | `{ "exists": { "field": "a" } }` |
| `WHERE a LIKE 'ab%'` | `{ "prefix": { "a": "ab" } }` |
| `WHERE text contains words` | `{ "match": { "text": "words" } }` |
| `AND` / `OR` / `NOT` | `bool.filter` (or `must`) / `bool.should` / `bool.must_not` |
| `ORDER BY a DESC` | `"sort": [ { "a": "desc" } ]` |
| `LIMIT 10 OFFSET 20` | `"size": 10, "from": 20` |
| `COUNT(*)` | `GET t/_count` |
| `GROUP BY a` | `"aggs": { "x": { "terms": { "field": "a" } } }` |
| `AVG(n)`, `SUM(n)`, `MIN`, `MAX` | `avg`, `sum`, `min`, `max` aggregations |
| `COUNT(DISTINCT a)` | `cardinality` aggregation |
| `HAVING COUNT(*) > 1` | `bucket_selector` pipeline aggregation |
| `SELECT DISTINCT a` (one row per a) | `"collapse": { "field": "a" }` |
| JOIN | Denormalize, `nested`, `join` field, or two queries (chapter 15) |

## 22.2 Which query for which field?

| Field type | Typical queries |
|---|---|
| `text` | `match`, `match_phrase`, `multi_match`, `simple_query_string` |
| `keyword` | `term`, `terms`, `prefix`, `wildcard`, `exists` |
| numbers, `date` | `range`, `term`, `terms`, `exists` |
| `boolean` | `term` |
| `nested` | `nested` (wrapping any of the above) |
| `geo_point` | `geo_distance`, `geo_bounding_box` |
| `search_as_you_type` | `multi_match` with `type: bool_prefix` |

## 22.3 Everyday Dev Tools commands

```text
GET _cluster/health
GET _cat/indices?v
GET _cat/aliases?v
GET products/_mapping
GET products/_count
GET products/_doc/ID
GET products/_search
{ "query": { "match": { "name": "mouse" } } }

POST products/_analyze
{ "field": "name", "text": "Wireless Mouse" }

GET products/_validate/query?explain=true
{ "query": { ... } }

GET products/_explain/ID
{ "query": { ... } }
```

## 22.4 A search request template

```text
GET products/_search
{
  "query": {
    "bool": {
      "must":     [ { "multi_match": { "query": "<user text>", "fields": ["name^3", "description"], "fuzziness": "AUTO" } } ],
      "filter":   [ { "term": { "category": "<value>" } }, { "range": { "price": { "gte": 10, "lte": 100 } } } ],
      "should":   [ { "term": { "tags": "bestseller" } } ],
      "must_not": [ { "term": { "inStock": false } } ]
    }
  },
  "post_filter": { "terms": { "brand": ["<selected>"] } },
  "sort": [ "_score", { "price": "asc" }, { "sku": "asc" } ],
  "from": 0,
  "size": 20,
  "_source": ["name", "price", "brand"],
  "highlight": { "fields": { "name": {}, "description": {} } },
  "aggs": {
    "brands": { "terms": { "field": "brand", "size": 20 } },
    "price":  { "stats": { "field": "price" } }
  }
}
```

## 22.5 The NestJS API at a glance

| Request | Example |
|---|---|
| Create | `POST /products` with a JSON body |
| Bulk create | `POST /products/bulk` with a JSON array |
| Get | `GET /products/p-1001` |
| Search | `GET /products/search?q=wireless&category=electronics&minPrice=10&maxPrice=100&inStock=true&sortBy=price&order=asc&page=1&size=10` |
| Next page by cursor | `GET /products/search?sortBy=price&order=asc&size=10&cursor=<nextCursor>` |
| Autocomplete | `GET /products/suggest?q=wire&size=5` |
| Statistics | `GET /products/stats` |
| Partial update | `PATCH /products/p-1001` with `{ "price": 17.49 }` |
| Replace | `PUT /products/p-1001` with all fields |
| Delete | `DELETE /products/p-1001` |
| Health | `GET /health` |
| API docs | `GET /docs` (Swagger UI) |

## 22.6 Glossary

| Term | Meaning |
|---|---|
| Alias | A second name for one or more indices |
| Analyzer | Turns text into terms: character filters → tokenizer → token filters |
| Bucket | A group of documents in an aggregation |
| Bulk | Many write operations in one NDJSON request |
| Doc values | On-disk column store used for sorting and aggregations |
| Document | One JSON record |
| Facet | A filter option with a count, built from aggregations |
| Filter context | Yes/no matching without scoring, cached |
| Index | A collection of documents with a mapping |
| Inverted index | Term → documents lookup that makes text search fast |
| Mapping | The schema: field names and types |
| Node | One OpenSearch server process |
| PIT | Point in time: a frozen view of an index for consistent paging |
| Query context | Matching with relevance scoring |
| Refresh | Makes recent writes searchable (every 1 s by default) |
| Replica | A copy of a shard on another node |
| Segment | An immutable piece of a shard, created by a refresh |
| Shard | A part of an index; a self-contained Lucene index |
| Term | One unit in the inverted index, usually a lower-cased word |
| `_source` | The original JSON of a document |
