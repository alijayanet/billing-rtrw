/**
 * Service: Manajemen Inventaris / Gudang (Warehouse)
 * Sistem Pelacakan Stok, Pemasukan, Pengeluaran & Sisa Stok Terintegrasi
 */
const db = require('../config/database');
const { logger } = require('../config/logger');

// ─── DEFAULT CATEGORIES SEEDER ───────────────────────────────────────────
function seedDefaultCategories() {
  try {
    const count = db.prepare('SELECT count(*) as c FROM inventory_categories').get().c;
    if (count === 0) {
      const defaults = [
        ['Router & ONT', 'Modem ONT GPON/EPON, Router WiFi, Access Point, Wireless Bridge'],
        ['Kabel & Drop Core', 'Kabel Fiber Optic Drop Core 1-2 Core, Kabel LAN UTP Cat5e/Cat6'],
        ['Aksesoris Fiber Optic', 'Patchcord, Pigtail, Adapter SC, ODP, OTB, Roset FO, Joint Closure, Protection Sleeve'],
        ['Aksesoris LAN & Jaringan', 'Konektor RJ45, Switch Hub, Barrel LAN, Faceplate, Modular Jack'],
        ['Aksesoris Tiang & Outdoor', 'Klem Buaya, Span Wartel, Hook S, Stainless Band, Bracket Tiang'],
        ['Power & Adaptor', 'Adaptor 12V 1A/2A, POE Injector, UPS Mini DC, Kabel Power']
      ];
      const insert = db.prepare('INSERT OR IGNORE INTO inventory_categories (name, description) VALUES (?, ?)');
      defaults.forEach(([name, desc]) => insert.run(name, desc));
    }
  } catch (e) {
    logger.error('Failed to seed default inventory categories: ' + e.message);
  }
}

// ─── CATEGORIES ───────────────────────────────────────────────────────────
function getAllCategories() {
  seedDefaultCategories();
  return db.prepare(`
    SELECT c.*, 
           (SELECT count(*) FROM inventory_items i WHERE i.category_id = c.id) as item_count
    FROM inventory_categories c 
    ORDER BY c.name ASC
  `).all();
}

function createCategory(data) {
  const { name, description } = data;
  if (!name || !name.trim()) throw new Error('Nama kategori wajib diisi');
  return db.prepare('INSERT INTO inventory_categories (name, description) VALUES (?, ?)').run(name.trim(), description || '');
}

function updateCategory(id, data) {
  const { name, description } = data;
  if (!name || !name.trim()) throw new Error('Nama kategori wajib diisi');
  return db.prepare('UPDATE inventory_categories SET name = ?, description = ? WHERE id = ?').run(name.trim(), description || '', id);
}

function deleteCategory(id) {
  const itemsCount = db.prepare('SELECT count(*) as c FROM inventory_items WHERE category_id = ?').get(id)?.c || 0;
  if (itemsCount > 0) {
    throw new Error(`Tidak dapat menghapus kategori karena masih memiliki ${itemsCount} jenis barang terkait.`);
  }
  return db.prepare('DELETE FROM inventory_categories WHERE id = ?').run(id);
}

// ─── HELPER STOCK COUNT ───────────────────────────────────────────────────
function getItemAvailableStock(itemId) {
  const res = db.prepare(`
    SELECT COALESCE(SUM(quantity), 0) as total
    FROM inventory_stock
    WHERE item_id = ? AND status = 'available'
  `).get(itemId);
  return Number(res?.total || 0);
}

function getItemAssignedStock(itemId) {
  const res = db.prepare(`
    SELECT COALESCE(SUM(quantity), 0) as total
    FROM inventory_stock
    WHERE item_id = ? AND status = 'assigned'
  `).get(itemId);
  return Number(res?.total || 0);
}

function getItemBrokenStock(itemId) {
  const res = db.prepare(`
    SELECT COALESCE(SUM(quantity), 0) as total
    FROM inventory_stock
    WHERE item_id = ? AND status = 'broken'
  `).get(itemId);
  return Number(res?.total || 0);
}

