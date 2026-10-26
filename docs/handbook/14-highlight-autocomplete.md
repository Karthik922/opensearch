# Chapter 14 — Highlighting, Autocomplete and "Did You Mean"

## 14.1 Highlighting — show why a result matched

Highlighting returns snippets of the matching fields with the matched words wrapped in tags, ready to display in bold.

```http
GET learn_products/_search
{
  "query": { "match": { "description": "wireless battery" } },
  "_source": ["name"],
  "highlight": {
    "fields": {
      "description": {}
    }
  }
}
```

→ For P001: `"highlight": { "description": ["Compact <em>wireless</em> mouse with a silent click and 18 month <em>battery</em> life."] }`

Notice that "battery" matched although the english analyzer stores it as `batteri`: the highlighter marks the **original** words.

### Options

```http
GET learn_products/_search
{
  "query": {
    "multi_match": { "query": "wireless", "fields": ["name", "description"] }
  },
  "_source": ["name"],
  "highlight": {
    "pre_tags":  ["<mark>"],
    "post_tags": ["</mark>"],
    "fields": {
      "name":        { "number_of_fragments": 0 },
      "description": { "fragment_size": 40, "number_of_fragments": 2 }
    }
  }
}
```

| Option | Meaning |
|---|---|
| `pre_tags`, `post_tags` | Tags around each match (default `<em>` and `</em>`) |
| `fragment_size` | Approximate length of each snippet in characters (default 100) |
| `number_of_fragments` | Maximum snippets per field (default 5); `0` returns the **whole field** highlighted (good for short fields like names) |
| `require_field_match` | `false` highlights the words in fields that weren't searched |
| `no_match_size` | Return the first N characters even when there's nothing to highlight |
| `type` | `unified` (default and recommended), `plain`, `fvh` |
| `encoder: "html"` | Escape HTML in the source text first. **Use this when showing highlights in a web page**, so stored text can't inject HTML |

The highlight is returned **next to** `_source`. Your UI shows the highlight if one exists, otherwise the plain field.

## 14.2 Autocomplete — three approaches

Autocomplete runs on every keystroke, so it must be fast and must match **incomplete words** ("wir" → "Wireless Mouse").

| Approach | How | Strengths | Weaknesses |
|---|---|---|---|
| `search_as_you_type` field + `bool_prefix` query | Special field type with prefix and shingle sub-fields | Easy, matches words in any position, typo tolerance possible, combines with filters | Slightly bigger index |
| Edge n-gram analyzer | Custom analyzer (chapter 5.7) | Full control | More setup |
| Completion suggester | `completion` field, in-memory prefix structure | Fastest; supports weights | Prefix of the **beginning** only; no filters except "contexts"; separate data to maintain |

## 14.3 `search_as_you_type` (recommended)

`learn_products` maps `name.autocomplete` as `search_as_you_type`. OpenSearch creates hidden sub-fields for it automatically:

| Sub-field | Contains |
|---|---|
| `name.autocomplete` | The words |
| `name.autocomplete._2gram` | Pairs of neighbouring words ("wireless mouse") |
| `name.autocomplete._3gram` | Triples of neighbouring words |
| `name.autocomplete._index_prefix` | Edge n-grams of the words, used for prefix matching |

Query it with `multi_match` of type `bool_prefix` across these fields:

```http
GET learn_products/_search
{
  "size": 5,
  "_source": ["name"],
  "query": {
    "multi_match": {
      "query": "wir",
      "type": "bool_prefix",
      "fields": [
        "name.autocomplete",
        "name.autocomplete._2gram",
        "name.autocomplete._3gram"
      ]
    }
  }
}
```

→ P001 Wireless Mouse, P002 Wireless Keyboard.

Each keystroke sends the whole input so far. More words narrow the results:

```http
GET learn_products/_search
{
  "size": 5,
  "_source": ["name"],
  "query": {
    "multi_match": {
      "query": "wireless k",
      "type": "bool_prefix",
      "fields": ["name.autocomplete", "name.autocomplete._2gram", "name.autocomplete._3gram"]
    }
  }
}
```

→ **P002** Wireless Keyboard first: it matches "wireless" followed by a word starting with "k", so the `_2gram` field scores it highest. P001 Wireless Mouse ("wireless"), P003 Mechanical Keyboard and P012 Chef Knife ("k" as a word prefix) follow with lower scores.

Words in the middle of the name also match ("key" finds "Mechanical Keyboard"). Autocomplete combines naturally with filters:

