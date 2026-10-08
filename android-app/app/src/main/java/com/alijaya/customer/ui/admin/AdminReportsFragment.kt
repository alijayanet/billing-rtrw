package com.alijaya.customer.ui.admin

import android.content.Context
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
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.cardview.widget.CardView
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.alijaya.customer.CustomerApplication
import com.alijaya.customer.databinding.FragmentAdminReportsBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.text.NumberFormat
import java.util.Calendar
import java.util.Locale
import java.util.concurrent.TimeUnit

class AdminReportsFragment : Fragment() {

    private var _binding: FragmentAdminReportsBinding? = null
    private val binding get() = _binding!!

    private val colorBgDark = Color.parseColor("#0F172A")
    private val colorCardDark = Color.parseColor("#1E293B")
    private val colorTextWhite = Color.parseColor("#FFFFFF")
    private val colorTextMuted = Color.parseColor("#94A3B8")
    private val colorAccent = Color.parseColor("#38BDF8")
    private val colorGreen = Color.parseColor("#4ADE80")
    private val colorYellow = Color.parseColor("#FACC15")
    private val colorRed = Color.parseColor("#EF4444")
    private val colorBlue = Color.parseColor("#3B82F6")

    private var selectedMonth = Calendar.getInstance().get(Calendar.MONTH) + 1
    private var selectedYear = Calendar.getInstance().get(Calendar.YEAR)

    private val monthNames = arrayOf(
        "", "Januari", "Februari", "Maret", "April", "Mei", "Juni",
        "Juli", "Agustus", "September", "Oktober", "November", "Desember"
    )

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
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View {
        _binding = FragmentAdminReportsBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        binding.swipeRefresh.setColorSchemeColors(colorAccent, colorBlue, colorGreen)
        binding.swipeRefresh.setProgressBackgroundColorSchemeColor(colorCardDark)

        binding.swipeRefresh.setOnRefreshListener {
            loadReport()
        }

        loadReport()
    }

