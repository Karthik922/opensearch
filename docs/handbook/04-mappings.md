# Chapter 4 — Mappings and Field Types

A **mapping** defines the fields of an index and how each one is stored and searched. It's the equivalent of `CREATE TABLE` in SQL, but it matters even more: **the field type decides which queries work on that field.**

```http
GET learn_products/_mapping
```

## 4.1 The most important decision: `text` vs `keyword`

| | `text` | `keyword` |
|---|---|---|
| Stored as | Individual words (terms) after **analysis**: split and lower-cased | The **exact value**, unchanged |
| "Wireless Mouse" becomes | `wireless`, `mouse` | `Wireless Mouse` |
| Use for | Free text people search in: names, descriptions, comments | IDs, codes, statuses, categories, tags, emails, URLs |
| Full-text search (`match`) | ✅ Yes | Only matches the whole exact value |
| Exact filter (`term`) | ⚠️ Matches single lower-cased words only | ✅ Yes (case-sensitive) |
| Sorting | ❌ No | ✅ Yes |
| Aggregations (`GROUP BY`) | ❌ No | ✅ Yes |

See the difference yourself. `name` is `text`; `name.keyword` is a `keyword` copy of it:

```http
# text field: matches the single word "mouse" (2 hits: P001, P004)
GET learn_products/_search
{ "query": { "match": { "name": "MOUSE" } } }

# keyword field: only the complete, exact value matches (1 hit: P001)
GET learn_products/_search
{ "query": { "term": { "name.keyword": "Wireless Mouse" } } }

# keyword field: a partial or differently-cased value does NOT match (0 hits)
GET learn_products/_search
{ "query": { "term": { "name.keyword": "wireless mouse" } } }
```

## 4.2 Multi-fields: one value, several types

Often you need both behaviours from the same value: search the product name by words **and** sort by it alphabetically. A **multi-field** indexes one JSON value in several ways:

```json
"name": {
  "type": "text",
  "fields": {
    "keyword":      { "type": "keyword" },
    "autocomplete": { "type": "search_as_you_type" }
  }
}
```

The document contains only `name`. OpenSearch indexes it three ways:

| Field to use in queries | Type | Used for |
|---|---|---|
| `name` | text | Full-text search |
| `name.keyword` | keyword | Sorting, aggregations, exact match |
| `name.autocomplete` | search_as_you_type | Autocomplete while typing (chapter 14) |

## 4.3 All common field types

| Type | Stores | Example values | Notes |
|---|---|---|---|
| `text` | Analyzed full text | `"Slim wireless keyboard"` | Searchable by words; not sortable |
| `keyword` | Exact string | `"electronics"`, `"P001"` | Filters, sorting, aggregations. `ignore_above: 256` skips very long values |
| `long` | 64-bit integer | `1520` | |
| `integer` | 32-bit integer | `25` | Up to about 2.1 billion |
| `short`, `byte` | Small integers | | Save space |
| `double` | 64-bit floating point | `4.567` | |
| `float` | 32-bit floating point | `4.5` | About 7 significant digits; `19.99` may come back as `19.989999771` in aggregations |
| `half_float` | 16-bit floating point | | Low precision |
| `scaled_float` | Decimal stored as an integer × `scaling_factor` | `19.99` with factor 100 → stored as 1999 | **Best for prices and money** |
| `boolean` | true / false | `true`, `"false"` | |
| `date` | Date or date-time | `"2026-01-15"`, `"2026-01-15T10:30:00Z"`, `1768435200000` (epoch ms) | Stored internally as UTC epoch milliseconds |
| `date_nanos` | Date with nanosecond precision | | For high-resolution events |
| `object` | A JSON object | `{ "city": "Chennai", "zip": "600001" }` | The default for nested JSON. Arrays of objects are flattened (chapter 15) |
| `nested` | Array of objects kept separate | `[{ "sku": "A", "qty": 1 }, ...]` | Needs `nested` queries (chapter 15) |
| `flattened` | Whole object as keywords | Arbitrary user-defined attributes | Avoids "mapping explosion" with unknown keys |
| `ip` | IPv4/IPv6 address | `"192.168.1.10"` | Supports CIDR queries: `"192.168.0.0/16"` |
| `geo_point` | Latitude/longitude | `{ "lat": 13.08, "lon": 80.27 }` | Distance queries and sorting (chapter 15) |
| `geo_shape` | Polygons, lines | | Areas, delivery zones |
| `completion` | Prefix suggestions | | The completion suggester (chapter 14) |
| `search_as_you_type` | Text optimised for prefix search | | Autocomplete (chapter 14) |
| `join` | Parent/child relation | | Chapter 15 |
| `binary` | Base64 data | | Stored, not searchable |
| `knn_vector` | Numeric vector | `[0.12, -0.5, ...]` | Vector / semantic search (k-NN plugin) |