// ─── ITEMS ───────────────────────────────────────────────────────────────
function getAllItems(search = '', categoryId = null) {
  seedDefaultCategories();
  let query = `
    SELECT i.*, c.name as category_name, 
           COALESCE((SELECT SUM(quantity) FROM inventory_stock s WHERE s.item_id = i.id AND s.status = 'available'), 0) as stock_available,
           COALESCE((SELECT SUM(quantity) FROM inventory_stock s WHERE s.item_id = i.id AND s.status = 'assigned'), 0) as stock_assigned,
           COALESCE((SELECT SUM(quantity) FROM inventory_stock s WHERE s.item_id = i.id AND s.status = 'broken'), 0) as stock_broken
    FROM inventory_items i
    LEFT JOIN inventory_categories c ON i.category_id = c.id
    WHERE 1=1
  `;
  const params = [];
  if (categoryId) {
    query += ' AND i.category_id = ?';
    params.push(categoryId);
  }
  if (search) {
    query += ' AND (i.name LIKE ? OR i.brand LIKE ? OR i.model LIKE ? OR c.name LIKE ?)';
    const s = `%${search}%`;
    params.push(s, s, s, s);
  }
  query += ' ORDER BY i.name ASC';
  return db.prepare(query).all(...params);
}

function getItemById(id) {
  return db.prepare(`
    SELECT i.*, c.name as category_name,
           COALESCE((SELECT SUM(quantity) FROM inventory_stock s WHERE s.item_id = i.id AND s.status = 'available'), 0) as stock_available,
           COALESCE((SELECT SUM(quantity) FROM inventory_stock s WHERE s.item_id = i.id AND s.status = 'assigned'), 0) as stock_assigned,
           COALESCE((SELECT SUM(quantity) FROM inventory_stock s WHERE s.item_id = i.id AND s.status = 'broken'), 0) as stock_broken
    FROM inventory_items i
    LEFT JOIN inventory_categories c ON i.category_id = c.id
    WHERE i.id = ?
  `).get(id);
}

function getItemDetail(id) {
  const item = getItemById(id);
  if (!item) return null;

  const stockList = db.prepare(`
    SELECT s.*, cust.name as customer_name, cust.pppoe_username as pppoe_user
    FROM inventory_stock s
    LEFT JOIN customers cust ON s.assigned_to_customer_id = cust.id
    WHERE s.item_id = ?
    ORDER BY CASE WHEN s.status = 'available' THEN 1 WHEN s.status = 'assigned' THEN 2 ELSE 3 END, s.created_at DESC
  `).all(id);

  const logs = db.prepare(`
    SELECT l.*, s.serial_number
    FROM inventory_logs l
    LEFT JOIN inventory_stock s ON l.stock_id = s.id
    WHERE l.item_id = ?
    ORDER BY l.created_at DESC, l.id DESC
    LIMIT 100
  `).all(id);

  return { item, stockList, logs };
}