    private fun loadReport() {
        val ctx = context ?: return
        binding.swipeRefresh.isRefreshing = true

        val container = binding.contentContainer
        container.removeAllViews()

        val pb = ProgressBar(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply {
                gravity = Gravity.CENTER_HORIZONTAL
                setMargins(0, 80, 0, 80)
            }
        }
        container.addView(pb)

        lifecycleScope.launch {
            val url = "${getBaseUrl()}/api/customer/app/admin/reports?month=$selectedMonth&year=$selectedYear"
            val responseStr = withContext(Dispatchers.IO) {
                try {
                    val req = Request.Builder()
                        .url(url)
                        .addHeader("Authorization", "Bearer ${getToken()}")
                        .build()
                    val resp = httpClient().newCall(req).execute()
                    if (resp.isSuccessful) resp.body?.string() else null
                } catch (e: Exception) {
                    null
                }
            }

            binding.swipeRefresh.isRefreshing = false
            container.removeView(pb)

            if (responseStr != null) {
                try {
                    val json = JSONObject(responseStr)
                    val data = json.optJSONObject("data")
                    if (data != null) {
                        renderReport(data)
                        return@launch
                    }
                } catch (e: Exception) {
                    // Fallthrough to error
                }
            }

            renderEmptyState("Gagal memuat laporan keuangan periode ini.")
            if (isAdded) {
                Toast.makeText(ctx, "Gagal memuat laporan keuangan", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun renderReport(data: JSONObject) {
        val ctx = context ?: return
        val container = binding.contentContainer
        container.removeAllViews()

        val fmt = NumberFormat.getCurrencyInstance(Locale("id", "ID"))
        fmt.maximumFractionDigits = 0

        val income = data.optDouble("income", 0.0)
        val prevIncome = data.optDouble("prevIncome", 0.0)
        val expense = data.optDouble("expense", 0.0)
        val netProfit = data.optDouble("netProfit", income - expense)
        val paidCount = data.optInt("paidCount", 0)
        val unpaidCount = data.optInt("unpaidCount", 0)
        val recentPayments = data.optJSONArray("recentPayments") ?: JSONArray()

        // 1. Month / Period Selector Card
        val filterCard = createCard(ctx)
        val filterLayout = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(28, 20, 28, 20)
        }

        val selectorRow = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }

        val btnPrev = Button(ctx, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
            text = "◀"
            textSize = 14f
            setTextColor(colorAccent)
            setPadding(0, 0, 0, 0)
            layoutParams = LinearLayout.LayoutParams(110, 110)
            setOnClickListener {
                if (selectedMonth == 1) {
                    selectedMonth = 12
                    selectedYear -= 1
                } else {
                    selectedMonth -= 1
                }
                loadReport()
            }
        }

        val tvPeriodName = TextView(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
            val monthName = if (selectedMonth in 1..12) monthNames[selectedMonth] else "$selectedMonth"
            text = "📅 $monthName $selectedYear"
            setTextColor(colorTextWhite)
            textSize = 16f
            gravity = Gravity.CENTER
            setTypeface(null, Typeface.BOLD)
        }

        val btnNext = Button(ctx, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
            text = "▶"
            textSize = 14f
            setTextColor(colorAccent)
            setPadding(0, 0, 0, 0)
            layoutParams = LinearLayout.LayoutParams(110, 110)
            setOnClickListener {
                if (selectedMonth == 12) {
                    selectedMonth = 1
                    selectedYear += 1
                } else {
                    selectedMonth += 1
                }
                loadReport()
            }
        }

        selectorRow.addView(btnPrev)
        selectorRow.addView(tvPeriodName)
        selectorRow.addView(btnNext)
        filterLayout.addView(selectorRow)
        filterCard.addView(filterLayout)
        container.addView(filterCard)

        // 2. Income Card (Green)
        val incomeCard = createCard(ctx)
        val incomeLayout = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 28, 32, 28)
        }

        val tvIncomeLabel = TextView(ctx).apply {
            text = "💵 Total Pendapatan (Omset)"
            setTextColor(colorTextMuted)
            textSize = 13f
        }

        val tvIncomeVal = TextView(ctx).apply {
            text = fmt.format(income)
            setTextColor(colorGreen)
            textSize = 22f
            setTypeface(null, Typeface.BOLD)
            setPadding(0, 6, 0, 4)
        }

        val tvPrevIncome = TextView(ctx).apply {
            text = "Bulan sebelumnya: ${fmt.format(prevIncome)}"
            setTextColor(colorTextMuted)
            textSize = 11.5f
        }

        incomeLayout.addView(tvIncomeLabel)
        incomeLayout.addView(tvIncomeVal)
        incomeLayout.addView(tvPrevIncome)
        incomeCard.addView(incomeLayout)
        container.addView(incomeCard)

        // 3. Expense Card (Red)
        val expenseCard = createCard(ctx)
        val expenseLayout = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 28, 32, 28)
        }

        val tvExpenseLabel = TextView(ctx).apply {
            text = "💸 Total Pengeluaran Operasional"
            setTextColor(colorTextMuted)
            textSize = 13f
        }

        val tvExpenseVal = TextView(ctx).apply {
            text = fmt.format(expense)
            setTextColor(colorRed)
            textSize = 22f
            setTypeface(null, Typeface.BOLD)
            setPadding(0, 6, 0, 4)
        }

        val tvExpenseDesc = TextView(ctx).apply {
            text = "Total seluruh biaya dan beban tercatat pada bulan ini"
            setTextColor(colorTextMuted)
            textSize = 11.5f
        }

        expenseLayout.addView(tvExpenseLabel)
        expenseLayout.addView(tvExpenseVal)
        expenseLayout.addView(tvExpenseDesc)
        expenseCard.addView(expenseLayout)
        container.addView(expenseCard)

        // 4. Net Profit Card (Blue/Accent or Green)
        val profitCard = createCard(ctx)
        val profitLayout = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 28, 32, 28)
        }

        val tvProfitLabel = TextView(ctx).apply {
            text = "📈 Laba Bersih (Net Profit)"
            setTextColor(colorTextMuted)
            textSize = 13f
        }

        val profitColor = if (netProfit >= 0) colorAccent else colorRed
        val tvProfitVal = TextView(ctx).apply {
            text = fmt.format(netProfit)
            setTextColor(profitColor)
            textSize = 24f
            setTypeface(null, Typeface.BOLD)
            setPadding(0, 6, 0, 4)
        }

        val tvProfitFormula = TextView(ctx).apply {
            text = "Formula: Pendapatan (${fmt.format(income)}) - Beban (${fmt.format(expense)})"
            setTextColor(colorTextMuted)
            textSize = 11.5f
        }

        profitLayout.addView(tvProfitLabel)
        profitLayout.addView(tvProfitVal)
        profitLayout.addView(tvProfitFormula)
        profitCard.addView(profitLayout)
        container.addView(profitCard)

        // 5. Billing Collection Summary Card
        val collectionCard = createCard(ctx)
        val collectionLayout = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 28, 32, 28)
        }

        val tvCollTitle = TextView(ctx).apply {
            text = "📊 Status Penagihan Invoice"
            setTextColor(colorTextWhite)
            textSize = 15f
            setTypeface(null, Typeface.BOLD)
            setPadding(0, 0, 0, 14)
        }
        collectionLayout.addView(tvCollTitle)

        val statsRow = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            weightSum = 2f
        }

        // Paid Box
        val paidBox = LinearLayout(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply {
                setMargins(0, 0, 8, 0)
            }
            orientation = LinearLayout.VERTICAL
            val bgDrawable = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = 16f
                setColor(Color.parseColor("#154ADE80"))
            }
            background = bgDrawable
            setPadding(20, 20, 20, 20)
        }

        val tvPaidTitle = TextView(ctx).apply {
            text = "✅ Lunas"
            setTextColor(colorGreen)
            textSize = 12f
            setTypeface(null, Typeface.BOLD)
        }

        val tvPaidCount = TextView(ctx).apply {
            text = "$paidCount Tagihan"
            setTextColor(colorTextWhite)
            textSize = 15f
            setTypeface(null, Typeface.BOLD)
            setPadding(0, 4, 0, 0)
        }
        paidBox.addView(tvPaidTitle)
        paidBox.addView(tvPaidCount)

        // Unpaid Box
        val unpaidBox = LinearLayout(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply {
                setMargins(8, 0, 0, 0)
            }
            orientation = LinearLayout.VERTICAL
            val bgDrawable = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = 16f
                setColor(Color.parseColor("#15FACC15"))
            }
            background = bgDrawable
            setPadding(20, 20, 20, 20)
        }

        val tvUnpaidTitle = TextView(ctx).apply {
            text = "⏳ Belum Bayar"
            setTextColor(colorYellow)
            textSize = 12f
            setTypeface(null, Typeface.BOLD)
        }

        val tvUnpaidCount = TextView(ctx).apply {
            text = "$unpaidCount Tagihan"
            setTextColor(colorTextWhite)
            textSize = 15f
            setTypeface(null, Typeface.BOLD)
            setPadding(0, 4, 0, 0)
        }
        unpaidBox.addView(tvUnpaidTitle)
        unpaidBox.addView(tvUnpaidCount)

        statsRow.addView(paidBox)
        statsRow.addView(unpaidBox)
        collectionLayout.addView(statsRow)

        val totalInvoices = paidCount + unpaidCount
        val collectionRate = if (totalInvoices > 0) ((paidCount.toDouble() / totalInvoices) * 100).toInt() else 0

        val tvCollRate = TextView(ctx).apply {
            text = "Tingkat Kolektibilitas: $collectionRate% dari $totalInvoices total tagihan"
            setTextColor(colorTextMuted)
            textSize = 11.5f
            setPadding(0, 12, 0, 0)
        }
        collectionLayout.addView(tvCollRate)

        collectionCard.addView(collectionLayout)
        container.addView(collectionCard)

        // 6. Recent Payments Card
        val paymentsCard = createCard(ctx)
        val paymentsLayout = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 28, 32, 28)
        }

        val tvPaymentsTitle = TextView(ctx).apply {
            text = "📋 Transaksi Pembayaran Masuk (${recentPayments.length()})"
            setTextColor(colorTextWhite)
            textSize = 15f
            setTypeface(null, Typeface.BOLD)
            setPadding(0, 0, 0, 12)
        }
        paymentsLayout.addView(tvPaymentsTitle)

        if (recentPayments.length() == 0) {
            val tvEmptyPay = TextView(ctx).apply {
                text = "Belum ada pembayaran yang tercatat pada periode ini."
                setTextColor(colorTextMuted)
                textSize = 12f
                setPadding(0, 8, 0, 8)
            }
            paymentsLayout.addView(tvEmptyPay)
        } else {
            for (i in 0 until recentPayments.length()) {
                val item = recentPayments.optJSONObject(i) ?: continue
                val cName = item.optString("customer_name", "Pelanggan")
                val pName = item.optString("package_name", "Internet")
                val amt = item.optDouble("amount", 0.0)
                val paidAt = item.optString("paid_at", "-")

                val row = LinearLayout(ctx).apply {
                    orientation = LinearLayout.VERTICAL
                    setPadding(0, 10, 0, 10)
                }

                val rowTop = LinearLayout(ctx).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                }

                val tvCust = TextView(ctx).apply {
                    layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                    text = cName
                    setTextColor(colorTextWhite)
                    textSize = 13.5f
                    setTypeface(null, Typeface.BOLD)
                }

                val tvAmt = TextView(ctx).apply {
                    text = fmt.format(amt)
                    setTextColor(colorGreen)
                    textSize = 13.5f
                    setTypeface(null, Typeface.BOLD)
                }

                rowTop.addView(tvCust)
                rowTop.addView(tvAmt)
                row.addView(rowTop)

                val tvInfo = TextView(ctx).apply {
                    text = "📦 $pName • 🕒 $paidAt"
                    setTextColor(colorTextMuted)
                    textSize = 11f
                    setPadding(0, 3, 0, 0)
                }
                row.addView(tvInfo)

                paymentsLayout.addView(row)

                if (i < recentPayments.length() - 1) {
                    val div = View(ctx).apply {
                        layoutParams = LinearLayout.LayoutParams(
                            LinearLayout.LayoutParams.MATCH_PARENT,
                            1
                        ).apply {
                            setMargins(0, 4, 0, 4)
                        }
                        setBackgroundColor(Color.parseColor("#253347"))
                    }
                    paymentsLayout.addView(div)
                }
            }
        }

        paymentsCard.addView(paymentsLayout)
        container.addView(paymentsCard)
    }

    private fun createCard(ctx: Context): CardView {
        return CardView(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply {
                setMargins(0, 0, 0, 20)
            }
            radius = 24f
            cardElevation = 3f
            setCardBackgroundColor(colorCardDark)
        }
    }

    private fun renderEmptyState(message: String) {
        val ctx = context ?: return
        val container = binding.contentContainer

        val emptyCard = CardView(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply {
                setMargins(0, 40, 0, 0)
            }
            radius = 24f
            setCardBackgroundColor(colorCardDark)
        }

        val emptyLayout = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(40, 60, 40, 60)
        }

        val tvIcon = TextView(ctx).apply {
            text = "📊"
            textSize = 36f
            gravity = Gravity.CENTER
        }

        val tvMsg = TextView(ctx).apply {
            text = message
            setTextColor(colorTextMuted)
            textSize = 13f
            gravity = Gravity.CENTER
            setPadding(0, 16, 0, 0)
        }

        emptyLayout.addView(tvIcon)
        emptyLayout.addView(tvMsg)
        emptyCard.addView(emptyLayout)
        container.addView(emptyCard)
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}
