INSERT INTO customers (name, email, city, created_at) VALUES
  ('Arun Kumar',     'arun@example.com',   'Chennai',   '2026-01-10'),
  ('Priya Sharma',   'priya@example.com',  'Bangalore', '2026-02-14'),
  ('Rahul Verma',    'rahul@example.com',  'Mumbai',    '2026-03-03'),
  ('Divya Nair',     'divya@example.com',  'Chennai',   '2026-04-21'),
  ('Karthik Raja',   'karthik@example.com','Coimbatore','2026-05-30');

INSERT INTO products (id, name, category, price) VALUES
  ('p-1001', 'Wireless Mouse',                        'electronics', 19.99),
  ('p-1002', 'Mechanical Keyboard',                   'electronics', 79.50),
  ('p-1003', 'Gaming Headset',                        'electronics', 59.00),
  ('p-1004', '27 inch 4K Monitor',                    'electronics', 329.00),
  ('p-2001', 'Ceramic Coffee Mug',                    'kitchen',      8.99),
  ('p-2002', 'French Press',                          'kitchen',     27.50),
  ('p-3001', 'Clean Code',                            'books',       32.99),
  ('p-3002', 'Designing Data-Intensive Applications', 'books',       44.50),
  ('p-4001', 'Running Shoes',                         'sports',      89.99);

INSERT INTO orders (customer_id, status, created_at) VALUES
  (1, 'delivered', '2026-06-01 10:15'),   -- order 1
  (1, 'shipped',   '2026-09-12 18:40'),   -- order 2
  (2, 'paid',      '2026-09-20 09:05'),   -- order 3
  (3, 'delivered', '2026-07-08 14:30'),   -- order 4
  (3, 'cancelled', '2026-08-15 11:00'),   -- order 5
  (4, 'pending',   '2026-10-20 20:10'),   -- order 6
  (5, 'delivered', '2026-08-01 08:45'),   -- order 7
  (5, 'paid',      '2026-10-18 16:25');   -- order 8

INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES
  -- order 1: 1 mouse + 5 keyboards  (used to show the object-vs-nested problem)
  (1, 'p-1001', 1, 19.99),
  (1, 'p-1002', 5, 79.50),
  (2, 'p-3001', 1, 32.99),
  (2, 'p-3002', 1, 44.50),
  (3, 'p-1004', 1, 329.00),
  (3, 'p-1001', 2, 19.99),
  (4, 'p-2001', 4, 8.99),
  (4, 'p-2002', 1, 27.50),
  (5, 'p-1003', 1, 59.00),
  (6, 'p-4001', 1, 89.99),
  (6, 'p-1001', 1, 18.99),
  (7, 'p-1002', 1, 79.50),
  (7, 'p-1003', 1, 55.00),
  (8, 'p-3001', 2, 32.99);
