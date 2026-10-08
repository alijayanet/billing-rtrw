package com.alijaya.customer.ui.admin

import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
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

class AdminCashInFragment : Fragment() {
    private fun httpClient() = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(15, TimeUnit.SECONDS).build()
    private fun getBaseUrl(): String { val b = CustomerApplication.sessionManager.getServerBaseUrl(); return if (b.endsWith("/")) b.dropLast(1) else b }
    private fun getToken(): String = CustomerApplication.sessionManager.getAuthToken()
    private val fmt = NumberFormat.getCurrencyInstance(Locale("id", "ID"))

    private lateinit var swipeRefresh: SwipeRefreshLayout
    private lateinit var contentContainer: LinearLayout

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        swipeRefresh = SwipeRefreshLayout(requireContext()).apply { setBackgroundColor(Color.parseColor("#0F172A")) }
        val scroll = android.widget.ScrollView(requireContext()).apply { isFillViewport = true }
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
        val container = contentContainer
        swipeRefresh.isRefreshing = true
        lifecycleScope.launch {
            val json = withContext(Dispatchers.IO) { try { val req = Request.Builder().url("${getBaseUrl()}/api/customer/app/admin/cash-in").addHeader("Authorization", "Bearer ${getToken()}").build(); val resp = httpClient().newCall(req).execute(); if (resp.isSuccessful) resp.body?.string()?.let { JSONObject(it) } else null } catch (_: Exception) { null } }
            swipeRefresh.isRefreshing = false; container.removeAllViews(); val ctx = context ?: return@launch
            val data = json?.optJSONObject("data")
            val totalMonth = data?.optDouble("totalMonth", 0.0) ?: 0.0

            container.addView(TextView(ctx).apply { text = "💵 Pemasukan Kas Non-Billing"; setTextColor(Color.WHITE); textSize = 18f; typeface = Typeface.DEFAULT_BOLD; setPadding(0, 0, 0, 8) })

            // Total Card
            val totCard = CardView(ctx).apply { radius = 24f; setCardBackgroundColor(Color.parseColor("#132742")); cardElevation = 4f; layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { setMargins(0, 0, 0, 16) } }
            val totInner = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL; setPadding(24, 20, 24, 20) }
            totInner.addView(TextView(ctx).apply { text = "Total Pemasukan Kas Bulan Ini"; setTextColor(Color.parseColor("#38BDF8")); textSize = 12f; typeface = Typeface.DEFAULT_BOLD })
            totInner.addView(TextView(ctx).apply { text = fmt.format(totalMonth); setTextColor(Color.WHITE); textSize = 20f; typeface = Typeface.DEFAULT_BOLD; setPadding(0, 4, 0, 0) })
            totCard.addView(totInner); container.addView(totCard)

            val arr = data?.optJSONArray("cashIn") ?: JSONArray()
            if (arr.length() == 0) { container.addView(TextView(ctx).apply { text = "Belum ada transaksi pemasukan kas"; setTextColor(Color.parseColor("#94A3B8")); textSize = 14f; gravity = Gravity.CENTER; setPadding(0, 40, 0, 40) }); return@launch }

            for (i in 0 until arr.length()) {
                val item = arr.getJSONObject(i)
                val card = CardView(ctx).apply { radius = 24f; setCardBackgroundColor(Color.parseColor("#1E293B")); cardElevation = 4f; layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { setMargins(0, 0, 0, 12) } }
                val inner = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL; setPadding(24, 16, 24, 16) }
                val row1 = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
                row1.addView(TextView(ctx).apply { text = item.optString("source", item.optString("category", "Pemasukan")); setTextColor(Color.WHITE); textSize = 14f; typeface = Typeface.DEFAULT_BOLD; layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f) })
                row1.addView(TextView(ctx).apply { text = "+${fmt.format(item.optDouble("amount", 0.0))}"; setTextColor(Color.parseColor("#4ADE80")); textSize = 14f; typeface = Typeface.DEFAULT_BOLD })
                inner.addView(row1)
                inner.addView(TextView(ctx).apply { text = "${item.optString("date", "-")} • ${item.optString("description", "-")}"; setTextColor(Color.parseColor("#94A3B8")); textSize = 11.5f; setPadding(0, 4, 0, 0) })
                card.addView(inner); container.addView(card)
            }
        }
    }
}
