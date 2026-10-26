# Chapter 8 — Full-Text Queries

Full-text queries search **`text` fields**. They analyze your query text with the field's analyzer (chapter 5), look up the resulting terms, and score the matches by relevance. Use them for anything a human types into a search box.

## 8.1 `match` — the standard full-text query

```http
GET learn_products/_search
{
  "query": {
    "match": { "name": "coffee maker" }
  }
}
```

The text "coffee maker" is analyzed into `coffee` and `maker`. By default, a document matches if it contains **any** of the terms (OR), and documents that contain more of them score higher.

→ **P010** French Press Coffee Maker (both words) first, then **P011** Ceramic Coffee Mug (one word).

### `operator`: require all words

```http
GET learn_products/_search
{
  "query": {
    "match": {
      "name": { "query": "coffee maker", "operator": "and" }
    }
  }
}
```

→ Only **P010**. With `"operator": "and"`, every term must be present.

### `minimum_should_match`: something in between

With a long query, requiring all words is too strict and requiring any word is too loose. `minimum_should_match` sets how many terms must match:

```http
GET learn_products/_search
{
  "query": {
    "match": {
      "description": {
        "query": "wireless keyboard with quiet keys and numeric keypad",
        "minimum_should_match": "75%"
      }
    }
  }
}
```

→ Only **P002**, whose description contains almost all the words. Values can be a number (`2`), a percentage (`"75%"`), or negative (`"-1"` = all but one).

### `fuzziness`: tolerate typos

```http
GET learn_products/_search
{
  "query": {
    "match": {
      "name": { "query": "keybord wireles", "fuzziness": "AUTO" }
    }
  }
}
```

→ **P002** Wireless Keyboard first (both misspelled words match), then **P001** Wireless Mouse and **P003** Mechanical Keyboard (one word each).

Fuzziness is the number of single-character edits (insert, delete, replace, swap two neighbouring letters) allowed per word. `"AUTO"` is the recommended setting:

| Word length | Allowed edits with `AUTO` |
|---|---|
| 1–2 characters | 0 (must be exact) |
| 3–5 characters | 1 |
| 6 or more characters | 2 |

Related options: `prefix_length` (number of leading characters that must be exact, which makes the query faster; for example `1`), and `max_expansions` (how many similar terms to consider, default 50).

### `zero_terms_query`

If the analyzer removes every word (for example the english analyzer and the query "the"), the match query normally returns nothing. `"zero_terms_query": "all"` returns everything instead.

## 8.2 `match_phrase` — words in order

```http
GET learn_products/_search
{
  "query": {
    "match_phrase": { "description": "noise cancelling" }
  }
}
```

→ **P005**. The words must appear **next to each other, in this order**.

`slop` allows words in between, or in a different order:

```http
GET learn_products/_search
{
  "query": {
    "match_phrase": {
      "description": { "query": "wireless keyboard keys", "slop": 3 }
    }
  }
}
```

→ **P002** ("Slim wireless keyboard with quiet keys"). There are two extra words between "keyboard" and "keys", which is within a slop of 3.

## 8.3 `match_phrase_prefix` and `match_bool_prefix` — the last word is incomplete

For simple autocomplete, the last term is treated as a prefix:

```http
GET learn_products/_search
{
  "query": {
    "match_phrase_prefix": { "name": "wireless key" }
  }
}
```

→ **P002** Wireless Keyboard. "wireless" must be followed by a word starting with "key".

```http
GET learn_products/_search
{
  "query": {
    "match_bool_prefix": { "name": "wireless key" }
  }
}
```

→ **P002** Wireless Keyboard (matches both), then **P001** Wireless Mouse ("wireless") and **P003** Mechanical Keyboard ("key" as the start of "keyboard"). `match_bool_prefix` ignores word order: every term except the last must match exactly, the last one is a prefix, and they are combined with OR (use `"operator": "and"` to require all). Chapter 14 shows better autocomplete with `search_as_you_type`.

## 8.4 `multi_match` — one query across several fields

```http
GET learn_products/_search
{
  "query": {
    "multi_match": {
      "query": "wireless audio",
      "fields": ["name^3", "description", "tags^2"]
    }
  }
}
```

`^3` is a **boost**: a match in `name` counts three times as much as a match in `description`. Field names can use wildcards (`"name*"`).

The `type` parameter decides how the per-field scores are combined:

| `type` | How it scores | Use for |
|---|---|---|
| `best_fields` (default) | The score of the **best single field** (plus a little from the others via `tie_breaker`) | Words that should appear together in one field: a product name |
| `most_fields` | The **sum** of all field scores | The same text indexed in several ways (`name`, `name.stemmed`) |
| `cross_fields` | Treats the fields as **one big field**: each word may be in a different field | People's names (first + last), brand + model: "logitech mouse" |
| `phrase` | `match_phrase` on each field | Exact phrases |
| `phrase_prefix` | `match_phrase_prefix` on each field | Simple autocomplete |
| `bool_prefix` | `match_bool_prefix` on each field | Autocomplete with `search_as_you_type` (chapter 14) |

