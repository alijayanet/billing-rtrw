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
    INSERT INTO odps (name, olt_id, pon_port, lat, lng, description)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  return stmt.run(
    data.name,
    data.olt_id ? parseInt(data.olt_id) : null,
    data.pon_port || '',
    data.lat || '',
    data.lng || '',
    data.description || ''
  );
}

function updateOdp(id, data) {
  const stmt = db.prepare(`
    UPDATE odps 
    SET name = ?, olt_id = ?, pon_port = ?, lat = ?, lng = ?, description = ?
    WHERE id = ?
  `);
  return stmt.run(
    data.name,
    data.olt_id ? parseInt(data.olt_id) : null,
    data.pon_port || '',
    data.lat || '',
    data.lng || '',
    data.description || '',
    id
  );
}

function deleteOdp(id) {
  return db.prepare('DELETE FROM odps WHERE id = ?').run(id);
}

module.exports = {
  getAllOdps,
  getOdpById,
  createOdp,
  updateOdp,
  deleteOdp
};
