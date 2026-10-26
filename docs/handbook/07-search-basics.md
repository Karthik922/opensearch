# Chapter 7 — Search Fundamentals

## 7.1 The anatomy of a search request

All searches go to the `_search` endpoint of an index. The body can contain these top-level keys:

```text
GET learn_products/_search
{
  "query":            { ... },        which documents match, and how well (scoring)
  "post_filter":      { ... },        filter hits AFTER aggregations are computed (ch. 11)
  "aggs":             { ... },        statistics and groupings (ch. 16)
  "sort":             [ ... ],        order of the hits (ch. 13)
  "from":             0,              skip N hits (pagination, ch. 12)
  "size":             10,             return N hits (default 10)
  "search_after":     [ ... ],        cursor-based pagination (ch. 12)
  "_source":          [ ... ],        which fields of _source to return
  "fields":           [ ... ],        return formatted field values
  "highlight":        { ... },        mark matched words (ch. 14)
  "track_total_hits": true,           exact total count (ch. 12)
  "collapse":         { ... },        one hit per value of a field (ch. 12)
  "suggest":          { ... },        "did you mean" / completion (ch. 14)
  "explain":          true,           explain the score of each hit
  "timeout":          "2s",           stop after this time and return partial results
  "min_score":        0.5             drop hits scoring below this
}
```

Every key is optional. The smallest search returns the first 10 documents:

```http
GET learn_products/_search
```

That's the same as:

```http
GET learn_products/_search
{
  "query": { "match_all": {} }
}
```

`match_all` matches every document and gives each a score of 1.0.

## 7.2 Query context and filter context

This is the single most important concept for writing good queries. Each query clause runs in one of two contexts:

| | Query context | Filter context |
|---|---|---|
| The question | **How well** does this document match? | **Does** this document match? Yes or no |
| Calculates `_score` | Yes | No |
| Cached | No | Yes: repeated filters are very fast |
| Where | `query` (top level), `bool.must`, `bool.should` | `bool.filter`, `bool.must_not`, `post_filter`, `constant_score`, filter aggregations |
| Use for | What the user **typed** in the search box | Everything selected from **dropdowns, checkboxes and sliders**: category, price range, in stock, date range |

```http
GET learn_products/_search
{
  "query": {
    "bool": {
      "must": [
        { "match": { "description": "wireless" } }
      ],
      "filter": [
        { "term":  { "category": "electronics" } },
        { "range": { "price": { "lte": 100 } } }
      ]
    }
  }
}
```

→ 2 hits: **P001** Wireless Mouse and **P002** Wireless Keyboard. The `match` on description decides the ranking. The two filters only remove documents (the headphones at 299 are out) and don't change the scores.

> **Rule of thumb:** search text goes in `must` (or `should`), and everything else goes in `filter`.

## 7.3 Choosing the returned fields

By default, every hit includes the complete `_source`. Return less data for faster responses:

```http
# Only these fields
GET learn_products/_search
{
  "_source": ["name", "price", "category"],
  "query": { "match": { "name": "keyboard" } }
}

# Wildcards and excludes
GET learn_products/_search
{
  "_source": { "includes": ["name", "pri*"], "excludes": ["description"] },
  "query": { "match": { "name": "keyboard" } }
}

# No _source at all: only _id and _score
GET learn_products/_search
{
  "_source": false,
  "query": { "match": { "name": "keyboard" } }
}
```

The `fields` option returns values as indexed, as arrays, and can format dates:

```http
GET learn_products/_search
{
  "_source": false,
  "fields": ["name", { "field": "createdAt", "format": "dd/MM/yyyy" }],
  "query": { "term": { "sku": "P001" } }
}
```

→ `"fields": { "name": ["Wireless Mouse"], "createdAt": ["15/01/2026"] }`

## 7.4 Counting

```http
# Count all documents
GET learn_products/_count

# Count documents matching a query
GET learn_products/_count
{
  "query": { "term": { "category": "kitchen" } }
}
```

→ `"count": 5`. Counting is cheaper than searching because no documents are fetched.

## 7.5 Understanding the score

Add `"explain": true` to see exactly how each score was calculated:

```http
GET learn_products/_search
{
  "explain": true,
  "size": 1,
  "query": { "match": { "name": "wireless mouse" } }
}
```

The `_explanation` shows the BM25 parts for each term: `idf` (how rare the term is across all documents), `tf` (how often it appears in this field, adjusted for field length), and the boost. The scores of the two terms are added together. That's why "Wireless Mouse" (both words) scores about twice as high as "Wireless Keyboard" (one word).

To explain why one specific document did or didn't match:

```http
GET learn_products/_explain/P002
{
  "query": { "match": { "name": "mouse" } }
}
```

→ `"matched": false`. The explanation says there is no matching term in the `name` field.

## 7.6 Validate a query without running it

```http
GET learn_products/_validate/query?explain=true
{
  "query": { "match": { "description": "Running Shoes" } }
}
```

→ `"valid": true`, and the explanation shows the query OpenSearch actually runs: `description:run description:shoe`. That's a quick way to see how your query text was analyzed.

## 7.7 Several searches in one request — `_msearch`

`_msearch` runs several independent searches in one round trip. Like `_bulk`, the body is NDJSON: a header line (the index), then the search body.

```http
GET _msearch
{ "index": "learn_products" }
{ "query": { "term": { "category": "books" } }, "size": 1 }
{ "index": "learn_products" }
{ "query": { "term": { "category": "sports" } }, "size": 1 }
```

The response has a `responses` array with one search result per request, in the same order.

## 7.8 URI search (query string in the URL)

For quick experiments, you can search with a `q` parameter and no body:

```http
GET learn_products/_search?q=name:keyboard&_source=name,price&sort=price:asc
```

The `q` syntax is the **Lucene query string** syntax (chapter 8.6): `field:value`, `AND`, `OR`, `NOT`, `"phrases"`, wildcards. Use it in Dev Tools and curl, but use the JSON body in application code.

## 7.9 Search across several indices

```http
GET learn_products,products/_search
{
  "query": { "match": { "name": "mouse" } },
  "_source": ["name"]
}
```

Each hit's `_index` tells you which index it came from. Use `"indices_boost": [{ "learn_products": 2 }]` to rank one index above another.

## 7.10 A complete, realistic search request

Here is everything from this chapter together. The next chapters explain each part in depth.

```http
GET learn_products/_search
{
  "query": {
    "bool": {
      "must": [
        { "multi_match": { "query": "wireless", "fields": ["name^3", "description", "tags^2"] } }
      ],
      "filter": [
        { "term":  { "inStock": true } },
        { "range": { "price": { "gte": 10, "lte": 300 } } }
      ]
    }
  },
  "sort": [ { "_score": "desc" }, { "price": "asc" } ],
  "from": 0,
  "size": 5,
  "_source": ["name", "price", "brand"],
  "highlight": { "fields": { "name": {}, "description": {} } },
  "aggs": {
    "brands": { "terms": { "field": "brand" } }
  }
}
```

→ 4 hits: P001 Wireless Mouse, P002 Wireless Keyboard, P006 Bluetooth Speaker and P005 Noise Cancelling Headphones. Highlights mark "wireless" in each, and a `brands` aggregation counts the matches per brand.
