# Chapter 21 — Performance and Troubleshooting

## 21.1 Search performance

| Do | Why |
|---|---|
| Put non-scoring conditions in `filter` | Cached and no scoring (chapter 7.2) |
| Return only needed fields (`_source` filtering) | Less data to read, serialize and send |
| Use `size: 0` when you only need aggregations | Skips fetching documents |
| Keep `size` and pagination depth small; use `search_after` for deep pages | Deep `from` is expensive on every shard (chapter 12) |
| Avoid leading wildcards and `regexp` on large fields | They scan every term |
| Avoid scripts in hot queries | Run per document; precompute values at index time instead |
| Use `keyword` for exact matches; `text` only for full-text | The right data structure for each query |
| Round date math (`now/d`) | Makes filters cacheable |
| Set `track_total_hits` to a limit or `false` when exact totals aren't needed | Stops counting early |
| Design documents for the query: denormalize | No query-time joins |

### Finding slow queries

```http
# The profile API: time spent in each part of the query, per shard
GET learn_products/_search
{
  "profile": true,
  "query": { "match": { "description": "wireless" } }
}
```

```http
# Log searches slower than 500 ms for this index
PUT learn_products/_settings
{
  "index.search.slowlog.threshold.query.warn": "500ms",
  "index.search.slowlog.threshold.query.info": "200ms"
}
```

Slow queries then appear in the OpenSearch logs (`docker compose logs opensearch`). The **Query Insights** plugin (enabled by default in recent versions, and the reason for the `top_queries-*` indices in this cluster) records the most expensive queries:

```http
GET _insights/top_queries?type=latency
```

## 21.2 Indexing performance

| Do | Why |
|---|---|
| Use `_bulk` with 1,000–5,000 docs or 5–15 MB per request | Fewer round trips |
| Run a few bulk requests in parallel; back off on 429 | Uses the cluster fully without overloading it |
| During big imports: `refresh_interval: -1`, `number_of_replicas: 0`, then restore | No refresh or replication work while loading |
| Let OpenSearch generate IDs when you never update by ID | Skips the "does this ID exist?" check |
| Don't use `refresh=true` on every write | Each forced refresh creates a tiny segment |
| Avoid updating the same document many times per second | Every update writes a whole new document version |

## 21.3 Index and shard sizing

- Aim for **10–50 GB per shard**. Small indices need **1 primary shard**.
- Too many small shards waste memory: each shard costs heap. Keep it below about 20 shards per GB of heap.
- For time-based data (logs, events), use daily or monthly indices with an index template, and delete old indices instead of deleting documents. **Index State Management** (ISM) can automate rollover and deletion.

## 21.4 Common errors and fixes

| Error message (or symptom) | Cause | Fix |
|---|---|---|
| `index_not_found_exception` | Wrong index name, or the index wasn't created | Check `GET _cat/indices?v`. Index names are lowercase |
| Search returns documents you never created | `GET _search` without an index searches **all** indices | Put the index name first: `GET products/_search` |
| `Text fields are not optimised for operations that require per-document field data like aggregations and sorting` | Aggregating or sorting on a `text` field | Use the `.keyword` sub-field, or fix the mapping (`keyword`) and reindex |
| `term` query on a name returns nothing | `term` isn't analyzed; the field is `text` | Use `match`, or `term` on `name.keyword` |
| Query on a nested field returns 0 hits, no error | Missing `nested` wrapper | Wrap it in a `nested` query with `path` |
| `mapper_parsing_exception: failed to parse field [x] of type [long]` | A value doesn't fit the field type (e.g. text in a number field) | Fix the data, or fix the mapping and reindex |
| `strict_dynamic_mapping_exception` | A field not in the mapping, with `dynamic: strict` | Add the field to the mapping, or fix the typo |
| `illegal_argument_exception: mapper [x] cannot be changed from type [text] to [keyword]` | Changing an existing field type | Create a new index, `_reindex`, swap the alias |
| `Result window is too large, from + size must be less than or equal to: [10000]` | Deep pagination with `from` | `search_after` (chapter 12) |
| `version_conflict_engine_exception` (409) | `_create` on an existing ID, or a concurrent update | Expected for `_create`; for updates use `retry_on_conflict` or reload and retry |
| `es_rejected_execution_exception` / HTTP 429 | The cluster is overloaded (queues full) | Back off and retry; smaller or fewer parallel bulks |
| `search_phase_execution_exception` | A query failed on the shards | Read `root_cause[0].reason` and `failed_shards` for the real reason |
| `array_index_out_of_bounds_exception: Index 0 out of bounds for length -3` | OpenSearch 2.19.1 bug: a `range` aggregation before a `date_histogram` | Put `date_histogram` first, or set `search.max_aggregation_rewrite_filters: 0` (chapter 16.6) |
| `search_after` pages skip documents | OpenSearch 2.18/2.19 bug with `match_all` + sort on a `scaled_float` field | Add any filter to the query, or use `float`/`long` (chapter 12.3) |
| Script error `A document doesn't have a value for a field` | `doc['x'].value` on a document without `x` | Check `doc['x'].size() == 0` first |
| New document doesn't appear in search | Not refreshed yet (near real-time) | Wait ~1 s, or write with `refresh=wait_for` |
| Cluster health **yellow** | Replicas can't be assigned (single node) | Normal on one node; set `number_of_replicas: 0`, or add nodes |
| Cluster health **red** | A primary shard is missing | `GET _cluster/allocation/explain` tells you why |
| `circuit_breaking_exception` | A request needs too much heap (huge aggregations, large `size`) | Smaller requests, fewer buckets, more heap |
| `flood stage disk watermark exceeded` → index becomes read-only | Disk above ~95% | Free disk space, then `PUT index/_settings {"index.blocks.read_only_allow_delete": null}` |
| `max virtual memory areas vm.max_map_count [65530] is too low` | Linux kernel setting | `sudo sysctl -w vm.max_map_count=262144` |
| Container exits with code 137 | Out of memory | Give Docker more RAM, or lower the heap |
| `TLS handshake timeout` when pulling images | Docker can't reach Docker Hub | Restart Docker Desktop, check VPN, proxy and DNS |
| `EADDRINUSE` / port already allocated | Another program uses the port | Change the port (`API_PORT=3001`) |

## 21.5 Diagnostic commands

```http
# Overall health, then per index
GET _cluster/health
GET _cluster/health?level=indices

# Why is a shard unassigned?
GET _cluster/allocation/explain

# Node resources: heap, CPU, disk
GET _cat/nodes?v&h=name,heap.percent,ram.percent,cpu,load_1m,disk.used_percent

# Disk per node
GET _cat/allocation?v

# Thread pools: look for rejected requests
GET _cat/thread_pool/search,write?v&h=node_name,name,active,queue,rejected

# Running tasks (long reindex or update_by_query)
GET _tasks?actions=*reindex,*byquery&detailed

# Pending cluster changes
GET _cluster/pending_tasks
```