function createItem(data) {
  const { category_id, name, brand, model, unit, min_stock, description } = data;
  if (!name || !name.trim()) throw new Error('Nama barang wajib diisi');
  return db.prepare(`
    INSERT INTO inventory_items (category_id, name, brand, model, unit, min_stock, description)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    category_id ? Number(category_id) : null,
    name.trim(),
    brand ? brand.trim() : '',
    model ? model.trim() : '',
    unit ? unit.trim() : 'pcs',
    Number(min_stock) || 5,
    description ? description.trim() : ''
  );
}

function updateItem(id, data) {
  const { category_id, name, brand, model, unit, min_stock, description } = data;
  if (!name || !name.trim()) throw new Error('Nama barang wajib diisi');
  return db.prepare(`
    UPDATE inventory_items 
    SET category_id = ?, name = ?, brand = ?, model = ?, unit = ?, min_stock = ?, description = ?
    WHERE id = ?
  `).run(
    category_id ? Number(category_id) : null,
    name.trim(),
    brand ? brand.trim() : '',
    model ? model.trim() : '',
    unit ? unit.trim() : 'pcs',
    Number(min_stock) || 5,
    description ? description.trim() : '',
    id
  );
}

function deleteItem(id) {
  const stockCount = db.prepare('SELECT count(*) as c FROM inventory_stock WHERE item_id = ?').get(id)?.c || 0;
  if (stockCount > 0) {
    throw new Error(`Tidak dapat menghapus barang karena masih ada ${stockCount} data stok terkait. Silakan sesuaikan atau kosongkan stok terlebih dahulu.`);
  }
  return db.prepare('DELETE FROM inventory_items WHERE id = ?').run(id);
}

// ─── SERIAL NUMBERS ───────────────────────────────────────────────────────
function getAvailableSerialNumbers(itemId) {
  return db.prepare(`
    SELECT id, serial_number, condition, location, note
    FROM inventory_stock
    WHERE item_id = ? AND status = 'available' AND serial_number IS NOT NULL AND TRIM(serial_number) != ''
    ORDER BY serial_number ASC
  `).all(itemId);
}

// ─── STOCK TRANSACTIONS ───────────────────────────────────────────────────

/**
 * 1. INPUT STOK MASUK (IN)
 * Menambah stok barang dan mencatat saldo sisa stok akhir secara presisi
 */
function addStock(data, actor = 'Admin') {
  const { item_id, serial_number, quantity, condition, location, price, supplier, reference_no, note } = data;
  if (!item_id) throw new Error('Pilih barang terlebih dahulu');
  
  const item = getItemById(item_id);
  if (!item) throw new Error('Data barang tidak ditemukan');

  const cleanSn = serial_number ? serial_number.trim() : '';
  const qty = cleanSn ? 1 : Math.max(1, parseInt(quantity, 10) || 1);

  const run = db.transaction(() => {
    let stockId = null;

    if (cleanSn) {
      // Cek duplikasi SN
      const existing = db.prepare('SELECT id, status FROM inventory_stock WHERE serial_number = ?').get(cleanSn);
      if (existing) {
        throw new Error(`Serial Number "${cleanSn}" sudah pernah terdaftar di sistem (Status: ${existing.status})!`);
      }

      const res = db.prepare(`
        INSERT INTO inventory_stock (item_id, serial_number, quantity, condition, location, status, price, supplier, note)
        VALUES (?, ?, 1, ?, ?, 'available', ?, ?, ?)
      `).run(item_id, cleanSn, condition || 'new', location || 'Gudang Utama', Number(price) || 0, supplier || '', note || '');
      stockId = res.lastInsertRowid;
    } else {
      // Non-serial item
      const res = db.prepare(`
        INSERT INTO inventory_stock (item_id, serial_number, quantity, condition, location, status, price, supplier, note)
        VALUES (?, NULL, ?, ?, ?, 'available', ?, ?, ?)
      `).run(item_id, qty, condition || 'new', location || 'Gudang Utama', Number(price) || 0, supplier || '', note || '');
      stockId = res.lastInsertRowid;
    }

    // Hitung sisa stok tersedia saat ini
    const remainingStock = getItemAvailableStock(item_id);

    // Catat log stok masuk lengkap dengan sisa stok
    const logNote = note || (cleanSn ? `Stok Masuk SN: ${cleanSn}` : `Stok Masuk (+${qty} ${item.unit})`);
    db.prepare(`
      INSERT INTO inventory_logs (item_id, stock_id, type, quantity, remaining_stock, actor, recipient, reference_no, note)
      VALUES (?, ?, 'in', ?, ?, ?, ?, ?, ?)
    `).run(
      item_id,
      stockId,
      qty,
      remainingStock,
      actor || 'Admin',
      supplier || 'Gudang Utama',
      reference_no || '',
      logNote
    );

    return { stockId, remainingStock };
  });

  return run();
}

/**
 * 2. PENGELUARAN BARANG (OUT / ISSUE)
 * Mengeluarkan barang untuk instalasi baru, perbaikan, pemakaian teknisi, atau rusak
 * Mengurangi stok secara otomatis dan mencatat sisa stok akhir
 */
function issueStock(data, actor = 'Admin') {
  const { item_id, stock_id, serial_number, quantity, type, customer_id, recipient, reference_no, note } = data;
  if (!item_id) throw new Error('Pilih barang terlebih dahulu');

  const item = getItemById(item_id);
  if (!item) throw new Error('Data barang tidak ditemukan');

  const availableStock = getItemAvailableStock(item_id);
  if (availableStock <= 0) {
    throw new Error(`Stok ${item.name} saat ini kosong (0 ${item.unit})!`);
  }

  const issueType = type || (customer_id ? 'assigned' : 'out'); // 'out', 'assigned', 'broken', 'loss'

  const run = db.transaction(() => {
    let stockIdTarget = stock_id ? Number(stock_id) : null;
    let qtyToDeduct = 1;

    // A. JIKA DITARGETKAN KE SERIAL NUMBER SPESIFIK ATAU STOCK_ID SPESIFIK
    if (serial_number && !stockIdTarget) {
      const row = db.prepare('SELECT id, status FROM inventory_stock WHERE item_id = ? AND serial_number = ?').get(item_id, serial_number.trim());
      if (!row) throw new Error(`Serial Number "${serial_number}" tidak ditemukan untuk barang ini`);
      if (row.status !== 'available') throw new Error(`Barang SN "${serial_number}" statusnya "${row.status}", tidak dapat dikeluarkan!`);
      stockIdTarget = row.id;
    }

    if (stockIdTarget) {
      const stock = db.prepare('SELECT * FROM inventory_stock WHERE id = ?').get(stockIdTarget);
      if (!stock) throw new Error('Data unit stok tidak ditemukan');
      if (stock.status !== 'available') throw new Error(`Unit stok ini statusnya "${stock.status}", tidak tersedia`);

      const targetStatus = (customer_id || issueType === 'assigned') ? 'assigned' : (issueType === 'broken' ? 'broken' : 'out');
      const targetCustomer = customer_id ? Number(customer_id) : null;

      db.prepare(`
        UPDATE inventory_stock 
        SET status = ?, assigned_to_customer_id = ?, updated_at = (NOW_LOCAL())
        WHERE id = ?
      `).run(targetStatus, targetCustomer, stockIdTarget);

      qtyToDeduct = stock.quantity || 1;
    } else {
      // B. BARANG NON-SERIAL / PENGURANGAN KUANTITAS (FIFO)
      qtyToDeduct = Math.max(1, parseInt(quantity, 10) || 1);
      if (qtyToDeduct > availableStock) {
        throw new Error(`Stok tidak mencukupi! Tersedia di gudang: ${availableStock} ${item.unit}, diminta keluar: ${qtyToDeduct} ${item.unit}`);
      }

      // Ambil batch stok yang available terurut dari yang paling lama masuk (FIFO)
      const batches = db.prepare(`
        SELECT id, quantity 
        FROM inventory_stock 
        WHERE item_id = ? AND status = 'available'
        ORDER BY created_at ASC, id ASC
      `).all(item_id);

      let needed = qtyToDeduct;
      for (const b of batches) {
        if (needed <= 0) break;
        if (b.quantity <= needed) {
          db.prepare("UPDATE inventory_stock SET quantity = 0, status = 'out', updated_at = (NOW_LOCAL()) WHERE id = ?").run(b.id);
          needed -= b.quantity;
        } else {
          db.prepare("UPDATE inventory_stock SET quantity = quantity - ?, updated_at = (NOW_LOCAL()) WHERE id = ?").run(needed, b.id);
          needed = 0;
          break;
        }
      }
    }

    // Hitung sisa stok tersedia setelah pengeluaran
    const remainingStock = getItemAvailableStock(item_id);

    // Keterangan penerima (teknisi / pelanggan)
    let finalRecipient = recipient ? recipient.trim() : '';
    if (customer_id && !finalRecipient) {
      const cust = db.prepare('SELECT name, pppoe_username as pppoe_user FROM customers WHERE id = ?').get(customer_id);
      if (cust) finalRecipient = `Pelanggan: ${cust.name} (${cust.pppoe_user || '-'})`;
    }
    if (!finalRecipient) finalRecipient = 'Teknisi / Operasional';

    const logNote = note || `Pengeluaran Barang (-${qtyToDeduct} ${item.unit})`;

    // Catat log pengeluaran dengan sisa stok
    db.prepare(`
      INSERT INTO inventory_logs (item_id, stock_id, type, quantity, remaining_stock, actor, recipient, reference_no, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      item_id,
      stockIdTarget,
      issueType,
      -qtyToDeduct,
      remainingStock,
      actor || 'Admin',
      finalRecipient,
      reference_no || '',
      logNote
    );

    return { qtyDeducted: qtyToDeduct, remainingStock };
  });

  return run();
}

