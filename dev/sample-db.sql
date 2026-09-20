-- KS Table – sample databases for development and manual testing.
-- Load into the Docker test container:
--   Get-Content dev/sample-db.sql -Raw | docker exec -i kstable-mysql mysql -uroot -pkstable --default-character-set=utf8mb4

SET NAMES utf8mb4;
SET SESSION cte_max_recursion_depth = 1000000;

-- ════════════════════════════════════════════════════════════════════
-- ks_shop: main demo database (all column types, FKs, views, routines, triggers, events)
-- ════════════════════════════════════════════════════════════════════
DROP DATABASE IF EXISTS ks_shop;
CREATE DATABASE ks_shop CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE ks_shop;

CREATE TABLE categories (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  parent_id INT UNSIGNED NULL,
  name VARCHAR(100) NOT NULL,
  slug VARCHAR(120) NOT NULL,
  description TEXT NULL,
  sort_order SMALLINT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_categories_slug (slug),
  KEY idx_categories_parent (parent_id),
  CONSTRAINT fk_categories_parent FOREIGN KEY (parent_id) REFERENCES categories (id) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB COMMENT='Produktkategorien';

INSERT INTO categories (id, parent_id, name, slug, description, sort_order) VALUES
  (1, NULL, 'Elektronik', 'elektronik', 'Geräte und Zubehör', 1),
  (2, 1, 'Computer', 'computer', NULL, 1),
  (3, 1, 'Smartphones', 'smartphones', NULL, 2),
  (4, 1, 'Audio', 'audio', 'Kopfhörer, Lautsprecher', 3),
  (5, NULL, 'Haushalt', 'haushalt', 'Alles für Zuhause', 2),
  (6, 5, 'Küche', 'kueche', NULL, 1),
  (7, 5, 'Garten', 'garten', NULL, 2),
  (8, NULL, 'Bücher', 'buecher', NULL, 3),
  (9, 8, 'Fachbücher', 'fachbuecher', NULL, 1),
  (10, 8, 'Romane', 'romane', NULL, 2),
  (11, NULL, 'Sport', 'sport', NULL, 4),
  (12, 11, 'Fitness', 'fitness', NULL, 1);

CREATE TABLE suppliers (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  contact_person VARCHAR(100) NULL,
  email VARCHAR(150) NULL,
  phone VARCHAR(40) NULL,
  country CHAR(2) NOT NULL DEFAULT 'DE',
  rating TINYINT UNSIGNED NULL,
  active TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB COMMENT='Lieferanten';

INSERT INTO suppliers (name, contact_person, email, phone, country, rating, active) VALUES
  ('Techno Import GmbH', 'Sabine Krüger', 'einkauf@techno-import.example', '+49 30 1234567', 'DE', 5, 1),
  ('Alpen Handel AG', 'Martin Gruber', 'office@alpenhandel.example', '+43 1 9876543', 'AT', 4, 1),
  ('Helvetia Supply', 'Lea Meier', 'info@helvetia-supply.example', '+41 44 5550101', 'CH', 3, 1),
  ('Nordsee Waren KG', 'Jan Petersen', 'kontakt@nordsee-waren.example', '+49 40 7654321', 'DE', 4, 1),
  ('Rhein Distribution', NULL, 'sales@rhein-dist.example', NULL, 'DE', NULL, 1),
  ('Lowlands Trading BV', 'Pieter de Vries', 'trade@lowlands.example', '+31 20 1112233', 'NL', 2, 1),
  ('Paris Commerce SARL', 'Claire Dubois', 'contact@paris-commerce.example', '+33 1 44556677', 'FR', 3, 0),
  ('Baltic Parts OÜ', 'Kadri Tamm', 'parts@baltic.example', '+372 5551234', 'EE', 4, 1);

CREATE TABLE products (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  sku CHAR(12) NOT NULL,
  category_id INT UNSIGNED NOT NULL,
  supplier_id INT UNSIGNED NULL,
  name VARCHAR(200) NOT NULL,
  description MEDIUMTEXT NULL,
  price DECIMAL(10,2) NOT NULL,
  cost DECIMAL(10,2) NULL,
  vat_rate DECIMAL(4,2) NOT NULL DEFAULT 19.00,
  price_gross DECIMAL(10,2) AS (ROUND(price * (1 + vat_rate / 100), 2)) STORED COMMENT 'Bruttopreis (berechnet)',
  stock INT NOT NULL DEFAULT 0,
  weight_kg FLOAT NULL,
  status ENUM('draft','active','discontinued') NOT NULL DEFAULT 'draft',
  tags SET('new','sale','bestseller','eco') NULL,
  attributes JSON NULL,
  image LONGBLOB NULL,
  is_featured TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_products_sku (sku),
  KEY idx_products_category (category_id),
  KEY idx_products_supplier (supplier_id),
  FULLTEXT KEY ft_products_name_desc (name, description),
  CONSTRAINT fk_products_category FOREIGN KEY (category_id) REFERENCES categories (id),
  CONSTRAINT fk_products_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers (id) ON DELETE SET NULL,
  CONSTRAINT chk_products_price CHECK (price >= 0),
  CONSTRAINT chk_products_vat CHECK (vat_rate BETWEEN 0 AND 30)
) ENGINE=InnoDB COMMENT='Artikelstamm';

INSERT INTO products (sku, category_id, supplier_id, name, description, price, cost, vat_rate, stock, weight_kg, status, tags, attributes, is_featured)
WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 500)
SELECT
  CONCAT('SKU-', LPAD(n, 8, '0')),
  2 + (n % 11),
  CASE WHEN n % 13 = 0 THEN NULL ELSE 1 + (n % 8) END,
  CONCAT(ELT(1 + (n % 10), 'Premium', 'Basic', 'Eco', 'Pro', 'Mini', 'Max', 'Smart', 'Classic', 'Ultra', 'Comfort'), ' ',
         ELT(1 + ((n DIV 10) % 12), 'Laptop', 'Kopfhörer', 'Mixer', 'Rasenmäher', 'Roman', 'Hantel', 'Monitor', 'Tastatur', 'Kaffeemaschine', 'Lampe', 'Rucksack', 'Lautsprecher'), ' ', n),
  CASE WHEN n % 9 = 0 THEN NULL ELSE CONCAT('Beschreibung für Artikel ', n, '. Hochwertige Verarbeitung, lange Lebensdauer und zwei Jahre Garantie.') END,
  ROUND(4.99 + ((n * 37) % 1000) + (n % 100) / 100, 2),
  ROUND((4.99 + ((n * 37) % 1000)) * 0.62, 2),
  CASE WHEN n % 10 = 4 THEN 7.00 ELSE 19.00 END,
  (n * 13) % 250,
  ROUND(0.1 + (n % 50) / 10, 2),
  ELT(1 + (n % 4), 'active', 'active', 'draft', 'discontinued'),
  CASE n % 5 WHEN 0 THEN 'new,sale' WHEN 1 THEN 'bestseller' WHEN 2 THEN NULL WHEN 3 THEN 'eco' ELSE 'sale' END,
  JSON_OBJECT('color', ELT(1 + (n % 5), 'schwarz', 'weiß', 'rot', 'blau', 'grün'), 'warranty_years', 1 + (n % 3), 'dimensions', JSON_ARRAY(10 + n % 40, 5 + n % 20, 2 + n % 10)),
  n % 17 = 0
FROM seq;

CREATE TABLE customers (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  customer_no CHAR(7) NOT NULL,
  first_name VARCHAR(50) NOT NULL,
  last_name VARCHAR(50) NOT NULL,
  email VARCHAR(150) NOT NULL,
  phone VARCHAR(40) NULL,
  birthday DATE NULL,
  street VARCHAR(120) NULL,
  zip VARCHAR(10) NULL,
  city VARCHAR(80) NULL,
  country CHAR(2) NOT NULL DEFAULT 'DE',
  newsletter BIT(1) NOT NULL DEFAULT b'0',
  credit_limit DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  notes TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_customers_no (customer_no),
  UNIQUE KEY uq_customers_email (email),
  KEY idx_customers_name (last_name, first_name),
  KEY idx_customers_city (city)
) ENGINE=InnoDB COMMENT='Kundenstamm';

INSERT INTO customers (customer_no, first_name, last_name, email, phone, birthday, street, zip, city, country, newsletter, credit_limit, notes, last_login)
WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 2000)
SELECT
  CONCAT('K', LPAD(n, 6, '0')),
  ELT(1 + (n % 20), 'Anna', 'Ben', 'Clara', 'David', 'Emma', 'Felix', 'Greta', 'Hannes', 'Ida', 'Jonas', 'Klara', 'Lukas', 'Mia', 'Noah', 'Olivia', 'Paul', 'Quentin', 'Rosa', 'Sophie', 'Tim'),
  ELT(1 + ((n DIV 20) % 20), 'Müller', 'Schmidt', 'Schneider', 'Fischer', 'Weber', 'Meyer', 'Wagner', 'Becker', 'Schulz', 'Hoffmann', 'Schäfer', 'Koch', 'Bauer', 'Richter', 'Klein', 'Wolf', 'Schröder', 'Neumann', 'Schwarz', 'Zimmermann'),
  CONCAT('kunde', n, '@example.com'),
  CASE WHEN n % 6 = 0 THEN NULL ELSE CONCAT('+49 ', 150 + (n % 30), ' ', LPAD((n * 7919) % 10000000, 7, '0')) END,
  CASE WHEN n % 15 = 0 THEN NULL ELSE DATE_ADD('1950-01-01', INTERVAL (n * 97) % 20000 DAY) END,
  CONCAT(ELT(1 + (n % 8), 'Hauptstraße', 'Bahnhofstraße', 'Gartenweg', 'Schulstraße', 'Lindenallee', 'Bergstraße', 'Kirchplatz', 'Am Markt'), ' ', 1 + (n % 120)),
  LPAD(10000 + (n * 37) % 89999, 5, '0'),
  ELT(1 + (n % 12), 'Berlin', 'Hamburg', 'München', 'Köln', 'Frankfurt', 'Stuttgart', 'Düsseldorf', 'Leipzig', 'Dortmund', 'Essen', 'Bremen', 'Dresden'),
  ELT(1 + (n % 10), 'DE', 'DE', 'DE', 'DE', 'DE', 'AT', 'CH', 'DE', 'NL', 'FR'),
  CASE WHEN n % 3 = 0 THEN b'1' ELSE b'0' END,
  ROUND((n % 50) * 100, 2),
  CASE WHEN n % 11 = 0 THEN 'Stammkunde – bevorzugt Lieferung am Vormittag.' ELSE NULL END,
  CASE WHEN n % 4 = 0 THEN NULL ELSE TIMESTAMP('2026-06-01') - INTERVAL ((n * 3571) % 15552000) SECOND END
