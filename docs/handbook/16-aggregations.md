# Chapter 16 — Aggregations: GROUP BY, Statistics and Analytics

**Aggregations** calculate summaries over the documents that match a query: counts per category, average price, sales per month, the top-rated product of each brand. They power facets, dashboards and reports.

## 16.1 Structure of an aggregation request

```text
GET learn_products/_search
{
  "size": 0,                         ← no documents, only aggregation results
  "query": { ... },                  ← optional: which documents to aggregate
  "aggs": {
    "<your name>": {                 ← any name; it appears in the response
      "<agg type>": { ... },         ← e.g. terms, avg, date_histogram
      "aggs": { ... }                ← optional sub-aggregations (per bucket)
    }
  }
}
```

There are three families:

| Family | What it returns | Examples | SQL equivalent |
|---|---|---|---|
| **Metric** | A number (or a few numbers) | `avg`, `sum`, `min`, `max`, `stats`, `cardinality`, `percentiles` | `AVG()`, `SUM()`, `COUNT(DISTINCT)` |
| **Bucket** | Groups of documents (buckets), each with a `doc_count` | `terms`, `range`, `histogram`, `date_histogram`, `filter`, `filters` | `GROUP BY` |
| **Pipeline** | Calculations on the output of other aggregations | `avg_bucket`, `derivative`, `cumulative_sum`, `bucket_sort`, `bucket_selector` | Window functions, `HAVING` |

> **Important:** aggregations run over **all documents matching the query**, not just the current page of hits. Use `"size": 0` when you only need the aggregations, which makes the request much faster.

## 16.2 Metric aggregations

```http
GET learn_products/_search
{
  "size": 0,
  "aggs": {
    "avg_price":       { "avg": { "field": "price" } },
    "cheapest":        { "min": { "field": "price" } },
    "most_expensive":  { "max": { "field": "price" } },
    "units_in_stock":  { "sum": { "field": "stock" } },
    "products_priced": { "value_count": { "field": "price" } },
    "brand_count":     { "cardinality": { "field": "brand" } }
  }
}
```

→ `avg_price` 99.14, `cheapest` 6.99, `most_expensive` 349, `units_in_stock` 1,318, `products_priced` 20, `brand_count` 18 (20 products, but Logitech and Decathlon each have two).

| Aggregation | Returns | SQL |
|---|---|---|
| `avg` | Average | `AVG(price)` |
| `sum` | Sum | `SUM(stock)` |
| `min`, `max` | Smallest, largest | `MIN()`, `MAX()` |
| `value_count` | Number of values (not documents) | `COUNT(price)` |
| `cardinality` | Approximate number of **distinct** values | `COUNT(DISTINCT brand)` |
| `stats` | count, min, max, avg and sum in one | |
| `extended_stats` | `stats` plus variance and standard deviation | `STDDEV()` |
| `percentiles` | Values below which X% of documents fall | `PERCENTILE_CONT()` |
| `percentile_ranks` | The percentile of given values | |
| `top_hits` | The top documents of each bucket | `ROW_NUMBER() OVER (...)` |
| `weighted_avg` | Average weighted by another field | |

```http
GET learn_products/_search
{
  "size": 0,
  "aggs": {
    "price_stats":       { "stats": { "field": "price" } },
    "price_percentiles": { "percentiles": { "field": "price", "percents": [25, 50, 75, 95] } },
    "rating_weighted_by_reviews": {
      "weighted_avg": {
        "value":  { "field": "rating" },
        "weight": { "field": "reviews" }
      }
    }
  }
}
```

→ `price_stats`: count 20, min 6.99, max 349, avg 99.14, sum 1,982.77. Percentiles: 25% of products cost under 34.49, the median (50th percentile) is about 52, 75% cost under 104.50 and 95% under 324. The rating average weighted by reviews (4.60) is higher than the plain average rating (4.51), because the most reviewed products are also highly rated.

