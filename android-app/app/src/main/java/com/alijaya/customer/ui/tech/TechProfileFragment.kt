package com.alijaya.customer.ui.tech

import android.content.Intent
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.appcompat.app.AlertDialog
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.alijaya.customer.CustomerApplication
import com.alijaya.customer.databinding.FragmentTechProfileBinding
import com.alijaya.customer.ui.server.ServerConfigActivity
import com.alijaya.customer.ui.login.LoginActivity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class TechProfileFragment : Fragment() {
    private var _binding: FragmentTechProfileBinding? = null
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
        _binding = FragmentTechProfileBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        val session = CustomerApplication.sessionManager
        val techName = session.getCustomerName().ifEmpty { "Teknisi Lapangan" }
        binding.tvProfileName.text = techName

        binding.btnPrinterConfig.setOnClickListener {
            startActivity(Intent(context, ServerConfigActivity::class.java))
        }

        binding.btnTechLogout.setOnClickListener {
            val act = activity ?: return@setOnClickListener
            AlertDialog.Builder(act)
                .setTitle("🚪 Konfirmasi Keluar")
                .setMessage("Apakah Anda yakin ingin logout dari akun Teknisi?")
                .setPositiveButton("Ya, Logout") { _, _ ->
                    session.logout()
                    val intent = Intent(act, LoginActivity::class.java).apply {
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
                    }
                    startActivity(intent)
                    act.finish()
                }
                .setNegativeButton("Batal", null)
                .show()
        }

        fetchProfileStats()
    }

    private fun fetchProfileStats() {
        lifecycleScope.launch {
            val url = "${getBaseUrl()}/api/customer/app/tech/dashboard"
            val responseStr = withContext(Dispatchers.IO) {
                try {
                    val req = Request.Builder().url(url)
                        .addHeader("Authorization", "Bearer ${getToken()}")
                        .build()
                    val resp = httpClient().newCall(req).execute()
                    if (resp.isSuccessful) resp.body?.string() else null
                } catch (_: Exception) { null }
            }

            if (responseStr != null) {
                try {
                    val json = JSONObject(responseStr)
                    val data = json.optJSONObject("data")
                    if (data != null) {
                        val tech = data.optJSONObject("tech")
                        if (tech != null) {
                            val name = tech.optString("name", "Teknisi Lapangan")
                            val area = tech.optString("area", "Semua Wilayah")
                            binding.tvProfileName.text = name
                            binding.tvProfileArea.text = "📍 Area: $area"
                        }

                        val stats = data.optJSONObject("stats")
                        if (stats != null) {
                            binding.tvStatTotalDone.text = stats.optInt("resolved", 0).toString()
                            binding.tvStatActive.text = stats.optInt("inProgress", 0).toString()
                        }
                    }
                } catch (_: Exception) {}
            }
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}
