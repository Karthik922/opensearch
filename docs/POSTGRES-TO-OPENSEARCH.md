# From PostgreSQL to OpenSearch — Relationships, Sync and Queries

This guide answers one question:

> *My data lives in PostgreSQL tables with foreign keys. How do I store the same data in OpenSearch, keep the relationships, get records back and search them?*

Everything here runs. The repo contains a real Postgres database with related tables, a script that copies the data into OpenSearch, and every query below has been run against that data.

Read [OPENSEARCH-GUIDE.md](OPENSEARCH-GUIDE.md) first if terms like *index*, *mapping*, `term` or `match` are new to you.

---

## Contents

1. [The big idea](#1-the-big-idea)
2. [Start the lab](#2-start-the-lab)
3. [The PostgreSQL side](#3-the-postgresql-side)
4. [Why you can't just copy the tables](#4-why-you-cant-just-copy-the-tables)
5. [Modelling relationships — the four techniques](#5-modelling-relationships--the-four-techniques)
6. [Technique 1 — Denormalize (copy related data in)](#6-technique-1--denormalize)
7. [Technique 2 — `nested` for one-to-many lists](#7-technique-2--nested-for-one-to-many-lists)
8. [Technique 3 — Parent/child with the `join` field](#8-technique-3--parentchild-with-the-join-field)
9. [Technique 4 — Application-side join](#9-technique-4--application-side-join)
10. [SQL vs OpenSearch side by side](#10-sql-vs-opensearch-side-by-side)
11. [Keeping OpenSearch in sync with Postgres](#11-keeping-opensearch-in-sync-with-postgres)
12. [Design checklist](#12-design-checklist)
13. [Exercises](#13-exercises)

---

## 1. The big idea

```
             writes (INSERT/UPDATE/DELETE)                    searches, filters, facets
  App ───────────────────────────────▶ PostgreSQL       App ◀────────────────────────── OpenSearch
                                         │ source of truth                                 ▲
                                         │                                                 │
                                         └──── sync (script / events / CDC) ───────────────┘
                                               JOINs are done HERE, once, at sync time
```

- **PostgreSQL stays the source of truth.** It handles transactions, foreign keys, constraints and JOINs.
- **OpenSearch is a search-optimised copy.** It handles full-text search, typo tolerance, relevance ranking, filters, facets and analytics over large data.
- OpenSearch **has no JOIN**. Postgres joins tables when you *read*. With OpenSearch you **join once, when you write**: you store documents that already contain the related data.

That last point is the whole mindset shift:

> **SQL:** store data once (normalized) and join at query time.
> **OpenSearch:** shape each document around the *questions you'll ask*, copy related data in, and never join at query time.

---

## 2. Start the lab

```bash
# 1. Start Postgres (schema + sample data load automatically on first start)
docker compose up -d postgres opensearch opensearch-dashboards

# 2. Copy Postgres → OpenSearch (creates the orders, customers and shop_join indices)
npm run sync:pg
```

```
orders:    8 documents
customers: 5 documents
shop_join: 13 documents (5 customers + 8 orders)
```

| | |
|---|---|
| Postgres | `localhost:5434`, database `shop`, user `shop`, password `shop` |
| Open a SQL shell | `docker exec -it shop-postgres psql -U shop -d shop` |
| OpenSearch Dev Tools | http://localhost:5601 → ☰ → Management → Dev Tools |

Files:

| File | What it does |
|---|---|
| `postgres/init/01-schema.sql` | Tables + foreign keys |
| `postgres/init/02-seed.sql` | Sample data |
| `scripts/sync-postgres-to-opensearch.js` | Runs JOIN queries in Postgres and bulk-loads the results into OpenSearch |

> The sync script **deletes and rebuilds** the three indices each time. That's fine for learning. Section 11 covers incremental sync.

---

## 3. The PostgreSQL side

```
 customers                 orders                    order_items                 products
┌──────────────┐ 1     N ┌──────────────┐ 1     N ┌──────────────────┐ N     1 ┌──────────────┐
│ id (PK)      │────────▶│ id (PK)      │────────▶│ order_id (FK)    │◀────────│ id (PK)      │
│ name         │         │ customer_id  │         │ product_id (FK)  │         │ name         │
│ email        │         │ status       │         │ quantity         │         │ category     │
│ city         │         │ created_at   │         │ unit_price       │         │ price        │
└──────────────┘         └──────────────┘         └──────────────────┘         └──────────────┘
```

Three kinds of relationship:

| Relationship | Example |
|---|---|
| **one-to-many** | a customer has many orders |
| **many-to-one** | each order belongs to one customer |
| **many-to-many** | orders ↔ products, through `order_items` |

To answer *"show order 1 with its customer and products"*, Postgres joins 4 tables:

```sql
SELECT c.name, o.id AS order_id, o.status, p.name AS product, oi.quantity
FROM customers c
JOIN orders o       ON o.customer_id = c.id
JOIN order_items oi ON oi.order_id = o.id
JOIN products p     ON p.id = oi.product_id
WHERE o.id = 1;
```

```
    name    | order_id |  status   |       product       | quantity
------------+----------+-----------+---------------------+----------
 Arun Kumar |        1 | delivered | Wireless Mouse      |        1
 Arun Kumar |        1 | delivered | Mechanical Keyboard |        5
```

Notice that the result repeats the customer on every row. That repetition is a hint of what the OpenSearch document will look like.

---

## 4. Why you can't just copy the tables

You *could* create four indices (`customers`, `orders`, `order_items`, `products`) with one document per row. Then try to answer:

> *"Find delivered orders from customers in Chennai that contain a Wireless Mouse."*

In Postgres that's one query with JOINs. In OpenSearch with four separate indices, you'd have to:
1. search `customers` for Chennai → get ids
2. search `products` for "Wireless Mouse" → get ids
3. search `order_items` for those product ids → get order ids
4. search `orders` for those order ids AND customer ids AND status

That's four round trips, with large id lists passed between them, and **relevance scoring and pagination break**, because no single query sees the whole picture. So we **reshape the data** instead.

---

## 5. Modelling relationships — the four techniques

| # | Technique | How | Best for | Cost |
|---|---|---|---|---|
| 1 | **Denormalize** | Copy the related row's fields into the document | many-to-one (order → customer), lookups (product name) | Data is duplicated, so you must update the copies when the source changes |
| 2 | **`nested`** | Store the child rows as an array of objects inside the parent document | one-to-many lists that are always loaded with the parent (order → items) | Reindexes the whole document when one child changes; needs `nested` queries |
| 3 | **`join` field (parent/child)** | Parent and child are separate documents in the *same* index, linked by id | one-to-many where children change often or are numerous (customer → thousands of orders) | Slower queries, needs routing, one join per index |
| 4 | **Application-side join** | Run two queries and combine the results in code | rare queries, small id lists | Two round trips; can't sort or score across both |

**Rule of thumb:** use **1 + 2** for about 90% of cases. Reach for 3 only when children are updated very often or there are huge numbers of them. Use 4 for occasional ad-hoc lookups.

The lab builds all of them from the same Postgres data:

| Index | Techniques | Document per |
|---|---|---|
| `orders` | 1 (customer copied in) + 2 (items nested, product data copied in) | order |
| `customers` | 1 (pre-computed order stats copied in) | customer |
| `shop_join` | 3 (customer = parent, order = child) | customer *and* order |

---

## 6. Technique 1 — Denormalize

### The Postgres query that builds the document

The sync script lets **Postgres do the JOINs** and return ready-made JSON, using `json_build_object` and `json_agg`:

```sql
SELECT o.id AS "orderId", o.status, o.created_at AS "createdAt",
       SUM(oi.quantity * oi.unit_price)::float8 AS total,
       json_build_object('id', c.id, 'name', c.name, 'email', c.email, 'city', c.city) AS customer,
       json_agg(json_build_object(
         'productId', p.id, 'name', p.name, 'category', p.category,
         'quantity', oi.quantity, 'unitPrice', oi.unit_price,
         'lineTotal', oi.quantity * oi.unit_price
       )) AS items
FROM orders o
JOIN customers   c  ON c.id = o.customer_id
JOIN order_items oi ON oi.order_id = o.id
JOIN products    p  ON p.id = oi.product_id
GROUP BY o.id, c.id;
```

### The resulting OpenSearch document

```
GET orders/_doc/1
```

```json
{
  "orderId": 1,
  "status": "delivered",
  "createdAt": "2026-06-01T10:15:00.000Z",
  "total": 417.49,
  "itemCount": 6,
  "customer": {                                     ← many-to-one: customer COPIED in
    "id": 1, "name": "Arun Kumar", "email": "arun@example.com", "city": "Chennai"
  },
  "items": [                                        ← one-to-many: order_items as an array
    { "productId": "p-1001", "name": "Wireless Mouse",      "category": "electronics",   ← many-to-many:
      "quantity": 1, "unitPrice": 19.99, "lineTotal": 19.99 },                             product fields
    { "productId": "p-1002", "name": "Mechanical Keyboard", "category": "electronics",     COPIED into
      "quantity": 5, "unitPrice": 79.5,  "lineTotal": 397.5 }                              each item
  ]
}
```

**Four tables became one document.** A single request returns everything needed to show the order. We keep `customer.id` and `items.productId` so we can still link back to Postgres.

### Querying copied (object) fields

Use dot notation, just like `table.column`:

```
# WHERE customer_id = 1
GET orders/_search
{ "query": { "term": { "customer.id": 1 } } }

# WHERE customers.name ILIKE '%arun%'   (full-text, typo tolerant)
GET orders/_search
{ "query": { "match": { "customer.name": "arun" } } }

# Revenue per city (no JOIN needed — the city is already on the order)
GET orders/_search
{
  "size": 0,
  "query": { "bool": { "must_not": { "term": { "status": "cancelled" } } } },
  "aggs": {
    "by_city": {
      "terms": { "field": "customer.city" },
      "aggs": { "revenue": { "sum": { "field": "total" } } }
    }
  }
}
```

→ Chennai: 3 orders, Coimbatore: 2, Bangalore: 1, Mumbai: 1 — each with its revenue.

### Pre-computing data (the `customers` index)

Denormalizing isn't only about copying fields. You can also **pre-compute answers** that would otherwise need `GROUP BY`:

```
GET customers/_doc/1
```

```json
{
  "customerId": 1, "name": "Arun Kumar", "email": "arun@example.com", "city": "Chennai",
  "orderCount": 2,
  "totalSpent": 494.98,
  "lastOrderAt": "2026-09-12T18:40:00.000Z",
  "productsBought": ["Clean Code", "Designing Data-Intensive Applications", "Mechanical Keyboard", "Wireless Mouse"]
}
```

```
# "Best customers with 2+ orders" — instant, no aggregation at query time
GET customers/_search
{ "query": { "range": { "orderCount": { "gte": 2 } } }, "sort": [ { "totalSpent": "desc" } ] }

# "Customers who ever bought a Mechanical Keyboard"
GET customers/_search
{ "query": { "term": { "productsBought": "Mechanical Keyboard" } } }
```

### The price of denormalizing

If Arun changes his name in Postgres, his name is now **stale in every order document**. Section 11 shows how to fix that with `_update_by_query`.

---

## 7. Technique 2 — `nested` for one-to-many lists

### The trap: arrays of objects get flattened

By default (`object` type), OpenSearch **flattens** an array of objects into separate arrays, one per field:

```
items: [ {productId: p-1001, quantity: 1}, {productId: p-1002, quantity: 5} ]

is stored as:

items.productId: [p-1001, p-1002]
items.quantity:  [1, 5]                ← the link between each id and its quantity is LOST
```

So the question *"orders with **5 or more Wireless Mice**"* matches order 1, which is **wrong**: order 1 has 1 mouse and 5 keyboards. Try it:

```
PUT demo_object
{ "mappings": { "properties": { "items": { "properties": {
    "productId": { "type": "keyword" }, "quantity": { "type": "integer" } } } } } }

PUT demo_object/_doc/1?refresh=true
{ "items": [ { "productId": "p-1001", "quantity": 1 }, { "productId": "p-1002", "quantity": 5 } ] }

GET demo_object/_search
{ "query": { "bool": { "filter": [
    { "term":  { "items.productId": "p-1001" } },
    { "range": { "items.quantity": { "gte": 5 } } } ] } } }
# → 1 hit  ❌ wrong!

DELETE demo_object
```

### The fix: `"type": "nested"`

With `nested`, each item is stored as its own hidden document, so the fields of one item stay together. The `orders` index maps `items` like this:

```json
"items": {
  "type": "nested",
  "properties": {
    "productId": { "type": "keyword" },
    "name":      { "type": "text", "fields": { "keyword": { "type": "keyword" } } },
    "category":  { "type": "keyword" },
    "quantity":  { "type": "integer" },
    "unitPrice": { "type": "float" },
    "lineTotal": { "type": "float" }
  }
}
```

Nested fields **must** be queried inside a `nested` query that names the `path`:

```
# Orders with 5+ Wireless Mice — conditions apply to the SAME item
GET orders/_search
{
  "query": {
    "nested": {
      "path": "items",
      "query": { "bool": { "filter": [
        { "term":  { "items.productId": "p-1001" } },
        { "range": { "items.quantity": { "gte": 5 } } }
      ] } }
    }
  }
}
# → 0 hits ✅ correct
```

> ⚠️ A plain `{"term": {"items.productId": "p-1001"}}` **without** the `nested` wrapper returns **0 hits** on a nested field. It doesn't throw an error, so this is a common bug.

### Which item matched? → `inner_hits`

```
GET orders/_search
{
  "_source": ["orderId", "customer.name"],
  "query": {
    "nested": {
      "path": "items",
      "query": { "term": { "items.productId": "p-1001" } },
      "inner_hits": {}
    }
  }
}
```

This returns orders 1, 3 and 6. Each one includes an `inner_hits` section showing *only* the matching line item (for example, quantity 2 in order 3).

### Mixing parent fields and nested fields

`nested` is just another clause, so it combines with normal fields in `bool`:

```
# Non-cancelled orders from Chennai customers that contain any electronics
GET orders/_search
{
  "query": {
    "bool": {
      "filter": [
        { "term": { "customer.city": "Chennai" } },
        { "nested": { "path": "items", "query": { "term": { "items.category": "electronics" } } } }
      ],
      "must_not": [ { "term": { "status": "cancelled" } } ]
    }
  }
}
# → orders 1 and 6
```

### Aggregating nested data: top-selling products

```
GET orders/_search
{
  "size": 0,
  "aggs": {
    "items": {
      "nested": { "path": "items" },                         // step into the nested docs
      "aggs": {
        "top_products": {
          "terms": { "field": "items.name.keyword", "size": 3, "order": { "units": "desc" } },
          "aggs": {
            "units":  { "sum": { "field": "items.quantity" } },
            "orders": { "reverse_nested": {} }               // step back out: count ORDERS, not items
          }
        }
      }
    }
  }
}
```

→ Mechanical Keyboard: 6 units in 2 orders, Wireless Mouse: 4 units in 3 orders, Ceramic Coffee Mug: 4 units in 1 order.

SQL equivalent:

```sql
SELECT p.name, SUM(oi.quantity) AS units, COUNT(DISTINCT oi.order_id) AS orders
FROM order_items oi JOIN products p ON p.id = oi.product_id
GROUP BY p.name ORDER BY units DESC LIMIT 3;
```

### When *not* to use nested
- If you never need "these two conditions on the **same** item", plain `object` is simpler and faster.
- If a parent has **thousands** of children, or children change often, every change rewrites the whole parent document. Use Technique 3 or a separate index instead. (By default, each document is limited to 10,000 nested objects.)

---

## 8. Technique 3 — Parent/child with the `join` field

Parents and children are **separate documents in the same index**, connected by a special `join` field. You can update an order without touching its customer, and the reverse.

### Mapping (`shop_join` index)

```json
"relation": { "type": "join", "relations": { "customer": "order" } }
```

### Indexing

```
# Parent
PUT shop_join/_doc/customer-1
{ "relation": "customer", "name": "Arun Kumar", "city": "Chennai" }

# Child — must name its parent AND use routing=<parent id>
PUT shop_join/_doc/order-1?routing=customer-1
{ "relation": { "name": "order", "parent": "customer-1" }, "status": "delivered", "total": 417.49 }
```

**Why routing?** Parent/child queries only work when a parent and all its children live on the **same shard**. `routing=customer-1` makes OpenSearch place the child on the parent's shard. The same routing value is needed to `GET`, update or delete the child:

```
GET shop_join/_doc/order-1?routing=customer-1
```

(The lab index has only 1 shard, so it happens to work without routing. On a real multi-shard index, it won't.)

### The three join queries

```
# has_child → find PARENTS by their children
# "Customers who have a cancelled order"
GET shop_join/_search
{ "query": { "has_child": { "type": "order", "query": { "term": { "status": "cancelled" } } } } }
# → Rahul Verma

# has_parent → find CHILDREN by their parent
# "Orders placed by customers in Chennai"
GET shop_join/_search
{ "query": { "has_parent": { "parent_type": "customer", "query": { "term": { "city": "Chennai" } } } } }
# → order-1, order-2, order-6

# parent_id → all children of one parent
# "All orders of customer 3"
GET shop_join/_search
{ "query": { "parent_id": { "type": "order", "id": "customer-3" } } }
# → order-4, order-5

# Parents + the matching children in one response (inner_hits)
# "Customers with an order of 300 or more, and show which order"
GET shop_join/_search
{ "query": { "has_child": { "type": "order", "query": { "range": { "total": { "gte": 300 } } }, "inner_hits": {} } } }
# → Arun Kumar (order-1), Priya Sharma (order-3)
```

### Trade-offs
- ✅ Update a child without rewriting the parent, and the reverse.
- ✅ Good for a few parents with very many, frequently changing children.
- ❌ Join queries are **several times slower** than nested or denormalized queries, and use more memory.
- ❌ Only one `join` field per index; parent and children must be on the same shard (routing).
- ❌ Can't sort parents by a child field.

The OpenSearch docs themselves advise using parent/child sparingly. **Denormalize first.**

---

## 9. Technique 4 — Application-side join

Keep separate indices and do two queries in code, like a manual `WHERE customer_id IN (SELECT ...)`:

```
# Step 1: ids of customers in Chennai
GET customers/_search
{ "_source": false, "query": { "term": { "city": "Chennai" } } }
# → ids 1 and 4

# Step 2: their orders
GET orders/_search
{ "query": { "terms": { "customer.id": [1, 4] } } }
# → orders 1, 2, 6
```

In NestJS:

```ts
const { body: c } = await client.search({ index: 'customers', body: { _source: false, query: { term: { city: 'Chennai' } } } });
const ids = c.hits.hits.map((h) => Number(h._id));
const { body: o } = await client.search({ index: 'orders', body: { query: { terms: { 'customer.id': ids } } } });
```

Fine when the id list is small (hundreds). Bad for large lists, and you can't rank or paginate across both indices as one result set.

---

## 10. SQL vs OpenSearch side by side

All of these run against the lab data.

| What you want | PostgreSQL | OpenSearch |
|---|---|---|
| One order with everything | 4-table JOIN (§3) | `GET orders/_doc/1` |
| Several orders by id | `WHERE id IN (1,3)` | `GET orders/_mget {"ids":["1","3"]}` |
| Orders of a customer | `WHERE customer_id = 1` | `{"term": {"customer.id": 1}}` |
| By customer name (fuzzy) | `WHERE c.name ILIKE '%arun%'` + JOIN | `{"match": {"customer.name": "arun"}}` |
| Status filter | `WHERE status IN ('paid','shipped')` | `{"terms": {"status": ["paid","shipped"]}}` |
| Date range | `WHERE created_at >= now() - interval '30 days'` | `{"range": {"createdAt": {"gte": "now-30d"}}}` |
| Orders containing a product | `WHERE EXISTS (SELECT 1 FROM order_items WHERE product_id='p-1001' ...)` | `{"nested": {"path":"items","query":{"term":{"items.productId":"p-1001"}}}}` |
| Item-level condition | `... oi.product_id='p-1001' AND oi.quantity>=5` | `nested` + `bool` (§7) |
| Count per status | `GROUP BY status` | `"aggs": {"s": {"terms": {"field": "status"}}}` |
| Revenue per city | JOIN + `GROUP BY c.city` | `terms` on `customer.city` + `sum` on `total` |
| Top products | JOIN + `GROUP BY` + `ORDER BY` | `nested` agg + `terms` + `sum` (§7) |
| Customers with a cancelled order | `WHERE EXISTS (...)` | `has_child` on `shop_join`, or `orders` + collapse (below) |
| Paging | `LIMIT 10 OFFSET 20` | `"from": 20, "size": 10` |
| Distinct customers in results | `SELECT DISTINCT customer_id` | `"collapse": {"field": "customer.id"}` |

Example of `collapse` (one hit per customer):

```
# Customers (one order each) who have a cancelled order, using only the orders index
GET orders/_search
{ "query": { "term": { "status": "cancelled" } }, "collapse": { "field": "customer.id" }, "_source": ["customer"] }
```

You can also use **SQL** on the denormalized index. Object fields use dot notation:

```
POST _plugins/_sql?format=csv
{ "query": "SELECT customer.city, COUNT(*) AS orders, SUM(total) AS revenue FROM orders GROUP BY customer.city" }
```

---

## 11. Keeping OpenSearch in sync with Postgres

### Initial load (what `npm run sync:pg` does)

1. Run the JOIN queries in Postgres (§6) → JSON rows.
2. Send them to OpenSearch in batches with `_bulk` (use batches of about 1,000–5,000 documents for big tables).
3. Use the Postgres primary key as the `_id`. Re-running then **overwrites** documents instead of duplicating them, so the load is *idempotent*.

### Ongoing changes — four strategies

| Strategy | How | Pros | Cons |
|---|---|---|---|
| **A. Dual write** | In your NestJS service, after the Postgres transaction commits, also write to OpenSearch | Simplest; near real-time | If the OpenSearch write fails, the copies drift apart. Needs retries and a periodic re-sync. |
| **B. Polling** | A cron job every N seconds: `SELECT ... WHERE updated_at > :lastSync` → bulk index | Simple; Postgres doesn't change | Misses hard deletes (use soft deletes or a deleted-rows table); delay = polling interval |
| **C. Outbox table** | In the *same* transaction as the change, insert a row into `outbox(entity, id)`. A worker reads the outbox, rebuilds those documents and indexes them. | Reliable, never loses an event, simple | Needs a worker and an extra table |
| **D. CDC** (Change Data Capture) | **Debezium** reads the Postgres WAL (write-ahead log) → Kafka → a consumer or **OpenSearch Data Prepper** indexes the changes | Captures every change including deletes; no app changes | Most infrastructure (Kafka, Connect) |

**Recommendation:** start with **A** or **B**, plus a nightly full re-sync as a safety net. Move to **C** when consistency matters, and to **D** at scale.

Dual write in NestJS (strategy A):

```ts
async updateOrderStatus(orderId: number, status: string) {
  await this.pg.query('UPDATE orders SET status = $1, updated_at = now() WHERE id = $2', [status, orderId]);
  // Re-read the full joined document and overwrite it in OpenSearch
  const { rows: [doc] } = await this.pg.query(ORDERS_SQL_FOR_ONE_ID, [orderId]);
  await this.os.index({ index: 'orders', id: String(orderId), body: doc, refresh: 'wait_for' });
}
```

### Updating denormalized copies

When **one** source row changes, work out **which documents contain a copy of it**:

| Change in Postgres | Documents to update in OpenSearch |
|---|---|
| `orders` row (e.g. status) | that one `orders` document, plus that customer's `customers` stats |
| `order_items` row | that order document (rebuild it), plus the customer stats |
| `customers` row (e.g. name, city) | that `customers` document **and every order of that customer** |
| `products` row (e.g. name) | every order that contains that product (only if old orders should show the new name) |

You can update many copies in one call with `_update_by_query`:

```
# Customer 1 renamed in Postgres → push the new name into all of their orders
POST orders/_update_by_query?refresh=true
{
  "query":  { "term": { "customer.id": 1 } },
  "script": {
    "source": "ctx._source.customer.name = params.name",
    "params": { "name": "Arun K. Kumar" }
  }
}
# → { "updated": 2 }
```

Or simply **rebuild the affected documents** from Postgres with the same JOIN query and `_bulk` them. That's often simpler and always correct.

> **Product price vs `unitPrice`.** We copied `unit_price` from `order_items` (the price *at purchase time*), not the current `products.price`. Old orders should *not* change when a product's price changes. Decide for each copied field whether it should follow the source or stay frozen.

### Deletes
- Hard delete in Postgres → `DELETE orders/_doc/<id>`, then rebuild the customer stats.
- With polling, prefer **soft deletes** (`deleted_at` column) so the poller can see them.

### Changing the mapping without downtime (aliases)

```
PUT orders_v2 { ...new mapping... }
# load orders_v2 from Postgres (or POST _reindex from orders_v1)
POST _aliases
{ "actions": [
  { "remove": { "index": "orders_v1", "alias": "orders" } },
  { "add":    { "index": "orders_v2", "alias": "orders" } }
] }
```

The app always queries the alias `orders`, and the swap is atomic.

### Consistency to expect
OpenSearch is **eventually consistent** with Postgres: there's a short delay between a commit and the change being searchable. For anything that must be exact (payments, stock checks before checkout), **read from Postgres**. Use OpenSearch for search and listing pages.

---

## 12. Design checklist

1. **Start from the queries, not the tables.** List the screens and searches: "search orders by customer name and product", "top products per month". One index per *main thing you search for* (orders, customers, products).
2. **Many-to-one → copy the fields you search, filter or display** (customer name and city into orders). Always keep the foreign key (`customer.id`) too.
3. **One-to-many, bounded and loaded together → `nested`** when you need conditions on the same child; plain `object` when you don't.
4. **One-to-many, huge or changing constantly → separate index** (with the parent id copied in), or `join` as a last resort.
5. **Pre-compute aggregates** you show often (`orderCount`, `totalSpent`).
6. **`_id` = the Postgres primary key**, so writes are idempotent and easy to update or delete.
7. **Types:** ids, statuses, emails, codes → `keyword`. Searchable text → `text` (+ `.keyword` for sorting). Money → `scaled_float` with `"scaling_factor": 100`, or integer cents, to avoid float rounding (notice the `603.9599914550781` revenue that `float` produced in the lab).
8. **Always define the mapping explicitly.** Don't rely on dynamic mapping.
9. **Plan the sync** (dual write / polling / outbox / CDC) *and* a full re-sync you can run any time.
10. **Postgres for truth, OpenSearch for search.**

---

## 13. Exercises

Run in Dev Tools against the lab indices.

1. All `paid` or `shipped` orders, newest first.
2. Orders that contain any **book**, showing only `orderId`, `customer.name` and `total`.
3. Orders where a single line item is worth more than 300 (`lineTotal`).
4. Number of orders per status.
5. Customers from Chennai who have spent more than 100 (use `customers`).
6. Using `shop_join`: customers who have an order in status `pending`.
7. In Postgres, change Divya's city to Kochi. Then update OpenSearch **without** re-running the full sync.

<details>
<summary>Answers</summary>

```
# 1
GET orders/_search
{ "query": { "terms": { "status": ["paid", "shipped"] } }, "sort": [ { "createdAt": "desc" } ] }

# 2
GET orders/_search
{ "_source": ["orderId", "customer.name", "total"],
  "query": { "nested": { "path": "items", "query": { "term": { "items.category": "books" } } } } }

# 3
GET orders/_search
{ "query": { "nested": { "path": "items", "query": { "range": { "items.lineTotal": { "gt": 300 } } }, "inner_hits": {} } } }

# 4
GET orders/_search
{ "size": 0, "aggs": { "by_status": { "terms": { "field": "status" } } } }

# 5
GET customers/_search
{ "query": { "bool": { "filter": [ { "term": { "city": "Chennai" } }, { "range": { "totalSpent": { "gt": 100 } } } ] } } }

# 6
GET shop_join/_search
{ "query": { "has_child": { "type": "order", "query": { "term": { "status": "pending" } } } } }

# 7  (Postgres)  UPDATE customers SET city = 'Kochi', updated_at = now() WHERE id = 4;
POST customers/_update/4
{ "doc": { "city": "Kochi" } }

POST orders/_update_by_query?refresh=true
{ "query": { "term": { "customer.id": 4 } },
  "script": { "source": "ctx._source.customer.city = params.city", "params": { "city": "Kochi" } } }

PUT shop_join/_doc/customer-4
{ "relation": "customer", "name": "Divya Nair", "email": "divya@example.com", "city": "Kochi" }
```
</details>