/**
 * 3. PENYESUAIAN STOK (STOCK OPNAME / ADJUSTMENT)
 * Menyesuaikan data sistem dengan fisik gudang dan mencatat selisih & saldo akhir
 */
function adjustStock(data, actor = 'Admin') {
  const { item_id, actual_quantity, note } = data;
  if (!item_id) throw new Error('Pilih barang terlebih dahulu');
  
  const item = getItemById(item_id);
  if (!item) throw new Error('Data barang tidak ditemukan');

  const actualQty = Math.max(0, parseInt(actual_quantity, 10));
  if (isNaN(actualQty)) throw new Error('Jumlah stok fisik harus berupa angka');

  const currentAvailable = getItemAvailableStock(item_id);
  const diff = actualQty - currentAvailable;

  if (diff === 0) {
    return { diff: 0, remainingStock: actualQty, message: 'Jumlah stok sudah sesuai, tidak ada perubahan.' };
  }

  const run = db.transaction(() => {
    if (diff > 0) {
      // Stok fisik lebih banyak dari sistem -> Tambah selisih ke stok
      db.prepare(`
        INSERT INTO inventory_stock (item_id, serial_number, quantity, condition, location, status, note)
        VALUES (?, NULL, ?, 'new', 'Gudang Utama', 'available', ?)
      `).run(item_id, diff, note || 'Penyesuaian Fisik (Opname)');
    } else {
      // Stok fisik lebih sedikit dari sistem -> Kurangi selisih dari stok yang ada
      let neededToReduce = Math.abs(diff);
      const batches = db.prepare(`
        SELECT id, quantity FROM inventory_stock 
        WHERE item_id = ? AND status = 'available'
        ORDER BY created_at ASC, id ASC
      `).all(item_id);

      for (const b of batches) {
        if (neededToReduce <= 0) break;
        if (b.quantity <= neededToReduce) {
          db.prepare("UPDATE inventory_stock SET quantity = 0, status = 'out', updated_at = (NOW_LOCAL()) WHERE id = ?").run(b.id);
          neededToReduce -= b.quantity;
        } else {
          db.prepare("UPDATE inventory_stock SET quantity = quantity - ?, updated_at = (NOW_LOCAL()) WHERE id = ?").run(neededToReduce, b.id);
          neededToReduce = 0;
          break;
        }
      }
    }

    const logNote = note || `Stock Opname (Penyesuaian Fisik: ${diff > 0 ? '+' : ''}${diff} ${item.unit})`;

    db.prepare(`
      INSERT INTO inventory_logs (item_id, stock_id, type, quantity, remaining_stock, actor, recipient, reference_no, note)
      VALUES (?, NULL, 'adjust', ?, ?, ?, 'Stock Opname', 'OPNAME', ?)
    `).run(
      item_id,
      diff,
      actualQty,
      actor || 'Admin',
      logNote
    );

    return { diff, remainingStock: actualQty };
  });

  return run();
}

