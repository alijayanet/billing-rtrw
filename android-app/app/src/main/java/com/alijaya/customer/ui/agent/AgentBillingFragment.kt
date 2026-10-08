package com.alijaya.customer.ui.agent

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
import com.alijaya.customer.databinding.FragmentAgentBillingBinding
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

class AgentBillingFragment : Fragment() {
    private var _binding: FragmentAgentBillingBinding? = null
    private val binding get() = _binding!!

    private var foundInvoices = mutableListOf<JSONObject>()

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
        _binding = FragmentAgentBillingBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        binding.swipeRefresh.setOnRefreshListener {
            searchCustomerBills(binding.etSearchCustomer.text.toString().trim())
        }

        binding.btnSearchCustomer.setOnClickListener {
            val query = binding.etSearchCustomer.text.toString().trim()
            if (query.isEmpty()) {
                Toast.makeText(context, "Ketik nama pelanggan, no. telepon, atau PPPoE", Toast.LENGTH_SHORT).show()
            } else {
                searchCustomerBills(query)
            }
        }
    }

    private fun searchCustomerBills(query: String) {
        if (query.isEmpty()) {
            binding.swipeRefresh.isRefreshing = false
            return
        }

        binding.swipeRefresh.isRefreshing = true
        lifecycleScope.launch {
            val url = "${getBaseUrl()}/api/customer/agent/search?q=${Uri.encode(query)}"
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
                    val arr = json.optJSONArray("data") ?: JSONArray()
                    foundInvoices.clear()
                    for (i in 0 until arr.length()) {
                        foundInvoices.add(arr.getJSONObject(i))
                    }
                    renderInvoices()
                } catch (_: Exception) {
                    binding.tvEmptyBilling.visibility = View.VISIBLE
                    binding.tvEmptyBilling.text = "Gagal memproses hasil pencarian tagihan"
                }
            } else {
                binding.tvEmptyBilling.visibility = View.VISIBLE
                binding.tvEmptyBilling.text = "Gagal terhubung ke server"
            }
        }
    }

    private fun renderInvoices() {
        val ctx = context ?: return
        val container = binding.containerInvoices
        container.removeAllViews()

        if (foundInvoices.isEmpty()) {
            binding.tvEmptyBilling.visibility = View.VISIBLE
            binding.tvEmptyBilling.text = "Tidak ditemukan tagihan tertunggak untuk pencarian tersebut"
            return
        }

        binding.tvEmptyBilling.visibility = View.GONE
        val fmt = NumberFormat.getNumberInstance(Locale("id", "ID"))

        for (inv in foundInvoices) {
            val invId = inv.optInt("id", 0)
            val custName = inv.optString("customer_name", "Pelanggan")
            val custPhone = inv.optString("customer_phone", "-")
            val pppoe = inv.optString("pppoe_username", "-")
            val pkgName = inv.optString("package_name", "Paket Internet")
            val period = "${inv.optInt("period_month", 1)}/${inv.optInt("period_year", 2026)}"
            val amount = inv.optLong("amount", 0)
            val status = inv.optString("status", "unpaid")

            val card = CardView(ctx).apply {
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                ).apply { setMargins(0, 0, 0, 24) }
                setCardBackgroundColor(ContextCompat.getColor(ctx, R.color.card_dark))
                radius = 28f
                cardElevation = 4f
            }

            val cardContent = LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(32, 28, 32, 28)
            }

            val topRow = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = android.view.Gravity.CENTER_VERTICAL
            }

            val tvTitle = TextView(ctx).apply {
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                text = custName
                setTextColor(ContextCompat.getColor(ctx, R.color.text_white))
                textSize = 15f
                typeface = android.graphics.Typeface.DEFAULT_BOLD
            }

            val tvBadge = TextView(ctx).apply {
                text = if (status.equals("paid", true)) "🟢 LUNAS" else "🔴 BELUM BAYAR"
                setTextColor(ContextCompat.getColor(ctx, if (status.equals("paid", true)) R.color.success else R.color.danger))
                textSize = 11f
                typeface = android.graphics.Typeface.DEFAULT_BOLD
            }

            topRow.addView(tvTitle)
            topRow.addView(tvBadge)
            cardContent.addView(topRow)

            val tvDetails = TextView(ctx).apply {
                text = "📄 Tagihan: #INV-$invId • Periode: $period\n📦 Paket: $pkgName\n👤 PPPoE: $pppoe • No. WA: $custPhone\n💰 Total: Rp ${fmt.format(amount)}"
                setTextColor(ContextCompat.getColor(ctx, R.color.text_muted))
                textSize = 12f
                setPadding(0, 10, 0, 14)
            }
            cardContent.addView(tvDetails)

            if (!status.equals("paid", true)) {
                val btnPay = Button(ctx, null, com.google.android.material.R.attr.materialButtonStyle).apply {
                    text = "💳 Bayar Tagihan (Rp ${fmt.format(amount)})"
                    setTextColor(ContextCompat.getColor(ctx, R.color.text_white))
                    setBackgroundColor(ContextCompat.getColor(ctx, R.color.primary))
                    setOnClickListener {
                        confirmPayInvoice(invId, custName, custPhone, period, amount, pkgName)
                    }
                }
                cardContent.addView(btnPay)
            }

            card.addView(cardContent)
            container.addView(card)
        }
    }

    private fun confirmPayInvoice(invId: Int, name: String, phone: String, period: String, amount: Long, pkgName: String) {
        val ctx = context ?: return
        val fmt = NumberFormat.getNumberInstance(Locale("id", "ID")).format(amount)
        val session = CustomerApplication.sessionManager
        val hasPrinter = session.getPrinterMac().isNotEmpty()

        AlertDialog.Builder(ctx)
            .setTitle("💳 Konfirmasi Pembayaran Tagihan")
            .setMessage("Apakah Anda ingin melunasi tagihan berikut menggunakan saldo agen Anda?\n\n" +
                        "• Pelanggan: $name\n" +
                        "• Periode: $period\n" +
                        "• Paket: $pkgName\n" +
                        "• Total: Rp $fmt\n\n" +
                        "Koneksi pelanggan akan otomatis aktif jika sebelumnya terisolir.\nPilih mode pembayaran:")
            .setPositiveButton(if (hasPrinter) "🖨️ Bayar & Cetak" else "✅ Bayar Sekarang") { _, _ ->
                executePayInvoice(invId, name, phone, period, amount, pkgName, autoPrint = hasPrinter)
            }
            .setNeutralButton("⚡ Bayar Saja (Hemat Kertas)") { _, _ ->
                executePayInvoice(invId, name, phone, period, amount, pkgName, autoPrint = false)
            }
            .setNegativeButton("Batal", null)
            .show()
    }

    private fun executePayInvoice(invId: Int, name: String, phone: String, period: String, amount: Long, pkgName: String, autoPrint: Boolean = false) {
        val ctx = context ?: return
        val progress = android.app.ProgressDialog(ctx).apply {
            setMessage("Memproses pelunasan tagihan...")
            setCancelable(false)
            show()
        }

        lifecycleScope.launch {
            val url = "${getBaseUrl()}/api/customer/agent/pay-invoice"
            val bodyJson = JSONObject().apply {
                put("invoiceId", invId)
                put("note", "Pembayaran via APK Agen Native")
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
                        Toast.makeText(ctx, "✅ Tagihan #INV-$invId berhasil dibayar LUNAS!", Toast.LENGTH_LONG).show()
                        if (autoPrint) {
                            printInvoiceBluetooth(invId, name, period, amount, pkgName)
                        }
                        showInvoiceReceiptDialog(invId, name, phone, period, amount, pkgName)
                        searchCustomerBills(binding.etSearchCustomer.text.toString().trim())
                    } else {
                        val msg = json.optString("message", "Gagal memproses pembayaran")
                        Toast.makeText(ctx, "⚠️ $msg", Toast.LENGTH_LONG).show()
                    }
                } catch (e: Exception) {
                    Toast.makeText(ctx, "Error: ${e.message}", Toast.LENGTH_SHORT).show()
                }
            } else {
                Toast.makeText(ctx, "Gagal terhubung ke server", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun showInvoiceReceiptDialog(invId: Int, name: String, phone: String, period: String, amount: Long, pkgName: String) {
        val ctx = context ?: return
        val fmt = NumberFormat.getNumberInstance(Locale("id", "ID")).format(amount)

        val scroll = android.widget.ScrollView(ctx).apply {
            isFillViewport = true
        }

        val layout = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(36, 16, 36, 10)
        }
        scroll.addView(layout)

        // 1. Status Header
        val headerCard = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = android.view.Gravity.CENTER
            setBackgroundColor(android.graphics.Color.parseColor("#15803D"))
            setPadding(16, 12, 16, 12)
        }
        val tvStatus = TextView(ctx).apply {
            text = "✅ STRUK PEMBAYARAN LUNAS"
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
            setPadding(20, 14, 20, 14)
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

        addRow("No. Invoice", "#INV-$invId", android.graphics.Color.WHITE, true, 14f)
        addRow("Nama Pelanggan", name, android.graphics.Color.parseColor("#38BDF8"), true, 15f)
        addRow("Paket Langganan", pkgName, android.graphics.Color.WHITE)
        addRow("Periode Tagihan", period, android.graphics.Color.parseColor("#CBD5E1"))
        addRow("Total Bayar", "Rp $fmt", android.graphics.Color.parseColor("#4ADE80"), true, 17f)
        addRow("Status Layanan", "AKTIF / NORMAL", android.graphics.Color.parseColor("#4ADE80"), true)

        layout.addView(detailsCard)

        if (phone.isNotEmpty() && phone != "-") {
            val btnWa = Button(ctx, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                text = "💬 Kirim Struk via WhatsApp ($phone)"
                setOnClickListener {
                    openWhatsAppInvoiceReceipt(phone, invId, name, period, amount, pkgName)
                }
            }
            layout.addView(btnWa)
        }

        AlertDialog.Builder(ctx)
            .setTitle("🧾 Struk Pembayaran Tagihan")
            .setView(scroll)
            .setPositiveButton("🖨️ Cetak Struk Bluetooth") { _, _ ->
                printInvoiceBluetooth(invId, name, period, amount, pkgName)
            }
            .setNegativeButton("Selesai", null)
            .show()
    }

    private fun printInvoiceBluetooth(invId: Int, name: String, period: String, amount: Long, pkgName: String) {
        val session = CustomerApplication.sessionManager
        val mac = session.getPrinterMac()
        if (mac.isEmpty()) {
            Toast.makeText(context, "Printer bluetooth belum dipilih.", Toast.LENGTH_SHORT).show()
            return
        }

        val fmt = NumberFormat.getNumberInstance(Locale("id", "ID")).format(amount)
        val lines = listOf(
            BluetoothPrinterHelper.centerText("================================"),
            BluetoothPrinterHelper.centerText(session.getIspName()),
            BluetoothPrinterHelper.centerText("STRUK PEMBAYARAN INTERNET"),
            BluetoothPrinterHelper.centerText("================================"),
            "No. Invoice : #INV-$invId",
            "Pelanggan   : $name",
            "Paket       : $pkgName",
            "Periode     : $period",
            "--------------------------------",
            "Total Bayar : Rp $fmt",
            "Status      : LUNAS",
            "Lokasi Bayar: Agen Resmi",
            "Tgl Cetak   : " + java.text.SimpleDateFormat("dd/MM/yyyy HH:mm", Locale.getDefault()).format(java.util.Date()),
            "================================",
            BluetoothPrinterHelper.centerText("Terima kasih atas pembayaran Anda!"),
            BluetoothPrinterHelper.centerText("================================"),
            "\n\n"
        )

        BluetoothPrinterHelper.printRawLines(requireContext(), mac, lines)
        Toast.makeText(context, "Mencetak struk pembayaran ke printer bluetooth...", Toast.LENGTH_SHORT).show()
    }

    private fun openWhatsAppInvoiceReceipt(phone: String, invId: Int, name: String, period: String, amount: Long, pkgName: String) {
        try {
            var p = phone.replace(Regex("[^0-9]"), "")
            if (p.startsWith("08")) p = "62" + p.substring(1)
            if (!p.startsWith("62")) p = "62" + p

            val fmt = NumberFormat.getNumberInstance(Locale("id", "ID")).format(amount)
            val msg = "✅ *BUKTI PEMBAYARAN TAGIHAN INTERNET*\n\n" +
                      "📄 *No. Invoice:* #INV-$invId\n" +
                      "👤 *Pelanggan:* $name\n" +
                      "📦 *Paket:* $pkgName\n" +
                      "📅 *Periode:* $period\n" +
                      "💰 *Total Dibayar:* Rp $fmt\n" +
                      "📡 *Status:* LUNAS (Koneksi Aktif)\n\n" +
                      "Terima kasih telah membayar tepat waktu di Agen Resmi ${CustomerApplication.sessionManager.getIspName()}."

            val intent = Intent(Intent.ACTION_VIEW, Uri.parse("https://wa.me/$p?text=${Uri.encode(msg)}"))
            startActivity(intent)
        } catch (_: Exception) {
            Toast.makeText(context, "Tidak dapat membuka aplikasi WhatsApp", Toast.LENGTH_SHORT).show()
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}