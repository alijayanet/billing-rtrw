package com.alijaya.customer.ui.home

import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.cardview.widget.CardView
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import com.alijaya.customer.CustomerApplication
import com.alijaya.customer.R
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.text.NumberFormat
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.concurrent.TimeUnit

class CustomerPpobFragment : Fragment() {
    private fun httpClient() = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(15, TimeUnit.SECONDS).build()
    private fun getBaseUrl(): String { val b = CustomerApplication.sessionManager.getServerBaseUrl(); return if (b.endsWith("/")) b.dropLast(1) else b }
    private fun getToken(): String = CustomerApplication.sessionManager.getAuthToken()
    private val fmt = NumberFormat.getCurrencyInstance(Locale("id", "ID"))

    private var currentBalance: Double = 0.0
    private var allCatalog = mutableListOf<JSONObject>()
    private var selectedCategory: String = "ALL" // ALL, Pulsa, Data, PLN, E-Wallet, Games
    private var detectedBrand: String = ""

    private lateinit var tvBalance: TextView
    private lateinit var etPhone: EditText
    private lateinit var tvTargetLabel: TextView
    private lateinit var tvProvider: TextView
    private lateinit var etSearch: EditText
    private lateinit var productsContainer: LinearLayout
    private lateinit var historyContainer: LinearLayout
    private val chipButtons = mutableMapOf<String, Button>()

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        val swipe = SwipeRefreshLayout(requireContext()).apply { setBackgroundColor(Color.parseColor("#0F172A")) }
        val scroll = android.widget.ScrollView(requireContext())
        val content = LinearLayout(requireContext()).apply { orientation = LinearLayout.VERTICAL; setPadding(32, 32, 32, 32) }
        scroll.addView(content); swipe.addView(scroll)
        buildUI(content)
        loadData(swipe)
        swipe.setOnRefreshListener { loadData(swipe) }
        return swipe
    }

    private fun buildUI(container: LinearLayout) {
        val ctx = requireContext()
        container.addView(TextView(ctx).apply { 
            text = "📱 Beli Pulsa, Data & Token PLN"
            setTextColor(Color.WHITE)
            textSize = 18f
            typeface = Typeface.DEFAULT_BOLD
            setPadding(0, 0, 0, 4) 
        })

        // 1. Balance Card
        val balCard = CardView(ctx).apply { 
            radius = 24f
            setCardBackgroundColor(Color.parseColor("#132742"))
            cardElevation = 4f
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { setMargins(0, 0, 0, 16) } 
        }
        val balInner = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL; setPadding(24, 20, 24, 20); gravity = Gravity.CENTER_VERTICAL }
        val balCol = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL; layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f) }
        balCol.addView(TextView(ctx).apply { text = "Saldo Dompet Anda"; setTextColor(Color.parseColor("#38BDF8")); textSize = 11.5f; typeface = Typeface.DEFAULT_BOLD })
        tvBalance = TextView(ctx).apply { text = "Rp 0"; setTextColor(Color.WHITE); textSize = 20f; typeface = Typeface.DEFAULT_BOLD; setPadding(0, 4, 0, 0) }
        balCol.addView(tvBalance)
        balInner.addView(balCol)

        val btnTopup = Button(ctx).apply {
            text = "➕ Isi Saldo"
            setBackgroundColor(Color.parseColor("#2563EB"))
            setTextColor(Color.WHITE)
            textSize = 11.5f
            typeface = Typeface.DEFAULT_BOLD
            setOnClickListener {
                parentFragmentManager.beginTransaction()
                    .replace(R.id.fragment_container, CustomerTopupFragment())
                    .addToBackStack(null).commit()
            }
        }
        balInner.addView(btnTopup)
        balCard.addView(balInner)
        container.addView(balCard)

        // 2. Category Chips Bar (ALL, Pulsa, Data, PLN, E-Wallet, Games)
        val chipsScroll = HorizontalScrollView(ctx).apply {
            isHorizontalScrollBarEnabled = false
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { setMargins(0, 0, 0, 12) }
        }
        val chipsLayout = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL }
        val categories = listOf(
            "ALL" to "🌟 Semua",
            "Pulsa" to "📱 Pulsa",
            "Data" to "🌐 Paket Data",
            "PLN" to "⚡ Token PLN",
            "E-Wallet" to "💳 E-Wallet",
            "Games" to "🎮 Games"
        )
        for ((catKey, catLabel) in categories) {
            val chip = Button(ctx).apply {
                text = catLabel
                textSize = 11f
                typeface = Typeface.DEFAULT_BOLD
                layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, 80).apply { setMargins(0, 0, 10, 0) }
                setOnClickListener {
                    selectedCategory = catKey
                    updateCategoryChipsUI()
                    updateInputHintForCategory()
                    applyFilter()
                }
            }
            chipButtons[catKey] = chip
            chipsLayout.addView(chip)
        }
        chipsScroll.addView(chipsLayout)
        container.addView(chipsScroll)
        updateCategoryChipsUI()

        // 3. Input Target Card
        val inputCard = CardView(ctx).apply { 
            radius = 24f
            setCardBackgroundColor(Color.parseColor("#1E293B"))
            cardElevation = 4f
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { setMargins(0, 0, 0, 16) } 
        }
        val inputInner = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL; setPadding(24, 20, 24, 20) }

        val rowLabel = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        tvTargetLabel = TextView(ctx).apply { 
            text = "NOMOR TUJUAN / HP"
            setTextColor(Color.parseColor("#38BDF8"))
            textSize = 11.5f
            typeface = Typeface.DEFAULT_BOLD
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f) 
        }
        tvProvider = TextView(ctx).apply { text = "Pilih Operator"; setTextColor(Color.parseColor("#4ADE80")); textSize = 11.5f; typeface = Typeface.DEFAULT_BOLD }
        rowLabel.addView(tvTargetLabel)
        rowLabel.addView(tvProvider)
        inputInner.addView(rowLabel)

        etPhone = EditText(ctx).apply {
            hint = "08xxxxxxxxxx"
            setTextColor(Color.WHITE)
            setHintTextColor(Color.parseColor("#64748B"))
            textSize = 18f
            typeface = Typeface.DEFAULT_BOLD
            background = ContextCompat.getDrawable(ctx, R.drawable.bg_input_field)
            setPadding(24, 20, 24, 20)
            inputType = android.text.InputType.TYPE_CLASS_PHONE
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { setMargins(0, 8, 0, 8) }
            addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
                    val p = detectProvider(s.toString().trim())
                    detectedBrand = p
                    tvProvider.text = if (p.isNotEmpty()) "📡 $p" else "Deteksi Otomatis..."
                    applyFilter()
                }
                override fun afterTextChanged(s: Editable?) {}
            })
        }
        inputInner.addView(etPhone)

        // Search Field
        etSearch = EditText(ctx).apply {
            hint = "🔍 Cari nominal / produk (misal: 100rb, 10gb, token)..."
            setTextColor(Color.WHITE)
            setHintTextColor(Color.parseColor("#64748B"))
            textSize = 13f
            background = ContextCompat.getDrawable(ctx, R.drawable.bg_input_field)
            setPadding(20, 14, 20, 14)
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { setMargins(0, 4, 0, 0) }
            addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
                    applyFilter()
                }
                override fun afterTextChanged(s: Editable?) {}
            })
        }
        inputInner.addView(etSearch)
        inputCard.addView(inputInner)
        container.addView(inputCard)

        // 4. Products Container
        container.addView(TextView(ctx).apply { 
            text = "PILIH NOMINAL / PRODUK"; setTextColor(Color.parseColor("#94A3B8")); textSize = 11.5f; typeface = Typeface.DEFAULT_BOLD; setPadding(0, 4, 0, 8) 
        })
        productsContainer = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        container.addView(productsContainer)

        // 5. History Section
        container.addView(TextView(ctx).apply {
            text = "📜 Riwayat Transaksi Saya"
            setTextColor(Color.WHITE)
            textSize = 15f
            typeface = Typeface.DEFAULT_BOLD
            setPadding(0, 32, 0, 8)
        })
        historyContainer = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        container.addView(historyContainer)
    }

    private fun updateCategoryChipsUI() {
        for ((catKey, btn) in chipButtons) {
            val isSelected = (catKey == selectedCategory)
            btn.setBackgroundColor(if (isSelected) Color.parseColor("#2563EB") else Color.parseColor("#1E293B"))
            btn.setTextColor(if (isSelected) Color.WHITE else Color.parseColor("#94A3B8"))
        }
    }

    private fun updateInputHintForCategory() {
        if (selectedCategory == "PLN") {
            tvTargetLabel.text = "NOMOR METER / ID PELANGGAN PLN"
            etPhone.hint = "Nomor Meter / ID PLN (11-12 digit)"
            tvProvider.text = "⚡ PLN Prabayar"
        } else {
            tvTargetLabel.text = "NOMOR TUJUAN / HP"
            etPhone.hint = "08xxxxxxxxxx"
            tvProvider.text = if (detectedBrand.isNotEmpty()) "📡 $detectedBrand" else "Deteksi Otomatis..."
        }
    }

    private fun detectProvider(phone: String): String {
        val clean = phone.replace("+62", "0").replace(Regex("[^0-9]"), "").trim()
        if (clean.length < 4) return ""

        // PLN Detection: 10-12 digits starting with common PLN prefixes
        if (clean.length >= 10 && (clean.startsWith("14") || clean.startsWith("22") || clean.startsWith("32") ||
                    clean.startsWith("56") || clean.startsWith("01") || clean.startsWith("86") || clean.startsWith("53"))) {
            return "PLN"
        }

        val prefix = clean.take(4)
        return when (prefix) {
            "0811", "0812", "0813", "0821", "0822", "0823", "0851", "0852", "0853" -> "Telkomsel"
            "0814", "0815", "0816", "0855", "0856", "0857", "0858" -> "Indosat"
            "0817", "0818", "0819", "0859", "0877", "0878" -> "XL"
            "0831", "0832", "0833", "0838" -> "Axis"
            "0895", "0896", "0897", "0898", "0899" -> "Tri"
            "0881", "0882", "0883", "0884", "0885", "0886", "0887", "0888", "0889" -> "Smartfren"
            else -> ""
        }
    }

    private fun loadData(swipe: SwipeRefreshLayout) {
        swipe.isRefreshing = true
        lifecycleScope.launch {
            val (balJson, catJson, histJson) = withContext(Dispatchers.IO) {
                val b = try {
                    val req = Request.Builder().url("${getBaseUrl()}/api/customer/app/customer/wallet").addHeader("Authorization", "Bearer ${getToken()}").build()
                    val resp = httpClient().newCall(req).execute()
                    if (resp.isSuccessful) resp.body?.string()?.let { JSONObject(it) } else null
                } catch (_: Exception) { null }
                val c = try {
                    val req = Request.Builder().url("${getBaseUrl()}/api/customer/app/customer/ppob/catalog").addHeader("Authorization", "Bearer ${getToken()}").build()
                    val resp = httpClient().newCall(req).execute()
                    if (resp.isSuccessful) resp.body?.string()?.let { JSONObject(it) } else null
                } catch (_: Exception) { null }
                val h = try {
                    val req = Request.Builder().url("${getBaseUrl()}/api/customer/app/customer/ppob/history").addHeader("Authorization", "Bearer ${getToken()}").build()
                    val resp = httpClient().newCall(req).execute()
                    if (resp.isSuccessful) resp.body?.string()?.let { JSONObject(it) } else null
                } catch (_: Exception) { null }
                Triple(b, c, h)
            }
            swipe.isRefreshing = false

            currentBalance = balJson?.optJSONObject("data")?.optDouble("balance", 0.0) ?: 0.0
            tvBalance.text = fmt.format(currentBalance)

            // Flexible array extraction: data as Array, or data.products, or products
            val arr = catJson?.optJSONArray("data")
                ?: catJson?.optJSONObject("data")?.optJSONArray("products")
                ?: catJson?.optJSONArray("products")
                ?: JSONArray()

            allCatalog.clear()
            for (i in 0 until arr.length()) {
                allCatalog.add(arr.getJSONObject(i))
            }

            applyFilter()

            // Render riwayat
            val histArr = histJson?.optJSONArray("data") ?: JSONArray()
            renderHistory(histArr)
        }
    }

    private fun refreshHistory() {
        lifecycleScope.launch {
            val histJson = withContext(Dispatchers.IO) {
                try {
                    val req = Request.Builder().url("${getBaseUrl()}/api/customer/app/customer/ppob/history")
                        .addHeader("Authorization", "Bearer ${getToken()}").build()
                    val resp = httpClient().newCall(req).execute()
                    if (resp.isSuccessful) resp.body?.string()?.let { JSONObject(it) } else null
                } catch (_: Exception) { null }
            }
            val histArr = histJson?.optJSONArray("data") ?: JSONArray()
            renderHistory(histArr)
        }
    }

    private fun renderHistory(histArr: JSONArray) {
        val ctx = context ?: return
        historyContainer.removeAllViews()

        if (histArr.length() == 0) {
            historyContainer.addView(TextView(ctx).apply {
                text = "Belum ada transaksi PPOB."
                setTextColor(Color.parseColor("#64748B"))
                textSize = 13f
                setPadding(0, 8, 0, 24)
            })
            return
        }

        val inputFmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.getDefault())
        val inputFmt2 = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.getDefault())
        val outputFmt = SimpleDateFormat("dd MMM yyyy, HH:mm", Locale("id", "ID"))

        for (i in 0 until histArr.length()) {
            val tx = histArr.getJSONObject(i)
            val status = tx.optString("status", "processing")
            val isSuccess = status == "fulfilled"
            val isFailed = status == "failed"

            val statusIcon = if (isSuccess) "✅" else if (isFailed) "❌" else "⏳"
            val statusColor = if (isSuccess) "#4ADE80" else if (isFailed) "#F87171" else "#FBBF24"
            val statusText = if (isSuccess) "BERHASIL" else if (isFailed) "GAGAL" else "DIPROSES"

            val rawDate = tx.optString("created_at", "")
            val displayDate = try {
                val parsed = try { inputFmt.parse(rawDate) } catch (_: Exception) { inputFmt2.parse(rawDate) }
                if (parsed != null) outputFmt.format(parsed) else rawDate
            } catch (_: Exception) { rawDate }

            val card = CardView(ctx).apply {
                radius = 20f
                setCardBackgroundColor(Color.parseColor("#1E293B"))
                cardElevation = 2f
                layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { setMargins(0, 0, 0, 10) }
            }
            val inner = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL; setPadding(20, 16, 20, 16) }

            // Row 1: Status icon + Product name + Price
            val row1 = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
            row1.addView(TextView(ctx).apply { text = statusIcon; textSize = 18f; setPadding(0, 0, 10, 0) })
            val col1 = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL; layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f) }
            col1.addView(TextView(ctx).apply {
                text = tx.optString("product_name", "-")
                setTextColor(Color.WHITE); textSize = 13.5f; typeface = Typeface.DEFAULT_BOLD
            })
            col1.addView(TextView(ctx).apply {
                text = "🎯 ${tx.optString("target", "-")}  •  $displayDate"
                setTextColor(Color.parseColor("#94A3B8")); textSize = 11f
            })
            row1.addView(col1)
            row1.addView(TextView(ctx).apply {
                text = fmt.format(tx.optDouble("price", 0.0))
                setTextColor(Color.parseColor("#F87171")); textSize = 13f; typeface = Typeface.DEFAULT_BOLD; gravity = Gravity.END
            })
            inner.addView(row1)

            // Row 2: Status badge + SN/pesan
            val row2 = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(0, 6, 0, 0) }
            row2.addView(TextView(ctx).apply {
                text = statusText; setTextColor(Color.parseColor(statusColor)); textSize = 10.5f; typeface = Typeface.DEFAULT_BOLD
                layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { setMargins(0, 0, 12, 0) }
            })
            val sn = tx.optString("digi_sn", "")
            val msg = tx.optString("digi_message", "")
            val snText = when {
                sn.isNotBlank() -> "SN: $sn"
                msg.isNotBlank() -> msg
                else -> ""
            }
            if (snText.isNotBlank()) {
                row2.addView(TextView(ctx).apply {
                    text = snText; setTextColor(Color.parseColor("#64748B")); textSize = 10.5f
                    maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END
                })
            }
            inner.addView(row2)

            card.addView(inner)
            historyContainer.addView(card)
        }
    }

    private fun applyFilter() {
        val ctx = context ?: return
        productsContainer.removeAllViews()

        val query = etSearch.text.toString().trim().lowercase()
        val provider = detectedBrand

        var list = allCatalog.asSequence()

        // Filter Category Chip
        if (selectedCategory != "ALL") {
            list = when (selectedCategory) {
                "PLN" -> list.filter { 
                    it.optString("category", "").equals("PLN", ignoreCase = true) || 
                    it.optString("brand", "").equals("PLN", ignoreCase = true) ||
                    it.optString("product_name", "").contains("PLN", ignoreCase = true)
                }
                "Pulsa" -> list.filter { it.optString("category", "").equals("Pulsa", ignoreCase = true) }
                "Data" -> list.filter { 
                    it.optString("category", "").equals("Data", ignoreCase = true) || 
                    it.optString("product_name", "").contains("GB", ignoreCase = true) 
                }
                "E-Wallet" -> list.filter { 
                    it.optString("category", "").equals("E-Wallet", ignoreCase = true) ||
                    listOf("dana", "ovo", "gopay", "shopee", "linkaja").any { w -> it.optString("brand", "").lowercase().contains(w) }
                }
                "Games" -> list.filter { it.optString("category", "").contains("Game", ignoreCase = true) }
                else -> list
            }
        }

        // Filter Detected Provider / Brand (if phone number is typed)
        if (provider.isNotEmpty() && selectedCategory != "PLN" && provider != "PLN") {
            list = list.filter { 
                it.optString("brand", "").contains(provider, ignoreCase = true) ||
                it.optString("product_name", "").contains(provider, ignoreCase = true)
            }
        } else if (provider == "PLN" || selectedCategory == "PLN") {
            list = list.filter {
                it.optString("category", "").equals("PLN", ignoreCase = true) || 
                it.optString("brand", "").equals("PLN", ignoreCase = true) ||
                it.optString("product_name", "").contains("PLN", ignoreCase = true)
            }
        }

        // Filter Search Text
        if (query.isNotEmpty()) {
            list = list.filter {
                it.optString("product_name", "").lowercase().contains(query) ||
                it.optString("sku", "").lowercase().contains(query) ||
                it.optString("brand", "").lowercase().contains(query)
            }
        }

        val filtered = list.toList()

        if (filtered.isEmpty()) {
            productsContainer.addView(TextView(ctx).apply {
                text = if (provider.isNotEmpty()) "Belum ada produk untuk $provider" else "Tidak ada produk yang sesuai kriteria pencarian"
                setTextColor(Color.parseColor("#94A3B8"))
                textSize = 13f
                gravity = Gravity.CENTER
                setPadding(0, 40, 0, 40)
            })
            return
        }

        // Sort by price
        val sorted = filtered.sortedBy { it.optDouble("price_sell", it.optDouble("price", 0.0)) }

        for (item in sorted) {
            val price = item.optDouble("price_sell", item.optDouble("price", 0.0))
            val card = CardView(ctx).apply {
                radius = 20f
                setCardBackgroundColor(Color.parseColor("#1E293B"))
                cardElevation = 3f
                layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { setMargins(0, 0, 0, 10) }
                isClickable = true
                isFocusable = true
            }
            val inner = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL; setPadding(20, 16, 20, 16); gravity = Gravity.CENTER_VERTICAL }
            val col = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL; layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f) }
            col.addView(TextView(ctx).apply { text = item.optString("product_name", "-"); setTextColor(Color.WHITE); textSize = 13.5f; typeface = Typeface.DEFAULT_BOLD })
            col.addView(TextView(ctx).apply { text = "${item.optString("category", "Pulsa")} • ${item.optString("brand", "-")}"; setTextColor(Color.parseColor("#94A3B8")); textSize = 11f })
            inner.addView(col)
            inner.addView(TextView(ctx).apply { text = fmt.format(price); setTextColor(Color.parseColor("#4ADE80")); textSize = 14f; typeface = Typeface.DEFAULT_BOLD })
            card.addView(inner)
            card.setOnClickListener { confirmPurchase(item) }
            productsContainer.addView(card)
        }
    }

    private fun confirmPurchase(item: JSONObject) {
        val ctx = context ?: return
        val target = etPhone.text.toString().trim()
        if (target.length < 9) { 
            Toast.makeText(ctx, "Masukkan nomor telepon / nomor meter PLN tujuan yang valid terlebih dahulu", Toast.LENGTH_SHORT).show()
            return 
        }

        val prodName = item.optString("product_name")
        val sku = item.optString("sku")
        val price = item.optDouble("price_sell", item.optDouble("price", 0.0))

        AlertDialog.Builder(ctx)
            .setTitle("Konfirmasi Pembelian")
            .setMessage("Beli: $prodName\nNomor Tujuan: $target\nHarga: ${fmt.format(price)}\n\nSaldo Anda saat ini: ${fmt.format(currentBalance)}")
            .setPositiveButton("Beli Sekarang") { _, _ ->
                doPurchase(sku, target)
            }
            .setNegativeButton("Batal", null)
            .show()
    }

    private fun doPurchase(sku: String, target: String) {
        val ctx = context ?: return
        Toast.makeText(ctx, "Memproses transaksi...", Toast.LENGTH_SHORT).show()
        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) {
                try {
                    val body = JSONObject().put("sku", sku).put("target", target).toString().toRequestBody("application/json".toMediaType())
                    val req = Request.Builder().url("${getBaseUrl()}/api/customer/app/customer/ppob/order")
                        .addHeader("Authorization", "Bearer ${getToken()}").post(body).build()
                    val resp = httpClient().newCall(req).execute()
                    resp.body?.string()?.let { JSONObject(it) }
                } catch (_: Exception) { null }
            }

            if (result?.optBoolean("success") == true) {
                Toast.makeText(ctx, "✅ ${result.optString("message")}", Toast.LENGTH_LONG).show()
                val remBal = result.optJSONObject("data")?.optDouble("remainingBalance", currentBalance) ?: currentBalance
                currentBalance = remBal
                tvBalance.text = fmt.format(currentBalance)
                refreshHistory() // Perbarui riwayat setelah transaksi berhasil
            } else {
                Toast.makeText(ctx, "❌ ${result?.optString("message") ?: "Gagal memproses transaksi"}", Toast.LENGTH_LONG).show()
            }
        }
    }
}