FROM seq;

CREATE TABLE orders (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_no VARCHAR(20) NOT NULL,
  customer_id INT UNSIGNED NOT NULL,
  order_date DATETIME NOT NULL,
  status ENUM('new','paid','shipped','delivered','cancelled') NOT NULL DEFAULT 'new',
  shipping_method VARCHAR(30) NULL,
  total DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  currency CHAR(3) NOT NULL DEFAULT 'EUR',
  notes VARCHAR(500) NULL,
  shipped_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_orders_no (order_no),
  KEY idx_orders_customer_date (customer_id, order_date),
  KEY idx_orders_status (status),
  CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB COMMENT='Bestellköpfe';

INSERT INTO orders (order_no, customer_id, order_date, status, shipping_method, currency, notes, shipped_at)
WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 8000)
SELECT
  CONCAT('B-2025-', LPAD(n, 6, '0')),
  1 + ((n * 7) % 2000),
  TIMESTAMP('2025-01-01') + INTERVAL ((n * 3917) % 51840000) SECOND,
  ELT(1 + (n % 5), 'new', 'paid', 'shipped', 'delivered', 'cancelled'),
  ELT(1 + (n % 4), 'DHL', 'DPD', 'Hermes', 'Abholung'),
  'EUR',
  CASE WHEN n % 25 = 0 THEN 'Bitte klingeln' ELSE NULL END,
  CASE WHEN n % 5 IN (2, 3) THEN TIMESTAMP('2025-01-02') + INTERVAL ((n * 3917) % 51840000) SECOND ELSE NULL END
