package com.alijaya.customer.ui.tech

import android.os.Bundle
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.alijaya.customer.CustomerApplication
import com.alijaya.customer.R
import com.alijaya.customer.databinding.FragmentTechTr069Binding
import com.alijaya.customer.databinding.ItemTechOnuBinding
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

class TechTr069Fragment : Fragment() {
    private var _binding: FragmentTechTr069Binding? = null
    private val binding get() = _binding!!

    private var allOnus = mutableListOf<JSONObject>()
    private lateinit var adapter: OnuAdapter

    private fun httpClient() = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .build()

    private fun getBaseUrl(): String {
        val base = CustomerApplication.sessionManager.getServerBaseUrl()
        return if (base.endsWith("/")) base.dropLast(1) else base
    }

    private fun getToken(): String = CustomerApplication.sessionManager.getAuthToken()

    override fun onCreateView(
        inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?
    ): View {
        _binding = FragmentTechTr069Binding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        adapter = OnuAdapter(
            onChangeSsid = { onu -> showChangeSsidDialog(onu) },
            onChangePassword = { onu -> showChangePasswordDialog(onu) },
            onReboot = { onu -> showRebootConfirmDialog(onu) }
        )

        binding.rvOnus.layoutManager = LinearLayoutManager(requireContext())
        binding.rvOnus.adapter = adapter

        binding.btnOpenOnuMap.setOnClickListener {
            parentFragmentManager.beginTransaction()
                .replace(R.id.fragment_container, com.alijaya.customer.ui.map.NetworkMapFragment())
                .addToBackStack(null)
                .commit()
        }

        binding.swipeRefresh.setOnRefreshListener {
            loadTr069Devices()
        }

        binding.etSearchOnu.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
                filterList(s.toString())
            }
            override fun afterTextChanged(s: Editable?) {}
        })

        loadTr069Devices()
    }

    private fun loadTr069Devices() {
        binding.swipeRefresh.isRefreshing = true
        viewLifecycleOwner.lifecycleScope.launch(Dispatchers.IO) {
            try {
                val url = "${getBaseUrl()}/api/customer/app/tech/tr069/devices"
                val req = Request.Builder()
                    .url(url)
                    .addHeader("Authorization", "Bearer ${getToken()}")
                    .build()
                val resp = httpClient().newCall(req).execute()
                val body = resp.body?.string() ?: ""
                val json = JSONObject(body)

                withContext(Dispatchers.Main) {
                    binding.swipeRefresh.isRefreshing = false
                    if (json.optBoolean("success")) {
                        val arr = json.optJSONArray("data") ?: JSONArray()
                        allOnus.clear()
                        var onlineCount = 0
                        for (i in 0 until arr.length()) {
                            val obj = arr.getJSONObject(i)
                            allOnus.add(obj)
                            if (obj.optString("status").equals("online", ignoreCase = true)) onlineCount++
                        }
                        binding.tvTr069Summary.text = "Total ONU TR-069: ${allOnus.size} | 🟢 Online: $onlineCount"
                        filterList(binding.etSearchOnu.text.toString())
                    } else {
                        binding.tvTr069Summary.text = json.optString("message", "Gagal memuat perangkat TR-069")
                    }
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    binding.swipeRefresh.isRefreshing = false
                    binding.tvTr069Summary.text = "Error koneksi TR-069: ${e.message}"
                }
            }
        }
    }

    private fun filterList(query: String) {
        val q = query.trim().lowercase()
        val filtered = if (q.isEmpty()) {
            allOnus
        } else {
            allOnus.filter {
                it.optString("customerName").lowercase().contains(q) ||
                it.optString("pppoeUsername").lowercase().contains(q) ||
                it.optString("serialNumber").lowercase().contains(q) ||
                it.optString("ssid").lowercase().contains(q) ||
                it.optString("customerPhone").lowercase().contains(q)
            }
        }
        adapter.submitList(filtered)
    }

    private fun showChangeSsidDialog(onu: JSONObject) {
        val ctx = requireContext()
        val tag = onu.optString("tag", onu.optString("id"))
        val currentSsid = onu.optString("ssid")
        val custName = onu.optString("customerName")

        val layout = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(40, 20, 40, 20)
        }

        val etSsid = EditText(ctx).apply {
            hint = "Nama WiFi (SSID) Baru"
            setText(if (currentSsid != "-" && currentSsid.isNotEmpty()) currentSsid else "")
        }

        layout.addView(TextView(ctx).apply {
            text = "Pelanggan: $custName\nMasukkan nama SSID WiFi baru yang diinginkan:"
            setTextColor(ContextCompat.getColor(ctx, R.color.text_muted))
        })
        layout.addView(etSsid)

        AlertDialog.Builder(ctx)
            .setTitle("📡 Ubah Nama WiFi (SSID)")
            .setView(layout)
            .setPositiveButton("Simpan ke ONU") { _, _ ->
                val newSsid = etSsid.text.toString().trim()
                if (newSsid.isEmpty()) {
                    Toast.makeText(ctx, "SSID tidak boleh kosong", Toast.LENGTH_SHORT).show()
                    return@setPositiveButton
                }
                executeChangeSsid(tag, newSsid)
            }
            .setNegativeButton("Batal", null)
            .show()
    }

    private fun executeChangeSsid(tag: String, newSsid: String) {
        viewLifecycleOwner.lifecycleScope.launch(Dispatchers.IO) {
            try {
                val url = "${getBaseUrl()}/api/customer/app/tech/tr069/device/ssid"
                val payload = JSONObject().apply {
                    put("tag", tag)
                    put("ssid", newSsid)
                }
                val body = payload.toString().toRequestBody("application/json".toMediaType())
                val req = Request.Builder()
                    .url(url)
                    .addHeader("Authorization", "Bearer ${getToken()}")
                    .post(body)
                    .build()
                val resp = httpClient().newCall(req).execute()
                val resJson = JSONObject(resp.body?.string() ?: "")

                withContext(Dispatchers.Main) {
                    Toast.makeText(requireContext(), resJson.optString("message", "SSID Diperbarui"), Toast.LENGTH_SHORT).show()
                    if (resJson.optBoolean("success")) loadTr069Devices()
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    Toast.makeText(requireContext(), "Gagal ubah SSID: ${e.message}", Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    private fun showChangePasswordDialog(onu: JSONObject) {
        val ctx = requireContext()
        val tag = onu.optString("tag", onu.optString("id"))
        val custName = onu.optString("customerName")

        val layout = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(40, 20, 40, 20)
        }

        val etPass = EditText(ctx).apply {
            hint = "Password WiFi Baru (min. 8 karakter)"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        }

        layout.addView(TextView(ctx).apply {
            text = "Pelanggan: $custName\nMasukkan password WiFi baru untuk modem:"
            setTextColor(ContextCompat.getColor(ctx, R.color.text_muted))
        })
        layout.addView(etPass)

        AlertDialog.Builder(ctx)
            .setTitle("🔑 Ubah Sandi WiFi")
            .setView(layout)
            .setPositiveButton("Simpan ke ONU") { _, _ ->
                val newPass = etPass.text.toString().trim()
                if (newPass.length < 8) {
                    Toast.makeText(ctx, "Password minimal 8 karakter", Toast.LENGTH_SHORT).show()
                    return@setPositiveButton
                }
                executeChangePassword(tag, newPass)
            }
            .setNegativeButton("Batal", null)
            .show()
    }

    private fun executeChangePassword(tag: String, newPass: String) {
        viewLifecycleOwner.lifecycleScope.launch(Dispatchers.IO) {
            try {
                val url = "${getBaseUrl()}/api/customer/app/tech/tr069/device/password"
                val payload = JSONObject().apply {
                    put("tag", tag)
                    put("password", newPass)
                }
                val body = payload.toString().toRequestBody("application/json".toMediaType())
                val req = Request.Builder()
                    .url(url)
                    .addHeader("Authorization", "Bearer ${getToken()}")
                    .post(body)
                    .build()
                val resp = httpClient().newCall(req).execute()
                val resJson = JSONObject(resp.body?.string() ?: "")

                withContext(Dispatchers.Main) {
                    Toast.makeText(requireContext(), resJson.optString("message", "Password Diperbarui"), Toast.LENGTH_SHORT).show()
                    if (resJson.optBoolean("success")) loadTr069Devices()
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    Toast.makeText(requireContext(), "Gagal ubah Password: ${e.message}", Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    private fun showRebootConfirmDialog(onu: JSONObject) {
        val tag = onu.optString("tag", onu.optString("id"))
        val custName = onu.optString("customerName")
        val sn = onu.optString("serialNumber")

        AlertDialog.Builder(requireContext())
            .setTitle("🔄 Reboot Modem ONT")
            .setMessage("Kirim perintah restart/reboot ke modem ONU '$custName' (SN: $sn) via TR-069?")
            .setPositiveButton("Reboot Sekarang") { _, _ ->
                executeReboot(tag)
            }
            .setNegativeButton("Batal", null)
            .show()
    }

    private fun executeReboot(tag: String) {
        viewLifecycleOwner.lifecycleScope.launch(Dispatchers.IO) {
            try {
                val url = "${getBaseUrl()}/api/customer/app/tech/tr069/device/reboot"
                val payload = JSONObject().apply { put("tag", tag) }
                val body = payload.toString().toRequestBody("application/json".toMediaType())
                val req = Request.Builder()
                    .url(url)
                    .addHeader("Authorization", "Bearer ${getToken()}")
                    .post(body)
                    .build()
                val resp = httpClient().newCall(req).execute()
                val resJson = JSONObject(resp.body?.string() ?: "")

                withContext(Dispatchers.Main) {
                    Toast.makeText(requireContext(), resJson.optString("message", "Reboot Selesai"), Toast.LENGTH_SHORT).show()
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    Toast.makeText(requireContext(), "Gagal reboot: ${e.message}", Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }

    class OnuAdapter(
        private val onChangeSsid: (JSONObject) -> Unit,
        private val onChangePassword: (JSONObject) -> Unit,
        private val onReboot: (JSONObject) -> Unit
    ) : RecyclerView.Adapter<OnuAdapter.ViewHolder>() {

        private var items = listOf<JSONObject>()

        fun submitList(newList: List<JSONObject>) {
            items = newList
            notifyDataSetChanged()
        }

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): ViewHolder {
            val binding = ItemTechOnuBinding.inflate(LayoutInflater.from(parent.context), parent, false)
            return ViewHolder(binding)
        }

        override fun onBindViewHolder(holder: ViewHolder, position: Int) {
            holder.bind(items[position])
        }

        override fun getItemCount(): Int = items.size

        inner class ViewHolder(private val binding: ItemTechOnuBinding) : RecyclerView.ViewHolder(binding.root) {
            fun bind(item: JSONObject) {
                val ctx = itemView.context
                val custName = item.optString("customerName", "Pelanggan")
                val pppoeUser = item.optString("pppoeUsername", "-")
                val phone = item.optString("customerPhone", "-")
                val sn = item.optString("serialNumber", "-")
                val model = item.optString("model", "ONT Router")
                val isOnline = item.optString("status").equals("online", ignoreCase = true)
                val rxPower = item.optString("rxPower", "-")
                val ssid = item.optString("ssid", "-")
                val ip = item.optString("pppoeIP", "-")
                val uptime = item.optString("uptime", "-")

                binding.tvOnuCustName.text = custName
                binding.tvOnuPppoeUser.text = "PPPoE: $pppoeUser  |  📞 $phone"
                binding.tvOnuModel.text = model
                binding.tvOnuSn.text = "SN: $sn"
                binding.tvOnuRxPower.text = "📉 Redaman: $rxPower"
                binding.tvOnuSsid.text = "WiFi: $ssid"
                binding.tvOnuIpUptime.text = "🌐 IP: $ip  |  ⏱️ $uptime"

                if (isOnline) {
                    binding.tvOnuStatusBadge.text = "🟢 ONLINE"
                    binding.tvOnuStatusBadge.setTextColor(android.graphics.Color.WHITE)
                    binding.tvOnuStatusBadge.setBackgroundColor(android.graphics.Color.parseColor("#16A34A"))
                } else {
                    binding.tvOnuStatusBadge.text = "🔴 OFFLINE"
                    binding.tvOnuStatusBadge.setTextColor(android.graphics.Color.WHITE)
                    binding.tvOnuStatusBadge.setBackgroundColor(android.graphics.Color.parseColor("#DC2626"))
                }

                binding.btnChangeSsid.setOnClickListener { onChangeSsid(item) }
                binding.btnChangePassword.setOnClickListener { onChangePassword(item) }
                binding.btnRebootOnu.setOnClickListener { onReboot(item) }
            }
        }
    }
}
