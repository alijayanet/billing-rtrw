package com.alijaya.customer.ui.home

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.cardview.widget.CardView
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import com.alijaya.customer.CustomerApplication
import com.alijaya.customer.R
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.text.NumberFormat
import java.util.Locale
import java.util.concurrent.TimeUnit

class CustomerTopupFragment : Fragment() {
    private fun httpClient() = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(15, TimeUnit.SECONDS).build()
    private fun getBaseUrl(): String { val b = CustomerApplication.sessionManager.getServerBaseUrl(); return if (b.endsWith("/")) b.dropLast(1) else b }
    private fun getToken(): String = CustomerApplication.sessionManager.getAuthToken()
    private val fmt = NumberFormat.getCurrencyInstance(Locale("id", "ID"))

    private var activeTopupId: Int = 0
    private var isPolling = false
    private lateinit var etCustomAmount: EditText
    private lateinit var qrisContainer: LinearLayout
    private lateinit var ivQris: ImageView
    private lateinit var tvQrisTotal: TextView
    private lateinit var tvQrisStatus: TextView

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        val swipe = SwipeRefreshLayout(requireContext()).apply { setBackgroundColor(Color.parseColor("#0F172A")) }
        val scroll = android.widget.ScrollView(requireContext())
        val content = LinearLayout(requireContext()).apply { orientation = LinearLayout.VERTICAL; setPadding(32, 32, 32, 32) }
        scroll.addView(content); swipe.addView(scroll)
        buildUI(content)
        swipe.setOnRefreshListener { swipe.isRefreshing = false }
        return swipe
    }

    private fun buildUI(container: LinearLayout) {
        val ctx = requireContext()
        container.addView(TextView(ctx).apply { text = "💳 Isi Saldo Dompet (QRIS)"; setTextColor(Color.WHITE); textSize = 18f; typeface = Typeface.DEFAULT_BOLD; setPadding(0, 0, 0, 4) })
        container.addView(TextView(ctx).apply { text = "Top-up saldo otomatis menggunakan QRIS (BCA, Mandiri, BRI, GoPay, OVO, DANA, ShopeePay)."; setTextColor(Color.parseColor("#94A3B8")); textSize = 12f; setPadding(0, 0, 0, 16) })

        val card = CardView(ctx).apply { radius = 24f; setCardBackgroundColor(Color.parseColor("#1E293B")); cardElevation = 4f; layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT) }
        val inner = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL; setPadding(24, 24, 24, 24) }

        inner.addView(TextView(ctx).apply { text = "PILIH NOMINAL TOP-UP"; setTextColor(Color.parseColor("#38BDF8")); textSize = 11.5f; typeface = Typeface.DEFAULT_BOLD; setPadding(0, 0, 0, 10) })

        val amounts = listOf(10000, 20000, 50000, 100000, 200000, 500000)
        val grid1 = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL }
        val grid2 = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL; layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { setMargins(0, 8, 0, 16) } }

        fun makeChip(amt: Int): Button {
            return Button(ctx).apply {
                text = fmt.format(amt).replace(",00", "")
                setBackgroundColor(Color.parseColor("#334155"))
                setTextColor(Color.WHITE); textSize = 11f; typeface = Typeface.DEFAULT_BOLD
                layoutParams = LinearLayout.LayoutParams(0, 100, 1f).apply { setMargins(4, 0, 4, 0) }
                setOnClickListener { etCustomAmount.setText(amt.toString()); requestQris(amt) }
            }
        }

        for (i in 0 until 3) grid1.addView(makeChip(amounts[i]))
        for (i in 3 until 6) grid2.addView(makeChip(amounts[i]))
        inner.addView(grid1); inner.addView(grid2)

        inner.addView(TextView(ctx).apply { text = "ATAU MASUKKAN NOMINAL LAIN"; setTextColor(Color.parseColor("#94A3B8")); textSize = 11f; typeface = Typeface.DEFAULT_BOLD; setPadding(0, 0, 0, 6) })
        etCustomAmount = EditText(ctx).apply {
            hint = "Min. Rp 10.000"; setTextColor(Color.WHITE); setHintTextColor(Color.parseColor("#64748B")); textSize = 15f
            background = ContextCompat.getDrawable(ctx, R.drawable.bg_input_field); setPadding(24, 18, 24, 18)
            inputType = android.text.InputType.TYPE_CLASS_NUMBER
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { setMargins(0, 0, 0, 12) }
        }
        inner.addView(etCustomAmount)

        val btnGen = Button(ctx).apply {
            text = "⚡ Tampilkan QRIS Pembayaran"; setBackgroundColor(Color.parseColor("#2563EB")); setTextColor(Color.WHITE); textSize = 13f; typeface = Typeface.DEFAULT_BOLD
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 110)
            setOnClickListener {
                val amt = etCustomAmount.text.toString().toIntOrNull() ?: 0
                if (amt < 10000) { Toast.makeText(ctx, "Minimal top-up adalah Rp 10.000", Toast.LENGTH_SHORT).show(); return@setOnClickListener }
                requestQris(amt)
            }
        }
        inner.addView(btnGen)
        card.addView(inner)
        container.addView(card)

        // QRIS Display Container
        qrisContainer = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL
            visibility = View.GONE; setPadding(24, 24, 24, 24)
        }

        val qrisCard = CardView(ctx).apply {
            radius = 24f; setCardBackgroundColor(Color.WHITE); cardElevation = 6f
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { setMargins(0, 20, 0, 0) }
        }
        val qrisInner = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL; setPadding(24, 24, 24, 24) }

        tvQrisTotal = TextView(ctx).apply { text = "Total: Rp 0"; setTextColor(Color.BLACK); textSize = 18f; typeface = Typeface.DEFAULT_BOLD; setPadding(0, 0, 0, 8) }
        qrisInner.addView(tvQrisTotal)

        ivQris = ImageView(ctx).apply { layoutParams = LinearLayout.LayoutParams(600, 600) }
        qrisInner.addView(ivQris)

        tvQrisStatus = TextView(ctx).apply { text = "⏳ Menunggu Pembayaran via QRIS..."; setTextColor(Color.parseColor("#D97706")); textSize = 12.5f; typeface = Typeface.DEFAULT_BOLD; setPadding(0, 12, 0, 4) }
        qrisInner.addView(tvQrisStatus)

        qrisCard.addView(qrisInner)
        qrisContainer.addView(qrisCard)
        container.addView(qrisContainer)
    }

    private fun requestQris(amount: Int) {
        val ctx = context ?: return
        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) {
                try {
                    val body = JSONObject().put("amount", amount).toString().toRequestBody("application/json".toMediaType())
                    val req = Request.Builder().url("${getBaseUrl()}/api/customer/app/customer/topup/create")
                        .addHeader("Authorization", "Bearer ${getToken()}").post(body).build()
                    val resp = httpClient().newCall(req).execute()
                    resp.body?.string()?.let { JSONObject(it) }
                } catch (_: Exception) { null }
            }

            if (result?.optBoolean("success") == true) {
                val data = result.optJSONObject("data") ?: return@launch
                activeTopupId = data.optInt("topupId")
                val totalAmount = data.optLong("totalAmount")
                val qrisStr = data.optString("qrisString")

                tvQrisTotal.text = "Total Bayar: ${fmt.format(totalAmount)}"
                tvQrisStatus.text = "⏳ Menunggu Pembayaran via QRIS..."
                tvQrisStatus.setTextColor(Color.parseColor("#D97706"))

                // Render QRIS Bitmap
                if (qrisStr.isNotEmpty()) {
                    try {
                        val writer = QRCodeWriter()
                        val bitMatrix = writer.encode(qrisStr, BarcodeFormat.QR_CODE, 600, 600)
                        val width = bitMatrix.width
                        val height = bitMatrix.height
                        val bmp = Bitmap.createBitmap(width, height, Bitmap.Config.RGB_565)
                        for (x in 0 until width) {
                            for (y in 0 until height) {
                                bmp.setPixel(x, y, if (bitMatrix.get(x, y)) Color.BLACK else Color.WHITE)
                            }
                        }
                        ivQris.setImageBitmap(bmp)
                    } catch (_: Exception) {}
                }
                qrisContainer.visibility = View.VISIBLE

                startPolling(activeTopupId)
            } else {
                Toast.makeText(ctx, "❌ ${result?.optString("message") ?: "Gagal membuat QRIS"}", Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun startPolling(topupId: Int) {
        if (isPolling) return
        isPolling = true

        lifecycleScope.launch {
            while (isActive && isPolling) {
                delay(3000)
                val statusJson = withContext(Dispatchers.IO) {
                    try {
                        val req = Request.Builder().url("${getBaseUrl()}/api/customer/app/customer/topup/status/$topupId")
                            .addHeader("Authorization", "Bearer ${getToken()}").build()
                        val resp = httpClient().newCall(req).execute()
                        if (resp.isSuccessful) resp.body?.string()?.let { JSONObject(it) } else null
                    } catch (_: Exception) { null }
                }

                val st = statusJson?.optJSONObject("data")?.optString("status")
                if (st == "paid") {
                    isPolling = false
                    tvQrisStatus.text = "✅ PEMBAYARAN BERHASIL! SALDO BERTAMBAH"
                    tvQrisStatus.setTextColor(Color.parseColor("#16A34A"))
                    Toast.makeText(context, "🎉 Top-Up saldo berhasil!", Toast.LENGTH_LONG).show()
                    break
                }
            }
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        isPolling = false
    }
}
