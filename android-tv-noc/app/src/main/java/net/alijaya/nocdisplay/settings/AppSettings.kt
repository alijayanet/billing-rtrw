package net.alijaya.nocdisplay.settings

import android.content.Context
import android.content.SharedPreferences
import net.alijaya.nocdisplay.ui.theme.ThemeMode

class AppSettings(context: Context) {

    private val prefs: SharedPreferences = context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)

    var host: String
        get() = prefs.getString(KEY_HOST, "192.168.8.1") ?: "192.168.8.1"
        set(value) = prefs.edit().putString(KEY_HOST, value.trim()).apply()

    var port: Int
        get() = prefs.getInt(KEY_PORT, 8722)
        set(value) = prefs.edit().putInt(KEY_PORT, value).apply()

    var username: String
        get() = prefs.getString(KEY_USERNAME, "admin") ?: "admin"
        set(value) = prefs.edit().putString(KEY_USERNAME, value.trim()).apply()

    var password: String
        get() = prefs.getString(KEY_PASSWORD, "") ?: ""
        set(value) = prefs.edit().putString(KEY_PASSWORD, value).apply()

    var wanInterface: String
        get() = prefs.getString(KEY_WAN, "ether1-ISP") ?: "ether1-ISP"
        set(value) = prefs.edit().putString(KEY_WAN, value.trim()).apply()

    var refreshIntervalMs: Long
        get() = prefs.getLong(KEY_REFRESH, 2000L)
        set(value) = prefs.edit().putLong(KEY_REFRESH, value.coerceAtLeast(1000L)).apply()

    var themeMode: ThemeMode
        get() {
            val name = prefs.getString(KEY_THEME, ThemeMode.CYBERPUNK_NEON.name)
            return try {
                ThemeMode.valueOf(name ?: ThemeMode.CYBERPUNK_NEON.name)
            } catch (_: Exception) {
                ThemeMode.CYBERPUNK_NEON
            }
        }
        set(value) = prefs.edit().putString(KEY_THEME, value.name).apply()

    var autoStartOnBoot: Boolean
        get() = prefs.getBoolean(KEY_AUTO_BOOT, true)
        set(value) = prefs.edit().putBoolean(KEY_AUTO_BOOT, value).apply()

    companion object {
        private const val PREF_NAME = "alijaya_noc_tv_prefs"
        private const val KEY_HOST = "pref_host"
        private const val KEY_PORT = "pref_port"
        private const val KEY_USERNAME = "pref_username"
        private const val KEY_PASSWORD = "pref_password"
        private const val KEY_WAN = "pref_wan_interface"
        private const val KEY_REFRESH = "pref_refresh_ms"
        private const val KEY_THEME = "pref_theme_mode"
        private const val KEY_AUTO_BOOT = "pref_auto_boot"
    }
}
