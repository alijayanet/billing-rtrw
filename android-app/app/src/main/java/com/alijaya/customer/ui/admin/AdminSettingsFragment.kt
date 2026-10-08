package com.alijaya.customer.ui.admin

import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import androidx.cardview.widget.CardView
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.alijaya.customer.CustomerApplication
import com.alijaya.customer.R
import com.alijaya.customer.databinding.FragmentAdminSettingsBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class AdminSettingsFragment : Fragment() {
    private var _binding: FragmentAdminSettingsBinding? = null
    private val binding get() = _binding!!

    private val colorBg = Color.parseColor("#0F172A")
    private val colorCard = Color.parseColor("#1E293B")
    private val colorWhite = Color.parseColor("#FFFFFF")
    private val colorMuted = Color.parseColor("#94A3B8")
    private val colorAccent = Color.parseColor("#38BDF8")
    private val colorGreen = Color.parseColor("#4ADE80")
    private val colorYellow = Color.parseColor("#FACC15")
    private val colorRed = Color.parseColor("#EF4444")
    private val colorBlue = Color.parseColor("#3B82F6")

    private var etCompanyHeader: EditText? = null
    private var etCompanyPhone: EditText? = null
    private var etCompanyAddress: EditText? = null
    private var spinnerTimezone: Spinner? = null

    private val timezoneOptions = listOf(
        "Asia/Jakarta (WIB - UTC+7)",
        "Asia/Makassar (WITA - UTC+8)",
        "Asia/Jayapura (WIT - UTC+9)"
    )
    private val timezoneValues = listOf(
        "Asia/Jakarta",
        "Asia/Makassar",
        "Asia/Jayapura"
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
        inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?
    ): View {
        _binding = FragmentAdminSettingsBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        binding.swipeRefresh.setOnRefreshListener {
            loadSettings()
        }

        loadSettings()
    }

    private fun loadSettings() {
        binding.swipeRefresh.isRefreshing = true
        lifecycleScope.launch {
            val url = "${getBaseUrl()}/api/customer/app/admin/settings"
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
                    val data = json.optJSONObject("data") ?: JSONObject()
                    renderUI(data)
                    return@launch
                } catch (_: Exception) {}
            }

            renderErrorUI()
        }
    }

    private fun renderUI(data: JSONObject) {
        val ctx = context ?: return
        val container = binding.contentContainer
        container.removeAllViews()

        val companyHeader = data.optString("company_header", "ALIJAYA NETWORK")
        val companyPhone = data.optString("company_phone", "")
        val companyAddress = data.optString("company_address", "")
        val curTimezone = data.optString("timezone", "Asia/Jakarta")

        // 1. Header Card
        val headerCard = CardView(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { setMargins(0, 0, 0, 20) }
            radius = 24f
            setCardBackgroundColor(colorCard)
        }
        val headerLayout = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 28, 32, 28)
        }
        val tvHeaderTitle = TextView(ctx).apply {
            text = "⚙️ Pengaturan ISP & Aplikasi"
            setTextColor(colorWhite)
            textSize = 18f
            setTypeface(null, Typeface.BOLD)
        }
        val tvHeaderDesc = TextView(ctx).apply {
            text = "Kelola identitas perusahaan, informasi kontak bantuan pelanggan pada invoice/struk, dan zona waktu server."
            setTextColor(colorMuted)
            textSize = 12f
            setPadding(0, 6, 0, 0)
        }
        headerLayout.addView(tvHeaderTitle)
        headerLayout.addView(tvHeaderDesc)
        headerCard.addView(headerLayout)
        container.addView(headerCard)

        // 1.5 Auto-Payment Gateway Card
        val gatewayCard = CardView(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { setMargins(0, 0, 0, 20) }
            radius = 24f
            setCardBackgroundColor(colorCard)
        }
        val gatewayLayout = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 24, 32, 24)
        }
        gatewayLayout.addView(TextView(ctx).apply {
            text = "⚡ Auto-Payment Gateway (E-Wallet & Bank)"
            setTextColor(colorWhite); textSize = 15f; typeface = Typeface.DEFAULT_BOLD
        })
        gatewayLayout.addView(TextView(ctx).apply {
            text = "Jadikan HP ini sebagai server gateway penangkap notifikasi QRIS/E-Wallet otomatis (DANA, GoPay, OVO, ShopeePay, BCA, Mandiri, BRI, dll) tanpa aplikasi pihak ketiga MacroDroid."
            setTextColor(colorMuted); textSize = 11.5f; setPadding(0, 4, 0, 14)
        })
        val btnOpenGateway = Button(ctx).apply {
            text = "⚙️ Buka Pengaturan Auto-Gateway E-Wallet"
            setTextColor(Color.WHITE); textSize = 12.5f; typeface = Typeface.DEFAULT_BOLD
            backgroundTintList = android.content.res.ColorStateList.valueOf(Color.parseColor("#F59E0B"))
            setOnClickListener {
                parentFragmentManager.beginTransaction()
                    .replace(R.id.fragment_container, AdminWebhookGatewayFragment())
                    .addToBackStack(null)
                    .commit()
            }
        }
        gatewayLayout.addView(btnOpenGateway)
        gatewayCard.addView(gatewayLayout)
        container.addView(gatewayCard)

        // 2. Settings Form Card
        val formCard = CardView(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { setMargins(0, 0, 0, 20) }
            radius = 24f
            setCardBackgroundColor(colorCard)
        }
        val formLayout = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 32, 32, 32)
        }

        fun createFieldLabel(label: String): TextView {
            return TextView(ctx).apply {
                text = label
                setTextColor(colorAccent)
                textSize = 12.5f
                setTypeface(null, Typeface.BOLD)
                setPadding(0, 14, 0, 6)
            }
        }

        fun createInputField(hintText: String, initialValue: String): EditText {
            return EditText(ctx).apply {
                hint = hintText
                setText(initialValue)
                setHintTextColor(colorMuted)
                setTextColor(colorWhite)
                textSize = 13.5f
                background = ContextCompat.getDrawable(ctx, R.drawable.bg_input_field)
                setPadding(28, 24, 28, 24)
            }
        }

        // Field 1: Company Header
        formLayout.addView(createFieldLabel("Nama Perusahaan / Header ISP:"))
        etCompanyHeader = createInputField("Contoh: ALIJAYA NETWORK", companyHeader)
        formLayout.addView(etCompanyHeader)

        // Field 2: Company Phone
        formLayout.addView(createFieldLabel("Nomor CS / WhatsApp Resmi:"))
        etCompanyPhone = createInputField("Contoh: 081234567890", companyPhone)
        formLayout.addView(etCompanyPhone)

        // Field 3: Company Address
        formLayout.addView(createFieldLabel("Alamat Kantor Operasional:"))
        etCompanyAddress = createInputField("Contoh: Jl. Raya Indramayu No. 123", companyAddress).apply {
            minLines = 2
            maxLines = 4
        }
        formLayout.addView(etCompanyAddress)

        // Field 4: Timezone Spinner
        formLayout.addView(createFieldLabel("Zona Waktu Server (Timezone):"))
        spinnerTimezone = Spinner(ctx).apply {
            val adapter = ArrayAdapter(ctx, android.R.layout.simple_spinner_dropdown_item, timezoneOptions)
            this.adapter = adapter
            val matchedIndex = timezoneValues.indexOfFirst { it.equals(curTimezone, ignoreCase = true) }
            if (matchedIndex >= 0) setSelection(matchedIndex)
            background = ContextCompat.getDrawable(ctx, R.drawable.bg_input_field)
            setPadding(20, 20, 20, 20)
        }
        formLayout.addView(spinnerTimezone)

        // Save Button
        val btnSave = Button(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                120
            ).apply { setMargins(0, 32, 0, 0) }
            text = "💾 Simpan Perubahan Pengaturan"
            textSize = 13.5f
            setTypeface(null, Typeface.BOLD)
            setBackgroundColor(colorBlue)
            setTextColor(colorWhite)
            setOnClickListener {
                saveSettings()
            }
        }
        formLayout.addView(btnSave)

        formCard.addView(formLayout)
        container.addView(formCard)
    }

    private fun saveSettings() {
        val ctx = context ?: return
        val header = etCompanyHeader?.text?.toString()?.trim() ?: ""
        val phone = etCompanyPhone?.text?.toString()?.trim() ?: ""
        val address = etCompanyAddress?.text?.toString()?.trim() ?: ""

        val selectedTzIdx = spinnerTimezone?.selectedItemPosition ?: 0
        val timezone = if (selectedTzIdx in timezoneValues.indices) timezoneValues[selectedTzIdx] else "Asia/Jakarta"

        if (header.isEmpty()) {
            Toast.makeText(ctx, "Nama perusahaan tidak boleh kosong!", Toast.LENGTH_SHORT).show()
            return
        }

        lifecycleScope.launch {
            Toast.makeText(ctx, "Menyimpan pengaturan...", Toast.LENGTH_SHORT).show()
            val url = "${getBaseUrl()}/api/customer/app/admin/settings/update"
            val bodyJson = JSONObject().apply {
                put("company_header", header)
                put("company_phone", phone)
                put("company_address", address)
                put("timezone", timezone)
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
                Toast.makeText(ctx, " Pengaturan berhasil disimpan!", Toast.LENGTH_LONG).show()
                loadSettings()
            } else {
                Toast.makeText(ctx, "Gagal menyimpan pengaturan ke server", Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun renderErrorUI() {
        val ctx = context ?: return
        val container = binding.contentContainer
        container.removeAllViews()

        val card = CardView(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
            radius = 24f
            setCardBackgroundColor(colorCard)
        }
        val layout = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(32, 48, 32, 48)
        }
        val tvErr = TextView(ctx).apply {
            text = "⚠️ Gagal memuat data pengaturan.\nTarik ke bawah untuk memuat ulang."
            setTextColor(colorMuted)
            textSize = 13f
            gravity = Gravity.CENTER
        }
        val btnRetry = Button(ctx, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
            text = "Coba Lagi"
            setTextColor(colorAccent)
            setOnClickListener { loadSettings() }
        }
        layout.addView(tvErr)
        layout.addView(btnRetry)
        card.addView(layout)
        container.addView(card)
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}
