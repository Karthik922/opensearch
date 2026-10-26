-- Relational "shop" schema used by the Postgres → OpenSearch lab.
-- Runs automatically the first time the postgres container starts.

CREATE TABLE customers (
  id          SERIAL PRIMARY KEY,
  name        TEXT        NOT NULL,
  email       TEXT        NOT NULL UNIQUE,
  city        TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id          TEXT PRIMARY KEY,
  name        TEXT          NOT NULL,
  category    TEXT          NOT NULL,
  price       NUMERIC(10,2) NOT NULL CHECK (price >= 0),
  updated_at  TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- one customer → many orders (1:N)
CREATE TABLE orders (
  id           SERIAL PRIMARY KEY,
  customer_id  INT         NOT NULL REFERENCES customers(id),
  status       TEXT        NOT NULL CHECK (status IN ('pending', 'paid', 'shipped', 'delivered', 'cancelled')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- orders ↔ products (N:M) through order_items
CREATE TABLE order_items (
  order_id    INT           NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id  TEXT          NOT NULL REFERENCES products(id),
  quantity    INT           NOT NULL CHECK (quantity > 0),
  unit_price  NUMERIC(10,2) NOT NULL,          -- price at the time of purchase
  PRIMARY KEY (order_id, product_id)
);

CREATE INDEX ON orders (customer_id);
CREATE INDEX ON order_items (product_id);