/**
 * 4. PENGEMBALIAN BARANG (RETURN / COPOTAN)
 * Barang bekas / copotan dari pelanggan atau sisa pemakaian lapangan dikembalikan ke gudang
 */
function returnStock(data, actor = 'Admin') {
  const { item_id, serial_number, quantity, condition, customer_id, returned_by, note } = data;
  if (!item_id) throw new Error('Pilih barang terlebih dahulu');

  const item = getItemById(item_id);
  if (!item) throw new Error('Data barang tidak ditemukan');

  const cleanSn = serial_number ? serial_number.trim() : '';
  const qty = cleanSn ? 1 : Math.max(1, parseInt(quantity, 10) || 1);
  const cond = condition || 'used';

  const run = db.transaction(() => {
    let stockId = null;

    if (cleanSn) {
      const existing = db.prepare('SELECT id, status FROM inventory_stock WHERE serial_number = ?').get(cleanSn);
      if (existing) {
        // Kembalikan unit yang sudah ada ke gudang
        db.prepare(`
          UPDATE inventory_stock 
          SET status = 'available', condition = ?, assigned_to_customer_id = NULL, location = 'Gudang Utama', updated_at = (NOW_LOCAL()), note = ?
          WHERE id = ?
        `).run(cond, note || 'Pengembalian / Copotan', existing.id);
        stockId = existing.id;
      } else {
        const res = db.prepare(`
          INSERT INTO inventory_stock (item_id, serial_number, quantity, condition, location, status, note)
          VALUES (?, ?, 1, ?, 'Gudang Utama', 'available', ?)
        `).run(item_id, cleanSn, cond, note || 'Pengembalian / Copotan');
        stockId = res.lastInsertRowid;
      }
    } else {
      const res = db.prepare(`
        INSERT INTO inventory_stock (item_id, serial_number, quantity, condition, location, status, note)
        VALUES (?, NULL, ?, ?, 'Gudang Utama', 'available', ?)
      `).run(item_id, qty, cond, note || 'Pengembalian / Copotan');
      stockId = res.lastInsertRowid;
    }

    const remainingStock = getItemAvailableStock(item_id);

    let returner = returned_by ? returned_by.trim() : '';
    if (customer_id && !returner) {
      const cust = db.prepare('SELECT name FROM customers WHERE id = ?').get(customer_id);
      if (cust) returner = `Copotan dari: ${cust.name}`;
    }
    if (!returner) returner = 'Teknisi Lapangan';

    const logNote = note || (cleanSn ? `Pengembalian SN: ${cleanSn} (${cond})` : `Pengembalian (+${qty} ${item.unit})`);

    db.prepare(`
      INSERT INTO inventory_logs (item_id, stock_id, type, quantity, remaining_stock, actor, recipient, reference_no, note)
      VALUES (?, ?, 'return', ?, ?, ?, ?, 'RETURN', ?)
    `).run(
      item_id,
      stockId,
      qty,
      remainingStock,
      actor || 'Admin',
      returner,
      logNote
    );

    return { stockId, remainingStock };
  });

  return run();
}

