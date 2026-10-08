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
import android.widget.ScrollView
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
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.text.NumberFormat
import java.util.Locale
import java.util.concurrent.TimeUnit

class AdminCollectorPaymentsFragment : Fragment() {
    private fun httpClient() = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(15, TimeUnit.SECONDS).build()
    private fun getBaseUrl(): String { val b = CustomerApplication.sessionManager.getServerBaseUrl(); return if (b.endsWith("/")) b.dropLast(1) else b }
    private fun getToken(): String = CustomerApplication.sessionManager.getAuthToken()
    private val fmt = NumberFormat.getCurrencyInstance(Locale("id", "ID"))

    private lateinit var swipeRefresh: SwipeRefreshLayout
    private lateinit var contentContainer: LinearLayout

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        swipeRefresh = SwipeRefreshLayout(requireContext()).apply { setBackgroundColor(Color.parseColor("#0F172A")) }
        val scroll = ScrollView(requireContext()).apply { isFillViewport = true }
        contentContainer = LinearLayout(requireContext()).apply { orientation = LinearLayout.VERTICAL; setPadding(32, 32, 32, 32) }
        scroll.addView(contentContainer)
        swipeRefresh.addView(scroll)
        swipeRefresh.setOnRefreshListener { fetchData() }
        return swipeRefresh
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        fetchData()
    }

    private fun fetchData() {
        swipeRefresh.isRefreshing = true
        lifecycleScope.launch {
            val json = withContext(Dispatchers.IO) {
                try {
                    val req = Request.Builder().url("${getBaseUrl()}/api/customer/app/admin/collector-payments")
                        .addHeader("Authorization", "Bearer ${getToken()}").build()
                    val resp = httpClient().newCall(req).execute()
                    if (resp.isSuccessful) resp.body?.string()?.let { JSONObject(it) } else null
                } catch (_: Exception) { null }
            }
            swipeRefresh.isRefreshing = false
            contentContainer.removeAllViews()
            val ctx = context ?: return@launch
            val data = json?.optJSONObject("data")
            val pending = data?.optInt("pendingCount", 0) ?: 0
            contentContainer.addView(TextView(ctx).apply { text = "✅ Approval Pembayaran Kolektor"; setTextColor(Color.WHITE); textSize = 18f; typeface = Typeface.DEFAULT_BOLD; setPadding(0, 0, 0, 4) })
            if (pending > 0) contentContainer.addView(TextView(ctx).apply { text = "⏳ $pending pembayaran menunggu approval"; setTextColor(Color.parseColor("#FACC15")); textSize = 12f; typeface = Typeface.DEFAULT_BOLD; setPadding(0, 0, 0, 16) })
            else contentContainer.addView(TextView(ctx).apply { text = "Tidak ada pembayaran pending"; setTextColor(Color.parseColor("#4ADE80")); textSize = 12f; setPadding(0, 0, 0, 16) })

            val arr = data?.optJSONArray("payments") ?: JSONArray()
            for (i in 0 until arr.length()) {
                val item = arr.getJSONObject(i)
                val payId = item.optInt("id")
                val status = item.optString("status", "pending")
                val card = CardView(ctx).apply { radius = 24f; setCardBackgroundColor(Color.parseColor("#1E293B")); cardElevation = 4f; layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { setMargins(0, 0, 0, 12) } }
                val inner = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL; setPadding(24, 20, 24, 20) }

                val top = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
                top.addView(TextView(ctx).apply {
                    text = item.optString("customer_name", "Pelanggan")
                    setTextColor(Color.WHITE); textSize = 14.5f; typeface = Typeface.DEFAULT_BOLD
                    layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                })
                top.addView(TextView(ctx).apply {
                    text = status.uppercase()
                    setTextColor(if (status == "approved") Color.parseColor("#4ADE80") else Color.parseColor("#FACC15"))
                    textSize = 11.5f; typeface = Typeface.DEFAULT_BOLD
                })
                inner.addView(top)

                inner.addView(TextView(ctx).apply {
                    text = "${fmt.format(item.optDouble("amount", 0.0))} • Kolektor: ${item.optString("collector_name", "-")}"
                    setTextColor(Color.parseColor("#94A3B8")); textSize = 12f; setPadding(0, 4, 0, 8)
                })

                if (status == "pending") {
                    val approveBtn = Button(ctx).apply {
                        text = "Setujui Pembayaran"
                        setBackgroundColor(Color.parseColor("#22C55E"))
                        setTextColor(Color.WHITE); textSize = 12f; typeface = Typeface.DEFAULT_BOLD
                        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 96)
                    }
                    approveBtn.setOnClickListener { approvePayment(payId) }
                    inner.addView(approveBtn)
                }
                card.addView(inner)
                contentContainer.addView(card)
            }
        }
    }

    private fun approvePayment(paymentId: Int) {
        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) {
                try {
                    val body = JSONObject().put("paymentId", paymentId).toString().toRequestBody("application/json".toMediaType())
                    val req = Request.Builder().url("${getBaseUrl()}/api/customer/app/admin/collector-payments/approve")
                        .addHeader("Authorization", "Bearer ${getToken()}").post(body).build()
                    val resp = httpClient().newCall(req).execute()
                    resp.body?.string()?.let { JSONObject(it) }
                } catch (_: Exception) { null }
            }
            Toast.makeText(context, result?.optString("message") ?: "Gagal memproses", Toast.LENGTH_SHORT).show()
            fetchData()
        }
    }
}
