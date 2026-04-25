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

  CREATE TABLE IF NOT EXISTS olts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    snmp_community TEXT DEFAULT 'public',
    snmp_port INTEGER DEFAULT 161,
    brand TEXT DEFAULT 'zte', -- zte, huawei, vsol, hioso, hsqg, etc.
    description TEXT DEFAULT '',
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS odps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    olt_id INTEGER REFERENCES olts(id) ON DELETE SET NULL,
    pon_port TEXT DEFAULT '',
    port_capacity INTEGER NOT NULL DEFAULT 16,
    lat TEXT,
    lng TEXT,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS voucher_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    router_id INTEGER REFERENCES routers(id) ON DELETE SET NULL,
    profile_name TEXT NOT NULL,
    qty_total INTEGER NOT NULL DEFAULT 0,
    qty_created INTEGER NOT NULL DEFAULT 0,
    qty_failed INTEGER NOT NULL DEFAULT 0,
    price INTEGER NOT NULL DEFAULT 0,
    validity TEXT DEFAULT '',
    prefix TEXT DEFAULT '',
    code_length INTEGER NOT NULL DEFAULT 4,
    status TEXT DEFAULT 'creating',
    created_by TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS vouchers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id INTEGER NOT NULL REFERENCES voucher_batches(id) ON DELETE CASCADE,
    router_id INTEGER REFERENCES routers(id) ON DELETE SET NULL,
    code TEXT NOT NULL,
    password TEXT NOT NULL,
    profile_name TEXT NOT NULL,
    comment TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    used_at DATETIME,
    last_seen_comment TEXT DEFAULT '',
    last_seen_uptime TEXT DEFAULT '',
    last_seen_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(router_id, code)
  );

  CREATE TABLE IF NOT EXISTS public_voucher_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    router_id INTEGER REFERENCES routers(id) ON DELETE SET NULL,
    profile_name TEXT NOT NULL,
    validity TEXT DEFAULT '',
    price INTEGER NOT NULL DEFAULT 0,
    buyer_phone TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    paid_at DATETIME,
    fulfilled_at DATETIME,
    voucher_code TEXT DEFAULT '',
    voucher_password TEXT DEFAULT '',
    voucher_comment TEXT DEFAULT '',
    wa_sent INTEGER NOT NULL DEFAULT 0,
    wa_sent_at DATETIME,
    wa_error TEXT DEFAULT '',
    payment_gateway TEXT DEFAULT '',
    payment_order_id TEXT DEFAULT '',
    payment_link TEXT DEFAULT '',
    payment_reference TEXT DEFAULT '',
    payment_payload TEXT,
    payment_expires_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS agents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    name TEXT NOT NULL,
    phone TEXT DEFAULT '',
    balance INTEGER NOT NULL DEFAULT 0,
    billing_fee INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS agent_hotspot_prices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    router_id INTEGER REFERENCES routers(id) ON DELETE SET NULL,
    profile_name TEXT NOT NULL,
    validity TEXT DEFAULT '',
    buy_price INTEGER NOT NULL DEFAULT 0,
    sell_price INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(agent_id, router_id, profile_name)
  );

  CREATE TABLE IF NOT EXISTS agent_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    type TEXT NOT NULL, -- topup, invoice_payment, voucher_sale, adjust
    invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
    customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
    router_id INTEGER REFERENCES routers(id) ON DELETE SET NULL,
    profile_name TEXT DEFAULT '',
    voucher_code TEXT DEFAULT '',
    voucher_password TEXT DEFAULT '',
    amount_invoice INTEGER NOT NULL DEFAULT 0,
    amount_buy INTEGER NOT NULL DEFAULT 0,
    amount_sell INTEGER NOT NULL DEFAULT 0,
    fee INTEGER NOT NULL DEFAULT 0,
    balance_before INTEGER NOT NULL DEFAULT 0,
    balance_after INTEGER NOT NULL DEFAULT 0,
    note TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_voucher_batches_router ON voucher_batches(router_id);
  CREATE INDEX IF NOT EXISTS idx_vouchers_batch ON vouchers(batch_id);
  CREATE INDEX IF NOT EXISTS idx_vouchers_code ON vouchers(code);
  CREATE INDEX IF NOT EXISTS idx_public_voucher_orders_status ON public_voucher_orders(status);
  CREATE INDEX IF NOT EXISTS idx_public_voucher_orders_created ON public_voucher_orders(created_at);

  CREATE INDEX IF NOT EXISTS idx_agents_username ON agents(username);
  CREATE INDEX IF NOT EXISTS idx_agent_prices_agent ON agent_hotspot_prices(agent_id);
  CREATE INDEX IF NOT EXISTS idx_agent_prices_router_profile ON agent_hotspot_prices(router_id, profile_name);
  CREATE INDEX IF NOT EXISTS idx_agent_tx_agent ON agent_transactions(agent_id);
  CREATE INDEX IF NOT EXISTS idx_agent_tx_created ON agent_transactions(created_at);
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
try {
  db.exec("ALTER TABLE customers ADD COLUMN olt_id INTEGER REFERENCES olts(id) ON DELETE SET NULL");
} catch (e) { /* ignore if already exists */ }
try {
  db.exec("ALTER TABLE customers ADD COLUMN pon_port TEXT DEFAULT ''");
} catch (e) { /* ignore if already exists */ }
try {
  db.exec("ALTER TABLE customers ADD COLUMN odp_id INTEGER REFERENCES odps(id) ON DELETE SET NULL");
} catch (e) { /* ignore if already exists */ }
try {
  db.exec("ALTER TABLE customers ADD COLUMN lat TEXT");
} catch (e) { /* ignore if already exists */ }
try {
  db.exec("ALTER TABLE customers ADD COLUMN lng TEXT");
} catch (e) { /* ignore if already exists */ }
try {
  db.exec("ALTER TABLE odps ADD COLUMN port_capacity INTEGER NOT NULL DEFAULT 16");
} catch (e) { /* ignore if already exists */ }

// Kolom untuk Payment Gateway di tabel invoices
try { db.exec("ALTER TABLE invoices ADD COLUMN payment_gateway TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE invoices ADD COLUMN payment_order_id TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE invoices ADD COLUMN payment_link TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE invoices ADD COLUMN payment_reference TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE invoices ADD COLUMN payment_payload TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE invoices ADD COLUMN payment_expires_at DATETIME"); } catch (e) {}

// Kolom untuk Login OLT (Web/API)
try { db.exec("ALTER TABLE olts ADD COLUMN web_user TEXT DEFAULT 'admin'"); } catch (e) {}
try { db.exec("ALTER TABLE olts ADD COLUMN web_password TEXT DEFAULT 'admin'"); } catch (e) {}

try { db.exec("ALTER TABLE voucher_batches ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP"); } catch (e) {}
try { db.exec("ALTER TABLE vouchers ADD COLUMN last_seen_comment TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE vouchers ADD COLUMN last_seen_uptime TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE vouchers ADD COLUMN last_seen_at DATETIME"); } catch (e) {}
try { db.exec("ALTER TABLE voucher_batches ADD COLUMN mode TEXT DEFAULT 'voucher'"); } catch (e) {}
try { db.exec("ALTER TABLE voucher_batches ADD COLUMN charset TEXT DEFAULT 'numbers'"); } catch (e) {}

module.exports = db;
