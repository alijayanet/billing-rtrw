package com.alijaya.customer.ui.admin

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.cardview.widget.CardView
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.alijaya.customer.CustomerApplication
import com.alijaya.customer.R
import com.alijaya.customer.databinding.FragmentAdminCustomersBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.text.NumberFormat
import java.util.Locale
import java.util.concurrent.TimeUnit

class AdminCustomersFragment : Fragment() {
    private var _binding: FragmentAdminCustomersBinding? = null
    private val binding get() = _binding!!

    private var allCustomers = mutableListOf<JSONObject>()
    private var availablePackages = mutableListOf<JSONObject>()
    private var activeFilter = "all" // all, active, isolated, deferred

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
        _binding = FragmentAdminCustomersBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        binding.swipeRefresh.setOnRefreshListener {
            loadCustomers(binding.etSearch.text.toString().trim())
        }

        binding.btnSearch.setOnClickListener {
            loadCustomers(binding.etSearch.text.toString().trim())
        }

        binding.btnAddCustomer.setOnClickListener {
            showAddCustomerDialog()
        }

        setupChips()
        loadPackages()
        loadCustomers()
    }

    private fun setupChips() {
        binding.chipAll.setOnClickListener {
            activeFilter = "all"
            updateChipStyles()
            renderCustomers()
        }
        binding.chipActive.setOnClickListener {
            activeFilter = "active"
            updateChipStyles()
            renderCustomers()
        }
        binding.chipIsolated.setOnClickListener {
            activeFilter = "isolated"
            updateChipStyles()
            renderCustomers()
        }
        binding.chipDeferred.setOnClickListener {
            activeFilter = "deferred"
            updateChipStyles()
            renderCustomers()
        }
    }

    private fun updateChipStyles() {
        binding.chipAll.alpha = if (activeFilter == "all") 1.0f else 0.6f
        binding.chipActive.alpha = if (activeFilter == "active") 1.0f else 0.6f
        binding.chipIsolated.alpha = if (activeFilter == "isolated") 1.0f else 0.6f
        binding.chipDeferred.alpha = if (activeFilter == "deferred") 1.0f else 0.6f
    }

    private fun loadPackages() {
        lifecycleScope.launch {
            val url = "${getBaseUrl()}/api/customer/app/admin/packages"
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
                    val arr = json.optJSONArray("data") ?: JSONArray()
                    availablePackages.clear()
                    for (i in 0 until arr.length()) {
                        availablePackages.add(arr.getJSONObject(i))
                    }
                } catch (_: Exception) {}
            }
        }
    }

    private fun loadCustomers(search: String = "") {
        binding.swipeRefresh.isRefreshing = true
        binding.pbLoading.visibility = View.VISIBLE
        binding.tvEmpty.visibility = View.GONE

        lifecycleScope.launch {
            val url = "${getBaseUrl()}/api/customer/app/admin/customers?search=${search}"
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
            binding.pbLoading.visibility = View.GONE

            if (responseStr != null) {
                try {
                    val json = JSONObject(responseStr)
                    val arr = json.optJSONArray("data") ?: JSONArray()
                    allCustomers.clear()
                    for (i in 0 until arr.length()) {
                        allCustomers.add(arr.getJSONObject(i))
                    }
                    renderCustomers()
                    return@launch
                } catch (_: Exception) {}
            }

            binding.tvEmpty.visibility = View.VISIBLE
        }
    }

    private fun renderCustomers() {
        val container = binding.layoutCustomersContainer
        container.removeAllViews()
        container.addView(binding.pbLoading)
        container.addView(binding.tvEmpty)

        val filtered = allCustomers.filter { c ->
            val status = c.optString("status", "active").lowercase()
            when (activeFilter) {
                "active" -> status == "active"
                "isolated" -> status == "suspended" || status == "isolated"
                "deferred" -> status == "ditangguhkan" || status == "deferred"
                else -> true
            }
        }

        if (filtered.isEmpty()) {
            binding.tvEmpty.visibility = View.VISIBLE
            return
        }
        binding.tvEmpty.visibility = View.GONE

        val ctx = context ?: return
        val fmt = NumberFormat.getCurrencyInstance(Locale("id", "ID"))

        for (c in filtered) {
            val cId = c.optInt("id")
            val name = c.optString("name", "Pelanggan")
            val phone = c.optString("phone", "-")
            val address = c.optString("address", "-")
            val pppoe = c.optString("pppoe_username", "-")
            val status = c.optString("status", "active").lowercase()
            val pkgName = c.optString("package_name", "Paket Internet")
            val pkgPrice = c.optDouble("package_price", 0.0)
            val isolDay = c.optInt("isolate_day", 10)
            val balance = c.optDouble("balance", 0.0)

            val card = CardView(ctx).apply {
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                ).apply {
                    setMargins(0, 0, 0, 20)
                }
                radius = 24f
                setCardBackgroundColor(ContextCompat.getColor(ctx, R.color.card_dark))
            }

            val cardContent = LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(32, 28, 32, 28)
            }

            // Top Row
            val topRow = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = android.view.Gravity.CENTER_VERTICAL
            }

            val tvName = TextView(ctx).apply {
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                text = name
                setTextColor(ContextCompat.getColor(ctx, R.color.text_white))
                textSize = 15f
                setTypeface(null, android.graphics.Typeface.BOLD)
            }

            val tvBadge = TextView(ctx).apply {
                setPadding(16, 4, 16, 4)
                textSize = 10.5f
                setTypeface(null, android.graphics.Typeface.BOLD)

                when (status) {
                    "suspended", "isolated" -> {
                        text = "\uD83D\uDD34 TERISOLIR"
                        setTextColor(ContextCompat.getColor(ctx, R.color.danger))
                    }
                    "ditangguhkan", "deferred" -> {
                        text = "\uD83D\uDFE1 DITANGGUHKAN"
                        setTextColor(ContextCompat.getColor(ctx, R.color.warning))
                    }
                    else -> {
                        text = "\uD83D\uDFE2 AKTIF"
                        setTextColor(ContextCompat.getColor(ctx, R.color.success))
                    }
                }
            }

            topRow.addView(tvName)
            topRow.addView(tvBadge)
            cardContent.addView(topRow)

            // Info
            val tvDetails = TextView(ctx).apply {
                text = "\uD83D\uDCF1 $phone | \uD83D\uDC64 PPPoE: $pppoe\n\uD83D\uDCE6 Paket: $pkgName (${fmt.format(pkgPrice)})\n\uD83D\uDCB0 Saldo: ${fmt.format(balance)}\n\uD83D\uDCCD $address\n\uD83D\uDCC5 Tgl Jatuh Tempo: Tgl $isolDay"
                setTextColor(ContextCompat.getColor(ctx, R.color.text_muted))
                textSize = 11.5f
                setPadding(0, 8, 0, 12)
            }
            cardContent.addView(tvDetails)

            // Actions Row 1 (Saldo, Edit, WhatsApp)
            val btnRow1 = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                    bottomMargin = 10
                }
            }

            val btnTopup = Button(ctx, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                layoutParams = LinearLayout.LayoutParams(0, 84, 1.1f).apply { marginEnd = 6 }
                text = "💰 Saldo"
                textSize = 10.5f
                setTextColor(ContextCompat.getColor(ctx, R.color.success))
                setOnClickListener {
                    showCustomerTopupDialog(cId, name, balance)
                }
            }
            btnRow1.addView(btnTopup)

            val btnEdit = Button(ctx, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                layoutParams = LinearLayout.LayoutParams(0, 84, 0.9f).apply { marginEnd = 6 }
                text = "\u270F\uFE0F Edit"
                textSize = 10.5f
                setTextColor(ContextCompat.getColor(ctx, R.color.text_white))
                setOnClickListener {
                    showEditCustomerDialog(c)
                }
            }
            btnRow1.addView(btnEdit)

            if (phone.isNotEmpty() && phone != "-") {
                val btnWa = Button(ctx, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                    layoutParams = LinearLayout.LayoutParams(0, 84, 1f)
                    text = "\uD83D\uDCAC WhatsApp"
                    textSize = 10.5f
                    setTextColor(ContextCompat.getColor(ctx, R.color.accent))
                    setOnClickListener {
                        showSendWhatsAppDialog(c)
                    }
                }
                btnRow1.addView(btnWa)
            }
            cardContent.addView(btnRow1)

            // Actions Row 2 (Isolir, Delete)
            val btnRow2 = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
            }

            val isSuspended = (status == "suspended" || status == "isolated")
            val btnIsolir = Button(ctx, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                layoutParams = LinearLayout.LayoutParams(0, 84, 1f).apply { marginEnd = 6 }
                text = if (isSuspended) "🔓 Buka Isolir" else "🔒 Isolir"
                textSize = 10.5f
                setTextColor(ContextCompat.getColor(ctx, if (isSuspended) R.color.warning else R.color.danger))
                setOnClickListener {
                    confirmToggleIsolir(cId, name, isSuspended)
                }
            }
            btnRow2.addView(btnIsolir)

            val btnDelete = Button(ctx, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                layoutParams = LinearLayout.LayoutParams(0, 84, 1f)
                text = "\uD83D\uDDD1 Hapus"
                textSize = 10.5f
                setTextColor(ContextCompat.getColor(ctx, R.color.danger))
                setOnClickListener {
                    confirmDeleteCustomer(cId, name)
                }
            }
            btnRow2.addView(btnDelete)

            cardContent.addView(btnRow2)
            card.addView(cardContent)
            container.addView(card)
        }
    }

    private fun confirmToggleIsolir(customerId: Int, name: String, currentlySuspended: Boolean) {
        val ctx = context ?: return
        val actionTitle = if (currentlySuspended) "Buka Isolir" else "Isolir Pelanggan"
        val actionMsg = if (currentlySuspended) 
            "Buka isolir untuk $name? Status pelanggan akan menjadi Ditangguhkan (bebas auto-isolir)."
            else "Yakin ingin mengisolir koneksi $name di MikroTik?"

        AlertDialog.Builder(ctx)
            .setTitle(actionTitle)
            .setMessage(actionMsg)
            .setPositiveButton(if (currentlySuspended) "Ya, Buka Isolir" else "Ya, Isolir") { _, _ ->
                toggleCustomerIsolation(customerId, currentlySuspended)
            }
            .setNegativeButton("Batal", null)
            .show()
    }

    private fun toggleCustomerIsolation(customerId: Int, currentlySuspended: Boolean) {
        val ctx = context ?: return
        lifecycleScope.launch {
            val endpoint = if (currentlySuspended) "unisolate-customer" else "isolate-customer"
            val url = "${getBaseUrl()}/api/customer/app/admin/$endpoint"

            val bodyJson = JSONObject().apply {
                put("customerId", customerId)
                put("id", customerId)
            }.toString()

            val resStr = withContext(Dispatchers.IO) {
                try {
                    val reqBody = bodyJson.toRequestBody("application/json".toMediaType())
                    val req = Request.Builder().url(url)
                        .addHeader("Authorization", "Bearer ${getToken()}")
                        .post(reqBody).build()
                    val resp = httpClient().newCall(req).execute()
                    resp.body?.string()
                } catch (_: Exception) { null }
            }

            if (resStr != null) {
                try {
                    val json = JSONObject(resStr)
                    val msg = json.optString("message", "Status isolir berhasil diperbarui")
                    Toast.makeText(ctx, msg, Toast.LENGTH_SHORT).show()
                } catch (_: Exception) {
                    Toast.makeText(ctx, "Status berhasil diperbarui", Toast.LENGTH_SHORT).show()
                }
                loadCustomers()
            } else {
                Toast.makeText(ctx, "Gagal mengubah status isolir di server", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun showAddCustomerDialog() {
        val ctx = context ?: return
        val layout = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(50, 30, 50, 10)
        }

        val etName = EditText(ctx).apply { hint = "Nama Lengkap Pelanggan" }
        val etPhone = EditText(ctx).apply { hint = "Nomor WhatsApp (misal 081234567890)" }
        val etAddress = EditText(ctx).apply { hint = "Alamat Lengkap / Blok" }
        val etPppoe = EditText(ctx).apply { hint = "Username PPPoE (opsional)" }
        val etPass = EditText(ctx).apply { hint = "Password PPPoE (default 123456)" }
        val etIsolDay = EditText(ctx).apply { 
            hint = "Tgl Isolir Bulanan (1-28)"
            setText("10")
        }

        val spinnerPkg = Spinner(ctx)
        val pkgNames = if (availablePackages.isNotEmpty()) {
            availablePackages.map { it.optString("name", "Paket") }
        } else {
            listOf("Paket Standar")
        }
        val adapter = ArrayAdapter(ctx, android.R.layout.simple_spinner_dropdown_item, pkgNames)
        spinnerPkg.adapter = adapter

        layout.addView(etName)
        layout.addView(etPhone)
        layout.addView(etAddress)
        layout.addView(TextView(ctx).apply { text = "Pilih Paket Internet:"; setPadding(0, 12, 0, 4) })
        layout.addView(spinnerPkg)
        layout.addView(etPppoe)
        layout.addView(etPass)
        layout.addView(etIsolDay)

        AlertDialog.Builder(ctx)
            .setTitle(" Tambah Pelanggan Baru")
            .setView(layout)
            .setPositiveButton("Simpan") { _, _ ->
                val name = etName.text.toString().trim()
                val phone = etPhone.text.toString().trim()
                val addr = etAddress.text.toString().trim()
                val pppoe = etPppoe.text.toString().trim()
                val pass = etPass.text.toString().trim()
                val isolDay = etIsolDay.text.toString().toIntOrNull() ?: 10

                val pkgIdx = spinnerPkg.selectedItemPosition
                val pkgId = if (availablePackages.isNotEmpty() && pkgIdx < availablePackages.size) {
                    availablePackages[pkgIdx].optInt("id", 1)
                } else 1

                if (name.isEmpty() || phone.isEmpty()) {
                    Toast.makeText(ctx, "Nama dan No. WhatsApp wajib diisi!", Toast.LENGTH_SHORT).show()
                } else {
                    processCreateCustomer(name, phone, addr, pkgId, pppoe, pass, isolDay)
                }
            }
            .setNegativeButton("Batal", null)
            .show()
    }

    private fun processCreateCustomer(name: String, phone: String, address: String, packageId: Int, pppoe: String, pass: String, isolateDay: Int) {
        val ctx = context ?: return
        lifecycleScope.launch {
            Toast.makeText(ctx, "Mendaftarkan pelanggan...", Toast.LENGTH_SHORT).show()
            val url = "${getBaseUrl()}/api/customer/app/admin/customers/create"

            val bodyJson = JSONObject().apply {
                put("name", name)
                put("phone", phone)
                put("address", address)
                put("package_id", packageId)
                put("pppoe_username", pppoe.ifEmpty { phone })
                put("pppoe_password", pass.ifEmpty { "123456" })
                put("isolate_day", isolateDay)
            }.toString()

            val success = withContext(Dispatchers.IO) {
                try {
                    val reqBody = bodyJson.toRequestBody("application/json".toMediaType())
                    val req = Request.Builder().url(url)
                        .addHeader("Authorization", "Bearer ${getToken()}")
                        .post(reqBody).build()
                    val resp = httpClient().newCall(req).execute()
                    resp.isSuccessful
                } catch (_: Exception) { false }
            }

            if (success) {
                Toast.makeText(ctx, " Pelanggan \"$name\" berhasil didaftarkan!", Toast.LENGTH_LONG).show()
                loadCustomers()
            } else {
                Toast.makeText(ctx, "Gagal mendaftarkan pelanggan", Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun showEditCustomerDialog(c: JSONObject) {
        val ctx = context ?: return
        val cId = c.optInt("id")
        val layout = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(50, 30, 50, 10)
        }

        val etName = EditText(ctx).apply { setText(c.optString("name", "")) }
        val etPhone = EditText(ctx).apply { setText(c.optString("phone", "")) }
        val etAddress = EditText(ctx).apply { setText(c.optString("address", "")) }
        val etPppoe = EditText(ctx).apply { 
            setText(c.optString("pppoe_username", c.optString("phone", ""))) 
        }
        val etPass = EditText(ctx).apply { 
            setText(c.optString("pppoe_password", "123456")) 
        }
        val etIsolDay = EditText(ctx).apply { setText(c.optInt("isolate_day", 10).toString()) }

        val spinnerPkg = Spinner(ctx)
        val pkgNames = if (availablePackages.isNotEmpty()) {
            availablePackages.map { it.optString("name", "Paket") }
        } else {
            listOf("Paket Standar")
        }
        val adapter = ArrayAdapter(ctx, android.R.layout.simple_spinner_dropdown_item, pkgNames)
        spinnerPkg.adapter = adapter

        // Select current package
        val curPkgId = c.optInt("package_id", 0)
        val selectedIdx = availablePackages.indexOfFirst { it.optInt("id") == curPkgId }
        if (selectedIdx >= 0) spinnerPkg.setSelection(selectedIdx)

        layout.addView(TextView(ctx).apply { text = "Nama Lengkap:" })
        layout.addView(etName)
        layout.addView(TextView(ctx).apply { text = "No. WhatsApp (Login ID Pelanggan):" })
        layout.addView(etPhone)
        layout.addView(TextView(ctx).apply { text = "Username PPPoE / Login ID:" })
        layout.addView(etPppoe)
        layout.addView(TextView(ctx).apply { text = "Password PPPoE / PIN Login:" })
        layout.addView(etPass)
        layout.addView(TextView(ctx).apply { text = "Alamat:" })
        layout.addView(etAddress)
        layout.addView(TextView(ctx).apply { text = "Pilih Paket Internet:" })
        layout.addView(spinnerPkg)
        layout.addView(TextView(ctx).apply { text = "Tgl Isolir Bulanan:" })
        layout.addView(etIsolDay)

        AlertDialog.Builder(ctx)
            .setTitle("✏️ Edit Pelanggan")
            .setView(layout)
            .setPositiveButton("Perbarui") { _, _ ->
                val name = etName.text.toString().trim()
                val phone = etPhone.text.toString().trim()
                val pppoe = etPppoe.text.toString().trim()
                val pass = etPass.text.toString().trim()
                val addr = etAddress.text.toString().trim()
                val isolDay = etIsolDay.text.toString().toIntOrNull() ?: 10

                val pkgIdx = spinnerPkg.selectedItemPosition
                val pkgId = if (availablePackages.isNotEmpty() && pkgIdx < availablePackages.size) {
                    availablePackages[pkgIdx].optInt("id", 1)
                } else 1

                processUpdateCustomer(cId, name, phone, addr, pppoe, pass, pkgId, isolDay)
            }
            .setNegativeButton("Batal", null)
            .show()
    }

    private fun processUpdateCustomer(id: Int, name: String, phone: String, address: String, pppoe: String, pass: String, packageId: Int, isolateDay: Int) {
        val ctx = context ?: return
        lifecycleScope.launch {
            Toast.makeText(ctx, "Memperbarui data...", Toast.LENGTH_SHORT).show()
            val url = "${getBaseUrl()}/api/customer/app/admin/customers/update"

            val bodyJson = JSONObject().apply {
                put("id", id)
                put("name", name)
                put("phone", phone)
                put("address", address)
                put("pppoe_username", pppoe.ifEmpty { phone })
                put("pppoe_password", pass.ifEmpty { "123456" })
                put("package_id", packageId)
                put("isolate_day", isolateDay)
            }.toString()

            val success = withContext(Dispatchers.IO) {
                try {
                    val reqBody = bodyJson.toRequestBody("application/json".toMediaType())
                    val req = Request.Builder().url(url)
                        .addHeader("Authorization", "Bearer ${getToken()}")
                        .post(reqBody).build()
                    val resp = httpClient().newCall(req).execute()
                    resp.isSuccessful
                } catch (_: Exception) { false }
            }

            if (success) {
                Toast.makeText(ctx, " Data pelanggan berhasil diperbarui!", Toast.LENGTH_SHORT).show()
                loadCustomers()
            } else {
                Toast.makeText(ctx, "Gagal memperbarui data", Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun confirmDeleteCustomer(customerId: Int, customerName: String) {
        val ctx = context ?: return
        AlertDialog.Builder(ctx)
            .setTitle(" Hapus Pelanggan")
            .setMessage("Apakah Anda yakin ingin menghapus pelanggan \"$customerName\"?")
            .setPositiveButton("Hapus") { _, _ ->
                processDeleteCustomer(customerId)
            }
            .setNegativeButton("Batal", null)
            .show()
    }

    private fun processDeleteCustomer(customerId: Int) {
        val ctx = context ?: return
        lifecycleScope.launch {
            val url = "${getBaseUrl()}/api/customer/app/admin/customers/delete"

            val bodyJson = JSONObject().apply {
                put("id", customerId)
            }.toString()

            val success = withContext(Dispatchers.IO) {
                try {
                    val reqBody = bodyJson.toRequestBody("application/json".toMediaType())
                    val req = Request.Builder().url(url)
                        .addHeader("Authorization", "Bearer ${getToken()}")
                        .post(reqBody).build()
                    val resp = httpClient().newCall(req).execute()
                    resp.isSuccessful
                } catch (_: Exception) { false }
            }

            if (success) {
                Toast.makeText(ctx, "Pelanggan berhasil dihapus", Toast.LENGTH_SHORT).show()
                loadCustomers()
            } else {
                Toast.makeText(ctx, "Gagal menghapus pelanggan", Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun showSendWhatsAppDialog(c: JSONObject) {
        val ctx = context ?: return
        val cId = c.optInt("id")
        val name = c.optString("name", "Pelanggan")
        val phone = c.optString("phone", "")
        val status = c.optString("status", "active")
        val pkgName = c.optString("package_name", "Paket Internet")

        lifecycleScope.launch {
            val url = "${getBaseUrl()}/api/customer/app/admin/customer/$cId/wa-templates"
            val responseStr = withContext(Dispatchers.IO) {
                try {
                    val req = Request.Builder().url(url)
                        .addHeader("Authorization", "Bearer ${getToken()}")
                        .build()
                    val resp = httpClient().newCall(req).execute()
                    if (resp.isSuccessful) resp.body?.string() else null
                } catch (_: Exception) { null }
            }

            var billingTpl = "Halo Bp/Ibu $name,\n\nBerikut tagihan layanan internet Paket $pkgName Anda.\n\nTerima kasih."
            var isolirTpl = "Halo Bp/Ibu $name,\n\nLayanan internet Anda ($pkgName) saat ini terisolir karena belum melunasi tagihan.\n\nTerima kasih."
            var successTpl = "Halo Bp/Ibu $name,\n\nPembayaran tagihan internet Paket $pkgName telah berhasil kami terima. Terima kasih."
            var customTpl = "Halo Bp/Ibu $name,\n\n"

            if (responseStr != null) {
                try {
                    val json = JSONObject(responseStr)
                    val data = json.optJSONObject("data")
                    val tpls = data?.optJSONObject("templates")
                    if (tpls != null) {
                        billingTpl = tpls.optString("billing", billingTpl)
                        isolirTpl = tpls.optString("isolir", isolirTpl)
                        successTpl = tpls.optString("success", successTpl)
                        customTpl = tpls.optString("custom", customTpl)
                    }
                } catch (_: Exception) {}
            }

            val templateOptions = listOf(
                "📢 Pengingat Tagihan Bulanan",
                "🔴 Pemberitahuan Terisolir (Suspended)",
                "🟢 Konfirmasi Pembayaran Lunas",
                "✏️ Pesan Kustom / Manual"
            )

            val layout = LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(50, 30, 50, 10)
            }

            val tvCustInfo = TextView(ctx).apply {
                val statusText = when (status.lowercase()) {
                    "suspended", "isolated" -> "🔴 Terisolir"
                    "ditangguhkan", "deferred" -> "🟡 Ditangguhkan"
                    else -> "🟢 Aktif"
                }
                text = "Pelanggan: $name ($statusText)\nNo. WhatsApp: $phone"
                setTextColor(ContextCompat.getColor(ctx, R.color.text_white))
                textSize = 12.5f
                setPadding(0, 0, 0, 12)
            }

            val tvLabelTpl = TextView(ctx).apply {
                text = "Pilih Format Template:"
                setTextColor(ContextCompat.getColor(ctx, R.color.accent))
                textSize = 11.5f
            }

            val spinnerTpl = Spinner(ctx).apply {
                adapter = ArrayAdapter(ctx, android.R.layout.simple_spinner_dropdown_item, templateOptions)
            }

            val tvLabelMsg = TextView(ctx).apply {
                text = "Pratinjau / Edit Pesan Sebelum Dikirim:"
                setTextColor(ContextCompat.getColor(ctx, R.color.text_muted))
                textSize = 11.5f
                setPadding(0, 12, 0, 4)
            }

            val etMsg = EditText(ctx).apply {
                minLines = 5
                maxLines = 10
                isVerticalScrollBarEnabled = true
                setTextColor(ContextCompat.getColor(ctx, R.color.text_white))
                textSize = 12f
                background = ContextCompat.getDrawable(ctx, R.drawable.bg_input_field)
                setPadding(24, 20, 24, 20)
            }

            // Initial selection based on status
            if (status.equals("suspended", ignoreCase = true) || status.equals("isolated", ignoreCase = true)) {
                spinnerTpl.setSelection(1)
                etMsg.setText(isolirTpl)
            } else {
                spinnerTpl.setSelection(0)
                etMsg.setText(billingTpl)
            }

            spinnerTpl.onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
                override fun onItemSelected(parent: android.widget.AdapterView<*>?, view: View?, position: Int, id: Long) {
                    when (position) {
                        0 -> etMsg.setText(billingTpl)
                        1 -> etMsg.setText(isolirTpl)
                        2 -> etMsg.setText(successTpl)
                        3 -> etMsg.setText(customTpl)
                    }
                }
                override fun onNothingSelected(parent: android.widget.AdapterView<*>?) {}
            }

            layout.addView(tvCustInfo)
            layout.addView(tvLabelTpl)
            layout.addView(spinnerTpl)
            layout.addView(tvLabelMsg)
            layout.addView(etMsg)

            AlertDialog.Builder(ctx)
                .setTitle("💬 Kirim Pesan WhatsApp")
                .setView(layout)
                .setPositiveButton("🚀 Kirim Bot Server") { _, _ ->
                    val finalMsg = etMsg.text.toString().trim()
                    if (finalMsg.isNotEmpty()) {
                        executeSendWhatsAppServer(phone, finalMsg)
                    }
                }
                .setNeutralButton("📱 Buka WhatsApp") { _, _ ->
                    val finalMsg = etMsg.text.toString().trim()
                    if (finalMsg.isNotEmpty()) {
                        openWhatsAppDirect(phone, finalMsg)
                    }
                }
                .setNegativeButton("Batal", null)
                .show()
        }
    }

    private fun executeSendWhatsAppServer(phone: String, message: String) {
        val ctx = context ?: return
        Toast.makeText(ctx, "Mengirim pesan via bot server...", Toast.LENGTH_SHORT).show()

        lifecycleScope.launch {
            val url = "${getBaseUrl()}/api/customer/app/admin/whatsapp/send"
            val bodyJson = JSONObject().apply {
                put("phone", phone)
                put("message", message)
            }.toString()

            val resStr = withContext(Dispatchers.IO) {
                try {
                    val reqBody = bodyJson.toRequestBody("application/json".toMediaType())
                    val req = Request.Builder().url(url)
                        .addHeader("Authorization", "Bearer ${getToken()}")
                        .post(reqBody).build()
                    val resp = httpClient().newCall(req).execute()
                    resp.body?.string()
                } catch (_: Exception) { null }
            }

            if (resStr != null) {
                try {
                    val json = JSONObject(resStr)
                    val msg = json.optString("message", "Pesan terkirim")
                    if (json.optBoolean("success")) {
                        Toast.makeText(ctx, "✅ $msg", Toast.LENGTH_LONG).show()
                    } else {
                        Toast.makeText(ctx, "⚠️ $msg", Toast.LENGTH_LONG).show()
                    }
                } catch (_: Exception) {
                    Toast.makeText(ctx, "Pesan berhasil diproses", Toast.LENGTH_SHORT).show()
                }
            } else {
                Toast.makeText(ctx, "Gagal terhubung ke server WhatsApp", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun openWhatsAppDirect(phone: String, message: String) {
        try {
            var p = phone.replace(Regex("[^0-9]"), "")
            if (p.startsWith("08")) p = "62" + p.substring(1)
            if (!p.startsWith("62")) p = "62" + p
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse("https://wa.me/$p?text=${Uri.encode(message)}"))
            startActivity(intent)
        } catch (_: Exception) {
            Toast.makeText(context, "Tidak dapat membuka WhatsApp", Toast.LENGTH_SHORT).show()
        }
    }

    private fun showCustomerTopupDialog(customerId: Int, customerName: String, currentBalance: Double) {
        val ctx = context ?: return
        val fmt = NumberFormat.getCurrencyInstance(Locale("id", "ID"))

        val layout = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 24, 48, 16)
        }

        val tvInfo = TextView(ctx).apply {
            text = "Pelanggan: $customerName\nSaldo Saat Ini: ${fmt.format(currentBalance)}"
            setTextColor(ContextCompat.getColor(ctx, R.color.text_white))
            textSize = 13.5f
            setTypeface(null, android.graphics.Typeface.BOLD)
            setPadding(0, 0, 0, 16)
        }
        layout.addView(tvInfo)

        // Radio Group: Tambah (+) vs Potong (-)
        val rgAction = RadioGroup(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, 0, 0, 16)
        }
        val rbAdd = RadioButton(ctx).apply {
            text = "➕ Tambah Saldo"
            setTextColor(ContextCompat.getColor(ctx, R.color.text_white))
            textSize = 12f
            isChecked = true
        }
        val rbDeduct = RadioButton(ctx).apply {
            text = "➖ Potong Saldo"
            setTextColor(ContextCompat.getColor(ctx, R.color.text_white))
            textSize = 12f
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { marginStart = 24 }
        }
        rgAction.addView(rbAdd)
        rgAction.addView(rbDeduct)
        layout.addView(rgAction)

        val tvLabelAmount = TextView(ctx).apply {
            text = "Nominal (Rp):"
            setTextColor(ContextCompat.getColor(ctx, R.color.accent))
            textSize = 12f
            setPadding(0, 0, 0, 6)
        }
        layout.addView(tvLabelAmount)

        val etAmount = EditText(ctx).apply {
            hint = "Contoh: 50000"
            inputType = android.text.InputType.TYPE_CLASS_NUMBER
            setTextColor(ContextCompat.getColor(ctx, R.color.text_white))
            setHintTextColor(ContextCompat.getColor(ctx, R.color.text_muted))
            textSize = 15f
            background = ContextCompat.getDrawable(ctx, R.drawable.bg_input_field)
            setPadding(24, 20, 24, 20)
        }
        layout.addView(etAmount)

        // Quick amount preset chips
        val quickAmounts = listOf(10000, 20000, 50000, 100000, 200000, 500000)
        val chipsRow1 = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, 12, 0, 6)
        }
        for (amt in quickAmounts.take(3)) {
            val btnChip = Button(ctx, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                layoutParams = LinearLayout.LayoutParams(0, 75, 1f).apply { marginEnd = 6 }
                text = "${amt / 1000}k"
                textSize = 11f
                setTextColor(ContextCompat.getColor(ctx, R.color.accent))
                setOnClickListener { etAmount.setText(amt.toString()) }
            }
            chipsRow1.addView(btnChip)
        }
        layout.addView(chipsRow1)

        val chipsRow2 = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, 0, 0, 14)
        }
        for (amt in quickAmounts.drop(3)) {
            val btnChip = Button(ctx, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                layoutParams = LinearLayout.LayoutParams(0, 75, 1f).apply { marginEnd = 6 }
                text = "${amt / 1000}k"
                textSize = 11f
                setTextColor(ContextCompat.getColor(ctx, R.color.accent))
                setOnClickListener { etAmount.setText(amt.toString()) }
            }
            chipsRow2.addView(btnChip)
        }
        layout.addView(chipsRow2)

        val tvLabelNote = TextView(ctx).apply {
            text = "Keterangan / Catatan:"
            setTextColor(ContextCompat.getColor(ctx, R.color.accent))
            textSize = 12f
            setPadding(0, 0, 0, 6)
        }
        layout.addView(tvLabelNote)

        val etNote = EditText(ctx).apply {
            hint = "Cth: Deposit Tunai di Loket"
            setTextColor(ContextCompat.getColor(ctx, R.color.text_white))
            setHintTextColor(ContextCompat.getColor(ctx, R.color.text_muted))
            textSize = 13.5f
            background = ContextCompat.getDrawable(ctx, R.drawable.bg_input_field)
            setPadding(24, 20, 24, 20)
        }
        layout.addView(etNote)

        val cbWa = CheckBox(ctx).apply {
            text = "Kirim Notifikasi WhatsApp ke Pelanggan"
            setTextColor(ContextCompat.getColor(ctx, R.color.text_white))
            textSize = 12f
            isChecked = true
            setPadding(8, 12, 0, 0)
        }
        layout.addView(cbWa)

        AlertDialog.Builder(ctx)
            .setTitle("💰 Kelola Saldo Pelanggan")
            .setView(layout)
            .setPositiveButton("Simpan Transaksi") { _, _ ->
                val amountStr = etAmount.text.toString().trim()
                val amount = amountStr.toDoubleOrNull() ?: 0.0
                if (amount <= 0) {
                    Toast.makeText(ctx, "Nominal tidak valid!", Toast.LENGTH_SHORT).show()
                } else {
                    val actionType = if (rbDeduct.isChecked) "deduct" else "add"
                    val note = etNote.text.toString().trim().ifEmpty {
                        if (actionType == "deduct") "Koreksi Saldo Manual" else "Setoran Tunai Manual"
                    }
                    val sendWa = cbWa.isChecked
                    processCustomerTopup(customerId, amount, actionType, note, sendWa, customerName)
                }
            }
            .setNegativeButton("Batal", null)
            .show()
    }

    private fun processCustomerTopup(
        customerId: Int,
        amount: Double,
        actionType: String,
        note: String,
        sendWhatsApp: Boolean,
        customerName: String
    ) {
        val ctx = context ?: return
        Toast.makeText(ctx, "Memproses update saldo...", Toast.LENGTH_SHORT).show()

        lifecycleScope.launch {
            val url = "${getBaseUrl()}/api/customer/app/admin/customers/topup"
            val bodyJson = JSONObject().apply {
                put("customerId", customerId)
                put("amount", amount)
                put("actionType", actionType)
                put("note", note)
                put("sendWhatsApp", sendWhatsApp)
            }.toString()

            val (success, message) = withContext(Dispatchers.IO) {
                try {
                    val reqBody = bodyJson.toRequestBody("application/json".toMediaType())
                    val req = Request.Builder().url(url)
                        .addHeader("Authorization", "Bearer ${getToken()}")
                        .post(reqBody).build()
                    val resp = httpClient().newCall(req).execute()
                    val respStr = resp.body?.string() ?: ""
                    val json = if (respStr.isNotEmpty()) JSONObject(respStr) else JSONObject()
                    val ok = resp.isSuccessful && json.optBoolean("success", false)
                    val msg = json.optString("message", if (ok) "Berhasil" else "Gagal memperbarui saldo")
                    Pair(ok, msg)
                } catch (e: Exception) {
                    Pair(false, e.message ?: "Koneksi gagal")
                }
            }

            if (success) {
                Toast.makeText(ctx, "✅ $message", Toast.LENGTH_LONG).show()
                loadCustomers(binding.etSearch.text.toString().trim())
            } else {
                Toast.makeText(ctx, "❌ $message", Toast.LENGTH_LONG).show()
            }
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}