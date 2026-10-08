package com.alijaya.customer.ui.admin

import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.cardview.widget.CardView
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.alijaya.customer.CustomerApplication
import com.alijaya.customer.databinding.FragmentAdminBackupBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale
import java.util.concurrent.TimeUnit

class AdminBackupFragment : Fragment() {
    private var _binding: FragmentAdminBackupBinding? = null
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

    private var backupList = mutableListOf<JSONObject>()

    private fun httpClient() = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    private fun getBaseUrl(): String {
        val base = CustomerApplication.sessionManager.getServerBaseUrl()
        return if (base.endsWith("/")) base.dropLast(1) else base
    }

    private fun getToken(): String = CustomerApplication.sessionManager.getAuthToken()

    override fun onCreateView(
        inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?
    ): View {
        _binding = FragmentAdminBackupBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        binding.swipeRefresh.setOnRefreshListener {
            loadBackups()
        }

        loadBackups()
    }

    private fun loadBackups() {
        binding.swipeRefresh.isRefreshing = true
        lifecycleScope.launch {
            val url = "${getBaseUrl()}/api/customer/app/admin/backups"
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
                    backupList.clear()
                    for (i in 0 until arr.length()) {
                        backupList.add(arr.getJSONObject(i))
                    }
                    renderUI()
                    return@launch
                } catch (_: Exception) {}
            }

