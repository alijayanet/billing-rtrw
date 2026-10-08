package com.alijaya.customer.ui.admin

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
import com.alijaya.customer.databinding.FragmentAdminPackagesBinding
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

class AdminPackagesFragment : Fragment() {

    private var _binding: FragmentAdminPackagesBinding? = null
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

    private val packagesList = mutableListOf<JSONObject>()

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
        _binding = FragmentAdminPackagesBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        binding.swipeRefresh.setColorSchemeColors(colorAccent, colorBlue, colorGreen)
        binding.swipeRefresh.setProgressBackgroundColorSchemeColor(colorCardDark)

        binding.swipeRefresh.setOnRefreshListener {
            loadPackages()
        }

        loadPackages()
    }

    private fun loadPackages() {
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
            val url = "${getBaseUrl()}/api/customer/app/admin/packages"
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
                    packagesList.clear()
                    for (i in 0 until arr.length()) {
                        packagesList.add(arr.getJSONObject(i))
                    }
                    renderPackages()
                    return@launch
                } catch (e: Exception) {
                    // Fallthrough to render error
                }
            }

            renderEmptyState("Gagal memuat daftar paket atau server tidak merespon.")
            if (isAdded) {
                Toast.makeText(ctx, "Gagal memuat daftar paket", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun renderPackages() {
        val ctx = context ?: return
        val container = binding.contentContainer
        container.removeAllViews()

        val fmt = NumberFormat.getCurrencyInstance(Locale("id", "ID"))
        fmt.maximumFractionDigits = 0

        // Header Summary Card
        val summaryCard = CardView(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply {
                setMargins(0, 0, 0, 24)
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
            text = "📦 Paket Layanan Internet"
            setTextColor(colorTextWhite)
            textSize = 18f
            setTypeface(null, Typeface.BOLD)
        }

        val tvSubHeader = TextView(ctx).apply {
            text = "Total ${packagesList.size} paket terkonfigurasi pada sistem"
            setTextColor(colorTextMuted)
            textSize = 12.5f
            setPadding(0, 6, 0, 0)
        }

        summaryContent.addView(tvHeader)
        summaryContent.addView(tvSubHeader)
        summaryCard.addView(summaryContent)
        container.addView(summaryCard)

        if (packagesList.isEmpty()) {
            renderEmptyState("Belum ada paket internet yang terdaftar.")
            return
        }

        for (pkg in packagesList) {
            val pkgId = pkg.optInt("id", 0)
            val name = pkg.optString("name", "Paket Tanpa Nama")
            val price = pkg.optDouble("price", 0.0)
            val speed = pkg.optString("speed", "-")
            val billingType = pkg.optString("billing_type", "bulanan")
            val profileMikrotik = pkg.optString("profile_mikrotik", "")
            val description = pkg.optString("description", "")
            val isActive = pkg.optInt("is_active", 1) == 1

            val card = CardView(ctx).apply {
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

            val cardLayout = LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(32, 28, 32, 28)
            }

            // Top Row: Name and Type Badge
            val topRow = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }

            val tvPkgName = TextView(ctx).apply {
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                text = name
                setTextColor(colorTextWhite)
                textSize = 16f
                setTypeface(null, Typeface.BOLD)
            }

            val badgeDrawable = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = 16f
                setColor(Color.parseColor("#3338BDF8"))
            }

            val tvBillingType = TextView(ctx).apply {
                text = billingType.uppercase(Locale.ROOT)
                setTextColor(colorAccent)
                textSize = 10.5f
                setTypeface(null, Typeface.BOLD)
                setPadding(20, 8, 20, 8)
                background = badgeDrawable
            }

            topRow.addView(tvPkgName)
            topRow.addView(tvBillingType)
            cardLayout.addView(topRow)

            // Price Row
            val priceRow = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.BOTTOM
                setPadding(0, 14, 0, 10)
            }

            val tvPrice = TextView(ctx).apply {
                text = fmt.format(price)
                setTextColor(colorGreen)
                textSize = 20f
                setTypeface(null, Typeface.BOLD)
            }

            val tvPeriod = TextView(ctx).apply {
                text = " / periode"
                setTextColor(colorTextMuted)
                textSize = 12f
                setPadding(8, 0, 0, 4)
            }

            priceRow.addView(tvPrice)
            priceRow.addView(tvPeriod)
            cardLayout.addView(priceRow)

            // Divider line
            val divider = View(ctx).apply {
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    2
                ).apply {
                    setMargins(0, 8, 0, 14)
                }
                setBackgroundColor(Color.parseColor("#334155"))
            }
            cardLayout.addView(divider)

            // Details section
            val detailsLayout = LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
            }

            if (speed.isNotBlank() && speed != "-") {
                val tvSpeed = TextView(ctx).apply {
                    text = "🚀 Kecepatan: $speed"
                    setTextColor(colorAccent)
                    textSize = 12.5f
                    setTypeface(null, Typeface.BOLD)
                    setPadding(0, 0, 0, 6)
                }
                detailsLayout.addView(tvSpeed)
            }

            if (profileMikrotik.isNotBlank()) {
                val tvProfile = TextView(ctx).apply {
                    text = "⚙️ Profile MikroTik: $profileMikrotik"
                    setTextColor(colorTextMuted)
                    textSize = 12f
                    setPadding(0, 0, 0, 6)
                }
                detailsLayout.addView(tvProfile)
            }

            if (description.isNotBlank()) {
                val tvDesc = TextView(ctx).apply {
                    text = "📝 $description"
                    setTextColor(colorTextMuted)
                    textSize = 11.5f
                    setPadding(0, 0, 0, 6)
                }
                detailsLayout.addView(tvDesc)
            }

            val statusText = if (isActive) "● Aktif Dipasarkan" else "○ Tidak Aktif"
            val statusColor = if (isActive) colorGreen else colorRed
            val tvStatus = TextView(ctx).apply {
                text = statusText
                setTextColor(statusColor)
                textSize = 11f
                setPadding(0, 4, 0, 0)
            }
            detailsLayout.addView(tvStatus)

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
            text = "📦"
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