> **Note:** `cardinality` and `percentiles` are **approximate**: they use probabilistic algorithms (HyperLogLog++ and t-digest) that use little memory. They are exact for small numbers; `cardinality` is exact below `precision_threshold` (default 3000).

## 16.3 `terms` — group by a field (GROUP BY)

```http
GET learn_products/_search
{
  "size": 0,
  "aggs": {
    "by_category": {
      "terms": { "field": "category" }
    }
  }
}
```

Response:

```json
"aggregations": {
  "by_category": {
    "doc_count_error_upper_bound": 0,
    "sum_other_doc_count": 0,
    "buckets": [
      { "key": "electronics", "doc_count": 8 },
      { "key": "kitchen",     "doc_count": 5 },
      { "key": "sports",      "doc_count": 4 },
      { "key": "books",       "doc_count": 3 }
    ]
  }
}
```

SQL equivalent: `SELECT category, COUNT(*) FROM learn_products GROUP BY category ORDER BY COUNT(*) DESC LIMIT 10`.

| Option | Meaning |
|---|---|
| `size` | How many buckets to return (default **10**). Values outside the top `size` are counted in `sum_other_doc_count` |
| `order` | `{ "_count": "desc" }` (default), `{ "_key": "asc" }` (alphabetical), or by a sub-aggregation: `{ "avg_price": "desc" }` |
| `min_doc_count` | Hide buckets with fewer documents (default 1; `0` also shows values with no matches) |
| `missing` | Put documents without the field into a bucket with this key |
| `include`, `exclude` | Only some values: an array or a regular expression |
| `shard_size` | How many candidates each shard returns (more = more accurate, slower) |

```http
# Tags, alphabetically, including a bucket for products without a color
GET learn_products/_search
{
  "size": 0,
  "aggs": {
    "tags_a_to_z": {
      "terms": { "field": "tags", "size": 50, "order": { "_key": "asc" } }
    },
    "colors": {
      "terms": { "field": "color", "missing": "(none)" }
    }
  }
}
```

→ `colors` includes `{ "key": "(none)", "doc_count": 3 }` for the three books.

> **Accuracy with several shards:** each shard returns its own top `shard_size` values, and the results are merged, so counts can be slightly off for values that are near the cut-off on some shards. `doc_count_error_upper_bound` shows the maximum possible error. With one shard (as here) the counts are exact.

## 16.4 Sub-aggregations — metrics per group

Put aggregations inside a bucket aggregation to calculate them **per bucket**:

```http
# Per category: number of products, average price, total stock, best-rated product
GET learn_products/_search
{
  "size": 0,
  "aggs": {
    "by_category": {
      "terms": { "field": "category", "order": { "avg_price": "desc" } },
      "aggs": {
        "avg_price":   { "avg": { "field": "price" } },
        "total_stock": { "sum": { "field": "stock" } },
        "best_rated": {
          "top_hits": {
            "size": 1,
            "sort": [ { "rating": "desc" } ],
            "_source": ["name", "rating"]
          }
        }
      }
    }
  }
}
```

→ Ordered by average price: sports (avg 125.75, total stock 153), electronics (122.86, 495), kitchen (75.88, 605) and books (39.16, 65). Each bucket includes its best-rated product: P019 Adjustable Dumbbells for sports, P005 Noise Cancelling Headphones for electronics, P012 Chef Knife for kitchen, and P015 Designing Data-Intensive Applications for books.

SQL equivalent:

```sql
SELECT category, COUNT(*), AVG(price) AS avg_price, SUM(stock)
FROM learn_products GROUP BY category ORDER BY avg_price DESC;
```

### Grouping by two fields

Nest one `terms` inside another, like `GROUP BY category, brand`:

```http
GET learn_products/_search
{
  "size": 0,
  "aggs": {
    "by_category": {
      "terms": { "field": "category" },
      "aggs": {
        "by_brand": { "terms": { "field": "brand" } }
      }
    }
  }
}
```

