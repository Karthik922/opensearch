# Chapter 9 — Exact Queries: term, terms, range, exists and more

**Term-level queries** look for **exact values**. They do **not** analyze the query text. Use them on `keyword`, numeric, date, boolean and `ip` fields, for IDs, statuses, categories, tags, prices and dates. They are the building blocks of filters.

> **The classic mistake:** a `term` query on a `text` field. The stored terms are lower-cased words, but `term` doesn't analyze your input, so `{"term": {"name": "Wireless Mouse"}}` finds nothing. Use `match` for `text` fields, or `term` on the `name.keyword` sub-field.

```http
# 0 hits: "Wireless Mouse" is not a single stored term of the text field
GET learn_products/_search
{ "query": { "term": { "name": "Wireless Mouse" } } }

# 1 hit: exact value on the keyword sub-field
GET learn_products/_search
{ "query": { "term": { "name.keyword": "Wireless Mouse" } } }
```

## 9.1 `term` — exactly one value

```http
# WHERE category = 'books'
GET learn_products/_search
{ "query": { "term": { "category": "books" } } }

# WHERE inStock = false
GET learn_products/_search
{ "query": { "term": { "inStock": false } } }

# Case-insensitive matching on a keyword field
GET learn_products/_search
{ "query": { "term": { "brand": { "value": "LOGITECH", "case_insensitive": true } } } }
```

→ 3 books (P014–P016); 3 out-of-stock products (P004, P013, P016); 2 Logitech products (P001, P002).

## 9.2 `terms` — any of several values (SQL `IN`)

```http
# WHERE category IN ('books', 'sports')
GET learn_products/_search
{
  "query": { "terms": { "category": ["books", "sports"] } },
  "size": 20
}

# Products with the tag "gaming" OR the tag "audio" (tags is an array field)
GET learn_products/_search
{
  "query": { "terms": { "tags": ["gaming", "audio"] } }
}
```

→ 7 books and sports products; 4 products tagged gaming or audio (P003, P004, P005, P006).

**All of several values (AND).** `terms` means "any". To require a document to have **every** tag, use one `term` per value inside a `bool.filter` (chapter 10):

```http
GET learn_products/_search
{
  "query": {
    "bool": {
      "filter": [
        { "term": { "tags": "wireless" } },
        { "term": { "tags": "audio" } }
      ]
    }
  }
}
```

→ P005 and P006: the only products tagged both wireless and audio.

### Terms lookup — take the values from another document

```http
PUT favourites/_doc/user-42?refresh=true
{ "skus": ["P001", "P005", "P017"] }

GET learn_products/_search
{
  "query": {
    "terms": {
      "sku": { "index": "favourites", "id": "user-42", "path": "skus" }
    }
  }
}
```

→ P001, P005 and P017. The ID list is read from the `favourites` document at search time, like `WHERE sku IN (SELECT skus FROM favourites WHERE id = 'user-42')`.

## 9.3 `range` — numbers and dates

| Operator | Meaning |
|---|---|
| `gt` | greater than |
| `gte` | greater than or equal |
| `lt` | less than |
| `lte` | less than or equal |

```http
# WHERE price BETWEEN 20 AND 50
GET learn_products/_search
{
  "query": { "range": { "price": { "gte": 20, "lte": 50 } } },
  "size": 20
}

# WHERE rating > 4.6
GET learn_products/_search
{ "query": { "range": { "rating": { "gt": 4.6 } } } }
```

→ 7 products between 20 and 50 (P002, P007, P010, P013, P014, P015, P016); 5 products rated above 4.6 (P003, P005, P012, P015, P016). Products rated exactly 4.6 are excluded by `gt`; use `gte` to include them.

### Date ranges and date math

```http
# Created in the first quarter of 2026
GET learn_products/_search
{
  "query": {
    "range": {
      "createdAt": { "gte": "2026-01-01", "lt": "2026-04-01" }
    }
  },
  "size": 20
}

# Created in the last 30 days (relative to now)
GET learn_products/_search
{
  "query": { "range": { "createdAt": { "gte": "now-30d/d" } } }
}

# Custom input format and a time zone
GET learn_products/_search
{
  "query": {
    "range": {
      "createdAt": {
        "gte": "01/09/2026",
        "lte": "30/09/2026",
        "format": "dd/MM/yyyy",
        "time_zone": "+05:30"
      }
    }
  }
}
```

