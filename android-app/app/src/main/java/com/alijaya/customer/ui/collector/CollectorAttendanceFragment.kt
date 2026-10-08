package com.alijaya.customer.ui.collector

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.location.LocationManager
import android.os.Bundle
import android.util.Base64
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.cardview.widget.CardView
import androidx.core.content.ContextCompat
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
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.TimeUnit

class CollectorAttendanceFragment : Fragment() {
    private fun httpClient() = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(15, TimeUnit.SECONDS).build()
    private fun getBaseUrl(): String { val b = CustomerApplication.sessionManager.getServerBaseUrl(); return if (b.endsWith("/")) b.dropLast(1) else b }
    private fun getToken(): String = CustomerApplication.sessionManager.getAuthToken()

    private lateinit var swipeRefresh: SwipeRefreshLayout
    private lateinit var contentContainer: LinearLayout

    private var capturedSelfieBitmap: Bitmap? = null
    private var cardSelfiePreview: CardView? = null
    private var ivSelfiePreview: ImageView? = null
    private var tvPlaceholder: TextView? = null
    private var btnCapturePhoto: Button? = null
    private var dynamicCompanyName: String = "ALIJAYA NET"

    private val takePictureLauncher = registerForActivityResult(
        ActivityResultContracts.TakePicturePreview()
    ) { bitmap ->
        if (bitmap != null) {
            val loc = getCurrentLocation()
            val latStr = if (loc != null) String.format(Locale.US, "%.6f", loc.first) else "-6.252119"
            val lngStr = if (loc != null) String.format(Locale.US, "%.6f", loc.second) else "107.920527"
            val colName = CustomerApplication.sessionManager.getCustomerName().ifEmpty { "Kolektor Lapangan" }

            val watermarked = addGeotagWatermark(
                original = bitmap,
                company = dynamicCompanyName,
                roleTitle = "KOLEKTOR PORTAL - ABSENSI",
                employeeName = colName,
                lat = latStr,
                lng = lngStr
            )

            capturedSelfieBitmap = watermarked
            tvPlaceholder?.visibility = View.GONE
            ivSelfiePreview?.apply {
                setImageBitmap(watermarked)
                visibility = View.VISIBLE
            }
            cardSelfiePreview?.visibility = View.VISIBLE
            btnCapturePhoto?.apply {
                text = "🔄 Ganti Foto Selfie (Geo-Tagged)"
                backgroundTintList = android.content.res.ColorStateList.valueOf(Color.parseColor("#0284C7"))
            }
            Toast.makeText(context, "📸 Foto selfie berhasil diambil & ditampilkan!", Toast.LENGTH_SHORT).show()
        } else {
            Toast.makeText(context, "Batal mengambil foto selfie", Toast.LENGTH_SHORT).show()
        }
    }

    private val cameraPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { isGranted ->
        if (isGranted) {
            takePictureLauncher.launch(null)
        } else {
            Toast.makeText(context, "Izin kamera diperlukan untuk mengambil foto selfie", Toast.LENGTH_SHORT).show()
        }
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        swipeRefresh = SwipeRefreshLayout(requireContext()).apply { setBackgroundColor(Color.parseColor("#0F172A")) }
        val scroll = ScrollView(requireContext()).apply { isFillViewport = true }
        contentContainer = LinearLayout(requireContext()).apply { orientation = LinearLayout.VERTICAL; setPadding(32, 32, 32, 32) }
        scroll.addView(contentContainer)
        swipeRefresh.addView(scroll)
        swipeRefresh.setOnRefreshListener { fetchAttendance() }
        return swipeRefresh
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        checkPermissions()
        fetchAttendance()
    }

