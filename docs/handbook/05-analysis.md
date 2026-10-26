# Chapter 5 — Text Analysis: How Text Becomes Searchable

**Analysis** is the process that turns a `text` value into the list of **terms** stored in the inverted index. The same process runs on the text of a `match` query, so that the query terms and the stored terms line up.

Understanding analysis explains almost every "why doesn't my search match?" question.

## 5.1 The analyzer pipeline

An **analyzer** has three stages:

| Stage | What it does | Examples |
|---|---|---|
| 1. **Character filters** (0 or more) | Change the raw text before splitting | Strip HTML tags, replace `&` with `and` |
| 2. **Tokenizer** (exactly 1) | Split the text into tokens | Split on whitespace and punctuation |
| 3. **Token filters** (0 or more) | Change, remove or add tokens | Lower-case, remove stop words, stem (`running` → `run`), synonyms |

```text
"<b>Running</b> Shoes & Socks"
   │ char filter: html_strip
   ▼
"Running Shoes & Socks"
   │ tokenizer: standard
   ▼
[Running] [Shoes] [Socks]
   │ token filters: lowercase, stemmer
   ▼
[run] [shoe] [sock]          ← these terms go into the inverted index
```

## 5.2 See it with the `_analyze` API

`_analyze` shows exactly which terms an analyzer produces. It's the most useful debugging tool for search problems.

```http
# The standard analyzer (the default for text fields)
POST _analyze
{
  "analyzer": "standard",
  "text": "The Wireless-Mouse's battery lasts 18 MONTHS!"
}
```

→ `the`, `wireless`, `mouse's`, `battery`, `lasts`, `18`, `months`

The standard analyzer splits on spaces and punctuation and lower-cases. It does **not** remove "the" and does **not** reduce words to their root.

```http
# The english analyzer: also removes stop words and stems
POST _analyze
{
  "analyzer": "english",
  "text": "The Wireless-Mouse's battery lasts 18 MONTHS!"
}
```

→ `wireless`, `mous`, `batteri`, `last`, `18`, `month`

The stems (`mous`, `batteri`) look odd, but they're never shown to users. What matters is that "battery" and "batteries", or "month" and "months", produce the **same** term, so they match each other.

You can also analyze with the analyzer of a specific field in an index:

```http
POST learn_products/_analyze
{
  "field": "description",
  "text": "runs running runner"
}
```

→ `run`, `run`, `runner`. The `description` field uses the `english` analyzer (see the mapping in chapter 2).

## 5.3 Why analysis matters: an example

`description` uses the english analyzer. P017's description says "road **running** and daily **runs**". Search for "run":

```http
GET learn_products/_search
{ "query": { "match": { "description": "run" } } }
```

→ **P017 Running Shoes**. Its description never contains the exact word "run", but stemming made `running` and `runs` both become `run`.

`name` uses the standard analyzer, so the same search on `name` finds nothing:

```http
GET learn_products/_search
{ "query": { "match": { "name": "run" } } }
```

→ 0 hits. The stored term is `running`, not `run`.

> **Rule:** the query text is analyzed with the **same analyzer as the field** (unless you set a `search_analyzer`). If a match fails, run `_analyze` on both the stored text and the query text and compare the terms.

## 5.4 Built-in analyzers

| Analyzer | What it does | "The QUICK brown-foxes" becomes |
|---|---|---|
| `standard` | Splits on word boundaries, lower-cases | `the`, `quick`, `brown`, `foxes` |
| `simple` | Splits on non-letters, lower-cases | `the`, `quick`, `brown`, `foxes` |
| `whitespace` | Splits on whitespace only, keeps case | `The`, `QUICK`, `brown-foxes` |
| `stop` | Like simple, removes English stop words | `quick`, `brown`, `foxes` |
| `keyword` | No splitting: the whole input is one term | `The QUICK brown-foxes` |
| `english` (and 30+ other languages) | Standard + stop words + stemming for that language | `quick`, `brown`, `fox` |
| `pattern` | Splits on a regular expression | depends on the pattern |

## 5.5 Building a custom analyzer

Custom analyzers are defined in the index **settings**, then used in the mapping. This example builds a product-search analyzer that:

- strips HTML (`html_strip`)
- folds accents, so `café` matches `cafe` (`asciifolding`)
- treats synonyms as equal (`laptop` = `notebook`, `tv` = `television`)
- stems English words

