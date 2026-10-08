package com.alijaya.customer.data.pref

import android.content.Context
import android.content.SharedPreferences
import android.net.Uri

class SessionManager(context: Context) {
    private val prefs: SharedPreferences = context.getSharedPreferences("alijaya_customer_prefs", Context.MODE_PRIVATE)

    companion object {
        private const val KEY_FIRST_TIME_DONE = "key_first_time_done"
        private const val KEY_SERVER_URL = "key_server_url"
        private const val KEY_PORTAL_TYPE = "key_portal_type"
        private const val KEY_CUSTOM_PATH = "key_custom_path"
        private const val KEY_AUTH_TOKEN = "key_auth_token"
        private const val KEY_CUSTOMER_ID = "key_customer_id"
        private const val KEY_CUSTOMER_NAME = "key_customer_name"
        private const val KEY_CUSTOMER_PHONE = "key_customer_phone"
        private const val KEY_ISP_NAME = "key_isp_name"
        private const val KEY_ADMIN_PHONE = "key_admin_phone"
        private const val KEY_PRINTER_MAC = "key_printer_mac"
        private const val KEY_PRINTER_NAME = "key_printer_name"
        private const val KEY_PRINTER_80MM = "key_printer_80mm"
        private const val KEY_GATEWAY_ENABLED = "key_gateway_enabled"
        private const val KEY_GATEWAY_SECRET = "key_gateway_secret"
        private const val KEY_GATEWAY_CUSTOM_URL = "key_gateway_custom_url"
        private const val KEY_GATEWAY_MONITOR_ALL = "key_gateway_monitor_all"
        private const val KEY_GATEWAY_PACKAGES = "key_gateway_packages"

        const val DEFAULT_SERVER_URL = "https://app.alijaya.com"

        const val PORTAL_CUSTOMER = "customer"
        const val PORTAL_AGENT = "agent"
        const val PORTAL_TECH = "tech"
        const val PORTAL_ADMIN = "admin"
        const val PORTAL_COLLECTOR = "collector"
        const val PORTAL_CUSTOM = "custom"
    }

    fun isFirstTimeSetup(): Boolean {
        return !prefs.getBoolean(KEY_FIRST_TIME_DONE, false)
    }

    fun setFirstTimeSetupDone() {
        prefs.edit().putBoolean(KEY_FIRST_TIME_DONE, true).apply()
    }

    fun setFirstTimeSetup(isFirst: Boolean) {
        prefs.edit().putBoolean(KEY_FIRST_TIME_DONE, !isFirst).apply()
    }

    fun getServerBaseUrl(): String {
        val raw = prefs.getString(KEY_SERVER_URL, DEFAULT_SERVER_URL) ?: DEFAULT_SERVER_URL
        return sanitizeBaseUrl(raw)
    }

    fun saveServerBaseUrl(url: String) = saveServerUrl(url)

    fun getPortalType(): String {
        return prefs.getString(KEY_PORTAL_TYPE, PORTAL_CUSTOMER) ?: PORTAL_CUSTOMER
    }

    fun getPortalDisplayName(): String {
        return when (getPortalType()) {
            PORTAL_AGENT -> "Agen & Reseller"
            PORTAL_TECH -> "Teknisi Lapangan"
            PORTAL_ADMIN -> "Admin & Kasir"
            PORTAL_COLLECTOR -> "Kolektor Lapangan"
            else -> "Portal Pelanggan"
        }
    }

    fun getPortalPath(): String {
        return when (getPortalType()) {
            PORTAL_AGENT -> "/agent/login"
            PORTAL_TECH -> "/tech/login"
            PORTAL_ADMIN -> "/admin/login"
            PORTAL_COLLECTOR -> "/collector/login"
            PORTAL_CUSTOM -> prefs.getString(KEY_CUSTOM_PATH, "/customer/login") ?: "/customer/login"
            else -> "/customer/login"
        }
    }

    fun getFullPortalUrl(): String {
        val base = getServerBaseUrl()
        val path = getPortalPath()
        return if (path.startsWith("/")) "$base$path" else "$base/$path"
    }

    fun saveConfig(inputUrl: String, portalType: String, customPath: String = "") {
        val sanitizedBase = sanitizeBaseUrl(inputUrl)
        prefs.edit()
            .putBoolean(KEY_FIRST_TIME_DONE, true)
            .putString(KEY_SERVER_URL, sanitizedBase)
            .putString(KEY_PORTAL_TYPE, portalType)
            .putString(KEY_CUSTOM_PATH, customPath)
            .apply()
    }

    private fun sanitizeBaseUrl(input: String): String {
        var clean = input.trim()
        if (clean.isEmpty()) return DEFAULT_SERVER_URL

        // If user entered protocol
        if (!clean.startsWith("http://") && !clean.startsWith("https://")) {
            // Check if it's local IP or localhost -> use http
            val isLocal = clean.startsWith("192.168.") || clean.startsWith("10.") || 
                          clean.startsWith("127.0.") || clean.startsWith("localhost") || 
                          clean.contains(":3000") || clean.contains(":3001") || clean.contains(":8080")
            clean = if (isLocal) "http://$clean" else "https://$clean"
        }

        // Parse URI to separate base host and any attached path
        try {
            val uri = Uri.parse(clean)
            val scheme = uri.scheme ?: "https"
            val authority = uri.authority ?: clean
            return "$scheme://$authority".removeSuffix("/")
        } catch (_: Exception) {
            return clean.removeSuffix("/")
        }
    }

    fun resetToDefault() {
        saveConfig(DEFAULT_SERVER_URL, PORTAL_CUSTOMER)
    }