→ 6 products from January to March (P001, P002, P003, P009, P010, P014); the products from the last 30 days (the result depends on today's date: on 24 October 2026 it is P019 and P020); 2 products created in September 2026 (P016, P018).

**Date math** expressions:

| Expression | Meaning |
|---|---|
| `now` | The current time |
| `now-1h` | One hour ago |
| `now-7d` | Seven days ago |
| `now/d` | Today at 00:00 (rounded down to the day) |
| `now-1M/M` | The start of last month |
| `2026-01-01\|\|+1M` | One month after 2026-01-01 |

Units: `y` year, `M` month, `w` week, `d` day, `h`/`H` hour, `m` minute, `s` second. Rounding (`/d`) makes the query cacheable: `now` changes every millisecond, `now/d` only once a day.

## 9.4 `exists` — the field has a value (SQL `IS NOT NULL`)

```http
# Products that have a color
GET learn_products/_search
{ "query": { "exists": { "field": "color" } }, "size": 0 }

# Products WITHOUT a color (IS NULL): exists inside must_not
GET learn_products/_search
{
  "query": { "bool": { "must_not": { "exists": { "field": "color" } } } }
}
```

→ 17 products with a color; 3 without (the books P014, P015, P016).

A field counts as missing if it's absent, `null`, or an empty array `[]`.

## 9.5 `prefix`, `wildcard` and `regexp`

```http
# SKUs starting with "P01"
GET learn_products/_search
{ "query": { "prefix": { "sku": "P01" } }, "size": 20 }

# Names ending in "Mouse" (SQL LIKE '%Mouse')
GET learn_products/_search
{ "query": { "wildcard": { "name.keyword": "*Mouse" } } }

# ? matches exactly one character
GET learn_products/_search
{ "query": { "wildcard": { "sku": "P00?" } }, "size": 20 }

# Regular expression: SKUs P001 to P005
GET learn_products/_search
{ "query": { "regexp": { "sku": "P00[1-5]" } } }

# Case-insensitive wildcard
GET learn_products/_search
{ "query": { "wildcard": { "name.keyword": { "value": "*coffee*", "case_insensitive": true } } } }
```

→ prefix `P01`: P010–P019 (10); `*Mouse`: P001, P004; `P00?`: P001–P009 (9); regexp: 5; `*coffee*`: P010, P011.

> **Performance warning:** wildcards at the **start** (`*Mouse`, `*coffee*`) must check every unique term in the field, which is slow on large indices. Prefer full-text search, `search_as_you_type`, or edge n-grams (chapter 5.7). `prefix` is fine, especially on keyword fields.

## 9.6 `fuzzy` — exact value with typos

```http
GET learn_products/_search
{ "query": { "fuzzy": { "brand": { "value": "Logitec", "fuzziness": 1 } } } }
```

→ P001 and P002. `fuzzy` works on single terms; for text typed by users, `match` with `fuzziness` (chapter 8.1) is usually better.

## 9.7 `ids` — by document ID

```http
GET learn_products/_search
{ "query": { "ids": { "values": ["P001", "P010", "P020"] } } }
```

Unlike `_mget`, `ids` is a query, so you can combine it with other conditions in a `bool`.

## 9.8 Term-level queries on text fields — what really happens

Analysis explains the surprises:

```http
# 2 hits: "mouse" is a stored (lower-case) term of the name field
GET learn_products/_search
{ "query": { "term": { "name": "mouse" } } }

# 0 hits: "Mouse" with a capital M isn't a stored term
GET learn_products/_search
{ "query": { "term": { "name": "Mouse" } } }
```

So `term` on a text field only works by accident, with a single lower-case word. Use the right query for the field type:

| Field type | Use |
|---|---|
| `text` | `match`, `match_phrase`, `multi_match` |
| `keyword`, numbers, dates, booleans | `term`, `terms`, `range`, `exists`, `prefix` |

## 9.9 SQL to OpenSearch

| SQL | OpenSearch |
|---|---|
| `WHERE status = 'paid'` | `{"term": {"status": "paid"}}` |
| `WHERE status IN ('paid', 'shipped')` | `{"terms": {"status": ["paid", "shipped"]}}` |
| `WHERE price BETWEEN 10 AND 50` | `{"range": {"price": {"gte": 10, "lte": 50}}}` |
| `WHERE created_at >= NOW() - INTERVAL '7 days'` | `{"range": {"createdAt": {"gte": "now-7d/d"}}}` |
| `WHERE color IS NOT NULL` | `{"exists": {"field": "color"}}` |
| `WHERE color IS NULL` | `{"bool": {"must_not": {"exists": {"field": "color"}}}}` |
| `WHERE sku LIKE 'P01%'` | `{"prefix": {"sku": "P01"}}` |
| `WHERE name LIKE '%mouse%'` | `{"match": {"name": "mouse"}}` (by word), or `wildcard` (slow) |
| `WHERE LOWER(brand) = 'logitech'` | `{"term": {"brand": {"value": "logitech", "case_insensitive": true}}}` |
| `WHERE id IN (1, 2, 3)` | `{"ids": {"values": ["1", "2", "3"]}}` |

## 9.10 Clean up

```http
DELETE favourites
```
