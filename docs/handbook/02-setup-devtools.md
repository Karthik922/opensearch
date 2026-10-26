# Chapter 2 — Setup, Dev Tools and the Practice Data

## 2.1 Start OpenSearch with Docker

The project's `docker-compose.yml` starts everything you need. From the project folder:

```bash
docker compose up -d opensearch opensearch-dashboards
```

| Service | URL | What it is |
|---|---|---|
| OpenSearch | http://localhost:9200 | The engine. Its REST API is what every client talks to. |
| OpenSearch Dashboards | http://localhost:5601 | Web UI, including Dev Tools |

The OpenSearch service in `docker-compose.yml`, explained line by line:

```yaml
opensearch:
  image: opensearchproject/opensearch:2.19.1
  environment:
    - discovery.type=single-node            # one-node cluster: no need to find other nodes
    - bootstrap.memory_lock=true             # keep OpenSearch memory out of swap
    - "OPENSEARCH_JAVA_OPTS=-Xms512m -Xmx512m"  # JVM heap: 512 MB min and max
    - DISABLE_SECURITY_PLUGIN=true           # development only: plain HTTP, no login
    - DISABLE_INSTALL_DEMO_CONFIG=true
  ulimits:
    memlock: { soft: -1, hard: -1 }          # required by bootstrap.memory_lock
    nofile: { soft: 65536, hard: 65536 }     # OpenSearch opens many files
  volumes:
    - opensearch-data:/usr/share/opensearch/data   # data survives container restarts
  ports:
    - "9200:9200"                            # REST API
```

> **Note:** Heap size (`-Xms`/`-Xmx`) should be about half of the machine's RAM, up to around 31 GB, with both values the same. 512 MB is enough for learning.

Check that it works:

```bash
curl http://localhost:9200
```

The response shows the cluster name and version (`"number" : "2.19.1"`).

## 2.2 Open Dev Tools

1. Open http://localhost:5601 in your browser.
2. If a welcome screen appears, choose **Explore on my own**.
3. Open the menu (☰, top left) → **Management** → **Dev Tools**.

The screen has two panes:

| Left pane: editor | Right pane: response |
|---|---|
| You type requests here | The JSON response of the last request you ran |

## 2.3 Request syntax in Dev Tools

Each request has a first line with the **HTTP method** and the **path**, optionally followed by a **JSON body**:

```http
GET _cat/indices?v
```

| Part | Example | Meaning |
|---|---|---|
| Method | `GET`, `POST`, `PUT`, `DELETE`, `HEAD` | What to do |
| Path | `learn_products/_search` | Which index (first) and which API (starting with `_`) |
| Query string | `?v`, `?pretty`, `?refresh=true` | Options for the request |
| Body | `{ "query": { ... } }` | JSON, starting on the next line |

Rules that save you time:

- **No leading slash is needed.** `GET _search` and `GET /_search` are the same.
- **No host or port.** Dev Tools sends every request to the cluster it's connected to.
- **Separate requests with a blank line** and give each its own first line.
- Lines starting with `#` are **comments**.
- Dev Tools accepts slightly relaxed JSON. Write strict JSON anyway, so you can copy it into code.

## 2.4 Running requests

