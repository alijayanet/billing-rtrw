package com.alijaya.customer.ui.agent

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
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
import com.alijaya.customer.CustomerApplication
import com.alijaya.customer.R
import com.alijaya.customer.databinding.FragmentAgentHomeBinding
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

class AgentHomeFragment : Fragment() {
    private var _binding: FragmentAgentHomeBinding? = null
    private val binding get() = _binding!!

    private var agentBalance: Long = 0
    private var agentName: String = "Agen Resmi"
    private var availablePrices = mutableListOf<JSONObject>()

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
        _binding = FragmentAgentHomeBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        binding.swipeRefresh.setOnRefreshListener {
            fetchAgentDashboard()
        }

        binding.btnTopupSaldo.setOnClickListener {
            showTopupDialog()
        }

        binding.btnTestPrint.setOnClickListener {
            testPrintBluetooth()
        }

        binding.btnGotoPulsa.setOnClickListener {
            parentFragmentManager.beginTransaction()
                .replace(R.id.fragment_container, AgentPulsaFragment())
                .addToBackStack(null)
                .commit()
        }

        binding.btnGotoBilling.setOnClickListener {
            parentFragmentManager.beginTransaction()
                .replace(R.id.fragment_container, AgentBillingFragment())
                .addToBackStack(null)
                .commit()
        }

