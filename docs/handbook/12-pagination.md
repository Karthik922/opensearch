# Chapter 12 — Pagination: from/size, search_after, PIT and scroll

OpenSearch offers four ways to page through results. Picking the right one depends on how deep users page and whether you're showing a UI or exporting data.

| Method | Jump to page N | Deep pages (beyond 10,000) | Consistent while data changes | Use for |
|---|---|---|---|---|
| `from` + `size` | ✅ | ❌ | ❌ | Normal result pages (1, 2, 3, ...) |
| `search_after` | ❌ (next page only) | ✅ | ❌ (✅ with PIT) | Infinite scroll, "load more", APIs with a cursor |
| `search_after` + **PIT** | ❌ | ✅ | ✅ | Exports and jobs that walk all results |
| `scroll` | ❌ | ✅ | ✅ | Older approach for exports; prefer PIT |

## 12.1 `from` and `size` — page numbers

`size` is the page size; `from` is how many hits to skip:

```text
from = (page - 1) * size
```

```http
# Page 1 of products sorted by price, 5 per page
GET learn_products/_search
{
  "from": 0,
  "size": 5,
  "sort": [ { "price": "asc" }, { "sku": "asc" } ],
  "_source": ["name", "price"]
}

# Page 2
GET learn_products/_search
{
  "from": 5,
  "size": 5,
  "sort": [ { "price": "asc" }, { "sku": "asc" } ],
  "_source": ["name", "price"]
}
```

→ Page 1: P011 (6.99), P018 (19.00), P001 (19.99), P010 (29.90), P014 (32.99). Page 2 continues from P007 (35.99).

Total pages = `ceil(hits.total.value / size)`.

### Why the second sort field matters

P005 and P019 both cost 299.00. If you sort only by price, their order can change between requests, so a product might appear on two pages or on none. Always add a **unique tie-breaker** as the last sort field (here `sku`). That makes the order **deterministic**.

### The 10,000 limit

`from + size` can't exceed `index.max_result_window` (default **10,000**):

```http
# expected error: Result window is too large, from + size must be less than or equal to: [10000]
GET learn_products/_search
{ "from": 10000, "size": 10 }
```

The reason: to return hits 10,000–10,010, **every shard** must find and sort its top 10,010 hits, and the coordinating node then sorts all of them. The cost grows with every page. You can raise the limit (`PUT index/_settings {"index.max_result_window": 50000}`), but for deep paging use `search_after`. Real users rarely go past page 10 anyway; Google stops at around page 40.

## 12.2 Total hit count — `track_total_hits`

By default, OpenSearch counts matches exactly **up to 10,000**. Beyond that it stops counting and returns `"total": { "value": 10000, "relation": "gte" }`, meaning "at least 10,000". This makes large searches faster.

| `track_total_hits` | Effect |
|---|---|
| *(default)* | Exact up to 10,000, then `relation: "gte"` |
| `true` | Always count exactly (slower on big result sets) |
| `false` | Don't count (fastest; `hits.total` is omitted) |
| a number, e.g. `1000` | Exact up to that number |

```http
GET learn_products/_search
{
  "track_total_hits": true,
  "size": 0,
  "query": { "term": { "inStock": true } }
}
```

→ `"total": { "value": 17, "relation": "eq" }`

Show "10,000+ results" in your UI when `relation` is `gte`.

## 12.3 `search_after` — cursor pagination

Instead of "skip N hits", `search_after` says "**give me the hits that come after this one**". You pass the `sort` values of the last hit of the previous page. Each shard can then jump straight to that position, so page 1,000 costs the same as page 2.

Step 1 — the first page. Use a sort with a unique tie-breaker. (The `exists` filter is explained in the warning below.)

```http
GET learn_products/_search
{
  "size": 5,
  "query": { "bool": { "filter": { "exists": { "field": "price" } } } },
  "sort": [ { "price": "asc" }, { "sku": "asc" } ],
  "_source": ["name", "price"]
}
```

Every hit in the response has a `sort` array. The last hit is:

```json
{ "_id": "P014", "_source": { "name": "Clean Code", "price": 32.99 }, "sort": [32.99, "P014"] }
```

Step 2 — the next page: copy that `sort` array into `search_after`:

```http
GET learn_products/_search
{
  "size": 5,
  "query": { "bool": { "filter": { "exists": { "field": "price" } } } },
  "sort": [ { "price": "asc" }, { "sku": "asc" } ],
  "search_after": [32.99, "P014"],
  "_source": ["name", "price"]
}
```

→ P007 (35.99), P013 (39.50), P016 (39.99), P015 (44.50), P002 (49.99). Repeat with the last hit's `sort` values until a page has fewer hits than `size`.

