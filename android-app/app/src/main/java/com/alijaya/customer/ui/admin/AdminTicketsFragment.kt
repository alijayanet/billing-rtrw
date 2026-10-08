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
import android.widget.LinearLayout
import android.widget.TextView
import androidx.cardview.widget.CardView
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.alijaya.customer.CustomerApplication
import com.alijaya.customer.databinding.FragmentAdminTicketsBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class AdminTicketsFragment : Fragment() {
    private var _binding: FragmentAdminTicketsBinding? = null
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

    private var allTickets = mutableListOf<JSONObject>()
    private var openCount = 0
    private var activeFilter = "all" // all, open, resolved, closed

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
        _binding = FragmentAdminTicketsBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        binding.swipeRefresh.setOnRefreshListener {
            loadTickets()
        }

        loadTickets()
    }

    private fun loadTickets() {
        binding.swipeRefresh.isRefreshing = true
        lifecycleScope.launch {
            val url = "${getBaseUrl()}/api/customer/app/admin/tickets"
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
                    val data = json.optJSONObject("data")
                    allTickets.clear()

                    if (data != null) {
                        openCount = data.optInt("openCount", 0)
                        val arr = data.optJSONArray("tickets") ?: JSONArray()
                        for (i in 0 until arr.length()) {
                            allTickets.add(arr.getJSONObject(i))
                        }
                    } else {
                        val arr = json.optJSONArray("data") ?: JSONArray()
                        for (i in 0 until arr.length()) {
                            val t = arr.getJSONObject(i)
                            allTickets.add(t)
                            if (t.optString("status", "").equals("open", ignoreCase = true)) {
                                openCount++
                            }
                        }
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

        // 1. Header Card with Open Count Badge
        val headerCard = CardView(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { setMargins(0, 0, 0, 16) }
            radius = 24f
            setCardBackgroundColor(colorCard)
        }
        val headerLayout = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 28, 32, 28)
        }
        val tvHeaderTitle = TextView(ctx).apply {
            text = "🎫 Tiket Bantuan & Gangguan"
            setTextColor(colorWhite)
            textSize = 18f
            setTypeface(null, Typeface.BOLD)
        }

        val badgeRow = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, 10, 0, 0)
            gravity = Gravity.CENTER_VERTICAL
        }

        val tvOpenBadge = TextView(ctx).apply {
            text = if (openCount > 0) " ⏳ $openCount Tiket Membutuhkan Penanganan " else " ✅ Semua Tiket Selesai "
            setTextColor(if (openCount > 0) colorYellow else colorGreen)
            textSize = 12f
            setTypeface(null, Typeface.BOLD)
            setPadding(20, 8, 20, 8)
            val bg = GradientDrawable().apply {
                setColor(if (openCount > 0) Color.parseColor("#372E15") else Color.parseColor("#153728"))
                cornerRadius = 16f
                setStroke(2, if (openCount > 0) colorYellow else colorGreen)
            }
            background = bg
        }
        badgeRow.addView(tvOpenBadge)

        headerLayout.addView(tvHeaderTitle)
        headerLayout.addView(badgeRow)
        headerCard.addView(headerLayout)
        container.addView(headerCard)

        // 2. Filter Buttons Row
        val filterRow = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { setMargins(0, 0, 0, 18) }
        }

        fun createFilterButton(label: String, filterKey: String): Button {
            return Button(ctx, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                layoutParams = LinearLayout.LayoutParams(0, 80, 1f).apply {
                    marginEnd = 6
                }
                text = label
                textSize = 10.5f
                val isSelected = activeFilter == filterKey
                setTextColor(if (isSelected) colorAccent else colorMuted)
                alpha = if (isSelected) 1.0f else 0.6f
                setOnClickListener {
                    activeFilter = filterKey
                    renderUI()
                }
            }
        }

        filterRow.addView(createFilterButton("Semua", "all"))
        filterRow.addView(createFilterButton("Open", "open"))
        filterRow.addView(createFilterButton("Resolved", "resolved"))
        filterRow.addView(createFilterButton("Closed", "closed"))
        container.addView(filterRow)

        // Filter List
        val filteredList = allTickets.filter { t ->
            val status = t.optString("status", "open").lowercase()
            when (activeFilter) {
                "open" -> status == "open" || status == "in_progress" || status == "assigned"
                "resolved" -> status == "resolved"
                "closed" -> status == "closed"
                else -> true
            }
        }

        if (filteredList.isEmpty()) {
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
                text = "Tidak ada tiket untuk kategori ini."
                setTextColor(colorMuted)
                textSize = 13f
            }
            emptyLayout.addView(tvEmpty)
            emptyCard.addView(emptyLayout)
            container.addView(emptyCard)
            return
        }

        // 3. Ticket Cards
        for (ticket in filteredList) {
            val id = ticket.optInt("id")
            val custName = ticket.optString("customer_name", "Pelanggan")
            val subject = ticket.optString("subject", "Keluhan Gangguan")
            val message = ticket.optString("message", "-")
            val status = ticket.optString("status", "open").lowercase()
            val createdAt = ticket.optString("created_at", "-")

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

            // Top Row (Customer Name + Status Badge)
            val topRow = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            val tvCust = TextView(ctx).apply {
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                text = "#TCK-$id • $custName"
                setTextColor(colorWhite)
                textSize = 14.5f
                setTypeface(null, Typeface.BOLD)
            }

            val tvStatusBadge = TextView(ctx).apply {
                textSize = 11f
                setTypeface(null, Typeface.BOLD)
                setPadding(16, 6, 16, 6)

                when (status) {
                    "open", "in_progress", "assigned" -> {
                        text = " ⏳ OPEN "
                        setTextColor(colorYellow)
                        val bg = GradientDrawable().apply {
                            setColor(Color.parseColor("#372E15"))
                            cornerRadius = 14f
                            setStroke(2, colorYellow)
                        }
                        background = bg
                    }
                    "resolved" -> {
                        text = " ✅ RESOLVED "
                        setTextColor(colorGreen)
                        val bg = GradientDrawable().apply {
                            setColor(Color.parseColor("#153728"))
                            cornerRadius = 14f
                            setStroke(2, colorGreen)
                        }
                        background = bg
                    }
                    else -> {
                        text = " 🔒 CLOSED "
                        setTextColor(colorMuted)
                        val bg = GradientDrawable().apply {
                            setColor(Color.parseColor("#27272A"))
                            cornerRadius = 14f
                            setStroke(2, colorMuted)
                        }
                        background = bg
                    }
                }
            }
            topRow.addView(tvCust)
            topRow.addView(tvStatusBadge)
            cardLayout.addView(topRow)

            // Subject
            val tvSubject = TextView(ctx).apply {
                text = subject
                setTextColor(colorAccent)
                textSize = 13.5f
                setTypeface(null, Typeface.BOLD)
                setPadding(0, 10, 0, 4)
            }
            cardLayout.addView(tvSubject)

            // Message
            val tvMessage = TextView(ctx).apply {
                text = message
                setTextColor(colorWhite)
                textSize = 12.5f
                setPadding(0, 0, 0, 8)
            }
            cardLayout.addView(tvMessage)

            // Created At
            val tvDate = TextView(ctx).apply {
                text = "📅 Diajukan: $createdAt"
                setTextColor(colorMuted)
                textSize = 11f
            }
            cardLayout.addView(tvDate)

            card.addView(cardLayout)
            container.addView(card)
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
            text = "⚠️ Gagal mengambil daftar tiket.\nTarik ke bawah untuk memuat ulang."
            setTextColor(colorMuted)
            textSize = 13f
            gravity = Gravity.CENTER
        }
        val btnRetry = Button(ctx, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
            text = "Coba Lagi"
            setTextColor(colorAccent)
            setOnClickListener { loadTickets() }
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
