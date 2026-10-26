# Chapter 10 — Combining Queries: bool and Other Compound Queries

Real searches combine several conditions: "wireless products, in electronics, under 100, not out of stock, preferably Logitech". The `bool` query is how you express AND, OR and NOT in OpenSearch.

## 10.1 The four clauses of `bool`

```text
"bool": {
  "must":     [ ... ],   AND  — must match,     adds to the score   (query context)
  "filter":   [ ... ],   AND  — must match,     no score, cached     (filter context)
  "should":   [ ... ],   OR   — should match,   adds to the score
  "must_not": [ ... ]    NOT  — must not match, no score, cached     (filter context)
}
```

| Clause | Logic | Affects score | Typical use |
|---|---|---|---|
| `must` | AND | Yes | The user's search text |
| `filter` | AND | No | Category, price range, status, dates, in stock |
| `should` | OR / "nice to have" | Yes | Boost preferred results; alternatives |
| `must_not` | NOT | No | Exclude cancelled, deleted, out of stock, ... |

Each clause takes one query object or an array of queries. Any query can be used inside, including another `bool`.

## 10.2 AND: `must` + `filter`

```http
# "keyboard" in the name AND category = electronics AND price <= 60
GET learn_products/_search
{
  "query": {
    "bool": {
      "must": [
        { "match": { "name": "keyboard" } }
      ],
      "filter": [
        { "term":  { "category": "electronics" } },
        { "range": { "price": { "lte": 60 } } }
      ]
    }
  }
}
```

→ **P002** Wireless Keyboard (49.99). The Mechanical Keyboard costs 89, so the price filter removes it.

SQL equivalent:

```sql
SELECT * FROM learn_products
WHERE name ILIKE '%keyboard%' AND category = 'electronics' AND price <= 60
ORDER BY relevance;
```

## 10.3 NOT: `must_not`

```http
# Electronics that are NOT out of stock and NOT tagged gaming
GET learn_products/_search
{
  "query": {
    "bool": {
      "filter":   [ { "term": { "category": "electronics" } } ],
      "must_not": [
        { "term": { "inStock": false } },
        { "term": { "tags": "gaming" } }
      ]
    }
  }
}
```

→ 6 products: all electronics except P003 Mechanical Keyboard (gaming) and P004 Gaming Mouse (gaming and out of stock).

> **Note:** a `bool` with only `must_not` (or only `filter`) gives every hit a score of 0. That's fine for filtering; add a `sort` if you need a specific order.

## 10.4 OR: `should`

How `should` behaves depends on whether the `bool` also has a `must` or `filter`:

| `bool` contains | `should` means |
|---|---|
| **Only** `should` (no `must`/`filter`) | **OR**: at least one `should` clause must match |
| `must` or `filter` as well | **Optional**: documents matching `should` are ranked higher, but nobody is excluded |

### `should` as OR

```http
# category = books OR price > 250
GET learn_products/_search
{
  "query": {
    "bool": {
      "should": [
        { "term":  { "category": "books" } },
        { "range": { "price": { "gt": 250 } } }
      ]
    }
  }
}
```

→ 6 products: the 3 books, plus the headphones (299), the monitor (349) and the dumbbells (299).

### `should` as a ranking boost

```http
# All wireless products; Logitech and highly rated ones first
GET learn_products/_search
{
  "query": {
    "bool": {
      "filter": [ { "term": { "tags": "wireless" } } ],
      "should": [
        { "term":  { "brand": { "value": "Logitech", "boost": 2 } } },
        { "range": { "rating": { "gte": 4.5 } } }
      ]
    }
  }
}
```

→ All 4 wireless products. P001 (Logitech, rating 4.5) scores highest because it matches both `should` clauses. P002 (Logitech) and P005 (rating 4.8) follow. P006 (JBL, rating 4.4) matches neither, but is **still in the results**: in a `bool` with a `filter`, `should` only changes the order.

### `minimum_should_match`

Force at least N of the `should` clauses to match:

```http
# At least 2 of these 3 conditions: tagged travel, rating >= 4.6, price < 50
GET learn_products/_search
{
  "query": {
    "bool": {
      "should": [
        { "term":  { "tags": "travel" } },
        { "range": { "rating": { "gte": 4.6 } } },
        { "range": { "price": { "lt": 50 } } }
      ],
      "minimum_should_match": 2
    }
  }
}
```

→ 5 products: P007 USB-C Charger matches all three (travel, 4.6, 35.99) and ranks first, then P005 Headphones (travel, 4.8) and the three books (rated 4.6 or higher and under 50).

## 10.5 Nesting: (A AND B) OR (C AND D)

Any clause can contain another `bool`. Example: "(kitchen AND under 30) OR (sports AND rated at least 4.5)":

```http
GET learn_products/_search
{
  "query": {
    "bool": {
      "should": [
        {
          "bool": {
            "filter": [
              { "term":  { "category": "kitchen" } },
              { "range": { "price": { "lt": 30 } } }
            ]
          }
        },
        {
          "bool": {
            "filter": [
              { "term":  { "category": "sports" } },
              { "range": { "rating": { "gte": 4.5 } } }
            ]
          }
        }
      ],
      "minimum_should_match": 1
    }
  }
}
```

→ P010 French Press (29.90), P011 Coffee Mug (6.99), P019 Dumbbells (4.6) and P020 Backpack (4.5).

SQL equivalent:

```sql
WHERE (category = 'kitchen' AND price < 30)
   OR (category = 'sports'  AND rating >= 4.5)
```

## 10.6 Named queries — which clause matched?

Give clauses a `_name`. Each hit then lists the names of the clauses it matched in `matched_queries`:

