const db = require('../config/database');

/**
 * ODP SERVICE
 * Mengelola data Optical Distribution Point (ODP)
 */

function getAllOdps() {
  return db.prepare(`
    SELECT o.*, olt.name as olt_name 
    FROM odps o 
    LEFT JOIN olts olt ON o.olt_id = olt.id 
    ORDER BY o.name ASC
  `).all();
}

function getOdpById(id) {
  return db.prepare('SELECT * FROM odps WHERE id = ?').get(id);
}

function createOdp(data) {
  const stmt = db.prepare(`
    INSERT INTO odps (name, olt_id, pon_port, port_capacity, lat, lng, description)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  return stmt.run(
    data.name,
    data.olt_id ? parseInt(data.olt_id) : null,
    data.pon_port || '',
    data.port_capacity !== undefined && data.port_capacity !== null ? parseInt(data.port_capacity) : 16,
    data.lat || '',
    data.lng || '',
    data.description || ''
  );
}

function updateOdp(id, data) {
  const stmt = db.prepare(`
    UPDATE odps 
    SET name = ?, olt_id = ?, pon_port = ?, port_capacity = ?, lat = ?, lng = ?, description = ?
    WHERE id = ?
  `);
  return stmt.run(
    data.name,
    data.olt_id ? parseInt(data.olt_id) : null,
    data.pon_port || '',
    data.port_capacity !== undefined && data.port_capacity !== null ? parseInt(data.port_capacity) : 16,
    data.lat || '',
    data.lng || '',
    data.description || '',
    id
  );
}

function deleteOdp(id) {
  return db.prepare('DELETE FROM odps WHERE id = ?').run(id);
}

function getOdpPortUsage(odpId) {
  const odp = getOdpById(odpId);
  if (!odp) return null;
  const usedRaw = db.prepare("SELECT pon_port FROM customers WHERE odp_id = ? AND pon_port IS NOT NULL AND TRIM(pon_port) != ''").all(odpId);
  const usedPorts = Array.from(new Set(usedRaw.map(r => String(r.pon_port).trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'id-ID', { numeric: true }));
  const capacity = Number(odp.port_capacity || 16) || 16;
  const usedCount = usedPorts.length;
  const remaining = Math.max(0, capacity - usedCount);
  return { odpId: Number(odpId), capacity, usedCount, remaining, usedPorts };
}

module.exports = {
  getAllOdps,
  getOdpById,
  createOdp,
  updateOdp,
  deleteOdp,
  getOdpPortUsage
};