Or use `multi_terms` to get flat combined keys:

```http
GET learn_products/_search
{
  "size": 0,
  "aggs": {
    "category_and_stock": {
      "multi_terms": {
        "terms": [ { "field": "category" }, { "field": "inStock" } ]
      }
    }
  }
}
```

→ Keys like `["electronics", true]` (`key_as_string`: `"electronics|true"`) with `doc_count` 7, and `["electronics", false]` with 1.

## 16.5 Range aggregations

```http
GET learn_products/_search
{
  "size": 0,
  "aggs": {
    "price_bands": {
      "range": {
        "field": "price",
        "ranges": [
          { "key": "budget",  "to": 25 },
          { "key": "mid",     "from": 25, "to": 100 },
          { "key": "premium", "from": 100 }
        ]
      }
    }
  }
}
```

→ budget 3, mid 12, premium 5. `from` is **inclusive** and `to` is **exclusive**: a product costing exactly 25 belongs to "mid".

`date_range` does the same for dates, with date math:

```http
GET learn_products/_search
{
  "size": 0,
  "aggs": {
    "launch_periods": {
      "date_range": {
        "field": "createdAt",
        "format": "yyyy-MM-dd",
        "ranges": [
          { "key": "H1 2026", "from": "2026-01-01", "to": "2026-07-01" },
          { "key": "H2 2026", "from": "2026-07-01", "to": "2027-01-01" }
        ]
      }
    }
  }
}
```

→ H1 2026: 12 products, H2 2026: 8 products.

## 16.6 Histograms

### `histogram` — fixed numeric intervals

```http
GET learn_products/_search
{
  "size": 0,
  "aggs": {
    "price_histogram": {
      "histogram": { "field": "price", "interval": 50, "min_doc_count": 0 }
    }
  }
}
```

→ Buckets 0–50 (10 products), 50–100 (5), 100–150 (1), 150–200 (0), 200–250 (1), 250–300 (2) and 300–350 (1). Each bucket's `key` is its lower bound. `min_doc_count: 0` keeps the empty 150–200 bucket, which is what a bar chart needs.

### `date_histogram` — per day, week, month, ...

```http
GET learn_products/_search
{
  "size": 0,
  "aggs": {
    "per_month": {
      "date_histogram": {
        "field": "createdAt",
        "calendar_interval": "month",
        "format": "yyyy-MM",
        "time_zone": "Asia/Kolkata",
        "min_doc_count": 0
      },
      "aggs": {
        "avg_price": { "avg": { "field": "price" } }
      }
    }
  }
}
```

→ 10 buckets, one per month from 2026-01 to 2026-10, each with 2 products and their average price (for example 2026-08: 234.50, from the monitor and the running shoes).

| Option | Values |
|---|---|
| `calendar_interval` | `minute`, `hour`, `day`, `week`, `month`, `quarter`, `year` (calendar-aware: months have different lengths) |
| `fixed_interval` | `30m`, `12h`, `7d`, ... (always the same length) |
| `time_zone` | Bucket boundaries in local time, e.g. `"Asia/Kolkata"` or `"+05:30"` |
| `format` | Format of `key_as_string` |
| `extended_bounds` | Force buckets to cover a range, e.g. the whole year, even without data |
| `min_doc_count` | `0` to include empty buckets |

> **Known bug in OpenSearch 2.19.1:** a top-level `range` aggregation placed **before** a `date_histogram` in the same request can fail with `array_index_out_of_bounds_exception`. Put the `date_histogram` first, or set the cluster setting `search.max_aggregation_rewrite_filters` to `0`. The NestJS `/products/stats` endpoint hit this bug; it now lists `date_histogram` first.

## 16.7 `filter` and `filters` — buckets defined by queries