/**
 * 5. RIWAYAT PERGERAKAN STOK (INVENTORY LOGS)
 */
function getInventoryLogs(options = {}) {
  const limit = options.limit ? parseInt(options.limit, 10) : 100;
  const itemId = options.itemId ? Number(options.itemId) : null;
  const type = options.type ? options.type.trim() : null;
  const search = options.search ? options.search.trim() : null;

  let query = `
    SELECT l.*, 
           i.name as item_name, 
           i.unit as item_unit, 
           i.brand as item_brand, 
           i.model as item_model,
           c.name as category_name, 
           s.serial_number
    FROM inventory_logs l
    LEFT JOIN inventory_items i ON l.item_id = i.id
    LEFT JOIN inventory_categories c ON i.category_id = c.id
    LEFT JOIN inventory_stock s ON l.stock_id = s.id
    WHERE 1=1
  `;
  const params = [];

  if (itemId) {
    query += ' AND l.item_id = ?';
    params.push(itemId);
  }
  if (type) {
    query += ' AND l.type = ?';
    params.push(type);
  }
  if (search) {
    query += ' AND (i.name LIKE ? OR s.serial_number LIKE ? OR l.recipient LIKE ? OR l.note LIKE ? OR l.reference_no LIKE ?)';
    const s = `%${search}%`;
    params.push(s, s, s, s, s);
  }

  query += ' ORDER BY l.created_at DESC, l.id DESC LIMIT ?';
  params.push(limit);

  return db.prepare(query).all(...params);
}

/**
 * 6. STATISTIK GUDANG
 */
function getInventoryStats() {
  seedDefaultCategories();
  const totalItems = db.prepare('SELECT count(*) as c FROM inventory_items').get()?.c || 0;
  const totalCategories = db.prepare('SELECT count(*) as c FROM inventory_categories').get()?.c || 0;
  
  const stockSummary = db.prepare(`
    SELECT 
      COALESCE(SUM(CASE WHEN status = 'available' THEN quantity ELSE 0 END), 0) as available,
      COALESCE(SUM(CASE WHEN status = 'assigned' THEN quantity ELSE 0 END), 0) as assigned,
      COALESCE(SUM(CASE WHEN status = 'broken' THEN quantity ELSE 0 END), 0) as broken
    FROM inventory_stock
  `).get();

  const lowStockCount = db.prepare(`
    SELECT count(*) as c FROM (
      SELECT i.id
      FROM inventory_items i
      LEFT JOIN inventory_stock s ON s.item_id = i.id AND s.status = 'available'
      GROUP BY i.id
      HAVING COALESCE(SUM(s.quantity), 0) <= i.min_stock
    )
  `).get()?.c || 0;

  return {
    total_items: totalItems,
    total_categories: totalCategories,
    total_stock_available: Number(stockSummary?.available || 0),
    total_stock_assigned: Number(stockSummary?.assigned || 0),
    total_stock_broken: Number(stockSummary?.broken || 0),
    low_stock_count: lowStockCount
  };
}

module.exports = {
  seedDefaultCategories,
  getAllCategories, createCategory, updateCategory, deleteCategory,
  getAllItems, getItemById, getItemDetail, createItem, updateItem, deleteItem,
  getAvailableSerialNumbers, getItemAvailableStock, getItemAssignedStock, getItemBrokenStock,
  addStock, issueStock, adjustStock, returnStock,
  getInventoryLogs, getInventoryStats
};
