package com.alijaya.customer.ui.admin

import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Bundle
import android.print.PrintAttributes
import android.print.PrintManager
import android.text.InputType
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.cardview.widget.CardView
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.alijaya.customer.CustomerApplication
import com.alijaya.customer.databinding.FragmentAdminVouchersBinding
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

class AdminVouchersFragment : Fragment() {

    private var _binding: FragmentAdminVouchersBinding? = null
    private val binding get() = _binding!!

    private val colorBgDark = Color.parseColor("#0F172A")
    private val colorCardDark = Color.parseColor("#1E293B")
    private val colorCardInner = Color.parseColor("#0F172A")
    private val colorTextWhite = Color.parseColor("#FFFFFF")
    private val colorTextMuted = Color.parseColor("#94A3B8")
    private val colorAccent = Color.parseColor("#38BDF8")
    private val colorGreen = Color.parseColor("#4ADE80")
    private val colorYellow = Color.parseColor("#FACC15")
    private val colorRed = Color.parseColor("#EF4444")
    private val colorBlue = Color.parseColor("#3B82F6")

    private val batchesList = mutableListOf<JSONObject>()
    private var totalVouchersCount = 0
    private var unsoldVouchersCount = 0

    // Options cache
    private var cachedRouters = JSONArray()
    private var cachedProfiles = JSONArray()
    private var cachedCompanyName = "ISP NETWORK"
    private var cachedCompanyPhone = ""
    private var cachedHotspotDns = ""
    private var cachedDefaultComment = "vc-admin"

    private fun httpClient() = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
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
        _binding = FragmentAdminVouchersBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        binding.swipeRefresh.setColorSchemeColors(colorAccent, colorBlue, colorGreen)
        binding.swipeRefresh.setProgressBackgroundColorSchemeColor(colorCardDark)

        binding.swipeRefresh.setOnRefreshListener {
            loadVouchers()
        }

        binding.btnCreateVoucher.setOnClickListener {
            showCreateVoucherDialog()
        }