FROM seq;

CREATE TABLE order_items (
  order_id BIGINT UNSIGNED NOT NULL,
  line_no SMALLINT UNSIGNED NOT NULL,
  product_id INT UNSIGNED NOT NULL,
  quantity SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  unit_price DECIMAL(10,2) NOT NULL,
  discount_pct DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  PRIMARY KEY (order_id, line_no),
  KEY idx_order_items_product (product_id),
  CONSTRAINT fk_order_items_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE,
  CONSTRAINT fk_order_items_product FOREIGN KEY (product_id) REFERENCES products (id),
  CONSTRAINT chk_order_items_qty CHECK (quantity > 0)
) ENGINE=InnoDB COMMENT='Bestellpositionen';

INSERT INTO order_items (order_id, line_no, product_id, quantity, unit_price, discount_pct)
SELECT o.id, l.line_no, p.id, 1 + ((o.id + l.line_no) % 5), p.price,
       CASE WHEN (o.id + l.line_no) % 7 = 0 THEN 10.00 ELSE 0.00 END
FROM orders o
JOIN (SELECT 1 AS line_no UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4) l ON l.line_no <= 1 + (o.id % 4)
JOIN products p ON p.id = 1 + ((o.id * 31 + l.line_no * 17) % 500);

UPDATE orders o
JOIN (SELECT order_id, SUM(quantity * unit_price * (1 - discount_pct / 100)) AS s FROM order_items GROUP BY order_id) t
  ON t.order_id = o.id
