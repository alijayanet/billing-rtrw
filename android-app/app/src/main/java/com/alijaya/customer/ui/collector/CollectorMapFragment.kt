package com.alijaya.customer.ui.collector

import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.cardview.widget.CardView
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import com.alijaya.customer.CustomerApplication
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

class CollectorMapFragment : Fragment() {
    private fun httpClient() = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(15, TimeUnit.SECONDS).build()
    private fun getBaseUrl(): String { val b = CustomerApplication.sessionManager.getServerBaseUrl(); return if (b.endsWith("/")) b.dropLast(1) else b }
    private fun getToken(): String = CustomerApplication.sessionManager.getAuthToken()

    private var allCustomers = mutableListOf<JSONObject>()
    private lateinit var contentContainer: LinearLayout
    private lateinit var listContainer: LinearLayout

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        val swipe = SwipeRefreshLayout(requireContext()).apply { setBackgroundColor(Color.parseColor("#0F172A")) }
        val scroll = android.widget.ScrollView(requireContext())
        contentContainer = LinearLayout(requireContext()).apply { orientation = LinearLayout.VERTICAL; setPadding(28, 28, 28, 28) }
        scroll.addView(contentContainer)
        swipe.addView(scroll)
        swipe.setOnRefreshListener { loadMapData(swipe) }
        return swipe
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        val swipe = view as SwipeRefreshLayout
        loadMapData(swipe)
    }

    private fun loadMapData(swipe: SwipeRefreshLayout) {
        swipe.isRefreshing = true
        lifecycleScope.launch {
            val json = withContext(Dispatchers.IO) {
                try {
                    val req = Request.Builder().url("${getBaseUrl()}/api/customer/app/collector/customers/map")
                        .addHeader("Authorization", "Bearer ${getToken()}").build()
                    val resp = httpClient().newCall(req).execute()
                    if (resp.isSuccessful) resp.body?.string()?.let { JSONObject(it) } else null
                } catch (_: Exception) { null }
            }
            swipe.isRefreshing = false
            contentContainer.removeAllViews()
            val ctx = context ?: return@launch

            val arr = json?.optJSONArray("data") ?: JSONArray()
            allCustomers.clear()
            for (i in 0 until arr.length()) {
                allCustomers.add(arr.getJSONObject(i))
            }

            renderView(ctx, "")
        }
    }

    private fun renderView(ctx: android.content.Context, query: String) {
        contentContainer.removeAllViews()

        contentContainer.addView(TextView(ctx).apply {
            text = "🗺️ Rute & Peta Penagihan"
            setTextColor(Color.WHITE); textSize = 19f; typeface = Typeface.DEFAULT_BOLD; setPadding(0, 0, 0, 4)
        })
        contentContainer.addView(TextView(ctx).apply {
            text = "Daftar titik lokasi rumah pelanggan tertunggak dengan navigasi langsung Google Maps."
            setTextColor(Color.parseColor("#94A3B8")); textSize = 12f; setPadding(0, 0, 0, 14)
        })

        // Search
        val etSearch = EditText(ctx).apply {
            hint = "🔍 Cari nama / alamat pelanggan..."
            setHintTextColor(Color.parseColor("#64748B"))
            setTextColor(Color.WHITE); textSize = 13f
            setBackgroundColor(Color.parseColor("#1E293B"))
            setPadding(24, 20, 24, 20)
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { setMargins(0, 0, 0, 14) }
            addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
                    filterAndRenderList(ctx, s.toString().trim())
                }
                override fun afterTextChanged(s: Editable?) {}
            })
        }
        contentContainer.addView(etSearch)

        // Summary Counter
        contentContainer.addView(TextView(ctx).apply {
            text = "📍 Total ${allCustomers.size} Titik Tagihan Belum Lunas"
            setTextColor(Color.parseColor("#38BDF8")); textSize = 12.5f; typeface = Typeface.DEFAULT_BOLD
            setBackgroundColor(Color.parseColor("#1E293B")); setPadding(20, 10, 20, 10)
        })

        listContainer = LinearLayout(ctx).apply {
            id = View.generateViewId()
            orientation = LinearLayout.VERTICAL
            setPadding(0, 12, 0, 0)
        }
        contentContainer.addView(listContainer)

        populateCards(ctx, listContainer, allCustomers)
    }

    private fun filterAndRenderList(ctx: android.content.Context, q: String) {
        listContainer.removeAllViews()

        val filtered = if (q.isEmpty()) {
            allCustomers
        } else {
            val lower = q.lowercase()
            allCustomers.filter {
                it.optString("name").lowercase().contains(lower) ||
                it.optString("address").lowercase().contains(lower) ||
                it.optString("phone").contains(lower)
            }
        }
        populateCards(ctx, listContainer, filtered)
    }

    private fun populateCards(ctx: android.content.Context, container: LinearLayout, list: List<JSONObject>) {
        if (list.isEmpty()) {
            container.addView(TextView(ctx).apply {
                text = "Tidak ada titik lokasi pelanggan ditemukan."
                setTextColor(Color.parseColor("#64748B")); textSize = 13f; setPadding(0, 24, 0, 0); gravity = Gravity.CENTER
            })
            return
        }

        val fmt = NumberFormat.getCurrencyInstance(Locale("id", "ID"))

        for (c in list) {
            val name = c.optString("name", "Pelanggan")
            val address = c.optString("address", "-")
            val phone = c.optString("phone", "-")
            val lat = c.optString("lat", "").trim()
            val lng = c.optString("lng", "").trim()
            val amount = c.optDouble("invoice_amount", c.optDouble("package_price", 0.0))
            val status = c.optString("status", "active")
            val isolateDay = c.optInt("isolate_day", 20)

            val card = CardView(ctx).apply {
                radius = 20f; setCardBackgroundColor(Color.parseColor("#1E293B")); cardElevation = 3f
                layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { setMargins(0, 0, 0, 16) }
            }
            val layout = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL; setPadding(24, 20, 24, 20) }

            // Header Row
            val topRow = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
            topRow.addView(TextView(ctx).apply {
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                text = "👤 $name"; setTextColor(Color.WHITE); textSize = 15f; typeface = Typeface.DEFAULT_BOLD
            })
            topRow.addView(TextView(ctx).apply {
                text = if (status == "suspended") "🔴 ISOLIR" else "⚠️ TERTUNGGAK"
                setTextColor(Color.WHITE); textSize = 10.5f; typeface = Typeface.DEFAULT_BOLD
                setBackgroundColor(if (status == "suspended") Color.parseColor("#DC2626") else Color.parseColor("#D97706"))
                setPadding(14, 4, 14, 4)
            })
            layout.addView(topRow)

            // Address & Bill Info
            layout.addView(TextView(ctx).apply {
                text = "📍 $address\n💰 Tagihan: ${fmt.format(amount)} (Jatuh Tempo Tgl $isolateDay)"
                setTextColor(Color.parseColor("#CBD5E1")); textSize = 12f; setPadding(0, 6, 0, 10)
            })

            // Action Buttons Row
            val btnRow = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL }

            val btnMaps = Button(ctx).apply {
                layoutParams = LinearLayout.LayoutParams(0, 84, 1.2f).apply { marginEnd = 6 }
                text = "🗺️ Buka Rute Maps"
                setTextColor(Color.WHITE); textSize = 11f; typeface = Typeface.DEFAULT_BOLD
                backgroundTintList = android.content.res.ColorStateList.valueOf(Color.parseColor("#0284C7"))
                setOnClickListener {
                    openGoogleMapsNavigation(ctx, lat, lng, address, name)
                }
            }
            btnRow.addView(btnMaps)

            if (phone.isNotEmpty() && phone != "-") {
                val btnWa = Button(ctx).apply {
                    layoutParams = LinearLayout.LayoutParams(0, 84, 1f)
                    text = "💬 WhatsApp"
                    setTextColor(Color.WHITE); textSize = 11f; typeface = Typeface.DEFAULT_BOLD
                    backgroundTintList = android.content.res.ColorStateList.valueOf(Color.parseColor("#15803D"))
                    setOnClickListener {
                        openWhatsApp(ctx, phone, name)
                    }
                }
                btnRow.addView(btnWa)
            }

            layout.addView(btnRow)
            card.addView(layout)
            container.addView(card)
        }
    }

    private fun openGoogleMapsNavigation(ctx: android.content.Context, lat: String, lng: String, address: String, name: String) {
        try {
            val uri = if (lat.isNotEmpty() && lng.isNotEmpty() && lat != "0" && lng != "0") {
                Uri.parse("google.navigation:q=$lat,$lng")
            } else {
                Uri.parse("geo:0,0?q=" + Uri.encode("$address ($name)"))
            }
            val intent = Intent(Intent.ACTION_VIEW, uri).apply {
                setPackage("com.google.android.apps.maps")
            }
            if (intent.resolveActivity(ctx.packageManager) != null) {
                ctx.startActivity(intent)
            } else {
                val browserUri = if (lat.isNotEmpty() && lng.isNotEmpty()) {
                    Uri.parse("https://www.google.com/maps/dir/?api=1&destination=$lat,$lng")
                } else {
                    Uri.parse("https://www.google.com/maps/search/?api=1&query=" + Uri.encode(address))
                }
                ctx.startActivity(Intent(Intent.ACTION_VIEW, browserUri))
            }
        } catch (e: Exception) {
            Toast.makeText(ctx, "Gagal membuka Maps: ${e.message}", Toast.LENGTH_SHORT).show()
        }
    }

    private fun openWhatsApp(ctx: android.content.Context, phone: String, name: String) {
        try {
            var p = phone.replace(Regex("[^0-9]"), "")
            if (p.startsWith("0")) p = "62" + p.substring(1)
            val msg = Uri.encode("Halo Kak $name, saya kolektor lapangan perihal konfirmasi jadwal penagihan internet. Terima kasih.")
            val uri = Uri.parse("https://wa.me/$p?text=$msg")
            ctx.startActivity(Intent(Intent.ACTION_VIEW, uri))
        } catch (_: Exception) {
            Toast.makeText(ctx, "WhatsApp tidak terpasang", Toast.LENGTH_SHORT).show()
        }
    }
}
