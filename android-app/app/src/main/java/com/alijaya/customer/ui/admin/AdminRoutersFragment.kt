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
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.cardview.widget.CardView
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.alijaya.customer.CustomerApplication
import com.alijaya.customer.databinding.FragmentAdminRoutersBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale
import java.util.concurrent.TimeUnit

class AdminRoutersFragment : Fragment() {

    private var _binding: FragmentAdminRoutersBinding? = null
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

    private val routersList = mutableListOf<JSONObject>()

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
        _binding = FragmentAdminRoutersBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        binding.swipeRefresh.setColorSchemeColors(colorAccent, colorBlue, colorGreen)
        binding.swipeRefresh.setProgressBackgroundColorSchemeColor(colorCardDark)

        binding.swipeRefresh.setOnRefreshListener {
            loadRouters()
        }

        loadRouters()
    }

    private fun loadRouters() {
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
            val url = "${getBaseUrl()}/api/customer/app/admin/routers"
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
                    val arr = json.optJSONArray("data") ?: JSONArray()
                    routersList.clear()
                    for (i in 0 until arr.length()) {
                        routersList.add(arr.getJSONObject(i))
                    }
                    renderRouters()
                    return@launch
                } catch (e: Exception) {
                    // Fallthrough to error
                }
            }

            renderEmptyState("Gagal memuat daftar router MikroTik.")
            if (isAdded) {
                Toast.makeText(ctx, "Gagal memuat daftar router", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun renderRouters() {
        val ctx = context ?: return
        val container = binding.contentContainer
        container.removeAllViews()

        val activeCount = routersList.count { it.optInt("is_active", 1) == 1 }

        // 1. Header Summary Card
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

        val summaryContent = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 28, 32, 28)
        }

        val tvHeader = TextView(ctx).apply {
            text = "🌐 Router MikroTik Gateway"
            setTextColor(colorTextWhite)
            textSize = 18f
            setTypeface(null, Typeface.BOLD)
        }

        val tvSubHeader = TextView(ctx).apply {
            text = "Total ${routersList.size} router terdaftar • $activeCount aktif"
            setTextColor(colorTextMuted)
            textSize = 12.5f
            setPadding(0, 6, 0, 0)
        }

        summaryContent.addView(tvHeader)
        summaryContent.addView(tvSubHeader)
        summaryCard.addView(summaryContent)
        container.addView(summaryCard)

        if (routersList.isEmpty()) {
            renderEmptyState("Belum ada router MikroTik yang terdaftar.")
            return
        }

        // Section Title
        val tvSection = TextView(ctx).apply {
            text = "📋 Daftar Unit Router"
            setTextColor(colorTextWhite)
            textSize = 16f
            setTypeface(null, Typeface.BOLD)
            setPadding(8, 4, 0, 14)
        }
        container.addView(tvSection)

        // List Routers
        for (router in routersList) {
            val routerId = router.optInt("id", 0)
            val name = router.optString("name", "Router MikroTik")
            val host = router.optString("host", "127.0.0.1")
            val port = router.optInt("port", 8728)
            val isActive = router.optInt("is_active", 1) == 1
            val createdAt = router.optString("created_at", "-")

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
                setPadding(28, 24, 28, 24)
            }

            // Top Row: Name & Status Badge
            val topRow = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }

            val tvName = TextView(ctx).apply {
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                text = "⚡ $name"
                setTextColor(colorTextWhite)
                textSize = 16f
                setTypeface(null, Typeface.BOLD)
            }

            val badgeBg = if (isActive) Color.parseColor("#16A34A") else Color.parseColor("#DC2626")
            val badgeColor = Color.WHITE
            val badgeText = if (isActive) "● AKTIF" else "● NONAKTIF"

            val badgeDrawable = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = 14f
                setColor(badgeBg)
            }

            val tvBadge = TextView(ctx).apply {
                text = badgeText
                setTextColor(badgeColor)
                textSize = 11.5f
                setTypeface(null, Typeface.BOLD)
                setPadding(18, 8, 18, 8)
                background = badgeDrawable
            }

            topRow.addView(tvName)
            topRow.addView(tvBadge)
            cardLayout.addView(topRow)

            // Details Layout
            val detailsLayout = LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(0, 12, 0, 0)
            }

            val tvHost = TextView(ctx).apply {
                text = "🌐 Host / IP: $host"
                setTextColor(colorAccent)
                textSize = 13.5f
                setTypeface(null, Typeface.BOLD)
                setPadding(0, 0, 0, 4)
            }

            val tvPort = TextView(ctx).apply {
                text = "🔌 Port API: $port (Winbox / API MikroTik)"
                setTextColor(colorTextMuted)
                textSize = 12f
                setPadding(0, 0, 0, 4)
            }

            val tvCreated = TextView(ctx).apply {
                text = "📅 Terdaftar sejak: $createdAt"
                setTextColor(colorTextMuted)
                textSize = 11f
                setPadding(0, 4, 0, 0)
            }

            detailsLayout.addView(tvHost)
            detailsLayout.addView(tvPort)
            detailsLayout.addView(tvCreated)
            cardLayout.addView(detailsLayout)

            card.addView(cardLayout)
            container.addView(card)
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
            text = "🌐"
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