SET o.total = ROUND(t.s, 2);

CREATE TABLE employees (
  id SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  manager_id SMALLINT UNSIGNED NULL,
  first_name VARCHAR(50) NOT NULL,
  last_name VARCHAR(50) NOT NULL,
  email VARCHAR(150) NOT NULL UNIQUE,
  department ENUM('Geschäftsführung','Vertrieb','Einkauf','Lager','IT','Buchhaltung') NOT NULL,
  hire_date DATE NOT NULL,
  salary DECIMAL(10,2) NULL,
  photo BLOB NULL,
  CONSTRAINT fk_employees_manager FOREIGN KEY (manager_id) REFERENCES employees (id) ON DELETE SET NULL
) ENGINE=InnoDB COMMENT='Mitarbeiter (selbstreferenzierend)';

INSERT INTO employees (id, manager_id, first_name, last_name, email, department, hire_date, salary) VALUES
  (1, NULL, 'Katrin', 'Stein', 'k.stein@ks-shop.example', 'Geschäftsführung', '2012-04-01', 145000.00),
  (2, 1, 'Oliver', 'Brandt', 'o.brandt@ks-shop.example', 'Vertrieb', '2014-09-15', 88000.00),
  (3, 1, 'Miriam', 'Hahn', 'm.hahn@ks-shop.example', 'Einkauf', '2015-02-01', 79000.00),
  (4, 1, 'Stefan', 'Vogel', 's.vogel@ks-shop.example', 'IT', '2016-06-01', 92000.00),
  (5, 1, 'Julia', 'Lang', 'j.lang@ks-shop.example', 'Buchhaltung', '2017-01-10', 74000.00);

INSERT INTO employees (manager_id, first_name, last_name, email, department, hire_date, salary)
WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 35)
SELECT 2 + (n % 4),
       ELT(1 + (n % 10), 'Lena', 'Max', 'Sara', 'Tom', 'Nina', 'Erik', 'Lisa', 'Jan', 'Eva', 'Kai'),
       ELT(1 + ((n * 3) % 10), 'Braun', 'Krause', 'Frank', 'Berger', 'Graf', 'Roth', 'Kaiser', 'Busch', 'Lorenz', 'Horn'),
       CONCAT('mitarbeiter', n, '@ks-shop.example'),
       ELT(1 + (n % 5), 'Vertrieb', 'Einkauf', 'Lager', 'IT', 'Buchhaltung'),
       DATE_ADD('2016-01-01', INTERVAL n * 61 DAY),
       CASE WHEN n % 8 = 0 THEN NULL ELSE 38000 + (n * 1270) % 40000 END
FROM seq;

CREATE TABLE audit_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  table_name VARCHAR(64) NOT NULL,
  action ENUM('INSERT','UPDATE','DELETE') NOT NULL,
  row_id BIGINT UNSIGNED NULL,
  changed_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  payload JSON NULL,
  KEY idx_audit_table_time (table_name, changed_at)
) ENGINE=InnoDB COMMENT='Änderungsprotokoll (per Trigger befüllt)';

CREATE TABLE page_views (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  url VARCHAR(255) NOT NULL,
  referrer VARCHAR(255) NULL,
  ip VARBINARY(16) NULL,
  user_agent VARCHAR(255) NULL,
  viewed_at DATETIME NOT NULL,
  duration_ms INT UNSIGNED NOT NULL DEFAULT 0,
  KEY idx_page_views_time (viewed_at)
) ENGINE=InnoDB COMMENT='Große Tabelle (200.000 Zeilen) für Paging-Tests';

