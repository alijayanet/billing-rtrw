package com.alijaya.customer.ui.admin

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.cardview.widget.CardView
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.alijaya.customer.CustomerApplication
import com.alijaya.customer.R
import com.alijaya.customer.databinding.FragmentAdminBillingBinding
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

class AdminBillingFragment : Fragment() {
    private var _binding: FragmentAdminBillingBinding? = null
    private val binding get() = _binding!!

    private var allCustomers = mutableListOf<JSONObject>()
    private var paidInvoices = mutableListOf<JSONObject>()
    private var activeFilter = "all" // all, unpaid, isolated, deferred, history

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
        _binding = FragmentAdminBillingBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        binding.swipeRefresh.setOnRefreshListener {
            if (activeFilter == "history") {
                loadPaidInvoices(binding.etSearch.text.toString().trim())
            } else {
                loadCustomers(binding.etSearch.text.toString().trim())
            }
        }

        binding.btnSearch.setOnClickListener {
            if (activeFilter == "history") {
                loadPaidInvoices(binding.etSearch.text.toString().trim())
            } else {
                loadCustomers(binding.etSearch.text.toString().trim())
            }
        }

        updatePrinterBadge()
        setupFilterChips()
        loadCustomers()
    }

    private fun updatePrinterBadge() {
        val session = CustomerApplication.sessionManager
        val printerName = session.getPrinterName()
        if (session.getPrinterMac().isNotEmpty()) {
            binding.tvPrinterStatus.text = printerName.ifEmpty { "Siap" }
            binding.tvPrinterStatus.setTextColor(ContextCompat.getColor(requireContext(), R.color.success))
        } else {
            binding.tvPrinterStatus.text = "Belum Terpilih"
            binding.tvPrinterStatus.setTextColor(ContextCompat.getColor(requireContext(), R.color.text_muted))
        }
    }

    private fun setupFilterChips() {
        binding.chipAll.setOnClickListener {
            activeFilter = "all"
            updateChipStyles()
            renderCustomers()
        }
        binding.chipUnpaid.setOnClickListener {
            activeFilter = "unpaid"
            updateChipStyles()
            renderCustomers()
        }
        binding.chipIsolated.setOnClickListener {
            activeFilter = "isolated"
            updateChipStyles()
            renderCustomers()
        }
        binding.chipDeferred.setOnClickListener {
            activeFilter = "deferred"
            updateChipStyles()
            renderCustomers()
        }
        binding.chipPaidHistory.setOnClickListener {
            activeFilter = "history"
            updateChipStyles()
            loadPaidInvoices(binding.etSearch.text.toString().trim())
        }
    }

    private fun updateChipStyles() {
        binding.chipAll.alpha = if (activeFilter == "all") 1.0f else 0.6f
        binding.chipUnpaid.alpha = if (activeFilter == "unpaid") 1.0f else 0.6f
        binding.chipIsolated.alpha = if (activeFilter == "isolated") 1.0f else 0.6f
        binding.chipDeferred.alpha = if (activeFilter == "deferred") 1.0f else 0.6f
        binding.chipPaidHistory.alpha = if (activeFilter == "history") 1.0f else 0.6f
    }

    private fun loadCustomers(search: String = "") {
        binding.swipeRefresh.isRefreshing = true
        binding.pbLoading.visibility = View.VISIBLE
        binding.tvEmpty.visibility = View.GONE

        lifecycleScope.launch {
            val url = "${getBaseUrl()}/api/customer/app/admin/customers?search=${search}"
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
            binding.pbLoading.visibility = View.GONE

            if (responseStr != null) {
                try {
                    val json = JSONObject(responseStr)
                    val arr = json.optJSONArray("data") ?: JSONArray()
                    allCustomers.clear()
                    for (i in 0 until arr.length()) {
                        allCustomers.add(arr.getJSONObject(i))
                    }
                    renderCustomers()
                    return@launch
                } catch (_: Exception) {}
            }

            binding.tvEmpty.visibility = View.VISIBLE
        }
    }

    private fun loadPaidInvoices(search: String = "") {
        binding.swipeRefresh.isRefreshing = true
        binding.pbLoading.visibility = View.VISIBLE
        binding.tvEmpty.visibility = View.GONE

        lifecycleScope.launch {
            val url = "${getBaseUrl()}/api/customer/app/admin/paid-invoices?search=${search}"
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
            binding.pbLoading.visibility = View.GONE

            if (responseStr != null) {
                try {
                    val json = JSONObject(responseStr)
                    val arr = json.optJSONArray("data") ?: JSONArray()
                    paidInvoices.clear()
                    for (i in 0 until arr.length()) {
                        paidInvoices.add(arr.getJSONObject(i))
                    }
                    renderPaidHistory()
                    return@launch
                } catch (_: Exception) {}
            }

            binding.tvEmpty.visibility = View.VISIBLE
        }
    }

    private fun renderCustomers() {
        val container = binding.layoutCustomerContainer
        container.removeAllViews()
        container.addView(binding.pbLoading)
        container.addView(binding.tvEmpty)

        val filtered = allCustomers.filter { c ->
            val status = c.optString("status", "active").lowercase()
            val unpaidCount = c.optInt("unpaid_count", 0)

            when (activeFilter) {
                "unpaid" -> unpaidCount > 0
                "isolated" -> status == "suspended" || status == "isolated"
                "deferred" -> status == "ditangguhkan" || status == "deferred"
                else -> true
            }
        }

        if (filtered.isEmpty()) {
            binding.tvEmpty.visibility = View.VISIBLE
            return
        }
        binding.tvEmpty.visibility = View.GONE

        val ctx = context ?: return
        val fmt = NumberFormat.getCurrencyInstance(Locale("id", "ID"))

        for (c in filtered) {
            val cId = c.optInt("id")
            val name = c.optString("name", "Pelanggan")
            val phone = c.optString("phone", "-")
            val pppoe = c.optString("pppoe_username", "-")
            val status = c.optString("status", "active").lowercase()
            val pkgName = c.optString("package_name", "Paket Internet")
            val pkgPrice = c.optDouble("package_price", 0.0)
            val balance = c.optDouble("balance", 0.0)
            val unpaidCount = c.optInt("unpaid_count", 0)
            val unpaidInvId = c.optInt("latest_unpaid_invoice_id", 0)
            val unpaidAmt = c.optDouble("latest_unpaid_amount", pkgPrice)
            val unpaidPeriod = c.optString("latest_unpaid_period", "-")

            val card = CardView(ctx).apply {
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                ).apply {
                    setMargins(0, 0, 0, 24)
                }
                radius = 28f
                setCardBackgroundColor(ContextCompat.getColor(ctx, R.color.card_dark))
            }

            val cardContent = LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(36, 32, 36, 32)
            }

            // Top row
            val topRow = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = android.view.Gravity.CENTER_VERTICAL
            }

            val tvName = TextView(ctx).apply {
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                text = name
                setTextColor(ContextCompat.getColor(ctx, R.color.text_white))
                textSize = 15f
                setTypeface(null, android.graphics.Typeface.BOLD)
            }

            val tvBadge = TextView(ctx).apply {
                setPadding(18, 6, 18, 6)
                textSize = 10.5f
                setTypeface(null, android.graphics.Typeface.BOLD)

                when (status) {
                    "suspended", "isolated" -> {
                        text = "\uD83D\uDD34 TERISOLIR"
                        setTextColor(ContextCompat.getColor(ctx, R.color.danger))
                    }
                    "ditangguhkan", "deferred" -> {
                        text = "\uD83D\uDFE1 DITANGGUHKAN"
                        setTextColor(ContextCompat.getColor(ctx, R.color.warning))
                    }
                    else -> {
                        text = "\uD83D\uDFE2 AKTIF"
                        setTextColor(ContextCompat.getColor(ctx, R.color.success))
                    }
                }
            }

            topRow.addView(tvName)
            topRow.addView(tvBadge)
            cardContent.addView(topRow)

            // Info rows
            val tvDetails = TextView(ctx).apply {
                text = "\uD83D\uDC64 PPPoE: $pppoe | \uD83D\uDCF1 WA: $phone\n\uD83D\uDCE6 Paket: $pkgName (${fmt.format(pkgPrice)}) | \uD83D\uDCB0 Saldo: ${fmt.format(balance)}\n" +
                        if (unpaidCount > 0) "\u26A0\uFE0F Tunggakan: $unpaidCount bln (#INV-$unpaidInvId: ${fmt.format(unpaidAmt)})"
                        else "\u2705 Tagihan LUNAS"
                setTextColor(ContextCompat.getColor(ctx, if (unpaidCount > 0) R.color.warning else R.color.text_muted))
                textSize = 11.5f
                setPadding(0, 10, 0, 14)
            }
            cardContent.addView(tvDetails)

            // Action Buttons Row
            val btnRow = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
            }

            // 1. Bayar Button
            if (unpaidCount > 0 && unpaidInvId > 0) {
                val btnPay = Button(ctx, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                    layoutParams = LinearLayout.LayoutParams(0, 84, 1f).apply { marginEnd = 6 }
                    text = "\uD83D\uDCB3 Bayar"
                    textSize = 10.5f
                    setTextColor(ContextCompat.getColor(ctx, R.color.success))
                    setOnClickListener {
                        confirmPayInvoice(unpaidInvId, name, pkgName, unpaidAmt, unpaidPeriod)
                    }
                }
                btnRow.addView(btnPay)
            }

            // 2. Saldo Button
            val btnTopup = Button(ctx, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                layoutParams = LinearLayout.LayoutParams(0, 84, 1f).apply { marginEnd = 6 }
                text = "💰 Saldo"
                textSize = 10.5f
                setTextColor(ContextCompat.getColor(ctx, R.color.accent))
                setOnClickListener {
                    showCustomerTopupDialog(cId, name, balance)
                }
            }
            btnRow.addView(btnTopup)

            // 3. Isolir Button
            if (status != "suspended" && status != "isolated") {
                val btnIsolate = Button(ctx, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                    layoutParams = LinearLayout.LayoutParams(0, 84, 1f).apply { marginEnd = 6 }
                    text = "\uD83D\uDD12 Isolir"
                    textSize = 10.5f
                    setTextColor(ContextCompat.getColor(ctx, R.color.danger))
                    setOnClickListener {
                        confirmIsolateCustomer(cId, name)
                    }
                }
                btnRow.addView(btnIsolate)
            }

            // 4. Buka Isolir (Ditangguhkan) Button
            val btnDefer = Button(ctx, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                layoutParams = LinearLayout.LayoutParams(0, 84, 1.1f)
                text = "\uD83D\uDD13 Tangguhkan"
                textSize = 10.5f
                setTextColor(ContextCompat.getColor(ctx, R.color.warning))
                setOnClickListener {
                    confirmUnisolateAndDefer(cId, name)
                }
            }
            btnRow.addView(btnDefer)

            cardContent.addView(btnRow)
            card.addView(cardContent)
            container.addView(card)
        }
    }

    private fun renderPaidHistory() {
        val container = binding.layoutCustomerContainer
        container.removeAllViews()
        container.addView(binding.pbLoading)
        container.addView(binding.tvEmpty)

        if (paidInvoices.isEmpty()) {
            binding.tvEmpty.text = "Belum ada riwayat tagihan lunas"
            binding.tvEmpty.visibility = View.VISIBLE
            return
        }
        binding.tvEmpty.visibility = View.GONE

        val ctx = context ?: return
        val fmt = NumberFormat.getCurrencyInstance(Locale("id", "ID"))

        for (inv in paidInvoices) {
            val invId = inv.optInt("id")
            val cName = inv.optString("customer_name", "Pelanggan")
            val phone = inv.optString("customer_phone", "-")
            val pkgName = inv.optString("package_name", "Langganan Internet")
            val amount = inv.optDouble("amount", 0.0)
            val period = "${inv.optInt("period_month")}/${inv.optInt("period_year")}"
            val paidAt = inv.optString("paid_at", "Lunas")
            val paidBy = inv.optString("paid_by_name", "Admin")

            val card = CardView(ctx).apply {
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                ).apply {
                    setMargins(0, 0, 0, 20)
                }
                radius = 24f
                setCardBackgroundColor(ContextCompat.getColor(ctx, R.color.card_dark))
            }

            val cardContent = LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(32, 28, 32, 28)
            }

            // Top Row
            val topRow = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = android.view.Gravity.CENTER_VERTICAL
            }

            val tvTitle = TextView(ctx).apply {
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                text = "#INV-$invId • $cName"
                setTextColor(ContextCompat.getColor(ctx, R.color.text_white))
                textSize = 14.5f
                setTypeface(null, android.graphics.Typeface.BOLD)
            }

            val tvBadge = TextView(ctx).apply {
                text = "\u2705 LUNAS"
                setTextColor(ContextCompat.getColor(ctx, R.color.success))
                textSize = 11f
                setTypeface(null, android.graphics.Typeface.BOLD)
            }

            topRow.addView(tvTitle)
            topRow.addView(tvBadge)
            cardContent.addView(topRow)

            // Info
            val tvDetails = TextView(ctx).apply {
                text = "\uD83D\uDCB0 Jumlah: ${fmt.format(amount)} ($period)\n\uD83D\uDCE6 Paket: $pkgName | \uD83D\uDCF1 $phone\n\uD83D\uDCC5 Bayar: $paidAt ($paidBy)"
                setTextColor(ContextCompat.getColor(ctx, R.color.text_muted))
                textSize = 11.5f
                setPadding(0, 8, 0, 12)
            }
            cardContent.addView(tvDetails)

            // Reprint Button
            val btnReprint = Button(ctx, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    80
                )
                text = "\uD83D\uDDA8 Cetak Ulang Struk (Bluetooth)"
                textSize = 11f
                setTextColor(ContextCompat.getColor(ctx, R.color.accent))
                setOnClickListener {
                    printBluetoothReceipt(
                        invoiceNumber = "#INV-$invId",
                        customerName = cName,
                        packageName = pkgName,
                        period = period,
                        amountFormatted = fmt.format(amount),
                        paymentDate = paidAt
                    )
                }
            }
            cardContent.addView(btnReprint)

            card.addView(cardContent)
            container.addView(card)
        }
    }

    private fun confirmPayInvoice(invoiceId: Int, customerName: String, packageName: String, amount: Double, period: String) {
        val ctx = context ?: return
        val fmt = NumberFormat.getCurrencyInstance(Locale("id", "ID")).format(amount)

        AlertDialog.Builder(ctx)
            .setTitle("💰 Validasi Bayar Tagihan")
            .setMessage("Validasi pelunasan tagihan berikut?\n\n• No. Tagihan: #INV-$invoiceId\n• Pelanggan: $customerName\n• Paket: $packageName\n• Periode: $period\n• Total: $fmt\n\nPilih mode pembayaran:")
            .setPositiveButton("🖨️ Bayar & Cetak") { _, _ ->
                processPayInvoice(invoiceId, customerName, packageName, fmt, period, shouldPrint = true)
            }
            .setNeutralButton("⚡ Bayar Saja (Hemat Kertas)") { _, _ ->
                processPayInvoice(invoiceId, customerName, packageName, fmt, period, shouldPrint = false)
            }
            .setNegativeButton("Batal", null)
            .show()
    }

    private fun processPayInvoice(invoiceId: Int, customerName: String, packageName: String, amountFormatted: String, period: String, shouldPrint: Boolean) {
        val ctx = context ?: return
        lifecycleScope.launch {
            Toast.makeText(ctx, "Memproses pembayaran...", Toast.LENGTH_SHORT).show()
            val url = "${getBaseUrl()}/api/customer/app/admin/pay-invoice"

            val bodyJson = JSONObject().apply {
                put("invoiceId", invoiceId)
            }.toString()

            val responseStr = withContext(Dispatchers.IO) {
                try {
                    val reqBody = bodyJson.toRequestBody("application/json".toMediaType())
                    val req = Request.Builder().url(url)
                        .addHeader("Authorization", "Bearer ${getToken()}")
                        .post(reqBody).build()
                    val resp = httpClient().newCall(req).execute()
                    if (resp.isSuccessful) resp.body?.string() else null
                } catch (_: Exception) { null }
            }

            if (responseStr != null) {
                try {
                    val json = JSONObject(responseStr)
                    if (json.optBoolean("success")) {
                        if (shouldPrint) {
                            // Cetak Struk Bluetooth Langsung
                            printBluetoothReceipt(
                                invoiceNumber = "#INV-$invoiceId",
                                customerName = customerName,
                                packageName = packageName,
                                period = period,
                                amountFormatted = amountFormatted,
                                paymentDate = "LUNAS"
                            )

                            AlertDialog.Builder(ctx)
                                .setTitle("✅ Pembayaran Berhasil")
                                .setMessage("Tagihan #INV-$invoiceId ($customerName) telah LUNAS!\n\nStruk dicetak ke printer Bluetooth dan bukti bayar dikirim ke WA pelanggan.")
                                .setPositiveButton("Selesai", null)
                                .setNeutralButton("🖨️ Cetak Lagi") { _, _ ->
                                    printBluetoothReceipt("#INV-$invoiceId", customerName, packageName, period, amountFormatted, "LUNAS")
                                }
                                .show()
                        } else {
                            // Mode Hemat Kertas: Tanpa Cetak Otomatis
                            AlertDialog.Builder(ctx)
                                .setTitle("✅ Pembayaran Berhasil")
                                .setMessage("Tagihan #INV-$invoiceId ($customerName) telah LUNAS!\n\nBukti pembayaran resmi telah dikirim ke WhatsApp pelanggan (Kertas thermal dihemat).")
                                .setPositiveButton("Selesai", null)
                                .setNeutralButton("🖨️ Cetak Struk (Jika Butuh)") { _, _ ->
                                    printBluetoothReceipt("#INV-$invoiceId", customerName, packageName, period, amountFormatted, "LUNAS")
                                }
                                .show()
                        }

                        loadCustomers(binding.etSearch.text.toString().trim())
                        return@launch
                    }
                } catch (_: Exception) {}
            }

            Toast.makeText(ctx, "Gagal memproses pembayaran tagihan", Toast.LENGTH_LONG).show()
        }
    }

    private fun printBluetoothReceipt(
        invoiceNumber: String,
        customerName: String,
        packageName: String,
        period: String,
        amountFormatted: String,
        paymentDate: String
    ) {
        val ctx = context ?: return
        val session = CustomerApplication.sessionManager
        val mac = session.getPrinterMac()
        if (mac.isEmpty()) {
            Toast.makeText(ctx, "Pilih printer Bluetooth di menu Pengaturan terlebih dahulu", Toast.LENGTH_LONG).show()
            return
        }

        lifecycleScope.launch {
            Toast.makeText(ctx, "Mengirim ke printer Bluetooth...", Toast.LENGTH_SHORT).show()
            val res = BluetoothPrinterHelper.printInvoiceReceipt(
                deviceAddress = mac,
                is80mm = session.isPrinter80mm(),
                companyName = session.getIspName(),
                companyAddress = "KASIR / ADMIN RESMI",
                companyPhone = session.getAdminPhone().ifBlank { "0812-3456-7890" },
                invoiceNumber = invoiceNumber,
                customerName = customerName,
                packageName = packageName,
                period = period,
                amountFormatted = amountFormatted,
                collectorName = "Admin / Kasir",
                paymentDate = paymentDate
            )
            if (res.isSuccess) {
                Toast.makeText(ctx, "Struk berhasil dicetak!", Toast.LENGTH_SHORT).show()
            } else {
                Toast.makeText(ctx, "Gagal mencetak: ${res.exceptionOrNull()?.message}", Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun confirmIsolateCustomer(customerId: Int, customerName: String) {
        val ctx = context ?: return
        AlertDialog.Builder(ctx)
            .setTitle(" Isolir Pelanggan")
            .setMessage("Apakah Anda yakin ingin mengisolir internet pelanggan \"$customerName\" di MikroTik?")
            .setPositiveButton("Ya, Isolir") { _, _ ->
                processIsolateCustomer(customerId)
            }
            .setNegativeButton("Batal", null)
            .show()
    }

    private fun processIsolateCustomer(customerId: Int) {
        val ctx = context ?: return
        lifecycleScope.launch {
            Toast.makeText(ctx, "Mengisolir di MikroTik...", Toast.LENGTH_SHORT).show()
            val url = "${getBaseUrl()}/api/customer/app/admin/isolate-customer"

            val bodyJson = JSONObject().apply {
                put("customerId", customerId)
            }.toString()

            val success = withContext(Dispatchers.IO) {
                try {
                    val reqBody = bodyJson.toRequestBody("application/json".toMediaType())
                    val req = Request.Builder().url(url)
                        .addHeader("Authorization", "Bearer ${getToken()}")
                        .post(reqBody).build()
                    val resp = httpClient().newCall(req).execute()
                    resp.isSuccessful
                } catch (_: Exception) { false }
            }

            if (success) {
                Toast.makeText(ctx, " Pelanggan berhasil di-isolir!", Toast.LENGTH_LONG).show()
                loadCustomers(binding.etSearch.text.toString().trim())
            } else {
                Toast.makeText(ctx, "Gagal mengisolir pelanggan", Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun confirmUnisolateAndDefer(customerId: Int, customerName: String) {
        val ctx = context ?: return
        AlertDialog.Builder(ctx)
            .setTitle(" Buka Isolir (Ditangguhkan)")
            .setMessage("Buka isolir untuk \"$customerName\" dan ubah status menjadi DITANGGUHKAN?\n\n Catatan Logika: Pelanggan akan kembali ONLINE di MikroTik dan TIDAK AKAN di-isolir otomatis oleh cron penjadwalan harian walau tagihannya belum lunas.")
            .setPositiveButton("Buka & Tangguhkan") { _, _ ->
                processUnisolateAndDefer(customerId)
            }
            .setNegativeButton("Batal", null)
            .show()
    }

    private fun processUnisolateAndDefer(customerId: Int) {
        val ctx = context ?: return
        lifecycleScope.launch {
            Toast.makeText(ctx, "Membuka isolir & mengupdate status...", Toast.LENGTH_SHORT).show()
            val url = "${getBaseUrl()}/api/customer/app/admin/unisolate-customer"

            val bodyJson = JSONObject().apply {
                put("customerId", customerId)
                put("status", "ditangguhkan")
            }.toString()

            val success = withContext(Dispatchers.IO) {
                try {
                    val reqBody = bodyJson.toRequestBody("application/json".toMediaType())
                    val req = Request.Builder().url(url)
                        .addHeader("Authorization", "Bearer ${getToken()}")
                        .post(reqBody).build()
                    val resp = httpClient().newCall(req).execute()
                    resp.isSuccessful
                } catch (_: Exception) { false }
            }

            if (success) {
                Toast.makeText(ctx, " Layanan dibuka & status DITANGGUHKAN (Bebas auto-isolir)!", Toast.LENGTH_LONG).show()
                loadCustomers(binding.etSearch.text.toString().trim())
            } else {
                Toast.makeText(ctx, "Gagal membuka isolir pelanggan", Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun showCustomerTopupDialog(customerId: Int, customerName: String, currentBalance: Double) {
        val ctx = context ?: return
        val fmt = NumberFormat.getCurrencyInstance(Locale("id", "ID"))

        val layout = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 24, 48, 16)
        }

        val tvInfo = TextView(ctx).apply {
            text = "Pelanggan: $customerName\nSaldo Saat Ini: ${fmt.format(currentBalance)}"
            setTextColor(ContextCompat.getColor(ctx, R.color.text_white))
            textSize = 13.5f
            setTypeface(null, android.graphics.Typeface.BOLD)
            setPadding(0, 0, 0, 16)
        }
        layout.addView(tvInfo)

        // Radio Group: Tambah (+) vs Potong (-)
        val rgAction = RadioGroup(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, 0, 0, 16)
        }
        val rbAdd = RadioButton(ctx).apply {
            text = "➕ Tambah Saldo"
            setTextColor(ContextCompat.getColor(ctx, R.color.text_white))
            textSize = 12f
            isChecked = true
        }
        val rbDeduct = RadioButton(ctx).apply {
            text = "➖ Potong Saldo"
            setTextColor(ContextCompat.getColor(ctx, R.color.text_white))
            textSize = 12f
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { marginStart = 24 }
        }
        rgAction.addView(rbAdd)
        rgAction.addView(rbDeduct)
        layout.addView(rgAction)

        val tvLabelAmount = TextView(ctx).apply {
            text = "Nominal (Rp):"
            setTextColor(ContextCompat.getColor(ctx, R.color.accent))
            textSize = 12f
            setPadding(0, 0, 0, 6)
        }
        layout.addView(tvLabelAmount)

        val etAmount = EditText(ctx).apply {
            hint = "Contoh: 50000"
            inputType = android.text.InputType.TYPE_CLASS_NUMBER
            setTextColor(ContextCompat.getColor(ctx, R.color.text_white))
            setHintTextColor(ContextCompat.getColor(ctx, R.color.text_muted))
            textSize = 15f
            background = ContextCompat.getDrawable(ctx, R.drawable.bg_input_field)
            setPadding(24, 20, 24, 20)
        }
        layout.addView(etAmount)

        // Quick amount preset chips
        val quickAmounts = listOf(10000, 20000, 50000, 100000, 200000, 500000)
        val chipsRow1 = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, 12, 0, 6)
        }
        for (amt in quickAmounts.take(3)) {
            val btnChip = Button(ctx, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                layoutParams = LinearLayout.LayoutParams(0, 75, 1f).apply { marginEnd = 6 }
                text = "${amt / 1000}k"
                textSize = 11f
                setTextColor(ContextCompat.getColor(ctx, R.color.accent))
                setOnClickListener { etAmount.setText(amt.toString()) }
            }
            chipsRow1.addView(btnChip)
        }
        layout.addView(chipsRow1)

        val chipsRow2 = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, 0, 0, 14)
        }
        for (amt in quickAmounts.drop(3)) {
            val btnChip = Button(ctx, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                layoutParams = LinearLayout.LayoutParams(0, 75, 1f).apply { marginEnd = 6 }
                text = "${amt / 1000}k"
                textSize = 11f
                setTextColor(ContextCompat.getColor(ctx, R.color.accent))
                setOnClickListener { etAmount.setText(amt.toString()) }
            }
            chipsRow2.addView(btnChip)
        }
        layout.addView(chipsRow2)

        val tvLabelNote = TextView(ctx).apply {
            text = "Keterangan / Catatan:"
            setTextColor(ContextCompat.getColor(ctx, R.color.accent))
            textSize = 12f
            setPadding(0, 0, 0, 6)
        }
        layout.addView(tvLabelNote)

        val etNote = EditText(ctx).apply {
            hint = "Cth: Deposit Tunai di Loket"
            setTextColor(ContextCompat.getColor(ctx, R.color.text_white))
            setHintTextColor(ContextCompat.getColor(ctx, R.color.text_muted))
            textSize = 13.5f
            background = ContextCompat.getDrawable(ctx, R.drawable.bg_input_field)
            setPadding(24, 20, 24, 20)
        }
        layout.addView(etNote)

        val cbWa = CheckBox(ctx).apply {
            text = "Kirim Notifikasi WhatsApp ke Pelanggan"
            setTextColor(ContextCompat.getColor(ctx, R.color.text_white))
            textSize = 12f
            isChecked = true
            setPadding(8, 12, 0, 0)
        }
        layout.addView(cbWa)

        AlertDialog.Builder(ctx)
            .setTitle("💰 Kelola Saldo Pelanggan")
            .setView(layout)
            .setPositiveButton("Simpan Transaksi") { _, _ ->
                val amountStr = etAmount.text.toString().trim()
                val amount = amountStr.toDoubleOrNull() ?: 0.0
                if (amount <= 0) {
                    Toast.makeText(ctx, "Nominal tidak valid!", Toast.LENGTH_SHORT).show()
                } else {
                    val actionType = if (rbDeduct.isChecked) "deduct" else "add"
                    val note = etNote.text.toString().trim().ifEmpty {
                        if (actionType == "deduct") "Koreksi Saldo Manual" else "Setoran Tunai Manual"
                    }
                    val sendWa = cbWa.isChecked
                    processCustomerTopup(customerId, amount, actionType, note, sendWa, customerName)
                }
            }
            .setNegativeButton("Batal", null)
            .show()
    }

    private fun processCustomerTopup(
        customerId: Int,
        amount: Double,
        actionType: String,
        note: String,
        sendWhatsApp: Boolean,
        customerName: String
    ) {
        val ctx = context ?: return
        Toast.makeText(ctx, "Memproses update saldo...", Toast.LENGTH_SHORT).show()

        lifecycleScope.launch {
            val url = "${getBaseUrl()}/api/customer/app/admin/customers/topup"
            val bodyJson = JSONObject().apply {
                put("customerId", customerId)
                put("amount", amount)
                put("actionType", actionType)
                put("note", note)
                put("sendWhatsApp", sendWhatsApp)
            }.toString()

            val (success, message) = withContext(Dispatchers.IO) {
                try {
                    val reqBody = bodyJson.toRequestBody("application/json".toMediaType())
                    val req = Request.Builder().url(url)
                        .addHeader("Authorization", "Bearer ${getToken()}")
                        .post(reqBody).build()
                    val resp = httpClient().newCall(req).execute()
                    val respStr = resp.body?.string() ?: ""
                    val json = if (respStr.isNotEmpty()) JSONObject(respStr) else JSONObject()
                    val ok = resp.isSuccessful && json.optBoolean("success", false)
                    val msg = json.optString("message", if (ok) "Berhasil" else "Gagal memperbarui saldo")
                    Pair(ok, msg)
                } catch (e: Exception) {
                    Pair(false, e.message ?: "Koneksi gagal")
                }
            }

            if (success) {
                Toast.makeText(ctx, "✅ $message", Toast.LENGTH_LONG).show()
                loadCustomers(binding.etSearch.text.toString().trim())
            } else {
                Toast.makeText(ctx, "❌ $message", Toast.LENGTH_LONG).show()
            }
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}