            renderErrorUI()
        }
    }

    private fun formatFileSize(sizeObj: Any?): String {
        if (sizeObj == null) return "-"
        if (sizeObj is String) {
            val s = sizeObj.trim()
            if (s.endsWith("B", ignoreCase = true) || s.endsWith("KB", ignoreCase = true) || s.endsWith("MB", ignoreCase = true)) {
                return s
            }
            val num = s.toDoubleOrNull()
            if (num != null) return formatBytes(num)
            return s
        }
        if (sizeObj is Number) {
            return formatBytes(sizeObj.toDouble())
        }
        return sizeObj.toString()
    }

    private fun formatBytes(bytes: Double): String {
        return when {
            bytes >= 1024 * 1024 * 1024 -> String.format(Locale.US, "%.2f GB", bytes / (1024 * 1024 * 1024))
            bytes >= 1024 * 1024 -> String.format(Locale.US, "%.2f MB", bytes / (1024 * 1024))
            bytes >= 1024 -> String.format(Locale.US, "%.1f KB", bytes / 1024)
            else -> "${bytes.toLong()} B"
        }
    }

    private fun renderUI() {
        val ctx = context ?: return
        val container = binding.contentContainer
        container.removeAllViews()

        // 1. Header & Action Card
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
            text = "💾 Cadangan Data (Backup)"
            setTextColor(colorWhite)
            textSize = 18f
            setTypeface(null, Typeface.BOLD)
        }
        val tvHeaderDesc = TextView(ctx).apply {
            text = "Buat salinan data sistem billing, invoice, dan profil pelanggan untuk menjaga keutuhan data server."
            setTextColor(colorMuted)
            textSize = 12f
            setPadding(0, 6, 0, 16)
        }

        val btnCreateBackup = Button(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                110
            )
            text = "⚡ Buat Backup Database Baru Sekarang"
            textSize = 13f
            setTypeface(null, Typeface.BOLD)
            setBackgroundColor(colorBlue)
            setTextColor(colorWhite)
            setOnClickListener {
                confirmCreateBackup()
            }
        }

        headerLayout.addView(tvHeaderTitle)
        headerLayout.addView(tvHeaderDesc)
        headerLayout.addView(btnCreateBackup)
        headerCard.addView(headerLayout)
        container.addView(headerCard)

        // 2. Backups List Section
        val tvListTitle = TextView(ctx).apply {
            text = "📦 Berkas Cadangan Tersimpan (${backupList.size})"
            setTextColor(colorAccent)
            textSize = 14f
            setTypeface(null, Typeface.BOLD)
            setPadding(8, 6, 8, 12)
        }
        container.addView(tvListTitle)

        if (backupList.isEmpty()) {
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
                text = "Belum ada berkas backup yang tersimpan."
                setTextColor(colorMuted)
                textSize = 13f
            }
            emptyLayout.addView(tvEmpty)
            emptyCard.addView(emptyLayout)
            container.addView(emptyCard)
            return
        }

        // List of Backup Cards
        for (backup in backupList) {
            val name = backup.optString("name", "backup.sqlite")
            val sizeRaw = backup.opt("size")
            val sizeFormatted = formatFileSize(sizeRaw)
            val date = backup.optString("date", "-")

            val card = CardView(ctx).apply {
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                ).apply { setMargins(0, 0, 0, 16) }
                radius = 24f
                setCardBackgroundColor(colorCard)
            }

            val cardLayout = LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(28, 24, 28, 24)
            }

            // Top Row
            val topRow = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            val tvIcon = TextView(ctx).apply {
                text = "🗄️"
                textSize = 20f
                setPadding(0, 0, 16, 0)
            }
            val tvName = TextView(ctx).apply {
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                text = name
                setTextColor(colorWhite)
                textSize = 13.5f
                setTypeface(null, Typeface.BOLD)
            }
            val tvSize = TextView(ctx).apply {
                text = sizeFormatted
                setTextColor(colorGreen)
                textSize = 12f
                setTypeface(null, Typeface.BOLD)
            }
            topRow.addView(tvIcon)
            topRow.addView(tvName)
            topRow.addView(tvSize)
            cardLayout.addView(topRow)

            // Date Row
            val tvDate = TextView(ctx).apply {
                text = "📅 Dibuat: $date"
                setTextColor(colorMuted)
                textSize = 11.5f
                setPadding(36, 6, 0, 0)
            }
            cardLayout.addView(tvDate)

            card.addView(cardLayout)
            container.addView(card)
        }
    }

    private fun confirmCreateBackup() {
        val ctx = context ?: return
        AlertDialog.Builder(ctx)
            .setTitle("💾 Konfirmasi Cadangan")
            .setMessage("Apakah Anda yakin ingin membuat cadangan database baru sekarang? Proses ini akan membuat snapshot lengkap data sistem.")
            .setPositiveButton("Ya, Buat Backup") { _, _ ->
                processCreateBackup()
            }
            .setNegativeButton("Batal", null)
            .show()
    }

    private fun processCreateBackup() {
        val ctx = context ?: return
        Toast.makeText(ctx, "Membuat backup database di server...", Toast.LENGTH_SHORT).show()
        binding.swipeRefresh.isRefreshing = true

        lifecycleScope.launch {
            val url = "${getBaseUrl()}/api/customer/app/admin/backup/create"
            val success = withContext(Dispatchers.IO) {
                try {
                    val emptyBody = "{}".toRequestBody("application/json".toMediaType())
                    val req = Request.Builder().url(url)
                        .addHeader("Authorization", "Bearer ${getToken()}")
                        .post(emptyBody).build()
                    val resp = httpClient().newCall(req).execute()
                    resp.isSuccessful
                } catch (_: Exception) { false }
            }

            binding.swipeRefresh.isRefreshing = false

            if (success) {
                Toast.makeText(ctx, "✅ Backup database berhasil dibuat!", Toast.LENGTH_LONG).show()
                loadBackups()
            } else {
                Toast.makeText(ctx, "Gagal membuat backup di server", Toast.LENGTH_LONG).show()
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
            text = "⚠️ Gagal mengambil daftar berkas backup.\nTarik ke bawah untuk memuat ulang."
            setTextColor(colorMuted)
            textSize = 13f
            gravity = Gravity.CENTER
        }
        val btnRetry = Button(ctx, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
            text = "Coba Lagi"
            setTextColor(colorAccent)
            setOnClickListener { loadBackups() }
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