INSERT INTO page_views (url, referrer, ip, user_agent, viewed_at, duration_ms)
WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 200000)
SELECT
  CONCAT('/', ELT(1 + (n % 8), 'produkte', 'kategorie', 'warenkorb', 'kasse', 'suche', 'konto', 'hilfe', 'blog'), '/', n % 500),
  CASE n % 4 WHEN 0 THEN 'https://www.google.com/' WHEN 1 THEN NULL WHEN 2 THEN 'https://www.bing.com/' ELSE 'https://news.example.org/' END,
  INET6_ATON(CONCAT('192.168.', (n DIV 256) % 256, '.', n % 256)),
  ELT(1 + (n % 4), 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)', 'Mozilla/5.0 (X11; Linux x86_64)'),
  TIMESTAMP('2026-01-01') + INTERVAL (n * 131) SECOND,
  (n * 7) % 60000
FROM seq;

CREATE TABLE stores (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  city VARCHAR(80) NOT NULL,
  location POINT NOT NULL SRID 4326,
  opened_on DATE NULL,
  SPATIAL INDEX sp_stores_location (location)
) ENGINE=InnoDB COMMENT='Filialen mit Geodaten';

INSERT INTO stores (name, city, location, opened_on) VALUES
  ('KS Store Berlin Mitte', 'Berlin', ST_GeomFromText('POINT(52.5200 13.4050)', 4326), '2019-03-01'),
  ('KS Store Hamburg', 'Hamburg', ST_GeomFromText('POINT(53.5511 9.9937)', 4326), '2020-05-15'),
  ('KS Store München', 'München', ST_GeomFromText('POINT(48.1351 11.5820)', 4326), '2021-09-01'),
  ('KS Store Köln', 'Köln', ST_GeomFromText('POINT(50.9375 6.9603)', 4326), NULL);

CREATE TABLE settings_kv (
  k VARCHAR(60) NOT NULL,
  v TEXT NULL,
  updated_at DATETIME NULL
) ENGINE=InnoDB COMMENT='Tabelle ohne Primärschlüssel';

INSERT INTO settings_kv VALUES
  ('shop.name', 'KS Demo Shop', NOW()),
  ('shop.currency', 'EUR', NOW()),
  ('mail.sender', 'shop@example.com', NULL),
  ('stats.refreshed', NULL, NULL),
  ('feature.beta', '1', NULL),
  ('feature.beta', '1', NULL);

CREATE TABLE all_types (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  c_tinyint TINYINT NULL,
  c_smallint SMALLINT NULL,
  c_mediumint MEDIUMINT NULL,
  c_int INT NULL,
  c_bigint BIGINT UNSIGNED NULL,
  c_decimal DECIMAL(20,6) NULL,
  c_float FLOAT NULL,
  c_double DOUBLE NULL,
  c_bit BIT(8) NULL,
  c_bool BOOLEAN NULL,
  c_date DATE NULL,
  c_datetime DATETIME(6) NULL,
  c_timestamp TIMESTAMP NULL,
  c_time TIME(3) NULL,
  c_year YEAR NULL,
  c_char CHAR(10) NULL,
  c_varchar VARCHAR(255) NULL,
  c_binary BINARY(16) NULL,
  c_varbinary VARBINARY(64) NULL,
  c_tinytext TINYTEXT NULL,
  c_text TEXT NULL,
  c_mediumtext MEDIUMTEXT NULL,
  c_longtext LONGTEXT NULL,
  c_tinyblob TINYBLOB NULL,
  c_blob BLOB NULL,
  c_mediumblob MEDIUMBLOB NULL,
  c_longblob LONGBLOB NULL,
  c_enum ENUM('rot','grün','blau') NULL,
  c_set SET('a','b','c','d') NULL,
  c_json JSON NULL,
  c_geometry GEOMETRY NULL,
  c_point POINT NULL,
  c_linestring LINESTRING NULL,
  c_polygon POLYGON NULL,
  c_invisible INT NULL DEFAULT 42 INVISIBLE,
  c_generated VARCHAR(300) AS (CONCAT(c_char, '-', c_varchar)) VIRTUAL
) ENGINE=InnoDB COMMENT='Alle MySQL-Datentypen';

