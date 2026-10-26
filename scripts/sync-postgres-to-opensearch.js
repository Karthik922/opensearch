/**
 * Copies the relational "shop" data from PostgreSQL into OpenSearch.
 *
 * The same rows are written in three different shapes so you can compare
 * how relationships are modelled (see docs/POSTGRES-TO-OPENSEARCH.md):
 *
 *   orders     – one document per order, customer copied in, items as `nested`  (RECOMMENDED)
 *   customers  – one document per customer, with pre-computed order statistics
 *   shop_join  – customers (parents) and orders (children) linked by a `join` field
 *
 * Full re-sync: the three indices are deleted and rebuilt on every run.
 *
 *   npm run sync:pg
 *   DATABASE_URL=postgres://shop:shop@localhost:5434/shop OPENSEARCH_NODE=http://localhost:9200 node scripts/sync-postgres-to-opensearch.js
 */
const { Client: PgClient } = require('pg');
const { Client: OsClient } = require('@opensearch-project/opensearch');

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://shop:shop@localhost:5434/shop';
const OPENSEARCH_NODE = process.env.OPENSEARCH_NODE || 'http://localhost:9200';

// ---------------------------------------------------------------- mappings
const ORDERS_INDEX = {
  settings: { number_of_shards: 1, number_of_replicas: 0 },
  mappings: {
    properties: {
      orderId: { type: 'integer' },
      status: { type: 'keyword' },
      createdAt: { type: 'date' },
      total: { type: 'float' },
      itemCount: { type: 'integer' },
      // many-to-one: the customer is COPIED into every order (denormalized)
      customer: {
        properties: {
          id: { type: 'integer' },
          name: { type: 'text', fields: { keyword: { type: 'keyword' } } },
          email: { type: 'keyword' },
          city: { type: 'keyword' },
        },
      },
      // one-to-many: order_items JOIN products, stored as nested objects
      items: {
        type: 'nested',
        properties: {
          productId: { type: 'keyword' },
          name: { type: 'text', fields: { keyword: { type: 'keyword' } } },
          category: { type: 'keyword' },
          quantity: { type: 'integer' },
          unitPrice: { type: 'float' },
          lineTotal: { type: 'float' },
        },
      },
    },
  },
};

const CUSTOMERS_INDEX = {
  settings: { number_of_shards: 1, number_of_replicas: 0 },
  mappings: {
    properties: {
      customerId: { type: 'integer' },
      name: { type: 'text', fields: { keyword: { type: 'keyword' } } },
      email: { type: 'keyword' },
      city: { type: 'keyword' },
      createdAt: { type: 'date' },
      orderCount: { type: 'integer' },
      totalSpent: { type: 'float' },
      lastOrderAt: { type: 'date' },
      productsBought: { type: 'keyword' },
    },
  },
};

const JOIN_INDEX = {
  settings: { number_of_shards: 1, number_of_replicas: 0 },
  mappings: {
    properties: {
      relation: { type: 'join', relations: { customer: 'order' } },
      // customer fields
      name: { type: 'text', fields: { keyword: { type: 'keyword' } } },
      email: { type: 'keyword' },
      city: { type: 'keyword' },
      // order fields
      status: { type: 'keyword' },
      total: { type: 'float' },
      createdAt: { type: 'date' },
      products: { type: 'keyword' },
    },
  },
};

// ---------------------------------------------------------------- SQL (Postgres does the JOINs)
const ORDERS_SQL = `
  SELECT o.id                                   AS "orderId",
         o.status,
         o.created_at                           AS "createdAt",
         SUM(oi.quantity * oi.unit_price)::float8 AS total,
         SUM(oi.quantity)::int                  AS "itemCount",
         json_build_object('id', c.id, 'name', c.name, 'email', c.email, 'city', c.city) AS customer,
         json_agg(json_build_object(
           'productId', p.id,
           'name',      p.name,
           'category',  p.category,
           'quantity',  oi.quantity,
           'unitPrice', oi.unit_price,
           'lineTotal', oi.quantity * oi.unit_price
         ) ORDER BY p.id)                        AS items
  FROM orders o
  JOIN customers   c  ON c.id = o.customer_id
  JOIN order_items oi ON oi.order_id = o.id
  JOIN products    p  ON p.id = oi.product_id
  GROUP BY o.id, c.id
  ORDER BY o.id`;

