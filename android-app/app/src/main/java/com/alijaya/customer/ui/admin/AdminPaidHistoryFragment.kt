package com.alijaya.customer.ui.admin

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.cardview.widget.CardView
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.alijaya.customer.CustomerApplication
import com.alijaya.customer.R
import com.alijaya.customer.databinding.FragmentAdminPaidHistoryBinding
import com.alijaya.customer.util.BluetoothPrinterHelper
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.text.NumberFormat
import java.util.Locale
import java.util.concurrent.TimeUnit

class AdminPaidHistoryFragment : Fragment() {
    private var _binding: FragmentAdminPaidHistoryBinding? = null
    private val binding get() = _binding!!

    private var paidInvoices = mutableListOf<JSONObject>()

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
        _binding = FragmentAdminPaidHistoryBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        binding.swipeRefresh.setOnRefreshListener {
            loadPaidHistory(binding.etSearch.text.toString().trim())
        }

        binding.btnSearch.setOnClickListener {
            loadPaidHistory(binding.etSearch.text.toString().trim())
        }

        updatePrinterStatus()
        loadPaidHistory()
    }

    private fun updatePrinterStatus() {
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

    private fun loadPaidHistory(search: String = "") {
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
                    var sumTotal = 0.0
                    for (i in 0 until arr.length()) {
                        val item = arr.getJSONObject(i)
                        paidInvoices.add(item)
                        sumTotal += item.optDouble("amount", 0.0)
                    }

                    val fmt = NumberFormat.getCurrencyInstance(Locale("id", "ID"))
                    binding.tvTotalPaidSummary.text = "${fmt.format(sumTotal)} (${paidInvoices.size} Transaksi)"

                    renderHistory()
                    return@launch
                } catch (_: Exception) {}
            }

            binding.tvEmpty.visibility = View.VISIBLE
        }
    }

    private fun renderHistory() {
        val container = binding.layoutHistoryContainer
        container.removeAllViews()
        container.addView(binding.pbLoading)
        container.addView(binding.tvEmpty)

        if (paidInvoices.isEmpty()) {
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
                text = "\uD83D\uDCB0 Jumlah: ${fmt.format(amount)} (Periode: $period)\n\uD83D\uDCE6 Paket: $pkgName | \uD83D\uDCF1 $phone\n\uD83D\uDCC5 Bayar: $paidAt ($paidBy)"
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

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}