INSERT INTO all_types (c_tinyint, c_smallint, c_mediumint, c_int, c_bigint, c_decimal, c_float, c_double, c_bit, c_bool,
  c_date, c_datetime, c_timestamp, c_time, c_year, c_char, c_varchar, c_binary, c_varbinary,
  c_tinytext, c_text, c_mediumtext, c_longtext, c_tinyblob, c_blob, c_mediumblob, c_longblob,
  c_enum, c_set, c_json, c_geometry, c_point, c_linestring, c_polygon) VALUES
  (-128, -32768, -8388608, -2147483648, 18446744073709551615, 12345678901234.123456, 3.14159, 2.718281828459045, b'10101010', TRUE,
   '2026-09-13', '2026-09-13 17:45:12.123456', '2026-09-13 17:45:12', '23:59:59.999', 2026, 'abc', 'Grüße aus Köln 😀', UUID_TO_BIN(UUID()), X'DEADBEEF',
   'tiny', 'Ein längerer Text\nmit Zeilenumbruch', 'medium', 'long', X'00FF', X'89504E470D0A1A0A', NULL, NULL,
   'grün', 'a,c', '{"name": "Test", "list": [1, 2, 3], "nested": {"ok": true}}',
   ST_GeomFromText('POINT(1 1)'), ST_GeomFromText('POINT(13.4 52.5)'), ST_GeomFromText('LINESTRING(0 0, 1 1, 2 1)'), ST_GeomFromText('POLYGON((0 0, 4 0, 4 4, 0 4, 0 0))')),
  (127, 32767, 8388607, 2147483647, 0, -0.000001, -1.5, 1e300, b'00000001', FALSE,
   '1970-01-01', '1000-01-01 00:00:00.000000', '1970-01-02 00:00:00', '-838:59:59.000', 1901, '', '', NULL, X'',
   '', '', '', '', X'', X'', NULL, NULL,
   'rot', '', '[]', NULL, NULL, NULL, NULL),
  (NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);

-- Views ---------------------------------------------------------------------
CREATE VIEW v_order_summary AS
SELECT o.id AS order_id, o.order_no, o.order_date, o.status,
       CONCAT(c.first_name, ' ', c.last_name) AS customer, c.city,
       COUNT(i.line_no) AS items, COALESCE(SUM(i.quantity), 0) AS quantity, o.total
FROM orders o
JOIN customers c ON c.id = o.customer_id
LEFT JOIN order_items i ON i.order_id = o.id
GROUP BY o.id, o.order_no, o.order_date, o.status, c.first_name, c.last_name, c.city, o.total;

CREATE VIEW v_active_products AS
SELECT id, sku, name, price, stock, status FROM products WHERE status = 'active'
WITH CASCADED CHECK OPTION;

CREATE ALGORITHM=TEMPTABLE SQL SECURITY INVOKER VIEW v_customer_revenue AS
SELECT c.id, c.customer_no, c.last_name, c.first_name, COUNT(o.id) AS orders, COALESCE(SUM(o.total), 0) AS revenue
FROM customers c LEFT JOIN orders o ON o.customer_id = c.id
GROUP BY c.id, c.customer_no, c.last_name, c.first_name;

-- Routines, triggers, events --------------------------------------------------
DELIMITER $$

CREATE FUNCTION fn_order_total(p_order_id BIGINT UNSIGNED) RETURNS DECIMAL(12,2)
  READS SQL DATA
  COMMENT 'Summe einer Bestellung'
BEGIN
  DECLARE v_total DECIMAL(12,2);
  SELECT COALESCE(SUM(quantity * unit_price * (1 - discount_pct / 100)), 0) INTO v_total
  FROM order_items WHERE order_id = p_order_id;
  RETURN ROUND(v_total, 2);
END$$

CREATE FUNCTION fn_full_name(p_first VARCHAR(50), p_last VARCHAR(50)) RETURNS VARCHAR(101)
  DETERMINISTIC NO SQL
RETURN CONCAT_WS(' ', p_first, p_last)$$

CREATE PROCEDURE sp_customer_orders(IN p_customer_id INT UNSIGNED)
  READS SQL DATA
  COMMENT 'Bestellungen eines Kunden'
BEGIN
  SELECT o.id, o.order_no, o.order_date, o.status, o.total
  FROM orders o WHERE o.customer_id = p_customer_id ORDER BY o.order_date DESC;
