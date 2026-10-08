package com.alijaya.customer.ui.admin

import android.content.Context
import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.widget.SwitchCompat
import androidx.cardview.widget.CardView
import androidx.core.app.NotificationManagerCompat
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import com.alijaya.customer.CustomerApplication
import com.alijaya.customer.service.PaymentNotificationListenerService
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class AdminWebhookGatewayFragment : Fragment() {

    private fun httpClient() = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(15, TimeUnit.SECONDS).build()
    private fun getBaseUrl(): String {
        val b = CustomerApplication.sessionManager.getServerBaseUrl()
        return if (b.endsWith("/")) b.dropLast(1) else b
    }
    private fun getToken(): String = CustomerApplication.sessionManager.getAuthToken()

    private lateinit var swipeRefresh: SwipeRefreshLayout
    private lateinit var contentContainer: LinearLayout

    private var serverWebhookSecret = "billing-rtrw-secret-key"

    private data class EwalletOption(
        val name: String,
        val icon: String,
        val packages: List<String>,
        val colorHex: String
    )

    private val ewalletList = listOf(
        EwalletOption("DANA", "🔵", listOf("id.dana"), "#0EA5E9"),
        EwalletOption("GoPay / Gojek / GoBiz", "🟢", listOf("com.gojek.app", "com.gojek.gofoodmerchant", "com.midtrans.gobiz"), "#10B981"),
        EwalletOption("OVO / OVO Merchant", "🟣", listOf("ovo.id", "com.ovo.merchant"), "#8B5CF6"),
        EwalletOption("ShopeePay / ShopeePartner", "🟠", listOf("com.shopee.id", "com.shopee.id.partner"), "#F97316"),
        EwalletOption("BCA Mobile / myBCA / Merchant BCA", "🟦", listOf("com.bca", "com.bca.mybca", "id.co.bca.merchant"), "#2563EB"),
        EwalletOption("Livin' by Mandiri", "🟨", listOf("id.bmri.livin", "com.bankmandiri.mandiriglobalmobile"), "#EAB308"),
        EwalletOption("BRImo (Bank BRI)", "🔷", listOf("id.co.bri.brimo"), "#0284C7"),
        EwalletOption("BNI Mobile / wondr by BNI", "🟧", listOf("src.com.bni", "id.co.bni.wondr"), "#EA580C"),
        EwalletOption("LinkAja", "🟩", listOf("com.telkom.mwallet"), "#16A34A"),
        EwalletOption("SeaBank", "🟡", listOf("com.seabank.mobile"), "#CA8A04"),
        EwalletOption("Bank Jago", "🔵", listOf("com.jago.digitalbanking"), "#0284C7"),
        EwalletOption("Nobu Bank / QRIS", "🔴", listOf("id.co.nobubank.noboneo"), "#DC2626")
    )

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        swipeRefresh = SwipeRefreshLayout(requireContext()).apply { setBackgroundColor(Color.parseColor("#0F172A")) }
        val scroll = ScrollView(requireContext()).apply { isFillViewport = true }
        contentContainer = LinearLayout(requireContext()).apply { orientation = LinearLayout.VERTICAL; setPadding(32, 32, 32, 48) }
        scroll.addView(contentContainer)
        swipeRefresh.addView(scroll)
        swipeRefresh.setOnRefreshListener {
            fetchServerSettings()
        }
        return swipeRefresh
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        fetchServerSettings()
    }

    override fun onResume() {
        super.onResume()
        renderUI()
    }

    private fun isNotificationServiceEnabled(): Boolean {
        val ctx = context ?: return false
        val pkg = ctx.packageName
        val listeners = NotificationManagerCompat.getEnabledListenerPackages(ctx)
        return listeners.contains(pkg)
    }

    private fun isBatteryOptimized(): Boolean {
        val ctx = context ?: return false
        val pm = ctx.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return false
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            !pm.isIgnoringBatteryOptimizations(ctx.packageName)
        } else {
            false
        }
    }

    private fun fetchServerSettings() {
        swipeRefresh.isRefreshing = true
        lifecycleScope.launch {
            val json = withContext(Dispatchers.IO) {
                try {
                    val req = Request.Builder().url("${getBaseUrl()}/api/customer/app/admin/settings")
                        .addHeader("Authorization", "Bearer ${getToken()}").build()
                    val resp = httpClient().newCall(req).execute()
                    if (resp.isSuccessful) resp.body?.string()?.let { JSONObject(it) } else null
                } catch (_: Exception) { null }
            }
            val data = json?.optJSONObject("data")
            val sec = data?.optString("webhook_secret", "") ?: ""
            if (sec.isNotEmpty()) {
                serverWebhookSecret = sec
                CustomerApplication.sessionManager.setGatewaySecret(sec)
            }
            renderUI()
        }
    }

    private fun renderUI() {
        val ctx = context ?: return
        val session = CustomerApplication.sessionManager
        contentContainer.removeAllViews()
        swipeRefresh.isRefreshing = false

        // Header Title
        contentContainer.addView(TextView(ctx).apply {
            text = "⚡ Auto-Payment Gateway E-Wallet"
            setTextColor(Color.WHITE); textSize = 20f; typeface = Typeface.DEFAULT_BOLD; setPadding(0, 0, 0, 4)
        })
        contentContainer.addView(TextView(ctx).apply {
            text = "Pengganti MacroDroid: Menangkap notifikasi pembayaran QRIS, e-wallet, dan bank langsung di HP ini untuk verifikasi otomatis 24 jam."
            setTextColor(Color.parseColor("#94A3B8")); textSize = 12f; setPadding(0, 0, 0, 16)
        })

        // 1. MASTER SWITCH CARD
        val isEnabled = session.isGatewayEnabled()
        val masterCard = CardView(ctx).apply {
            radius = 24f
            setCardBackgroundColor(if (isEnabled) Color.parseColor("#14532D") else Color.parseColor("#1E293B"))
            cardElevation = 4f
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { setMargins(0, 0, 0, 16) }
        }
        val masterInner = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL; setPadding(24, 20, 24, 20)
        }
        val switchRow = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
        }
        val titleText = TextView(ctx).apply {
            text = if (isEnabled) "🟢 GATEWAY AKTIF (Mendengarkan Notifikasi)" else "⚪ GATEWAY NONAKTIF"
            setTextColor(Color.WHITE); textSize = 14f; typeface = Typeface.DEFAULT_BOLD
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        val masterSwitch = SwitchCompat(ctx).apply {
            isChecked = isEnabled
            thumbTintList = ColorStateList.valueOf(if (isEnabled) Color.parseColor("#4ADE80") else Color.parseColor("#94A3B8"))
            trackTintList = ColorStateList.valueOf(if (isEnabled) Color.parseColor("#166534") else Color.parseColor("#475569"))
            setOnCheckedChangeListener { _, checked ->
                session.setGatewayEnabled(checked)
                renderUI()
                if (checked && !isNotificationServiceEnabled()) {
                    Toast.makeText(ctx, "PENTING: Aktifkan izin 'Akses Notifikasi' agar aplikasi bisa membaca notifikasi e-wallet!", Toast.LENGTH_LONG).show()
                }
            }
        }
        switchRow.addView(titleText)
        switchRow.addView(masterSwitch)
        masterInner.addView(switchRow)

        masterInner.addView(TextView(ctx).apply {
            text = if (isEnabled) "✅ Aplikasi ini sedang aktif memantau notifikasi transaksi finansial yang masuk ke HP ini." else "Aktifkan sakelar di atas jika HP ini digunakan sebagai server penangkap notifikasi pembayaran QRIS/E-Wallet."
            setTextColor(if (isEnabled) Color.parseColor("#DCFCE7") else Color.parseColor("#94A3B8"))
            textSize = 11.5f; setPadding(0, 8, 0, 0)
        })
        masterCard.addView(masterInner)
        contentContainer.addView(masterCard)

        // 2. PERMISSION STATUS CARD
        val permCard = CardView(ctx).apply {
            radius = 20f; setCardBackgroundColor(Color.parseColor("#1E293B")); cardElevation = 3f
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { setMargins(0, 0, 0, 16) }
        }
        val permInner = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL; setPadding(24, 20, 24, 20) }

        permInner.addView(TextView(ctx).apply {
            text = "🛡️ Status Izin Sistem Android"; setTextColor(Color.WHITE); textSize = 14f; typeface = Typeface.DEFAULT_BOLD; setPadding(0, 0, 0, 12)
        })

        // Notif Permission
        val notifGranted = isNotificationServiceEnabled()
        val notifRow = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(0, 0, 0, 8) }
        notifRow.addView(TextView(ctx).apply {
            text = if (notifGranted) "✅ Akses Notifikasi: DIIZINKAN" else "⚠️ Akses Notifikasi: BELUM AKTIF"
            setTextColor(if (notifGranted) Color.parseColor("#4ADE80") else Color.parseColor("#F87171"))
            textSize = 12f; typeface = Typeface.DEFAULT_BOLD
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        })
        val btnNotifPerm = Button(ctx).apply {
            text = if (notifGranted) "Pengaturan" else "Buka Izin"
            textSize = 11f; setTextColor(Color.WHITE)
            backgroundTintList = ColorStateList.valueOf(if (notifGranted) Color.parseColor("#334155") else Color.parseColor("#DC2626"))
            setOnClickListener {
                try {
                    val intent = Intent("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS")
                    startActivity(intent)
                } catch (e: Exception) {
                    Toast.makeText(ctx, "Buka Pengaturan HP -> Privasi -> Akses Notifikasi", Toast.LENGTH_SHORT).show()
                }
            }
        }
        notifRow.addView(btnNotifPerm)
        permInner.addView(notifRow)

        // Battery Optimization
        val batteryOptimized = isBatteryOptimized()
        val batteryRow = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        batteryRow.addView(TextView(ctx).apply {
            text = if (!batteryOptimized) "✅ Hemat Baterai: BEBAS PEMBATASAN" else "🔋 Baterai: Masih Dibatasi Sistem"
            setTextColor(if (!batteryOptimized) Color.parseColor("#4ADE80") else Color.parseColor("#FBBF24"))
            textSize = 12f; typeface = Typeface.DEFAULT_BOLD
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        })
        val btnBattery = Button(ctx).apply {
            text = "Atur Baterai"
            textSize = 11f; setTextColor(Color.WHITE)
            backgroundTintList = ColorStateList.valueOf(Color.parseColor("#334155"))
            setOnClickListener {
                var opened = false
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    try {
                        val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                            data = Uri.parse("package:${ctx.packageName}")
                        }
                        startActivity(intent)
                        opened = true
                    } catch (_: Exception) {}
                }
                if (!opened) {
                    try {
                        val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                            data = Uri.parse("package:${ctx.packageName}")
                        }
                        startActivity(intent)
                        opened = true
                    } catch (_: Exception) {}
                }
                if (!opened) {
                    try {
                        val intent = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
                        startActivity(intent)
                    } catch (e: Exception) {
                        Toast.makeText(ctx, "Buka Pengaturan HP -> Aplikasi -> Alijaya -> Baterai -> Tidak Dibatasi", Toast.LENGTH_LONG).show()
                    }
                }
            }
        }
        batteryRow.addView(btnBattery)
        permInner.addView(batteryRow)

        permCard.addView(permInner)
        contentContainer.addView(permCard)

        // 3. WEBHOOK LINK & SECRET KEY SETTINGS CARD
        val cfgCard = CardView(ctx).apply {
            radius = 20f; setCardBackgroundColor(Color.parseColor("#1E293B")); cardElevation = 3f
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { setMargins(0, 0, 0, 16) }
        }
        val cfgInner = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL; setPadding(24, 20, 24, 20) }

        cfgInner.addView(TextView(ctx).apply {
            text = "🔗 Konfigurasi URL Webhook & Secret Key"; setTextColor(Color.WHITE); textSize = 14f; typeface = Typeface.DEFAULT_BOLD; setPadding(0, 0, 0, 10)
        })

        val defaultWebhookUrl = "${getBaseUrl()}/api/webhook/v1/payment-notif"
        val customUrl = session.getGatewayCustomUrl()
        val currentWebhookUrl = if (customUrl.isNotEmpty()) customUrl else defaultWebhookUrl

        cfgInner.addView(TextView(ctx).apply { text = "URL Webhook Server:"; setTextColor(Color.parseColor("#94A3B8")); textSize = 11.5f; setPadding(0, 0, 0, 4) })
        val etWebhookUrl = EditText(ctx).apply {
            setText(currentWebhookUrl)
            setTextColor(Color.WHITE); textSize = 12f
            setBackgroundColor(Color.parseColor("#0F172A"))
            setPadding(20, 16, 20, 16)
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { setMargins(0, 0, 0, 10) }
        }
        cfgInner.addView(etWebhookUrl)

        val savedSecret = session.getGatewaySecret()
        val currentSecret = if (savedSecret.isNotEmpty()) savedSecret else serverWebhookSecret

        cfgInner.addView(TextView(ctx).apply { text = "Webhook Secret Key (Token Keamanan):"; setTextColor(Color.parseColor("#94A3B8")); textSize = 11.5f; setPadding(0, 0, 0, 4) })
        val etSecretKey = EditText(ctx).apply {
            setText(currentSecret)
            setTextColor(Color.WHITE); textSize = 12f
            setBackgroundColor(Color.parseColor("#0F172A"))
            setPadding(20, 16, 20, 16)
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { setMargins(0, 0, 0, 12) }
        }
        cfgInner.addView(etSecretKey)

        val btnSaveWebhook = Button(ctx).apply {
            text = "💾 Simpan Pengaturan Webhook"
            setTextColor(Color.WHITE); textSize = 12.5f; typeface = Typeface.DEFAULT_BOLD
            backgroundTintList = ColorStateList.valueOf(Color.parseColor("#0284C7"))
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 100).apply { setMargins(0, 0, 0, 8) }
            setOnClickListener {
                val newUrl = etWebhookUrl.text.toString().trim()
                val newSecret = etSecretKey.text.toString().trim().ifEmpty { "billing-rtrw-secret-key" }
                session.setGatewayCustomUrl(if (newUrl == defaultWebhookUrl) "" else newUrl)
                session.setGatewaySecret(newSecret)
                serverWebhookSecret = newSecret

                // Sync to backend settings
                lifecycleScope.launch {
                    withContext(Dispatchers.IO) {
                        try {
                            val body = JSONObject().put("webhook_secret", newSecret).toString().toRequestBody("application/json".toMediaType())
                            val req = Request.Builder().url("${getBaseUrl()}/api/customer/app/admin/settings/update")
                                .addHeader("Authorization", "Bearer ${getToken()}").post(body).build()
                            httpClient().newCall(req).execute()
                        } catch (_: Exception) {}
                    }
                    Toast.makeText(ctx, "✅ Pengaturan Webhook berhasil disimpan & disinkronkan!", Toast.LENGTH_SHORT).show()
                }
            }
        }
        cfgInner.addView(btnSaveWebhook)

        // Test Simulation Button
        val btnTestWebhook = Button(ctx).apply {
            text = "🧪 Kirim Notifikasi Uji Coba (Simulasi Rp 10.000)"
            setTextColor(Color.WHITE); textSize = 12f; typeface = Typeface.DEFAULT_BOLD
            backgroundTintList = ColorStateList.valueOf(Color.parseColor("#475569"))
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 90)
            setOnClickListener {
                testWebhookSimulation(etWebhookUrl.text.toString().trim(), etSecretKey.text.toString().trim().ifEmpty { serverWebhookSecret })
            }
        }
        cfgInner.addView(btnTestWebhook)

        cfgCard.addView(cfgInner)
        contentContainer.addView(cfgCard)

        // 4. EWALLET & BANK SELECTION CARD
        val ewalletCard = CardView(ctx).apply {
            radius = 20f; setCardBackgroundColor(Color.parseColor("#1E293B")); cardElevation = 3f
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { setMargins(0, 0, 0, 16) }
        }
        val ewalletInner = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL; setPadding(24, 20, 24, 20) }

        ewalletInner.addView(TextView(ctx).apply {
            text = "📱 Pilihan Aplikasi E-Wallet & Bank yang Dimonitor"; setTextColor(Color.WHITE); textSize = 14f; typeface = Typeface.DEFAULT_BOLD; setPadding(0, 0, 0, 4)
        })
        ewalletInner.addView(TextView(ctx).apply {
            text = "Centang aplikasi perbankan/e-wallet yang terpasang di HP ini untuk menangkap transfer uang masuk:"; setTextColor(Color.parseColor("#94A3B8")); textSize = 11.5f; setPadding(0, 0, 0, 12)
        })

        val currentSelectedPackages = session.getGatewaySelectedPackages().toMutableSet()

        for (opt in ewalletList) {
            val isChecked = opt.packages.any { currentSelectedPackages.contains(it) }
            val cb = CheckBox(ctx).apply {
                text = "${opt.icon} ${opt.name}"
                setTextColor(Color.WHITE); textSize = 12.5f
                this.isChecked = isChecked
                buttonTintList = ColorStateList.valueOf(Color.parseColor(opt.colorHex))
                setOnCheckedChangeListener { _, checked ->
                    if (checked) {
                        currentSelectedPackages.addAll(opt.packages)
                    } else {
                        currentSelectedPackages.removeAll(opt.packages.toSet())
                    }
                    session.setGatewaySelectedPackages(currentSelectedPackages)
                }
            }
            ewalletInner.addView(cb)
        }

        // Monitor All Switch
        val monitorAllChecked = session.isGatewayMonitorAll()
        val cbMonitorAll = CheckBox(ctx).apply {
            text = "🌐 Tangkap Semua Notifikasi Lainnya yang Berisi Kata 'Rp' / 'QRIS'"
            setTextColor(Color.parseColor("#38BDF8")); textSize = 12f; typeface = Typeface.DEFAULT_BOLD
            isChecked = monitorAllChecked
            buttonTintList = ColorStateList.valueOf(Color.parseColor("#38BDF8"))
            setPadding(0, 8, 0, 0)
            setOnCheckedChangeListener { _, checked ->
                session.setGatewayMonitorAll(checked)
            }
        }
        ewalletInner.addView(cbMonitorAll)

        ewalletCard.addView(ewalletInner)
        contentContainer.addView(ewalletCard)

        // 5. LIVE CAPTURED LOGS ON THIS DEVICE
        val liveEvents = PaymentNotificationListenerService.recentCapturedEvents.toList().reversed()
        if (liveEvents.isNotEmpty()) {
            contentContainer.addView(TextView(ctx).apply {
                text = "⚡ Terdeteksi di HP Ini (${liveEvents.size} Terakhir)"; setTextColor(Color.WHITE); textSize = 14f; typeface = Typeface.DEFAULT_BOLD; setPadding(4, 8, 0, 8)
            })

            for (ev in liveEvents.take(5)) {
                val card = CardView(ctx).apply {
                    radius = 16f; setCardBackgroundColor(Color.parseColor("#0F172A")); cardElevation = 2f
                    layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { setMargins(0, 0, 0, 8) }
                }
                val inner = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL; setPadding(18, 12, 18, 12) }
                inner.addView(TextView(ctx).apply {
                    text = "[${ev.time}] ${ev.service} • ${ev.status}"
                    setTextColor(if (ev.status.contains("Sukses")) Color.parseColor("#4ADE80") else Color.parseColor("#FBBF24"))
                    textSize = 11.5f; typeface = Typeface.DEFAULT_BOLD
                })
                inner.addView(TextView(ctx).apply {
                    text = ev.content
                    setTextColor(Color.parseColor("#CBD5E1")); textSize = 11f; setPadding(0, 4, 0, 0)
                })
                card.addView(inner)
                contentContainer.addView(card)
            }
        }

        // 6. SERVER WEBHOOK LOGS SECTION
        fetchServerWebhookLogs()
    }

    private fun testWebhookSimulation(endpoint: String, secret: String) {
        val ctx = context ?: return
        swipeRefresh.isRefreshing = true
        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) {
                try {
                    val targetUrl = if (endpoint.contains("?")) "$endpoint&secret_key=$secret" else "$endpoint?secret_key=$secret"
                    val payload = JSONObject().apply {
                        put("service", "TEST_SIMULASI")
                        put("packageName", "com.alijaya.customer.test")
                        put("secret_key", secret)
                        put("title", "Simulasi QRIS Masuk")
                        put("content", "Diterima pembayaran QRIS Rp 10.000 dari Pengujian HP Admin")
                        put("timestamp", System.currentTimeMillis())
                    }
                    val body = payload.toString().toRequestBody("application/json; charset=utf-8".toMediaType())
                    val req = Request.Builder().url(targetUrl)
                        .addHeader("Content-Type", "application/json")
                        .addHeader("x-webhook-token", secret)
                        .addHeader("x-webhook-secret", secret)
                        .addHeader("Authorization", "Bearer ${getToken()}")
                        .post(body).build()
                    val resp = httpClient().newCall(req).execute()
                    val code = resp.code
                    val b = resp.body?.string() ?: ""
                    Pair(code, b)
                } catch (e: Exception) {
                    Pair(0, e.message ?: "Koneksi gagal")
                }
            }
            swipeRefresh.isRefreshing = false
            if (result.first in 200..299) {
                Toast.makeText(ctx, "✅ Sukses terhubung ke server! (HTTP ${result.first})\nRespons: ${result.second.take(100)}", Toast.LENGTH_LONG).show()
            } else {
                Toast.makeText(ctx, "❌ Gagal: HTTP ${result.first}\nRespons: ${result.second.take(120)}", Toast.LENGTH_LONG).show()
            }
            renderUI()
        }
    }

    private fun fetchServerWebhookLogs() {
        val ctx = context ?: return
        lifecycleScope.launch {
            val json = withContext(Dispatchers.IO) {
                try {
                    val req = Request.Builder().url("${getBaseUrl()}/api/customer/app/admin/webhook/logs")
                        .addHeader("Authorization", "Bearer ${getToken()}").build()
                    val resp = httpClient().newCall(req).execute()
                    if (resp.isSuccessful) resp.body?.string()?.let { JSONObject(it) } else null
                } catch (_: Exception) { null }
            }

            val data = json?.optJSONArray("data") ?: JSONArray()
            if (data.length() > 0) {
                contentContainer.addView(TextView(ctx).apply {
                    text = "📋 Riwayat Webhook di Server (${data.length()} Terakhir)"
                    setTextColor(Color.WHITE); textSize = 14f; typeface = Typeface.DEFAULT_BOLD; setPadding(4, 16, 0, 8)
                })

                for (i in 0 until data.length().coerceAtMost(10)) {
                    val item = data.getJSONObject(i)
                    val service = item.optString("service", "NOTIF")
                    val content = item.optString("content", "-")
                    val amount = item.optInt("parsed_amount", 0)
                    val matchedInv = item.optInt("matched_invoice_id", 0)
                    val createdAt = item.optString("created_at", "-")

                    val card = CardView(ctx).apply {
                        radius = 16f; setCardBackgroundColor(Color.parseColor("#1E293B")); cardElevation = 2f
                        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { setMargins(0, 0, 0, 8) }
                    }
                    val inner = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL; setPadding(18, 12, 18, 12) }

                    val headerRow = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL }
                    headerRow.addView(TextView(ctx).apply {
                        text = "[$service] Rp ${String.format("%,d", amount).replace(',', '.')}"
                        setTextColor(Color.parseColor("#38BDF8")); textSize = 12f; typeface = Typeface.DEFAULT_BOLD
                        layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                    })
                    headerRow.addView(TextView(ctx).apply {
                        text = if (matchedInv > 0) "✅ MATCH #$matchedInv" else "⚪ Belum Match"
                        setTextColor(if (matchedInv > 0) Color.parseColor("#4ADE80") else Color.parseColor("#94A3B8"))
                        textSize = 10.5f; typeface = Typeface.DEFAULT_BOLD
                    })
                    inner.addView(headerRow)

                    inner.addView(TextView(ctx).apply {
                        text = content; setTextColor(Color.parseColor("#CBD5E1")); textSize = 11f; setPadding(0, 4, 0, 2)
                    })
                    inner.addView(TextView(ctx).apply {
                        text = "Waktu: $createdAt"; setTextColor(Color.parseColor("#64748B")); textSize = 10f
                    })

                    card.addView(inner)
                    contentContainer.addView(card)
                }
            }
        }
    }
}