Example where `cross_fields` matters. In P008, "monitor" appears only in the `name` ("27-inch 4K Monitor"), and "adjustable" appears only in the `description` ("... an adjustable stand"):

```http
# best_fields + operator "and": 0 hits, because no SINGLE field contains both words
GET learn_products/_search
{
  "query": {
    "multi_match": {
      "query": "monitor adjustable",
      "type": "best_fields",
      "fields": ["name", "description"],
      "operator": "and",
      "analyzer": "english"
    }
  }
}

# cross_fields + operator "and": P008, because each word is in at least one field
GET learn_products/_search
{
  "query": {
    "multi_match": {
      "query": "monitor adjustable",
      "type": "cross_fields",
      "fields": ["name", "description"],
      "operator": "and",
      "analyzer": "english"
    }
  }
}
```

Why `"analyzer": "english"`? `cross_fields` only blends fields that use the **same analyzer**. Here `name` uses `standard` and `description` uses `english`, so without a common analyzer they are searched separately and the second request also returns 0 hits. Forcing one analyzer puts both fields in one group.

> **Note:** don't mix `keyword` fields into `cross_fields`. A keyword field treats the **whole query** as one value. You can see this with `_validate/query?explain=true`: the query "logitech keyboard" on `["name", "brand"]` becomes `brand:logitech keyboard | (+name:logitech +name:keyboard)`, and the brand part only matches a brand literally called "logitech keyboard". To search brand and name together, index the brand as `text` too (a multi-field), or use `copy_to` (chapter 4.7).

## 8.5 `simple_query_string` — search syntax for users

`simple_query_string` lets users write simple operators in the search box. It **never throws an error** on invalid syntax, so it's safe to pass user input directly:

| Syntax | Meaning |
|---|---|
| `+` | AND |
| `\|` | OR |
| `-` | NOT |
| `"..."` | Phrase |
| `*` at the end of a word | Prefix |
| `( )` | Grouping |
| `~N` after a word | Fuzziness |

```http
GET learn_products/_search
{
  "query": {
    "simple_query_string": {
      "query": "coffee -mug",
      "fields": ["name", "description"],
      "default_operator": "and"
    }
  }
}
```

→ Only **P010** French Press Coffee Maker. P011 Ceramic Coffee Mug contains "coffee" but is excluded by `-mug`. P009 Espresso Machine doesn't match, because the word "coffee" appears in neither its name nor its description (only in its `tags`, which aren't searched here).

> **Note:** `default_operator` matters. With the default (`or`), "coffee -mug" means "coffee OR NOT mug", which matches almost everything.

```http
GET learn_products/_search
{
  "query": {
    "simple_query_string": {
      "query": "\"wireless mouse\" | headphon*",
      "fields": ["name"]
    }
  }
}
```

→ P001 Wireless Mouse (phrase) and P005 Noise Cancelling Headphones (prefix).

## 8.6 `query_string` — the full Lucene syntax (for experts)

`query_string` supports the complete syntax: `field:value`, `AND` / `OR` / `NOT`, ranges `[10 TO 50]`, wildcards `?` and `*`, regular expressions `/.../`, fuzziness `~`, boosts `^`.

```http
GET learn_products/_search
{
  "query": {
    "query_string": {
      "query": "(category:books OR category:kitchen) AND price:[30 TO 50] AND NOT name:pan"
    }
  }
}
```

→ 3 hits: **P014** Clean Code (32.99), **P015** Designing Data-Intensive Applications (44.50) and **P016** The Pragmatic Programmer (39.99). From the kitchen, only P013 Non-stick Frying Pan (39.50) is in the price range, and `NOT name:pan` excludes it.

> **Warning:** `query_string` throws an error on invalid syntax (for example an unclosed quote or bracket). Never pass user input to it directly; use `simple_query_string` or `match` for search boxes.

## 8.7 Which full-text query should I use?

| Situation | Query |
|---|---|
| A normal search box | `multi_match` (`best_fields`) over the important fields with boosts, `fuzziness: AUTO` |
| All words must be present | `match` / `multi_match` with `operator: and` or `minimum_should_match` |
| Exact phrase | `match_phrase` (with `slop` if needed) |
| Words spread across fields (brand + model, first + last name) | `multi_match` `cross_fields` |
| Users type `+`, `-`, quotes | `simple_query_string` |
| Admin or power-user search with field names | `query_string` (validate first) |
| Autocomplete while typing | `search_as_you_type` + `multi_match` `bool_prefix` (chapter 14) |