END$$

CREATE PROCEDURE sp_restock(IN p_product_id INT UNSIGNED, IN p_qty INT, OUT p_new_stock INT)
  MODIFIES SQL DATA
BEGIN
  IF p_qty <= 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Menge muss positiv sein';
  END IF;
  UPDATE products SET stock = stock + p_qty WHERE id = p_product_id;
  SELECT stock INTO p_new_stock FROM products WHERE id = p_product_id;
END$$

CREATE PROCEDURE sp_monthly_report(IN p_year INT, IN p_month INT)
  READS SQL DATA
BEGIN
  SELECT DATE(order_date) AS day, COUNT(*) AS orders, SUM(total) AS revenue
  FROM orders WHERE YEAR(order_date) = p_year AND MONTH(order_date) = p_month
  GROUP BY DATE(order_date) ORDER BY day;
  SELECT status, COUNT(*) AS orders
  FROM orders WHERE YEAR(order_date) = p_year AND MONTH(order_date) = p_month
  GROUP BY status;
END$$

CREATE TRIGGER trg_order_items_ai AFTER INSERT ON order_items FOR EACH ROW
BEGIN
  UPDATE products SET stock = stock - NEW.quantity WHERE id = NEW.product_id;
  INSERT INTO audit_log (table_name, action, row_id, payload)
  VALUES ('order_items', 'INSERT', NEW.order_id, JSON_OBJECT('line_no', NEW.line_no, 'product_id', NEW.product_id, 'quantity', NEW.quantity));
END$$

CREATE TRIGGER trg_products_au AFTER UPDATE ON products FOR EACH ROW
BEGIN
  IF NOT (OLD.price <=> NEW.price) THEN
    INSERT INTO audit_log (table_name, action, row_id, payload)
    VALUES ('products', 'UPDATE', NEW.id, JSON_OBJECT('old_price', OLD.price, 'new_price', NEW.price));
  END IF;
END$$

CREATE TRIGGER trg_customers_bi BEFORE INSERT ON customers FOR EACH ROW
SET NEW.country = UPPER(NEW.country)$$

CREATE EVENT ev_purge_audit_log
  ON SCHEDULE EVERY 1 DAY STARTS '2026-01-01 03:00:00'
  ON COMPLETION PRESERVE ENABLE
  COMMENT 'Alte Audit-Einträge löschen'
DO DELETE FROM audit_log WHERE changed_at < NOW() - INTERVAL 90 DAY$$

CREATE EVENT ev_refresh_stats
  ON SCHEDULE EVERY 1 HOUR
  ON COMPLETION PRESERVE DISABLE
DO BEGIN
  UPDATE settings_kv SET v = NOW(), updated_at = NOW() WHERE k = 'stats.refreshed';
END$$

DELIMITER ;

-- ════════════════════════════════════════════════════════════════════
-- ks_hr: second database (data transfer tests)
-- ════════════════════════════════════════════════════════════════════
DROP DATABASE IF EXISTS ks_hr;
CREATE DATABASE ks_hr CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE ks_hr;

CREATE TABLE departments (
  id SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(80) NOT NULL UNIQUE,
  budget DECIMAL(14,2) NULL,
  location VARCHAR(80) NULL
) ENGINE=InnoDB;

INSERT INTO departments (name, budget, location) VALUES
  ('Vertrieb', 1200000, 'Berlin'), ('Einkauf', 450000, 'Hamburg'), ('Lager', 300000, 'Leipzig'),
  ('IT', 900000, 'Berlin'), ('Buchhaltung', 250000, 'Berlin'), ('Marketing', 600000, 'München');

CREATE TABLE staff (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  department_id SMALLINT UNSIGNED NULL,
  first_name VARCHAR(50) NOT NULL,
  last_name VARCHAR(50) NOT NULL,
  email VARCHAR(150) NOT NULL UNIQUE,
  hired DATE NOT NULL,
  salary DECIMAL(10,2) NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  CONSTRAINT fk_staff_department FOREIGN KEY (department_id) REFERENCES departments (id) ON DELETE SET NULL
) ENGINE=InnoDB;

