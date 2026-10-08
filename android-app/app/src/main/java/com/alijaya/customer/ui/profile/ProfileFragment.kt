package com.alijaya.customer.ui.profile

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Toast
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.alijaya.customer.CustomerApplication
import com.alijaya.customer.databinding.FragmentProfileBinding
import com.alijaya.customer.ui.login.LoginActivity
import com.alijaya.customer.ui.server.ServerConfigActivity
import com.alijaya.customer.util.AppUpdateHelper
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class ProfileFragment : Fragment() {
    private var _binding: FragmentProfileBinding? = null
    private val binding get() = _binding!!

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentProfileBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        val session = CustomerApplication.sessionManager

        binding.tvCustomerName.text = session.getCustomerName()
        binding.tvCustomerPhone.text = session.getCustomerPhone()
        binding.tvServerUrl.text = "Server: " + session.getServerBaseUrl()

        binding.btnCheckUpdate.setOnClickListener {
            val act = activity ?: return@setOnClickListener
            AppUpdateHelper.checkForUpdate(act, showToastIfLatest = true)
        }

        binding.btnChangeServer.setOnClickListener {
            startActivity(Intent(context, ServerConfigActivity::class.java))
        }

        binding.btnWhatsappCs.setOnClickListener {
            val phone = session.getFormattedAdminPhone()
            if (phone.isNotBlank()) {
                val url = "https://wa.me/" + phone + "?text=Halo%20Admin%20saya%20pelanggan%20" + Uri.encode(session.getCustomerName())
                try {
                    startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                } catch (_: Exception) {
                    Toast.makeText(context, "Tidak dapat membuka aplikasi WhatsApp.", Toast.LENGTH_SHORT).show()
                }
            } else {
                val act = activity ?: return@setOnClickListener
                val base = session.getServerBaseUrl().removeSuffix("/")
                lifecycleScope.launch(Dispatchers.IO) {
                    var livePhone = ""
                    try {
                        val client = OkHttpClient.Builder().connectTimeout(4, TimeUnit.SECONDS).build()
                        val req = Request.Builder().url("$base/api/customer/ping").build()
                        val resp = client.newCall(req).execute()
                        val body = resp.body?.string()
                        if (!body.isNullOrBlank()) {
                            val json = JSONObject(body)
                            livePhone = json.optString("companyPhone", json.optString("adminPhone", ""))
                        }
                    } catch (_: Exception) {}

                    withContext(Dispatchers.Main) {
                        if (livePhone.isNotBlank()) {
                            session.saveAdminPhone(livePhone)
                            val formatted = session.formatWhatsappNumber(livePhone)
                            val url = "https://wa.me/" + formatted + "?text=Halo%20Admin%20saya%20pelanggan%20" + Uri.encode(session.getCustomerName())
                            try {
                                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                            } catch (_: Exception) {
                                Toast.makeText(act, "Tidak dapat membuka aplikasi WhatsApp.", Toast.LENGTH_SHORT).show()
                            }
                        } else {
                            Toast.makeText(act, "Nomor WhatsApp admin belum dikonfigurasi di server.", Toast.LENGTH_LONG).show()
                        }
                    }
                }
            }
        }

        binding.btnLogout.setOnClickListener {
            session.logout()
            val intent = Intent(context, LoginActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
            }
            startActivity(intent)
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}