> **Warning — a bug in OpenSearch 2.18/2.19:** `search_after` **skips documents** when **all three** of these are true: the query is `match_all` (or there is no query), the sort field is a **`scaled_float`**, and you're on OpenSearch 2.18 or 2.19. A newer optimization rewrites "match everything, sorted by a number" into a range lookup, and it converts `scaled_float` values incorrectly. Walking all 20 practice products 5 at a time with `match_all` returned only **11** of them, in ascending order. Sorting by `float`, `integer` or `date` fields was correct, and so was the same `scaled_float` sort with **any real filter** in the query. Hence the harmless `exists` filter above. If you paginate on a `scaled_float` field, always include a filter (or store the value as `float` or in cents as `long`), and **test that walking all pages returns every document exactly once**.

Try the bug yourself: the same request without the filter skips P007, P013, P016 and P015:

```http
GET learn_products/_search
{
  "size": 5,
  "sort": [ { "price": "asc" }, { "sku": "asc" } ],
  "search_after": [32.99, "P014"],
  "_source": ["name", "price"]
}
```

Rules:

- The `sort` must be **identical** on every request.
- The last sort field must be **unique** per document (an ID field). `_id` works but is relatively expensive to sort on; a dedicated `keyword` field like `sku` is better.
- Don't use `from` together with `search_after` (or keep it at 0).
- You can only go **forward**, one page at a time. To offer "previous", keep the cursors of the pages you've already loaded.

> **Note:** sort values come back in their internal form. A `scaled_float` price of 19.99 may come back as `19.990000000000002`, and dates come back as epoch milliseconds. Always pass the values back **exactly as received**; don't format them.

The NestJS API implements this as an opaque cursor: it base64-encodes the last `sort` array into `nextCursor`, and the client sends it back as `?cursor=...` (chapter 19).

## 12.4 Point in time (PIT) — a frozen view for consistent paging

New, updated or deleted documents between page requests can shift results. A **point in time** freezes the index as it was at one moment:

```http
# 1. Open a PIT that stays alive for 1 minute
POST learn_products/_search/point_in_time?keep_alive=1m
```

The response contains a `pit_id`. Searches then name the PIT **instead of the index**:

```text
# 2. Search with the PIT: no index in the path
GET _search
{
  "size": 5,
  "pit": { "id": "<pit_id>", "keep_alive": "1m" },
  "query": { "bool": { "filter": { "exists": { "field": "price" } } } },
  "sort": [ { "price": "asc" }, { "sku": "asc" } ]
}

# 3. Next pages: the same request plus search_after with the last hit's sort values
GET _search
{
  "size": 5,
  "pit": { "id": "<pit_id>", "keep_alive": "1m" },
  "query": { "bool": { "filter": { "exists": { "field": "price" } } } },
  "sort": [ { "price": "asc" }, { "sku": "asc" } ],
  "search_after": [32.99, "P014"]
}

# 4. Close the PIT when finished (it also expires automatically)
DELETE _search/point_in_time
{ "pit_id": ["<pit_id>"] }
```

Each request extends the PIT by `keep_alive`, so it only needs to cover the time **between two requests**. Open PITs hold resources, so close them when you're done. List them with `GET _search/point_in_time/_all`.

## 12.5 Scroll — the older export method

Scroll also freezes the results and returns them batch by batch:

```text
# 1. Start: returns the first batch and a _scroll_id
POST learn_products/_search?scroll=1m
{ "size": 1000, "sort": ["_doc"], "query": { "match_all": {} } }

# 2. Repeat with the latest _scroll_id until hits is empty
POST _search/scroll
{ "scroll": "1m", "scroll_id": "<_scroll_id>" }

# 3. Release resources
DELETE _search/scroll
{ "scroll_id": "<_scroll_id>" }
```

`"sort": ["_doc"]` is the most efficient order when you don't care about order. Scroll is still widely used, but **`search_after` + PIT** is the recommended approach for new code.

## 12.6 Collapse — one hit per group

`collapse` returns only the best hit for each value of a field. Example: one product per brand, for a "top product of each brand" list:

```http
GET learn_products/_search
{
  "query": { "term": { "category": "sports" } },
  "collapse": { "field": "brand" },
  "sort": [ { "rating": "desc" } ],
  "_source": ["name", "brand", "rating"]
}
```

→ 3 hits: Decathlon has two sports products, but only its best-rated (P020 Waterproof Hiking Backpack, 4.5) is returned, next to Bowflex and Nike.

Add `inner_hits` to also get the other members of each group:

```http
GET learn_products/_search
{
  "query": { "term": { "category": "sports" } },
  "collapse": {
    "field": "brand",
    "inner_hits": { "name": "all_from_brand", "size": 5, "_source": ["name"] }
  },
  "_source": ["brand"]
}
```

Note that `hits.total` still counts all matching documents (4), not the groups (3). Count groups with a `cardinality` aggregation (chapter 16).

## 12.7 Which method should I use?

| Screen or job | Method |
|---|---|
| Classic result pages with page numbers | `from` + `size`, a unique tie-breaker sort, and max ~100 pages |
| Mobile infinite scroll, "load more", public API | `search_after` with an opaque cursor |
| Export all results to CSV, nightly batch job | `search_after` + PIT |
| Reindexing or copying data | `_reindex` (chapter 3), or scroll / PIT |
| "Best item per category or brand" | `collapse` |
