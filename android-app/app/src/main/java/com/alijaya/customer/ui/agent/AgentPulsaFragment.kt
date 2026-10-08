package com.alijaya.customer.ui.agent

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.alijaya.customer.CustomerApplication
import com.alijaya.customer.R
import com.alijaya.customer.databinding.FragmentAgentPulsaBinding
import com.alijaya.customer.databinding.ItemAgentPulsaBinding
import com.alijaya.customer.util.BluetoothPrinterHelper
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
import java.util.Locale
import java.util.concurrent.TimeUnit

data class PulsaProduct(
    val sku: String,
    val name: String,
    val category: String,
    val brand: String,
    val priceModal: Long,
    val priceSell: Long
)

class AgentPulsaFragment : Fragment() {
    private var _binding: FragmentAgentPulsaBinding? = null
    private val binding get() = _binding!!

    private var allProducts = mutableListOf<PulsaProduct>()
    private var filteredProducts = mutableListOf<PulsaProduct>()
    private lateinit var adapter: PulsaProductAdapter
    private var selectedCategory: String = "ALL" // ALL, Pulsa, Data, PLN, E-Wallet

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
        _binding = FragmentAgentPulsaBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        adapter = PulsaProductAdapter(filteredProducts) { prod ->
            showBuyPulsaDialog(prod)
        }

        binding.rvPulsaProducts.layoutManager = LinearLayoutManager(context)
        binding.rvPulsaProducts.adapter = adapter

        binding.swipeRefresh.setOnRefreshListener {
            loadCatalog()
        }

