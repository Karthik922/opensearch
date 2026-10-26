# Chapter 13 — Sorting

Without a `sort`, hits are ordered by `_score` (relevance), highest first. With a `sort`, you choose the order.

## 13.1 Sort by a field

```http
# Cheapest first
GET learn_products/_search
{
  "sort": [ { "price": "asc" } ],
  "_source": ["name", "price"]
}

# Long form with options
GET learn_products/_search
{
  "sort": [ { "rating": { "order": "desc" } } ],
  "_source": ["name", "rating"]
}
```

Each hit gets a `sort` array with the values it was sorted by, and `_score` becomes `null` (the score isn't calculated when you don't sort by it).

## 13.2 Several sort fields

The second field decides between hits that are equal on the first, and so on:

```http
# Category A→Z, then highest rating, then SKU as a unique tie-breaker
GET learn_products/_search
{
  "sort": [
    { "category": "asc" },
    { "rating": "desc" },
    { "sku": "asc" }
  ],
  "_source": ["name", "category", "rating"]
}
```

→ books first (P015 4.9, P016 4.7, P014 4.6), then electronics (P005 4.8, P003 4.7, ...), then kitchen, then sports.

## 13.3 Relevance and a field together

Sort by relevance first, and use a field to break ties between equally relevant hits:

```http
GET learn_products/_search
{
  "query": { "match": { "name": "mouse" } },
  "sort": [ "_score", { "reviews": "desc" } ],
  "_source": ["name", "reviews"]
}
```

→ P001 (1,520 reviews) before P004 (980 reviews); both have the same score.

To sort by a field but still see the scores, add `"track_scores": true`.

## 13.4 What you can sort on

| Field type | Sortable? |
|---|---|
| `keyword`, numbers, `date`, `boolean`, `ip` | ✅ (uses doc values) |
| `text` | ❌ error. Sort on its `.keyword` sub-field instead |
| `_score` | ✅ |
| `_id` | ✅ but expensive; prefer a keyword ID field |
| `_doc` | ✅ index order; the fastest (for exports) |
| Fields inside `nested` objects | ✅ with a `nested` option (chapter 15) |

```http
# expected error: text fields are not optimised for sorting (use name.keyword)
GET learn_products/_search
{ "sort": [ { "name": "asc" } ] }

# Correct: alphabetical by name
GET learn_products/_search
{
  "sort": [ { "name.keyword": "asc" } ],
  "_source": ["name"],
  "size": 3
}
```

→ "27-inch 4K Monitor", "Adjustable Dumbbells", "Bluetooth Speaker".

> **Note:** keyword sorting is by byte value, so it's case-sensitive: uppercase letters come before lowercase ones ("Zebra" sorts before "apple"), and accents aren't handled. Use a `keyword` sub-field with a lowercase `normalizer` (chapter 5.6) for natural alphabetical sorting.

## 13.5 Missing values

Documents without the sort field go **last** by default, whatever the direction. Change that with `missing`:

```http
# Products without a color first, then the others A→Z
GET learn_products/_search
{
  "sort": [ { "color": { "order": "asc", "missing": "_first" } }, { "sku": "asc" } ],
  "_source": ["name", "color"],
  "size": 5
}
```

→ The three books (no color) come first, then the black products.

`missing` can also be a value: `"missing": 0` treats a missing number as 0.

## 13.6 Sorting on array fields — `mode`

If a field holds several values (like `tags`, or a list of variant prices), `mode` decides which value counts:

| `mode` | Uses |
|---|---|
| `min` | The smallest value (default for `asc`) |
| `max` | The largest value (default for `desc`) |
| `avg`, `sum`, `median` | Numeric arrays only |

```http
GET learn_products/_search
{
  "sort": [ { "tags": { "order": "asc", "mode": "min" } }, { "sku": "asc" } ],
  "_source": ["name", "tags"],
  "size": 3
}
```

→ Sorted by each product's alphabetically first tag: "accessories" (P001) comes first.

## 13.7 Sorting on a field that doesn't exist in every index

When searching several indices, a sort field missing from one of them causes an error. `unmapped_type` tells OpenSearch how to treat it:

```http
GET learn_products,products/_search
{
  "sort": [ { "rating": { "order": "desc", "unmapped_type": "float" } } ],
  "_source": ["name", "rating"],
  "size": 3
}
```

## 13.8 Sorting by a script

For orders that aren't stored in any field:

```http
# Stock value (price × stock), highest first
GET learn_products/_search
{
  "sort": [
    {
      "_script": {
        "type": "number",
        "order": "desc",
        "script": { "source": "doc['price'].value * doc['stock'].value" }
      }
    }
  ],
  "_source": ["name", "price", "stock"],
  "size": 3
}
```

→ P007 USB-C Charger (35.99 × 200 = 7,198), then P017 Running Shoes (120 × 35 = 4,200) and P005 Headphones (299 × 12 = 3,588). The hit's `sort` value contains the calculated number.

Script sorting runs the script for every matching document, so it's slow. If you need this order often, store the value in a field when indexing (for example `stockValue`).

## 13.9 Sorting and pagination

When paginating, always end the sort with a unique field so the order is stable between pages (chapter 12.1). The NestJS API appends `_id` to every sort for this reason.