const CUSTOMERS_SQL = `
  SELECT c.id                                        AS "customerId",
         c.name, c.email, c.city,
         c.created_at                                AS "createdAt",
         COUNT(DISTINCT o.id)::int                   AS "orderCount",
         COALESCE(SUM(oi.quantity * oi.unit_price) FILTER (WHERE o.status <> 'cancelled'), 0)::float8 AS "totalSpent",
         MAX(o.created_at)                           AS "lastOrderAt",
         COALESCE(array_agg(DISTINCT p.name) FILTER (WHERE p.name IS NOT NULL), '{}') AS "productsBought"
  FROM customers c
  LEFT JOIN orders      o  ON o.customer_id = c.id
  LEFT JOIN order_items oi ON oi.order_id = o.id
  LEFT JOIN products    p  ON p.id = oi.product_id
  GROUP BY c.id
  ORDER BY c.id`;

// ---------------------------------------------------------------- helpers
async function recreateIndex(os, index, body) {
  const { body: exists } = await os.indices.exists({ index });
  if (exists) await os.indices.delete({ index });
  await os.indices.create({ index, body });
}

async function bulk(os, operations) {
  const { body } = await os.bulk({ body: operations, refresh: 'wait_for' });
  if (body.errors) {
    const failed = body.items.filter((i) => Object.values(i)[0].error);
    throw new Error(`Bulk failed for ${failed.length} item(s): ${JSON.stringify(Object.values(failed[0])[0].error)}`);
  }
  return body.items.length;
}

// ---------------------------------------------------------------- main
async function main() {
  const pg = new PgClient({ connectionString: DATABASE_URL });
  const os = new OsClient({ node: OPENSEARCH_NODE });
  await pg.connect();

  try {
    const { rows: orders } = await pg.query(ORDERS_SQL);
    const { rows: customers } = await pg.query(CUSTOMERS_SQL);

    // 1) orders: denormalized + nested
    await recreateIndex(os, 'orders', ORDERS_INDEX);
    const n1 = await bulk(
      os,
      orders.flatMap((o) => [{ index: { _index: 'orders', _id: String(o.orderId) } }, o]),
    );

    // 2) customers: flat with computed stats
    await recreateIndex(os, 'customers', CUSTOMERS_INDEX);
    const n2 = await bulk(
      os,
      customers.flatMap((c) => [{ index: { _index: 'customers', _id: String(c.customerId) } }, c]),
    );

    // 3) shop_join: parent/child. Children MUST use routing = parent id (same shard as the parent).
    await recreateIndex(os, 'shop_join', JOIN_INDEX);
    const joinOps = [
      ...customers.flatMap((c) => [
        { index: { _index: 'shop_join', _id: `customer-${c.customerId}` } },
        { relation: 'customer', name: c.name, email: c.email, city: c.city },
      ]),
      ...orders.flatMap((o) => [
        { index: { _index: 'shop_join', _id: `order-${o.orderId}`, routing: `customer-${o.customer.id}` } },
        {
          relation: { name: 'order', parent: `customer-${o.customer.id}` },
          status: o.status,
          total: o.total,
          createdAt: o.createdAt,
          products: o.items.map((i) => i.name),
        },
      ]),
    ];
    const n3 = await bulk(os, joinOps);

    console.log(`orders:    ${n1} documents`);
    console.log(`customers: ${n2} documents`);
    console.log(`shop_join: ${n3} documents (${customers.length} customers + ${orders.length} orders)`);
  } finally {
    await pg.end();
    await os.close();
  }
}

main().catch((err) => {
  console.error('Sync failed:', err.message);
  process.exit(1);
});