        setupChips()
        setupInputs()
        loadCatalog()
    }

    private fun setupChips() {
        binding.chipAll.setOnClickListener {
            selectedCategory = "ALL"
            updateChipStyles()
            applyFilter()
        }
        binding.chipPulsa.setOnClickListener {
            selectedCategory = "Pulsa"
            updateChipStyles()
            applyFilter()
        }
        binding.chipData.setOnClickListener {
            selectedCategory = "Data"
            updateChipStyles()
            applyFilter()
        }
        binding.chipPln.setOnClickListener {
            selectedCategory = "PLN"
            updateChipStyles()
            applyFilter()
        }
        binding.chipEwallet.setOnClickListener {
            selectedCategory = "E-Wallet"
            updateChipStyles()
            applyFilter()
        }
        updateChipStyles()
    }

    private fun updateChipStyles() {
        val activeBg = ContextCompat.getColor(requireContext(), R.color.primary)
        val inactiveBg = ContextCompat.getColor(requireContext(), R.color.card_dark)

        binding.chipAll.setBackgroundColor(if (selectedCategory == "ALL") activeBg else inactiveBg)
        binding.chipPulsa.setBackgroundColor(if (selectedCategory == "Pulsa") activeBg else inactiveBg)
        binding.chipData.setBackgroundColor(if (selectedCategory == "Data") activeBg else inactiveBg)
        binding.chipPln.setBackgroundColor(if (selectedCategory == "PLN") activeBg else inactiveBg)
        binding.chipEwallet.setBackgroundColor(if (selectedCategory == "E-Wallet") activeBg else inactiveBg)
    }

    private var detectedBrand: String = ""

    private fun setupInputs() {
        binding.etTargetNumber.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
                detectProvider(s.toString().trim())
            }
            override fun afterTextChanged(s: Editable?) {}
        })

        binding.etSearchProduct.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
                applyFilter()
            }
            override fun afterTextChanged(s: Editable?) {}
        })
    }

    private fun detectProvider(phone: String) {
        val clean = phone.replace(Regex("[^0-9]"), "")
        val provider = when {
            clean.startsWith("0811") || clean.startsWith("0812") || clean.startsWith("0813") ||
            clean.startsWith("0821") || clean.startsWith("0822") || clean.startsWith("0823") ||
            clean.startsWith("0852") || clean.startsWith("0853") || clean.startsWith("0851") -> "Telkomsel"
            clean.startsWith("0814") || clean.startsWith("0815") || clean.startsWith("0816") ||
            clean.startsWith("0855") || clean.startsWith("0856") || clean.startsWith("0857") || clean.startsWith("0858") -> "Indosat"
            clean.startsWith("0817") || clean.startsWith("0818") || clean.startsWith("0819") ||
            clean.startsWith("0859") || clean.startsWith("0877") || clean.startsWith("0878") -> "XL"
            clean.startsWith("0831") || clean.startsWith("0832") || clean.startsWith("0833") || clean.startsWith("0838") -> "Axis"
            clean.startsWith("0895") || clean.startsWith("0896") || clean.startsWith("0897") || clean.startsWith("0898") || clean.startsWith("0899") -> "Tri"
            clean.startsWith("0881") || clean.startsWith("0882") || clean.startsWith("0883") || clean.startsWith("0887") || clean.startsWith("0888") || clean.startsWith("0889") -> "Smartfren"
            clean.length >= 10 && (clean.startsWith("14") || clean.startsWith("22") || clean.startsWith("32") || clean.startsWith("56") || clean.startsWith("01") || clean.startsWith("86")) -> "PLN"
            else -> ""
        }

        detectedBrand = provider
        binding.tvDetectedProvider.text = if (provider.isNotEmpty()) "📱 $provider" else "📱 Otomatis"
        applyFilter()
    }

    private fun loadCatalog() {
        binding.swipeRefresh.isRefreshing = true
        lifecycleScope.launch {
            val url = "${getBaseUrl()}/api/customer/agent/pulsa/catalog"
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
                    val data = json.optJSONObject("data")
                    allProducts.clear()

                    val prodsArr = data?.optJSONArray("products") ?: JSONArray()
                    for (i in 0 until prodsArr.length()) {
                        val p = prodsArr.getJSONObject(i)
                        allProducts.add(
                            PulsaProduct(
                                sku = p.optString("sku", ""),
                                name = p.optString("product_name", p.optString("name", "")),
                                category = p.optString("category", "Pulsa"),
                                brand = p.optString("brand", "Telkomsel"),
                                priceModal = p.optLong("price_modal", 0),
                                priceSell = p.optLong("price_sell", 0)
                            )
                        )
                    }

                    applyFilter()
                } catch (_: Exception) {
                    binding.tvEmptyPulsa.visibility = View.VISIBLE
                    binding.tvEmptyPulsa.text = "Gagal memproses katalog pulsa"
                }
            } else {
                binding.tvEmptyPulsa.visibility = View.VISIBLE
                binding.tvEmptyPulsa.text = "Gagal terhubung ke server katalog pulsa"
            }
        }
    }

    private fun applyFilter() {
        filteredProducts.clear()
        val query = binding.etSearchProduct.text.toString().trim().lowercase()

        for (p in allProducts) {
            val matchBrand = if (detectedBrand.isNotEmpty()) {
                p.brand.contains(detectedBrand, ignoreCase = true) ||
                p.name.contains(detectedBrand, ignoreCase = true) ||
                p.sku.contains(detectedBrand, ignoreCase = true)
            } else {
                true
            }

            val matchCat = when (selectedCategory) {
                "ALL" -> true
                else -> p.category.equals(selectedCategory, ignoreCase = true) || p.name.contains(selectedCategory, ignoreCase = true)
            }

            val matchQuery = query.isEmpty() ||
                             p.name.lowercase().contains(query) ||
                             p.sku.lowercase().contains(query) ||
                             p.brand.lowercase().contains(query)

            if (matchBrand && matchCat && matchQuery) {
                filteredProducts.add(p)
            }
        }

        // Urutkan nominal dari yang terkecil ke terbesar
        filteredProducts.sortBy { it.priceSell }

        adapter.notifyDataSetChanged()
        if (filteredProducts.isEmpty()) {
            binding.tvEmptyPulsa.visibility = View.VISIBLE
            val brandHint = if (detectedBrand.isNotEmpty()) " untuk operator $detectedBrand" else ""
            binding.tvEmptyPulsa.text = "Tidak ada produk pulsa yang cocok$brandHint"
            binding.rvPulsaProducts.visibility = View.GONE
        } else {
            binding.tvEmptyPulsa.visibility = View.GONE
            binding.rvPulsaProducts.visibility = View.VISIBLE
        }
    }

    private fun showBuyPulsaDialog(prod: PulsaProduct) {
        val ctx = context ?: return
        val target = binding.etTargetNumber.text.toString().trim()

        if (target.isEmpty()) {
            Toast.makeText(ctx, "Harap masukkan nomor tujuan terlebih dahulu!", Toast.LENGTH_SHORT).show()
            binding.etTargetNumber.requestFocus()
            return
        }

        val layout = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(40, 24, 40, 10)
        }

        val card = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(android.graphics.Color.parseColor("#1E293B"))
            setPadding(20, 16, 20, 16)
        }

        fun addRow(label: String, value: String, color: Int = android.graphics.Color.WHITE, isBold: Boolean = false, sizeSp: Float = 13.5f) {
            val row = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                setPadding(0, 4, 0, 4)
            }
            val tvL = TextView(ctx).apply {
                text = label
                setTextColor(android.graphics.Color.parseColor("#94A3B8"))
                textSize = 13f
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
            }
            val tvV = TextView(ctx).apply {
                text = value
                setTextColor(color)
                textSize = sizeSp
                if (isBold) typeface = android.graphics.Typeface.DEFAULT_BOLD
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 2f)
                gravity = android.view.Gravity.END
            }
            row.addView(tvL)
            row.addView(tvV)
            card.addView(row)
        }

        addRow("Produk", prod.name, android.graphics.Color.WHITE, true, 14f)
        addRow("Nomor Tujuan", target, android.graphics.Color.parseColor("#38BDF8"), true, 16f)
        addRow("Harga Jual", formatRupiah(prod.priceSell), android.graphics.Color.parseColor("#4ADE80"), true, 16f)

        layout.addView(card)

        val tvWaHint = TextView(ctx).apply {
            text = "Kirim struk otomatis ke WhatsApp pembeli (opsional):"
            setTextColor(android.graphics.Color.parseColor("#CBD5E1"))
            textSize = 12f
            setPadding(0, 12, 0, 6)
        }
        layout.addView(tvWaHint)

        val etBuyerPhone = EditText(ctx).apply {
            hint = "Nomor WA Pembeli (misal: 0812...)"
            inputType = android.text.InputType.TYPE_CLASS_PHONE
            setTextColor(android.graphics.Color.WHITE)
            textSize = 14f
            background = ContextCompat.getDrawable(ctx, R.drawable.bg_input_field)
            setPadding(24, 18, 24, 18)
            setText(if (target.startsWith("08")) target else "")
        }
        layout.addView(etBuyerPhone)

        AlertDialog.Builder(ctx)
            .setTitle("📱 Konfirmasi Pembelian Pulsa")
            .setView(layout)
            .setPositiveButton("Beli Sekarang") { _, _ ->
                val buyerPhone = etBuyerPhone.text.toString().trim().ifEmpty { target }
                executeOrderPulsa(prod, target, buyerPhone)
            }
            .setNegativeButton("Batal", null)
            .show()
    }

    private fun executeOrderPulsa(prod: PulsaProduct, target: String, buyerPhone: String) {
        val ctx = context ?: return
        val progress = android.app.ProgressDialog(ctx).apply {
            setMessage("Memproses transaksi pulsa ke provider...")
            setCancelable(false)
            show()
        }

        lifecycleScope.launch {
            val url = "${getBaseUrl()}/api/customer/agent/pulsa/order"
            val bodyJson = JSONObject().apply {
                put("sku", prod.sku)
                put("target", target)
                put("sell_price", prod.priceSell)
                put("buyer_phone", buyerPhone)
            }.toString()

            val respStr = withContext(Dispatchers.IO) {
                try {
                    val reqBody = bodyJson.toRequestBody("application/json".toMediaType())
                    val req = Request.Builder().url(url)
                        .addHeader("Authorization", "Bearer ${getToken()}")
                        .post(reqBody).build()
                    val resp = httpClient().newCall(req).execute()
                    resp.body?.string()
                } catch (_: Exception) { null }
            }

            progress.dismiss()

            if (respStr != null) {
                try {
                    val json = JSONObject(respStr)
                    val data = json.optJSONObject("data")
                    val status = data?.optString("status", "success") ?: "success"
                    val refId = data?.optString("refId", "-") ?: "-"
                    val sn = data?.optString("sn", "-") ?: "-"
                    val msg = data?.optString("message", json.optString("message", "Transaksi berhasil")) ?: "Transaksi berhasil"

                    showReceiptDialog(prod, target, refId, sn, status, msg, buyerPhone)
                } catch (e: Exception) {
                    Toast.makeText(ctx, "Gagal memproses respon transaksi: ${e.message}", Toast.LENGTH_SHORT).show()
                }
            } else {
                Toast.makeText(ctx, "Gagal terhubung ke server pulsa", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun showReceiptDialog(prod: PulsaProduct, target: String, refId: String, sn: String, status: String, msg: String, buyerPhone: String) {
        val ctx = context ?: return
        val layout = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(36, 20, 36, 10)
        }

        val isPending = status.equals("pending", true) || status.equals("process", true)
        val isFailed = status.equals("failed", true)
        
        // 1. Status Banner Header
        val statusCard = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = android.view.Gravity.CENTER
            setBackgroundColor(
                if (isPending) android.graphics.Color.parseColor("#854D0E") // Dark Amber
                else if (isFailed) android.graphics.Color.parseColor("#991B1B") // Dark Red
                else android.graphics.Color.parseColor("#15803D") // Dark Green
            )
            setPadding(16, 12, 16, 12)
        }
        val tvStatus = TextView(ctx).apply {
            text = if (isPending) "⏳ MENUNGGU KONFIRMASI OPERATOR" else if (isFailed) "❌ TRANSAKSI GAGAL" else "✅ TRANSAKSI BERHASIL"
            setTextColor(android.graphics.Color.WHITE)
            textSize = 14.5f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
        }
        statusCard.addView(tvStatus)
        layout.addView(statusCard)

        // 2. High-Contrast Details Card
        val detailsCard = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(android.graphics.Color.parseColor("#1E293B"))
            setPadding(20, 16, 20, 16)
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply {
                setMargins(0, 12, 0, 14)
            }
        }

        fun addRow(label: String, value: String, valueColor: Int = android.graphics.Color.WHITE, isBold: Boolean = false, textSizeSp: Float = 13.5f) {
            val row = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                setPadding(0, 4, 0, 4)
            }
            val tvLabel = TextView(ctx).apply {
                text = label
                setTextColor(android.graphics.Color.parseColor("#94A3B8")) // Slate 400
                textSize = 13f
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1.2f)
            }
            val tvVal = TextView(ctx).apply {
                text = value
                setTextColor(valueColor)
                textSize = textSizeSp
                if (isBold) typeface = android.graphics.Typeface.DEFAULT_BOLD
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 2f)
                gravity = android.view.Gravity.END
            }
            row.addView(tvLabel)
            row.addView(tvVal)
            detailsCard.addView(row)
        }

        addRow("Produk", prod.name, android.graphics.Color.WHITE, true, 14f)
        addRow("Nomor Tujuan", target, android.graphics.Color.parseColor("#38BDF8"), true, 15f)
        addRow("Total Bayar", formatRupiah(prod.priceSell), android.graphics.Color.parseColor("#4ADE80"), true, 16f)
        addRow("Ref ID", refId, android.graphics.Color.parseColor("#E2E8F0"))
        
        if (sn.isNotEmpty() && sn != "-") {
            val snBox = LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
                setBackgroundColor(android.graphics.Color.parseColor("#0F172A"))
                setPadding(12, 8, 12, 8)
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                ).apply {
                    setMargins(0, 8, 0, 4)
                }
            }
            val tvSnLabel = TextView(ctx).apply {
                text = "Nomor Seri / Token PLN:"
                setTextColor(android.graphics.Color.parseColor("#94A3B8"))
                textSize = 11f
            }
            val tvSnVal = TextView(ctx).apply {
                text = sn
                setTextColor(android.graphics.Color.parseColor("#FACC15")) // Bright Yellow Gold
                textSize = 16f
                typeface = android.graphics.Typeface.DEFAULT_BOLD
                letterSpacing = 0.04f
            }
            snBox.addView(tvSnLabel)
            snBox.addView(tvSnVal)
            detailsCard.addView(snBox)
        }

        val statColor = if (isPending) android.graphics.Color.parseColor("#FACC15")
                        else if (isFailed) android.graphics.Color.parseColor("#F87171")
                        else android.graphics.Color.parseColor("#4ADE80")
        addRow("Status Operator", status.uppercase(), statColor, true)
        addRow("Keterangan", msg, android.graphics.Color.parseColor("#CBD5E1"))

        layout.addView(detailsCard)

        var dialog: AlertDialog? = null

        if (isPending) {
            val btnCheckStatus = Button(ctx).apply {
                text = "🔄 Cek Status Terkini ke Digiflazz"
                setTextColor(android.graphics.Color.WHITE)
                textSize = 13f
                typeface = android.graphics.Typeface.DEFAULT_BOLD
                backgroundTintList = android.content.res.ColorStateList.valueOf(android.graphics.Color.parseColor("#D97706")) // Amber 600
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                ).apply {
                    setMargins(0, 0, 0, 10)
                }
                setOnClickListener {
                    checkOrderPulsaStatusLive(prod, target, refId, buyerPhone, dialog)
                }
            }
            layout.addView(btnCheckStatus)
        }

        if (buyerPhone.isNotEmpty()) {
            val btnWa = Button(ctx, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                text = "💬 Kirim Struk WhatsApp ($buyerPhone)"
                setOnClickListener {
                    openWhatsAppReceipt(buyerPhone, prod.name, target, prod.priceSell, refId, sn)
                }
            }
            layout.addView(btnWa)
        }

        dialog = AlertDialog.Builder(ctx)
            .setTitle("📱 Detail & Struk Transaksi")
            .setView(layout)
            .setPositiveButton("🖨️ Cetak Struk Bluetooth") { _, _ ->
                printPulsaBluetooth(prod.name, target, prod.priceSell, refId, sn)
            }
            .setNegativeButton("Tutup", null)
            .show()
    }

    private fun checkOrderPulsaStatusLive(prod: PulsaProduct, target: String, refId: String, buyerPhone: String, dialog: AlertDialog?) {
        val ctx = context ?: return
        val progress = android.app.ProgressDialog(ctx).apply {
            setMessage("Mengecek status terkini ke server Digiflazz...")
            setCancelable(false)
            show()
        }

        lifecycleScope.launch {
            val url = "${getBaseUrl()}/api/customer/agent/pulsa/check-status"
            val bodyJson = JSONObject().apply { put("ref_id", refId) }.toString()
            val respStr = withContext(Dispatchers.IO) {
                try {
                    val reqBody = bodyJson.toRequestBody("application/json".toMediaType())
                    val req = Request.Builder().url(url)
                        .addHeader("Authorization", "Bearer ${getToken()}")
                        .post(reqBody).build()
                    val resp = httpClient().newCall(req).execute()
                    resp.body?.string()
                } catch (_: Exception) { null }
            }

            progress.dismiss()

            if (respStr != null) {
                try {
                    val json = JSONObject(respStr)
                    val data = json.optJSONObject("data")
                    val newStatus = data?.optString("status", "pending") ?: "pending"
                    val newSn = data?.optString("sn", "") ?: ""
                    val newMsg = data?.optString("message", "") ?: ""

                    dialog?.dismiss()

                    if (newStatus.equals("success", true)) {
                        Toast.makeText(ctx, "✅ Transaksi SUKSES! SN: $newSn", Toast.LENGTH_LONG).show()
                    } else if (newStatus.equals("failed", true)) {
                        Toast.makeText(ctx, "❌ Transaksi GAGAL dari provider!", Toast.LENGTH_LONG).show()
                    } else {
                        Toast.makeText(ctx, "⏳ Transaksi masih dalam proses provider.", Toast.LENGTH_SHORT).show()
                    }

                    showReceiptDialog(prod, target, refId, newSn, newStatus, newMsg, buyerPhone)
                } catch (e: Exception) {
                    Toast.makeText(ctx, "Gagal memproses respon: ${e.message}", Toast.LENGTH_SHORT).show()
                }
            } else {
                Toast.makeText(ctx, "Gagal terhubung ke server untuk cek status", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun printPulsaBluetooth(prodName: String, target: String, price: Long, refId: String, sn: String) {
        val session = CustomerApplication.sessionManager
        val mac = session.getPrinterMac()
        if (mac.isEmpty()) {
            Toast.makeText(context, "Printer bluetooth belum dipilih.", Toast.LENGTH_SHORT).show()
            return
        }

        val lines = listOf(
            BluetoothPrinterHelper.centerText("================================"),
            BluetoothPrinterHelper.centerText(session.getIspName()),
            BluetoothPrinterHelper.centerText("STRUK TRANSAKSI PULSA & PPOB"),
            BluetoothPrinterHelper.centerText("================================"),
            "Produk    : $prodName",
            "Tujuan    : $target",
            "Ref ID    : $refId",
            if (sn.isNotEmpty() && sn != "-") "SN        : $sn" else "",
            "--------------------------------",
            "Total     : ${formatRupiah(price)}",
            "Status    : LUNAS / SUKSES",
            "Waktu     : " + java.text.SimpleDateFormat("dd/MM/yyyy HH:mm", Locale.getDefault()).format(java.util.Date()),
            "================================",
            BluetoothPrinterHelper.centerText("Terima kasih atas transaksi Anda"),
            BluetoothPrinterHelper.centerText("================================"),
            "\n\n"
        ).filter { it.isNotEmpty() }

        BluetoothPrinterHelper.printRawLines(requireContext(), mac, lines)
        Toast.makeText(context, "Mencetak struk pulsa ke printer thermal...", Toast.LENGTH_SHORT).show()
    }

    private fun openWhatsAppReceipt(phone: String, prodName: String, target: String, price: Long, refId: String, sn: String) {
        try {
            var p = phone.replace(Regex("[^0-9]"), "")
            if (p.startsWith("08")) p = "62" + p.substring(1)
            if (!p.startsWith("62")) p = "62" + p

            val msg = "✅ *BUKTI TRANSAKSI PULSA / PPOB*\n\n" +
                      "📦 *Produk:* $prodName\n" +
                      "🎯 *Nomor Tujuan:* $target\n" +
                      "💰 *Total Bayar:* ${formatRupiah(price)}\n" +
                      "🧾 *Ref ID:* $refId\n" +
                      "${if (sn.isNotEmpty() && sn != "-") "🔢 *SN:* $sn\n" else ""}" +
                      "📡 *Status:* SUKSES\n\n" +
                      "Terima kasih telah bertransaksi di Agen Resmi ${CustomerApplication.sessionManager.getIspName()}."

            val intent = Intent(Intent.ACTION_VIEW, Uri.parse("https://wa.me/$p?text=${Uri.encode(msg)}"))
            startActivity(intent)
        } catch (_: Exception) {
            Toast.makeText(context, "Tidak dapat membuka aplikasi WhatsApp", Toast.LENGTH_SHORT).show()
        }
    }

    private fun formatRupiah(amount: Long): String {
        return "Rp " + NumberFormat.getNumberInstance(Locale("id", "ID")).format(amount)
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }

    class PulsaProductAdapter(
        private val list: List<PulsaProduct>,
        private val onBuyClick: (PulsaProduct) -> Unit
    ) : RecyclerView.Adapter<PulsaProductAdapter.VH>() {

        inner class VH(val b: ItemAgentPulsaBinding) : RecyclerView.ViewHolder(b.root)

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
            val b = ItemAgentPulsaBinding.inflate(LayoutInflater.from(parent.context), parent, false)
            return VH(b)
        }

        override fun onBindViewHolder(holder: VH, position: Int) {
            val item = list[position]
            holder.b.tvProductName.text = item.name
            holder.b.tvProductCategory.text = "${item.category} • ${item.brand} (SKU: ${item.sku})"
            holder.b.tvProductPrice.text = "Rp " + NumberFormat.getNumberInstance(Locale("id", "ID")).format(item.priceSell)

            holder.b.btnBuyPulsa.setOnClickListener {
                onBuyClick(item)
            }
        }

        override fun getItemCount() = list.size
    }
}