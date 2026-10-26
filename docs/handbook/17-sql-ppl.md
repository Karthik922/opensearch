# Chapter 17 — Querying with SQL and PPL

OpenSearch includes a **SQL plugin**. You can query indices with ordinary SQL, which is great for exploring data, ad-hoc reports, and learning: you can ask OpenSearch to show the Query DSL that a SQL statement becomes.

## 17.1 SQL basics

Send SQL to `_plugins/_sql`. The index name is the table name:

```http
POST _plugins/_sql?format=csv
{
  "query": "SELECT name, price FROM learn_products WHERE category = 'books' ORDER BY price DESC"
}
```

→

```text
name,price
Designing Data-Intensive Applications,44.5
The Pragmatic Programmer,39.99
Clean Code,32.99
```

The `format` parameter controls the response:

| `format` | Output |
|---|---|
| `jdbc` (default) | JSON with `schema` (column names and types) and `datarows` |
| `json` | The raw OpenSearch search response |
| `csv` | Comma-separated text |
| `raw` | Pipe-separated text |

> **Note:** some tutorials use `format=txt`. OpenSearch 2.19 rejects it for SQL with *"unknown response format: txt"*. Use `csv` or `jdbc`.

```http
# The default jdbc format: column schema + rows
POST _plugins/_sql
{
  "query": "SELECT name, price FROM learn_products WHERE category = 'books' ORDER BY price DESC LIMIT 1"
}
```

→ `"schema": [{"name": "name", "type": "text"}, {"name": "price", "type": "double"}]`, `"datarows": [["Designing Data-Intensive Applications", 44.5]]`, `"total": 1`. SQL reports the `scaled_float` price as `double`.

## 17.2 Aggregation with SQL

```http
POST _plugins/_sql?format=csv
{
  "query": "SELECT category, COUNT(*) AS products, ROUND(AVG(price), 2) AS avg_price, SUM(stock) AS units FROM learn_products GROUP BY category ORDER BY products DESC"
}
```

→

```text
category,products,avg_price,units
electronics,8,122.86,495
kitchen,5,75.88,605
sports,4,125.75,153
books,3,39.16,65
```

More examples:

```http
POST _plugins/_sql?format=csv
{ "query": "SELECT brand, COUNT(*) AS c FROM learn_products GROUP BY brand HAVING COUNT(*) >= 2" }

POST _plugins/_sql?format=csv
{ "query": "SELECT name, price FROM learn_products WHERE MATCH(description, 'wireless') AND price < 100" }

POST _plugins/_sql?format=csv
{ "query": "SELECT name, createdAt FROM learn_products WHERE createdAt >= '2026-09-01' ORDER BY createdAt" }
```

`MATCH(field, 'text')` is a full-text search inside SQL. Other search functions include `MATCH_PHRASE`, `MULTI_MATCH` and `QUERY_STRING`.

## 17.3 See the Query DSL behind a SQL statement

```http
POST _plugins/_sql/_explain
{
  "query": "SELECT name FROM learn_products WHERE price > 50 AND category = 'kitchen'"
}
```

The response shows the generated OpenSearch query (a `bool` with `range` and `term` clauses). It's an excellent way to learn the Query DSL: write what you know in SQL, then read the equivalent DSL.

## 17.4 PPL — Piped Processing Language

PPL is a pipe-based language (like Unix pipes or Splunk), popular for logs and analytics:

```http
POST _plugins/_ppl?format=csv
{
  "query": "source=learn_products | where price > 100 | fields name, price, category | sort - price"
}

POST _plugins/_ppl?format=csv
{
  "query": "source=learn_products | stats count() as products, avg(price) as avg_price by category"
}
```

| PPL command | Does |
|---|---|
| `source=index` | Choose the index |
| `where condition` | Filter |
| `fields a, b` | Choose columns |
| `sort - field` / `sort + field` | Sort descending / ascending |
| `stats count(), avg(x) by y` | Aggregate |
| `head 5` | Limit |
| `eval newField = a * b` | Calculated column |
| `dedup field` | One row per value |

## 17.5 Query Workbench

OpenSearch Dashboards has a graphical **Query Workbench** (☰ → OpenSearch Plugins → Query Workbench). You can type SQL or PPL, see the results as a table, and download them.

## 17.6 Limits of SQL in OpenSearch

- JOINs are very limited and not recommended. Model data as described in chapter 15.
- Results are capped (200 rows by default, configurable with `plugins.query.size_limit`).
- Relevance scoring, highlighting, fuzziness and facets are richer in the Query DSL.

**Use SQL to explore and report. Use the Query DSL in application code.**