```http
GET learn_products/_search
{
  "size": 0,
  "aggs": {
    "out_of_stock": {
      "filter": { "term": { "inStock": false } },
      "aggs": { "lost_value": { "sum": { "field": "price" } } }
    },
    "segments": {
      "filters": {
        "filters": {
          "bestsellers": { "term":  { "tags": "bestseller" } },
          "top_rated":   { "range": { "rating": { "gte": 4.7 } } },
          "cheap":       { "range": { "price": { "lt": 20 } } }
        }
      }
    }
  }
}
```

→ `out_of_stock`: 3 products with a combined price of 139.48. `segments`: bestsellers 2, top_rated 5, cheap 3. A document can be in several `filters` buckets.

`missing` counts documents without a field:

```http
GET learn_products/_search
{
  "size": 0,
  "aggs": { "no_color": { "missing": { "field": "color" } } }
}
```

→ `doc_count`: 3

## 16.8 Aggregations and the query: scope

Aggregations see the documents matched by `query`. Three tools change that:

| Tool | Effect |
|---|---|
| `query` | Narrows both hits and aggregations |
| `post_filter` | Narrows only the hits (chapter 11.4) |
| `global` aggregation | Ignores the query: aggregates over **all** documents in the index |
| `filter` aggregation | Narrows one aggregation further |

```http
# Electronics only, but also show the average price of ALL products for comparison
GET learn_products/_search
{
  "size": 0,
  "query": { "term": { "category": "electronics" } },
  "aggs": {
    "electronics_avg": { "avg": { "field": "price" } },
    "all_products": {
      "global": {},
      "aggs": { "overall_avg": { "avg": { "field": "price" } } }
    }
  }
}
```

→ `hits.total` is 8 (the electronics), `electronics_avg` is 122.86, and `all_products.overall_avg` is 99.14 (`doc_count` 20).

## 16.9 Pipeline aggregations

Pipeline aggregations work on the **output** of other aggregations. They refer to them with `buckets_path`.

```http
GET learn_products/_search
{
  "size": 0,
  "aggs": {
    "per_month": {
      "date_histogram": { "field": "createdAt", "calendar_interval": "month", "format": "yyyy-MM" },
      "aggs": {
        "units":            { "sum": { "field": "stock" } },
        "running_total":    { "cumulative_sum": { "buckets_path": "units" } },
        "change_vs_before": { "derivative": { "buckets_path": "units" } }
      }
    },
    "best_month":     { "max_bucket": { "buckets_path": "per_month>units" } },
    "avg_per_month":  { "avg_bucket": { "buckets_path": "per_month>units" } }
  }
}
```

| Pipeline | Calculates |
|---|---|
| `cumulative_sum` | Running total across buckets |
| `derivative` | Difference from the previous bucket |
| `moving_fn` | Moving average and other window functions |
| `max_bucket`, `min_bucket`, `avg_bucket`, `sum_bucket`, `stats_bucket` | Over all buckets of another aggregation |
| `bucket_script` | A formula per bucket, e.g. revenue ÷ orders |
| `bucket_selector` | Keep only buckets matching a condition (like SQL `HAVING`) |
| `bucket_sort` | Sort and paginate buckets |

`buckets_path` syntax: `agg>sub_agg` to go down a level, and `_count` for the bucket's document count.

### HAVING: `bucket_selector`

```http
# Brands with at least 2 products (HAVING COUNT(*) >= 2)
GET learn_products/_search
{
  "size": 0,
  "aggs": {
    "by_brand": {
      "terms": { "field": "brand", "size": 50 },
      "aggs": {
        "having_2_or_more": {
          "bucket_selector": {
            "buckets_path": { "count": "_count" },
            "script": "params.count >= 2"
          }
        }
      }
    }
  }
}
```

→ Only `Logitech` (2) and `Decathlon` (2).

### Calculated metrics: `bucket_script`

