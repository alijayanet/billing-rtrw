const { RouterOSClient } = require('routeros-client');
const { getSettingsWithCache } = require('../config/settingsManager');
const { logger } = require('../config/logger');

async function getConnection() {
  const settings = getSettingsWithCache();
  const host = settings.mikrotik_host;
  const port = settings.mikrotik_port || 8728;
  const user = settings.mikrotik_user;
  const password = settings.mikrotik_password;

  if (!host || !user) {
    throw new Error('MikroTik settings not configured');
  }

  const api = new RouterOSClient({
    host,
    port,
    user,
    password,
    timeout: 5000
  });

  try {
    const client = await api.connect();
    return { client, api };
  } catch (err) {
    logger.error('Failed to connect to MikroTik:', err);
    throw err;
  }
}

async function getPppoeProfiles() {
  let conn = null;
  try {
    conn = await getConnection();
    const results = await conn.client.menu('/ppp/profile').get();
    return results.map(r => ({
      name: r.name,
      localAddress: r.localAddress || r['local-address'] || '-',
      remoteAddress: r.remoteAddress || r['remote-address'] || '-',
      rateLimit: r.rateLimit || r['rate-limit'] || '-'
    }));
  } catch (e) {
    logger.error('Error getting PPPoE profiles:', e);
    return [];
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function getPppoeUsers() {
  let conn = null;
  try {
    conn = await getConnection();
    // Only get secrets for pppoe service
    const results = await conn.client.menu('/ppp/secret').where('service', 'pppoe').get();
    return results.map(r => ({
      name: r.name,
      profile: r.profile,
      disabled: r.disabled === 'true'
    }));
  } catch (e) {
    logger.error('Error getting PPPoE users:', e);
    return [];
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

// Function to isolate a user
async function setPppoeProfile(username, profileName) {
  let conn = null;
  try {
    conn = await getConnection();
    const secretMenu = conn.client.menu('/ppp/secret');
    const secret = await secretMenu.where('name', username).get();
    
    if (!secret || secret.length === 0) {
      throw new Error(`PPPoE User ${username} not found in MikroTik`);
    }

    await secretMenu.where('name', username).set({ profile: profileName });
    
    // Disconnect active connection so they reconnect with new profile
    await kickPppoeUser(username);

    return true;
  } catch (e) {
    logger.error(`Error setting PPPoE profile for ${username}:`, e);
    throw e;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function kickPppoeUser(username) {
  let conn = null;
  try {
    conn = await getConnection();
    const activeMenu = conn.client.menu('/ppp/active');
    const sessions = await activeMenu.where('name', username).get();
    if (sessions && sessions.length > 0) {
      for (const s of sessions) {
        await activeMenu.remove(s.id || s['.id']);
      }
      return true;
    }
    return false;
  } catch (e) {
    logger.warn(`Could not kick active connection for ${username}: ${e.message}`);
    return false;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function kickHotspotUser(username) {
  let conn = null;
  try {
    conn = await getConnection();
    const activeMenu = conn.client.menu('/ip/hotspot/active');
    const sessions = await activeMenu.where('user', username).get();
    if (sessions && sessions.length > 0) {
      for (const s of sessions) {
        await activeMenu.remove(s.id || s['.id']);
      }
      return true;
    }
    return false;
  } catch (e) {
    logger.warn(`Could not kick active hotspot connection for ${username}: ${e.message}`);
    return false;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function getPppoeSecrets() {
  let conn = null;
  try {
    conn = await getConnection();
    return await conn.client.menu('/ppp/secret').get();
  } catch (e) {
    logger.error('Error getting PPPoE secrets:', e);
    return [];
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function addPppoeSecret(data) {
  let conn = null;
  try {
    conn = await getConnection();
    return await conn.client.menu('/ppp/secret').add(data);
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function updatePppoeSecret(id, data) {
  let conn = null;
  try {
    conn = await getConnection();
    return await conn.client.menu('/ppp/secret').set(data, id);
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function deletePppoeSecret(id) {
  let conn = null;
  try {
    conn = await getConnection();
    return await conn.client.menu('/ppp/secret').remove(id);
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function getPppoeActive() {
  let conn = null;
  try {
    conn = await getConnection();
    return await conn.client.menu('/ppp/active').get();
  } catch (e) {
    logger.error('Error getting active PPPoE sessions:', e);
    return [];
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function getHotspotActive() {
  let conn = null;
  try {
    conn = await getConnection();
    return await conn.client.menu('/ip/hotspot/active').get();
  } catch (e) {
    logger.error('Error getting active Hotspot sessions:', e);
    return [];
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

// PPPoE Profiles CRUD
async function addPppoeProfile(data) {
  let conn = null;
  try {
    conn = await getConnection();
    return await conn.client.menu('/ppp/profile').add(data);
  } catch (e) {
    logger.error('Error adding PPPoE profile:', e);
    throw e;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function updatePppoeProfile(id, data) {
  let conn = null;
  try {
    conn = await getConnection();
    return await conn.client.menu('/ppp/profile').update(id, data);
  } catch (e) {
    logger.error('Error updating PPPoE profile:', e);
    throw e;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function deletePppoeProfile(id) {
  let conn = null;
  try {
    conn = await getConnection();
    return await conn.client.menu('/ppp/profile').remove(id);
  } catch (e) {
    logger.error('Error deleting PPPoE profile:', e);
    throw e;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

// Hotspot Profiles CRUD (User Profiles)
async function getHotspotUserProfiles() {
  let conn = null;
  try {
    conn = await getConnection();
    return await conn.client.menu('/ip/hotspot/user/profile').get();
  } catch (e) {
    logger.error('Error getting Hotspot user profiles:', e);
    return [];
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function addHotspotUserProfile(data) {
  let conn = null;
  try {
    conn = await getConnection();
    return await conn.client.menu('/ip/hotspot/user/profile').add(data);
  } catch (e) {
    logger.error('Error adding Hotspot user profile:', e);
    throw e;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function updateHotspotUserProfile(id, data) {
  let conn = null;
  try {
    conn = await getConnection();
    return await conn.client.menu('/ip/hotspot/user/profile').update(id, data);
  } catch (e) {
    logger.error('Error updating Hotspot user profile:', e);
    throw e;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function deleteHotspotUserProfile(id) {
  let conn = null;
  try {
    conn = await getConnection();
    return await conn.client.menu('/ip/hotspot/user/profile').remove(id);
  } catch (e) {
    logger.error('Error deleting Hotspot user profile:', e);
    throw e;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function getHotspotUsers() {
  let conn = null;
  try {
    conn = await getConnection();
    return await conn.client.menu('/ip/hotspot/user').get();
  } catch (e) {
    logger.error('Error getting Hotspot users:', e);
    return [];
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function addHotspotUser(data) {
  let conn = null;
  try {
    conn = await getConnection();
    return await conn.client.menu('/ip/hotspot/user').add(data);
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function updateHotspotUser(id, data) {
  let conn = null;
  try {
    conn = await getConnection();
    return await conn.client.menu('/ip/hotspot/user').set(data, id);
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function deleteHotspotUser(id) {
  let conn = null;
  try {
    conn = await getConnection();
    return await conn.client.menu('/ip/hotspot/user').remove(id);
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function getBackup() {
  let conn = null;
  try {
    conn = await getConnection();
    const result = await conn.client.menu('/').exec('export');
    return result;
  } catch (e) {
    logger.error('Error exporting MikroTik config:', e);
    throw e;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function getSystemScripts() {
  let conn = null;
  try {
    conn = await getConnection();
    return await conn.client.menu('/system/script').get();
  } catch (e) {
    logger.error('Error getting MikroTik system scripts:', e);
    return [];
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function getSystemResource() {
  let conn = null;
  try {
    conn = await getConnection();
    const result = await conn.client.menu('/system/resource').get();
    return result[0];
  } catch (e) {
    logger.error('Error getting MikroTik system resource:', e);
    throw e;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function getHotspotProfiles() {
  let conn = null;
  try {
    conn = await getConnection();
    return await conn.client.menu('/ip/hotspot/user/profile').get();
  } catch (e) {
    logger.error('Error getting Hotspot profiles:', e);
    return [];
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

module.exports = {
  getPppoeProfiles,
  getPppoeUsers,
  setPppoeProfile,
  getPppoeSecrets,
  addPppoeSecret,
  updatePppoeSecret,
  deletePppoeSecret,
  getHotspotUsers,
  addHotspotUser,
  updateHotspotUser,
  deleteHotspotUser,
  getHotspotProfiles,
  getPppoeActive,
  getHotspotActive,
  addPppoeProfile,
  updatePppoeProfile,
  deletePppoeProfile,
  getHotspotUserProfiles,
  addHotspotUserProfile,
  updateHotspotUserProfile,
  deleteHotspotUserProfile,
  getBackup,
  kickPppoeUser,
  kickHotspotUser,
  getSystemResource,
  getSystemScripts
};
