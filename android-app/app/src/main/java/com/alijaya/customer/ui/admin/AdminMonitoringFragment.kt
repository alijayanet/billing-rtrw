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
import com.alijaya.customer.databinding.FragmentAdminMonitoringBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.util.Locale
import java.util.concurrent.TimeUnit

class AdminMonitoringFragment : Fragment() {

    private var _binding: FragmentAdminMonitoringBinding? = null
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
        _binding = FragmentAdminMonitoringBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        binding.swipeRefresh.setColorSchemeColors(colorAccent, colorBlue, colorGreen)
        binding.swipeRefresh.setProgressBackgroundColorSchemeColor(colorCardDark)

        binding.swipeRefresh.setOnRefreshListener {
            loadMonitoringData()
        }

        loadMonitoringData()
    }

    private fun loadMonitoringData() {
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
            val url = "${getBaseUrl()}/api/customer/app/admin/monitoring"
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
                        renderMonitoring(data)
                        return@launch
                    }
                } catch (e: Exception) {
                    // Fallthrough to error
                }
            }

            renderEmptyState("Gagal memuat status monitoring sistem.")
            if (isAdded) {
                Toast.makeText(ctx, "Gagal mengambil data monitoring", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun renderMonitoring(data: JSONObject) {
        val ctx = context ?: return
        val container = binding.contentContainer
        container.removeAllViews()

        // 1. Header Card
        val headerCard = CardView(ctx).apply {
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

        val headerLayout = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 28, 32, 28)
        }

        val tvTitle = TextView(ctx).apply {
            text = "📊 Monitoring Server & Node"
            setTextColor(colorTextWhite)
            textSize = 18f
            setTypeface(null, Typeface.BOLD)
        }

        val tvSub = TextView(ctx).apply {
            val platform = data.optString("platform", "Linux")
            val nodeVer = data.optString("nodeVersion", "-")
            text = "Platform: $platform • Node: $nodeVer"
            setTextColor(colorTextMuted)
            textSize = 12f
            setPadding(0, 6, 0, 0)
        }

        headerLayout.addView(tvTitle)
        headerLayout.addView(tvSub)
        headerCard.addView(headerLayout)
        container.addView(headerCard)

        // 2. Services Status Card
        val services = data.optJSONObject("services")
        if (services != null) {
            val servicesCard = createCard(ctx)
            val servicesLayout = LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(32, 28, 32, 28)
            }

            val tvSecServices = createSectionTitle(ctx, "⚙️ Status Layanan Utama")
            servicesLayout.addView(tvSecServices)

            val mikrotikStatus = services.optString("mikrotik", "unknown")
            val whatsappStatus = services.optString("whatsapp", "unknown")
            val databaseStatus = services.optString("database", "unknown")

            servicesLayout.addView(createServiceRow(ctx, "MikroTik Gateway", mikrotikStatus))
            servicesLayout.addView(createServiceRow(ctx, "WhatsApp Bot Daemon", whatsappStatus))
            servicesLayout.addView(createServiceRow(ctx, "Database SQLite/Engine", databaseStatus))

            servicesCard.addView(servicesLayout)
            container.addView(servicesCard)
        }

        // 3. CPU Card
        val cpu = data.optJSONObject("cpu")
        if (cpu != null) {
            val cpuPercent = cpu.optInt("percent", 0)
            val cpuCores = cpu.optInt("cores", 1)
            val cpuModel = cpu.optString("model", "Processor")

            val cpuCard = createCard(ctx)
            val cpuLayout = LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(32, 28, 32, 28)
            }

            val cpuHeaderRow = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }

            val tvCpuTitle = TextView(ctx).apply {
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                text = "🖥️ CPU Processor"
                setTextColor(colorTextWhite)
                textSize = 15f
                setTypeface(null, Typeface.BOLD)
            }

            val tvCpuPercent = TextView(ctx).apply {
                text = "$cpuPercent%"
                setTextColor(getMetricColor(cpuPercent))
                textSize = 17f
                setTypeface(null, Typeface.BOLD)
            }

            cpuHeaderRow.addView(tvCpuTitle)
            cpuHeaderRow.addView(tvCpuPercent)
            cpuLayout.addView(cpuHeaderRow)

            val tvCpuModel = TextView(ctx).apply {
                text = "$cpuModel ($cpuCores Core)"
                setTextColor(colorTextMuted)
                textSize = 12f
                setPadding(0, 4, 0, 8)
            }
            cpuLayout.addView(tvCpuModel)

            cpuLayout.addView(createProgressBar(ctx, cpuPercent, getMetricColor(cpuPercent)))

            cpuCard.addView(cpuLayout)
            container.addView(cpuCard)
        }

        // 4. Memory (RAM) Card
        val memory = data.optJSONObject("memory")
        if (memory != null) {
            val memPercent = memory.optInt("percent", 0)
            val totalMem = memory.optLong("total", 0L)
            val usedMem = memory.optLong("used", 0L)
            val freeMem = memory.optLong("free", 0L)

            val memCard = createCard(ctx)
            val memLayout = LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(32, 28, 32, 28)
            }

            val memHeaderRow = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }

            val tvMemTitle = TextView(ctx).apply {
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                text = "💾 RAM (Memory)"
                setTextColor(colorTextWhite)
                textSize = 15f
                setTypeface(null, Typeface.BOLD)
            }

            val tvMemPercent = TextView(ctx).apply {
                text = "$memPercent%"
                setTextColor(getMetricColor(memPercent))
                textSize = 17f
                setTypeface(null, Typeface.BOLD)
            }

            memHeaderRow.addView(tvMemTitle)
            memHeaderRow.addView(tvMemPercent)
            memLayout.addView(memHeaderRow)

            val tvMemDetails = TextView(ctx).apply {
                text = "Terpakai: ${formatBytes(usedMem)} / ${formatBytes(totalMem)} (Tersedia: ${formatBytes(freeMem)})"
                setTextColor(colorTextMuted)
                textSize = 12f
                setPadding(0, 4, 0, 8)
            }
            memLayout.addView(tvMemDetails)

            memLayout.addView(createProgressBar(ctx, memPercent, getMetricColor(memPercent)))

            memCard.addView(memLayout)
            container.addView(memCard)
        }

        // 5. Disk Storage Card
        val disk = data.optJSONObject("disk")
        if (disk != null) {
            val diskPercent = disk.optInt("percent", 0)
            val totalDisk = disk.optLong("total", 0L)
            val usedDisk = disk.optLong("used", 0L)
            val freeDisk = disk.optLong("free", 0L)

            val diskCard = createCard(ctx)
            val diskLayout = LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(32, 28, 32, 28)
            }

            val diskHeaderRow = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }

            val tvDiskTitle = TextView(ctx).apply {
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                text = "💽 Disk Storage"
                setTextColor(colorTextWhite)
                textSize = 15f
                setTypeface(null, Typeface.BOLD)
            }

            val tvDiskPercent = TextView(ctx).apply {
                text = "$diskPercent%"
                setTextColor(getMetricColor(diskPercent))
                textSize = 17f
                setTypeface(null, Typeface.BOLD)
            }

            diskHeaderRow.addView(tvDiskTitle)
            diskHeaderRow.addView(tvDiskPercent)
            diskLayout.addView(diskHeaderRow)

            val tvDiskDetails = TextView(ctx).apply {
                text = "Terpakai: ${formatBytes(usedDisk)} / ${formatBytes(totalDisk)} (Free: ${formatBytes(freeDisk)})"
                setTextColor(colorTextMuted)
                textSize = 12f
                setPadding(0, 4, 0, 8)
            }
            diskLayout.addView(tvDiskDetails)

            diskLayout.addView(createProgressBar(ctx, diskPercent, getMetricColor(diskPercent)))

            diskCard.addView(diskLayout)
            container.addView(diskCard)
        }

        // 6. Uptime & Node Version Card
        val uptimeSeconds = data.optLong("uptime", 0L)
        val uptimeCard = createCard(ctx)
        val uptimeLayout = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 28, 32, 28)
        }

        val tvUptimeSec = createSectionTitle(ctx, "⏱️ Server Uptime & Lingkungan")
        uptimeLayout.addView(tvUptimeSec)

        val tvUptimeVal = TextView(ctx).apply {
            text = formatUptime(uptimeSeconds)
            setTextColor(colorGreen)
            textSize = 16f
            setTypeface(null, Typeface.BOLD)
            setPadding(0, 4, 0, 6)
        }
        uptimeLayout.addView(tvUptimeVal)

        val tvUptimeDesc = TextView(ctx).apply {
            text = "Waktu nyala server sejak booting terakhir tanpa restart."
            setTextColor(colorTextMuted)
            textSize = 11.5f
        }
        uptimeLayout.addView(tvUptimeDesc)

        uptimeCard.addView(uptimeLayout)
        container.addView(uptimeCard)
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

    private fun createSectionTitle(ctx: Context, title: String): TextView {
        return TextView(ctx).apply {
            text = title
            setTextColor(colorTextWhite)
            textSize = 15f
            setTypeface(null, Typeface.BOLD)
            setPadding(0, 0, 0, 10)
        }
    }

    private fun createServiceRow(ctx: Context, name: String, status: String): LinearLayout {
        val row = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, 8, 0, 8)
        }

        val tvName = TextView(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
            text = name
            setTextColor(colorTextWhite)
            textSize = 13.5f
        }

        val isOk = status.equals("ok", ignoreCase = true) ||
                status.equals("configured", ignoreCase = true) ||
                status.equals("connected", ignoreCase = true) ||
                status.equals("active", ignoreCase = true)

        val badgeText = when {
            status.equals("connected", true) -> "● TERHUBUNG"
            status.equals("configured", true) -> "● TERHUBUNG"
            status.equals("ok", true) -> "● NORMAL"
            status.equals("disconnected", true) -> "● TERPUTUS"
            status.equals("not_available", true) -> "● NONAKTIF"
            else -> "● ${status.uppercase(Locale.ROOT)}"
        }

        val badgeColor = if (isOk) colorGreen else colorRed
        val badgeBg = if (isOk) Color.parseColor("#224ADE80") else Color.parseColor("#22EF4444")

        val badgeDrawable = GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = 14f
            setColor(badgeBg)
        }

        val tvBadge = TextView(ctx).apply {
            text = badgeText
            setTextColor(badgeColor)
            textSize = 11f
            setTypeface(null, Typeface.BOLD)
            setPadding(16, 6, 16, 6)
            background = badgeDrawable
        }

        row.addView(tvName)
        row.addView(tvBadge)
        return row
    }

    private fun createProgressBar(context: Context, percent: Int, progressColor: Int): View {
        val safePercent = percent.coerceIn(0, 100)
        val bg = LinearLayout(context).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                18
            ).apply {
                setMargins(0, 10, 0, 10)
            }
            val bgDrawable = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = 9f
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
                cornerRadius = 9f
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

    private fun getMetricColor(percent: Int): Int {
        return when {
            percent >= 85 -> colorRed
            percent >= 60 -> colorYellow
            else -> colorGreen
        }
    }

    private fun formatBytes(bytes: Long): String {
        if (bytes <= 0) return "0 B"
        val units = arrayOf("B", "KB", "MB", "GB", "TB")
        val digitGroups = (Math.log10(bytes.toDouble()) / Math.log10(1024.0)).toInt()
        val groupIndex = digitGroups.coerceIn(0, units.size - 1)
        val value = bytes / Math.pow(1024.0, groupIndex.toDouble())
        return String.format(Locale.US, "%.1f %s", value, units[groupIndex])
    }

    private fun formatUptime(seconds: Long): String {
        if (seconds <= 0) return "0 Menit"
        val days = seconds / 86400
        val hours = (seconds % 86400) / 3600
        val minutes = (seconds % 3600) / 60
        val secs = seconds % 60
        val parts = mutableListOf<String>()
        if (days > 0) parts.add("$days Hari")
        if (hours > 0) parts.add("$hours Jam")
        if (minutes > 0) parts.add("$minutes Menit")
        if (parts.isEmpty()) parts.add("$secs Detik")
        return parts.joinToString(" ")
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