**Arrays.** There is no special array type. Any field can hold one value or an array of values of the same type: `"tags": ["computer", "wireless"]` is simply a `keyword` field with two values. A query for `tags: wireless` matches the document if **any** value matches.

**Null and missing values.** A field that is `null`, `[]` or absent isn't indexed. Queries treat it as "missing" (see the `exists` query in chapter 9).

## 4.4 Dynamic mapping — what happens with unknown fields

When a document contains a field that isn't in the mapping, the `dynamic` setting decides what happens:

| `dynamic` | Behaviour |
|---|---|
| `true` (default) | The field is **added to the mapping automatically**, with a guessed type |
| `false` | The field is stored in `_source` but **not indexed**: you can't search it |
| `strict` | The document is **rejected** with an error |

The type guesses for `dynamic: true`:

| JSON value | Guessed type |
|---|---|
| `"hello"` | `text` with a `.keyword` sub-field (`ignore_above: 256`) |
| `"2026-01-15"` (a string that looks like a date) | `date` |
| `42` | `long` |
| `4.5` | `float` |
| `true` | `boolean` |
| `{ ... }` | `object` |

See it happen:

```http
PUT dyn_demo/_doc/1
{ "title": "Hello", "views": 42, "price": 9.5, "published": "2026-01-15", "active": true }

GET dyn_demo/_mapping
```

`title` became `text` + `title.keyword`, `views` became `long`, `price` became `float`, and `published` became `date`.

The danger: the **first document decides the type forever**. If the first `zip` value is `600001` (a number), `zip` becomes `long`, and a later document with `"zip": "SW1A 1AA"` fails. A typo creates a new field, and too many unique keys (for example user-defined attributes) create a huge mapping ("mapping explosion").

Our `learn_products` index uses `"dynamic": "strict"`, so mistakes are caught immediately:

```http
# expected error: "colour" is not in the mapping (strict_dynamic_mapping_exception)
PUT learn_products/_doc/TEST
{ "sku": "TEST", "name": "Test", "colour": "red" }
```

> **Best practice:** define your mapping explicitly before indexing data. Use `dynamic: strict` for indices your application owns, so typos and unexpected fields fail loudly.

## 4.5 Dynamic templates — rules for new fields

If you must accept unknown fields, **dynamic templates** control how they are mapped. For example, make every new string field a `keyword` instead of `text` + `keyword`:

```http
PUT dyn_template_demo
{
  "mappings": {
    "dynamic_templates": [
      {
        "strings_as_keywords": {
          "match_mapping_type": "string",
          "mapping": { "type": "keyword" }
        }
      },
      {
        "prices_as_scaled_float": {
          "match": "*_price",
          "mapping": { "type": "scaled_float", "scaling_factor": 100 }
        }
      }
    ]
  }
}

PUT dyn_template_demo/_doc/1
{ "color": "red", "size": "XL", "sale_price": 19.99 }

GET dyn_template_demo/_mapping
```

`color` and `size` are `keyword`, and `sale_price` is `scaled_float`.

## 4.6 Adding fields to an existing mapping

You **can add** new fields at any time:

```http
PUT learn_products/_mapping
{
  "properties": {
    "warrantyMonths": { "type": "integer" }
  }
}
```

You **can add** a new multi-field to an existing field, but documents indexed before the change won't have it. Re-index them in place with an empty update-by-query:

