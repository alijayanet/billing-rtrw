package com.alijaya.customer.service

import android.app.Notification
import android.content.Context
import android.os.Bundle
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import com.alijaya.customer.CustomerApplication
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.TimeUnit

class PaymentNotificationListenerService : NotificationListenerService() {

    companion object {
        private const val TAG = "PaymentGatewayListener"

        // In-memory queue of recent captured notifications for Live Monitoring UI
        val recentCapturedEvents = ConcurrentLinkedQueue<CapturedEvent>()

        data class CapturedEvent(
            val id: Long = System.currentTimeMillis(),
            val time: String,
            val service: String,
            val packageName: String,
            val title: String,
            val content: String,
            var status: String = "Mengirim...",
            var serverResponse: String = ""
        )

        fun addEvent(event: CapturedEvent) {
            recentCapturedEvents.add(event)
            while (recentCapturedEvents.size > 30) {
                recentCapturedEvents.poll()
            }
        }
    }

    private val scope = CoroutineScope(Dispatchers.IO)
    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()

    override fun onListenerConnected() {
        super.onListenerConnected()
        Log.i(TAG, "NotificationListenerService Connected & Ready.")
    }

    override fun onListenerDisconnected() {
        super.onListenerDisconnected()
        Log.w(TAG, "NotificationListenerService Disconnected.")
    }

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        super.onNotificationPosted(sbn)
        if (sbn == null) return

        val session = CustomerApplication.sessionManager
        // Hanya proses jika fitur gateway diaktifkan oleh Admin
        if (!session.isGatewayEnabled()) {
            return
        }

        val pkgName = sbn.packageName ?: return
        // Abaikan notifikasi dari aplikasi sendiri
        if (pkgName == applicationContext.packageName) {
            return
        }

        // Abaikan mutlak aplikasi chat & pesan instan (WhatsApp, Telegram, SMS Messenger, dll)
        val blacklistedPackages = setOf(
            "com.whatsapp",
            "com.whatsapp.w4b",
            "org.telegram.messenger",
            "org.thunderdog.challegram",
            "com.facebook.orca",
            "com.instagram.android",
            "com.google.android.apps.messaging",
            "com.android.mms",
            "com.samsung.android.messaging",
            "jp.naver.line.android",
            "com.tencent.mm"
        )
        if (blacklistedPackages.contains(pkgName) || pkgName.contains("whatsapp", ignoreCase = true) || pkgName.contains("telegram", ignoreCase = true)) {
            return
        }

        val extras: Bundle = sbn.notification.extras ?: return
        val title = (extras.getCharSequence(Notification.EXTRA_TITLE)?.toString() ?: "").trim()
        val text = (extras.getCharSequence(Notification.EXTRA_TEXT)?.toString() ?: "").trim()
        val bigText = (extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString() ?: "").trim()
        val subText = (extras.getCharSequence(Notification.EXTRA_SUB_TEXT)?.toString() ?: "").trim()

        // Gabungkan semua teks relevan
        val textParts = listOf(title, text, bigText, subText).filter { it.isNotEmpty() }.distinct()
        val fullContent = textParts.joinToString(" • ")

        if (fullContent.isEmpty()) return

        val selectedPackages = session.getGatewaySelectedPackages()
        val monitorAll = session.isGatewayMonitorAll()
        val isWhitelisted = selectedPackages.contains(pkgName)

        val containsFinancialKeywords = containsPaymentKeyword(fullContent)

        // Harus memenuhi syarat: masuk daftar whitelist ATAU (monitor all & ada keyword pembayaran)
        if (!isWhitelisted && !(monitorAll && containsFinancialKeywords)) {
            return
        }

        // Hindari duplikasi spam: jika notifikasi hanya berupa update progres atau terlalu pendek
        if (fullContent.length < 5) return

        val serviceName = mapPackageToServiceName(pkgName)
        val timeStr = SimpleDateFormat("HH:mm:ss", Locale("id", "ID")).format(Date())

        val event = CapturedEvent(
            time = timeStr,
            service = serviceName,
            packageName = pkgName,
            title = title,
            content = fullContent,
            status = "Mengirim ke server..."
        )
        addEvent(event)

        Log.i(TAG, "Captured payment notification: [$serviceName] $fullContent")