| Action | How |
|---|---|
| Run the request under the cursor | **Ctrl + Enter** (Mac: Cmd + Enter), or click the ▶ button next to the request |
| Run several requests | Select them all, then press Ctrl + Enter. Responses appear one after another. |
| Format (indent) the JSON | **Ctrl + I** |
| Jump to the previous / next request | **Ctrl + ↑ / Ctrl + ↓** |
| Autocomplete | Start typing. Suggestions appear for paths, index names, field names and query keywords. Press Enter or Tab to accept. Ctrl + Space opens it manually. |
| Open the docs for the API under the cursor | **Ctrl + /** |
| Copy as cURL | Click the wrench icon next to the request → **Copy as cURL** |
| History | **History** button (top) shows recent requests; click one to reuse it |
| Settings | **Settings** button: font size, autocomplete options |
| Help | **Help** button: the full list of keyboard shortcuts |

Dev Tools saves the editor content in your browser, so your requests are still there the next time you open it.

**Multi-line strings.** Inside a body, Dev Tools lets you write long strings (for example scripts) between triple quotes. When copied as cURL, they are converted to normal JSON strings:

```text
POST learn_products/_update/P001
{
  "script": {
    "source": """
      ctx._source.stock -= 1;
      ctx._source.inStock = ctx._source.stock > 0;
    """
  }
}
```

## 2.5 Your first requests

```http
# Cluster information: name and version
GET /

# Is the cluster healthy? (green / yellow / red)
GET _cluster/health

# List all indices with document counts and sizes (?v adds column headers)
GET _cat/indices?v

# List the nodes
GET _cat/nodes?v
```

The `_cat` APIs return human-readable tables instead of JSON. They are ideal for a quick look in Dev Tools. Add `?v` for headers and `?help` to list the available columns.

## 2.6 Reading a response

Every response has a **status code** (shown above the response pane, for example `200 - OK`) and a JSON body. A search response looks like this:

```json
{
  "took": 2,
  "timed_out": false,
  "_shards": { "total": 1, "successful": 1, "skipped": 0, "failed": 0 },
  "hits": {
    "total": { "value": 2, "relation": "eq" },
    "max_score": 1.2,
    "hits": [
      {
        "_index": "learn_products",
        "_id": "P001",
        "_score": 1.2,
        "_source": { "name": "Wireless Mouse", "price": 19.99 }
      }
    ]
  }
}
```

| Field | Meaning |
|---|---|
| `took` | Time spent in OpenSearch, in milliseconds |
| `timed_out` | `true` if the search hit its time limit and the results are partial |
| `_shards` | How many shards were searched and how many failed |
| `hits.total.value` | Number of matching documents |
| `hits.total.relation` | `eq` = the number is exact. `gte` = there are **at least** this many (see chapter 12) |
| `hits.max_score` | The highest score in the results |
| `hits.hits` | The documents for the current page: **10 by default** |
| `_index`, `_id` | Where the document lives and its ID |
| `_score` | How well it matched (higher is better) |
| `_source` | Your original JSON |

## 2.7 Reading an error

Errors also return JSON. Try a request for an index that doesn't exist:

```http
# expected error: the index does not exist
GET no_such_index/_search
```

```json
{
  "error": {
    "root_cause": [
      { "type": "index_not_found_exception", "reason": "no such index [no_such_index]" }
    ],
    "type": "index_not_found_exception",
    "reason": "no such index [no_such_index]"
  },
  "status": 404
}
```

Always read **`error.root_cause[0].reason`** first: it says what went wrong in plain words. The status codes you'll see most:

| Status | Meaning | Typical cause |
|---|---|---|
| 200 / 201 | OK / Created | Success |
| 400 | Bad request | Invalid JSON, unknown query, wrong field type, mapping conflict |
| 404 | Not found | Index or document doesn't exist |
| 409 | Conflict | Document already exists (`_create`), or a version conflict |
| 429 | Too many requests | The cluster is overloaded; retry later |
| 500 | Server error | A bug or an unexpected failure; read the reason |
| 503 | Unavailable | The cluster isn't ready or shards are missing (red health) |

## 2.8 The same request outside Dev Tools

Every Dev Tools request is a normal HTTP request. The search `GET learn_products/_search` with a body becomes:

**curl (Git Bash, Linux, macOS):**

```bash
curl -X GET "http://localhost:9200/learn_products/_search?pretty" \
  -H "Content-Type: application/json" \
  -d '{ "query": { "match": { "name": "mouse" } } }'
```

**PowerShell:**

```powershell
$body = '{ "query": { "match": { "name": "mouse" } } }'
Invoke-RestMethod -Method Post -Uri "http://localhost:9200/learn_products/_search" `
  -ContentType "application/json" -Body $body | ConvertTo-Json -Depth 10
```

**Postman:** method `POST` (or `GET`), URL `http://localhost:9200/learn_products/_search`, Body → raw → JSON.

> **Note:** Searches with a body can be sent as `GET` or `POST`. Some tools and proxies drop the body of `GET` requests, so code usually uses `POST`.

## 2.9 Create the practice data

Every example in chapters 3 to 17 uses an index called **`learn_products`** with 20 products. Copy the three requests below into Dev Tools, select them all, and press Ctrl + Enter.

The first request removes the index if it exists, so you can run this block again at any time to reset the data. The second request creates the index with its **mapping**, the schema (explained in chapter 4). The third loads 20 products in one **bulk** request (explained in chapter 6).

```http
# 1. Delete the practice index if it already exists (safe to run again)
DELETE learn_products?ignore_unavailable=true

# 2. Create the index with settings and a mapping
PUT learn_products
{
  "settings": {
    "number_of_shards": 1,
    "number_of_replicas": 0
  },
  "mappings": {
    "dynamic": "strict",
    "properties": {
      "sku":         { "type": "keyword" },
      "name":        {
        "type": "text",
        "fields": {
          "keyword":      { "type": "keyword" },
          "autocomplete": { "type": "search_as_you_type" }
        }
      },
      "description": { "type": "text", "analyzer": "english" },
      "brand":       { "type": "keyword" },
      "category":    { "type": "keyword" },
      "tags":        { "type": "keyword" },
      "color":       { "type": "keyword" },
      "price":       { "type": "scaled_float", "scaling_factor": 100 },
      "rating":      { "type": "float" },
      "reviews":     { "type": "integer" },
      "stock":       { "type": "integer" },
      "inStock":     { "type": "boolean" },
      "createdAt":   { "type": "date" }
    }
  }
}

# 3. Load 20 products
POST _bulk?refresh=true
{ "index": { "_index": "learn_products", "_id": "P001" } }
{ "sku": "P001", "name": "Wireless Mouse", "description": "Compact wireless mouse with a silent click and 18 month battery life.", "brand": "Logitech", "category": "electronics", "tags": ["computer", "accessories", "wireless"], "color": "black", "price": 19.99, "rating": 4.5, "reviews": 1520, "stock": 150, "inStock": true, "createdAt": "2026-01-15" }
{ "index": { "_index": "learn_products", "_id": "P002" } }
{ "sku": "P002", "name": "Wireless Keyboard", "description": "Slim wireless keyboard with quiet keys and a numeric keypad.", "brand": "Logitech", "category": "electronics", "tags": ["computer", "wireless"], "color": "black", "price": 49.99, "rating": 4.3, "reviews": 830, "stock": 60, "inStock": true, "createdAt": "2026-02-03" }
{ "index": { "_index": "learn_products", "_id": "P003" } }
{ "sku": "P003", "name": "Mechanical Keyboard", "description": "Hot-swappable mechanical keyboard with RGB backlight and Bluetooth.", "brand": "Keychron", "category": "electronics", "tags": ["computer", "gaming"], "color": "gray", "price": 89.00, "rating": 4.7, "reviews": 2100, "stock": 25, "inStock": true, "createdAt": "2026-03-10" }
{ "index": { "_index": "learn_products", "_id": "P004" } }
{ "sku": "P004", "name": "Gaming Mouse", "description": "Lightweight gaming mouse with a 26K DPI optical sensor.", "brand": "Razer", "category": "electronics", "tags": ["computer", "gaming"], "color": "black", "price": 59.99, "rating": 4.6, "reviews": 980, "stock": 0, "inStock": false, "createdAt": "2026-04-22" }
{ "index": { "_index": "learn_products", "_id": "P005" } }
{ "sku": "P005", "name": "Noise Cancelling Headphones", "description": "Wireless over-ear headphones with industry leading noise cancelling and 30 hours of battery.", "brand": "Sony", "category": "electronics", "tags": ["audio", "wireless", "travel"], "color": "silver", "price": 299.00, "rating": 4.8, "reviews": 5400, "stock": 12, "inStock": true, "createdAt": "2026-05-05" }
{ "index": { "_index": "learn_products", "_id": "P006" } }
{ "sku": "P006", "name": "Bluetooth Speaker", "description": "Waterproof portable speaker with deep bass, perfect for the beach.", "brand": "JBL", "category": "electronics", "tags": ["audio", "wireless", "outdoor"], "color": "blue", "price": 79.95, "rating": 4.4, "reviews": 2650, "stock": 40, "inStock": true, "createdAt": "2026-06-18" }
{ "index": { "_index": "learn_products", "_id": "P007" } }
{ "sku": "P007", "name": "USB-C Charger 65W", "description": "Fast charger for laptops and phones with two USB-C ports.", "brand": "Anker", "category": "electronics", "tags": ["charging", "travel"], "color": "white", "price": 35.99, "rating": 4.6, "reviews": 3100, "stock": 200, "inStock": true, "createdAt": "2026-07-01" }
{ "index": { "_index": "learn_products", "_id": "P008" } }
{ "sku": "P008", "name": "27-inch 4K Monitor", "description": "Ultra sharp 4K display with USB-C and an adjustable stand.", "brand": "Dell", "category": "electronics", "tags": ["computer", "display"], "color": "black", "price": 349.00, "rating": 4.5, "reviews": 760, "stock": 8, "inStock": true, "createdAt": "2026-08-12" }
{ "index": { "_index": "learn_products", "_id": "P009" } }
{ "sku": "P009", "name": "Espresso Machine", "description": "Manual espresso machine with a milk frother for cappuccino.", "brand": "DeLonghi", "category": "kitchen", "tags": ["coffee", "appliance"], "color": "silver", "price": 249.00, "rating": 4.2, "reviews": 410, "stock": 5, "inStock": true, "createdAt": "2026-02-20" }
{ "index": { "_index": "learn_products", "_id": "P010" } }
{ "sku": "P010", "name": "French Press Coffee Maker", "description": "Classic glass French press that brews eight cups of coffee.", "brand": "Bodum", "category": "kitchen", "tags": ["coffee"], "color": "black", "price": 29.90, "rating": 4.5, "reviews": 1800, "stock": 70, "inStock": true, "createdAt": "2026-03-28" }
{ "index": { "_index": "learn_products", "_id": "P011" } }
{ "sku": "P011", "name": "Ceramic Coffee Mug", "description": "Simple ceramic mug, dishwasher and microwave safe.", "brand": "IKEA", "category": "kitchen", "tags": ["coffee", "home"], "color": "white", "price": 6.99, "rating": 4.1, "reviews": 320, "stock": 500, "inStock": true, "createdAt": "2026-04-02" }
{ "index": { "_index": "learn_products", "_id": "P012" } }
{ "sku": "P012", "name": "Chef Knife 8 inch", "description": "Stainless steel chef knife for chopping, slicing and dicing.", "brand": "Victorinox", "category": "kitchen", "tags": ["cooking"], "color": "black", "price": 54.00, "rating": 4.7, "reviews": 940, "stock": 30, "inStock": true, "createdAt": "2026-05-15" }
{ "index": { "_index": "learn_products", "_id": "P013" } }
{ "sku": "P013", "name": "Non-stick Frying Pan", "description": "Non-stick frying pan with a heat indicator, works on induction.", "brand": "Tefal", "category": "kitchen", "tags": ["cooking"], "color": "black", "price": 39.50, "rating": 4.3, "reviews": 1210, "stock": 0, "inStock": false, "createdAt": "2026-06-09" }
{ "index": { "_index": "learn_products", "_id": "P014" } }
{ "sku": "P014", "name": "Clean Code", "description": "A handbook of agile software craftsmanship by Robert C. Martin.", "brand": "Prentice Hall", "category": "books", "tags": ["programming", "bestseller"], "price": 32.99, "rating": 4.6, "reviews": 6800, "stock": 45, "inStock": true, "createdAt": "2026-01-05" }
{ "index": { "_index": "learn_products", "_id": "P015" } }
{ "sku": "P015", "name": "Designing Data-Intensive Applications", "description": "The big ideas behind reliable, scalable and maintainable systems, databases and search engines.", "brand": "O'Reilly", "category": "books", "tags": ["programming", "databases", "bestseller"], "price": 44.50, "rating": 4.9, "reviews": 4100, "stock": 20, "inStock": true, "createdAt": "2026-07-19" }
{ "index": { "_index": "learn_products", "_id": "P016" } }
{ "sku": "P016", "name": "The Pragmatic Programmer", "description": "Your journey to mastery as a software developer.", "brand": "Addison-Wesley", "category": "books", "tags": ["programming"], "price": 39.99, "rating": 4.7, "reviews": 3900, "stock": 0, "inStock": false, "createdAt": "2026-09-02" }
{ "index": { "_index": "learn_products", "_id": "P017" } }
{ "sku": "P017", "name": "Running Shoes", "description": "Lightweight cushioned shoes for road running and daily runs.", "brand": "Nike", "category": "sports", "tags": ["running", "outdoor"], "color": "red", "price": 120.00, "rating": 4.4, "reviews": 2300, "stock": 35, "inStock": true, "createdAt": "2026-08-25" }
{ "index": { "_index": "learn_products", "_id": "P018" } }
{ "sku": "P018", "name": "Yoga Mat", "description": "Non-slip 6mm yoga mat with a carry strap.", "brand": "Decathlon", "category": "sports", "tags": ["yoga", "fitness"], "color": "purple", "price": 19.00, "rating": 4.2, "reviews": 860, "stock": 90, "inStock": true, "createdAt": "2026-09-14" }
{ "index": { "_index": "learn_products", "_id": "P019" } }
{ "sku": "P019", "name": "Adjustable Dumbbells", "description": "Pair of adjustable dumbbells from 2 to 24 kg for home workouts.", "brand": "Bowflex", "category": "sports", "tags": ["fitness", "gym"], "color": "black", "price": 299.00, "rating": 4.6, "reviews": 1500, "stock": 6, "inStock": true, "createdAt": "2026-10-01" }
{ "index": { "_index": "learn_products", "_id": "P020" } }
{ "sku": "P020", "name": "Waterproof Hiking Backpack", "description": "30 litre waterproof backpack for hiking and travel.", "brand": "Decathlon", "category": "sports", "tags": ["outdoor", "travel"], "color": "green", "price": 64.99, "rating": 4.5, "reviews": 1340, "stock": 22, "inStock": true, "createdAt": "2026-10-10" }
```

The bulk response should show `"errors": false`. Check the result:

```http
GET learn_products/_count
```

→ `{ "count": 20, ... }`

### The practice data at a glance

| Category | Products | Out of stock |
|---|---|---|
| electronics | P001–P008 (8) | P004 Gaming Mouse |
| kitchen | P009–P013 (5) | P013 Non-stick Frying Pan |
| books | P014–P016 (3) | P016 The Pragmatic Programmer |
| sports | P017–P020 (4) | — |

The books have no `color` field. Several later examples use this to show how missing fields behave.

## 2.10 Your first search

```http
GET learn_products/_search
{
  "query": {
    "match": { "name": "wireless mouse" }
  }
}
```

The result contains three products, in this order:

1. **P001 Wireless Mouse**, which has both words, so it gets the highest score
2. **P002 Wireless Keyboard** and **P004 Gaming Mouse**, which each have one of the words and get the same, lower score

You've just used the inverted index and relevance scoring from chapter 1. The next chapters explain every part of this request.