```http
GET learn_products/_search
{
  "_source": ["name"],
  "query": {
    "bool": {
      "should": [
        { "term":  { "tags": { "value": "travel", "_name": "travel" } } },
        { "range": { "price": { "lt": 40, "_name": "cheap" } } }
      ]
    }
  }
}
```

→ For example, P007 USB-C Charger has `"matched_queries": ["travel", "cheap"]`. That's useful for debugging and for showing "why this result" badges.

## 10.7 `constant_score` — match without scoring

Wraps a filter and gives every hit the same score:

```http
GET learn_products/_search
{
  "query": {
    "constant_score": {
      "filter": { "term": { "category": "books" } },
      "boost": 1.5
    }
  }
}
```

## 10.8 `boosting` — push results down instead of removing them

`must_not` removes documents. `boosting` keeps them but lowers their score, so they appear at the end:

```http
# Search "mouse", but rank out-of-stock products lower
GET learn_products/_search
{
  "query": {
    "boosting": {
      "positive": { "match": { "name": "mouse" } },
      "negative": { "term": { "inStock": false } },
      "negative_boost": 0.2
    }
  }
}
```

→ P001 Wireless Mouse first. P004 Gaming Mouse (out of stock) is still listed, but its score is multiplied by 0.2.

## 10.9 `dis_max` — the best clause wins

`dis_max` scores a document by its **best-matching** clause, instead of adding all the clause scores like `bool.should` does. `tie_breaker` adds a fraction of the other clauses' scores:

```http
GET learn_products/_search
{
  "query": {
    "dis_max": {
      "queries": [
        { "match": { "name": "wireless speaker" } },
        { "match": { "description": "wireless speaker" } }
      ],
      "tie_breaker": 0.3
    }
  }
}
```

`multi_match` with `best_fields` (chapter 8.4) is internally a `dis_max`.

## 10.10 `function_score` — custom ranking

`function_score` changes the relevance score with your own business rules: popularity, rating, recency, distance, or randomness.

### Boost by a numeric field: popular products first

```http
GET learn_products/_search
{
  "query": {
    "function_score": {
      "query": { "match": { "description": "wireless" } },
      "field_value_factor": {
        "field": "reviews",
        "modifier": "log1p",
        "factor": 1,
        "missing": 1
      },
      "boost_mode": "multiply"
    }
  }
}
```

The text score is multiplied by `log(1 + reviews)`. `log1p` keeps very popular products from dominating completely: 5,400 reviews is about 3.7, while 830 reviews is about 2.9.

| `modifier` | Effect |
|---|---|
| `none` | Use the value as it is |
| `log1p`, `log2p`, `ln1p` | Logarithm: dampens large values (recommended for counts) |
| `sqrt`, `square`, `reciprocal` | Other curves |

| `boost_mode` | Combine query score and function score by |
|---|---|
| `multiply` (default) | query × function |
| `sum` | query + function |
| `replace` | Ignore the query score |
| `avg`, `max`, `min` | |

### Several functions with weights and filters

```http
GET learn_products/_search
{
  "query": {
    "function_score": {
      "query": { "match_all": {} },
      "functions": [
        { "filter": { "term": { "inStock": true } }, "weight": 3 },
        { "filter": { "range": { "rating": { "gte": 4.7 } } }, "weight": 2 },
        { "field_value_factor": { "field": "reviews", "modifier": "log1p", "missing": 1 } }
      ],
      "score_mode": "sum",
      "boost_mode": "replace"
    }
  },
  "_source": ["name", "rating", "reviews", "inStock"]
}
```

`score_mode` combines the functions (`sum`, `multiply`, `avg`, `first`, `max`, `min`). This one ranks products as "in stock (+3), highly rated (+2), plus popularity".

### Decay functions: newer is better

```http
GET learn_products/_search
{
  "query": {
    "function_score": {
      "query": { "match_all": {} },
      "gauss": {
        "createdAt": { "origin": "2026-10-24", "scale": "60d", "decay": 0.5 }
      }
    }
  },
  "_source": ["name", "createdAt"]
}
```

A product created on the origin date keeps its full score. One created 60 days earlier (the `scale`) gets half (`decay: 0.5`), and older ones get less and less. `gauss`, `exp` and `linear` are three curve shapes; they also work for numbers (a price near 50) and for geo distance.

### Random order (for example "products of the day")

```http
GET learn_products/_search
{
  "query": {
    "function_score": {
      "query": { "term": { "inStock": true } },
      "random_score": { "seed": 20261024, "field": "_seq_no" },
      "boost_mode": "replace"
    }
  },
  "size": 3,
  "_source": ["name"]
}
```

The same seed gives the same order, so pagination stays consistent. Change the seed daily for a new selection.

### Script score

```http
GET learn_products/_search
{
  "query": {
    "script_score": {
      "query": { "term": { "category": "electronics" } },
      "script": {
        "source": "doc['rating'].value * Math.log(2 + doc['reviews'].value)"
      }
    }
  },
  "_source": ["name", "rating", "reviews"]
}
```

Scripts are the most flexible option and the slowest; prefer `field_value_factor` and decay functions when they can express the rule.

## 10.11 Summary

| Need | Use |
|---|---|
| AND with scoring | `bool.must` |
| AND without scoring (fast, cached) | `bool.filter` |
| OR | `bool.should` (alone, or with `minimum_should_match`) |
| NOT | `bool.must_not` |
| Prefer some results without excluding the others | `bool.should` next to `must`/`filter`, or `boosting` |
| Rank by popularity, rating, recency | `function_score` |
| Know which clause matched | `_name` → `matched_queries` |
