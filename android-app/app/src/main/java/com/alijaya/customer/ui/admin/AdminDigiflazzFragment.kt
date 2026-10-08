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
import android.widget.LinearLayout
import android.widget.TextView
import androidx.cardview.widget.CardView
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.alijaya.customer.CustomerApplication
import com.alijaya.customer.databinding.FragmentAdminDigiflazzBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.text.NumberFormat
import java.util.Locale
import java.util.concurrent.TimeUnit

class AdminDigiflazzFragment : Fragment() {
    private var _binding: FragmentAdminDigiflazzBinding? = null
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
        _binding = FragmentAdminDigiflazzBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        binding.swipeRefresh.setOnRefreshListener {
            loadStatus()
        }

        loadStatus()
    }

    private fun loadStatus(showToast: Boolean = false) {
        binding.swipeRefresh.isRefreshing = true
        lifecycleScope.launch {
            val url = "${getBaseUrl()}/api/customer/app/admin/digiflazz/status"
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
                    val enabled = data.optBoolean("enabled", false)
                    val username = data.optString("username", "-")
                    val saldo = data.optDouble("saldo", 0.0)
                    val todayCount = data.optInt("todayCount", 0)
                    val todayTotal = data.optDouble("todayTotal", 0.0)

                    renderUI(enabled, username, saldo, todayCount, todayTotal)
                    if (showToast) {
                        val fmt = NumberFormat.getCurrencyInstance(Locale("id", "ID"))
                        val msg = if (enabled) "Saldo Digiflazz: ${fmt.format(saldo)}" else "Digiflazz belum aktif / Kunci API belum diisi"
                        android.widget.Toast.makeText(context, msg, android.widget.Toast.LENGTH_SHORT).show()
                    }
                    return@launch
                } catch (_: Exception) {}
            }

            renderErrorUI()
            if (showToast) {
                android.widget.Toast.makeText(context, "Gagal mengambil status Digiflazz", android.widget.Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun renderUI(enabled: Boolean, username: String, saldo: Double, todayCount: Int, todayTotal: Double) {
        val ctx = context ?: return
        val container = binding.contentContainer
        container.removeAllViews()

        val fmt = NumberFormat.getCurrencyInstance(Locale("id", "ID"))

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
            text = "⚡ Digiflazz H2H Gateway"
            setTextColor(colorWhite)
            textSize = 18f
            setTypeface(null, Typeface.BOLD)
        }
        val tvHeaderDesc = TextView(ctx).apply {
            text = "Integrasi server PPOB otomatis untuk pengisian Pulsa, Paket Data, Token PLN, dan Saldo E-Wallet via Agen & Kasir."
            setTextColor(colorMuted)
            textSize = 12f
            setPadding(0, 6, 0, 0)
        }
        headerLayout.addView(tvHeaderTitle)
        headerLayout.addView(tvHeaderDesc)
        headerCard.addView(headerLayout)
        container.addView(headerCard)

        // 2. Status & Credentials Card
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
            setPadding(32, 28, 32, 28)
        }

        val topStatusRow = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        val tvStatusTitle = TextView(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
            text = "Status Integrasi"
            setTextColor(colorWhite)
            textSize = 15f
            setTypeface(null, Typeface.BOLD)
        }
        val tvBadge = TextView(ctx).apply {
            text = if (enabled) "  🟢 AKTIF  " else "  🔴 NON-AKTIF  "
            setTextColor(if (enabled) colorGreen else colorRed)
            textSize = 11.5f
            setTypeface(null, Typeface.BOLD)
            setPadding(20, 8, 20, 8)
            val bg = GradientDrawable().apply {
                setColor(if (enabled) Color.parseColor("#153728") else Color.parseColor("#371515"))
                cornerRadius = 16f
                setStroke(2, if (enabled) colorGreen else colorRed)
            }
            background = bg
        }
        topStatusRow.addView(tvStatusTitle)
        topStatusRow.addView(tvBadge)
        statusLayout.addView(topStatusRow)

        // Info Rows
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

        val divider = View(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 2
            ).apply { setMargins(0, 16, 0, 16) }
            setBackgroundColor(Color.parseColor("#334155"))
        }
        statusLayout.addView(divider)
        statusLayout.addView(createInfoRow("Username Digiflazz", if (username.isNotEmpty()) username else "-", colorAccent))
        statusLayout.addView(createInfoRow("Saldo Deposit", fmt.format(saldo), colorGreen))
        statusLayout.addView(createInfoRow("Protokol API", "REST JSON / v1 H2H", colorWhite))
        statusLayout.addView(createInfoRow("Status Layanan", if (enabled) "Siap Melayani Transaksi" else "Kunci API Belum Dikonfigurasi", if (enabled) colorGreen else colorYellow))

        val btnCheckSaldo = Button(ctx, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
            text = "🔄 Cek Saldo Terkini"
            setTextColor(colorAccent)
            textSize = 12f
            setOnClickListener {
                android.widget.Toast.makeText(ctx, "Mengecek status & saldo ke server...", android.widget.Toast.LENGTH_SHORT).show()
                loadStatus(showToast = true)
            }
        }
        statusLayout.addView(btnCheckSaldo)

        statusCard.addView(statusLayout)
        container.addView(statusCard)

        // 3. Today Transactions Summary Cards
        val statsRow = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { setMargins(0, 0, 0, 20) }
        }

        // Card 1: Count
        val countCard = CardView(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply {
                marginEnd = 10
            }
            radius = 24f
            setCardBackgroundColor(colorCard)
        }
        val countLayout = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(24, 24, 24, 24)
        }
        val tvCountLabel = TextView(ctx).apply {
            text = "Transaksi Hari Ini"
            setTextColor(colorMuted)
            textSize = 11.5f
        }
        val tvCountVal = TextView(ctx).apply {
            text = "$todayCount"
            setTextColor(colorAccent)
            textSize = 22f
            setTypeface(null, Typeface.BOLD)
            setPadding(0, 6, 0, 0)
        }
        countLayout.addView(tvCountLabel)
        countLayout.addView(tvCountVal)
        countCard.addView(countLayout)

        // Card 2: Total
        val totalCard = CardView(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply {
                marginStart = 10
            }
            radius = 24f
            setCardBackgroundColor(colorCard)
        }
        val totalLayout = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(24, 24, 24, 24)
        }
        val tvTotalLabel = TextView(ctx).apply {
            text = "Nominal Hari Ini"
            setTextColor(colorMuted)
            textSize = 11.5f
        }
        val tvTotalVal = TextView(ctx).apply {
            text = fmt.format(todayTotal)
            setTextColor(colorGreen)
            textSize = 16f
            setTypeface(null, Typeface.BOLD)
            setPadding(0, 6, 0, 0)
        }
        totalLayout.addView(tvTotalLabel)
        totalLayout.addView(tvTotalVal)
        totalCard.addView(totalLayout)

        statsRow.addView(countCard)
        statsRow.addView(totalCard)
        container.addView(statsRow)

        // 4. Products Supported Card
        val productsCard = CardView(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { setMargins(0, 0, 0, 20) }
            radius = 24f
            setCardBackgroundColor(colorCard)
        }
        val productsLayout = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 28, 32, 28)
        }
        val tvProdTitle = TextView(ctx).apply {
            text = "📦 Produk Terintegrasi Otomatis"
            setTextColor(colorWhite)
            textSize = 14.5f
            setTypeface(null, Typeface.BOLD)
        }
        val tvProdDesc = TextView(ctx).apply {
            text = "• 📱 Pulsa Reguler & Transfer Semua Operator\n" +
                    "• 🌐 Paket Data & Kuota Internet Nasional / Lokal\n" +
                    "• ⚡ Token Listrik PLN Prabayar & Tagihan Pascabayar\n" +
                    "• 💳 Top-Up E-Wallet (DANA, OVO, GoPay, ShopeePay, LinkAja)\n" +
                    "• 🎮 Voucher Game Online (Mobile Legends, Free Fire, PUBG)"
            setTextColor(colorMuted)
            textSize = 12f
            setPadding(0, 10, 0, 0)
            setLineSpacing(6f, 1f)
        }
        productsLayout.addView(tvProdTitle)
        productsLayout.addView(tvProdDesc)
        productsCard.addView(productsLayout)
        container.addView(productsCard)
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
            text = "⚠️ Gagal mengambil status Digiflazz.\nTarik ke bawah untuk memuat ulang."
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

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}