    // Bluetooth Printer Preferences
    fun getPrinterMac(): String = prefs.getString(KEY_PRINTER_MAC, "") ?: ""
    fun getPrinterName(): String = prefs.getString(KEY_PRINTER_NAME, "Belum Dipilih") ?: "Belum Dipilih"
    fun isPrinter80mm(): Boolean = prefs.getBoolean(KEY_PRINTER_80MM, false)

    fun setPrinter(mac: String, name: String, is80mm: Boolean) {
        prefs.edit()
            .putString(KEY_PRINTER_MAC, mac)
            .putString(KEY_PRINTER_NAME, name)
            .putBoolean(KEY_PRINTER_80MM, is80mm)
            .apply()
    }

    fun saveAuthToken(token: String) {
        prefs.edit().putString(KEY_AUTH_TOKEN, token).apply()
    }

    fun getAuthToken(): String = prefs.getString(KEY_AUTH_TOKEN, "") ?: ""
    fun getRawAuthToken(): String? = prefs.getString(KEY_AUTH_TOKEN, null)

    fun getIspName(): String = prefs.getString(KEY_ISP_NAME, "ISP NETWORK") ?: "ISP NETWORK"
    fun saveIspName(name: String) {
        if (name.isNotBlank()) {
            prefs.edit().putString(KEY_ISP_NAME, name.trim()).apply()
        }
    }

    fun getAdminPhone(): String = prefs.getString(KEY_ADMIN_PHONE, "") ?: ""
    fun saveAdminPhone(phone: String) {
        if (phone.isNotBlank()) {
            prefs.edit().putString(KEY_ADMIN_PHONE, phone.trim()).apply()
        }
    }

    fun getFormattedAdminPhone(): String {
        return formatWhatsappNumber(getAdminPhone())
    }

    fun formatWhatsappNumber(raw: String): String {
        val firstToken = raw.split(',', ';', '/').firstOrNull { it.isNotBlank() } ?: ""
        var digits = firstToken.replace(Regex("[^0-9]"), "")
        if (digits.startsWith("08")) {
            digits = "628" + digits.substring(2)
        } else if (digits.startsWith("8")) {
            digits = "628" + digits.substring(1)
        }
        return digits
    }

    fun getServerUrl(): String = getServerBaseUrl()
    fun saveServerUrl(url: String) = saveConfig(url, getPortalType())

    fun saveCustomerInfo(id: Int, name: String, phone: String) {
        prefs.edit()
            .putInt(KEY_CUSTOMER_ID, id)
            .putString(KEY_CUSTOMER_NAME, name)
            .putString(KEY_CUSTOMER_PHONE, phone)
            .apply()
    }

    fun getCustomerId(): Int = prefs.getInt(KEY_CUSTOMER_ID, 0)
    fun getCustomerName(): String = prefs.getString(KEY_CUSTOMER_NAME, "Pelanggan") ?: "Pelanggan"
    fun getCustomerPhone(): String = prefs.getString(KEY_CUSTOMER_PHONE, "") ?: ""

    fun isLoggedIn(): Boolean = !getAuthToken().isNullOrBlank()

    fun logout() {
        prefs.edit()
            .remove(KEY_AUTH_TOKEN)
            .remove(KEY_CUSTOMER_ID)
            .remove(KEY_CUSTOMER_NAME)
            .remove(KEY_CUSTOMER_PHONE)
            .apply()
    }

    // ─── AUTO-PAYMENT GATEWAY (KHUSUS ADMIN) ──────────────────────────────────
    fun isGatewayEnabled(): Boolean = prefs.getBoolean(KEY_GATEWAY_ENABLED, false)
    fun setGatewayEnabled(enabled: Boolean) = prefs.edit().putBoolean(KEY_GATEWAY_ENABLED, enabled).apply()

    fun getGatewaySecret(): String = prefs.getString(KEY_GATEWAY_SECRET, "") ?: ""
    fun setGatewaySecret(secret: String) = prefs.edit().putString(KEY_GATEWAY_SECRET, secret.trim()).apply()

    fun getGatewayCustomUrl(): String = prefs.getString(KEY_GATEWAY_CUSTOM_URL, "") ?: ""
    fun setGatewayCustomUrl(url: String) = prefs.edit().putString(KEY_GATEWAY_CUSTOM_URL, url.trim()).apply()

    fun isGatewayMonitorAll(): Boolean = prefs.getBoolean(KEY_GATEWAY_MONITOR_ALL, false)
    fun setGatewayMonitorAll(monitorAll: Boolean) = prefs.edit().putBoolean(KEY_GATEWAY_MONITOR_ALL, monitorAll).apply()

    fun getGatewaySelectedPackages(): Set<String> {
        val defaults = setOf(
            "id.dana",
            "com.gojek.app",
            "com.gojek.gofoodmerchant",
            "com.midtrans.gobiz",
            "ovo.id",
            "com.ovo.merchant",
            "com.shopee.id",
            "com.shopee.id.partner",
            "com.bca",
            "com.bca.mybca",
            "id.co.bca.merchant",
            "id.bmri.livin",
            "com.bankmandiri.mandiriglobalmobile",
            "id.co.bri.brimo",
            "src.com.bni",
            "id.co.bni.wondr",
            "com.telkom.mwallet",
            "com.seabank.mobile",
            "com.jago.digitalbanking",
            "id.co.nobubank.noboneo"
        )
        return prefs.getStringSet(KEY_GATEWAY_PACKAGES, defaults) ?: defaults
    }
    fun setGatewaySelectedPackages(pkgs: Set<String>) = prefs.edit().putStringSet(KEY_GATEWAY_PACKAGES, pkgs).apply()
}
