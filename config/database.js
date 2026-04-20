/**
 * Inisialisasi database SQLite untuk billing RTRWnet
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbDir = path.join(__dirname, '../database');
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const dbPath = path.join(dbDir, 'billing.db');

let db;
try {
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
} catch (err) {
  console.error('[DB] Gagal membuka database:', err.message);
  process.exit(1);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS packages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    price INTEGER NOT NULL DEFAULT 0,
    speed_down INTEGER DEFAULT 0,
    speed_up INTEGER DEFAULT 0,
    description TEXT DEFAULT '',
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT DEFAULT '',
    address TEXT DEFAULT '',
    package_id INTEGER REFERENCES packages(id) ON DELETE SET NULL,
    genieacs_tag TEXT DEFAULT '',
    pppoe_username TEXT DEFAULT '',
    isolir_profile TEXT DEFAULT 'isolir',
    status TEXT DEFAULT 'active',
    install_date DATE,
    notes TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS technicians (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    name TEXT NOT NULL,
    phone TEXT DEFAULT '',
    area TEXT DEFAULT '',
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS cashiers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    name TEXT NOT NULL,
    phone TEXT DEFAULT '',
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    period_month INTEGER NOT NULL,
    period_year INTEGER NOT NULL,
    amount INTEGER NOT NULL DEFAULT 0,
    status TEXT DEFAULT 'unpaid',
    paid_at DATETIME,
    paid_by_name TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    subject TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT DEFAULT 'open', -- open, in_progress, resolved
    technician_id INTEGER REFERENCES technicians(id) ON DELETE SET NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS routers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER DEFAULT 8728,
    user TEXT NOT NULL,
    password TEXT NOT NULL,
    description TEXT DEFAULT '',
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Tambahkan kolom baru jika belum ada
try {
  db.exec("ALTER TABLE customers ADD COLUMN auto_isolate INTEGER DEFAULT 1");
} catch (e) { /* ignore if already exists */ }
try {
  db.exec("ALTER TABLE customers ADD COLUMN isolate_day INTEGER DEFAULT 10");
} catch (e) { /* ignore if already exists */ }
try {
  db.exec("ALTER TABLE customers ADD COLUMN email TEXT DEFAULT ''");
} catch (e) { /* ignore if already exists */ }
try {
  db.exec("ALTER TABLE customers ADD COLUMN router_id INTEGER REFERENCES routers(id) ON DELETE SET NULL");
} catch (e) { /* ignore if already exists */ }

// Kolom untuk Payment Gateway di tabel invoices
try { db.exec("ALTER TABLE invoices ADD COLUMN payment_gateway TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE invoices ADD COLUMN payment_order_id TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE invoices ADD COLUMN payment_link TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE invoices ADD COLUMN payment_reference TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE invoices ADD COLUMN payment_payload TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE invoices ADD COLUMN payment_expires_at DATETIME"); } catch (e) {}

module.exports = db;