        loadVouchers()
    }

    private fun loadVouchers() {
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
            val url = "${getBaseUrl()}/api/customer/app/admin/vouchers"
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
                        totalVouchersCount = data.optInt("totalVouchers", 0)
                        unsoldVouchersCount = data.optInt("unsold", 0)

                        val bArr = data.optJSONArray("batches") ?: JSONArray()
                        batchesList.clear()
                        for (i in 0 until bArr.length()) {
                            batchesList.add(bArr.getJSONObject(i))
                        }

                        renderVouchers()
                        return@launch
                    }
                } catch (e: Exception) {
                    // Fallthrough
                }
            }

            renderEmptyState("Gagal memuat data voucher hotspot.")
            if (isAdded) {
                Toast.makeText(ctx, "Gagal memuat data voucher", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun renderVouchers() {
        val ctx = context ?: return
        val container = binding.contentContainer
        container.removeAllViews()

        val fmt = NumberFormat.getCurrencyInstance(Locale("id", "ID"))
        fmt.maximumFractionDigits = 0

        val soldCount = (totalVouchersCount - unsoldVouchersCount).coerceAtLeast(0)

        // 1. Summary Card
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

        val tvTitle = TextView(ctx).apply {
            text = "🎫 Manajemen Voucher Hotspot"
            setTextColor(colorTextWhite)
            textSize = 17f
            setTypeface(null, Typeface.BOLD)
            setPadding(0, 0, 0, 16)
        }
        summaryLayout.addView(tvTitle)

        val statsRow = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            weightSum = 3f
        }

        statsRow.addView(createStatBox(ctx, "Total Cetak", "$totalVouchersCount", colorAccent, Color.parseColor("#1538BDF8"), 0, 4))
        statsRow.addView(createStatBox(ctx, "Terjual", "$soldCount", colorGreen, Color.parseColor("#154ADE80"), 4, 4))
        statsRow.addView(createStatBox(ctx, "Sisa Stok", "$unsoldVouchersCount", colorYellow, Color.parseColor("#15FACC15"), 4, 0))

        summaryLayout.addView(statsRow)
        summaryCard.addView(summaryLayout)
        container.addView(summaryCard)

        // Section Title
        val tvSection = TextView(ctx).apply {
            text = "📦 Daftar Batch Voucher (${batchesList.size})"
            setTextColor(colorTextWhite)
            textSize = 16f
            setTypeface(null, Typeface.BOLD)
            setPadding(8, 6, 0, 14)
        }
        container.addView(tvSection)

        if (batchesList.isEmpty()) {
            renderEmptyState("Belum ada batch voucher yang dicetak. Tekan tombol \"➕ Buat Voucher\" di atas untuk memulai.")
            return
        }

        // List Batches
        for (batch in batchesList) {
            val batchId = batch.optInt("batch_id", 0)
            val profileName = batch.optString("profile_name", "Voucher Hotspot")
            val price = batch.optDouble("price", 0.0)
            val priceFormatted = fmt.format(price)
            val validity = batch.optString("validity", "-")
            val totalCount = batch.optInt("total_count", 0)
            val batchSoldCount = batch.optInt("sold_count", 0)
            val createdAt = batch.optString("created_at", "-")

            val card = CardView(ctx).apply {
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                ).apply {
                    setMargins(0, 0, 0, 18)
                }
                radius = 20f
                cardElevation = 3f
                setCardBackgroundColor(colorCardDark)
            }

            val cardLayout = LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(26, 20, 26, 20)
            }

            // Top Row: Profile Name & Batch ID Badge
            val topRow = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }

            val tvProfile = TextView(ctx).apply {
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                text = "🎟️ $profileName"
                setTextColor(colorTextWhite)
                textSize = 15.5f
                setTypeface(null, Typeface.BOLD)
            }

            val batchBadgeDrawable = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = 14f
                setColor(Color.parseColor("#2238BDF8"))
            }

            val tvBatchBadge = TextView(ctx).apply {
                text = "Batch #$batchId"
                setTextColor(colorAccent)
                textSize = 11f
                setTypeface(null, Typeface.BOLD)
                setPadding(16, 6, 16, 6)
                background = batchBadgeDrawable
            }

            topRow.addView(tvProfile)
            topRow.addView(tvBatchBadge)
            cardLayout.addView(topRow)

            // Price & Validity Row
            val priceRow = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(0, 8, 0, 8)
            }

            val tvPrice = TextView(ctx).apply {
                text = priceFormatted
                setTextColor(colorGreen)
                textSize = 16f
                setTypeface(null, Typeface.BOLD)
            }

            val tvValidity = TextView(ctx).apply {
                text = " • ⏱️ $validity"
                setTextColor(colorTextMuted)
                textSize = 12f
                setPadding(4, 0, 0, 0)
            }

            priceRow.addView(tvPrice)
            priceRow.addView(tvValidity)
            cardLayout.addView(priceRow)

            // Progress Bar
            val percent = if (totalCount > 0) ((batchSoldCount.toDouble() / totalCount) * 100).toInt() else 0
            val tvProgress = TextView(ctx).apply {
                text = "Terjual: $batchSoldCount / $totalCount voucher ($percent%)"
                setTextColor(colorTextMuted)
                textSize = 11.5f
            }
            cardLayout.addView(tvProgress)
            cardLayout.addView(createProgressBar(ctx, percent, colorGreen))

            // Footer Created At
            val tvDate = TextView(ctx).apply {
                text = "📅 Dibuat: $createdAt"
                setTextColor(colorTextMuted)
                textSize = 11f
                setPadding(0, 2, 0, 12)
            }
            cardLayout.addView(tvDate)

            // ACTION BUTTONS ROW (Print A4, Bluetooth Thermal, Copy, Delete)
            val actionRow = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(0, 4, 0, 0)
            }

            // 1. Button Cetak / PDF A4
            val btnPrintA4 = Button(ctx).apply {
                layoutParams = LinearLayout.LayoutParams(0, 76, 1f).apply {
                    setMargins(0, 0, 6, 0)
                }
                text = "📄 PDF A4"
                textSize = 11f
                setTypeface(null, Typeface.BOLD)
                setTextColor(colorTextWhite)
                background = GradientDrawable().apply {
                    cornerRadius = 14f
                    setColor(Color.parseColor("#2563EB"))
                }
                setOnClickListener {
                    printBatchA4(batchId)
                }
            }

            // 2. Button Cetak Bluetooth Bersambung
            val btnPrintThermal = Button(ctx).apply {
                layoutParams = LinearLayout.LayoutParams(0, 76, 1f).apply {
                    setMargins(3, 0, 3, 0)
                }
                text = "🖨️ Thermal"
                textSize = 11f
                setTypeface(null, Typeface.BOLD)
                setTextColor(colorTextWhite)
                background = GradientDrawable().apply {
                    cornerRadius = 14f
                    setColor(Color.parseColor("#059669"))
                }
                setOnClickListener {
                    showPrintBatchThermalDialog(batchId, profileName, priceFormatted, validity)
                }
            }

            // 3. Button Salin Kode
            val btnCopy = Button(ctx).apply {
                layoutParams = LinearLayout.LayoutParams(0, 76, 0.8f).apply {
                    setMargins(3, 0, 3, 0)
                }
                text = "📋 Salin"
                textSize = 11f
                setTypeface(null, Typeface.BOLD)
                setTextColor(colorTextWhite)
                background = GradientDrawable().apply {
                    cornerRadius = 14f
                    setColor(Color.parseColor("#475569"))
                }
                setOnClickListener {
                    copyBatchCodes(batchId)
                }
            }

            // 4. Button Hapus Batch
            val btnDelete = Button(ctx).apply {
                layoutParams = LinearLayout.LayoutParams(0, 76, 0.7f).apply {
                    setMargins(6, 0, 0, 0)
                }
                text = "🗑️"
                textSize = 13f
                setTextColor(colorRed)
                background = GradientDrawable().apply {
                    cornerRadius = 14f
                    setColor(Color.parseColor("#25EF4444"))
                }
                setOnClickListener {
                    confirmDeleteBatch(batchId, profileName)
                }
            }

            actionRow.addView(btnPrintA4)
            actionRow.addView(btnPrintThermal)
            actionRow.addView(btnCopy)
            actionRow.addView(btnDelete)
            cardLayout.addView(actionRow)

            card.addView(cardLayout)
            container.addView(card)
        }
    }

    // ─── CREATE VOUCHER DIALOG (SINGLE & BATCH) ─────────────────────────────
    private fun showCreateVoucherDialog() {
        val ctx = context ?: return

        val loadingDialog = AlertDialog.Builder(ctx)
            .setMessage("Mengambil profile MikroTik...")
            .setCancelable(false)
            .create()
        loadingDialog.setOnShowListener {
            loadingDialog.window?.setBackgroundDrawable(createDialogBackground())
            loadingDialog.findViewById<TextView>(android.R.id.message)?.setTextColor(Color.WHITE)
        }
        loadingDialog.show()

        lifecycleScope.launch {
            val url = "${getBaseUrl()}/api/customer/app/admin/vouchers/options"
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

            loadingDialog.dismiss()

            if (responseStr == null) {
                Toast.makeText(ctx, "Gagal mengambil data dari server", Toast.LENGTH_SHORT).show()
                return@launch
            }

            try {
                val json = JSONObject(responseStr)
                val data = json.optJSONObject("data")
                if (data == null) {
                    Toast.makeText(ctx, "Respon server tidak valid", Toast.LENGTH_SHORT).show()
                    return@launch
                }

                cachedRouters = data.optJSONArray("routers") ?: JSONArray()
                cachedProfiles = data.optJSONArray("profiles") ?: JSONArray()
                cachedCompanyName = data.optString("companyName", "ISP NETWORK")
                cachedCompanyPhone = data.optString("companyPhone", "")
                cachedHotspotDns = data.optString("hotspotDns", "").trim().let { if (it == "wifi.id") "" else it }
                cachedDefaultComment = data.optString("defaultComment", "vc-admin")

                if (cachedProfiles.length() == 0) {
                    Toast.makeText(ctx, "Tidak ada User Profile Hotspot di MikroTik", Toast.LENGTH_LONG).show()
                    return@launch
                }

                renderCreateVoucherModal()
            } catch (e: Exception) {
                Toast.makeText(ctx, "Error: ${e.message}", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun renderCreateVoucherModal() {
        val ctx = context ?: return

        val scroll = ScrollView(ctx).apply {
            setPadding(32, 20, 32, 16)
        }
        val layout = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
        }
        scroll.addView(layout)

        // Containers for Single vs Batch
        val singleContainer = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
        }
        val batchContainer = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
        }

        // Mode Switch (Single vs Batch) Segmented Tabs
        layout.addView(createFieldLabel(ctx, "Tipe Pembuatan Voucher:"))

        var isBatchMode = false

        val tabModeContainer = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply {
                setMargins(0, 4, 0, 14)
            }
            background = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = 16f
                setColor(Color.parseColor("#0F172A"))
                setStroke(2, Color.parseColor("#334155"))
            }
            setPadding(6, 6, 6, 6)
        }

        val btnTabSingle = TextView(ctx).apply {
            text = "🎯 Satuan (1 Voucher)"
            textSize = 13f
            setTypeface(null, Typeface.BOLD)
            gravity = Gravity.CENTER
            setPadding(16, 22, 16, 22)
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }

        val btnTabBatch = TextView(ctx).apply {
            text = "📦 Banyak (Batch)"
            textSize = 13f
            setTypeface(null, Typeface.BOLD)
            gravity = Gravity.CENTER
            setPadding(16, 22, 16, 22)
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }

        fun updateModeTabs() {
            if (!isBatchMode) {
                btnTabSingle.setTextColor(Color.WHITE)
                btnTabSingle.background = GradientDrawable().apply {
                    shape = GradientDrawable.RECTANGLE
                    cornerRadius = 12f
                    setColor(Color.parseColor("#2563EB"))
                }
                btnTabBatch.setTextColor(Color.parseColor("#94A3B8"))
                btnTabBatch.background = null

                singleContainer.visibility = View.VISIBLE
                batchContainer.visibility = View.GONE
            } else {
                btnTabBatch.setTextColor(Color.WHITE)
                btnTabBatch.background = GradientDrawable().apply {
                    shape = GradientDrawable.RECTANGLE
                    cornerRadius = 12f
                    setColor(Color.parseColor("#2563EB"))
                }
                btnTabSingle.setTextColor(Color.parseColor("#94A3B8"))
                btnTabSingle.background = null

                singleContainer.visibility = View.GONE
                batchContainer.visibility = View.VISIBLE
            }
        }

        btnTabSingle.setOnClickListener {
            if (isBatchMode) {
                isBatchMode = false
                updateModeTabs()
            }
        }

        btnTabBatch.setOnClickListener {
            if (!isBatchMode) {
                isBatchMode = true
                updateModeTabs()
            }
        }

        tabModeContainer.addView(btnTabSingle)
        tabModeContainer.addView(btnTabBatch)
        layout.addView(tabModeContainer)
        updateModeTabs()

        // Profile MikroTik Selector
        layout.addView(createFieldLabel(ctx, "Pilih Hotspot Profile (MikroTik):"))

        val profileNames = mutableListOf<String>()
        for (i in 0 until cachedProfiles.length()) {
            val p = cachedProfiles.getJSONObject(i)
            val name = p.optString("name", "")
            val price = p.optDouble("price", 0.0)
            val valText = p.optString("validity", "")
            val priceStr = if (price > 0) " - Rp " + NumberFormat.getNumberInstance(Locale("id", "ID")).format(price) else ""
            val durStr = if (valText.isNotEmpty()) " ($valText)" else ""
            profileNames.add("$name$priceStr$durStr")
        }

        val spProfile = Spinner(ctx).apply {
            background = createInputBackground()
            setPadding(16, 16, 16, 16)
            adapter = createDarkSpinnerAdapter(ctx, profileNames)
        }
        layout.addView(spProfile)

        // Price & Validity inputs
        layout.addView(createFieldLabel(ctx, "Harga Jual (Rp):"))

        val etPrice = EditText(ctx).apply {
            background = createInputBackground()
            setTextColor(colorTextWhite)
            inputType = InputType.TYPE_CLASS_NUMBER
            setPadding(24, 20, 24, 20)
            hint = "Contoh: 5000"
            setHintTextColor(Color.parseColor("#64748B"))
            textSize = 13.5f
        }
        layout.addView(etPrice)

        layout.addView(createFieldLabel(ctx, "Masa Aktif / Limit Waktu (Contoh: 2h, 1d, 30d):"))

        val etValidity = EditText(ctx).apply {
            background = createInputBackground()
            setTextColor(colorTextWhite)
            setPadding(24, 20, 24, 20)
            hint = "Contoh: 1d atau 2h"
            setHintTextColor(Color.parseColor("#64748B"))
            textSize = 13.5f
        }
        layout.addView(etValidity)

        // Comment MikroTik
        layout.addView(createFieldLabel(ctx, "Komentar MikroTik (Comment):"))

        val etComment = EditText(ctx).apply {
            background = createInputBackground()
            setTextColor(colorTextWhite)
            setPadding(24, 20, 24, 20)
            setText(cachedDefaultComment)
            hint = "Contoh: vc-admin-12.09.26"
            setHintTextColor(Color.parseColor("#64748B"))
            textSize = 13.5f
        }
        layout.addView(etComment)

        // Listener to auto-fill price and validity when profile changed
        spProfile.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                if (position in 0 until cachedProfiles.length()) {
                    val p = cachedProfiles.getJSONObject(position)
                    val pr = p.optDouble("price", 0.0)
                    val valText = p.optString("validity", "")
                    if (pr > 0) etPrice.setText(pr.toInt().toString())
                    if (valText.isNotEmpty()) etValidity.setText(valText)
                }
            }
            override fun onNothingSelected(parent: AdapterView<*>?) {}
        }

        // ── POPULATE SINGLE MODE FIELDS ─────────────────────────────
        singleContainer.addView(createFieldLabel(ctx, "Metode Kode Voucher:"))

        var isSingleManual = false

        val tabSingleMethod = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply {
                setMargins(0, 4, 0, 10)
            }
            background = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = 14f
                setColor(Color.parseColor("#0F172A"))
                setStroke(2, Color.parseColor("#334155"))
            }
            setPadding(5, 5, 5, 5)
        }

        val btnTabAuto = TextView(ctx).apply {
            text = "⚡ Otomatis"
            textSize = 12.5f
            setTypeface(null, Typeface.BOLD)
            gravity = Gravity.CENTER
            setPadding(12, 18, 12, 18)
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }

        val btnTabManual = TextView(ctx).apply {
            text = "✏️ Manual (User & Pass)"
            textSize = 12.5f
            setTypeface(null, Typeface.BOLD)
            gravity = Gravity.CENTER
            setPadding(12, 18, 12, 18)
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }

        // Manual Fields
        val manualContainer = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
        }

        val tvUserLabel = createFieldLabel(ctx, "Username / Kode Voucher:")
        val etUser = EditText(ctx).apply {
            background = createInputBackground()
            setTextColor(colorTextWhite)
            setPadding(24, 20, 24, 20)
            hint = "Masukkan username voucher"
            setHintTextColor(Color.parseColor("#64748B"))
            textSize = 13.5f
        }
        val tvPassLabel = createFieldLabel(ctx, "Password (Opsional, kosongkan jika = username):")
        val etPass = EditText(ctx).apply {
            background = createInputBackground()
            setTextColor(colorTextWhite)
            setPadding(24, 20, 24, 20)
            hint = "Sama dengan username jika kosong"
            setHintTextColor(Color.parseColor("#64748B"))
            textSize = 13.5f
        }
        manualContainer.addView(tvUserLabel)
        manualContainer.addView(etUser)
        manualContainer.addView(tvPassLabel)
        manualContainer.addView(etPass)

        fun updateSingleMethodTabs() {
            if (!isSingleManual) {
                btnTabAuto.setTextColor(Color.WHITE)
                btnTabAuto.background = GradientDrawable().apply {
                    shape = GradientDrawable.RECTANGLE
                    cornerRadius = 10f
                    setColor(Color.parseColor("#0284C7"))
                }
                btnTabManual.setTextColor(Color.parseColor("#94A3B8"))
                btnTabManual.background = null
                manualContainer.visibility = View.GONE
            } else {
                btnTabManual.setTextColor(Color.WHITE)
                btnTabManual.background = GradientDrawable().apply {
                    shape = GradientDrawable.RECTANGLE
                    cornerRadius = 10f
                    setColor(Color.parseColor("#0284C7"))
                }
                btnTabAuto.setTextColor(Color.parseColor("#94A3B8"))
                btnTabAuto.background = null
                manualContainer.visibility = View.VISIBLE
            }
        }

        btnTabAuto.setOnClickListener {
            if (isSingleManual) {
                isSingleManual = false
                updateSingleMethodTabs()
            }
        }

        btnTabManual.setOnClickListener {
            if (!isSingleManual) {
                isSingleManual = true
                updateSingleMethodTabs()
            }
        }

        tabSingleMethod.addView(btnTabAuto)
        tabSingleMethod.addView(btnTabManual)
        singleContainer.addView(tabSingleMethod)
        updateSingleMethodTabs()

        singleContainer.addView(manualContainer)

        // Buyer Phone (for WhatsApp)
        val tvBuyerPhone = createFieldLabel(ctx, "No. WhatsApp Pembeli (Opsional untuk kirim WA):")
        val etBuyerPhone = EditText(ctx).apply {
            background = createInputBackground()
            setTextColor(colorTextWhite)
            inputType = InputType.TYPE_CLASS_PHONE
            setPadding(24, 20, 24, 20)
            hint = "Contoh: 081234567890"
            setHintTextColor(Color.parseColor("#64748B"))
            textSize = 13.5f
        }
        singleContainer.addView(tvBuyerPhone)
        singleContainer.addView(etBuyerPhone)

        layout.addView(singleContainer)

        // ── POPULATE BATCH MODE FIELDS ──────────────────────────────
        val tvQtyLabel = createFieldLabel(ctx, "Jumlah Voucher (Qty):")
        val etQty = EditText(ctx).apply {
            background = createInputBackground()
            setTextColor(colorTextWhite)
            inputType = InputType.TYPE_CLASS_NUMBER
            setPadding(24, 20, 24, 20)
            setText("50")
            textSize = 13.5f
        }
        batchContainer.addView(tvQtyLabel)
        batchContainer.addView(etQty)

        val tvPrefixLabel = createFieldLabel(ctx, "Prefix Kode (Opsional):")
        val etPrefix = EditText(ctx).apply {
            background = createInputBackground()
            setTextColor(colorTextWhite)
            setPadding(24, 20, 24, 20)
            hint = "Contoh: VC"
            setHintTextColor(Color.parseColor("#64748B"))
            textSize = 13.5f
        }
        batchContainer.addView(tvPrefixLabel)
        batchContainer.addView(etPrefix)

        val tvCodeLenLabel = createFieldLabel(ctx, "Panjang Karakter Kode:")
        val spCodeLen = Spinner(ctx).apply {
            background = createInputBackground()
            setPadding(16, 16, 16, 16)
            adapter = createDarkSpinnerAdapter(ctx, listOf("4 Karakter", "5 Karakter", "6 Karakter", "7 Karakter", "8 Karakter"))
            setSelection(2) // 6 karakter default
        }
        batchContainer.addView(tvCodeLenLabel)
        batchContainer.addView(spCodeLen)

        val tvCharsetLabel = createFieldLabel(ctx, "Kombinasi Karakter:")
        val spCharset = Spinner(ctx).apply {
            background = createInputBackground()
            setPadding(16, 16, 16, 16)
            adapter = createDarkSpinnerAdapter(ctx, listOf("Angka Saja (123456)", "Huruf Kecil & Angka (ab12cd)", "Huruf Besar & Angka (AB12CD)"))
            setSelection(0)
        }
        batchContainer.addView(tvCharsetLabel)
        batchContainer.addView(spCharset)

        val tvBatchMode = createFieldLabel(ctx, "Format Login:")
        val spMode = Spinner(ctx).apply {
            background = createInputBackground()
            setPadding(16, 16, 16, 16)
            adapter = createDarkSpinnerAdapter(ctx, listOf("Username = Password (Voucher)", "Username & Password Berbeda (Member)"))
            setSelection(0)
        }
        batchContainer.addView(tvBatchMode)
        batchContainer.addView(spMode)

        layout.addView(batchContainer)

        // Trigger initial profile selection filling
        if (cachedProfiles.length() > 0) {
            val p0 = cachedProfiles.getJSONObject(0)
            val pr = p0.optDouble("price", 0.0)
            val vt = p0.optString("validity", "")
            if (pr > 0) etPrice.setText(pr.toInt().toString())
            if (vt.isNotEmpty()) etValidity.setText(vt)
        }

        val dialog = AlertDialog.Builder(ctx)
            .setCustomTitle(createCustomDialogHeader(ctx, "➕ Buat Voucher Hotspot"))
            .setView(scroll)
            .setPositiveButton("Simpan & Buat", null)
            .setNegativeButton("Batal", null)
            .create()

        dialog.setOnShowListener {
            styleDialog(dialog, positiveColor = colorAccent, negativeColor = colorTextMuted)
            val btnPositive = dialog.getButton(AlertDialog.BUTTON_POSITIVE)
            btnPositive.setOnClickListener {
                val selProfileIdx = spProfile.selectedItemPosition
                if (selProfileIdx < 0 || selProfileIdx >= cachedProfiles.length()) {
                    Toast.makeText(ctx, "Pilih profile terlebih dahulu", Toast.LENGTH_SHORT).show()
                    return@setOnClickListener
                }
                val selectedProfile = cachedProfiles.getJSONObject(selProfileIdx).optString("name", "")
                val priceVal = etPrice.text.toString().trim().toDoubleOrNull() ?: 0.0
                val validityVal = etValidity.text.toString().trim()

                if (!isBatchMode) {
                    // Single voucher creation
                    val u = if (isSingleManual) etUser.text.toString().trim() else ""
                    val p = if (isSingleManual) etPass.text.toString().trim() else ""
                    val buyerPhone = etBuyerPhone.text.toString().trim()

                    if (isSingleManual && u.isEmpty()) {
                        Toast.makeText(ctx, "Username manual wajib diisi", Toast.LENGTH_SHORT).show()
                        return@setOnClickListener
                    }

                    val commentVal = etComment.text.toString().trim()
                    dialog.dismiss()
                    executeCreateSingleVoucher(selectedProfile, priceVal, validityVal, u, p, buyerPhone, commentVal)
                } else {
                    // Batch voucher creation
                    val qty = etQty.text.toString().trim().toIntOrNull() ?: 0
                    if (qty <= 0) {
                        Toast.makeText(ctx, "Jumlah voucher minimal 1", Toast.LENGTH_SHORT).show()
                        return@setOnClickListener
                    }
                    val prefix = etPrefix.text.toString().trim()
                    val len = spCodeLen.selectedItemPosition + 4 // 4 to 8
                    val charset = when (spCharset.selectedItemPosition) {
                        1 -> "alphanumeric_lower"
                        2 -> "alphanumeric_upper"
                        else -> "numbers"
                    }
                    val mode = if (spMode.selectedItemPosition == 1) "member" else "voucher"
                    val commentVal = etComment.text.toString().trim()

                    dialog.dismiss()
                    executeCreateBatchVouchers(selectedProfile, qty, prefix, len, charset, mode, priceVal, validityVal, commentVal)
                }
            }
        }

        dialog.show()
    }

    private fun executeCreateSingleVoucher(
        profile: String,
        price: Double,
        validity: String,
        username: String,
        password: String,
        buyerPhone: String,
        comment: String = ""
    ) {
        val ctx = context ?: return
        val progress = AlertDialog.Builder(ctx)
            .setMessage("Membuat voucher & mendaftarkan ke MikroTik...")
            .setCancelable(false)
            .create()
        progress.setOnShowListener {
            progress.window?.setBackgroundDrawable(createDialogBackground())
            progress.findViewById<TextView>(android.R.id.message)?.setTextColor(Color.WHITE)
        }
        progress.show()

        lifecycleScope.launch {
            val url = "${getBaseUrl()}/api/customer/app/admin/vouchers/create-single"
            val payload = JSONObject().apply {
                put("profile", profile)
                put("price", price)
                put("validity", validity)
                if (username.isNotEmpty()) put("username", username)
                if (password.isNotEmpty()) put("password", password)
                if (buyerPhone.isNotEmpty()) put("buyerPhone", buyerPhone)
                if (comment.isNotEmpty()) put("comment", comment)
            }

            val resultStr = withContext(Dispatchers.IO) {
                try {
                    val mediaType = "application/json; charset=utf-8".toMediaType()
                    val body = payload.toString().toRequestBody(mediaType)
                    val req = Request.Builder()
                        .url(url)
                        .addHeader("Authorization", "Bearer ${getToken()}")
                        .post(body)
                        .build()
                    val resp = httpClient().newCall(req).execute()
                    resp.body?.string()
                } catch (e: Exception) {
                    null
                }
            }

            progress.dismiss()

            if (resultStr != null) {
                try {
                    val json = JSONObject(resultStr)
                    if (json.optBoolean("success", false)) {
                        val vData = json.optJSONObject("data")
                        loadVouchers() // Refresh list in background
                        if (vData != null) {
                            showSingleVoucherSuccessDialog(vData)
                        } else {
                            Toast.makeText(ctx, json.optString("message", "Voucher berhasil dibuat!"), Toast.LENGTH_LONG).show()
                        }
                        return@launch
                    } else {
                        Toast.makeText(ctx, json.optString("message", "Gagal membuat voucher"), Toast.LENGTH_LONG).show()
                        return@launch
                    }
                } catch (e: Exception) {
                    // Fallthrough
                }
            }

            Toast.makeText(ctx, "Gagal menghubungi server MikroTik", Toast.LENGTH_SHORT).show()
        }
    }

    private fun showSingleVoucherSuccessDialog(vData: JSONObject) {
        val ctx = context ?: return

        val code = vData.optString("code", "")
        val pass = vData.optString("password", code)
        val profile = vData.optString("profile", "")
        val priceFormatted = vData.optString("priceFormatted", "")
        val validity = vData.optString("validity", "-")
        val buyerPhone = vData.optString("buyerPhone", "")
        val companyName = vData.optString("companyName", cachedCompanyName)
        val companyPhone = vData.optString("companyPhone", cachedCompanyPhone)
        val hotspotDns = vData.optString("hotspotDns", cachedHotspotDns).trim().let { if (it == "wifi.id") "" else it }

        val isSame = code == pass

        val layout = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 20, 32, 20)
        }

        // Voucher Preview Card
        val previewCard = CardView(ctx).apply {
            radius = 16f
            setCardBackgroundColor(colorCardDark)
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply {
                setMargins(0, 0, 0, 20)
            }
        }

        val cardLayout = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(24, 20, 24, 20)
        }

        val tvComp = TextView(ctx).apply {
            text = "🏢 $companyName"
            setTextColor(colorAccent)
            textSize = 14f
            setTypeface(null, Typeface.BOLD)
            gravity = Gravity.CENTER
        }
        val tvPkg = TextView(ctx).apply {
            text = "Paket: $profile • $priceFormatted"
            setTextColor(colorGreen)
            textSize = 15f
            setTypeface(null, Typeface.BOLD)
            gravity = Gravity.CENTER
            setPadding(0, 4, 0, 0)
        }
        val tvVal = TextView(ctx).apply {
            text = "Masa Aktif: $validity"
            setTextColor(colorTextMuted)
            textSize = 12f
            gravity = Gravity.CENTER
            setPadding(0, 2, 0, 12)
        }

        val codeBox = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            background = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = 12f
                setColor(colorCardInner)
            }
            setPadding(20, 16, 20, 16)
        }

        if (isSame) {
            val tvCodePrompt = TextView(ctx).apply {
                text = "KODE LOGIN VOUCHER"
                setTextColor(colorTextMuted)
                textSize = 11f
                gravity = Gravity.CENTER
            }
            val tvCodeVal = TextView(ctx).apply {
                text = code
                setTextColor(colorAccent)
                textSize = 24f
                setTypeface(null, Typeface.BOLD)
                gravity = Gravity.CENTER
                setPadding(0, 4, 0, 0)
            }
            codeBox.addView(tvCodePrompt)
            codeBox.addView(tvCodeVal)
        } else {
            val tvU = TextView(ctx).apply {
                text = "Username: $code"
                setTextColor(colorAccent)
                textSize = 17f
                setTypeface(null, Typeface.BOLD)
            }
            val tvP = TextView(ctx).apply {
                text = "Password: $pass"
                setTextColor(colorYellow)
                textSize = 17f
                setTypeface(null, Typeface.BOLD)
                setPadding(0, 4, 0, 0)
            }
            codeBox.addView(tvU)
            codeBox.addView(tvP)
        }

        cardLayout.addView(tvComp)
        cardLayout.addView(tvPkg)
        cardLayout.addView(tvVal)
        cardLayout.addView(codeBox)

        val hasDns = hotspotDns.isNotEmpty() && hotspotDns != "wifi.id"
        if (hasDns) {
            val tvLoginUrl = TextView(ctx).apply {
                text = "🌐 Login: http://$hotspotDns"
                setTextColor(colorTextMuted)
                textSize = 11.5f
                gravity = Gravity.CENTER
                setPadding(0, 12, 0, 0)
            }
            cardLayout.addView(tvLoginUrl)
        }

        previewCard.addView(cardLayout)
        layout.addView(previewCard)

        // Action Buttons: Print BT & WhatsApp
        val btnPrintBT = Button(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                88
            ).apply {
                setMargins(0, 0, 0, 10)
            }
            text = "🖨️ Cetak Struk Bluetooth"
            setTextColor(colorTextWhite)
            textSize = 13f
            setTypeface(null, Typeface.BOLD)
            background = GradientDrawable().apply {
                cornerRadius = 14f
                setColor(Color.parseColor("#059669"))
            }
            setOnClickListener {
                printSingleVoucherBT(companyName, profile, code, pass, priceFormatted, validity, companyPhone, hotspotDns)
            }
        }
        layout.addView(btnPrintBT)

        val btnSendWA = Button(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                88
            ).apply {
                setMargins(0, 0, 0, 10)
            }
            text = if (buyerPhone.isNotEmpty()) "💬 Kirim WhatsApp ($buyerPhone)" else "💬 Kirim via WhatsApp"
            setTextColor(colorTextWhite)
            textSize = 13f
            setTypeface(null, Typeface.BOLD)
            background = GradientDrawable().apply {
                cornerRadius = 14f
                setColor(Color.parseColor("#2563EB"))
            }
            setOnClickListener {
                promptSendWhatsApp(code, pass, profile, validity, priceFormatted, buyerPhone, companyName, hotspotDns, companyPhone)
            }
        }
        layout.addView(btnSendWA)

        val btnCopy = Button(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                80
            )
            text = "📋 Salin Teks Voucher"
            setTextColor(colorTextWhite)
            textSize = 12f
            background = GradientDrawable().apply {
                cornerRadius = 14f
                setColor(Color.parseColor("#334155"))
            }
            setOnClickListener {
                val clip = if (isSame) "Kode: $code | Paket: $profile | Harga: $priceFormatted" else "User: $code | Pass: $pass | Paket: $profile | Harga: $priceFormatted"
                val clipboard = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                clipboard.setPrimaryClip(ClipData.newPlainText("Voucher", clip))
                Toast.makeText(ctx, "Teks voucher disalin ke clipboard!", Toast.LENGTH_SHORT).show()
            }
        }
        layout.addView(btnCopy)

        val succDialog = AlertDialog.Builder(ctx)
            .setCustomTitle(createCustomDialogHeader(ctx, "🎉 Voucher Berhasil Dibuat!"))
            .setView(layout)
            .setPositiveButton("Selesai", null)
            .create()

        succDialog.setOnShowListener {
            styleDialog(succDialog, positiveColor = colorAccent)
        }
        succDialog.show()
    }

    private fun printSingleVoucherBT(
        companyName: String,
        profile: String,
        code: String,
        pass: String,
        priceFormatted: String,
        validity: String,
        contact: String,
        hotspotDns: String
    ) {
        val ctx = context ?: return
        val printers = BluetoothPrinterHelper.getPairedPrinters()
        if (printers.isEmpty()) {
            Toast.makeText(ctx, "Tidak ada printer bluetooth terpasang di HP ini. Pasangkan terlebih dahulu di Bluetooth Android.", Toast.LENGTH_LONG).show()
            return
        }

        if (printers.size == 1) {
            doPrintSingleVoucher(printers[0].address, false, companyName, profile, code, pass, priceFormatted, validity, contact, hotspotDns)
        } else {
            val names = printers.map { "${it.name} (${it.address})" }.toTypedArray()
            val printerDialog = AlertDialog.Builder(ctx)
                .setCustomTitle(createCustomDialogHeader(ctx, "Pilih Printer Thermal"))
                .setItems(names) { _, which ->
                    doPrintSingleVoucher(printers[which].address, false, companyName, profile, code, pass, priceFormatted, validity, contact, hotspotDns)
                }
                .setNegativeButton("Batal", null)
                .create()

            printerDialog.setOnShowListener {
                styleDialog(printerDialog)
            }
            printerDialog.show()
        }
    }

    private fun doPrintSingleVoucher(
        deviceAddress: String,
        is80mm: Boolean,
        companyName: String,
        packageName: String,
        voucherCode: String,
        voucherPass: String,
        priceFormatted: String,
        validity: String,
        contact: String,
        hotspotDns: String
    ) {
        val ctx = context ?: return
        Toast.makeText(ctx, "Mencetak voucher ke printer...", Toast.LENGTH_SHORT).show()

        lifecycleScope.launch {
            val res = BluetoothPrinterHelper.printVoucherTicket(
                deviceAddress = deviceAddress,
                is80mm = is80mm,
                companyName = companyName,
                packageName = packageName,
                voucherCode = voucherCode,
                voucherPass = voucherPass,
                priceFormatted = priceFormatted,
                validity = validity,
                contact = contact,
                hotspotDns = hotspotDns
            )
            if (res.isSuccess) {
                Toast.makeText(ctx, "Struk voucher berhasil dicetak!", Toast.LENGTH_SHORT).show()
            } else {
                Toast.makeText(ctx, "Gagal cetak: ${res.exceptionOrNull()?.message}", Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun executeCreateBatchVouchers(
        profile: String,
        qty: Int,
        prefix: String,
        codeLength: Int,
        charset: String,
        mode: String,
        price: Double,
        validity: String,
        comment: String = ""
    ) {
        val ctx = context ?: return
        val progress = AlertDialog.Builder(ctx)
            .setMessage("Membuat batch $qty voucher hotspot...")
            .setCancelable(false)
            .create()
        progress.setOnShowListener {
            progress.window?.setBackgroundDrawable(createDialogBackground())
            progress.findViewById<TextView>(android.R.id.message)?.setTextColor(Color.WHITE)
        }
        progress.show()

        lifecycleScope.launch {
            val url = "${getBaseUrl()}/api/customer/app/admin/vouchers/create-batch"
            val payload = JSONObject().apply {
                put("profile", profile)
                put("qty", qty)
                put("prefix", prefix)
                put("codeLength", codeLength)
                put("charset", charset)
                put("mode", mode)
                put("price", price)
                put("validity", validity)
                if (comment.isNotEmpty()) put("comment", comment)
            }

            val resultStr = withContext(Dispatchers.IO) {
                try {
                    val mediaType = "application/json; charset=utf-8".toMediaType()
                    val body = payload.toString().toRequestBody(mediaType)
                    val req = Request.Builder()
                        .url(url)
                        .addHeader("Authorization", "Bearer ${getToken()}")
                        .post(body)
                        .build()
                    val resp = httpClient().newCall(req).execute()
                    resp.body?.string()
                } catch (e: Exception) {
                    null
                }
            }

            progress.dismiss()

            if (resultStr != null) {
                try {
                    val json = JSONObject(resultStr)
                    if (json.optBoolean("success", false)) {
                        val batchData = json.optJSONObject("data")
                        val newBatchId = batchData?.optInt("batchId", 0) ?: 0
                        loadVouchers() // Reload list

                        val batchSuccessDialog = AlertDialog.Builder(ctx)
                            .setCustomTitle(createCustomDialogHeader(ctx, "🎉 Batch Berhasil Dibuat!"))
                            .setMessage("Batch #$newBatchId sebanyak $qty voucher berhasil disimpan dan sedang disinkronkan ke MikroTik.\n\nApakah ingin langsung cetak sekarang?")
                            .setPositiveButton("📄 Cetak A4 PDF") { _, _ ->
                                if (newBatchId > 0) printBatchA4(newBatchId)
                            }
                            .setNeutralButton("🖨️ Thermal Bersambung") { _, _ ->
                                if (newBatchId > 0) {
                                    val fmt = NumberFormat.getCurrencyInstance(Locale("id", "ID"))
                                    fmt.maximumFractionDigits = 0
                                    showPrintBatchThermalDialog(newBatchId, profile, fmt.format(price), validity)
                                }
                            }
                            .setNegativeButton("Nanti", null)
                            .create()

                        batchSuccessDialog.setOnShowListener {
                            styleDialog(batchSuccessDialog, positiveColor = Color.parseColor("#38BDF8"), neutralColor = Color.parseColor("#4ADE80"), negativeColor = colorTextMuted)
                            batchSuccessDialog.findViewById<TextView>(android.R.id.message)?.setTextColor(Color.parseColor("#E2E8F0"))
                        }
                        batchSuccessDialog.show()
                        return@launch
                    } else {
                        Toast.makeText(ctx, json.optString("message", "Gagal membuat batch"), Toast.LENGTH_LONG).show()
                        return@launch
                    }
                } catch (e: Exception) {
                    // Fallthrough
                }
            }

            Toast.makeText(ctx, "Gagal menghubungi server", Toast.LENGTH_SHORT).show()
        }
    }

    // ─── PRINT BATCH A4 VIA ANDROID PRINTMANAGER ────────────────────────────
    @SuppressLint("SetJavaScriptEnabled")
    private fun printBatchA4(batchId: Int) {
        val ctx = context ?: return
        val printUrl = "${getBaseUrl()}/api/customer/app/admin/vouchers/batch/$batchId/print?token=${getToken()}"

        val options = arrayOf("🖨️ Cetak / Simpan PDF A4 (Ala Mikhmon)", "🌐 Buka di Browser HP")
        val a4Dialog = AlertDialog.Builder(ctx)
            .setCustomTitle(createCustomDialogHeader(ctx, "Cetak / Export PDF A4"))
            .setItems(options) { _, which ->
                if (which == 0) {
                    val progress = AlertDialog.Builder(ctx)
                        .setMessage("Menyiapkan dokumen A4...")
                        .setCancelable(false)
                        .create()
                    progress.setOnShowListener {
                        progress.window?.setBackgroundDrawable(createDialogBackground())
                        progress.findViewById<TextView>(android.R.id.message)?.setTextColor(Color.WHITE)
                    }
                    progress.show()

                    val webView = WebView(ctx)
                    webView.settings.javaScriptEnabled = true
                    webView.webViewClient = object : WebViewClient() {
                        override fun onPageFinished(view: WebView?, url: String?) {
                            progress.dismiss()
                            try {
                                val printManager = ctx.getSystemService(Context.PRINT_SERVICE) as? PrintManager
                                val jobName = "Voucher-Hotspot-Batch-$batchId"
                                val printAdapter = webView.createPrintDocumentAdapter(jobName)
                                val printAttributes = PrintAttributes.Builder()
                                    .setMediaSize(PrintAttributes.MediaSize.ISO_A4)
                                    .build()
                                printManager?.print(jobName, printAdapter, printAttributes)
                            } catch (e: Exception) {
                                Toast.makeText(ctx, "Gagal membuka print dialog: ${e.message}", Toast.LENGTH_SHORT).show()
                            }
                        }
                    }
                    webView.loadUrl(printUrl)
                } else {
                    try {
                        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(printUrl))
                        startActivity(intent)
                    } catch (e: Exception) {
                        Toast.makeText(ctx, "Gagal membuka browser", Toast.LENGTH_SHORT).show()
                    }
                }
            }
            .setNegativeButton("Batal", null)
            .create()

        a4Dialog.setOnShowListener {
            styleDialog(a4Dialog)
        }
        a4Dialog.show()
    }

    // ─── CONTINUOUS THERMAL BLUETOOTH PRINTING FOR BATCH ────────────────────
    private fun showPrintBatchThermalDialog(
        batchId: Int,
        profileName: String,
        priceFormatted: String,
        validity: String
    ) {
        val ctx = context ?: return

        val printers = BluetoothPrinterHelper.getPairedPrinters()
        if (printers.isEmpty()) {
            Toast.makeText(ctx, "Belum ada printer thermal yang terpasang di HP. Pasangkan printer Bluetooth di pengaturan HP Anda terlebih dahulu.", Toast.LENGTH_LONG).show()
            return
        }

        val progress = AlertDialog.Builder(ctx)
            .setMessage("Mengambil data voucher batch #$batchId...")
            .setCancelable(false)
            .create()
        progress.setOnShowListener {
            progress.window?.setBackgroundDrawable(createDialogBackground())
            progress.findViewById<TextView>(android.R.id.message)?.setTextColor(Color.WHITE)
        }
        progress.show()

        lifecycleScope.launch {
            val url = "${getBaseUrl()}/api/customer/app/admin/vouchers/batch/$batchId/vouchers"
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

            progress.dismiss()

            if (responseStr == null) {
                Toast.makeText(ctx, "Gagal memuat data voucher untuk dicetak", Toast.LENGTH_SHORT).show()
                return@launch
            }

            try {
                val json = JSONObject(responseStr)
                val data = json.optJSONObject("data")
                val vArr = data?.optJSONArray("vouchers") ?: JSONArray()
                val companyName = data?.optString("companyName", cachedCompanyName) ?: cachedCompanyName
                val companyPhone = data?.optString("companyPhone", cachedCompanyPhone) ?: cachedCompanyPhone
                val hotspotDns = (data?.optString("hotspotDns", cachedHotspotDns) ?: cachedHotspotDns).trim().let { if (it == "wifi.id") "" else it }

                if (vArr.length() == 0) {
                    Toast.makeText(ctx, "Tidak ada voucher pada batch ini", Toast.LENGTH_SHORT).show()
                    return@launch
                }

                val allVouchers = mutableListOf<Pair<String, String>>()
                val unusedVouchers = mutableListOf<Pair<String, String>>()

                for (i in 0 until vArr.length()) {
                    val v = vArr.getJSONObject(i)
                    val c = v.optString("code", "")
                    val p = v.optString("password", c)
                    val st = v.optString("status", "")
                    val pair = Pair(c, p)
                    allVouchers.add(pair)
                    if (st != "used") {
                        unusedVouchers.add(pair)
                    }
                }

                // Render Print Dialog Options
                val printOptionsLayout = LinearLayout(ctx).apply {
                    orientation = LinearLayout.VERTICAL
                    setPadding(32, 20, 32, 16)
                }

                val printerNames = printers.map { "${it.name} (${it.address})" }
                val spPrinter = Spinner(ctx).apply {
                    background = createInputBackground()
                    setPadding(16, 16, 16, 16)
                    adapter = createDarkSpinnerAdapter(ctx, printerNames)
                }
                printOptionsLayout.addView(createFieldLabel(ctx, "Pilih Printer Bluetooth:"))
                printOptionsLayout.addView(spPrinter)

                val targetOptions = listOf(
                    "Semua Voucher (${allVouchers.size} voucher)",
                    "Hanya Belum Terpakai (${unusedVouchers.size} voucher)",
                    "10 Voucher Pertama",
                    "20 Voucher Pertama"
                )
                val spTarget = Spinner(ctx).apply {
                    background = createInputBackground()
                    setPadding(16, 16, 16, 16)
                    adapter = createDarkSpinnerAdapter(ctx, targetOptions)
                }
                printOptionsLayout.addView(createFieldLabel(ctx, "Voucher yang Dicetak:"))
                printOptionsLayout.addView(spTarget)

                val spPaper = Spinner(ctx).apply {
                    background = createInputBackground()
                    setPadding(16, 16, 16, 16)
                    adapter = createDarkSpinnerAdapter(ctx, listOf("58mm (Standar Portabel)", "80mm (Printer Kasir Besar)"))
                }
                printOptionsLayout.addView(createFieldLabel(ctx, "Lebar Kertas Printer:"))
                printOptionsLayout.addView(spPaper)

                val printDialog = AlertDialog.Builder(ctx)
                    .setCustomTitle(createCustomDialogHeader(ctx, "🖨️ Cetak Bluetooth Bersambung"))
                    .setView(printOptionsLayout)
                    .setPositiveButton("Mulai Cetak") { _, _ ->
                        val selPrinter = printers[spPrinter.selectedItemPosition]
                        val is80mm = spPaper.selectedItemPosition == 1
                        val selectedList = when (spTarget.selectedItemPosition) {
                            1 -> unusedVouchers
                            2 -> allVouchers.take(10)
                            3 -> allVouchers.take(20)
                            else -> allVouchers
                        }

                        if (selectedList.isEmpty()) {
                            Toast.makeText(ctx, "Tidak ada voucher yang memenuhi kriteria", Toast.LENGTH_SHORT).show()
                            return@setPositiveButton
                        }

                        startContinuousThermalPrinting(
                            printer = selPrinter,
                            is80mm = is80mm,
                            vouchers = selectedList,
                            companyName = companyName,
                            profileName = profileName,
                            priceFormatted = priceFormatted,
                            validity = validity,
                            contact = companyPhone,
                            hotspotDns = hotspotDns
                        )
                    }
                    .setNegativeButton("Batal", null)
                    .create()

                printDialog.setOnShowListener {
                    styleDialog(printDialog, positiveColor = Color.parseColor("#059669"))
                }
                printDialog.show()

            } catch (e: Exception) {
                Toast.makeText(ctx, "Error: ${e.message}", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun startContinuousThermalPrinting(
        printer: BluetoothPrinterHelper.PairedPrinter,
        is80mm: Boolean,
        vouchers: List<Pair<String, String>>,
        companyName: String,
        profileName: String,
        priceFormatted: String,
        validity: String,
        contact: String,
        hotspotDns: String
    ) {
        val ctx = context ?: return

        val progressView = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(40, 30, 40, 30)
            gravity = Gravity.CENTER
        }
        val pb = ProgressBar(ctx)
        val tvStatus = TextView(ctx).apply {
            text = "Menghubungkan ke ${printer.name}..."
            setTextColor(colorTextWhite)
            textSize = 14f
            setPadding(0, 16, 0, 0)
            gravity = Gravity.CENTER
        }
        progressView.addView(pb)
        progressView.addView(tvStatus)

        val progressDialog = AlertDialog.Builder(ctx)
            .setCustomTitle(createCustomDialogHeader(ctx, "Mencetak Bersambung..."))
            .setView(progressView)
            .setCancelable(false)
            .create()
        progressDialog.setOnShowListener {
            progressDialog.window?.setBackgroundDrawable(createDialogBackground())
        }
        progressDialog.show()

        lifecycleScope.launch {
            val res = BluetoothPrinterHelper.printVoucherBatchContinuous(
                deviceAddress = printer.address,
                is80mm = is80mm,
                companyName = companyName,
                packageName = profileName,
                priceFormatted = priceFormatted,
                validity = validity,
                contact = contact,
                hotspotDns = hotspotDns,
                vouchers = vouchers,
                onProgress = { cur, tot ->
                    lifecycleScope.launch(Dispatchers.Main) {
                        tvStatus.text = "Mencetak voucher $cur dari $tot...\n(Jangan matikan printer)"
                    }
                }
            )

            progressDialog.dismiss()

            if (res.isSuccess) {
                val printedCount = res.getOrDefault(vouchers.size)
                Toast.makeText(ctx, "✅ Berhasil mencetak $printedCount voucher bersambung!", Toast.LENGTH_LONG).show()
            } else {
                val errDialog = AlertDialog.Builder(ctx)
                    .setCustomTitle(createCustomDialogHeader(ctx, "Gagal Cetak Bluetooth"))
                    .setMessage(res.exceptionOrNull()?.message ?: "Terjadi kesalahan koneksi printer Bluetooth.")
                    .setPositiveButton("Tutup", null)
                    .create()
                errDialog.setOnShowListener {
                    styleDialog(errDialog, positiveColor = colorRed)
                    errDialog.findViewById<TextView>(android.R.id.message)?.setTextColor(Color.parseColor("#E2E8F0"))
                }
                errDialog.show()
            }
        }
    }

    // ─── COPY BATCH CODES ───────────────────────────────────────────────────
    private fun copyBatchCodes(batchId: Int) {
        val ctx = context ?: return

        lifecycleScope.launch {
            val url = "${getBaseUrl()}/api/customer/app/admin/vouchers/batch/$batchId/vouchers"
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

            if (responseStr != null) {
                try {
                    val json = JSONObject(responseStr)
                    val data = json.optJSONObject("data")
                    val vArr = data?.optJSONArray("vouchers") ?: JSONArray()
                    val batch = data?.optJSONObject("batch")
                    val profile = batch?.optString("profile_name", "Hotspot") ?: "Hotspot"

                    val sb = StringBuilder()
                    sb.append("🎫 DAFTAR VOUCHER BATCH #$batchId ($profile)\n\n")

                    for (i in 0 until vArr.length()) {
                        val v = vArr.getJSONObject(i)
                        val code = v.optString("code", "")
                        val pass = v.optString("password", code)
                        if (code == pass) {
                            sb.append("${i + 1}. Kode: $code\n")
                        } else {
                            sb.append("${i + 1}. User: $code | Pass: $pass\n")
                        }
                    }

                    val clipboard = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    clipboard.setPrimaryClip(ClipData.newPlainText("Vouchers Batch #$batchId", sb.toString()))
                    Toast.makeText(ctx, "✅ ${vArr.length()} kode voucher disalin ke clipboard!", Toast.LENGTH_LONG).show()
                    return@launch
                } catch (e: Exception) {
                    // Fallthrough
                }
            }

            Toast.makeText(ctx, "Gagal mengambil kode voucher", Toast.LENGTH_SHORT).show()
        }
    }

    // ─── DELETE BATCH ───────────────────────────────────────────────────────
    private fun confirmDeleteBatch(batchId: Int, profileName: String) {
        val ctx = context ?: return

        val delDialog = AlertDialog.Builder(ctx)
            .setCustomTitle(createCustomDialogHeader(ctx, "Hapus Batch #$batchId?"))
            .setMessage("Voucher dalam paket \"$profileName\" pada batch ini akan dihapus dari sistem dan MikroTik.")
            .setPositiveButton("Hapus") { _, _ ->
                executeDeleteBatch(batchId)
            }
            .setNegativeButton("Batal", null)
            .create()
        delDialog.setOnShowListener {
            styleDialog(delDialog, positiveColor = colorRed, negativeColor = colorTextMuted)
            delDialog.findViewById<TextView>(android.R.id.message)?.setTextColor(Color.parseColor("#E2E8F0"))
        }
        delDialog.show()
    }

    private fun executeDeleteBatch(batchId: Int) {
        val ctx = context ?: return
        val progress = AlertDialog.Builder(ctx)
            .setMessage("Menghapus batch voucher...")
            .setCancelable(false)
            .create()
        progress.setOnShowListener {
            progress.window?.setBackgroundDrawable(createDialogBackground())
            progress.findViewById<TextView>(android.R.id.message)?.setTextColor(Color.WHITE)
        }
        progress.show()

        lifecycleScope.launch {
            val url = "${getBaseUrl()}/api/customer/app/admin/vouchers/batch/$batchId"
            val responseStr = withContext(Dispatchers.IO) {
                try {
                    val req = Request.Builder()
                        .url(url)
                        .addHeader("Authorization", "Bearer ${getToken()}")
                        .delete()
                        .build()
                    val resp = httpClient().newCall(req).execute()
                    if (resp.isSuccessful) resp.body?.string() else null
                } catch (e: Exception) {
                    null
                }
            }

            progress.dismiss()

            if (responseStr != null) {
                Toast.makeText(ctx, "Batch #$batchId berhasil dihapus", Toast.LENGTH_SHORT).show()
                loadVouchers()
            } else {
                Toast.makeText(ctx, "Gagal menghapus batch", Toast.LENGTH_SHORT).show()
            }
        }
    }

    // ─── WHATSAPP SHARING HELPERS ───────────────────────────────────────────
    private fun promptSendWhatsApp(
        code: String,
        pass: String,
        profile: String,
        validity: String,
        price: String,
        initialPhone: String,
        companyName: String,
        hotspotDns: String,
        companyPhone: String
    ) {
        val ctx = context ?: return

        val container = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(40, 24, 40, 24)
        }

        val tvDesc = TextView(ctx).apply {
            text = "Kirim voucher ke pembeli menggunakan Gateway WhatsApp server (otomatis) atau buka aplikasi WhatsApp di perangkat ini."
            setTextColor(colorTextMuted)
            textSize = 12f
            setPadding(0, 0, 0, 16)
        }
        container.addView(tvDesc)

        val tvLabel = TextView(ctx).apply {
            text = "Nomor WhatsApp Pembeli:"
            setTextColor(colorTextWhite)
            textSize = 13f
            setTypeface(null, Typeface.BOLD)
            setPadding(0, 0, 0, 8)
        }
        container.addView(tvLabel)

        val etPhone = EditText(ctx).apply {
            hint = "Contoh: 08123456789"
            inputType = InputType.TYPE_CLASS_PHONE
            background = createInputBackground()
            setTextColor(colorTextWhite)
            setHintTextColor(Color.parseColor("#64748B"))
            textSize = 14f
            setPadding(24, 20, 24, 20)
            if (initialPhone.isNotEmpty()) {
                setText(initialPhone)
            }
        }
        container.addView(etPhone)

        val spacer = View(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 24)
        }
        container.addView(spacer)

        // Action Buttons: Server Gateway & Local App
        val btnServerGateway = Button(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                88
            ).apply {
                setMargins(0, 0, 0, 12)
            }
            text = "🚀 Kirim via Gateway WhatsApp"
            setTextColor(colorTextWhite)
            textSize = 13f
            setTypeface(null, Typeface.BOLD)
            background = GradientDrawable().apply {
                cornerRadius = 14f
                setColor(Color.parseColor("#059669")) // Emerald green
            }
        }
        container.addView(btnServerGateway)

        val btnLocalWA = Button(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                88
            ).apply {
                setMargins(0, 0, 0, 4)
            }
            text = "💬 Buka Aplikasi WhatsApp HP"
            setTextColor(colorTextWhite)
            textSize = 13f
            setTypeface(null, Typeface.BOLD)
            background = GradientDrawable().apply {
                cornerRadius = 14f
                setColor(Color.parseColor("#2563EB")) // Blue
            }
        }
        container.addView(btnLocalWA)

        val dialog = AlertDialog.Builder(ctx)
            .setCustomTitle(createCustomDialogHeader(ctx, "Kirim Voucher WhatsApp"))
            .setView(container)
            .setNegativeButton("Tutup", null)
            .create()

        dialog.setOnShowListener {
            styleDialog(dialog, negativeColor = colorTextMuted)
        }

        btnServerGateway.setOnClickListener {
            val phone = etPhone.text.toString().trim()
            if (phone.isEmpty()) {
                Toast.makeText(ctx, "Nomor WhatsApp belum diisi", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }

            btnServerGateway.isEnabled = false
            btnServerGateway.text = "Mengirim via Server..."

            sendVoucherViaServerGateway(phone, code, pass, profile, validity, price) { ok, msg ->
                if (!isAdded) return@sendVoucherViaServerGateway
                btnServerGateway.isEnabled = true
                btnServerGateway.text = "🚀 Kirim via Gateway WhatsApp"

                if (ok) {
                    Toast.makeText(ctx, "✅ $msg", Toast.LENGTH_LONG).show()
                    dialog.dismiss()
                } else {
                    AlertDialog.Builder(ctx)
                        .setTitle("Gagal Kirim WhatsApp")
                        .setMessage(msg)
                        .setPositiveButton("OK", null)
                        .show()
                }
            }
        }

        btnLocalWA.setOnClickListener {
            val phone = etPhone.text.toString().trim()
            if (phone.isEmpty()) {
                Toast.makeText(ctx, "Nomor WhatsApp belum diisi", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            openWhatsAppVoucher(phone, code, pass, profile, validity, price, companyName, hotspotDns, companyPhone)
            dialog.dismiss()
        }

        dialog.show()
    }

    private fun sendVoucherViaServerGateway(
        phone: String,
        code: String,
        pass: String,
        profile: String,
        validity: String,
        price: String,
        onComplete: (Boolean, String) -> Unit
    ) {
        lifecycleScope.launch {
            val res = withContext(Dispatchers.IO) {
                try {
                    val url = "${getBaseUrl()}/api/customer/app/admin/vouchers/send-wa"
                    val bodyJson = JSONObject().apply {
                        put("phone", phone)
                        put("code", code)
                        put("password", pass)
                        put("profile", profile)
                        put("validity", validity)
                        put("price", price)
                    }
                    val reqBody = bodyJson.toString().toRequestBody("application/json".toMediaType())
                    val req = Request.Builder()
                        .url(url)
                        .addHeader("Authorization", "Bearer ${getToken()}")
                        .post(reqBody)
                        .build()
                    val resp = httpClient().newCall(req).execute()
                    val respStr = resp.body?.string() ?: ""
                    val json = JSONObject(respStr)
                    val ok = json.optBoolean("success", false)
                    val msg = json.optString("message", if (ok) "Voucher berhasil dikirim" else "Gagal mengirim WhatsApp")
                    Pair(ok, msg)
                } catch (e: Exception) {
                    Pair(false, e.message ?: "Kesalahan koneksi ke server")
                }
            }
            onComplete(res.first, res.second)
        }
    }

    private fun openWhatsAppVoucher(
        phone: String,
        code: String,
        pass: String,
        profile: String,
        validity: String,
        price: String,
        companyName: String,
        hotspotDns: String,
        companyPhone: String
    ) {
        try {
            var p = phone.replace(Regex("[^0-9]"), "")
            if (p.startsWith("08")) p = "62" + p.substring(1)
            if (!p.startsWith("62")) p = "62" + p

            val msg = StringBuilder().apply {
                append("🎫 *VOUCHER INTERNET HOTSPOT*\n")
                append("--------------------------------\n")
                append("🏢 *$companyName*\n")
                append("📦 *Paket:* $profile\n")
                append("⏱️ *Masa Aktif:* $validity\n")
                append("💰 *Tarif:* $price\n\n")

                if (code == pass) {
                    append("👤 *Kode Login:* `$code`\n\n")
                } else {
                    append("👤 *Username:* `$code`\n")
                    append("🔑 *Password:* `$pass`\n\n")
                }

                if (hotspotDns.isNotEmpty() && hotspotDns != "wifi.id") {
                    append("🌐 *Login URL:* http://$hotspotDns\n")
                }
                if (companyPhone.isNotEmpty()) {
                    append("📞 *Bantuan / CS:* $companyPhone\n")
                }
                append("--------------------------------\n")
                append("Sambungkan perangkat ke WiFi, masukkan kode login di atas. Terima kasih!")
            }.toString()

            val intent = Intent(Intent.ACTION_VIEW, Uri.parse("https://wa.me/$p?text=${Uri.encode(msg)}"))
            startActivity(intent)
        } catch (_: Exception) {
            Toast.makeText(context, "Aplikasi WhatsApp tidak ditemukan", Toast.LENGTH_SHORT).show()
        }
    }

    // ─── UI UTILS ───────────────────────────────────────────────────────────
    private fun createInputBackground(): GradientDrawable {
        return GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = 14f
            setColor(Color.parseColor("#0F172A"))
            setStroke(2, Color.parseColor("#334155"))
        }
    }

    private fun createDialogBackground(): GradientDrawable {
        return GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = 28f
            setColor(Color.parseColor("#1E293B"))
            setStroke(2, Color.parseColor("#334155"))
        }
    }

    private fun createCustomDialogHeader(ctx: Context, title: String): View {
        return LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(40, 36, 40, 16)
            addView(TextView(ctx).apply {
                text = title
                textSize = 17.5f
                setTypeface(null, Typeface.BOLD)
                setTextColor(Color.WHITE)
            })
        }
    }

    private fun createFieldLabel(ctx: Context, text: String): TextView {
        return TextView(ctx).apply {
            this.text = text
            setTextColor(Color.parseColor("#E2E8F0")) // Slate 200
            textSize = 12.5f
            setTypeface(null, Typeface.BOLD)
            setPadding(0, 14, 0, 6)
        }
    }

    private fun styleRadioButton(rb: RadioButton) {
        rb.setTextColor(Color.WHITE)
        rb.textSize = 13.5f
        rb.buttonTintList = ColorStateList.valueOf(Color.parseColor("#38BDF8"))
    }

    private fun createDarkSpinnerAdapter(ctx: Context, items: List<String>): ArrayAdapter<String> {
        return object : ArrayAdapter<String>(ctx, android.R.layout.simple_spinner_item, items) {
            override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
                val v = super.getView(position, convertView, parent)
                (v as? TextView)?.apply {
                    setTextColor(Color.WHITE)
                    textSize = 13.5f
                    setTypeface(null, Typeface.BOLD)
                }
                return v
            }

            override fun getDropDownView(position: Int, convertView: View?, parent: ViewGroup): View {
                val v = super.getDropDownView(position, convertView, parent)
                (v as? TextView)?.apply {
                    setTextColor(Color.WHITE)
                    textSize = 13.5f
                    setBackgroundColor(Color.parseColor("#1E293B"))
                    setPadding(32, 28, 32, 28)
                }
                return v
            }
        }.apply {
            setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
        }
    }

    private fun styleDialog(
        dialog: AlertDialog,
        positiveColor: Int = Color.parseColor("#38BDF8"),
        negativeColor: Int = Color.parseColor("#94A3B8"),
        neutralColor: Int = Color.parseColor("#4ADE80")
    ) {
        dialog.window?.setBackgroundDrawable(createDialogBackground())
        dialog.getButton(AlertDialog.BUTTON_POSITIVE)?.apply {
            setTextColor(positiveColor)
            textSize = 13.5f
            setTypeface(null, Typeface.BOLD)
        }
        dialog.getButton(AlertDialog.BUTTON_NEGATIVE)?.apply {
            setTextColor(negativeColor)
            textSize = 13.5f
        }
        dialog.getButton(AlertDialog.BUTTON_NEUTRAL)?.apply {
            setTextColor(neutralColor)
            textSize = 13.5f
        }
    }

    private fun createStatBox(
        ctx: Context,
        title: String,
        value: String,
        textColor: Int,
        bgColor: Int,
        marginLeft: Int,
        marginRight: Int
    ): LinearLayout {
        return LinearLayout(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply {
                setMargins(marginLeft, 0, marginRight, 0)
            }
            orientation = LinearLayout.VERTICAL
            val bgDrawable = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = 14f
                setColor(bgColor)
            }
            background = bgDrawable
            setPadding(14, 16, 14, 16)

            val tvTitle = TextView(ctx).apply {
                text = title
                setTextColor(colorTextMuted)
                textSize = 11f
            }

            val tvVal = TextView(ctx).apply {
                text = value
                setTextColor(textColor)
                textSize = 16f
                setTypeface(null, Typeface.BOLD)
                setPadding(0, 4, 0, 0)
            }

            addView(tvTitle)
            addView(tvVal)
        }
    }

    private fun createProgressBar(context: Context, percent: Int, progressColor: Int): View {
        val safePercent = percent.coerceIn(0, 100)
        val bg = LinearLayout(context).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                14
            ).apply {
                setMargins(0, 8, 0, 8)
            }
            val bgDrawable = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = 7f
                setColor(Color.parseColor("#334155"))
            }
            background = bgDrawable
            orientation = LinearLayout.HORIZONTAL
            weightSum = 100f
        }

        val fill = View(context).apply {
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, safePercent.toFloat())
            val fillDrawable = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = 7f
                setColor(progressColor)
            }
            background = fillDrawable
        }

        val emptySpace = View(context).apply {
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, (100 - safePercent).toFloat())
        }

        bg.addView(fill)
        bg.addView(emptySpace)
        return bg
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
            text = "🎫"
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

