# Chapter 1 — What OpenSearch Is and How It Works

## 1.1 What is OpenSearch?

OpenSearch is an open-source **search and analytics engine**. You send it JSON documents. It indexes every field so that you can:

- **search text** the way Google does: by relevance, with typo tolerance and synonyms
- **filter** millions of records by exact values, numbers and dates in milliseconds
- **aggregate**: count, sum, average and group data, like SQL `GROUP BY`
- **autocomplete** while the user types

You talk to OpenSearch over **HTTP with JSON**. There is no special driver protocol: every operation is a REST request such as `GET /products/_search`. Client libraries (like the Node.js client used by NestJS) are thin wrappers around these HTTP calls.

OpenSearch started in 2021 as a fork of Elasticsearch 7.10 and is maintained by the OpenSearch Software Foundation (Linux Foundation). Its query language is almost identical to Elasticsearch's, so most Elasticsearch tutorials also apply.

## 1.2 When to use it — and when not to

| Use OpenSearch for | Don't use OpenSearch for |
|---|---|
| Search boxes on websites and apps | The main source of truth for business data |
| Product catalogs with filters and facets | Money transfers and anything needing transactions |
| Log and event analytics, dashboards | Data with many JOINs and strict constraints |
| Autocomplete and "did you mean" | Small datasets where `ILIKE` in SQL is enough |
| Full-text search across documents | Frequent single-field updates on the same record (each update rewrites the document) |

The common architecture is: **PostgreSQL (or MySQL, MongoDB) is the source of truth, and OpenSearch holds a search-optimised copy.** The application writes to the database and copies the data into OpenSearch. Search screens read from OpenSearch.

## 1.3 The vocabulary

| OpenSearch term | Meaning | SQL equivalent |
|---|---|---|
| **Cluster** | One or more servers working together, identified by a name | Database server |
| **Node** | One running OpenSearch process (one server) | — |
| **Index** | A named collection of documents with the same structure | Table |
| **Document** | One JSON object stored in an index | Row |
| **Field** | A key in the JSON document | Column |
| **`_id`** | The unique identifier of a document within its index | Primary key |
| **Mapping** | The definition of the fields and their types | Table schema (`CREATE TABLE`) |
| **Shard** | A piece of an index. An index is split into one or more shards that can live on different nodes | Partition |
| **Replica** | A copy of a shard on another node, for safety and read speed | Read replica |
| **Query DSL** | The JSON language used to search | `SELECT ... WHERE` |
| **Aggregation** | A calculation over matching documents | `GROUP BY`, `COUNT`, `SUM`, `AVG` |
| **Analyzer** | The process that turns text into searchable words | — |

> **Note:** Older tutorials mention "types" (for example `/index/type/id`). Types were removed. Today every document lives directly in an index, and the endpoint is always `/index/_doc/id`.

## 1.4 What a document looks like

A document is plain JSON:

```json
{
  "sku": "P001",
  "name": "Wireless Mouse",
  "brand": "Logitech",
  "category": "electronics",
  "tags": ["computer", "accessories", "wireless"],
  "price": 19.99,
  "inStock": true,
  "createdAt": "2026-01-15"
}
```

OpenSearch stores this JSON unchanged in a special field called **`_source`**, and returns it when you search. Separately, it builds search structures for each field.

## 1.5 The inverted index — why search is fast

A SQL database searching for the word "wireless" in a description column has to scan every row (`LIKE '%wireless%'` cannot use a normal index). OpenSearch avoids that with an **inverted index**: a list of every word, and the documents that contain it. It works like the index at the back of a book.

Take three product names:

| `_id` | name |
|---|---|
| P001 | Wireless Mouse |
| P002 | Wireless Keyboard |
| P004 | Gaming Mouse |

OpenSearch splits the names into words, lower-cases them, and builds:

| Term | Documents |
|---|---|
| gaming | P004 |
| keyboard | P002 |
| mouse | P001, P004 |
| wireless | P001, P002 |

A search for "wireless mouse" looks up two entries (`wireless` → P001, P002; `mouse` → P001, P004) and combines them. P001 contains both words, so it gets the highest score. This lookup takes about the same time whether you have a thousand documents or a hundred million.

The process of turning text into terms is called **analysis** (chapter 5). It is the reason why `text` fields and `keyword` fields behave so differently (chapter 4).

## 1.6 Relevance scoring

When you search text, each matching document gets a **score** (`_score`). The results are sorted by score, highest first. OpenSearch uses the **BM25** formula, which rewards:

- **Term frequency:** the word appears often in this document's field.
- **Inverse document frequency:** the word is rare across all documents. Rare words like "espresso" count more than common words like "the".
- **Field length:** the match is in a short field. A match in a 2-word name counts more than a match in a 200-word description.

You can boost fields (`name^3`), combine queries and use functions to change the score (chapter 10).

## 1.7 Shards and replicas

An index is divided into **primary shards**. Each shard is a complete, self-contained search engine (a Lucene index) holding part of the documents. When you search, OpenSearch asks every shard in parallel and merges the results.

- You choose the number of primary shards **when you create the index**. You cannot simply change it later.
- **Replica shards** are copies of the primaries on *other* nodes. If a node dies, a replica takes over. Replicas also serve searches, which spreads the load.
- A good shard size is between 10 and 50 GB. Small indices (under a few GB) need only **1 shard**.

The practice cluster in this guide has one node, so all indices use `"number_of_shards": 1` and `"number_of_replicas": 0`.

## 1.8 Cluster health: green, yellow, red

| Colour | Meaning |
|---|---|
| **Green** | All primary and replica shards are working. |
| **Yellow** | All primary shards work, but some replicas are not assigned. All data is available. This is **normal on a single-node cluster** with replicas set to 1 or more, because a replica is never placed on the same node as its primary. |
| **Red** | At least one primary shard is not available. Some data cannot be searched. Investigate immediately. |

## 1.9 Near real-time search

A new document is **not searchable instantly**. OpenSearch collects new documents in memory and makes them searchable at the next **refresh**, which happens every **1 second** by default. That's why OpenSearch is called *near real-time*.

- Reading one document by ID (`GET index/_doc/id`) always sees the latest version, even before a refresh.
- Searching sees the document only after the next refresh.
- When writing, you can add `?refresh=wait_for` so the request waits until the document is searchable. The NestJS API in this project does this, so search results reflect a write immediately after the API call returns.

## 1.10 How a write is stored (simplified)

1. The document arrives and is checked against the mapping.
2. It is written to an in-memory buffer and to the **translog** (transaction log) on disk, so it survives a crash.
3. A **refresh** (every 1 s) turns the buffer into a new, searchable **segment**.
4. A **flush** writes segments to disk permanently and clears the translog.
5. In the background, small segments are **merged** into larger ones.

Segments are never changed once written. An "update" therefore **writes a new version** of the document and marks the old version as deleted. The space is reclaimed later, during merges. That is why updating the same document many times per second is expensive.

## 1.11 OpenSearch Dashboards

**OpenSearch Dashboards** is the web interface for OpenSearch, started at http://localhost:5601 in this project. Its most important tool for learning is **Dev Tools**, a console where you type and run requests. Chapter 2 explains how to use it.
