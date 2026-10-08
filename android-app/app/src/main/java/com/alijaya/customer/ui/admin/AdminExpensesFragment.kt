package com.alijaya.customer.ui.admin

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.cardview.widget.CardView
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.alijaya.customer.CustomerApplication
import com.alijaya.customer.databinding.FragmentAdminExpensesBinding
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
import java.util.Date
import java.util.Locale
import java.util.concurrent.TimeUnit

class AdminExpensesFragment : Fragment() {

    private var _binding: FragmentAdminExpensesBinding? = null
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

    private val expensesList = mutableListOf<JSONObject>()
    private val categoriesList = mutableListOf<String>()
    private var totalMonthAmount = 0.0

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
        _binding = FragmentAdminExpensesBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        binding.swipeRefresh.setColorSchemeColors(colorAccent, colorBlue, colorGreen)
        binding.swipeRefresh.setProgressBackgroundColorSchemeColor(colorCardDark)

        binding.swipeRefresh.setOnRefreshListener {
            loadExpenses()
        }

        loadExpenses()
    }

    private fun loadExpenses() {
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
            val url = "${getBaseUrl()}/api/customer/app/admin/expenses"
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
                        totalMonthAmount = data.optDouble("totalMonth", 0.0)

                        val expArr = data.optJSONArray("expenses") ?: JSONArray()
                        expensesList.clear()
                        for (i in 0 until expArr.length()) {
                            expensesList.add(expArr.getJSONObject(i))
                        }

                        val catArr = data.optJSONArray("categories")
                        categoriesList.clear()
                        if (catArr != null) {
                            for (i in 0 until catArr.length()) {
                                categoriesList.add(catArr.optString(i))
                            }
                        }

                        renderExpenses()
                        return@launch
                    }
                } catch (e: Exception) {
                    // Fallthrough to error
                }
            }

            renderEmptyState("Gagal memuat daftar pengeluaran operasional.")
            if (isAdded) {
                Toast.makeText(ctx, "Gagal memuat pengeluaran", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun renderExpenses() {
        val ctx = context ?: return
        val container = binding.contentContainer
        container.removeAllViews()

        val fmt = NumberFormat.getCurrencyInstance(Locale("id", "ID"))
        fmt.maximumFractionDigits = 0

        // 1. Total Bulan Ini & Action Card
        val summaryCard = CardView(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply {
                setMargins(0, 0, 0, 20)
            }
            radius = 24f
            cardElevation = 4f
            setCardBackgroundColor(colorCardDark)
        }

        val summaryLayout = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 28, 32, 28)
        }

        val tvLabel = TextView(ctx).apply {
            text = "💸 Total Pengeluaran Bulan Ini"
            setTextColor(colorTextMuted)
            textSize = 13f
        }

        val tvTotal = TextView(ctx).apply {
            text = fmt.format(totalMonthAmount)
            setTextColor(colorRed)
            textSize = 24f
            setTypeface(null, Typeface.BOLD)
            setPadding(0, 6, 0, 4)
        }

        val tvCount = TextView(ctx).apply {
            text = "Total ${expensesList.size} catatan pengeluaran"
            setTextColor(colorTextMuted)
            textSize = 11.5f
            setPadding(0, 0, 0, 16)
        }

        val btnAdd = Button(ctx, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
            text = "+ Catat Pengeluaran Baru"
            setTextColor(colorAccent)
            textSize = 13f
            setTypeface(null, Typeface.BOLD)
            setOnClickListener {
                showAddExpenseDialog()
            }
        }

        summaryLayout.addView(tvLabel)
        summaryLayout.addView(tvTotal)
        summaryLayout.addView(tvCount)
        summaryLayout.addView(btnAdd)
        summaryCard.addView(summaryLayout)
        container.addView(summaryCard)

        // Section Title
        val tvSection = TextView(ctx).apply {
            text = "📋 Riwayat Pengeluaran"
            setTextColor(colorTextWhite)
            textSize = 16f
            setTypeface(null, Typeface.BOLD)
            setPadding(8, 6, 0, 14)
        }
        container.addView(tvSection)

        if (expensesList.isEmpty()) {
            renderEmptyState("Belum ada data pengeluaran yang dicatat.")
            return
        }

        // List of Expenses
        for (exp in expensesList) {
            val expId = exp.optInt("id", 0)
            val date = exp.optString("date", "-")
            val category = exp.optString("category", "Umum")
            val amount = exp.optDouble("amount", 0.0)
            val description = exp.optString("description", "")
            val vendor = exp.optString("vendor", "")
            val paymentMethod = exp.optString("payment_method", "")

            val card = CardView(ctx).apply {
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                ).apply {
                    setMargins(0, 0, 0, 16)
                }
                radius = 20f
                cardElevation = 3f
                setCardBackgroundColor(colorCardDark)
            }

            val cardLayout = LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(28, 22, 28, 22)
            }

            // Top row: Category badge & Date
            val topRow = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }

            val catBadgeDrawable = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = 14f
                setColor(Color.parseColor("#22FACC15"))
            }

            val tvCategory = TextView(ctx).apply {
                text = category.uppercase(Locale.ROOT)
                setTextColor(colorYellow)
                textSize = 10.5f
                setTypeface(null, Typeface.BOLD)
                setPadding(16, 6, 16, 6)
                background = catBadgeDrawable
            }

            val tvDate = TextView(ctx).apply {
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                text = "📅 $date"
                setTextColor(colorTextMuted)
                textSize = 11.5f
                gravity = Gravity.END
            }

            topRow.addView(tvCategory)
            topRow.addView(tvDate)
            cardLayout.addView(topRow)

            // Amount row
            val tvAmount = TextView(ctx).apply {
                text = "- ${fmt.format(amount)}"
                setTextColor(colorRed)
                textSize = 17f
                setTypeface(null, Typeface.BOLD)
                setPadding(0, 10, 0, 4)
            }
            cardLayout.addView(tvAmount)

            // Description / notes
            if (description.isNotBlank()) {
                val tvDesc = TextView(ctx).apply {
                    text = description
                    setTextColor(colorTextWhite)
                    textSize = 13f
                    setPadding(0, 2, 0, 4)
                }
                cardLayout.addView(tvDesc)
            }

            // Vendor / Method footer
            val extras = mutableListOf<String>()
            if (vendor.isNotBlank()) extras.add("Vendor: $vendor")
            if (paymentMethod.isNotBlank()) extras.add("Metode: $paymentMethod")

            if (extras.isNotEmpty()) {
                val tvExtras = TextView(ctx).apply {
                    text = extras.joinToString(" • ")
                    setTextColor(colorTextMuted)
                    textSize = 11f
                    setPadding(0, 2, 0, 0)
                }
                cardLayout.addView(tvExtras)
            }

            card.addView(cardLayout)
            container.addView(card)
        }
    }

    private fun showAddExpenseDialog() {
        val ctx = context ?: return

        val layout = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(50, 30, 50, 10)
        }

        val defaultCats = listOf("Operasional", "Bandwidth", "Gaji & Komisi", "Listrik & Server", "Perangkat & Alat", "Perbaikan", "Lain-lain")
        val combinedCats = (categoriesList + defaultCats).distinct().filter { it.isNotBlank() }

        val tvLabelCat = TextView(ctx).apply {
            text = "Kategori Pengeluaran:"
            setTextColor(colorTextMuted)
            textSize = 12f
            setPadding(0, 0, 0, 4)
        }
        val spinnerCat = Spinner(ctx)
        val adapter = ArrayAdapter(ctx, android.R.layout.simple_spinner_dropdown_item, combinedCats)
        spinnerCat.adapter = adapter

        val etAmount = EditText(ctx).apply {
            hint = "Nominal Biaya (Rp)"
            inputType = InputType.TYPE_CLASS_NUMBER
        }

        val todayStr = SimpleDateFormat("yyyy-MM-dd", Locale.ROOT).format(Date())
        val etDate = EditText(ctx).apply {
            hint = "Tanggal (YYYY-MM-DD)"
            setText(todayStr)
        }

        val etDesc = EditText(ctx).apply {
            hint = "Keterangan / Keperluan"
        }

        val etVendor = EditText(ctx).apply {
            hint = "Penerima / Vendor (Opsional)"
        }

        layout.addView(tvLabelCat)
        layout.addView(spinnerCat)
        layout.addView(etAmount)
        layout.addView(etDate)
        layout.addView(etDesc)
        layout.addView(etVendor)

        AlertDialog.Builder(ctx)
            .setTitle("💸 Catat Pengeluaran Baru")
            .setView(layout)
            .setPositiveButton("Simpan") { _, _ ->
                val category = spinnerCat.selectedItem?.toString() ?: "Operasional"
                val amountStr = etAmount.text.toString().trim()
                val dateStr = etDate.text.toString().trim().ifEmpty { todayStr }
                val descStr = etDesc.text.toString().trim()
                val vendorStr = etVendor.text.toString().trim()

                val amount = amountStr.toDoubleOrNull()
                if (amount == null || amount <= 0) {
                    Toast.makeText(ctx, "Nominal pengeluaran tidak valid", Toast.LENGTH_SHORT).show()
                    return@setPositiveButton
                }

                saveExpense(dateStr, category, amount, descStr, vendorStr)
            }
            .setNegativeButton("Batal", null)
            .show()
    }

    private fun saveExpense(date: String, category: String, amount: Double, description: String, vendor: String) {
        val ctx = context ?: return
        binding.swipeRefresh.isRefreshing = true

        lifecycleScope.launch {
            val url = "${getBaseUrl()}/api/customer/app/admin/expenses/create"
            val jsonBody = JSONObject().apply {
                put("date", date)
                put("category", category)
                put("amount", amount)
                put("description", description)
                put("vendor", vendor)
                put("payment_method", "cash")
            }

            val success = withContext(Dispatchers.IO) {
                try {
                    val mediaType = "application/json; charset=utf-8".toMediaType()
                    val reqBody = jsonBody.toString().toRequestBody(mediaType)
                    val req = Request.Builder()
                        .url(url)
                        .addHeader("Authorization", "Bearer ${getToken()}")
                        .post(reqBody)
                        .build()
                    val resp = httpClient().newCall(req).execute()
                    resp.isSuccessful
                } catch (e: Exception) {
                    false
                }
            }

            if (success) {
                Toast.makeText(ctx, "Pengeluaran berhasil dicatat!", Toast.LENGTH_SHORT).show()
                loadExpenses()
            } else {
                binding.swipeRefresh.isRefreshing = false
                Toast.makeText(ctx, "Gagal mencatat pengeluaran", Toast.LENGTH_SHORT).show()
            }
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
            text = "💸"
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
