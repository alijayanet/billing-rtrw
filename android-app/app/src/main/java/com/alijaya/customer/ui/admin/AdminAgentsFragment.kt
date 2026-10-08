package com.alijaya.customer.ui.admin

import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
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
import com.alijaya.customer.databinding.FragmentAdminAgentsBinding
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

class AdminAgentsFragment : Fragment() {
    private var _binding: FragmentAdminAgentsBinding? = null
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

    private var agentList = mutableListOf<JSONObject>()

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
        _binding = FragmentAdminAgentsBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        binding.swipeRefresh.setOnRefreshListener {
            loadAgents()
        }

        loadAgents()
    }

    private fun loadAgents() {
        binding.swipeRefresh.isRefreshing = true
        lifecycleScope.launch {
            val url = "${getBaseUrl()}/api/customer/app/admin/agents"
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
                    agentList.clear()
                    for (i in 0 until arr.length()) {
                        agentList.add(arr.getJSONObject(i))
                    }
                    renderUI()
                    return@launch
                } catch (_: Exception) {}
            }

            renderErrorUI()
        }
    }

    private fun renderUI() {
        val ctx = context ?: return
        val container = binding.contentContainer
        container.removeAllViews()

        val fmt = NumberFormat.getCurrencyInstance(Locale("id", "ID"))
        val totalAgents = agentList.size
        var totalBalance = 0.0
        for (a in agentList) {
            totalBalance += a.optDouble("balance", 0.0)
        }

        // 1. Header Summary Card
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
            text = "🏪 Mitra Agen Voucher & PPOB"
            setTextColor(colorWhite)
            textSize = 18f
            setTypeface(null, Typeface.BOLD)
        }
        val tvHeaderDesc = TextView(ctx).apply {
            text = "Total $totalAgents Agen  •  Saldo Beredar: ${fmt.format(totalBalance)}"
            setTextColor(colorAccent)
            textSize = 12.5f
            setPadding(0, 6, 0, 0)
            setTypeface(null, Typeface.BOLD)
        }
        headerLayout.addView(tvHeaderTitle)
        headerLayout.addView(tvHeaderDesc)
        headerCard.addView(headerLayout)
        container.addView(headerCard)

        if (agentList.isEmpty()) {
            val emptyCard = CardView(ctx).apply {
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                )
                radius = 24f
                setCardBackgroundColor(colorCard)
            }
            val emptyLayout = LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER
                setPadding(32, 60, 32, 60)
            }
            val tvEmpty = TextView(ctx).apply {
                text = "Belum ada mitra agen yang terdaftar."
                setTextColor(colorMuted)
                textSize = 13f
            }
            emptyLayout.addView(tvEmpty)
            emptyCard.addView(emptyLayout)
            container.addView(emptyCard)
            return
        }

        // 2. Agent Cards
        for (agent in agentList) {
            val agentId = agent.optInt("id")
            val name = agent.optString("name", "Mitra Agen")
            val username = agent.optString("username", "-")
            val phone = agent.optString("phone", "-")
            val balance = agent.optDouble("balance", 0.0)
            val isActive = agent.optInt("is_active", 1) == 1

            val card = CardView(ctx).apply {
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                ).apply { setMargins(0, 0, 0, 18) }
                radius = 24f
                setCardBackgroundColor(colorCard)
            }

            val cardLayout = LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(32, 28, 32, 28)
            }

            // Top Row (Name + Active Badge)
            val topRow = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            val tvName = TextView(ctx).apply {
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                text = name
                setTextColor(colorWhite)
                textSize = 15.5f
                setTypeface(null, Typeface.BOLD)
            }
            val tvBadge = TextView(ctx).apply {
                text = if (isActive) " 🟢 AKTIF " else " 🔴 NON-AKTIF "
                setTextColor(if (isActive) colorGreen else colorRed)
                textSize = 11f
                setTypeface(null, Typeface.BOLD)
                setPadding(16, 6, 16, 6)
                val bg = GradientDrawable().apply {
                    setColor(if (isActive) Color.parseColor("#153728") else Color.parseColor("#371515"))
                    cornerRadius = 14f
                    setStroke(2, if (isActive) colorGreen else colorRed)
                }
                background = bg
            }
            topRow.addView(tvName)
            topRow.addView(tvBadge)
            cardLayout.addView(topRow)

            // Details
            val tvDetails = TextView(ctx).apply {
                text = "👤 @$username  |  📱 $phone"
                setTextColor(colorMuted)
                textSize = 12f
                setPadding(0, 6, 0, 8)
            }
            cardLayout.addView(tvDetails)

            // Balance Row
            val balanceLayout = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(0, 4, 0, 14)
            }
            val tvBalLabel = TextView(ctx).apply {
                text = "Saldo Deposit: "
                setTextColor(colorMuted)
                textSize = 13f
            }
            val tvBalVal = TextView(ctx).apply {
                text = fmt.format(balance)
                setTextColor(colorGreen)
                textSize = 15f
                setTypeface(null, Typeface.BOLD)
            }
            balanceLayout.addView(tvBalLabel)
            balanceLayout.addView(tvBalVal)
            cardLayout.addView(balanceLayout)

            // Topup Button
            val btnTopup = Button(ctx).apply {
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    90
                )
                text = "➕ Top-Up Saldo Agen"
                textSize = 12f
                setBackgroundColor(colorBlue)
                setTextColor(colorWhite)
                setOnClickListener {
                    showTopupDialog(agentId, name, balance)
                }
            }
            cardLayout.addView(btnTopup)

            card.addView(cardLayout)
            container.addView(card)
        }
    }

    private fun showTopupDialog(agentId: Int, agentName: String, currentBalance: Double) {
        val ctx = context ?: return
        val fmt = NumberFormat.getCurrencyInstance(Locale("id", "ID"))

        val layout = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(50, 30, 50, 10)
        }

        val tvInfo = TextView(ctx).apply {
            text = "Agen: $agentName\nSaldo Saat Ini: ${fmt.format(currentBalance)}"
            setTextColor(colorWhite)
            textSize = 13f
            setPadding(0, 0, 0, 16)
        }
        layout.addView(tvInfo)

        val tvLabelAmount = TextView(ctx).apply {
            text = "Nominal Top-Up (Rp):"
            setTextColor(colorAccent)
            textSize = 12f
        }
        layout.addView(tvLabelAmount)

        val etAmount = EditText(ctx).apply {
            hint = "Contoh: 100000"
            inputType = android.text.InputType.TYPE_CLASS_NUMBER
            setTextColor(colorWhite)
            setHintTextColor(colorMuted)
            textSize = 15f
            background = ContextCompat.getDrawable(ctx, R.drawable.bg_input_field)
            setPadding(24, 20, 24, 20)
        }
        layout.addView(etAmount)

        // Quick amount preset chips
        val quickAmounts = listOf(50000, 100000, 250000, 500000, 1000000)
        val chipsRow = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, 14, 0, 10)
        }

        for (amt in quickAmounts.take(3)) {
            val btnChip = Button(ctx, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                layoutParams = LinearLayout.LayoutParams(0, 75, 1f).apply { marginEnd = 6 }
                text = "${amt / 1000}k"
                textSize = 11f
                setTextColor(colorAccent)
                setOnClickListener {
                    etAmount.setText(amt.toString())
                }
            }
            chipsRow.addView(btnChip)
        }
        layout.addView(chipsRow)

        val chipsRow2 = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, 0, 0, 10)
        }
        for (amt in quickAmounts.drop(3)) {
            val btnChip = Button(ctx, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                layoutParams = LinearLayout.LayoutParams(0, 75, 1f).apply { marginEnd = 6 }
                text = "${amt / 1000}k"
                textSize = 11f
                setTextColor(colorAccent)
                setOnClickListener {
                    etAmount.setText(amt.toString())
                }
            }
            chipsRow2.addView(btnChip)
        }
        layout.addView(chipsRow2)

        AlertDialog.Builder(ctx)
            .setTitle("➕ Top-Up Saldo Mitra Agen")
            .setView(layout)
            .setPositiveButton("Top-Up Sekarang") { _, _ ->
                val amountStr = etAmount.text.toString().trim()
                val amount = amountStr.toDoubleOrNull() ?: 0.0
                if (amount <= 0) {
                    Toast.makeText(ctx, "Nominal tidak valid!", Toast.LENGTH_SHORT).show()
                } else {
                    processTopup(agentId, amount, agentName)
                }
            }
            .setNegativeButton("Batal", null)
            .show()
    }

    private fun processTopup(agentId: Int, amount: Double, agentName: String) {
        val ctx = context ?: return
        val fmt = NumberFormat.getCurrencyInstance(Locale("id", "ID"))
        Toast.makeText(ctx, "Memproses top-up...", Toast.LENGTH_SHORT).show()

        lifecycleScope.launch {
            val url = "${getBaseUrl()}/api/customer/app/admin/agents/topup"
            val bodyJson = JSONObject().apply {
                put("agentId", agentId)
                put("amount", amount)
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
                Toast.makeText(ctx, "✅ Top-up ${fmt.format(amount)} ke agen \"$agentName\" berhasil!", Toast.LENGTH_LONG).show()
                loadAgents()
            } else {
                Toast.makeText(ctx, "Gagal memproses top-up ke agen", Toast.LENGTH_LONG).show()
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
            text = "⚠️ Gagal mengambil data agen.\nTarik ke bawah untuk memuat ulang."
            setTextColor(colorMuted)
            textSize = 13f
            gravity = Gravity.CENTER
        }
        val btnRetry = Button(ctx, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
            text = "Coba Lagi"
            setTextColor(colorAccent)
            setOnClickListener { loadAgents() }
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