    private fun checkPermissions() {
        val ctx = context ?: return
        if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION), 101)
        }
    }

    private fun getCurrentLocation(): Pair<Double, Double>? {
        val ctx = context ?: return null
        val lm = ctx.getSystemService(Context.LOCATION_SERVICE) as? LocationManager ?: return null
        try {
            if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
                ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
                val gpsLoc = lm.getLastKnownLocation(LocationManager.GPS_PROVIDER)
                val netLoc = lm.getLastKnownLocation(LocationManager.NETWORK_PROVIDER)
                val best = gpsLoc ?: netLoc
                if (best != null) {
                    return Pair(best.latitude, best.longitude)
                }
            }
        } catch (_: Exception) {}
        return null
    }

    private fun addGeotagWatermark(
        original: Bitmap,
        company: String,
        roleTitle: String,
        employeeName: String,
        lat: String,
        lng: String
    ): Bitmap {
        return try {
            val mutableBitmap = original.copy(Bitmap.Config.ARGB_8888, true)
            val canvas = Canvas(mutableBitmap)
            val width = mutableBitmap.width
            val height = mutableBitmap.height

            val sdf = SimpleDateFormat("dd/MM/yyyy HH:mm:ss", Locale("id", "ID"))
            val timestamp = sdf.format(Date())

            val lines = listOf(
                "$company • $employeeName",
                "Waktu: $timestamp",
                "GPS: $lat, $lng"
            )

            val fontSize = (width * 0.030f).coerceIn(13f, 22f)
            val padding = fontSize * 0.6f
            val lineGap = fontSize * 0.22f
            val overlayHeight = (fontSize + lineGap) * lines.size + padding * 1.5f

            val paintOverlay = Paint().apply {
                color = Color.parseColor("#99000000")
                style = Paint.Style.FILL
            }
            canvas.drawRect(0f, height - overlayHeight, width.toFloat(), height.toFloat(), paintOverlay)

            val paintText = Paint().apply {
                isAntiAlias = true
                typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            }

            var textY = height - overlayHeight + padding + fontSize
            for (i in lines.indices) {
                when (i) {
                    0 -> {
                        paintText.textSize = fontSize * 1.05f
                        paintText.color = Color.parseColor("#38BDF8")
                    }
                    1 -> {
                        paintText.textSize = fontSize * 0.92f
                        paintText.color = Color.WHITE
                    }
                    else -> {
                        paintText.textSize = fontSize * 0.92f
                        paintText.color = Color.parseColor("#4ADE80")
                    }
                }
                canvas.drawText(lines[i], padding, textY, paintText)
                textY += fontSize + lineGap
            }

            mutableBitmap
        } catch (_: Exception) {
            original
        }
    }

    private fun fetchAttendance() {
        swipeRefresh.isRefreshing = true
        lifecycleScope.launch {
            val json = withContext(Dispatchers.IO) {
                try {
                    val req = Request.Builder().url("${getBaseUrl()}/api/customer/app/collector/attendance/today")
                        .addHeader("Authorization", "Bearer ${getToken()}").build()
                    val resp = httpClient().newCall(req).execute()
                    if (resp.isSuccessful) resp.body?.string()?.let { JSONObject(it) } else null
                } catch (_: Exception) { null }
            }
            swipeRefresh.isRefreshing = false
            contentContainer.removeAllViews()
            val ctx = context ?: return@launch
            val data = json?.optJSONObject("data")
            val today = data?.optJSONObject("today")
            val history = data?.optJSONArray("history")

            contentContainer.addView(TextView(ctx).apply {
                text = "📍 Absensi Kolektor Lapangan"
                setTextColor(Color.WHITE); textSize = 18f; typeface = Typeface.DEFAULT_BOLD; setPadding(0, 0, 0, 4)
            })
            contentContainer.addView(TextView(ctx).apply {
                text = "Pencatatan kehadiran harian kolektor dengan foto selfie & Geo-Tagging posisi."
                setTextColor(Color.parseColor("#94A3B8")); textSize = 12f; setPadding(0, 0, 0, 16)
            })

            val card = CardView(ctx).apply {
                radius = 24f; setCardBackgroundColor(Color.parseColor("#1E293B")); cardElevation = 4f
                layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { setMargins(0, 0, 0, 16) }
            }
            val inner = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL; setPadding(28, 24, 28, 24) }

            val status = today?.optString("status", "none") ?: "none"
            val checkInTime = today?.optString("check_in_time", "-") ?: "-"
            val checkOutTime = today?.optString("check_out_time", "-") ?: "-"
            dynamicCompanyName = data?.optString("companyName", dynamicCompanyName) ?: dynamicCompanyName

            // Status Badge
            val badgeText = when (status) {
                "checked_in" -> "🟢 SEDANG PENAGIHAN (CHECK-IN)"
                "checked_out" -> "🏁 TUGAS SELESAI (CHECK-OUT)"
                else -> "⚪ BELUM CHECK-IN HARI INI"
            }
            val badgeColor = when (status) {
                "checked_in" -> Color.parseColor("#16A34A")
                "checked_out" -> Color.parseColor("#2563EB")
                else -> Color.parseColor("#475569")
            }
            inner.addView(TextView(ctx).apply {
                text = badgeText; setTextColor(Color.WHITE); textSize = 12f; typeface = Typeface.DEFAULT_BOLD
                setBackgroundColor(badgeColor); setPadding(20, 10, 20, 10); gravity = Gravity.CENTER
            })

            // Timestamps
            inner.addView(TextView(ctx).apply {
                text = "\n⏰ Jam Masuk: $checkInTime\n🏁 Jam Pulang: $checkOutTime"
                setTextColor(Color.WHITE); textSize = 13.5f; setPadding(0, 4, 0, 8)
            })

            // GPS indicator
            val curLoc = getCurrentLocation()
            inner.addView(TextView(ctx).apply {
                text = if (curLoc != null) "📡 GPS: Terkunci (${String.format(Locale.US, "%.5f, %.5f", curLoc.first, curLoc.second)})" else "📡 GPS: Menggunakan titik koordinat kantor"
                setTextColor(if (curLoc != null) Color.parseColor("#4ADE80") else Color.parseColor("#94A3B8"))
                textSize = 11.5f; setPadding(0, 0, 0, 12)
            })

            if (status == "none" || status == "checked_in") {
                inner.addView(TextView(ctx).apply {
                    text = "📸 Foto Selfie + Geo-Tagging (Kamera)"
                    setTextColor(Color.WHITE); textSize = 13f; typeface = Typeface.DEFAULT_BOLD; setPadding(0, 4, 0, 6)
                })

                // Preview Card with FrameLayout Container
                val dpHeight = (220 * ctx.resources.displayMetrics.density).toInt()
                cardSelfiePreview = CardView(ctx).apply {
                    radius = 20f
                    setCardBackgroundColor(Color.parseColor("#0F172A"))
                    cardElevation = 3f
                    layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dpHeight).apply {
                        setMargins(0, 8, 0, 14)
                    }
                }

                val previewBox = FrameLayout(ctx).apply {
                    layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                }

                tvPlaceholder = TextView(ctx).apply {
                    text = "📷 Belum ada foto selfie\nTekan tombol di bawah untuk membuka kamera"
                    setTextColor(Color.parseColor("#64748B"))
                    textSize = 12.5f
                    gravity = Gravity.CENTER
                    layoutParams = FrameLayout.LayoutParams(
                        FrameLayout.LayoutParams.MATCH_PARENT,
                        FrameLayout.LayoutParams.MATCH_PARENT
                    )
                    visibility = if (capturedSelfieBitmap != null) View.GONE else View.VISIBLE
                }

                ivSelfiePreview = ImageView(ctx).apply {
                    layoutParams = FrameLayout.LayoutParams(
                        FrameLayout.LayoutParams.MATCH_PARENT,
                        FrameLayout.LayoutParams.MATCH_PARENT
                    )
                    scaleType = ImageView.ScaleType.FIT_CENTER
                    adjustViewBounds = true
                    if (capturedSelfieBitmap != null) {
                        setImageBitmap(capturedSelfieBitmap)
                        visibility = View.VISIBLE
                    } else {
                        visibility = View.GONE
                    }
                }

                previewBox.addView(tvPlaceholder)
                previewBox.addView(ivSelfiePreview)
                cardSelfiePreview?.addView(previewBox)
                inner.addView(cardSelfiePreview)

                // Capture Button
                btnCapturePhoto = Button(ctx).apply {
                    layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 100).apply {
                        setMargins(0, 0, 0, 12)
                    }
                    text = if (capturedSelfieBitmap != null) "🔄 Ganti Foto Selfie (Geo-Tagged)" else "📸 Buka Kamera & Ambil Foto Selfie (Geo-Tag)"
                    setTextColor(Color.WHITE); textSize = 12.5f; typeface = Typeface.DEFAULT_BOLD
                    backgroundTintList = android.content.res.ColorStateList.valueOf(Color.parseColor("#0284C7"))
                    setOnClickListener {
                        if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                            takePictureLauncher.launch(null)
                        } else {
                            cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
                        }
                    }
                }
                inner.addView(btnCapturePhoto)

                val etNote = EditText(ctx).apply {
                    hint = "Catatan wilayah penagihan (opsional)..."
                    setHintTextColor(Color.parseColor("#64748B"))
                    setTextColor(Color.WHITE); textSize = 12.5f
                    setBackgroundColor(Color.parseColor("#0F172A"))
                    setPadding(20, 18, 20, 18)
                    layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { setMargins(0, 0, 0, 14) }
                }
                inner.addView(etNote)

                if (status == "none") {
                    val btnCheckin = Button(ctx).apply {
                        text = "📍 Check-In Sekarang"
                        setTextColor(Color.WHITE); textSize = 13f; typeface = Typeface.DEFAULT_BOLD
                        backgroundTintList = android.content.res.ColorStateList.valueOf(Color.parseColor("#16A34A"))
                        setOnClickListener { submitAttendance("checkin", etNote.text.toString()) }
                    }
                    inner.addView(btnCheckin)
                } else {
                    val btnCheckout = Button(ctx).apply {
                        text = "🏁 Selesai Tugas & Check-Out"
                        setTextColor(Color.WHITE); textSize = 13f; typeface = Typeface.DEFAULT_BOLD
                        backgroundTintList = android.content.res.ColorStateList.valueOf(Color.parseColor("#2563EB"))
                        setOnClickListener { submitAttendance("checkout", etNote.text.toString()) }
                    }
                    inner.addView(btnCheckout)
                }
            } else {
                inner.addView(TextView(ctx).apply {
                    text = "✅ Anda telah menyelesaikan absensi hari ini. Terima kasih!"
                    setTextColor(Color.parseColor("#4ADE80")); textSize = 12.5f; typeface = Typeface.DEFAULT_BOLD
                    setPadding(0, 4, 0, 0)
                })
            }

            card.addView(inner)
            contentContainer.addView(card)

            // History Section
            contentContainer.addView(TextView(ctx).apply {
                text = "📋 Riwayat Absensi Terakhir"
                setTextColor(Color.WHITE); textSize = 15f; typeface = Typeface.DEFAULT_BOLD; setPadding(4, 16, 0, 8)
            })

            if (history != null && history.length() > 0) {
                for (i in 0 until history.length()) {
                    val h = history.optJSONObject(i) ?: continue
                    val date = h.optString("date", "-")
                    val inTime = h.optString("check_in_time", "-")
                    val outTime = h.optString("check_out_time", "-")
                    val hStatus = h.optString("status", "-")

                    val hCard = CardView(ctx).apply {
                        radius = 16f; setCardBackgroundColor(Color.parseColor("#1E293B")); cardElevation = 2f
                        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { setMargins(0, 0, 0, 10) }
                    }
                    val hLayout = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL; setPadding(20, 14, 20, 14) }
                    hLayout.addView(TextView(ctx).apply {
                        text = "📅 $date  ($hStatus)"
                        setTextColor(Color.WHITE); textSize = 13f; typeface = Typeface.DEFAULT_BOLD
                    })
                    hLayout.addView(TextView(ctx).apply {
                        text = "Masuk: $inTime  |  Pulang: $outTime"
                        setTextColor(Color.parseColor("#94A3B8")); textSize = 11.5f; setPadding(0, 4, 0, 0)
                    })
                    hCard.addView(hLayout)
                    contentContainer.addView(hCard)
                }
            } else {
                contentContainer.addView(TextView(ctx).apply {
                    text = "Belum ada riwayat absensi sebelumnya."
                    setTextColor(Color.parseColor("#64748B")); textSize = 12f; setPadding(4, 4, 0, 0)
                })
            }
        }
    }

    private fun submitAttendance(action: String, note: String) {
        val ctx = context ?: return
        val loc = getCurrentLocation()

        var base64Photo = ""
        capturedSelfieBitmap?.let { bmp ->
            try {
                val stream = ByteArrayOutputStream()
                bmp.compress(Bitmap.CompressFormat.JPEG, 75, stream)
                val byteArray = stream.toByteArray()
                base64Photo = "data:image/jpeg;base64," + Base64.encodeToString(byteArray, Base64.NO_WRAP)
            } catch (_: Exception) {}
        }

        swipeRefresh.isRefreshing = true
        lifecycleScope.launch {
            val url = "${getBaseUrl()}/api/customer/app/collector/attendance/$action"
            val result = withContext(Dispatchers.IO) {
                try {
                    val payload = JSONObject().apply {
                        put("note", note)
                        if (base64Photo.isNotEmpty()) {
                            put("photo", base64Photo)
                        }
                        if (loc != null) {
                            put("lat", loc.first.toString())
                            put("lng", loc.second.toString())
                        }
                    }
                    val body = payload.toString().toRequestBody("application/json".toMediaType())
                    val req = Request.Builder().url(url).addHeader("Authorization", "Bearer ${getToken()}").post(body).build()
                    val resp = httpClient().newCall(req).execute()
                    resp.body?.string()?.let { JSONObject(it) }
                } catch (_: Exception) { null }
            }
            swipeRefresh.isRefreshing = false
            val msg = result?.optString("message") ?: "Gagal memproses absensi"
            Toast.makeText(ctx, msg, Toast.LENGTH_SHORT).show()
            if (result?.optBoolean("success") == true) {
                capturedSelfieBitmap = null
            }
            fetchAttendance()
        }
    }
}
