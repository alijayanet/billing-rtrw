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
import android.widget.Toast
import androidx.cardview.widget.CardView
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import com.alijaya.customer.CustomerApplication
import com.alijaya.customer.R
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

class AdminAuditLogFragment : Fragment() {
    private fun httpClient() = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(15, TimeUnit.SECONDS).build()
    private fun getBaseUrl(): String { val b = CustomerApplication.sessionManager.getServerBaseUrl(); return if (b.endsWith("/")) b.dropLast(1) else b }
    private fun getToken(): String = CustomerApplication.sessionManager.getAuthToken()

    private lateinit var swipeRefresh: SwipeRefreshLayout
    private lateinit var contentContainer: LinearLayout

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        swipeRefresh = SwipeRefreshLayout(requireContext()).apply { id = R.id.swipe_refresh; setBackgroundColor(Color.parseColor("#0F172A")) }
        val scroll = android.widget.ScrollView(requireContext()).apply { isFillViewport = true }
        contentContainer = LinearLayout(requireContext()).apply { orientation = LinearLayout.VERTICAL; setPadding(32, 32, 32, 32); id = View.generateViewId() }
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
                    val req = Request.Builder().url("${getBaseUrl()}/api/customer/app/admin/audit-logs")
                        .addHeader("Authorization", "Bearer ${getToken()}").build()
                    val resp = httpClient().newCall(req).execute()
                    if (resp.isSuccessful) resp.body?.string()?.let { JSONObject(it) } else null
                } catch (_: Exception) { null }
            }
            val container = contentContainer
            swipeRefresh.isRefreshing = false
            container.removeAllViews()
            val ctx = context ?: return@launch

            // Title
            container.addView(TextView(ctx).apply { text = "📋 Audit Log"; setTextColor(Color.WHITE); textSize = 18f; typeface = Typeface.DEFAULT_BOLD; setPadding(0, 0, 0, 16) })

            val arr = json?.optJSONArray("data") ?: JSONArray()
            if (arr.length() == 0) {
                container.addView(TextView(ctx).apply { text = "Belum ada log audit"; setTextColor(Color.parseColor("#94A3B8")); textSize = 14f; gravity = Gravity.CENTER; setPadding(0, 40, 0, 40) })
                return@launch
            }

            for (i in 0 until arr.length()) {
                val item = arr.getJSONObject(i)
                val card = CardView(ctx).apply {
                    radius = 24f; setCardBackgroundColor(Color.parseColor("#1E293B")); cardElevation = 4f
                    layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { setMargins(0, 0, 0, 16) }
                }
                val inner = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL; setPadding(24, 16, 24, 16) }
                inner.addView(TextView(ctx).apply { text = item.optString("action", "-"); setTextColor(Color.WHITE); textSize = 13.5f; typeface = Typeface.DEFAULT_BOLD })
                inner.addView(TextView(ctx).apply { text = "Oleh: ${item.optString("performed_by", item.optString("user", "-"))} • ${item.optString("created_at", "-")}"; setTextColor(Color.parseColor("#94A3B8")); textSize = 11f })
                val details = item.optString("details", item.optString("description", ""))
                if (details.isNotEmpty()) inner.addView(TextView(ctx).apply { text = details; setTextColor(Color.parseColor("#CBD5E1")); textSize = 11.5f; setPadding(0, 4, 0, 0) })
                card.addView(inner)
                container.addView(card)
            }
        }
    }
}