        updatePrinterBadge()
        fetchAgentDashboard()
    }

    private fun updatePrinterBadge() {
        val session = CustomerApplication.sessionManager
        if (session.getPrinterMac().isNotEmpty()) {
            binding.tvPrinterBadge.text = "${session.getPrinterName()} (${if (session.isPrinter80mm()) "80mm" else "58mm"})"
            binding.tvPrinterBadge.setTextColor(ContextCompat.getColor(requireContext(), R.color.success))
        } else {
            binding.tvPrinterBadge.text = "Belum Terkoneksi"
            binding.tvPrinterBadge.setTextColor(ContextCompat.getColor(requireContext(), R.color.text_muted))
        }
    }

    private fun fetchAgentDashboard() {
        binding.swipeRefresh.isRefreshing = true
        lifecycleScope.launch {
            val url = "${getBaseUrl()}/api/customer/agent/dashboard"
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
                    if (data != null) {
                        val agentObj = data.optJSONObject("agent")
                        if (agentObj != null) {
                            agentName = agentObj.optString("name", "Agen Resmi")
                            agentBalance = agentObj.optLong("balance", 0)
                            binding.tvAgentName.text = "Agen: $agentName"
                            binding.tvAgentBalance.text = formatRupiah(agentBalance)
                        }

                        availablePrices.clear()
                        val pricesArr = data.optJSONArray("prices") ?: JSONArray()
                        for (i in 0 until pricesArr.length()) {
                            availablePrices.add(pricesArr.getJSONObject(i))
                        }

                        renderVoucherCards()
                    }
                } catch (_: Exception) {
                    binding.tvEmptyVouchers.visibility = View.VISIBLE
                    binding.tvEmptyVouchers.text = "Gagal memproses data paket voucher"
                }
            } else {
                binding.tvEmptyVouchers.visibility = View.VISIBLE
                binding.tvEmptyVouchers.text = "Gagal terhubung ke server"
            }
        }
    }

    private fun renderVoucherCards() {
        val ctx = context ?: return
        val container = binding.containerVouchers
        container.removeAllViews()

        if (availablePrices.isEmpty()) {
            binding.tvEmptyVouchers.visibility = View.VISIBLE
            binding.tvEmptyVouchers.text = "Belum ada paket voucher hotspot yang aktif"
            binding.tvVoucherCount.text = "0 Paket"
            return
        }

        binding.tvEmptyVouchers.visibility = View.GONE
        binding.tvVoucherCount.text = "${availablePrices.size} Paket Tersedia"

        val inflater = LayoutInflater.from(ctx)
        for (priceObj in availablePrices) {
            val view = inflater.inflate(R.layout.item_agent_voucher, container, false)
            val pId = priceObj.optInt("id", 0)
            val profile = priceObj.optString("profile_name", "Paket Hotspot")
            val validity = priceObj.optString("validity", "24 Jam").ifEmpty { "24 Jam" }
            val router = priceObj.optString("router_name", "Default Hotspot").ifEmpty { "Default Hotspot" }
            val sellPrice = priceObj.optLong("sell_price", 5000)
            val buyPrice = priceObj.optLong("buy_price", Math.round(sellPrice * 0.85).toLong())
            val profit = Math.max(0, sellPrice - buyPrice)

            view.findViewById<TextView>(R.id.tv_voucher_profile).text = profile
            view.findViewById<TextView>(R.id.tv_voucher_router).text = "📡 $router"
            view.findViewById<TextView>(R.id.tv_voucher_sell_price).text = formatRupiah(sellPrice)
            view.findViewById<TextView>(R.id.tv_voucher_buy_price).text = "Potong Saldo: ${formatRupiah(buyPrice)}"
            view.findViewById<TextView>(R.id.tv_voucher_validity).text = "⏱️ $validity"
            view.findViewById<TextView>(R.id.tv_voucher_profit).text = "💰 Profit ${formatRupiah(profit)}"

            view.findViewById<Button>(R.id.btn_sell_voucher).setOnClickListener {
                showSellVoucherDialog(pId, profile, validity, sellPrice, buyPrice)
            }

            container.addView(view)
        }
    }

    private fun showSellVoucherDialog(priceId: Int, profile: String, validity: String, sellPrice: Long, buyPrice: Long) {
        val ctx = context ?: return

        if (agentBalance < buyPrice) {
            AlertDialog.Builder(ctx)
                .setTitle("⚠️ Saldo Tidak Cukup")
                .setMessage("Saldo agen Anda (${formatRupiah(agentBalance)}) tidak mencukupi untuk membuat voucher ini (${formatRupiah(buyPrice)}).\n\nSilakan lakukan Top Up saldo terlebih dahulu.")
                .setPositiveButton("Top Up Sekarang") { _, _ -> showTopupDialog() }
                .setNegativeButton("Tutup", null)
                .show()
            return
        }

        val layout = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(36, 16, 36, 10)
        }

        val detailsCard = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(android.graphics.Color.parseColor("#1E293B"))
            setPadding(20, 16, 20, 16)
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply {
                setMargins(0, 4, 0, 10)
            }
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
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1.2f)
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
            detailsCard.addView(row)
        }

        addRow("Paket Hotspot", profile, android.graphics.Color.WHITE, true, 14f)
        addRow("Masa Aktif", validity, android.graphics.Color.parseColor("#38BDF8"), true)
        addRow("Harga Jual", formatRupiah(sellPrice), android.graphics.Color.parseColor("#4ADE80"), true, 15f)
        addRow("Potong Saldo", formatRupiah(buyPrice), android.graphics.Color.parseColor("#F87171"), true, 14f)

        layout.addView(detailsCard)

        val tvWaHint = TextView(ctx).apply {
            text = "Kirim struk ke WhatsApp pembeli (opsional):"
            setTextColor(android.graphics.Color.parseColor("#94A3B8"))
            textSize = 12f
            setPadding(0, 6, 0, 6)
        }
        layout.addView(tvWaHint)

        val etBuyerPhone = EditText(ctx).apply {
            hint = "No. WhatsApp (misal: 0812...)"
            setHintTextColor(android.graphics.Color.parseColor("#64748B"))
            inputType = android.text.InputType.TYPE_CLASS_PHONE
            setTextColor(android.graphics.Color.WHITE)
            textSize = 14f
            background = ContextCompat.getDrawable(ctx, R.drawable.bg_input_field)
            setPadding(24, 18, 24, 18)
        }
        layout.addView(etBuyerPhone)

        val sellDialog = AlertDialog.Builder(ctx)
            .setTitle("🎫 Konfirmasi Jual Voucher")
            .setView(layout)
            .setPositiveButton("Buat & Cetak") { _, _ ->
                val buyerPhone = etBuyerPhone.text.toString().trim()
                executeGenerateVoucher(priceId, profile, sellPrice, validity, buyerPhone)
            }
            .setNegativeButton("Batal", null)
            .create()

        sellDialog.setOnShowListener {
            sellDialog.window?.setBackgroundDrawable(android.graphics.drawable.GradientDrawable().apply {
                shape = android.graphics.drawable.GradientDrawable.RECTANGLE
                cornerRadius = 28f
                setColor(android.graphics.Color.parseColor("#1E293B"))
                setStroke(2, android.graphics.Color.parseColor("#334155"))
            })
            sellDialog.getButton(AlertDialog.BUTTON_POSITIVE)?.setTextColor(android.graphics.Color.parseColor("#38BDF8"))
            sellDialog.getButton(AlertDialog.BUTTON_NEGATIVE)?.setTextColor(android.graphics.Color.parseColor("#94A3B8"))
        }
        sellDialog.show()
    }

    private fun executeGenerateVoucher(priceId: Int, profile: String, sellPrice: Long, validity: String, buyerPhone: String) {
        val ctx = context ?: return
        val progress = android.app.ProgressDialog(ctx).apply {
            setMessage("Membuat voucher hotspot dari server MikroTik...")
            setCancelable(false)
            show()
        }

        lifecycleScope.launch {
            val url = "${getBaseUrl()}/api/customer/agent/buy-voucher"
            val bodyJson = JSONObject().apply {
                put("price_id", priceId)
                put("profile", profile)
                put("price", sellPrice)
                put("validity", validity)
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
                    if (json.optBoolean("success")) {
                        val data = json.optJSONObject("data")
                        val code = data?.optString("voucherCode", "") ?: ""
                        val pass = data?.optString("voucherPass", code) ?: code
                        val prof = data?.optString("profile", profile) ?: profile
                        val valStr = data?.optString("validity", validity) ?: validity
                        val priceFmt = data?.optString("priceFormatted", formatRupiah(sellPrice)) ?: formatRupiah(sellPrice)
                        val newBal = data?.optLong("newBalance", agentBalance - Math.round(sellPrice * 0.85)) ?: (agentBalance - Math.round(sellPrice * 0.85))

                        agentBalance = newBal
                        binding.tvAgentBalance.text = formatRupiah(agentBalance)

                        showVoucherReceiptDialog(code, pass, prof, valStr, priceFmt, buyerPhone)
                    } else {
                        val err = json.optString("message", "Gagal membuat voucher")
                        Toast.makeText(ctx, "⚠️ $err", Toast.LENGTH_LONG).show()
                    }
                } catch (e: Exception) {
                    Toast.makeText(ctx, "Gagal memproses respon voucher: ${e.message}", Toast.LENGTH_SHORT).show()
                }
            } else {
                Toast.makeText(ctx, "Gagal terhubung ke server", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun showVoucherReceiptDialog(code: String, pass: String, profile: String, validity: String, priceFormatted: String, buyerPhone: String) {
        val ctx = context ?: return

        val scroll = android.widget.ScrollView(ctx).apply {
            isFillViewport = true
        }

        val layout = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(36, 16, 36, 10)
        }
        scroll.addView(layout)

        // 1. Status Banner Header
        val headerCard = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = android.view.Gravity.CENTER
            setBackgroundColor(android.graphics.Color.parseColor("#15803D"))
            setPadding(16, 12, 16, 12)
        }
        val tvStatus = TextView(ctx).apply {
            text = "✅ VOUCHER BERHASIL DIBUAT"
            setTextColor(android.graphics.Color.WHITE)
            textSize = 14.5f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
        }
        headerCard.addView(tvStatus)
        layout.addView(headerCard)

        // 2. High-Contrast Details Card
        val detailsCard = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(android.graphics.Color.parseColor("#1E293B"))
            setPadding(20, 16, 20, 16)
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply {
                setMargins(0, 8, 0, 10)
            }
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
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1.2f)
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
            detailsCard.addView(row)
        }

        addRow("Paket Layanan", profile, android.graphics.Color.WHITE, true, 14f)
        addRow("Masa Aktif", validity, android.graphics.Color.parseColor("#38BDF8"), true)
        addRow("Username", code, android.graphics.Color.parseColor("#38BDF8"), true, 16f)
        addRow("Password", pass, android.graphics.Color.parseColor("#FBBF24"), true, 16f)
        addRow("Total Bayar", priceFormatted, android.graphics.Color.parseColor("#4ADE80"), true, 16f)

        layout.addView(detailsCard)

        val btnCopy = Button(ctx, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
            text = "📋 Salin Username & Password"
            setOnClickListener {
                val clip = ClipData.newPlainText("Voucher", "User: $code\nPass: $pass\nPaket: $profile ($validity)")
                val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                cm.setPrimaryClip(clip)
                Toast.makeText(ctx, "Voucher berhasil disalin ke clipboard!", Toast.LENGTH_SHORT).show()
            }
        }
        layout.addView(btnCopy)

        if (buyerPhone.isNotEmpty()) {
            val btnWa = Button(ctx, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                text = "💬 Kirim via WhatsApp ($buyerPhone)"
                setOnClickListener {
                    openWhatsAppVoucher(buyerPhone, code, pass, profile, validity, priceFormatted)
                }
            }
            layout.addView(btnWa)
        }

        AlertDialog.Builder(ctx)
            .setTitle("🎫 Struk Voucher Hotspot")
            .setView(scroll)
            .setPositiveButton("🖨️ Cetak Struk Bluetooth") { _, _ ->
                printVoucherBluetooth(code, pass, profile, validity, priceFormatted)
            }
            .setNegativeButton("Selesai", null)
            .show()
    }

    private fun printVoucherBluetooth(code: String, pass: String, profile: String, validity: String, price: String) {
        val session = CustomerApplication.sessionManager
        val mac = session.getPrinterMac()
        if (mac.isEmpty()) {
            Toast.makeText(context, "Printer bluetooth belum dipilih. Silakan atur printer di menu Riwayat & Profil.", Toast.LENGTH_LONG).show()
            return
        }

        val lines = listOf(
            BluetoothPrinterHelper.centerText("================================"),
            BluetoothPrinterHelper.centerText(session.getIspName()),
            BluetoothPrinterHelper.centerText("HOTSPOT VOUCHER RESMI"),
            BluetoothPrinterHelper.centerText("================================"),
            "Paket     : $profile",
            "Masa Aktif: $validity",
            "--------------------------------",
            "USERNAME  : $code",
            "PASSWORD  : $pass",
            "--------------------------------",
            "Harga     : $price",
            "Agen      : $agentName",
            "Tgl Cetak : " + java.text.SimpleDateFormat("dd/MM/yyyy HH:mm", Locale.getDefault()).format(java.util.Date()),
            "================================",
            BluetoothPrinterHelper.centerText("Terima kasih & Selamat Internetan!"),
            BluetoothPrinterHelper.centerText("================================"),
            "\n\n"
        )

        BluetoothPrinterHelper.printRawLines(requireContext(), mac, lines)
        Toast.makeText(context, "Mencetak struk voucher ke printer thermal...", Toast.LENGTH_SHORT).show()
    }

    private fun openWhatsAppVoucher(phone: String, code: String, pass: String, profile: String, validity: String, price: String) {
        try {
            var p = phone.replace(Regex("[^0-9]"), "")
            if (p.startsWith("08")) p = "62" + p.substring(1)
            if (!p.startsWith("62")) p = "62" + p

            val msg = "🎫 *VOUCHER HOTSPOT INTERNET*\n\n" +
                      "📦 *Paket:* $profile\n" +
                      "⏱️ *Masa Aktif:* $validity\n" +
                      "👤 *Username:* `$code`\n" +
                      "🔑 *Password:* `$pass`\n" +
                      "💰 *Harga:* $price\n\n" +
                      "Simpan voucher ini untuk login di WiFi. Terima kasih telah membeli di Agen $agentName."

            val intent = Intent(Intent.ACTION_VIEW, Uri.parse("https://wa.me/$p?text=${Uri.encode(msg)}"))
            startActivity(intent)
        } catch (_: Exception) {
            Toast.makeText(context, "Tidak dapat membuka aplikasi WhatsApp", Toast.LENGTH_SHORT).show()
        }
    }

    private fun showTopupDialog() {
        val ctx = context ?: return
        val layout = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(36, 20, 36, 10)
        }

        val cardInfo = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(android.graphics.Color.parseColor("#1E293B"))
            setPadding(20, 14, 20, 14)
        }

        val tvCurrentBal = TextView(ctx).apply {
            text = "Saldo Agen Saat Ini: ${formatRupiah(agentBalance)}"
            setTextColor(android.graphics.Color.parseColor("#4ADE80"))
            textSize = 14f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
        }
        val tvMin = TextView(ctx).apply {
            text = "Minimal deposit: Rp 10.000 (Otomatis QRIS / Payment Gateway)"
            setTextColor(android.graphics.Color.parseColor("#94A3B8"))
            textSize = 11.5f
            setPadding(0, 4, 0, 0)
        }
        cardInfo.addView(tvCurrentBal)
        cardInfo.addView(tvMin)
        layout.addView(cardInfo)

        val tvLabelInput = TextView(ctx).apply {
            text = "Masukkan Nominal Deposit:"
            setTextColor(android.graphics.Color.parseColor("#334155"))
            textSize = 13f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            setPadding(0, 14, 0, 6)
        }
        layout.addView(tvLabelInput)

        val etAmount = EditText(ctx).apply {
            hint = "Contoh: 50000"
            setHintTextColor(android.graphics.Color.parseColor("#94A3B8"))
            inputType = android.text.InputType.TYPE_CLASS_NUMBER
            setTextColor(android.graphics.Color.WHITE)
            textSize = 17f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            background = ContextCompat.getDrawable(ctx, R.drawable.bg_input_field)
            setPadding(24, 18, 24, 18)
        }
        layout.addView(etAmount)

        // Quick amount buttons
        val quickLayout = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, 10, 0, 8)
        }
        val amounts = listOf(50000L, 100000L, 200000L, 500000L)
        for (a in amounts) {
            val btnQ = Button(ctx, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply {
                    setMargins(3, 0, 3, 0)
                }
                text = "${a / 1000}rb"
                textSize = 11f
                setOnClickListener {
                    etAmount.setText(a.toString())
                }
            }
            quickLayout.addView(btnQ)
        }
        layout.addView(quickLayout)

        AlertDialog.Builder(ctx)
            .setTitle("💰 Isi Deposit Saldo Agen")
            .setView(layout)
            .setPositiveButton("Lanjutkan Pembayaran") { _, _ ->
                val amt = etAmount.text.toString().toLongOrNull() ?: 0
                if (amt < 10000) {
                    Toast.makeText(ctx, "Minimal deposit adalah Rp 10.000", Toast.LENGTH_SHORT).show()
                } else {
                    executeCreateTopup(amt)
                }
            }
            .setNegativeButton("Batal", null)
            .show()
    }

    private fun executeCreateTopup(amount: Long) {
        val ctx = context ?: return
        val progress = android.app.ProgressDialog(ctx).apply {
            setMessage("Menghubungkan ke Payment Gateway...")
            setCancelable(false)
            show()
        }

        lifecycleScope.launch {
            val url = "${getBaseUrl()}/api/customer/agent/topup/create"
            val bodyJson = JSONObject().apply {
                put("amount", amount)
                put("method", "QRIS")
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
                    if (json.optBoolean("success")) {
                        val data = json.optJSONObject("data")
                        val reqId = data?.optInt("reqId", 0) ?: 0
                        val orderId = data?.optString("orderId", "AGTOP$reqId") ?: "AGTOP$reqId"
                        val totalAmt = data?.optLong("totalAmount", amount) ?: amount
                        val uniqueCode = data?.optInt("uniqueCode", 0) ?: 0
                        val gateway = data?.optString("paymentGateway", "Gateway") ?: "Gateway"
                        val payLink = data?.optString("paymentLink", "") ?: ""
                        val qrBase64 = data?.optString("qrImageBase64", "") ?: ""
                        val vaNum = data?.optString("vaNumber", "") ?: ""
                        val bankName = data?.optString("bankName", "Bank Transfer") ?: "Bank Transfer"
                        val bankAccount = data?.optString("bankAccount", "") ?: ""
                        val bankHolder = data?.optString("bankHolder", "") ?: ""

                        showTopupPaymentSheet(reqId, orderId, amount, totalAmt, uniqueCode, gateway, payLink, qrBase64, vaNum, bankName, bankAccount, bankHolder)
                    } else {
                        val msg = json.optString("message", "Gagal membuat request topup")
                        Toast.makeText(ctx, "⚠️ $msg", Toast.LENGTH_LONG).show()
                    }
                } catch (e: Exception) {
                    Toast.makeText(ctx, "Error: ${e.message}", Toast.LENGTH_SHORT).show()
                }
            } else {
                Toast.makeText(ctx, "Gagal terhubung ke server payment gateway", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun showTopupPaymentSheet(
        reqId: Int,
        orderId: String,
        amount: Long,
        totalAmount: Long,
        uniqueCode: Int,
        gateway: String,
        paymentLink: String,
        qrImageBase64: String,
        vaNumber: String,
        bankName: String,
        bankAccount: String,
        bankHolder: String
    ) {
        val ctx = context ?: return
        val scroll = android.widget.ScrollView(ctx).apply {
            isFillViewport = true
        }

        val layout = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(36, 16, 36, 12)
        }
        scroll.addView(layout)

        // 1. QRIS Barcode Box
        if (qrImageBase64.isNotEmpty()) {
            try {
                val cleanBase64 = if (qrImageBase64.contains(",")) qrImageBase64.substringAfter(",") else qrImageBase64
                val decodedBytes = android.util.Base64.decode(cleanBase64, android.util.Base64.DEFAULT)
                val bitmap = android.graphics.BitmapFactory.decodeByteArray(decodedBytes, 0, decodedBytes.size)
                if (bitmap != null) {
                    val qrCard = LinearLayout(ctx).apply {
                        orientation = LinearLayout.VERTICAL
                        gravity = android.view.Gravity.CENTER
                        setBackgroundColor(android.graphics.Color.WHITE)
                        setPadding(16, 16, 16, 16)
                        layoutParams = LinearLayout.LayoutParams(
                            LinearLayout.LayoutParams.WRAP_CONTENT,
                            LinearLayout.LayoutParams.WRAP_CONTENT
                        ).apply {
                            gravity = android.view.Gravity.CENTER_HORIZONTAL
                            setMargins(0, 4, 0, 10)
                        }
                    }

                    val ivQris = android.widget.ImageView(ctx).apply {
                        layoutParams = LinearLayout.LayoutParams(
                            (230 * resources.displayMetrics.density).toInt(),
                            (230 * resources.displayMetrics.density).toInt()
                        )
                        setImageBitmap(bitmap)
                        scaleType = android.widget.ImageView.ScaleType.FIT_CENTER
                    }
                    qrCard.addView(ivQris)
                    layout.addView(qrCard)

                    val tvScanGuide = TextView(ctx).apply {
                        text = "📲 Pindai QRIS di atas dengan m-Banking (BCA, Livin, BRImo, dll) atau E-Wallet (GoPay, OVO, DANA, ShopeePay)."
                        setTextColor(android.graphics.Color.parseColor("#94A3B8"))
                        textSize = 12f
                        gravity = android.view.Gravity.CENTER
                        setPadding(10, 0, 10, 10)
                    }
                    layout.addView(tvScanGuide)
                }
            } catch (_: Exception) {}
        }

        // 2. High-Contrast Breakdown Card
        val detailsCard = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(android.graphics.Color.parseColor("#1E293B"))
            setPadding(20, 14, 20, 14)
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply {
                setMargins(0, 4, 0, 10)
            }
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
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1.2f)
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
            detailsCard.addView(row)
        }

        addRow("Nominal Deposit", formatRupiah(amount), android.graphics.Color.WHITE, true, 14f)
        if (uniqueCode > 0) {
            addRow("Kode Unik", "+Rp $uniqueCode", android.graphics.Color.parseColor("#38BDF8"), true, 14f)
        }

        val div = View(ctx).apply {
            setBackgroundColor(android.graphics.Color.parseColor("#334155"))
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                (1 * resources.displayMetrics.density).toInt()
            ).apply {
                setMargins(0, 8, 0, 8)
            }
        }
        detailsCard.addView(div)

        addRow("TOTAL BAYAR", formatRupiah(totalAmount), android.graphics.Color.parseColor("#4ADE80"), true, 17f)

        layout.addView(detailsCard)

        // 3. Virtual Account / Bank Transfer Card
        if (vaNumber.isNotEmpty()) {
            val vaCard = LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
                setBackgroundColor(android.graphics.Color.parseColor("#0F172A"))
                setPadding(16, 12, 16, 12)
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                ).apply {
                    setMargins(0, 0, 0, 10)
                }
            }
            val tvVaLabel = TextView(ctx).apply {
                text = "Nomor Virtual Account:"
                setTextColor(android.graphics.Color.parseColor("#94A3B8"))
                textSize = 11.5f
            }
            val tvVaVal = TextView(ctx).apply {
                text = vaNumber
                setTextColor(android.graphics.Color.WHITE)
                textSize = 16f
                typeface = android.graphics.Typeface.DEFAULT_BOLD
                letterSpacing = 0.05f
                setPadding(0, 2, 0, 8)
            }
            val btnCopyVA = Button(ctx, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                text = "📋 Salin Nomor VA"
                setOnClickListener {
                    val clip = ClipData.newPlainText("VA", vaNumber)
                    val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    cm.setPrimaryClip(clip)
                    Toast.makeText(ctx, "Nomor VA berhasil disalin!", Toast.LENGTH_SHORT).show()
                }
            }
            vaCard.addView(tvVaLabel)
            vaCard.addView(tvVaVal)
            vaCard.addView(btnCopyVA)
            layout.addView(vaCard)
        } else if (bankAccount.isNotEmpty()) {
            val bankCard = LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
                setBackgroundColor(android.graphics.Color.parseColor("#0F172A"))
                setPadding(16, 12, 16, 12)
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                ).apply {
                    setMargins(0, 0, 0, 10)
                }
            }
            val tvBankLabel = TextView(ctx).apply {
                text = "Transfer Bank $bankName (a.n. $bankHolder):"
                setTextColor(android.graphics.Color.parseColor("#94A3B8"))
                textSize = 11.5f
            }
            val tvBankVal = TextView(ctx).apply {
                text = bankAccount
                setTextColor(android.graphics.Color.WHITE)
                textSize = 16f
                typeface = android.graphics.Typeface.DEFAULT_BOLD
                letterSpacing = 0.05f
                setPadding(0, 2, 0, 8)
            }
            val btnCopyBank = Button(ctx, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                text = "📋 Salin No. Rekening"
                setOnClickListener {
                    val clip = ClipData.newPlainText("Bank", bankAccount)
                    val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    cm.setPrimaryClip(clip)
                    Toast.makeText(ctx, "Nomor rekening berhasil disalin!", Toast.LENGTH_SHORT).show()
                }
            }
            bankCard.addView(tvBankLabel)
            bankCard.addView(tvBankVal)
            bankCard.addView(btnCopyBank)
            layout.addView(bankCard)
        }

        if (paymentLink.isNotEmpty()) {
            val btnPayNow = Button(ctx, null, com.google.android.material.R.attr.materialButtonStyle).apply {
                text = "📲 Buka Link Pembayaran Gateway"
                setBackgroundColor(ContextCompat.getColor(ctx, R.color.primary))
                setTextColor(android.graphics.Color.WHITE)
                setOnClickListener {
                    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(paymentLink))
                    startActivity(intent)
                }
            }
            layout.addView(btnPayNow)
        }

        val tvStatusPolling = TextView(ctx).apply {
            text = "⏳ Menunggu pembayaran... Saldo bertambah otomatis!"
            setTextColor(android.graphics.Color.parseColor("#38BDF8"))
            textSize = 12f
            gravity = android.view.Gravity.CENTER
            setPadding(0, 8, 0, 4)
        }
        layout.addView(tvStatusPolling)

        AlertDialog.Builder(ctx)
            .setTitle("💰 Instruksi Pembayaran Deposit")
            .setView(scroll)
            .setPositiveButton("🔄 Cek Status Pembayaran") { _, _ ->
                checkTopupStatus(reqId)
            }
            .setNegativeButton("Tutup", null)
            .show()
    }

    private fun checkTopupStatus(reqId: Int) {
        val ctx = context ?: return
        val progress = android.app.ProgressDialog(ctx).apply {
            setMessage("Mengecek status pembayaran ke sistem...")
            setCancelable(false)
            show()
        }

        lifecycleScope.launch {
            val url = "${getBaseUrl()}/api/customer/agent/topup/status/$reqId"
            val respStr = withContext(Dispatchers.IO) {
                try {
                    val req = Request.Builder().url(url)
                        .addHeader("Authorization", "Bearer ${getToken()}")
                        .build()
                    val resp = httpClient().newCall(req).execute()
                    resp.body?.string()
                } catch (_: Exception) { null }
            }

            progress.dismiss()

            if (respStr != null) {
                try {
                    val json = JSONObject(respStr)
                    val data = json.optJSONObject("data")
                    val status = data?.optString("status", "pending") ?: "pending"
                    val curBal = data?.optLong("currentBalance", agentBalance) ?: agentBalance
                    val totalAmt = data?.optLong("totalAmount", 0L) ?: 0L
                    val uniqueCode = data?.optInt("uniqueCode", 0) ?: 0

                    if (status.equals("paid", true)) {
                        agentBalance = curBal
                        binding.tvAgentBalance.text = formatRupiah(agentBalance)
                        val msgBuilder = StringBuilder("Dana pembayaran telah diterima oleh sistem!\n")
                        if (totalAmt > 0) {
                            msgBuilder.append("Saldo Masuk: ${formatRupiah(totalAmt)}")
                            if (uniqueCode > 0) {
                                msgBuilder.append(" (Termasuk Kode Unik +Rp $uniqueCode)")
                            }
                            msgBuilder.append("\n")
                        }
                        msgBuilder.append("\nTotal Saldo Sekarang: ${formatRupiah(agentBalance)}")

                        AlertDialog.Builder(ctx)
                            .setTitle("✅ Pembayaran Berhasil!")
                            .setMessage(msgBuilder.toString())
                            .setPositiveButton("Selesai", null)
                            .show()
                    } else {
                        Toast.makeText(ctx, "⏳ Pembayaran belum terkonfirmasi atau masih dalam proses.", Toast.LENGTH_LONG).show()
                    }
                } catch (e: Exception) {
                    Toast.makeText(ctx, "Error: ${e.message}", Toast.LENGTH_SHORT).show()
                }
            } else {
                Toast.makeText(ctx, "Gagal mengecek status ke server", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun testPrintBluetooth() {
        val session = CustomerApplication.sessionManager
        val mac = session.getPrinterMac()
        if (mac.isEmpty()) {
            Toast.makeText(context, "Printer bluetooth belum dipilih. Silakan atur printer di menu Riwayat & Profil.", Toast.LENGTH_LONG).show()
            return
        }

        val lines = listOf(
            BluetoothPrinterHelper.centerText("================================"),
            BluetoothPrinterHelper.centerText("TES PRINTER THERMAL BLUETOOTH"),
            BluetoothPrinterHelper.centerText(session.getIspName()),
            BluetoothPrinterHelper.centerText("================================"),
            "Agen : $agentName",
            "Tgl  : " + java.text.SimpleDateFormat("dd/MM/yyyy HH:mm:ss", Locale.getDefault()).format(java.util.Date()),
            "--------------------------------",
            "STATUS PRINTER: OK (NORMAL)",
            "================================",
            "\n\n"
        )

        BluetoothPrinterHelper.printRawLines(requireContext(), mac, lines)
        Toast.makeText(context, "Mengirim tes cetak ke printer bluetooth...", Toast.LENGTH_SHORT).show()
    }

    private fun formatRupiah(amount: Long): String {
        return "Rp " + NumberFormat.getNumberInstance(Locale("id", "ID")).format(amount)
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}