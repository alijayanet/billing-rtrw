package com.alijaya.customer.ui.admin

import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Bundle
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
import com.alijaya.customer.databinding.FragmentAdminTechniciansBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class AdminTechniciansFragment : Fragment() {
    private var _binding: FragmentAdminTechniciansBinding? = null
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

    private var technicianList = mutableListOf<JSONObject>()

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
        _binding = FragmentAdminTechniciansBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        binding.swipeRefresh.setOnRefreshListener {
            loadTechnicians()
        }

        loadTechnicians()
    }

    private fun loadTechnicians() {
        binding.swipeRefresh.isRefreshing = true
        lifecycleScope.launch {
            val url = "${getBaseUrl()}/api/customer/app/admin/technicians"
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
                    technicianList.clear()
                    for (i in 0 until arr.length()) {
                        technicianList.add(arr.getJSONObject(i))
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

        val totalTech = technicianList.size
        val activeTech = technicianList.count { it.optInt("is_active", 1) == 1 }

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
            text = "🛠️ Tim Teknisi Lapangan"
            setTextColor(colorWhite)
            textSize = 18f
            setTypeface(null, Typeface.BOLD)
        }
        val tvHeaderDesc = TextView(ctx).apply {
            text = "Total $totalTech Teknisi terdaftar  •  $activeTech Teknisi Aktif bertugas"
            setTextColor(colorAccent)
            textSize = 12.5f
            setPadding(0, 6, 0, 0)
            setTypeface(null, Typeface.BOLD)
        }
        headerLayout.addView(tvHeaderTitle)
        headerLayout.addView(tvHeaderDesc)
        headerCard.addView(headerLayout)
        container.addView(headerCard)

        if (technicianList.isEmpty()) {
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
                text = "Belum ada data teknisi yang terdaftar."
                setTextColor(colorMuted)
                textSize = 13f
            }
            emptyLayout.addView(tvEmpty)
            emptyCard.addView(emptyLayout)
            container.addView(emptyCard)
            return
        }

        // 2. Technicians Cards List
        for (tech in technicianList) {
            val name = tech.optString("name", "Teknisi")
            val username = tech.optString("username", "-")
            val phone = tech.optString("phone", "-")
            val area = tech.optString("area", "Semua Wilayah")
            val isActive = tech.optInt("is_active", 1) == 1

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

            // Info details
            val tvDetails = TextView(ctx).apply {
                text = "👤 @$username\n📱 $phone\n📍 Wilayah / Area: ${if (area.isNotEmpty()) area else "Semua Wilayah"}"
                setTextColor(colorMuted)
                textSize = 12.5f
                setPadding(0, 10, 0, 16)
                setLineSpacing(4f, 1f)
            }
            cardLayout.addView(tvDetails)

            // Actions Row
            val actionsRow = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
            }

            if (phone.isNotEmpty() && phone != "-") {
                val btnWa = Button(ctx, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                    layoutParams = LinearLayout.LayoutParams(0, 85, 1f).apply { marginEnd = 8 }
                    text = "💬 WhatsApp"
                    textSize = 11f
                    setTextColor(colorAccent)
                    setOnClickListener {
                        openWhatsApp(phone)
                    }
                }
                actionsRow.addView(btnWa)

                val btnCall = Button(ctx, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                    layoutParams = LinearLayout.LayoutParams(0, 85, 1f)
                    text = "📞 Telepon"
                    textSize = 11f
                    setTextColor(colorGreen)
                    setOnClickListener {
                        openDialer(phone)
                    }
                }
                actionsRow.addView(btnCall)
            }

            if (actionsRow.childCount > 0) {
                cardLayout.addView(actionsRow)
            }

            card.addView(cardLayout)
            container.addView(card)
        }
    }

    private fun openWhatsApp(phone: String) {
        try {
            var p = phone.replace(Regex("[^0-9]"), "")
            if (p.startsWith("08")) p = "62" + p.substring(1)
            if (!p.startsWith("62")) p = "62" + p
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse("https://wa.me/$p"))
            startActivity(intent)
        } catch (_: Exception) {
            Toast.makeText(context, "Tidak dapat membuka WhatsApp", Toast.LENGTH_SHORT).show()
        }
    }

    private fun openDialer(phone: String) {
        try {
            val intent = Intent(Intent.ACTION_DIAL, Uri.parse("tel:$phone"))
            startActivity(intent)
        } catch (_: Exception) {
            Toast.makeText(context, "Tidak dapat membuka panggilan telepon", Toast.LENGTH_SHORT).show()
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
            text = "⚠️ Gagal mengambil data teknisi.\nTarik ke bawah untuk memuat ulang."
            setTextColor(colorMuted)
            textSize = 13f
            gravity = Gravity.CENTER
        }
        val btnRetry = Button(ctx, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
            text = "Coba Lagi"
            setTextColor(colorAccent)
            setOnClickListener { loadTechnicians() }
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
