# Chapter 3 — Indices: Creating and Managing "Tables"

An **index** is where documents live. Every request that reads or writes data names an index **at the start of the path**:

```text
GET  learn_products/_search      → search one index
GET  learn_products,orders/_search → search two indices
GET  learn_*/_search             → every index whose name starts with "learn_"
GET  _search                     → EVERY index in the cluster (rarely what you want)
```

> **Note:** `GET _search` without an index name searches all indices, including internal ones such as `.kibana_1`. That's why it returns documents you didn't create. Always put the index name first.

## 3.1 Index names

Index names must be **lowercase**. They cannot contain spaces or the characters `\ / * ? " < > | , #`, and cannot start with `-`, `_` or `+`. Names starting with `.` are reserved for system indices.

Good names: `products`, `orders_v2`, `logs-2026.10.24`.

## 3.2 Create an index

The simplest way: create it with no settings at all.

```http
PUT my_first_index
```

Usually you create an index with **settings** (how it's stored) and **mappings** (the fields):

```http
PUT my_orders
{
  "settings": {
    "number_of_shards": 1,
    "number_of_replicas": 0,
    "refresh_interval": "1s"
  },
  "mappings": {
    "properties": {
      "orderNo":   { "type": "keyword" },
      "customer":  { "type": "text" },
      "total":     { "type": "scaled_float", "scaling_factor": 100 },
      "status":    { "type": "keyword" },
      "createdAt": { "type": "date" }
    }
  }
}
```

| Setting | Meaning | Can it be changed later? |
|---|---|---|
| `number_of_shards` | How many primary shards (chapter 1.7) | No: you need to reindex or use the split/shrink APIs |
| `number_of_replicas` | Copies of each shard | Yes, at any time |
| `refresh_interval` | How often new documents become searchable. `-1` disables refresh, which is useful during big imports | Yes |
| `analysis` | Custom analyzers (chapter 5) | Only while the index is closed |
| `max_result_window` | Maximum `from + size` for pagination (chapter 12), default 10000 | Yes |

> **Note:** You can also create an index without a mapping and let OpenSearch guess the field types from the first document (dynamic mapping). That's convenient for experiments, but the guesses are often wrong. Chapter 4 explains why you should define mappings yourself.

## 3.3 Inspect an index

```http
# Does it exist? (200 = yes, 404 = no; no response body)
HEAD my_orders

# Everything: aliases, mappings and settings
GET my_orders

# Only the mapping (the schema)
GET my_orders/_mapping

# Only the settings
GET my_orders/_settings

# Number of documents
GET my_orders/_count

# Size, document count and health as a table
GET _cat/indices/my_orders?v

# Detailed statistics: indexing rate, search rate, size, ...
GET my_orders/_stats
```

## 3.4 Change settings

Dynamic settings can be changed on a live index:

```http
PUT my_orders/_settings
{
  "index": {
    "number_of_replicas": 0,
    "refresh_interval": "5s"
  }
}
```

A typical pattern for large imports: set `refresh_interval` to `-1` and `number_of_replicas` to `0` before the import, then restore them afterwards. That makes bulk loading much faster.

## 3.5 Close, open and delete

```http
# A closed index stays on disk but cannot be read or written
POST my_orders/_close

POST my_orders/_open

# Delete the index and ALL its documents. There is no undo.
DELETE my_first_index
```

> **Note:** `DELETE` on an index is permanent. In production, clusters are often configured with `action.destructive_requires_name: true`, which forbids wildcard deletes like `DELETE *`.

## 3.6 Aliases — a second name for an index

An **alias** is a name that points to one or more indices. Applications should use the alias, never the real index name. You can then switch the alias to a new index without changing any code.

```http
# Create alias "current_orders" pointing to my_orders
POST _aliases
{
  "actions": [
    { "add": { "index": "my_orders", "alias": "current_orders" } }
  ]
}

# Use the alias like an index
GET current_orders/_count

# List aliases
GET _cat/aliases?v
```

An alias can also include a **filter**, which acts like a SQL view:

```http
POST _aliases
{
  "actions": [
    {
      "add": {
        "index": "learn_products",
        "alias": "learn_books",
        "filter": { "term": { "category": "books" } }
      }
    }
  ]
}

GET learn_books/_count
```

→ `"count": 3`. Only the books are visible through the alias.

## 3.7 Changing a mapping safely: reindex + alias swap

You **cannot change the type of an existing field** (for example from `text` to `keyword`), because the data on disk was built for the old type. The safe procedure is:

1. Create a new index with the correct mapping.
2. Copy the documents with `_reindex`.
3. Move the alias to the new index in one atomic action.
4. Delete the old index.

```http
# 1. New index with the corrected mapping
PUT my_orders_v2
{
  "settings": { "number_of_shards": 1, "number_of_replicas": 0 },
  "mappings": {
    "properties": {
      "orderNo":   { "type": "keyword" },
      "customer":  { "type": "text", "fields": { "keyword": { "type": "keyword" } } },
      "total":     { "type": "scaled_float", "scaling_factor": 100 },
      "status":    { "type": "keyword" },
      "createdAt": { "type": "date" }
    }
  }
}

# 2. Copy every document
POST _reindex
{
  "source": { "index": "my_orders" },
  "dest":   { "index": "my_orders_v2" }
}

# 3. Switch the alias (both actions happen together; no moment without an index)
POST _aliases
{
  "actions": [
    { "remove": { "index": "my_orders",    "alias": "current_orders" } },
    { "add":    { "index": "my_orders_v2", "alias": "current_orders" } }
  ]
}

# 4. Remove the old index
DELETE my_orders
```

`_reindex` can also transform data while copying, using a query (copy only some documents) or a script:

```text
POST _reindex
{
  "source": { "index": "old", "query": { "term": { "status": "active" } } },
  "dest":   { "index": "new" },
  "script": { "source": "ctx._source.total = ctx._source.total * 100" }
}
```

> **Real example from this project:** the NestJS app's `products` index was originally created by dynamic mapping, which made `tags` a `text` field. Aggregating on `tags` then failed with *"Text fields are not optimised for operations that require per-document field data like aggregations"*. The fix was exactly this procedure: create `products_v2` with `tags` as `keyword`, reindex all 29 documents, and replace the old index with an alias `products` → `products_v2`. The API code didn't change, because it uses the name `products`.

## 3.8 Index templates — automatic settings for new indices

A **template** applies settings and mappings to every new index whose name matches a pattern. This is essential for time-based indices such as `logs-2026.10.24`, which are created automatically.

```http
PUT _index_template/logs_template
{
  "index_patterns": ["logs-*"],
  "priority": 1,
  "template": {
    "settings": { "number_of_shards": 1, "number_of_replicas": 0 },
    "mappings": {
      "properties": {
        "@timestamp": { "type": "date" },
        "level":      { "type": "keyword" },
        "message":    { "type": "text" },
        "service":    { "type": "keyword" }
      }
    }
  }
}

# Creating any document in a new logs-* index applies the template
POST logs-2026.10.24/_doc
{ "@timestamp": "2026-10-24T10:00:00Z", "level": "ERROR", "message": "Payment service timeout", "service": "payments" }

GET logs-2026.10.24/_mapping
```

The mapping of `logs-2026.10.24` now comes from the template.

## 3.9 Useful `_cat` commands

```http
# Indices sorted by size, largest first
GET _cat/indices?v&s=store.size:desc

# Include hidden and system indices
GET _cat/indices?v&expand_wildcards=all

# Shards: which node, how big, state
GET _cat/shards/learn_products?v

# Document count of one index
GET _cat/count/learn_products?v

# Installed plugins
GET _cat/plugins?v
```

## 3.10 Clean up

```http
DELETE my_orders_v2
DELETE logs-2026.10.24
DELETE _index_template/logs_template
POST _aliases
{
  "actions": [ { "remove": { "index": "learn_products", "alias": "learn_books" } } ]
}
```
