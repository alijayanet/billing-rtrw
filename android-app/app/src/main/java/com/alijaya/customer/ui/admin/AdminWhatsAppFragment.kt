package com.alijaya.customer.ui.admin

import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.cardview.widget.CardView
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.alijaya.customer.CustomerApplication
import com.alijaya.customer.R
import com.alijaya.customer.databinding.FragmentAdminWhatsappBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class AdminWhatsAppFragment : Fragment() {
    private var _binding: FragmentAdminWhatsappBinding? = null
    private val binding get() = _binding!!

    private val colorBg = Color.parseColor("#0F172A")
    private val colorCard = Color.parseColor("#1E293B")
    private val colorWhite = Color.parseColor("#FFFFFF")
    private val colorMuted = Color.parseColor("#94A3B8")
    private val colorAccent = Color.parseColor("#38BDF8")
    private val colorGreen = Color.parseColor("#4ADE80")
    private val colorYellow = Color.parseColor("#FACC15")
    private val colorRed = Color.parseColor("#EF4444")
    private val colorBlue = Color.parseColor("#3B82F6")

    private fun httpClient() = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()

    private fun getBaseUrl(): String {
        val base = CustomerApplication.sessionManager.getServerBaseUrl()
        return if (base.endsWith("/")) base.dropLast(1) else base
    }

    private fun getToken(): String = CustomerApplication.sessionManager.getAuthToken()

    override fun onCreateView(
        inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?
    ): View {
        _binding = FragmentAdminWhatsappBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        binding.swipeRefresh.setOnRefreshListener {
            loadStatus()
        }

        loadStatus()
    }

    private fun loadStatus() {
        binding.swipeRefresh.isRefreshing = true
        lifecycleScope.launch {
            val url = "${getBaseUrl()}/api/customer/app/admin/whatsapp/status"
            val responseStr = withContext(Dispatchers.IO) {
                try {
                    val req = Request.Builder().url(url)
                        .addHeader("Authorization", "Bearer ${getToken()}")
                        .build()
                    val resp = httpClient().newCall(req).execute()
                    if (resp.isSuccessful) resp.body?.string() else null
                } catch (_: Exception) { null }
            }

            binding.swipeRefresh.isRefreshing = false

            if (responseStr != null) {
                try {
                    val json = JSONObject(responseStr)
                    val data = json.optJSONObject("data") ?: JSONObject()
                    val connected = data.optBoolean("connected", false) ||
                            data.optString("status", "").equals("open", ignoreCase = true) ||
                            data.optString("status", "").equals("connected", ignoreCase = true)
                    val statusText = data.optString("status", if (connected) "connected" else "disconnected")
                    val number = data.optString("number", "-")
                    val name = data.optString("name", "WhatsApp Server Bot")

                    renderUI(connected, statusText, number, name)
                    return@launch
                } catch (_: Exception) {}
            }

            renderErrorUI()
        }
    }

    private fun renderUI(connected: Boolean, status: String, number: String, name: String) {
        val ctx = context ?: return
        val container = binding.contentContainer
        container.removeAllViews()

        // 1. Header Card
        val headerCard = CardView(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { setMargins(0, 0, 0, 20) }
            radius = 24f
            setCardBackgroundColor(colorCard)
        }
        val headerLayout = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 28, 32, 28)
        }
        val tvHeaderTitle = TextView(ctx).apply {
            text = "📱 WhatsApp Bot Gateway"
            setTextColor(colorWhite)
            textSize = 18f
            setTypeface(null, Typeface.BOLD)
        }
        val tvHeaderDesc = TextView(ctx).apply {
            text = "Pengiriman otomatis pengingat tagihan, notifikasi bayar lunas, peringatan isolir, dan pesan broadcast pelanggan."
            setTextColor(colorMuted)
            textSize = 12f
            setPadding(0, 6, 0, 0)
        }
        headerLayout.addView(tvHeaderTitle)
        headerLayout.addView(tvHeaderDesc)
        headerCard.addView(headerLayout)
        container.addView(headerCard)

        // 2. Status Card
        val statusCard = CardView(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { setMargins(0, 0, 0, 20) }
            radius = 24f
            setCardBackgroundColor(colorCard)
        }
        val statusLayout = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(32, 36, 32, 36)
        }

        // Status Indicator Circle Icon
        val statusCircle = TextView(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(90, 90).apply {
                gravity = Gravity.CENTER_HORIZONTAL
                setMargins(0, 0, 0, 16)
            }
            gravity = Gravity.CENTER
            textSize = 36f
            text = if (connected) "🟢" else "🔴"
        }
        statusLayout.addView(statusCircle)

        // Status Label Pill Badge
        val tvStatusBadge = TextView(ctx).apply {
            text = if (connected) "  TERHUBUNG (ONLINE)  " else "  TERPUTUS (OFFLINE)  "
            setTextColor(if (connected) colorGreen else colorRed)
            textSize = 13f
            setTypeface(null, Typeface.BOLD)
            gravity = Gravity.CENTER
            setPadding(24, 10, 24, 10)
            val bg = GradientDrawable().apply {
                setColor(if (connected) Color.parseColor("#153728") else Color.parseColor("#371515"))
                cornerRadius = 20f
                setStroke(2, if (connected) colorGreen else colorRed)
            }
            background = bg
        }
        statusLayout.addView(tvStatusBadge)

        // Bot Details Layout
        val detailsLayout = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, 28, 0, 0)
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
        }

        fun createInfoRow(label: String, value: String, valueColor: Int = colorWhite): LinearLayout {
            return LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                setPadding(0, 10, 0, 10)
                val tvLabel = TextView(ctx).apply {
                    layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                    text = label
                    setTextColor(colorMuted)
                    textSize = 13f
                }
                val tvVal = TextView(ctx).apply {
                    text = value
                    setTextColor(valueColor)
                    textSize = 13f
                    setTypeface(null, Typeface.BOLD)
                }
                addView(tvLabel)
                addView(tvVal)
            }
        }

        detailsLayout.addView(createInfoRow("Nomor Bot Server", if (number.isNotEmpty() && number != "-") number else "Tidak diketahui", colorAccent))
        detailsLayout.addView(createInfoRow("Nama Bot / Profil", if (name.isNotEmpty()) name else "WhatsApp Gateway", colorWhite))
        detailsLayout.addView(createInfoRow("Status Koneksi Sesi", status.uppercase(), if (connected) colorGreen else colorYellow))

        statusLayout.addView(detailsLayout)
        statusCard.addView(statusLayout)
        container.addView(statusCard)

        // 3. Test Send Action Card
        val actionCard = CardView(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { setMargins(0, 0, 0, 20) }
            radius = 24f
            setCardBackgroundColor(colorCard)
        }
        val actionLayout = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 28, 32, 28)
        }

        val tvActionTitle = TextView(ctx).apply {
            text = "🚀 Uji Coba Pengiriman Pesan"
            setTextColor(colorWhite)
            textSize = 15f
            setTypeface(null, Typeface.BOLD)
        }
        val tvActionDesc = TextView(ctx).apply {
            text = "Kirim pesan uji coba langsung dari bot server ke nomor WhatsApp tertentu untuk memastikan gateway berfungsi normal."
            setTextColor(colorMuted)
            textSize = 12f
            setPadding(0, 4, 0, 16)
        }

        val btnTestSend = Button(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                110
            )
            text = "✉️ Tes Kirim Pesan WhatsApp"
            textSize = 13f
            setBackgroundColor(colorBlue)
            setTextColor(colorWhite)
            setOnClickListener {
                showTestSendDialog()
            }
        }

        actionLayout.addView(tvActionTitle)
        actionLayout.addView(tvActionDesc)
        actionLayout.addView(btnTestSend)
        actionCard.addView(actionLayout)
        container.addView(actionCard)

        // 4. Feature Info Card
        val infoCard = CardView(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { setMargins(0, 0, 0, 20) }
            radius = 24f
            setCardBackgroundColor(colorCard)
        }
        val infoLayout = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 28, 32, 28)
        }
        val tvInfoTitle = TextView(ctx).apply {
            text = "⚡ Notifikasi Otomatis yang Terhubung"
            setTextColor(colorWhite)
            textSize = 14f
            setTypeface(null, Typeface.BOLD)
        }
        val tvInfoContent = TextView(ctx).apply {
            text = "• 📢 Pengingat Tagihan Bulanan (Billing Reminder)\n" +
                    "• 🔴 Pemberitahuan Terisolir Otomatis (Suspension Alert)\n" +
                    "• 🟢 Konfirmasi Pembayaran Tagihan Lunas\n" +
                    "• 🎫 Notifikasi Tiket Gangguan Masuk untuk Teknisi & Admin\n" +
                    "• 🎟️ Pengiriman Kode Voucher Hotspot Pembeli"
            setTextColor(colorMuted)
            textSize = 12f
            setPadding(0, 10, 0, 0)
            setLineSpacing(6f, 1f)
        }
        infoLayout.addView(tvInfoTitle)
        infoLayout.addView(tvInfoContent)
        infoCard.addView(infoLayout)
        container.addView(infoCard)
    }

    private fun renderErrorUI() {
        val ctx = context ?: return
        val container = binding.contentContainer
        container.removeAllViews()

        val card = CardView(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
            radius = 24f
            setCardBackgroundColor(colorCard)
        }
        val layout = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(32, 48, 32, 48)
        }
        val tvErr = TextView(ctx).apply {
            text = "⚠️ Gagal terhubung ke server WhatsApp.\nTarik ke bawah untuk memuat ulang."
            setTextColor(colorMuted)
            textSize = 13f
            gravity = Gravity.CENTER
        }
        val btnRetry = Button(ctx, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
            text = "Coba Lagi"
            setTextColor(colorAccent)
            setOnClickListener { loadStatus() }
        }
        layout.addView(tvErr)
        layout.addView(btnRetry)
        card.addView(layout)
        container.addView(card)
    }

    private fun showTestSendDialog() {
        val ctx = context ?: return
        val layout = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(50, 30, 50, 10)
        }

        val tvLabelPhone = TextView(ctx).apply {
            text = "Nomor WhatsApp Penerima:"
            setTextColor(colorWhite)
            textSize = 12f
        }
        val etPhone = EditText(ctx).apply {
            hint = "081234567890"
            setHintTextColor(colorMuted)
            setTextColor(colorWhite)
            textSize = 13f
        }

        val tvLabelMsg = TextView(ctx).apply {
            text = "Pesan Uji Coba:"
            setTextColor(colorWhite)
            textSize = 12f
            setPadding(0, 16, 0, 0)
        }
        val etMessage = EditText(ctx).apply {
            hint = "Tulis pesan tes..."
            setText("Halo! Ini adalah pesan uji coba dari Bot WhatsApp ISP Server. Gateway aktif & berjalan dengan baik.")
            setHintTextColor(colorMuted)
            setTextColor(colorWhite)
            textSize = 13f
            minLines = 3
        }

        layout.addView(tvLabelPhone)
        layout.addView(etPhone)
        layout.addView(tvLabelMsg)
        layout.addView(etMessage)

        AlertDialog.Builder(ctx)
            .setTitle("💬 Tes Kirim Pesan WhatsApp")
            .setView(layout)
            .setPositiveButton("🚀 Kirim") { _, _ ->
                val phone = etPhone.text.toString().trim()
                val msg = etMessage.text.toString().trim()
                if (phone.isEmpty() || msg.isEmpty()) {
                    Toast.makeText(ctx, "Nomor dan pesan wajib diisi!", Toast.LENGTH_SHORT).show()
                } else {
                    executeSendTest(phone, msg)
                }
            }
            .setNegativeButton("Batal", null)
            .show()
    }

    private fun executeSendTest(phone: String, message: String) {
        val ctx = context ?: return
        Toast.makeText(ctx, "Mengirim pesan...", Toast.LENGTH_SHORT).show()

        lifecycleScope.launch {
            val url = "${getBaseUrl()}/api/customer/app/admin/whatsapp/send"
            val bodyJson = JSONObject().apply {
                put("phone", phone)
                put("message", message)
            }.toString()

            val responseStr = withContext(Dispatchers.IO) {
                try {
                    val reqBody = bodyJson.toRequestBody("application/json".toMediaType())
                    val req = Request.Builder().url(url)
                        .addHeader("Authorization", "Bearer ${getToken()}")
                        .post(reqBody).build()
                    val resp = httpClient().newCall(req).execute()
                    resp.body?.string()
                } catch (_: Exception) { null }
            }

            if (responseStr != null) {
                try {
                    val json = JSONObject(responseStr)
                    val msg = json.optString("message", "Pesan berhasil diproses")
                    if (json.optBoolean("success")) {
                        Toast.makeText(ctx, "✅ $msg", Toast.LENGTH_LONG).show()
                    } else {
                        Toast.makeText(ctx, "⚠️ $msg", Toast.LENGTH_LONG).show()
                    }
                    loadStatus()
                    return@launch
                } catch (_: Exception) {}
            }

            Toast.makeText(ctx, "Gagal mengirim pesan via server WhatsApp", Toast.LENGTH_LONG).show()
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}
