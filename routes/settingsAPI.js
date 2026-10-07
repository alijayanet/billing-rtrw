/**
 * Settings API Routes
 * Untuk manage settings lewat API dengan security & validation
 */
const express = require('express');
const router = express.Router();
const { logger } = require('../config/logger');
const { getSetting, getSettings, saveSettings } = require('../config/settingsManager');
const { getMaskedSettings } = require('../config/settingsEncryption');
const { getAllRules } = require('../config/settingsValidator');
const { getChangeHistory, getAuditStats, exportAuditLog } = require('../config/settingsAudit');
const {
  requireSuperAdmin,
  validateSettingsMiddleware,
  maskSensitiveValues,
  logSettingsAccess,
  rateLimitSettings
} = require('../middleware/settingsMiddleware');

// Apply middleware
router.use(rateLimitSettings);
router.use(maskSensitiveValues);
router.use(logSettingsAccess);

/**
 * GET /api/settings
 * Get all settings (masked)
 */
router.get('/', requireSuperAdmin, (req, res) => {
  try {
    const settings = getSettings();
    const masked = getMaskedSettings(settings);

    return res.json({
      success: true,
      settings: masked
    });
  } catch (error) {
    logger.error(`[settings-api] Error getting settings: ${error.message}`);
    return res.status(500).json({
      error: 'Internal server error'
    });
  }
});

/**
 * GET /api/settings/rules
 * Get validation rules untuk setiap field
 */
router.get('/rules', requireSuperAdmin, (req, res) => {
  try {
    const rules = getAllRules();

    return res.json({
      success: true,
      rules
    });
  } catch (error) {
    logger.error(`[settings-api] Error getting rules: ${error.message}`);
    return res.status(500).json({
      error: 'Internal server error'
    });
  }
});

/**
 * GET /api/settings/:field
 * Get single setting (masked)
 */
router.get('/:field', requireSuperAdmin, (req, res) => {
  try {
    const { field } = req.params;
    const value = getSetting(field);

    if (value === null || value === undefined) {
      return res.status(404).json({
        error: 'Setting not found'
      });
    }

    const { getMaskedSettings } = require('../config/settingsEncryption');
    const masked = getMaskedSettings({ [field]: value });

    return res.json({
      success: true,
      field,
      value: masked[field]
    });
  } catch (error) {
    logger.error(`[settings-api] Error getting setting: ${error.message}`);
    return res.status(500).json({
      error: 'Internal server error'
    });
  }
});

/**
 * POST /api/settings
 * Update settings dengan validation & encryption
 */
router.post('/', requireSuperAdmin, validateSettingsMiddleware, (req, res) => {
  try {
    const settings = req.validatedSettings;
    const actor = req.session?.username || 'unknown';
    const metadata = {
      ip: req.ip,
      userAgent: req.get('user-agent')
    };

    const result = saveSettings(settings, actor, metadata);

    if (!result.success) {
      return res.status(400).json({
        error: 'Failed to save settings',
        errors: result.errors
      });
    }

    return res.json({
      success: true,
      message: 'Settings saved successfully',
      changes: result.changes
    });
  } catch (error) {
    logger.error(`[settings-api] Error saving settings: ${error.message}`);
    return res.status(500).json({
      error: 'Internal server error'
    });
  }
});

/**
 * PUT /api/settings/:field
 * Update single setting
 */
router.put('/:field', requireSuperAdmin, (req, res) => {
  try {
    const { field } = req.params;
    const { value } = req.body;

    if (value === undefined) {
      return res.status(400).json({
        error: 'Value is required'
      });
    }

    const settings = { [field]: value };
    const actor = req.session?.username || 'unknown';
    const metadata = {
      ip: req.ip,
      userAgent: req.get('user-agent')
    };

    const result = saveSettings(settings, actor, metadata);

    if (!result.success) {
      return res.status(400).json({
        error: 'Failed to save setting',
        errors: result.errors
      });
    }

    return res.json({
      success: true,
      message: `Setting ${field} updated successfully`
    });
  } catch (error) {
    logger.error(`[settings-api] Error updating setting: ${error.message}`);
    return res.status(500).json({
      error: 'Internal server error'
    });
  }
});

/**
 * GET /api/settings/audit/history
 * Get settings change history
 */
router.get('/audit/history', requireSuperAdmin, (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
    const history = getChangeHistory(limit);

    return res.json({
      success: true,
      count: history.length,
      history
    });
  } catch (error) {
    logger.error(`[settings-api] Error getting history: ${error.message}`);
    return res.status(500).json({
      error: 'Internal server error'
    });
  }
});

/**
 * GET /api/settings/audit/stats
 * Get audit statistics
 */
