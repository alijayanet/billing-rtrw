package com.alijaya.customer.ui.tech

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.cardview.widget.CardView
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.alijaya.customer.CustomerApplication
import com.alijaya.customer.R
import com.alijaya.customer.databinding.FragmentTechOltBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class TechOltFragment : Fragment() {
    private var _binding: FragmentTechOltBinding? = null
    private val binding get() = _binding!!

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
        _binding = FragmentTechOltBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        binding.swipeRefresh.setOnRefreshListener { fetchOlts() }

        binding.btnSendReboot.setOnClickListener {
            val target = binding.etRebootTarget.text.toString().trim()
            if (target.isBlank()) {
                Toast.makeText(context, "Masukkan PPPoE Username atau No. HP pelanggan", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }

            AlertDialog.Builder(requireContext())
                .setTitle("🔄 Konfirmasi Remote Reboot")
                .setMessage("Kirim perintah restart modem ONT untuk pelanggan '$target'?")
                .setPositiveButton("Ya, Restart") { _, _ ->
                    sendRebootCommand(target)
                }
                .setNegativeButton("Batal", null)
                .show()
        }

        fetchOlts()
    }

    private fun sendRebootCommand(target: String) {
        binding.btnSendReboot.isEnabled = false
        binding.btnSendReboot.text = "Mengirim Perintah Reboot..."

        lifecycleScope.launch {
            val url = "${getBaseUrl()}/api/customer/app/tech/onu/restart"
            val jsonBody = JSONObject().apply {
                put("pppoeUsername", target)
            }.toString()

            val respStr = withContext(Dispatchers.IO) {
                try {
                    val body = jsonBody.toRequestBody("application/json".toMediaType())
                    val req = Request.Builder().url(url)
                        .addHeader("Authorization", "Bearer ${getToken()}")
                        .post(body).build()
                    val resp = httpClient().newCall(req).execute()
                    if (resp.isSuccessful) resp.body?.string() else null
                } catch (_: Exception) { null }
            }

            binding.btnSendReboot.isEnabled = true
            binding.btnSendReboot.text = "Kirim Perintah Reboot"

            if (respStr != null) {
                try {
                    val json = JSONObject(respStr)
                    val msg = json.optString("message", "Perintah Reboot berhasil dikirim!")
                    AlertDialog.Builder(requireContext())
                        .setTitle("✅ Perintah Berhasil Dikirim")
                        .setMessage(msg)
                        .setPositiveButton("OK", null)
                        .show()
                    binding.etRebootTarget.text.clear()
                } catch (_: Exception) {
                    Toast.makeText(context, "Perintah reboot terkirim", Toast.LENGTH_SHORT).show()
                }
            } else {
                Toast.makeText(context, "Gagal mengirim reboot. Pastikan perangkat online di TR-069.", Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun fetchOlts() {
        binding.swipeRefresh.isRefreshing = true
        lifecycleScope.launch {
            val url = "${getBaseUrl()}/api/customer/app/tech/olts"
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
                    renderOlts(arr)
                } catch (_: Exception) {}
            }
        }
    }

    private fun renderOlts(arr: JSONArray) {
        val container = binding.layoutOltList
        container.removeAllViews()

        if (arr.length() == 0) {
            val tv = TextView(context).apply {
                text = "Belum ada OLT yang terkonfigurasi pada server."
                setTextColor(resources.getColor(R.color.text_muted, null))
                setPadding(10, 10, 10, 10)
            }
            container.addView(tv)
            return
        }

        for (i in 0 until arr.length()) {
            val obj = arr.getJSONObject(i)
            val name = obj.optString("name", "OLT")
            val brand = obj.optString("brand", "ZTE / Huawei / VSOL").uppercase()
            val host = obj.optString("host", "-")
            val ponCount = obj.optInt("pon_count", 8)
            val status = obj.optString("status", "online")

            val card = CardView(requireContext()).apply {
                radius = 12f * resources.displayMetrics.density
                setCardBackgroundColor(0xFF132742.toInt())
                cardElevation = 3f
                layoutParams = ViewGroup.MarginLayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply {
                    bottomMargin = (8 * resources.displayMetrics.density).toInt()
                }
            }

            val inner = android.widget.LinearLayout(context).apply {
                orientation = android.widget.LinearLayout.VERTICAL
                setPadding(36, 32, 36, 32)
            }

            val tvTitle = TextView(context).apply {
                text = "📶 $name ($brand)"
                setTextColor(0xFFFFFFFF.toInt())
                textSize = 14f
                typeface = android.graphics.Typeface.DEFAULT_BOLD
            }

            val tvDetail = TextView(context).apply {
                text = "🌐 Host: $host | PON Port: $ponCount Port | Status: 🟢 Terhubung"
                setTextColor(0xFF38BDF8.toInt())
                textSize = 11f
                setPadding(0, 6, 0, 0)
            }

            inner.addView(tvTitle)
            inner.addView(tvDetail)
            card.addView(inner)
            container.addView(card)
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}