INSERT INTO staff (department_id, first_name, last_name, email, hired, salary, active)
WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 120)
SELECT 1 + (n % 6),
       ELT(1 + (n % 8), 'Aylin', 'Björn', 'Carla', 'Deniz', 'Elif', 'Frank', 'Gül', 'Henrik'),
       ELT(1 + ((n * 7) % 8), 'Yilmaz', 'Nowak', 'Keller', 'Arslan', 'Jansen', 'Kovač', 'Lindner', 'Öztürk'),
       CONCAT('staff', n, '@ks-hr.example'),
       DATE_ADD('2010-01-01', INTERVAL n * 29 DAY),
       40000 + (n * 997) % 50000,
       n % 9 <> 0
FROM seq;

CREATE TABLE salary_history (
  staff_id INT UNSIGNED NOT NULL,
  valid_from DATE NOT NULL,
  salary DECIMAL(10,2) NOT NULL,
  PRIMARY KEY (staff_id, valid_from),
  CONSTRAINT fk_salary_staff FOREIGN KEY (staff_id) REFERENCES staff (id) ON DELETE CASCADE
) ENGINE=InnoDB;

INSERT INTO salary_history (staff_id, valid_from, salary)
SELECT id, hired, ROUND(salary * 0.9, 2) FROM staff
UNION ALL
SELECT id, DATE_ADD(hired, INTERVAL 2 YEAR), salary FROM staff;

-- ════════════════════════════════════════════════════════════════════
-- ks_shop_staging: variant of ks_shop (structure / data synchronization tests)
-- ════════════════════════════════════════════════════════════════════
DROP DATABASE IF EXISTS ks_shop_staging;
CREATE DATABASE ks_shop_staging CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE ks_shop_staging;

CREATE TABLE categories LIKE ks_shop.categories;
CREATE TABLE suppliers LIKE ks_shop.suppliers;
CREATE TABLE products LIKE ks_shop.products;
ALTER TABLE products
  DROP COLUMN weight_kg,
  MODIFY name VARCHAR(150) NOT NULL,
  ADD COLUMN ean CHAR(13) NULL AFTER sku,
  DROP INDEX ft_products_name_desc,
  ADD INDEX idx_products_status (status);
CREATE TABLE customers LIKE ks_shop.customers;
ALTER TABLE customers DROP COLUMN notes;
CREATE TABLE wishlist (
  customer_id INT UNSIGNED NOT NULL,
  product_id INT UNSIGNED NOT NULL,
  added_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (customer_id, product_id)
) ENGINE=InnoDB;

INSERT INTO categories SELECT * FROM ks_shop.categories WHERE id <= 8;
UPDATE categories SET description = 'Geändert in Staging' WHERE id = 1;
INSERT INTO suppliers SELECT * FROM ks_shop.suppliers;
DELETE FROM suppliers WHERE id = 8;
INSERT INTO suppliers (name, country) VALUES ('Nur-in-Staging GmbH', 'AT');

-- ════════════════════════════════════════════════════════════════════
-- Users and roles (user management tests)
-- ════════════════════════════════════════════════════════════════════
DROP USER IF EXISTS 'app_reader'@'%', 'app_writer'@'localhost', 'reporting'@'%';
DROP ROLE IF EXISTS 'r_reporting';

CREATE USER 'app_reader'@'%' IDENTIFIED BY 'Reader#2026' COMMENT 'Nur lesender Zugriff';
GRANT SELECT ON ks_shop.* TO 'app_reader'@'%';
GRANT SELECT (id, sku, name, price) ON ks_shop.products TO 'app_reader'@'%';

CREATE USER 'app_writer'@'localhost' IDENTIFIED BY 'Writer#2026' WITH MAX_QUERIES_PER_HOUR 5000;
GRANT SELECT, INSERT, UPDATE, DELETE ON ks_shop.* TO 'app_writer'@'localhost';
GRANT EXECUTE ON PROCEDURE ks_shop.sp_restock TO 'app_writer'@'localhost';

CREATE ROLE 'r_reporting';
GRANT SELECT ON ks_shop.v_order_summary TO 'r_reporting';
GRANT SELECT ON ks_shop.v_customer_revenue TO 'r_reporting';

CREATE USER 'reporting'@'%' IDENTIFIED BY 'Report#2026' PASSWORD EXPIRE INTERVAL 90 DAY;
GRANT 'r_reporting' TO 'reporting'@'%';
SET DEFAULT ROLE 'r_reporting' TO 'reporting'@'%';

FLUSH PRIVILEGES;
