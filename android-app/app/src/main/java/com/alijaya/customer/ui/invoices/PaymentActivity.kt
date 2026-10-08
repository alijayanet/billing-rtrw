package com.alijaya.customer.ui.invoices

import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.view.View
import android.widget.ImageView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.alijaya.customer.CustomerApplication
import com.alijaya.customer.R
import com.alijaya.customer.databinding.ActivityPaymentBinding
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.text.NumberFormat
import java.util.Locale
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

class PaymentActivity : AppCompatActivity() {
    private lateinit var binding: ActivityPaymentBinding
    private var invoiceId: Int = 0
    private var publicToken: String? = null
    private var totalAmountToPay: Double = 0.0
    private var currentQrBitmap: Bitmap? = null
    private var currentQrPayload: String = ""
    private var isPollingActive: Boolean = false
    private var isPaymentCompleted: Boolean = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityPaymentBinding.inflate(layoutInflater)
        setContentView(binding.root)

        invoiceId = intent.getIntExtra("invoice_id", 0)
        publicToken = intent.getStringExtra("public_token")

        binding.btnBack.setOnClickListener { finish() }

        setupActions()

        binding.pbQrisLoading.visibility = View.VISIBLE
        loadInvoiceAndQris()
    }

    override fun onResume() {
        super.onResume()
        if (!isPaymentCompleted) {
            isPollingActive = true
            startAutoPolling()
        }
    }

    override fun onPause() {
        super.onPause()
        isPollingActive = false
    }

    override fun onDestroy() {
        super.onDestroy()
        isPollingActive = false
    }

    private fun setupActions() {
        binding.btnSaveQrisGallery.setOnClickListener {
            saveQrToGallery()
        }

        binding.btnCopyNominal.setOnClickListener {
            copyNominalToClipboard()
        }

        binding.btnCheckStatus.setOnClickListener {
            checkPaymentStatus(showAlert = true)
        }

        binding.btnEnlargeQris.setOnClickListener {
            showFullScreenQrDialog()
        }

        binding.btnConfirmPayment.setOnClickListener {
            val phone = CustomerApplication.sessionManager.getFormattedAdminPhone()
            if (phone.isBlank()) {
                Toast.makeText(this, "Nomor WhatsApp admin belum dikonfigurasi di server.", Toast.LENGTH_LONG).show()
                return@setOnClickListener
            }
            val custName = CustomerApplication.sessionManager.getCustomerName().ifBlank { "Pelanggan" }
            val text = "Halo Admin, saya konfirmasi pembayaran tagihan #INV-$invoiceId sebesar Rp ${totalAmountToPay.toLong()} atas nama $custName"
            val url = "https://wa.me/$phone?text=" + Uri.encode(text)
            try {
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
            } catch (_: Exception) {
                Toast.makeText(this, "Tidak dapat membuka aplikasi WhatsApp.", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun saveQrToGallery() {
        val bitmap = currentQrBitmap ?: run {
            Toast.makeText(this, "Gambar QRIS sedang dimuat, mohon tunggu...", Toast.LENGTH_SHORT).show()
            return
        }

        try {
            val filename = "QRIS_INV_${invoiceId}_${System.currentTimeMillis()}.png"
            var savedSuccessfully = false

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val contentValues = ContentValues().apply {
                    put(MediaStore.MediaColumns.DISPLAY_NAME, filename)
                    put(MediaStore.MediaColumns.MIME_TYPE, "image/png")
                    put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/QRIS")
                    put(MediaStore.MediaColumns.IS_PENDING, 1)
                }

                val uri = contentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, contentValues)
                if (uri != null) {
                    contentResolver.openOutputStream(uri)?.use { stream ->
                        bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream)
                    }
                    contentValues.clear()
                    contentValues.put(MediaStore.MediaColumns.IS_PENDING, 0)
                    contentResolver.update(uri, contentValues, null, null)
                    savedSuccessfully = true
                }
            } else {
                @Suppress("DEPRECATION")
                val inserted = MediaStore.Images.Media.insertImage(contentResolver, bitmap, filename, "QRIS Tagihan #INV-$invoiceId")
                savedSuccessfully = !inserted.isNullOrBlank()
            }

            if (savedSuccessfully) {
                AlertDialog.Builder(this)
                    .setTitle("📥 QRIS Disimpan ke Galeri!")
                    .setMessage("Gambar barcode QRIS telah berhasil disimpan ke Galeri Foto HP Anda.\n\n" +
                            "Cara Bayar di m-Banking / e-Wallet:\n" +
                            "1. Buka BCA / Mandiri Livin / BRImo / BNI / DANA / GoPay / ShopeePay.\n" +
                            "2. Pilih menu QRIS / Bayar.\n" +
                            "3. Klik ikon 'Galeri' di aplikasi m-banking dan pilih barcode ini.\n" +
                            "4. Pastikan nominal pas dan konfirmasi pembayaran.")
                    .setPositiveButton("Buka m-Banking Sekarang", null)
                    .show()
            } else {
                Toast.makeText(this, "Gagal menyimpan gambar QRIS ke galeri.", Toast.LENGTH_SHORT).show()
            }
        } catch (e: Exception) {
            Toast.makeText(this, "Error: ${e.message}", Toast.LENGTH_LONG).show()
        }
    }

    private fun copyNominalToClipboard() {
        val nominalLong = totalAmountToPay.toLong()
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val clip = ClipData.newPlainText("Nominal Tagihan", nominalLong.toString())
        clipboard.setPrimaryClip(clip)

        val fmt = NumberFormat.getCurrencyInstance(Locale("id", "ID"))
        Toast.makeText(this, "📋 Nominal ${fmt.format(nominalLong)} disalin ke clipboard!", Toast.LENGTH_SHORT).show()
    }

    private fun startAutoPolling() {
        lifecycleScope.launch {
            while (isPollingActive && !isPaymentCompleted) {
                delay(3500)
                if (!isPollingActive || isPaymentCompleted) break
                val isPaid = checkPaymentStatusSilent()
                if (isPaid) {
                    isPaymentCompleted = true
                    isPollingActive = false
                    showPaymentSuccessDialog()
                    break
                }
            }
        }
    }

    private fun generateLocalQrBitmap(content: String) {
        lifecycleScope.launch(Dispatchers.Default) {
            try {
                val writer = QRCodeWriter()
                val bitMatrix = writer.encode(content, BarcodeFormat.QR_CODE, 600, 600)
                val width = bitMatrix.width
                val height = bitMatrix.height
                val bmp = Bitmap.createBitmap(width, height, Bitmap.Config.RGB_565)
                for (x in 0 until width) {
                    for (y in 0 until height) {
                        bmp.setPixel(x, y, if (bitMatrix.get(x, y)) Color.BLACK else Color.WHITE)
                    }
                }
                currentQrBitmap = bmp
                withContext(Dispatchers.Main) {
                    binding.ivQrisImage.setImageBitmap(bmp)
                    binding.pbQrisLoading.visibility = View.GONE
                }
            } catch (_: Exception) {}
        }
    }

    private fun showFullScreenQrDialog() {
        if (currentQrBitmap == null) return
        val iv = ImageView(this).apply {
            setImageBitmap(currentQrBitmap)
            scaleType = ImageView.ScaleType.FIT_CENTER
            setPadding(30, 30, 30, 30)
            setBackgroundColor(Color.WHITE)
        }
        AlertDialog.Builder(this)
            .setTitle(" Barcode QRIS Tagihan")
            .setView(iv)
            .setPositiveButton("Tutup", null)
            .show()
    }

    private fun getUnsafeOkHttpClient(): OkHttpClient {
        val builder = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)

        try {
            val trustAllCerts = arrayOf<TrustManager>(
                object : X509TrustManager {
                    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
                    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
                    override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
                }
            )
            val sslContext = SSLContext.getInstance("SSL")
            sslContext.init(null, trustAllCerts, SecureRandom())
            builder.sslSocketFactory(sslContext.socketFactory, trustAllCerts[0] as X509TrustManager)
            builder.hostnameVerifier { _, _ -> true }
        } catch (_: Exception) {}

        return builder.build()
    }

    private fun loadInvoiceAndQris() {
        val base = CustomerApplication.sessionManager.getServerBaseUrl()
        val token = CustomerApplication.sessionManager.getAuthToken()

        var url = if (base.endsWith("/")) base + "api/customer/invoices/" + invoiceId else base + "/api/customer/invoices/" + invoiceId
        var qrisImgUrl = if (base.endsWith("/")) base + "api/customer/invoices/" + invoiceId + "/qris-image" else base + "/api/customer/invoices/" + invoiceId + "/qris-image"

        if (!publicToken.isNullOrBlank()) {
            val separator = if (url.contains("?")) "&" else "?"
            url += separator + "token=" + Uri.encode(publicToken)
            qrisImgUrl += separator + "token=" + Uri.encode(publicToken)
        }

        lifecycleScope.launch {
            // 1. Fetch JSON details
            val jsonStr = withContext(Dispatchers.IO) {
                try {
                    val client = getUnsafeOkHttpClient()
                    val reqBuilder = Request.Builder().url(url)
                    if (!token.isNullOrBlank()) {
                        reqBuilder.addHeader("Authorization", "Bearer $token")
                    }
                    if (!publicToken.isNullOrBlank()) {
                        reqBuilder.addHeader("x-invoice-token", publicToken ?: "")
                    }
                    val resp = client.newCall(reqBuilder.build()).execute()
                    if (resp.isSuccessful) resp.body?.string() else null
                } catch (_: Exception) { null }
            }

            if (jsonStr != null) {
                try {
                    val data = JSONObject(jsonStr).optJSONObject("data")
                    if (data != null) {
                        val adminPhone = data.optString("adminPhone", data.optString("companyPhone", ""))
                        if (adminPhone.isNotBlank()) {
                            CustomerApplication.sessionManager.saveAdminPhone(adminPhone)
                        }
                        val baseAmt = data.optDouble("baseAmount", 150000.0)
                        val uniqueCode = data.optInt("uniqueCode", 123)
                        val totalAmt = data.optDouble("totalAmount", baseAmt + uniqueCode)
                        totalAmountToPay = totalAmt

                        val payload = data.optString("qrisPayload", "")
                        if (payload.isNotEmpty()) {
                            currentQrPayload = payload
                            generateLocalQrBitmap(payload)
                        }

                        val fmt = NumberFormat.getCurrencyInstance(Locale("id", "ID"))

                        binding.tvInvoiceNo.text = data.optString("invoiceNo", "#INV-$invoiceId")
                        binding.tvPackageName.text = data.optString("packageName", "Paket Internet Home")
                        binding.tvPeriod.text = "Periode: Bulan " + data.optInt("periodMonth", 8) + "/" + data.optInt("periodYear", 2026)

                        binding.tvBaseAmount.text = fmt.format(baseAmt)
                        binding.tvUniqueCode.text = "+ " + fmt.format(uniqueCode)
                        binding.tvTotalAmount.text = fmt.format(totalAmt)
                        binding.tvQrisNotice.text = "Pastikan nominal transfer PERSIS SAMA hingga digit terakhir (" + fmt.format(totalAmt) + ") agar otomatis terverifikasi LUNAS."

                        val status = data.optString("status", "unpaid")
                        if (status == "paid" || status == "lunas") {
                            isPaymentCompleted = true
                            isPollingActive = false
                            binding.tvTotalAmount.setTextColor(ContextCompat.getColor(this@PaymentActivity, R.color.success))
                            binding.tvTotalAmount.text = fmt.format(totalAmt) + " (LUNAS)"
                            binding.btnCheckStatus.text = "✅ Tagihan Ini Telah LUNAS"
                            binding.layoutPollingStatus.visibility = View.GONE
                        }
                    }
                } catch (_: Exception) {}
            }

            // 2. Fetch QR Image Bitmap from server as double verification
            val bitmap = withContext(Dispatchers.IO) {
                try {
                    val client = getUnsafeOkHttpClient()
                    val req = Request.Builder().url(qrisImgUrl).build()
                    val resp = client.newCall(req).execute()
                    if (resp.isSuccessful) {
                        val bytes = resp.body?.bytes()
                        if (bytes != null) BitmapFactory.decodeByteArray(bytes, 0, bytes.size) else null
                    } else null
                } catch (_: Exception) { null }
            }

            if (bitmap != null) {
                currentQrBitmap = bitmap
                binding.ivQrisImage.setImageBitmap(bitmap)
                binding.pbQrisLoading.visibility = View.GONE
            }
        }
    }

    private suspend fun checkPaymentStatusSilent(): Boolean {
        val base = CustomerApplication.sessionManager.getServerBaseUrl()
        val token = CustomerApplication.sessionManager.getAuthToken()
        var url = if (base.endsWith("/")) base + "api/customer/invoices/" + invoiceId + "/check-status" else base + "/api/customer/invoices/" + invoiceId + "/check-status"

        if (!publicToken.isNullOrBlank()) {
            val separator = if (url.contains("?")) "&" else "?"
            url += separator + "token=" + Uri.encode(publicToken)
        }

        return withContext(Dispatchers.IO) {
            try {
                val client = getUnsafeOkHttpClient()
                val reqBuilder = Request.Builder().url(url)
                if (!token.isNullOrBlank()) {
                    reqBuilder.addHeader("Authorization", "Bearer $token")
                }
                if (!publicToken.isNullOrBlank()) {
                    reqBuilder.addHeader("x-invoice-token", publicToken ?: "")
                }
                val resp = client.newCall(reqBuilder.build()).execute()
                if (resp.isSuccessful) {
                    val str = resp.body?.string()
                    if (str != null) JSONObject(str).optJSONObject("data")?.optBoolean("isPaid", false) == true else false
                } else false
            } catch (_: Exception) { false }
        }
    }

    private fun checkPaymentStatus(showAlert: Boolean = true) {
        if (showAlert) {
            Toast.makeText(this, "Memeriksa status pembayaran...", Toast.LENGTH_SHORT).show()
        }

        lifecycleScope.launch {
            val isPaid = checkPaymentStatusSilent()
            if (isPaid) {
                isPaymentCompleted = true
                isPollingActive = false
                showPaymentSuccessDialog()
            } else if (showAlert) {
                Toast.makeText(this@PaymentActivity, "Status: Menunggu Pembayaran. Silakan scan QRIS atau gunakan tombol Simpan QR.", Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun showPaymentSuccessDialog() {
        val fmt = NumberFormat.getCurrencyInstance(Locale("id", "ID"))
        binding.tvTotalAmount.setTextColor(ContextCompat.getColor(this@PaymentActivity, R.color.success))
        binding.tvTotalAmount.text = fmt.format(totalAmountToPay) + " (LUNAS)"
        binding.btnCheckStatus.text = "✅ Tagihan Ini Telah LUNAS"
        binding.layoutPollingStatus.visibility = View.GONE

        AlertDialog.Builder(this@PaymentActivity)
            .setTitle("🎉 Pembayaran Berhasil Diverifikasi!")
            .setMessage("Pembayaran tagihan #INV-$invoiceId sebesar ${fmt.format(totalAmountToPay)} telah diverifikasi lunas oleh sistem.\n\nLayanan internet WiFi rumah Anda telah aktif kembali secara otomatis.")
            .setCancelable(false)
            .setPositiveButton("Selesai") { _, _ -> finish() }
            .show()
    }
}
