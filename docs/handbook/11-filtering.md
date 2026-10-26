# Chapter 11 — Filtering and Faceted Search

An online shop's search page has a search box, plus filters on the left: category checkboxes, a price slider, brand checkboxes, "in stock only". Next to each option is a count ("Electronics (8)"). These counts are called **facets**. This chapter shows how to build that screen correctly.

## 11.1 Filters belong in filter context

Everything the user **selects** (rather than types) is a filter. Filters go in `bool.filter`:

```http
GET learn_products/_search
{
  "query": {
    "bool": {
      "must": [
        { "multi_match": { "query": "wireless", "fields": ["name^3", "description", "tags^2"] } }
      ],
      "filter": [
        { "terms": { "category": ["electronics"] } },
        { "range": { "price": { "gte": 10, "lte": 100 } } },
        { "term":  { "inStock": true } }
      ]
    }
  }
}
```

Why `filter` instead of `must`?

1. **Correct ranking.** Filters don't change the score. A product isn't "more relevant" because it's cheaper.
2. **Speed.** Filter results are cached as bitsets and reused by the next query with the same filter.
3. **Clear code.** Search text and filters are kept apart.

## 11.2 Building filters from a form

Each UI control becomes one clause. If the user didn't choose a value, leave the clause out:

| UI control | Clause |
|---|---|
| Search box | `must: multi_match` |
| Category checkboxes (several allowed) | `filter: terms { category: [...] }` |
| Brand checkboxes | `filter: terms { brand: [...] }` |
| Price slider | `filter: range { price: { gte, lte } }` |
| "In stock only" | `filter: term { inStock: true }` |
| Rating "4 stars and up" | `filter: range { rating: { gte: 4 } }` |
| "New arrivals" | `filter: range { createdAt: { gte: "now-30d/d" } }` |
| "Must have all of these tags" | one `filter: term { tags }` per tag |

Several values of the **same** facet are combined with OR (`terms`), and **different** facets are combined with AND (separate filter clauses). That's what users expect: "(Electronics OR Kitchen) AND price 10–100 AND in stock".

Chapter 19 shows this exact logic in the NestJS `ProductsService.search()` method.

## 11.3 Facet counts with aggregations

Facet counts come from **aggregations** (chapter 16). A `terms` aggregation returns the values of a field and how many matching documents have each value:

```http
GET learn_products/_search
{
  "size": 0,
  "query": {
    "bool": {
      "filter": [ { "range": { "price": { "lte": 100 } } } ]
    }
  },
  "aggs": {
    "categories": { "terms": { "field": "category" } },
    "brands":     { "terms": { "field": "brand", "size": 20 } },
    "in_stock":   { "terms": { "field": "inStock" } },
    "price_ranges": {
      "range": {
        "field": "price",
        "ranges": [
          { "key": "under 25", "to": 25 },
          { "key": "25 to 50", "from": 25, "to": 50 },
          { "key": "50 to 100", "from": 50, "to": 100 }
        ]
      }
    }
  }
}
```

→ Among the 15 products priced up to 100: categories `electronics: 6`, `kitchen: 4`, `books: 3`, `sports: 2`, plus brand counts, stock counts and price buckets (`under 25: 3`, `25 to 50: 7`, `50 to 100: 5`).

Aggregations are calculated over **all documents that match the query**, not just the current page.

## 11.4 The facet problem — and `post_filter`

The user ticks **Category: books**. If you put that filter in `query`, the category facet is calculated only from books, and shows `books: 3` and nothing else. The user can no longer see or pick the other categories.

```http
# Problem: with the category filter in query, the category facet only shows "books"
GET learn_products/_search
{
  "size": 0,
  "query": { "bool": { "filter": [ { "term": { "category": "books" } } ] } },
  "aggs": { "categories": { "terms": { "field": "category" } } }
}
```

**`post_filter`** solves it. It's applied to the hits **after** the aggregations have been calculated:

```http
GET learn_products/_search
{
  "query": { "match_all": {} },
  "post_filter": { "term": { "category": "books" } },
  "aggs": { "categories": { "terms": { "field": "category" } } },
  "_source": ["name", "category"]
}
```

→ The **hits** are the 3 books, while the **category facet** still shows every category: `electronics: 8`, `kitchen: 5`, `sports: 4`, `books: 3`.

| Part of the request | Sees the post_filter? |
|---|---|
| `query` | — (runs first) |
| `aggs` | **No**: calculated on the `query` results only |
| hits (the result list) | **Yes** |

## 11.5 Multi-select facets done properly

With several facets, each facet should be narrowed by **all other** selected facets, but not by itself. Example: the user selects **Category = electronics** and **Tag = wireless**.

- The **category** facet should count products tagged wireless (in any category), so the user can switch category.
- The **tags** facet should count electronics (with any tag), so the user can add tags.
- The **hits** must match both.

Put the facet filters in `post_filter`, and give each facet a `filter` aggregation that applies the *other* facets' filters:

```http
GET learn_products/_search
{
  "query": { "match_all": {} },
  "post_filter": {
    "bool": {
      "filter": [
        { "term": { "category": "electronics" } },
        { "term": { "tags": "wireless" } }
      ]
    }
  },
  "aggs": {
    "category_facet": {
      "filter": { "term": { "tags": "wireless" } },
      "aggs": { "values": { "terms": { "field": "category" } } }
    },
    "tag_facet": {
      "filter": { "term": { "category": "electronics" } },
      "aggs": { "values": { "terms": { "field": "tags" } } }
    }
  },
  "_source": ["name"]
}
```

→ **Hits:** the 4 wireless electronics (P001, P002, P005, P006). **Category facet:** `electronics: 4` (all wireless products here are electronics). **Tag facet:** the tags of all 8 electronics (`computer: 5`, `wireless: 4`, `audio: 2`, `gaming: 2`, `travel: 2`, ...).

Filters the user doesn't pick from a facet list (search text, price slider, in stock) stay in `query`, because they should narrow everything, facets included.

> **This is exactly what the NestJS API's `/products/search` does**, and why `GET /products/search?category=books` still returns every category in `facets.categories` (chapter 19).

## 11.6 Filter performance tips

- Put every non-scoring condition in `filter` or `must_not`: they're cached and skip scoring.
- Use `keyword` fields for exact filters, and numeric or date fields for ranges.
- Round date math (`now/d` rather than `now`) so the filter can be cached.
- Avoid `script` filters and leading wildcards in hot paths.
- Several `term` filters on the same field can usually be one `terms` filter.