```http
GET learn_products/_search
{
  "size": 5,
  "_source": ["name", "price"],
  "query": {
    "bool": {
      "must": {
        "multi_match": {
          "query": "key",
          "type": "bool_prefix",
          "fields": ["name.autocomplete", "name.autocomplete._2gram", "name.autocomplete._3gram"]
        }
      },
      "filter": [ { "term": { "inStock": true } } ]
    }
  }
}
```

→ P002 Wireless Keyboard and P003 Mechanical Keyboard.

The NestJS endpoint `GET /products/suggest?q=...` uses exactly this query (chapter 19).

## 14.4 The completion suggester

The completion suggester keeps an in-memory structure (an FST) for very fast prefix lookups. It needs a field of type `completion`, filled with the inputs to suggest:

```http
PUT suggest_demo
{
  "mappings": {
    "properties": {
      "suggest": { "type": "completion" },
      "name":    { "type": "keyword" }
    }
  }
}

POST suggest_demo/_bulk?refresh=true
{ "index": { "_id": "1" } }
{ "name": "Wireless Mouse", "suggest": { "input": ["Wireless Mouse", "Mouse"], "weight": 15 } }
{ "index": { "_id": "2" } }
{ "name": "Wireless Keyboard", "suggest": { "input": ["Wireless Keyboard", "Keyboard"], "weight": 8 } }
{ "index": { "_id": "3" } }
{ "name": "Mechanical Keyboard", "suggest": { "input": ["Mechanical Keyboard", "Keyboard"], "weight": 21 } }

POST suggest_demo/_search
{
  "_source": ["name"],
  "suggest": {
    "product_suggest": {
      "prefix": "key",
      "completion": { "field": "suggest", "size": 5 }
    }
  }
}
```

→ Two options, ordered by weight. Each has `"text": "Keyboard"` (the input that matched) and the document's `_source`: first **Mechanical Keyboard** (`_score` 21), then **Wireless Keyboard** (8). The suggestions are under `suggest.product_suggest[0].options`, not under `hits`. Show `_source.name` to the user, not `text`.

Add `"skip_duplicates": true` to drop options with the same `text`. Here it keeps only one "Keyboard" option (the Mechanical Keyboard, weight 21), which is useful when you suggest **search terms** rather than products.

Typo tolerance:

```http
POST suggest_demo/_search
{
  "suggest": {
    "fuzzy_suggest": {
      "prefix": "wirel",
      "completion": { "field": "suggest", "fuzzy": { "fuzziness": 1 } }
    }
  }
}
```

To suggest a word in the middle (like "Keyboard" above), you must add it as an extra `input`. The completion suggester only matches the **start** of each input.

## 14.5 "Did you mean?" — term and phrase suggesters

When a search returns few or no results, suggest a corrected spelling built from the words in your index.

### Term suggester: corrects each word separately

```http
GET learn_products/_search
{
  "size": 0,
  "suggest": {
    "spellcheck": {
      "text": "wireles keybord",
      "term": { "field": "name" }
    }
  }
}
```

→ For "wireles": `wireless`; for "keybord": `keyboard`. Each word gets its own list of options with a score and a frequency (`freq`, the number of documents containing the word).

### Phrase suggester: corrects the whole phrase

```http
GET learn_products/_search
{
  "size": 0,
  "suggest": {
    "did_you_mean": {
      "text": "wireles keybord",
      "phrase": {
        "field": "name",
        "max_errors": 2,
        "confidence": 0,
        "highlight": { "pre_tag": "<b>", "post_tag": "</b>" },
        "collate": {
          "query": { "source": { "match": { "name": { "query": "{{suggestion}}", "operator": "and" } } } },
          "prune": true
        }
      }
    }
  }
}
```

→ The first option is `"wireless keyboard"`, with `"highlighted": "<b>wireless keyboard</b>"` (the corrected words are marked) and `"collate_match": true`. Partial corrections such as "wireles keyboard" follow with `"collate_match": false`, because they would find nothing.

| Option | Meaning |
|---|---|
| `max_errors` | How many words may be corrected (here both) |
| `confidence` | `0` returns suggestions even when the input looks fine |
| `collate` | Run a query for each suggestion and keep only suggestions that would actually find results (`prune: true` keeps them all but marks `collate_match`) |

A typical UI flow: run the search; if it returns 0 hits, show "Did you mean *wireless keyboard*?" from the phrase suggester, or run the corrected search automatically.

## 14.6 Clean up

```http
DELETE suggest_demo
```
