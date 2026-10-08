package com.alijaya.customer.ui.collector

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.cardview.widget.CardView
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.alijaya.customer.CustomerApplication
import com.alijaya.customer.R
import com.alijaya.customer.databinding.FragmentCollectorHomeBinding
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

class CollectorHomeFragment : Fragment() {
    private var _binding: FragmentCollectorHomeBinding? = null
    private val binding get() = _binding!!

    private var allCustomers = mutableListOf<JSONObject>()
    private var activeFilter = "all" // all, unpaid, today, isolir

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
        _binding = FragmentCollectorHomeBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        binding.swipeRefresh.setOnRefreshListener {
            loadData(binding.etSearch.text.toString().trim())
        }

        binding.btnSearch.setOnClickListener {
            loadData(binding.etSearch.text.toString().trim())
        }

        setupChips()
        loadData()
    }

    private fun setupChips() {
        binding.chipAll.setOnClickListener {
            activeFilter = "all"
            updateChipStyles()
            renderList()
        }
        binding.chipUnpaid.setOnClickListener {
            activeFilter = "unpaid"
            updateChipStyles()
            renderList()
        }
        binding.chipToday.setOnClickListener {
            activeFilter = "today"
            updateChipStyles()
            renderList()
        }
        binding.chipIsolir.setOnClickListener {
            activeFilter = "isolir"
            updateChipStyles()
            renderList()
        }
    }

    private fun updateChipStyles() {
        binding.chipAll.alpha = if (activeFilter == "all") 1.0f else 0.6f
        binding.chipUnpaid.alpha = if (activeFilter == "unpaid") 1.0f else 0.6f
        binding.chipToday.alpha = if (activeFilter == "today") 1.0f else 0.6f
        binding.chipIsolir.alpha = if (activeFilter == "isolir") 1.0f else 0.6f
    }

    private fun loadData(search: String = "") {
        binding.swipeRefresh.isRefreshing = true
        binding.pbLoading.visibility = View.VISIBLE
        binding.tvEmpty.visibility = View.GONE

        lifecycleScope.launch {
            val url = "${getBaseUrl()}/api/customer/app/collector/dashboard?search=${search}&filter=${activeFilter}"
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
                    val data = json.optJSONObject("data")
                    if (data != null) {
                        val summary = data.optJSONObject("summary")
                        if (summary != null) {
                            val unpaidCnt = summary.optInt("unpaidCount", 0)
                            val todayCnt = summary.optInt("todayCount", 0)
                            binding.tvStatUnpaid.text = "$unpaidCnt Tagihan"
                            binding.tvStatToday.text = "$todayCnt Hari Ini"
                        }

                        val arr = data.optJSONArray("customers") ?: JSONArray()
                        allCustomers.clear()
                        for (i in 0 until arr.length()) {
                            allCustomers.add(arr.getJSONObject(i))
                        }
                        renderList()
                        return@launch
                    }
                } catch (_: Exception) {}
            }

            binding.tvEmpty.visibility = View.VISIBLE
        }
    }

    private fun renderList() {
        val container = binding.layoutCollectorContainer
        container.removeAllViews()
        container.addView(binding.pbLoading)
        container.addView(binding.tvEmpty)

        if (allCustomers.isEmpty()) {
            binding.tvEmpty.visibility = View.VISIBLE
            return
        }
        binding.tvEmpty.visibility = View.GONE

        val ctx = context ?: return
        val fmt = NumberFormat.getCurrencyInstance(Locale("id", "ID"))

        for (c in allCustomers) {
            val cId = c.optInt("id")
            val name = c.optString("name", "Pelanggan")
            val phone = c.optString("phone", "-")
            val address = c.optString("address", "-")
            val status = c.optString("status", "active").lowercase()
            val pkgName = c.optString("package_name", "Paket Internet")
            val pkgPrice = c.optDouble("package_price", 0.0)
            val invId = c.optInt("invoice_id", 0)
            val invStatus = c.optString("invoice_status", "unpaid").lowercase()
            val invAmount = c.optDouble("invoice_amount", pkgPrice)
            val period = "${c.optInt("period_month")}/${c.optInt("period_year")}"

            val isPaid = invStatus == "paid"

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

            val tvName = TextView(ctx).apply {
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                text = name
                setTextColor(ContextCompat.getColor(ctx, R.color.text_white))
                textSize = 15f
                setTypeface(null, android.graphics.Typeface.BOLD)
            }

            val tvBadge = TextView(ctx).apply {
                setPadding(16, 4, 16, 4)
                textSize = 10.5f
                setTypeface(null, android.graphics.Typeface.BOLD)

                if (isPaid) {
                    text = " LUNAS"
                    setTextColor(ContextCompat.getColor(ctx, R.color.success))
                } else if (status == "suspended" || status == "isolated") {
                    text = " ISOLIR"
                    setTextColor(ContextCompat.getColor(ctx, R.color.danger))
                } else if (status == "ditangguhkan" || status == "deferred") {
                    text = " TANGGUH"
                    setTextColor(ContextCompat.getColor(ctx, R.color.warning))
                } else {
                    text = " BELUM BAYAR"
                    setTextColor(ContextCompat.getColor(ctx, R.color.warning))
                }
            }

            topRow.addView(tvName)
            topRow.addView(tvBadge)
            cardContent.addView(topRow)

            // Details
            val tvDetails = TextView(ctx).apply {
                text = "\uD83D\uDCCD $address\n\uD83D\uDCF1 $phone | \uD83D\uDCE6 Paket: $pkgName\n\uD83D\uDCB0 Tagihan: ${fmt.format(invAmount)} ($period)"
                setTextColor(ContextCompat.getColor(ctx, R.color.text_muted))
                textSize = 11.5f
                setPadding(0, 8, 0, 12)
            }
            cardContent.addView(tvDetails)

            // Buttons Row
            val btnRow = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
            }

            if (!isPaid) {
                val btnPay = Button(ctx, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                    layoutParams = LinearLayout.LayoutParams(0, 80, 1.2f).apply { marginEnd = 6 }
                    text = "\uD83D\uDCB5 Terima Bayar"
                    textSize = 10.5f
                    setTextColor(ContextCompat.getColor(ctx, R.color.success))
                    setOnClickListener {
                        confirmCollectPayment(invId, cId, name, invAmount, period, phone)
                    }
                }
                btnRow.addView(btnPay)
            }

            if (phone.isNotEmpty() && phone != "-") {
                val btnWa = Button(ctx, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                    layoutParams = LinearLayout.LayoutParams(0, 80, 1f).apply { marginEnd = 6 }
                    text = "\uD83D\uDCAC WhatsApp"
                    textSize = 10.5f
                    setTextColor(ContextCompat.getColor(ctx, R.color.accent))
                    setOnClickListener {
                        openWhatsApp(phone, name, invAmount, period)
                    }
                }
                btnRow.addView(btnWa)
            }

            val btnPrint = Button(ctx, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                layoutParams = LinearLayout.LayoutParams(0, 80, 0.9f)
                text = "\uD83D\uDDA8 Struk"
                textSize = 10.5f
                setTextColor(ContextCompat.getColor(ctx, R.color.text_white))
                setOnClickListener {
                    printReceipt(invId, name, invAmount, period)
                }
            }
            btnRow.addView(btnPrint)

            cardContent.addView(btnRow)
            card.addView(cardContent)
            container.addView(card)
        }
    }

    private fun confirmCollectPayment(invId: Int, customerId: Int, customerName: String, amount: Double, period: String, phone: String) {
        val ctx = context ?: return
        val fmt = NumberFormat.getCurrencyInstance(Locale("id", "ID")).format(amount)
        val session = CustomerApplication.sessionManager
        val hasPrinter = session.getPrinterMac().isNotEmpty()

        AlertDialog.Builder(ctx)
            .setTitle("💰 Terima Pembayaran Lapangan")
            .setMessage("Terima pembayaran tagihan lapangan berikut?\n\n• Pelanggan: $customerName\n• Periode: $period\n• Total: $fmt\n\nPilih mode pembayaran:")
            .setPositiveButton("🖨️ Terima & Cetak") { _, _ ->
                processCollectPayment(invId, customerId, customerName, amount, period, shouldPrint = true)
            }
            .setNeutralButton("⚡ Terima Saja (Hemat Kertas)") { _, _ ->
                processCollectPayment(invId, customerId, customerName, amount, period, shouldPrint = false)
            }
            .setNegativeButton("Batal", null)
            .show()
    }

    private fun processCollectPayment(invId: Int, customerId: Int, customerName: String, amount: Double, period: String, shouldPrint: Boolean) {
        val ctx = context ?: return
        val session = CustomerApplication.sessionManager
        val mac = session.getPrinterMac()
        val fmt = NumberFormat.getCurrencyInstance(Locale("id", "ID")).format(amount)

        lifecycleScope.launch {
            Toast.makeText(ctx, "Memproses pembayaran lapangan...", Toast.LENGTH_SHORT).show()
            val url = "${getBaseUrl()}/api/customer/app/collector/pay-bill"

            val bodyJson = JSONObject().apply {
                put("invoiceId", invId)
                put("customerId", customerId)
                put("note", "Pembayaran Diterima Kolektor Lapangan")
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
                if (shouldPrint && mac.isNotEmpty()) {
                    BluetoothPrinterHelper.printInvoiceReceipt(
                        deviceAddress = mac,
                        is80mm = session.isPrinter80mm(),
                        companyName = session.getIspName(),
                        companyAddress = "Kolektor Resmi Lapangan",
                        companyPhone = session.getAdminPhone().ifBlank { "0812-3456-7890" },
                        invoiceNumber = if (invId > 0) "#INV-$invId" else "#INV-TAGIH",
                        customerName = customerName,
                        packageName = "Langganan Internet",
                        period = period,
                        amountFormatted = fmt,
                        collectorName = "Kolektor",
                        paymentDate = "LUNAS"
                    )
                }

                AlertDialog.Builder(ctx)
                    .setTitle("✅ Pembayaran Berhasil")
                    .setMessage(
                        if (shouldPrint && mac.isNotEmpty())
                            "Pembayaran tagihan $customerName ($period) sebesar $fmt berhasil diterima dan LUNAS!\n\nStruk dicetak ke printer Bluetooth."
                        else
                            "Pembayaran tagihan $customerName ($period) sebesar $fmt berhasil diterima dan LUNAS!\n\nBukti bayar dikirim ke WA pelanggan (Kertas thermal dihemat)."
                    )
                    .setPositiveButton("Selesai", null)
                    .setNeutralButton("🖨️ Cetak Struk (Jika Butuh)") { _, _ ->
                        printReceipt(invId, customerName, amount, period)
                    }
                    .show()

                loadData(binding.etSearch.text.toString().trim())
            } else {
                Toast.makeText(ctx, "Gagal memproses pembayaran kolektor", Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun printReceipt(invId: Int, customerName: String, amount: Double, period: String) {
        val ctx = context ?: return
        val session = CustomerApplication.sessionManager
        val mac = session.getPrinterMac()
        if (mac.isEmpty()) {
            Toast.makeText(ctx, "Pilih printer Bluetooth terlebih dahulu di menu Pengaturan", Toast.LENGTH_LONG).show()
            return
        }

        val fmt = NumberFormat.getCurrencyInstance(Locale("id", "ID")).format(amount)
        lifecycleScope.launch {
            Toast.makeText(ctx, "Mencetak struk Bluetooth...", Toast.LENGTH_SHORT).show()
            val res = BluetoothPrinterHelper.printInvoiceReceipt(
                deviceAddress = mac,
                is80mm = session.isPrinter80mm(),
                companyName = session.getIspName(),
                companyAddress = "Kolektor Resmi Lapangan",
                companyPhone = session.getAdminPhone().ifBlank { "0812-3456-7890" },
                invoiceNumber = if (invId > 0) "#INV-$invId" else "#INV-TAGIH",
                customerName = customerName,
                packageName = "Langganan Internet",
                period = period,
                amountFormatted = fmt,
                collectorName = "Kolektor",
                paymentDate = "LUNAS"
            )
            if (res.isSuccess) {
                Toast.makeText(ctx, "Struk berhasil dicetak!", Toast.LENGTH_SHORT).show()
            } else {
                Toast.makeText(ctx, "Gagal cetak: ${res.exceptionOrNull()?.message}", Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun openWhatsApp(phone: String, customerName: String, amount: Double, period: String) {
        try {
            var p = phone.replace(Regex("[^0-9]"), "")
            if (p.startsWith("08")) p = "62" + p.substring(1)
            val fmt = NumberFormat.getCurrencyInstance(Locale("id", "ID")).format(amount)
            val msg = "Halo Bp/Ibu $customerName, kami dari bagian penagihan internet ingin mengkonfirmasi tagihan periode $period sebesar $fmt. Mohon kesediaannya untuk pelunasan. Terima kasih."
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse("https://wa.me/$p?text=${Uri.encode(msg)}"))
            startActivity(intent)
        } catch (_: Exception) {
            Toast.makeText(context, "Tidak dapat membuka WhatsApp", Toast.LENGTH_SHORT).show()
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}
