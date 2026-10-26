# How to Use This Guide

This guide teaches OpenSearch from zero to building a production-style product search API with NestJS. It assumes you know JavaScript/TypeScript and basic SQL. It assumes no OpenSearch knowledge.

Every example in this guide has been run against a real OpenSearch 2.19 cluster. Results quoted in the text come from those runs, so you should see the same results on your machine.

## What you will learn

| Part | Chapters | You will be able to |
|---|---|---|
| 1. Foundations | 1–2 | Explain what OpenSearch is, how it stores data, and use Dev Tools confidently |
| 2. Data | 3–6 | Create indices, design mappings, understand text analysis, insert, update and delete documents |
| 3. Search | 7–17 | Write any query: full-text, exact filters, bool logic, filtering and facets, pagination, sorting, highlighting, autocomplete, relationships, geo, aggregations, SQL |
| 4. NestJS | 18–20 | Connect NestJS to OpenSearch, build CRUD, search, autocomplete and statistics APIs, load data, test and deploy |
| 5. Operations | 21–22 | Tune performance, fix common errors, and use the cheat sheet |

## How to read it

1. **Read chapters 1 and 2 first.** They set up the practice data that every later chapter uses.
2. **Type the examples yourself in Dev Tools.** Change values and see what happens. That is the fastest way to learn.
3. Chapters 7 to 17 build on each other. Read them in order the first time.
4. Use chapter 22 (cheat sheet) as a daily reference afterwards.

## Conventions

Dev Tools requests look like this. Run them in OpenSearch Dashboards → Dev Tools:

```http
GET _cluster/health
```

Shell commands (run in a terminal):

```bash
curl http://localhost:9200
```

TypeScript code (NestJS):

```ts
const { body } = await client.search({ index: 'products', body: { query: { match_all: {} } } });
```

> **Note:** Boxes like this highlight important rules, common mistakes, and tips.

## The project this guide belongs to

The repository contains a complete, working NestJS + OpenSearch application:

| Path | What it is |
|---|---|
| `docker-compose.yml` | OpenSearch, OpenSearch Dashboards, PostgreSQL and the NestJS API |
| `src/products/` | The products API: CRUD, search, autocomplete, statistics |
| `postman/` | Postman collection with 38 tested requests and sample data |
| `scripts/sync-postgres-to-opensearch.js` | Copies relational PostgreSQL data into OpenSearch |
| `docs/handbook/` | The source of this guide |

Two indices are used in this guide:

| Index | Used for |
|---|---|
| `learn_products` | The practice index for Dev Tools examples (chapters 2–17). Safe to delete and recreate at any time. |
| `products` | The index used by the NestJS API (chapters 18–20). |