        // Kirim ke server backend
        scope.launch {
            sendWebhookPayload(session, serviceName, pkgName, title, fullContent, event)
        }
    }

    private fun containsPaymentKeyword(text: String): Boolean {
        val lower = text.lowercase(Locale.ROOT)

        // Deteksi dan abaikan chat/reaksi pesan/kutipan tagihan
        val chatOrInvoiceHints = listOf(
            "bereaksi", "reacted", "membalas", "tagihan manual", "kode bayar qris",
            "rincian tagihan", "portal pelanggan", "silakan scan", "mohon scan",
            "link login", "pengingat tagihan", "halo pelanggan", "yth. pelanggan",
            "paket internet anda", "sebelum tanggal jatuh tempo"
        )
        if (chatOrInvoiceHints.any { lower.contains(it) }) {
            return false
        }

        val keywords = listOf(
            "transfer masuk", "dana masuk", "uang masuk", "pembayaran masuk",
            "pembayaran diterima", "saldo masuk", "saldo bertambah", "berhasil top up",
            "top up berhasil", "topup berhasil", "terima uang", "telah diterima dari",
            "diterima dari", "qris berhasil", "qris sukses", "qr berhasil", "qr sukses",
            "payment received", "kamu menerima", "berhasil menerima", "uang diterima"
        )
        val hasInbound = keywords.any { lower.contains(it) }

        val outgoingHints = listOf(
            "telah dikirim", "berhasil kirim", "transfer ke", "bayar ke", "berhasil bayar",
            "pembelian", "belanja", "kamu membayar", "transaksi keluar", "dikenakan biaya"
        )
        val hasOutbound = outgoingHints.any { lower.contains(it) }

        return hasInbound && !hasOutbound
    }

    private fun mapPackageToServiceName(pkg: String): String {
        return when {
            pkg.contains("dana") -> "DANA"
            pkg.contains("gojek") || pkg.contains("gobiz") -> "GOPAY"
            pkg.contains("ovo") -> "OVO"
            pkg.contains("shopee") -> "SHOPEEPAY"
            pkg.contains("bca") -> "BCA"
            pkg.contains("livin") || pkg.contains("mandiri") -> "MANDIRI"
            pkg.contains("brimo") || pkg.contains("bri") -> "BRIMO"
            pkg.contains("bni") -> "BNI"
            pkg.contains("mwallet") || pkg.contains("linkaja") -> "LINKAJA"
            pkg.contains("seabank") -> "SEABANK"
            pkg.contains("jago") -> "JAGO"
            pkg.contains("nobu") -> "NOBU"
            else -> pkg
        }
    }

    private fun sendWebhookPayload(
        session: com.alijaya.customer.data.pref.SessionManager,
        service: String,
        pkgName: String,
        title: String,
        content: String,
        event: CapturedEvent
    ) {
        try {
            val customUrl = session.getGatewayCustomUrl()
            val baseUrl = if (customUrl.isNotEmpty()) customUrl else session.getServerBaseUrl().trimEnd('/')
            val endpoint = if (baseUrl.endsWith("/api/webhook/v1/payment-notif")) baseUrl else "$baseUrl/api/webhook/v1/payment-notif"

            val secretKey = session.getGatewaySecret().ifEmpty { "billing-rtrw-secret-key" }

            val payload = JSONObject().apply {
                put("service", service)
                put("packageName", pkgName)
                put("app", service)
                put("secret_key", secretKey)
                put("title", title)
                put("content", content)
                put("timestamp", System.currentTimeMillis())
            }

            val body = payload.toString().toRequestBody("application/json; charset=utf-8".toMediaType())
            val request = Request.Builder()
                .url(endpoint)
                .addHeader("Content-Type", "application/json")
                .addHeader("x-webhook-token", secretKey)
                .addHeader("User-Agent", "Alijaya-Android-Gateway/1.2.0")
                .post(body)
                .build()

            val response = httpClient.newCall(request).execute()
            val respCode = response.code
            val respBody = response.body?.string() ?: ""

            if (response.isSuccessful) {
                event.status = "✅ Sukses (HTTP $respCode)"
                event.serverResponse = respBody.take(150)
                Log.i(TAG, "Webhook dispatched successfully: HTTP $respCode - $respBody")
            } else {
                event.status = "❌ Gagal (HTTP $respCode)"
                event.serverResponse = respBody.take(150)
                Log.e(TAG, "Webhook server error: HTTP $respCode - $respBody")
            }
        } catch (e: Exception) {
            event.status = "⚠️ Error Koneksi"
            event.serverResponse = e.message ?: "Network error"
            Log.e(TAG, "Failed to send webhook: ${e.message}", e)
        }
    }
}