```http
PUT analysis_demo
{
  "settings": {
    "analysis": {
      "filter": {
        "product_synonyms": {
          "type": "synonym",
          "synonyms": [
            "laptop, notebook",
            "tv, television",
            "phone, mobile, smartphone"
          ]
        },
        "english_stemmer": { "type": "stemmer", "language": "english" }
      },
      "analyzer": {
        "product_text": {
          "type": "custom",
          "char_filter": ["html_strip"],
          "tokenizer": "standard",
          "filter": ["lowercase", "asciifolding", "product_synonyms", "english_stemmer"]
        }
      }
    }
  },
  "mappings": {
    "properties": {
      "title": { "type": "text", "analyzer": "product_text" }
    }
  }
}

POST analysis_demo/_analyze
{
  "analyzer": "product_text",
  "text": "<p>Café Notebook Stands</p>"
}
```

→ `cafe`, `notebook`, `laptop`, `stand`. The HTML is gone, the accent is removed, the synonym `laptop` is added at the same position, and "Stands" is stemmed.

```http
PUT analysis_demo/_doc/1?refresh=true
{ "title": "Aluminium notebook stand" }

GET analysis_demo/_search
{ "query": { "match": { "title": "laptop stands" } } }
```

→ 1 hit. The document says "notebook stand" and the user typed "laptop stands".

> **Note:** You can't change the analyzer of an existing field. Synonym lists can be updated without reindexing if they are applied only at search time (`search_analyzer` with `"updateable": true` on the synonym filter), which is an advanced topic.

## 5.6 Normalizers: case-insensitive `keyword` fields

`keyword` fields are case-sensitive: a filter for `brand: "logitech"` doesn't match "Logitech". A **normalizer** is a simple analyzer for keyword fields. It can't split text, but it can lower-case it and fold accents:

```http
PUT normalizer_demo
{
  "settings": {
    "analysis": {
      "normalizer": {
        "lowercase_normalizer": { "type": "custom", "filter": ["lowercase", "asciifolding"] }
      }
    }
  },
  "mappings": {
    "properties": {
      "brand": { "type": "keyword", "normalizer": "lowercase_normalizer" }
    }
  }
}

PUT normalizer_demo/_doc/1?refresh=true
{ "brand": "Logitech" }

GET normalizer_demo/_search
{ "query": { "term": { "brand": "LOGITECH" } } }
```

→ 1 hit. Both the stored value and the query value are lower-cased. The `_source` still shows "Logitech", but aggregations return the normalized value `logitech`.

An alternative without a normalizer: the `term` query has a `case_insensitive` option (chapter 9).

## 5.7 Edge n-grams: matching word beginnings

An **edge n-gram** filter stores every prefix of each word. "Mouse" becomes `m`, `mo`, `mou`, `mous`, `mouse`. A search for "mou" then matches directly. This is the classic way to build autocomplete:

```http
PUT edge_ngram_demo
{
  "settings": {
    "analysis": {
      "filter": {
        "prefixes": { "type": "edge_ngram", "min_gram": 2, "max_gram": 15 }
      },
      "analyzer": {
        "prefix_index":  { "tokenizer": "standard", "filter": ["lowercase", "prefixes"] },
        "prefix_search": { "tokenizer": "standard", "filter": ["lowercase"] }
      }
    }
  },
  "mappings": {
    "properties": {
      "name": { "type": "text", "analyzer": "prefix_index", "search_analyzer": "prefix_search" }
    }
  }
}

POST edge_ngram_demo/_analyze
{ "analyzer": "prefix_index", "text": "Mouse" }
```

→ `mo`, `mou`, `mous`, `mouse`

Notice `search_analyzer`: the stored text is split into prefixes, but the **query** isn't. Otherwise a search for "mouse" would also be cut into `mo`, `mou` and so on, and would match "money" and "mountain". In practice, the `search_as_you_type` field type (chapter 14) does this for you.

## 5.8 Summary

| Problem | Solution |
|---|---|
| "running" should match "run" | `english` analyzer (stemming) |
| "laptop" should match "notebook" | `synonym` token filter |
| "cafe" should match "café" | `asciifolding` token filter |
| HTML tags in text | `html_strip` char filter |
| Case-insensitive exact filter | `normalizer` with `lowercase` |
| Match while typing ("mou" → "Mouse") | `search_as_you_type`, or `edge_ngram` + a separate `search_analyzer` |
| A search doesn't match and you don't know why | `_analyze` the document text and the query text, then compare the terms |

## 5.9 Clean up

```http
DELETE analysis_demo
DELETE normalizer_demo
DELETE edge_ngram_demo
```