router.get('/audit/stats', requireSuperAdmin, (req, res) => {
  try {
    const stats = getAuditStats();

    return res.json({
      success: true,
      stats
    });
  } catch (error) {
    logger.error(`[settings-api] Error getting stats: ${error.message}`);
    return res.status(500).json({
      error: 'Internal server error'
    });
  }
});

/**
 * GET /api/settings/audit/export
 * Export audit log
 */
router.get('/audit/export', requireSuperAdmin, (req, res) => {
  try {
    const format = req.query.format || 'json';
    const result = exportAuditLog(format);

    if (!result) {
      return res.status(500).json({
        error: 'Failed to export audit log'
      });
    }

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="settings-audit.csv"');
      return res.send(result.data);
    }

    return res.json({
      success: true,
      format: 'json',
      count: result.count,
      data: result.data
    });
  } catch (error) {
    logger.error(`[settings-api] Error exporting audit: ${error.message}`);
    return res.status(500).json({
      error: 'Internal server error'
    });
  }
});

/**
 * POST /api/settings/test-connection/:service
 * Test connection ke external service
 */
router.post('/test-connection/:service', requireSuperAdmin, async (req, res) => {
  try {
    const { service } = req.params;
    let result = { success: false, message: '' };

    switch (service) {
      case 'genieacs':
        result = await testGenieACSConnection();
        break;
      case 'mikrotik':
        result = await testMikroTikConnection();
        break;
      case 'tripay':
        result = await testTripayConnection();
        break;
      case 'midtrans':
        result = await testMidtransConnection();
        break;
      default:
        return res.status(400).json({
          error: 'Unknown service'
        });
    }

    return res.json(result);
  } catch (error) {
    logger.error(`[settings-api] Error testing connection: ${error.message}`);
    return res.status(500).json({
      error: 'Internal server error'
    });
  }
});

/**
 * Test GenieACS connection
 */
async function testGenieACSConnection() {
  try {
    const axios = require('axios');
    const url = getSetting('genieacs_url');
    const username = getSetting('genieacs_username');
    const password = getSetting('genieacs_password');

    if (!url || !username || !password) {
      return { success: false, message: 'GenieACS credentials not configured' };
    }

    const response = await axios.get(`${url}/devices`, {
      auth: { username, password },
      timeout: 5000
    });

    return { success: true, message: 'GenieACS connection successful' };
  } catch (error) {
    return { success: false, message: `GenieACS connection failed: ${error.message}` };
  }
}

/**
 * Test MikroTik connection
 */
async function testMikroTikConnection() {
  try {
    const { RouterOSClient } = require('routeros-client');
    const host = getSetting('mikrotik_host');
    const user = getSetting('mikrotik_user');
    const password = getSetting('mikrotik_password');
    const port = getSetting('mikrotik_port') || 8728;

    if (!host || !user || !password) {
      return { success: false, message: 'MikroTik credentials not configured' };
    }

    const useTls = Number(port) === 8729 || getSetting('mikrotik_tls') === true;
    const api = new RouterOSClient({
      host,
      port: Number(port),
      user,
      password,
      tls: useTls ? { rejectUnauthorized: false } : false,
      timeout: 5000
    });

    const client = await api.connect();
    await client.close();

    return { success: true, message: 'MikroTik connection successful' };
  } catch (error) {
    return { success: false, message: `MikroTik connection failed: ${error.message}` };
  }
}

/**
 * Test Tripay connection
 */
async function testTripayConnection() {
  try {
    const axios = require('axios');
    const apiKey = getSetting('tripay_api_key');
    const merchantCode = getSetting('tripay_merchant_code');
    const mode = getSetting('tripay_mode') || 'sandbox';

    if (!apiKey || !merchantCode) {
      return { success: false, message: 'Tripay credentials not configured' };
    }

    const baseUrl = mode === 'live'
      ? 'https://tripay.co.id/api/merchant/detail'
      : 'https://tripay.co.id/api-sandbox/merchant/detail';

    const response = await axios.get(baseUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 5000
    });

    return { success: true, message: 'Tripay connection successful' };
  } catch (error) {
    return { success: false, message: `Tripay connection failed: ${error.message}` };
  }
}

/**
 * Test Midtrans connection
 */
async function testMidtransConnection() {
  try {
    const axios = require('axios');
    const serverKey = getSetting('midtrans_server_key');
    const mode = getSetting('midtrans_mode') || 'sandbox';

    if (!serverKey) {
      return { success: false, message: 'Midtrans credentials not configured' };
    }

    const baseUrl = mode === 'production'
      ? 'https://app.midtrans.com/api/v2/balance'
      : 'https://app.sandbox.midtrans.com/api/v2/balance';

    const response = await axios.get(baseUrl, {
      auth: { username: serverKey, password: '' },
      timeout: 5000
    });

    return { success: true, message: 'Midtrans connection successful' };
  } catch (error) {
    return { success: false, message: `Midtrans connection failed: ${error.message}` };
  }
}

module.exports = router;