```text
PUT products/_mapping
{ "properties": { "name": { "type": "text", "fields": { "autocomplete": { "type": "search_as_you_type" } } } } }

POST products/_update_by_query?conflicts=proceed&refresh=true
```

The NestJS app in this project does exactly this on startup, in `addMissingAutocompleteField()` (chapter 18).

You **cannot**:
- change a field's type (`text` → `keyword`, `long` → `keyword`, ...)
- remove a field
- change the analyzer of an existing field

For those, create a new index and reindex (chapter 3.7).

## 4.7 Mapping parameters you should know

| Parameter | Example | Effect |
|---|---|---|
| `index` | `"index": false` | The field is stored in `_source` but not searchable. Saves space for display-only data |
| `doc_values` | `"doc_values": false` | Disables sorting and aggregations on the field. Saves disk for fields you never sort or aggregate on |
| `null_value` | `"null_value": "N/A"` | Index `null` as this value so it can be searched |
| `ignore_above` | `"ignore_above": 256` | Don't index `keyword` values longer than this |
| `copy_to` | `"copy_to": "all_text"` | Also copy the value into another field, for example to search several fields as one |
| `analyzer` | `"analyzer": "english"` | Which analyzer to use for a `text` field (chapter 5) |
| `search_analyzer` | | A different analyzer for the query text |
| `normalizer` | `"normalizer": "lowercase_normalizer"` | Lower-case `keyword` values, for case-insensitive filters (chapter 5) |
| `format` | `"format": "yyyy-MM-dd HH:mm:ss"` | Accepted date formats for a `date` field |
| `coerce` | `"coerce": false` | Reject `"42"` (a string) in a numeric field instead of converting it |
| `enabled` | `"enabled": false` | For `object` fields: store the JSON but don't parse or index it at all |

Example: a field that combines brand and name into one searchable field with `copy_to`:

```http
PUT copy_to_demo
{
  "mappings": {
    "properties": {
      "brand":    { "type": "text", "copy_to": "all_text" },
      "name":     { "type": "text", "copy_to": "all_text" },
      "all_text": { "type": "text" }
    }
  }
}

PUT copy_to_demo/_doc/1?refresh=true
{ "brand": "Logitech", "name": "Wireless Mouse" }

GET copy_to_demo/_search
{ "query": { "match": { "all_text": { "query": "logitech mouse", "operator": "and" } } } }
```

→ 1 hit. Neither `brand` nor `name` alone contains both words, but `all_text` does.

## 4.8 Dates in detail

A `date` field accepts strings in the formats listed in its `format` parameter. The default is `strict_date_optional_time||epoch_millis`, which accepts:

| Value | Meaning |
|---|---|
| `"2026-01-15"` | Date only (midnight UTC) |
| `"2026-01-15T10:30:00Z"` | Date and time in UTC |
| `"2026-01-15T16:00:00+05:30"` | Date and time with a time-zone offset (converted to UTC) |
| `1768473000000` | Milliseconds since 1970-01-01 UTC |

Custom formats:

```http
PUT date_demo
{
  "mappings": {
    "properties": {
      "orderedAt": { "type": "date", "format": "yyyy-MM-dd HH:mm:ss||yyyy-MM-dd||epoch_millis" }
    }
  }
}

PUT date_demo/_doc/1
{ "orderedAt": "2026-10-24 18:45:00" }
```

> **Note:** Dates are always stored in UTC. When you query or aggregate by day, pass `"time_zone": "+05:30"` (or `"Asia/Kolkata"`) so that "today" means today in your time zone (chapters 9 and 16).

## 4.9 Money: why `scaled_float`

Binary floating-point types can't represent most decimals exactly. A `float` stores `19.99` as `19.9899997711`, and sums show long tails such as `603.9599914550781`. `scaled_float` with `"scaling_factor": 100` stores 19.99 as the whole number 1999, so sums and filters on cents are exact. Alternatively, store amounts in cents as a `long`.

## 4.10 Clean up

```http
DELETE dyn_demo
DELETE dyn_template_demo
DELETE copy_to_demo
DELETE date_demo
```
