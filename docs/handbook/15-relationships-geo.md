# Chapter 15 — Relationships (nested, parent/child) and Geo Search

OpenSearch has no JOIN. Related data is modelled in one of four ways:

| Technique | How | Use for |
|---|---|---|
| **Denormalize** | Copy related fields into the document (the customer's name into each order) | Most many-to-one relations: the default choice |
| **`nested`** | An array of objects inside the document, each kept as its own hidden document | One-to-many lists that are loaded with the parent: order lines, product variants |
| **`join` (parent/child)** | Separate documents in one index, linked by ID | Huge or very frequently changing child lists |
| **Application-side join** | Two queries, combined in your code | Rare lookups with small ID lists |

The repository guide `docs/POSTGRES-TO-OPENSEARCH.md` covers modelling PostgreSQL tables in depth, with a runnable lab. This chapter focuses on the query syntax.

## 15.1 The problem with arrays of objects

A product with variants (sizes and colors), indexed with a normal `object` mapping:

```http
PUT variants_object
{
  "mappings": {
    "properties": {
      "name":     { "type": "text" },
      "variants": {
        "properties": {
          "color": { "type": "keyword" },
          "size":  { "type": "keyword" },
          "stock": { "type": "integer" }
        }
      }
    }
  }
}

PUT variants_object/_doc/1?refresh=true
{
  "name": "T-Shirt",
  "variants": [
    { "color": "red",  "size": "M", "stock": 0 },
    { "color": "blue", "size": "L", "stock": 25 }
  ]
}

# "Is there a red shirt in stock?" Wrongly finds the document
GET variants_object/_search
{
  "query": {
    "bool": {
      "filter": [
        { "term":  { "variants.color": "red" } },
        { "range": { "variants.stock": { "gt": 0 } } }
      ]
    }
  }
}
```

→ 1 hit, which is **wrong**: the red variant has no stock. OpenSearch flattens arrays of objects into one array per field:

```text
variants.color: [red, blue]
variants.stock: [0, 25]        ← which stock belongs to which color is lost
```

## 15.2 `nested` keeps each object separate

```http
PUT variants_nested
{
  "mappings": {
    "properties": {
      "name":     { "type": "text" },
      "variants": {
        "type": "nested",
        "properties": {
          "color": { "type": "keyword" },
          "size":  { "type": "keyword" },
          "stock": { "type": "integer" }
        }
      }
    }
  }
}

PUT variants_nested/_doc/1?refresh=true
{
  "name": "T-Shirt",
  "variants": [
    { "color": "red",  "size": "M", "stock": 0 },
    { "color": "blue", "size": "L", "stock": 25 }
  ]
}
```

Nested fields must be queried with a **`nested` query** that names the `path`. All conditions inside it must match **the same** object:

```http
# Red AND in stock, within one variant: 0 hits (correct)
GET variants_nested/_search
{
  "query": {
    "nested": {
      "path": "variants",
      "query": {
        "bool": {
          "filter": [
            { "term":  { "variants.color": "red" } },
            { "range": { "variants.stock": { "gt": 0 } } }
          ]
        }
      }
    }
  }
}

# Blue AND in stock: 1 hit, and inner_hits shows WHICH variant matched
GET variants_nested/_search
{
  "query": {
    "nested": {
      "path": "variants",
      "query": {
        "bool": {
          "filter": [
            { "term":  { "variants.color": "blue" } },
            { "range": { "variants.stock": { "gt": 0 } } }
          ]
        }
      },
      "inner_hits": {}
    }
  }
}
```

> **Common bug:** a normal `term` query on a nested field (`{"term": {"variants.color": "red"}}` without the `nested` wrapper) returns **0 hits, without an error**. Always wrap nested fields in a `nested` query.

### Sorting by a nested field

```http
# Sort products by the stock of their blue variant
GET variants_nested/_search
{
  "sort": [
    {
      "variants.stock": {
        "order": "desc",
        "mode": "max",
        "nested": { "path": "variants", "filter": { "term": { "variants.color": "blue" } } }
      }
    }
  ]
}
```

### Aggregating nested fields

```http
GET variants_nested/_search
{
  "size": 0,
  "aggs": {
    "variants": {
      "nested": { "path": "variants" },
      "aggs": {
        "colors": {
          "terms": { "field": "variants.color" },
          "aggs": {
            "total_stock": { "sum": { "field": "variants.stock" } },
            "products":    { "reverse_nested": {} }
          }
        }
      }
    }
  }
}
```

`nested` steps into the variant objects; `reverse_nested` steps back out to the parent, so `products.doc_count` counts **products** instead of variants.

### Costs of nested

- Each nested object is a hidden Lucene document: 100 products with 10 variants each are 1,100 documents internally.
- Updating one variant rewrites the whole product with all its variants.
- Default limits: `index.mapping.nested_fields.limit` = 50 nested fields per index, and `index.mapping.nested_objects.limit` = 10,000 nested objects per document.

## 15.3 Parent/child with the `join` field

Parents and children are separate documents **in the same index and the same shard**. A child can be updated without touching its parent.

```http
PUT qa_join
{
  "mappings": {
    "properties": {
      "relation": { "type": "join", "relations": { "question": "answer" } },
      "text":     { "type": "text" },
      "votes":    { "type": "integer" }
    }
  }
}

PUT qa_join/_doc/q1
{ "relation": "question", "text": "How do I paginate deep results in OpenSearch?" }

PUT qa_join/_doc/a1?routing=q1
{ "relation": { "name": "answer", "parent": "q1" }, "text": "Use search_after with a point in time.", "votes": 12 }

PUT qa_join/_doc/a2?routing=q1&refresh=true
{ "relation": { "name": "answer", "parent": "q1" }, "text": "Increase max_result_window.", "votes": 1 }
```

Children **must** be indexed with `routing` set to the parent ID, so they land on the parent's shard.

```http
# Questions that have an answer with 10 or more votes
GET qa_join/_search
{
  "query": {
    "has_child": {
      "type": "answer",
      "query": { "range": { "votes": { "gte": 10 } } },
      "inner_hits": {}
    }
  }
}

# Answers whose question mentions "paginate"
GET qa_join/_search
{
  "query": {
    "has_parent": {
      "parent_type": "question",
      "query": { "match": { "text": "paginate" } }
    }
  }
}

# All answers of question q1
GET qa_join/_search
{
  "query": { "parent_id": { "type": "answer", "id": "q1" } }
}
```

Join queries are several times slower than nested or denormalized ones and use more memory. Use them only when children are very numerous or change very often.

## 15.4 Denormalization and application-side joins

**Denormalization** (copying data) is usually the best choice: an `orders` document contains `customer.name` and `customer.city`, so "orders from Chennai" is a simple `term` query. The cost: when a customer changes their name, every one of their orders must be updated, for example with `_update_by_query`.

**Application-side join**: query one index, collect the IDs, then query the other with `terms`. This is fine for small ID lists. The lab in `docs/POSTGRES-TO-OPENSEARCH.md` demonstrates all four techniques on the same data.

## 15.5 Geo search

A `geo_point` field stores a location. That enables "stores within 5 km", "sort by distance", and "count by distance band".

```http
PUT learn_stores
{
  "mappings": {
    "properties": {
      "name":     { "type": "text" },
      "city":     { "type": "keyword" },
      "location": { "type": "geo_point" }
    }
  }
}

POST learn_stores/_bulk?refresh=true
{ "index": { "_id": "S1" } }
{ "name": "T. Nagar Store",   "city": "Chennai",   "location": { "lat": 13.0418, "lon": 80.2341 } }
{ "index": { "_id": "S2" } }
{ "name": "Anna Nagar Store", "city": "Chennai",   "location": { "lat": 13.0850, "lon": 80.2101 } }
{ "index": { "_id": "S3" } }
{ "name": "Velachery Store",  "city": "Chennai",   "location": { "lat": 12.9815, "lon": 80.2180 } }
{ "index": { "_id": "S4" } }
{ "name": "Koramangala Store","city": "Bangalore", "location": { "lat": 12.9352, "lon": 77.6245 } }
```

A `geo_point` can be written as `{ "lat": ..., "lon": ... }`, as a string `"13.04,80.23"`, or as an array `[lon, lat]`. Note the **reversed order** in the array form.

```http
# Stores within 7 km of Chennai Central, nearest first
GET learn_stores/_search
{
  "query": {
    "bool": {
      "filter": {
        "geo_distance": {
          "distance": "7km",
          "location": { "lat": 13.0827, "lon": 80.2707 }
        }
      }
    }
  },
  "sort": [
    {
      "_geo_distance": {
        "location": { "lat": 13.0827, "lon": 80.2707 },
        "order": "asc",
        "unit": "km"
      }
    }
  ]
}
```

→ 2 stores: **T. Nagar** (6.03 km) and **Anna Nagar** (6.57 km). Velachery (12.6 km) is outside the radius. Each hit's `sort` value is its distance in km, so you can show "6.0 km away" directly.

```http
# Stores inside a rectangle (top-left and bottom-right corners)
GET learn_stores/_search
{
  "query": {
    "geo_bounding_box": {
      "location": {
        "top_left":     { "lat": 13.10, "lon": 80.15 },
        "bottom_right": { "lat": 12.95, "lon": 80.30 }
      }
    }
  }
}

# Count stores by distance band
GET learn_stores/_search
{
  "size": 0,
  "aggs": {
    "rings": {
      "geo_distance": {
        "field": "location",
        "origin": { "lat": 13.0827, "lon": 80.2707 },
        "unit": "km",
        "ranges": [ { "to": 10 }, { "from": 10, "to": 50 }, { "from": 50 } ]
      }
    }
  }
}
```

→ The bounding box contains the three Chennai stores. Distance bands: 2 stores within 10 km, 1 between 10 and 50 km (Velachery), and 1 beyond 50 km (Bangalore, 287 km).

## 15.6 Clean up

```http
DELETE variants_object
DELETE variants_nested
DELETE qa_join
DELETE learn_stores
```