```http
# Per category: stock value = sum(price × stock), and its share of out-of-stock products
GET learn_products/_search
{
  "size": 0,
  "aggs": {
    "by_category": {
      "terms": { "field": "category" },
      "aggs": {
        "stock_value":  { "sum": { "script": { "source": "doc['price'].value * doc['stock'].value" } } },
        "out_of_stock": { "filter": { "term": { "inStock": false } } },
        "out_of_stock_pct": {
          "bucket_script": {
            "buckets_path": { "oos": "out_of_stock._count", "total": "_count" },
            "script": "params.oos * 100.0 / params.total"
          }
        }
      }
    }
  }
}
```

→ books: one of three is out of stock, so `out_of_stock_pct` is 33.3.

## 16.10 Paging through all groups: `composite`

`terms` returns only the top N buckets. To go through **every** group (for example to export all brand × category combinations), use `composite` and page with `after`:

```http
GET learn_products/_search
{
  "size": 0,
  "aggs": {
    "all_combinations": {
      "composite": {
        "size": 5,
        "sources": [
          { "category": { "terms": { "field": "category" } } },
          { "brand":    { "terms": { "field": "brand" } } }
        ]
      }
    }
  }
}
```

The first page holds the 3 book brands plus electronics/Anker and electronics/Dell, and the response contains `"after_key": { "category": "electronics", "brand": "Dell" }`. Pass it as `after` to get the next page:

```http
GET learn_products/_search
{
  "size": 0,
  "aggs": {
    "all_combinations": {
      "composite": {
        "size": 5,
        "sources": [
          { "category": { "terms": { "field": "category" } } },
          { "brand":    { "terms": { "field": "brand" } } }
        ],
        "after": { "category": "electronics", "brand": "Dell" }
      }
    }
  }
}
```

→ electronics/JBL, electronics/Keychron, electronics/Logitech (2), electronics/Razer and electronics/Sony. Continue until a page has fewer than `size` buckets.

## 16.11 Scripts in aggregations

Any metric aggregation can use a script instead of a field:

```http
GET learn_products/_search
{
  "size": 0,
  "aggs": {
    "inventory_value": {
      "sum": {
        "script": {
          "source": "doc['price'].size() == 0 || doc['stock'].size() == 0 ? 0 : doc['price'].value * doc['stock'].value"
        }
      }
    }
  }
}
```

→ 44,960.23 (the value of all stock: price × quantity).

Always check `doc['field'].size() == 0` before reading `.value`. A document without the field makes `doc['field'].value` throw an error and fails the whole request. This is a real bug the NestJS `/products/stats` endpoint had with older documents that had no `stock`.

## 16.12 Aggregations that need specific field types

| Aggregation | Works on |
|---|---|
| `terms`, `cardinality`, `composite`, `multi_terms` | `keyword`, numbers, `boolean`, `ip`, dates. **Not `text`** (use the `.keyword` sub-field) |
| `avg`, `sum`, `min`, `max`, `stats`, `percentiles`, `histogram`, `range` | Numbers (and dates for min/max/range) |
| `date_histogram`, `date_range` | `date` |
| `geo_distance`, `geo_bounds`, `geohash_grid` | `geo_point` |

The error *"Text fields are not optimised for operations that require per-document field data like aggregations and sorting"* means you used a `text` field: use `field.keyword`, or fix the mapping (chapter 3.7).

## 16.13 Recipes

| Question | Aggregation |
|---|---|
| How many products per category? | `terms` on `category` |
| Average price per brand, most expensive first | `terms` on `brand` + `avg`, ordered by the avg |
| Products launched per month | `date_histogram` (`calendar_interval: month`) |
| Price distribution for a bar chart | `histogram` (`interval`, `min_doc_count: 0`) |
| Distinct customers | `cardinality` |
| Best product in each category | `terms` + `top_hits` (`size: 1`, sorted) |
| Categories with more than N products | `terms` + `bucket_selector` |
| Running total per month | `date_histogram` + `sum` + `cumulative_sum` |
| Export every group | `composite` with `after` |
| Facet counts in a search page | `terms`/`range` + `post_filter` (chapter 11) |
