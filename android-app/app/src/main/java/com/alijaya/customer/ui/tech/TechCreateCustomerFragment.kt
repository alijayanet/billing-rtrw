package com.alijaya.customer.ui.tech

import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import androidx.cardview.widget.CardView
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import com.alijaya.customer.CustomerApplication
import com.alijaya.customer.R
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

class TechCreateCustomerFragment : Fragment() {
    private fun httpClient() = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(15, TimeUnit.SECONDS).build()
    private fun getBaseUrl(): String { val b = CustomerApplication.sessionManager.getServerBaseUrl(); return if (b.endsWith("/")) b.dropLast(1) else b }
    private fun getToken(): String = CustomerApplication.sessionManager.getAuthToken()

    private var packagesList = mutableListOf<JSONObject>()
    private var routersList = mutableListOf<JSONObject>()
    private var odpsList = mutableListOf<JSONObject>()

    private lateinit var etName: EditText
    private lateinit var etPhone: EditText
    private lateinit var etAddress: EditText
    private lateinit var etArea: EditText
    private lateinit var etPppoeUser: EditText
    private lateinit var etPppoePass: EditText
    private lateinit var spinnerPkg: Spinner
    private lateinit var spinnerRouter: Spinner
    private lateinit var spinnerOdp: Spinner
    private lateinit var etIsolDay: EditText
    private lateinit var etNotes: EditText

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        val swipe = SwipeRefreshLayout(requireContext()).apply { setBackgroundColor(Color.parseColor("#0F172A")) }
        val scroll = android.widget.ScrollView(requireContext())
        val content = LinearLayout(requireContext()).apply { orientation = LinearLayout.VERTICAL; setPadding(32, 32, 32, 32) }
        scroll.addView(content); swipe.addView(scroll)
        buildForm(content, swipe)
        loadOptions()
        swipe.setOnRefreshListener { loadOptions(); swipe.isRefreshing = false }
        return swipe
    }

    private fun buildForm(container: LinearLayout, swipe: SwipeRefreshLayout) {
        val ctx = requireContext()
        container.addView(TextView(ctx).apply { text = "➕ Pasang Baru Pelanggan"; setTextColor(Color.WHITE); textSize = 18f; typeface = Typeface.DEFAULT_BOLD; setPadding(0, 0, 0, 4) })
        container.addView(TextView(ctx).apply { text = "Registrasi pelanggan baru langsung dari lapangan & auto-sync ke MikroTik."; setTextColor(Color.parseColor("#94A3B8")); textSize = 12f; setPadding(0, 0, 0, 16) })

        val card = CardView(ctx).apply { radius = 24f; setCardBackgroundColor(Color.parseColor("#1E293B")); cardElevation = 4f; layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT) }
        val form = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL; setPadding(24, 24, 24, 24) }

        fun addLabel(txt: String) = form.addView(TextView(ctx).apply { text = txt; setTextColor(Color.parseColor("#38BDF8")); textSize = 11.5f; typeface = Typeface.DEFAULT_BOLD; setPadding(0, 12, 0, 4) })
        fun createInput(h: String, def: String = ""): EditText {
            return EditText(ctx).apply {
                hint = h; setText(def); setTextColor(Color.WHITE); setHintTextColor(Color.parseColor("#64748B")); textSize = 13.5f
                background = ContextCompat.getDrawable(ctx, R.drawable.bg_input_field); setPadding(24, 18, 24, 18)
                layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            }
        }

        addLabel("NAMA PELANGGAN *")
        etName = createInput("Nama Lengkap")
        form.addView(etName)

        addLabel("NOMOR WHATSAPP *")
        etPhone = createInput("08123456789")
        form.addView(etPhone)

        addLabel("ALAMAT / BLOK / RT-RW")
        etAddress = createInput("Alamat Lengkap Rumah")
        form.addView(etAddress)

        addLabel("WILAYAH / AREA")
        etArea = createInput("Nama Area (contoh: Blok A / RT 01)")
        form.addView(etArea)

        addLabel("PILIH PAKET INTERNET *")
        spinnerPkg = Spinner(ctx).apply { background = ContextCompat.getDrawable(ctx, R.drawable.bg_input_field); setPadding(20, 20, 20, 20) }
        form.addView(spinnerPkg)

        addLabel("PILIH ROUTER MIKROTIK")
        spinnerRouter = Spinner(ctx).apply { background = ContextCompat.getDrawable(ctx, R.drawable.bg_input_field); setPadding(20, 20, 20, 20) }
        form.addView(spinnerRouter)

        addLabel("PILIH ODP (PORT FIBER)")
        spinnerOdp = Spinner(ctx).apply { background = ContextCompat.getDrawable(ctx, R.drawable.bg_input_field); setPadding(20, 20, 20, 20) }
        form.addView(spinnerOdp)

        addLabel("USERNAME PPPOE")
        etPppoeUser = createInput("Username PPPoE (misal: joko01)")
        form.addView(etPppoeUser)

        addLabel("PASSWORD PPPOE")
        etPppoePass = createInput("Password PPPoE", "123456")
        form.addView(etPppoePass)

        addLabel("TANGGAL JATUH TEMPO ISOLIR (1-28)")
        etIsolDay = createInput("Tanggal (1-28)", "10")
        form.addView(etIsolDay)

        addLabel("CATATAN INSTALASI")
        etNotes = createInput("Catatan kabel / posisi modem", "Pasang baru lapangan")
        form.addView(etNotes)

        val btnSubmit = Button(ctx).apply {
            text = "🚀 Daftarkan Pelanggan Sekarang"; setBackgroundColor(Color.parseColor("#2563EB")); setTextColor(Color.WHITE); textSize = 13.5f; typeface = Typeface.DEFAULT_BOLD
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 120).apply { setMargins(0, 28, 0, 8) }
            setOnClickListener { submitCustomer() }
        }
        form.addView(btnSubmit)

        card.addView(form)
        container.addView(card)
    }

    private fun loadOptions() {
        lifecycleScope.launch {
            val json = withContext(Dispatchers.IO) {
                try {
                    val req = Request.Builder().url("${getBaseUrl()}/api/customer/app/tech/customers/options")
                        .addHeader("Authorization", "Bearer ${getToken()}").build()
                    val resp = httpClient().newCall(req).execute()
                    if (resp.isSuccessful) resp.body?.string()?.let { JSONObject(it) } else null
                } catch (_: Exception) { null }
            }

            val ctx = context ?: return@launch
            val data = json?.optJSONObject("data")

            // Packages
            val pkgs = data?.optJSONArray("packages") ?: JSONArray()
            packagesList.clear()
            val pkgNames = mutableListOf<String>()
            for (i in 0 until pkgs.length()) {
                val p = pkgs.getJSONObject(i)
                packagesList.add(p)
                pkgNames.add("${p.optString("name")} - Rp ${p.optLong("price")}")
            }
            if (pkgNames.isEmpty()) pkgNames.add("Paket Default")
            spinnerPkg.adapter = ArrayAdapter(ctx, android.R.layout.simple_spinner_dropdown_item, pkgNames)

            // Routers
            val rtrs = data?.optJSONArray("routers") ?: JSONArray()
            routersList.clear()
            val rtrNames = mutableListOf<String>()
            for (i in 0 until rtrs.length()) {
                val r = rtrs.getJSONObject(i)
                routersList.add(r)
                rtrNames.add("${r.optString("name")} (${r.optString("host")})")
            }
            if (rtrNames.isEmpty()) rtrNames.add("Router Utama (Default)")
            spinnerRouter.adapter = ArrayAdapter(ctx, android.R.layout.simple_spinner_dropdown_item, rtrNames)

            // ODPs
            val odps = data?.optJSONArray("odps") ?: JSONArray()
            odpsList.clear()
            val odpNames = mutableListOf<String>()
            odpNames.add("-- Pilih ODP (Opsional) --")
            for (i in 0 until odps.length()) {
                val o = odps.getJSONObject(i)
                odpsList.add(o)
                odpNames.add("${o.optString("name")} (${o.optInt("used_ports")}/${o.optInt("total_ports")} port)")
            }
            spinnerOdp.adapter = ArrayAdapter(ctx, android.R.layout.simple_spinner_dropdown_item, odpNames)
        }
    }

    private fun submitCustomer() {
        val name = etName.text.toString().trim()
        val phone = etPhone.text.toString().trim()
        if (name.isEmpty()) { Toast.makeText(context, "Nama pelanggan wajib diisi", Toast.LENGTH_SHORT).show(); return }

        val pkgId = if (packagesList.isNotEmpty() && spinnerPkg.selectedItemPosition in packagesList.indices) packagesList[spinnerPkg.selectedItemPosition].optInt("id") else null
        val rtrId = if (routersList.isNotEmpty() && spinnerRouter.selectedItemPosition in routersList.indices) routersList[spinnerRouter.selectedItemPosition].optInt("id") else null
        val odpId = if (spinnerOdp.selectedItemPosition > 0 && (spinnerOdp.selectedItemPosition - 1) in odpsList.indices) odpsList[spinnerOdp.selectedItemPosition - 1].optInt("id") else null

        val body = JSONObject().apply {
            put("name", name)
            put("phone", phone)
            put("address", etAddress.text.toString().trim())
            put("area", etArea.text.toString().trim())
            put("package_id", pkgId)
            put("router_id", rtrId)
            put("odp_id", odpId)
            put("pppoe_username", etPppoeUser.text.toString().trim())
            put("pppoe_password", etPppoePass.text.toString().trim())
            put("isolate_day", etIsolDay.text.toString().toIntOrNull() ?: 10)
            put("notes", etNotes.text.toString().trim())
        }

        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) {
                try {
                    val reqBody = body.toString().toRequestBody("application/json".toMediaType())
                    val req = Request.Builder().url("${getBaseUrl()}/api/customer/app/tech/customers/create")
                        .addHeader("Authorization", "Bearer ${getToken()}").post(reqBody).build()
                    val resp = httpClient().newCall(req).execute()
                    resp.body?.string()?.let { JSONObject(it) }
                } catch (_: Exception) { null }
            }

            val ctx = context ?: return@launch
            if (result?.optBoolean("success") == true) {
                Toast.makeText(ctx, "✅ ${result.optString("message")}", Toast.LENGTH_LONG).show()
                parentFragmentManager.popBackStack()
            } else {
                Toast.makeText(ctx, "❌ ${result?.optString("message") ?: "Gagal menyimpan data"}", Toast.LENGTH_LONG).show()
            }
        }
    }
}
