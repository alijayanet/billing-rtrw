package com.alijaya.customer.ui.tech

import android.content.Context
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Spinner
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
import com.alijaya.customer.databinding.FragmentTechMikrotikBinding
import com.alijaya.customer.databinding.ItemTechPppoeBinding
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

class TechMikrotikFragment : Fragment() {
    private var _binding: FragmentTechMikrotikBinding? = null
    private val binding get() = _binding!!

    private var allSecrets = mutableListOf<JSONObject>()
    private var profileList = mutableListOf<String>()
    private lateinit var adapter: PppoeAdapter

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
        _binding = FragmentTechMikrotikBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        adapter = PppoeAdapter(
            onEdit = { secret -> showEditPppoeDialog(secret) },
            onKick = { secret -> showKickConfirmDialog(secret) },
            onDelete = { secret -> showDeleteConfirmDialog(secret) }
        )

        binding.rvPppoe.layoutManager = LinearLayoutManager(requireContext())
        binding.rvPppoe.adapter = adapter

        binding.swipeRefresh.setOnRefreshListener {
            loadPppoeSecrets()
        }

        binding.btnAddPppoe.setOnClickListener {
            showAddPppoeDialog()
        }

        binding.etSearchPppoe.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
                filterList(s.toString())
            }
            override fun afterTextChanged(s: Editable?) {}
        })

        loadProfiles()
        loadPppoeSecrets()
    }

    private fun loadProfiles() {
        viewLifecycleOwner.lifecycleScope.launch(Dispatchers.IO) {
            try {
                val url = "${getBaseUrl()}/api/customer/app/tech/mikrotik/profiles"
                val req = Request.Builder()
                    .url(url)
                    .addHeader("Authorization", "Bearer ${getToken()}")
                    .build()
                val resp = httpClient().newCall(req).execute()
                val body = resp.body?.string() ?: ""
                val json = JSONObject(body)
                if (json.optBoolean("success")) {
                    val arr = json.optJSONArray("data") ?: JSONArray()
                    profileList.clear()
                    for (i in 0 until arr.length()) {
                        val p = arr.optJSONObject(i)
                        val name = p?.optString("name") ?: ""
                        if (name.isNotEmpty()) profileList.add(name)
                    }
                    if (!profileList.contains("default")) profileList.add(0, "default")
                }
            } catch (_: Exception) {}
        }
    }

    private fun loadPppoeSecrets() {
        binding.swipeRefresh.isRefreshing = true
        viewLifecycleOwner.lifecycleScope.launch(Dispatchers.IO) {
            try {
                val url = "${getBaseUrl()}/api/customer/app/tech/mikrotik/secrets"
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
                        allSecrets.clear()
                        var activeCount = 0
                        for (i in 0 until arr.length()) {
                            val obj = arr.getJSONObject(i)
                            allSecrets.add(obj)
                            if (obj.optBoolean("active")) activeCount++
                        }
                        binding.tvMikrotikSummary.text = "Total Secret: ${allSecrets.size} | Aktif Online: $activeCount"
                        filterList(binding.etSearchPppoe.text.toString())
                    } else {
                        binding.tvMikrotikSummary.text = json.optString("message", "Gagal memuat PPPoE")
                        Toast.makeText(requireContext(), json.optString("message"), Toast.LENGTH_SHORT).show()
                    }
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    binding.swipeRefresh.isRefreshing = false
                    binding.tvMikrotikSummary.text = "Error koneksi MikroTik: ${e.message}"
                }
            }
        }
    }

    private fun filterList(query: String) {
        val q = query.trim().lowercase()
        val filtered = if (q.isEmpty()) {
            allSecrets
        } else {
            allSecrets.filter {
                it.optString("name").lowercase().contains(q) ||
                it.optString("profile").lowercase().contains(q) ||
                it.optString("comment").lowercase().contains(q) ||
                it.optString("activeIp").lowercase().contains(q)
            }
        }
        adapter.submitList(filtered)
    }

    private fun showAddPppoeDialog() {
        val ctx = requireContext()
        val layout = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(40, 20, 40, 20)
        }

        val etUser = EditText(ctx).apply { hint = "Username PPPoE (cth: pelanggan_12)" }
        val etPass = EditText(ctx).apply { hint = "Password PPPoE" }
        val spProfile = Spinner(ctx).apply {
            val list = if (profileList.isNotEmpty()) profileList else listOf("default")
            val adapter = ArrayAdapter(ctx, android.R.layout.simple_spinner_dropdown_item, list)
            this.adapter = adapter
        }
        val etComment = EditText(ctx).apply { hint = "Catatan / Nama Pelanggan (opsional)" }

        layout.addView(TextView(ctx).apply { text = "Username PPPoE:"; setTextColor(ContextCompat.getColor(ctx, R.color.text_muted)) })
        layout.addView(etUser)
        layout.addView(TextView(ctx).apply { text = "Password PPPoE:"; setTextColor(ContextCompat.getColor(ctx, R.color.text_muted)) })
        layout.addView(etPass)
        layout.addView(TextView(ctx).apply { text = "Profile Paket:"; setTextColor(ContextCompat.getColor(ctx, R.color.text_muted)) })
        layout.addView(spProfile)
        layout.addView(TextView(ctx).apply { text = "Catatan (Comment):"; setTextColor(ContextCompat.getColor(ctx, R.color.text_muted)) })
        layout.addView(etComment)

        AlertDialog.Builder(ctx)
            .setTitle("➕ Tambah Secret PPPoE")
            .setView(layout)
            .setPositiveButton("Simpan ke MikroTik") { _, _ ->
                val username = etUser.text.toString().trim()
                val password = etPass.text.toString().trim()
                val profile = spProfile.selectedItem?.toString() ?: "default"
                val comment = etComment.text.toString().trim()

                if (username.isEmpty() || password.isEmpty()) {
                    Toast.makeText(ctx, "Username dan Password wajib diisi", Toast.LENGTH_SHORT).show()
                    return@setPositiveButton
                }

                executeAddPppoe(username, password, profile, comment)
            }
            .setNegativeButton("Batal", null)
            .show()
    }

    private fun executeAddPppoe(user: String, pass: String, profile: String, comment: String) {
        viewLifecycleOwner.lifecycleScope.launch(Dispatchers.IO) {
            try {
                val url = "${getBaseUrl()}/api/customer/app/tech/mikrotik/secret/create"
                val payload = JSONObject().apply {
                    put("username", user)
                    put("password", pass)
                    put("profile", profile)
                    put("comment", comment)
                }
                val body = payload.toString().toRequestBody("application/json".toMediaType())
                val req = Request.Builder().url(url)
                    .addHeader("Authorization", "Bearer ${getToken()}")
                    .post(body).build()
                val resp = httpClient().newCall(req).execute()
                val resJson = JSONObject(resp.body?.string() ?: "")

                withContext(Dispatchers.Main) {
                    Toast.makeText(requireContext(), resJson.optString("message", "Selesai"), Toast.LENGTH_SHORT).show()
                    if (resJson.optBoolean("success")) loadPppoeSecrets()
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    Toast.makeText(requireContext(), "Gagal: ${e.message}", Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    private fun showEditPppoeDialog(secret: JSONObject) {
        val ctx = requireContext()
        val username = secret.optString("name")
        val currentPass = secret.optString("password")
        val currentProfile = secret.optString("profile")

        val layout = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(40, 20, 40, 20)
        }

        val etPass = EditText(ctx).apply {
            hint = "Password Baru"
            setText(currentPass)
        }
        val spProfile = Spinner(ctx).apply {
            val list = if (profileList.isNotEmpty()) profileList else listOf(currentProfile, "default")
            val adapter = ArrayAdapter(ctx, android.R.layout.simple_spinner_dropdown_item, list)
            this.adapter = adapter
            val idx = list.indexOf(currentProfile)
            if (idx >= 0) setSelection(idx)
        }

        layout.addView(TextView(ctx).apply { text = "Password PPPoE:"; setTextColor(ContextCompat.getColor(ctx, R.color.text_muted)) })
        layout.addView(etPass)
        layout.addView(TextView(ctx).apply { text = "Profile Paket:"; setTextColor(ContextCompat.getColor(ctx, R.color.text_muted)) })
        layout.addView(spProfile)

        AlertDialog.Builder(ctx)
            .setTitle("✏️ Edit Secret: $username")
            .setView(layout)
            .setPositiveButton("Perbarui") { _, _ ->
                val newPass = etPass.text.toString().trim()
                val newProfile = spProfile.selectedItem?.toString() ?: currentProfile
                executeUpdatePppoe(username, newPass, newProfile)
            }
            .setNegativeButton("Batal", null)
            .show()
    }

    private fun executeUpdatePppoe(username: String, pass: String, profile: String) {
        viewLifecycleOwner.lifecycleScope.launch(Dispatchers.IO) {
            try {
                val url = "${getBaseUrl()}/api/customer/app/tech/mikrotik/secret/update"
                val payload = JSONObject().apply {
                    put("username", username)
                    put("password", pass)
                    put("profile", profile)
                }
                val body = payload.toString().toRequestBody("application/json".toMediaType())
                val req = Request.Builder().url(url)
                    .addHeader("Authorization", "Bearer ${getToken()}")
                    .post(body).build()
                val resp = httpClient().newCall(req).execute()
                val resJson = JSONObject(resp.body?.string() ?: "")

                withContext(Dispatchers.Main) {
                    Toast.makeText(requireContext(), resJson.optString("message", "Berhasil"), Toast.LENGTH_SHORT).show()
                    if (resJson.optBoolean("success")) loadPppoeSecrets()
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    Toast.makeText(requireContext(), "Gagal: ${e.message}", Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    private fun showKickConfirmDialog(secret: JSONObject) {
        val username = secret.optString("name")
        AlertDialog.Builder(requireContext())
            .setTitle("⚡ Kick Sesi PPPoE")
            .setMessage("Apakah Anda yakin ingin memutus sesi aktif untuk '$username'? Perangkat akan reconnect otomatis.")
            .setPositiveButton("Ya, Putus Sesi") { _, _ ->
                executeKick(username)
            }
            .setNegativeButton("Batal", null)
            .show()
    }

    private fun executeKick(username: String) {
        viewLifecycleOwner.lifecycleScope.launch(Dispatchers.IO) {
            try {
                val url = "${getBaseUrl()}/api/customer/app/tech/mikrotik/secret/kick"
                val payload = JSONObject().apply { put("username", username) }
                val body = payload.toString().toRequestBody("application/json".toMediaType())
                val req = Request.Builder().url(url)
                    .addHeader("Authorization", "Bearer ${getToken()}")
                    .post(body).build()
                val resp = httpClient().newCall(req).execute()
                val resJson = JSONObject(resp.body?.string() ?: "")

                withContext(Dispatchers.Main) {
                    Toast.makeText(requireContext(), resJson.optString("message", "Kicked"), Toast.LENGTH_SHORT).show()
                    loadPppoeSecrets()
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    Toast.makeText(requireContext(), "Gagal: ${e.message}", Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    private fun showDeleteConfirmDialog(secret: JSONObject) {
        val username = secret.optString("name")
        AlertDialog.Builder(requireContext())
            .setTitle("🗑️ Hapus User PPPoE")
            .setMessage("Apakah Anda yakin ingin menghapus secret '$username' dari MikroTik? Tindakan ini tidak dapat dibatalkan.")
            .setPositiveButton("Hapus") { _, _ ->
                executeDelete(username)
            }
            .setNegativeButton("Batal", null)
            .show()
    }

    private fun executeDelete(username: String) {
        viewLifecycleOwner.lifecycleScope.launch(Dispatchers.IO) {
            try {
                val url = "${getBaseUrl()}/api/customer/app/tech/mikrotik/secret/delete"
                val payload = JSONObject().apply { put("username", username) }
                val body = payload.toString().toRequestBody("application/json".toMediaType())
                val req = Request.Builder().url(url)
                    .addHeader("Authorization", "Bearer ${getToken()}")
                    .post(body).build()
                val resp = httpClient().newCall(req).execute()
                val resJson = JSONObject(resp.body?.string() ?: "")

                withContext(Dispatchers.Main) {
                    Toast.makeText(requireContext(), resJson.optString("message", "Terhapus"), Toast.LENGTH_SHORT).show()
                    if (resJson.optBoolean("success")) loadPppoeSecrets()
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    Toast.makeText(requireContext(), "Gagal: ${e.message}", Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }

    class PppoeAdapter(
        private val onEdit: (JSONObject) -> Unit,
        private val onKick: (JSONObject) -> Unit,
        private val onDelete: (JSONObject) -> Unit
    ) : RecyclerView.Adapter<PppoeAdapter.ViewHolder>() {

        private var items = listOf<JSONObject>()

        fun submitList(newList: List<JSONObject>) {
            items = newList
            notifyDataSetChanged()
        }

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): ViewHolder {
            val binding = ItemTechPppoeBinding.inflate(LayoutInflater.from(parent.context), parent, false)
            return ViewHolder(binding)
        }

        override fun onBindViewHolder(holder: ViewHolder, position: Int) {
            holder.bind(items[position])
        }

        override fun getItemCount(): Int = items.size

        inner class ViewHolder(private val binding: ItemTechPppoeBinding) : RecyclerView.ViewHolder(binding.root) {
            fun bind(item: JSONObject) {
                val ctx = itemView.context
                val username = item.optString("name")
                val password = item.optString("password")
                val profile = item.optString("profile", "default")
                val isActive = item.optBoolean("active")
                val ip = item.optString("activeIp", "-")
                val uptime = item.optString("activeUptime", "-")

                binding.tvPppoeUser.text = username
                binding.tvPppoeProfile.text = "Profile: $profile"
                binding.tvPppoePassword.text = "Pass: $password"

                if (isActive) {
                    binding.tvPppoeStatusBadge.text = "🟢 ONLINE"
                    binding.tvPppoeStatusBadge.setTextColor(android.graphics.Color.WHITE)
                    binding.tvPppoeStatusBadge.setBackgroundColor(android.graphics.Color.parseColor("#16A34A"))
                    binding.tvPppoeSessionInfo.visibility = View.VISIBLE
                    binding.tvPppoeSessionInfo.text = "🌐 IP: $ip   |   ⏱️ $uptime"
                    binding.btnKickPppoe.visibility = View.VISIBLE
                } else {
                    binding.tvPppoeStatusBadge.text = "⚪ OFFLINE"
                    binding.tvPppoeStatusBadge.setTextColor(android.graphics.Color.WHITE)
                    binding.tvPppoeStatusBadge.setBackgroundColor(android.graphics.Color.parseColor("#475569"))
                    binding.tvPppoeSessionInfo.visibility = View.GONE
                    binding.btnKickPppoe.visibility = View.GONE
                }

                binding.btnEditPppoe.setOnClickListener { onEdit(item) }
                binding.btnKickPppoe.setOnClickListener { onKick(item) }
                binding.btnDeletePppoe.setOnClickListener { onDelete(item) }
            }
        }
    }
}
