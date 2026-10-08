package com.alijaya.customer.ui.collector

import android.graphics.Color
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.cardview.widget.CardView
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.alijaya.customer.CustomerApplication
import com.alijaya.customer.databinding.FragmentCollectorHistoryBinding
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

class CollectorHistoryFragment : Fragment() {
    private var _binding: FragmentCollectorHistoryBinding? = null
    private val binding get() = _binding!!

    private var allRequests = mutableListOf<JSONObject>()

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
        _binding = FragmentCollectorHistoryBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        binding.swipeRefresh.setOnRefreshListener {
            loadHistory()
        }

        binding.etSearchHistory.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
                renderList(s.toString().trim())
            }
            override fun afterTextChanged(s: Editable?) {}
        })

        loadHistory()
    }

    private fun loadHistory() {
        binding.swipeRefresh.isRefreshing = true
        binding.pbLoading.visibility = View.VISIBLE
        binding.tvEmpty.visibility = View.GONE

        lifecycleScope.launch {
            val url = "${getBaseUrl()}/api/customer/app/collector/history"
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
                            val fmt = NumberFormat.getCurrencyInstance(Locale("id", "ID"))
                            val appTotal = summary.optDouble("approvedTotal", 0.0)
                            val pendTotal = summary.optDouble("pendingTotal", 0.0)
                            val appCount = summary.optInt("approvedCount", 0)
                            val pendCount = summary.optInt("pendingCount", 0)

                            binding.tvApprovedTotal.text = fmt.format(appTotal)
                            binding.tvApprovedCount.text = "$appCount Transaksi Lunas"
                            binding.tvPendingTotal.text = fmt.format(pendTotal)
                            binding.tvPendingCount.text = "$pendCount Menunggu Approval"
                        }

                        val arr = data.optJSONArray("requests") ?: JSONArray()
                        allRequests.clear()
                        for (i in 0 until arr.length()) {
                            allRequests.add(arr.getJSONObject(i))
                        }
                        renderList(binding.etSearchHistory.text.toString().trim())
                        return@launch
                    }
                } catch (_: Exception) {}
            }

            binding.tvEmpty.visibility = View.VISIBLE
        }
    }

    private fun renderList(query: String = "") {
        val container = binding.containerHistory
        container.removeAllViews()

        val filtered = if (query.isEmpty()) {
            allRequests
        } else {
            val q = query.lowercase()
            allRequests.filter {
                it.optString("customer_name").lowercase().contains(q) ||
                it.optString("invoice_id").contains(q) ||
                it.optString("customer_phone").contains(q)
            }
        }

        if (filtered.isEmpty()) {
            binding.tvEmpty.visibility = View.VISIBLE
            return
        }
        binding.tvEmpty.visibility = View.GONE

        val ctx = context ?: return
        val fmt = NumberFormat.getCurrencyInstance(Locale("id", "ID"))

        for (item in filtered) {
            val reqId = item.optInt("id")
            val invId = item.optInt("invoice_id")
            val custName = item.optString("customer_name", "Pelanggan")
            val phone = item.optString("customer_phone", "-")
            val address = item.optString("customer_address", "-")
            val amount = item.optDouble("amount", 0.0)
            val status = item.optString("status", "pending").lowercase()
            val note = item.optString("note", "")
            val decidedBy = item.optString("decided_by_name", "")
            val createdAt = item.optString("created_at", "")
            val period = "${item.optInt("period_month")}/${item.optInt("period_year")}"

            val card = CardView(ctx).apply {
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                ).apply {
                    setMargins(0, 0, 0, 16)
                }
                radius = 20f
                setCardBackgroundColor(Color.parseColor("#1E293B"))
                cardElevation = 3f
            }

            val cardContent = LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(28, 22, 28, 22)
            }

            // Top Header: Name & Status Badge
            val topRow = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }

            val tvName = TextView(ctx).apply {
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                text = custName
                setTextColor(Color.WHITE)
                textSize = 15.5f
                setTypeface(null, android.graphics.Typeface.BOLD)
            }

            val tvStatusBadge = TextView(ctx).apply {
                setPadding(18, 6, 18, 6)
                textSize = 11f
                setTypeface(null, android.graphics.Typeface.BOLD)

                when (status) {
                    "approved" -> {
                        text = "🟢 DISETUJUI"
                        setTextColor(Color.WHITE)
                        setBackgroundColor(Color.parseColor("#16A34A"))
                    }
                    "rejected" -> {
                        text = "🔴 DITOLAK"
                        setTextColor(Color.WHITE)
                        setBackgroundColor(Color.parseColor("#DC2626"))
                    }
                    else -> {
                        text = "🟡 MENUNGGU"
                        setTextColor(Color.WHITE)
                        setBackgroundColor(Color.parseColor("#D97706"))
                    }
                }
            }

            topRow.addView(tvName)
            topRow.addView(tvStatusBadge)
            cardContent.addView(topRow)

            // Details
            val tvDetails = TextView(ctx).apply {
                val decidedStr = if (decidedBy.isNotEmpty()) " • Oleh: $decidedBy" else ""
                val noteStr = if (note.isNotEmpty()) "\n📝 Catatan: $note" else ""
                text = "📄 Tagihan: #INV-$invId ($period)\n💰 Nominal: ${fmt.format(amount)}\n📅 Tanggal: $createdAt$decidedStr$noteStr"
                setTextColor(Color.parseColor("#CBD5E1"))
                textSize = 12f
                setPadding(0, 8, 0, 10)
            }
            cardContent.addView(tvDetails)

            // Button Print Re-print Struk
            val btnPrint = Button(ctx).apply {
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    90
                )
                text = "🖨️ Cetak Ulang Struk (Bluetooth Thermal)"
                setTextColor(Color.WHITE)
                textSize = 11.5f
                setTypeface(null, android.graphics.Typeface.BOLD)
                backgroundTintList = android.content.res.ColorStateList.valueOf(Color.parseColor("#2563EB"))
                setOnClickListener {
                    printReceipt(invId, custName, amount, period)
                }
            }
            cardContent.addView(btnPrint)

            card.addView(cardContent)
            container.addView(card)
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
            Toast.makeText(ctx, "Mencetak struk...", Toast.LENGTH_SHORT).show()
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
                collectorName = "Kolektor Lapangan",
                paymentDate = "LUNAS (Salinan)"
            )
            Toast.makeText(ctx, if (res.isSuccess) "Berhasil dicetak!" else "Gagal cetak printer", Toast.LENGTH_SHORT).show()
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}
