package com.alijaya.customer.ui.admin

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.speech.RecognizerIntent
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.*
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.widget.SwitchCompat
import androidx.cardview.widget.CardView
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.alijaya.customer.CustomerApplication
import com.alijaya.customer.service.SoundboxSpeakerHelper
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.TimeUnit

class AdminVoiceAssistantFragment : Fragment() {

    private fun httpClient() = OkHttpClient.Builder()
        .connectTimeout(25, TimeUnit.SECONDS)
        .readTimeout(25, TimeUnit.SECONDS)
        .build()

    private fun getBaseUrl(): String {
        val b = CustomerApplication.sessionManager.getServerBaseUrl()
        return if (b.endsWith("/")) b.dropLast(1) else b
    }

    private fun getToken(): String = CustomerApplication.sessionManager.getAuthToken()

    private lateinit var contentContainer: LinearLayout
    private lateinit var transcriptContainer: LinearLayout
    private lateinit var transcriptScroll: ScrollView
    private lateinit var tvOrbStatus: TextView
    private lateinit var orbButton: FrameLayout
    private lateinit var progressBar: ProgressBar

    // Speech-to-Text via RecognizerIntent (Zero RECORD_AUDIO permissions required!)
    private val speechRecognizerLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK && result.data != null) {
            val matches = result.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)
            val spokenText = matches?.firstOrNull()?.trim()
            if (!spokenText.isNullOrEmpty()) {
                sendQuestionToAi(spokenText)
            }
        }
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        val mainLayout = LinearLayout(requireContext()).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#0F172A"))
            layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        }

        val scroll = ScrollView(requireContext()).apply {
            isFillViewport = true
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f)
        }
        contentContainer = LinearLayout(requireContext()).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(28, 28, 28, 24)
        }
        scroll.addView(contentContainer)
        mainLayout.addView(scroll)

        // Bottom Input Bar
        mainLayout.addView(createBottomInputBar())

        return mainLayout
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        SoundboxSpeakerHelper.init(requireContext())
        renderUI()
    }

    private fun renderUI() {
        val ctx = context ?: return
        val session = CustomerApplication.sessionManager
        contentContainer.removeAllViews()

        // 1. Header Title & Subtitle
        contentContainer.addView(TextView(ctx).apply {
            text = "🎙️ Asisten AI Alijaya"
            setTextColor(Color.WHITE); textSize = 22f; typeface = Typeface.DEFAULT_BOLD
            setPadding(0, 0, 0, 4)
        })
        contentContainer.addView(TextView(ctx).apply {
            text = "Asisten cerdas berbasis AI untuk mengecek billing, tagihan, router, pelanggan, & status server secara instan."
            setTextColor(Color.parseColor("#94A3B8")); textSize = 12f
            setPadding(0, 0, 0, 16)
        })

        // 2. THE VOICE ORB CALL STAGE CARD
        val orbCard = CardView(ctx).apply {
            radius = 24f
            setCardBackgroundColor(Color.parseColor("#1E293B"))
            cardElevation = 6f
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                setMargins(0, 0, 0, 18)
            }
        }
        val orbInner = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(24, 28, 24, 28)
        }

        // Status Badge Pill
        val badge = TextView(ctx).apply {
            text = "🌸 Suara AI Bahasa Indonesia Siap"
            setTextColor(Color.parseColor("#A7F3D0"))
            textSize = 11f
            typeface = Typeface.DEFAULT_BOLD
            setPadding(24, 8, 24, 8)
            val bg = GradientDrawable().apply {
                setColor(Color.parseColor("#064E3B"))
                cornerRadius = 999f
                setStroke(2, Color.parseColor("#10B981"))
            }
            background = bg
        }
        orbInner.addView(badge)

        // Central Orb Button
        orbButton = FrameLayout(ctx).apply {
            val size = (110 * resources.displayMetrics.density).toInt()
            layoutParams = LinearLayout.LayoutParams(size, size).apply {
                setMargins(0, 24, 0, 16)
            }
            val orbBg = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                colors = intArrayOf(Color.parseColor("#8B5CF6"), Color.parseColor("#3B82F6"), Color.parseColor("#1E1B4B"))
                gradientType = GradientDrawable.RADIAL_GRADIENT
                gradientRadius = size.toFloat()
            }
            background = orbBg
            elevation = 12f
            isClickable = true
            isFocusable = true
            setOnClickListener {
                SoundboxSpeakerHelper.stopCurrentPlayback()
                launchSpeechInput()
            }
        }

        val micIcon = ImageView(ctx).apply {
            setImageResource(com.alijaya.customer.R.drawable.ic_voice_ai)
            setColorFilter(Color.WHITE)
            val iconSize = (48 * resources.displayMetrics.density).toInt()
            layoutParams = FrameLayout.LayoutParams(iconSize, iconSize, Gravity.CENTER)
        }
        orbButton.addView(micIcon)
        orbInner.addView(orbButton)

        tvOrbStatus = TextView(ctx).apply {
            text = "Ketuk bola untuk berbicara langsung"
            setTextColor(Color.parseColor("#CBD5E1"))
            textSize = 13f
            typeface = Typeface.DEFAULT_BOLD
        }
        orbInner.addView(tvOrbStatus)

        progressBar = ProgressBar(ctx).apply {
            visibility = View.GONE
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                setMargins(0, 8, 0, 0)
            }
        }
        orbInner.addView(progressBar)

        orbCard.addView(orbInner)
        contentContainer.addView(orbCard)

        // 3. SOUNDBOX KASIR SPEAKER CARD
        val isSoundboxOn = session.isSoundboxSpeakerEnabled()
        val soundboxCard = CardView(ctx).apply {
            radius = 20f
            setCardBackgroundColor(Color.parseColor("#1E293B"))
            cardElevation = 4f
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                setMargins(0, 0, 0, 18)
            }
        }
        val sbInner = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(20, 16, 20, 16)
        }
        val sbHeaderRow = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        val sbTitle = TextView(ctx).apply {
            text = "🔊 Speaker Kasir Soundbox di HP"
            setTextColor(Color.WHITE); textSize = 13f; typeface = Typeface.DEFAULT_BOLD
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        val sbSwitch = SwitchCompat(ctx).apply {
            isChecked = isSoundboxOn
            thumbTintList = ColorStateList.valueOf(if (isSoundboxOn) Color.parseColor("#10B981") else Color.parseColor("#94A3B8"))
            trackTintList = ColorStateList.valueOf(if (isSoundboxOn) Color.parseColor("#065F46") else Color.parseColor("#475569"))
            setOnCheckedChangeListener { _, isChecked ->
                session.setSoundboxSpeakerEnabled(isChecked)
                thumbTintList = ColorStateList.valueOf(if (isChecked) Color.parseColor("#10B981") else Color.parseColor("#94A3B8"))
                trackTintList = ColorStateList.valueOf(if (isChecked) Color.parseColor("#065F46") else Color.parseColor("#475569"))
                if (isChecked) {
                    SoundboxSpeakerHelper.speak(ctx, "Speaker kasir soundbox aktif.")
                }
            }
        }
        sbHeaderRow.addView(sbTitle)
        sbHeaderRow.addView(sbSwitch)
        sbInner.addView(sbHeaderRow)

        sbInner.addView(TextView(ctx).apply {
            text = "Saat ada pembayaran QRIS, Bank, atau E-Wallet masuk, HP ini otomatis membunyikan bel kasir dan mengumumkan nominalnya."
            setTextColor(Color.parseColor("#94A3B8")); textSize = 11f
            setPadding(0, 4, 0, 12)
        })

        val btnTestSoundbox = Button(ctx).apply {
            text = "🔔 Uji Suara Kasir"
            setTextColor(Color.WHITE); textSize = 11f; typeface = Typeface.DEFAULT_BOLD
            backgroundTintList = ColorStateList.valueOf(Color.parseColor("#0D9488"))
            setOnClickListener {
                SoundboxSpeakerHelper.speak(ctx, "Uji coba speaker kasir berhasil. Pembayaran sebesar lima puluh ribu rupiah diterima.")
            }
        }
        sbInner.addView(btnTestSoundbox)
        soundboxCard.addView(sbInner)
        contentContainer.addView(soundboxCard)

        // 4. QUICK SUGGESTION CHIPS (Horizontal Scroll)
        contentContainer.addView(TextView(ctx).apply {
            text = "💡 Contoh Pertanyaan Cepat (Ketuk untuk coba)"
            setTextColor(Color.parseColor("#E2E8F0")); textSize = 12f; typeface = Typeface.DEFAULT_BOLD
            setPadding(0, 0, 0, 8)
        })

        val chipsScroll = HorizontalScrollView(ctx).apply {
            isHorizontalScrollBarEnabled = false
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                setMargins(0, 0, 0, 18)
            }
        }
        val chipsContainer = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, 0, 0, 4)
        }

        val chips = listOf(
            "📡 Cek Kondisi Modem" to "Cek kondisi modem pelanggan saat ini",
            "💰 Cek Tagihan Belum Lunas" to "Berapa pelanggan yang belum bayar bulan ini?",
            "🔒 Pelanggan Terisolir" to "Siapa saja pelanggan yang sedang terisolir?",
            "📊 Ringkasan Pelanggan" to "Bagaimana ringkasan total pelanggan aktif?",
            "⚡ Status Jaringan" to "Cek status router dan jaringan saat ini",
            "💡 Tips WiFi Kuat" to "Ceritakan tips agar sinyal wifi di rumah pelanggan kuat"
        )
        for ((label, query) in chips) {
            val chipBtn = TextView(ctx).apply {
                text = label
                setTextColor(Color.WHITE); textSize = 11f; typeface = Typeface.DEFAULT_BOLD
                setPadding(24, 12, 24, 12)
                val chipBg = GradientDrawable().apply {
                    setColor(Color.parseColor("#334155"))
                    cornerRadius = 999f
                }
                background = chipBg
                isClickable = true
                isFocusable = true
                layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                    setMargins(0, 0, 16, 0)
                }
                setOnClickListener {
                    sendQuestionToAi(query)
                }
            }
            chipsContainer.addView(chipBtn)
        }
        chipsScroll.addView(chipsContainer)
        contentContainer.addView(chipsScroll)

        // 5. CONVERSATION TRANSCRIPT
        contentContainer.addView(TextView(ctx).apply {
            text = "💬 Riwayat Percakapan"
            setTextColor(Color.parseColor("#E2E8F0")); textSize = 12f; typeface = Typeface.DEFAULT_BOLD
            setPadding(0, 0, 0, 8)
        })

        transcriptContainer = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, 0, 0, 16)
        }
        contentContainer.addView(transcriptContainer)

        // Initial greeting bubble
        addMessageBubble(
            isUser = false,
            message = "Halo Administrator! Saya Asisten AI Alijaya. Silakan ketuk tombol mic di atas atau ketik pertanyaan seputar tagihan, pelanggan isolir, router, atau panduan teknis lainnya.",
            speechText = "Halo Administrator, saya Asisten AI Alijaya. Silakan bicara langsung atau ketik pertanyaan Anda."
        )
    }

    private fun createBottomInputBar(): View {
        val ctx = requireContext()
        val bar = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(Color.parseColor("#1E293B"))
            setPadding(16, 12, 16, 16)
            elevation = 16f
        }

        val btnMic = ImageButton(ctx).apply {
            setImageResource(com.alijaya.customer.R.drawable.ic_voice_ai)
            setColorFilter(Color.WHITE)
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(Color.parseColor("#8B5CF6"))
            }
            val size = (44 * resources.displayMetrics.density).toInt()
            layoutParams = LinearLayout.LayoutParams(size, size).apply {
                setMargins(0, 0, 10, 0)
            }
            setOnClickListener {
                SoundboxSpeakerHelper.stopCurrentPlayback()
                launchSpeechInput()
            }
        }
        bar.addView(btnMic)

        val etInput = EditText(ctx).apply {
            hint = "Ketik pertanyaan atau tekan mic..."
            setHintTextColor(Color.parseColor("#64748B"))
            setTextColor(Color.WHITE)
            textSize = 13f
            val bg = GradientDrawable().apply {
                setColor(Color.parseColor("#0F172A"))
                cornerRadius = 24f
                setStroke(1, Color.parseColor("#334155"))
            }
            background = bg
            setPadding(28, 16, 28, 16)
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply {
                setMargins(0, 0, 10, 0)
            }
        }
        bar.addView(etInput)

        val btnSend = Button(ctx).apply {
            text = "Kirim"
            setTextColor(Color.WHITE)
            textSize = 12f
            typeface = Typeface.DEFAULT_BOLD
            backgroundTintList = ColorStateList.valueOf(Color.parseColor("#3B82F6"))
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            setOnClickListener {
                val q = etInput.text.toString().trim()
                if (q.isNotEmpty()) {
                    etInput.setText("")
                    sendQuestionToAi(q)
                }
            }
        }
        bar.addView(btnSend)

        return bar
    }

    private fun launchSpeechInput() {
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, "id-ID")
            putExtra(RecognizerIntent.EXTRA_PROMPT, "Silakan bicara sekarang...")
        }
        try {
            speechRecognizerLauncher.launch(intent)
        } catch (e: Exception) {
            Toast.makeText(requireContext(), "Google Voice Search tidak tersedia. Silakan ketik pertanyaan Anda.", Toast.LENGTH_SHORT).show()
        }
    }

    private fun sendQuestionToAi(question: String) {
        val ctx = context ?: return
        addMessageBubble(isUser = true, message = question)

        tvOrbStatus.text = "AI sedang berpikir..."
        progressBar.visibility = View.VISIBLE

        lifecycleScope.launch {
            val response = withContext(Dispatchers.IO) {
                try {
                    val candidateUrls = listOf(
                        "${getBaseUrl()}/api/voice-assistant/ask",
                        "${getBaseUrl()}/admin/api/voice-assistant/ask"
                    )
                    var lastCode = 0
                    var resultJson: JSONObject? = null

                    for (url in candidateUrls) {
                        try {
                            val payload = JSONObject().apply {
                                put("message", question)
                                put("isAdmin", true)
                            }
                            val body = payload.toString().toRequestBody("application/json; charset=utf-8".toMediaType())
                            val request = Request.Builder()
                                .url(url)
                                .addHeader("Content-Type", "application/json")
                                .addHeader("Authorization", "Bearer ${getToken()}")
                                .addHeader("x-api-token", "alijaya-voice-ai-2026")
                                .post(body)
                                .build()

                            val resp = httpClient().newCall(request).execute()
                            lastCode = resp.code
                            val str = resp.body?.string() ?: ""
                            if (resp.isSuccessful) {
                                resultJson = JSONObject(str)
                                break
                            } else if (resp.code != 404) {
                                resultJson = JSONObject().apply {
                                    put("ok", false)
                                    put("error", "Gagal menghubungi server (HTTP ${resp.code})")
                                }
                                break
                            }
                        } catch (e: Exception) {
                            // try next endpoint if any
                        }
                    }

                    resultJson ?: JSONObject().apply {
                        put("ok", false)
                        put("error", if (lastCode > 0) "Gagal menghubungi server (HTTP $lastCode)" else "Koneksi terputus")
                    }
                } catch (e: Exception) {
                    JSONObject().apply {
                        put("ok", false)
                        put("error", e.message ?: "Koneksi terputus")
                    }
                }
            }

            progressBar.visibility = View.GONE

            val isOk = response.optBoolean("ok", false)
            if (isOk) {
                val answer = response.optString("text", "Jawaban kosong.")
                val speech = response.optString("speechText", answer)
                addMessageBubble(isUser = false, message = answer, speechText = speech)
                tvOrbStatus.text = "AI sedang berbicara..."
                SoundboxSpeakerHelper.speak(ctx, speech, withChime = false) {
                    tvOrbStatus.text = "Ketuk bola untuk berbicara langsung"
                }
            } else {
                tvOrbStatus.text = "Ketuk bola untuk berbicara langsung"
                val err = response.optString("error", "Terjadi kesalahan saat memproses pertanyaan.")
                addMessageBubble(isUser = false, message = "⚠️ $err")
            }
        }
    }

    private fun addMessageBubble(isUser: Boolean, message: String, speechText: String = "") {
        val ctx = context ?: return
        val bubble = CardView(ctx).apply {
            radius = 18f
            setCardBackgroundColor(if (isUser) Color.parseColor("#1D4ED8") else Color.parseColor("#1E293B"))
            cardElevation = 2f
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                gravity = if (isUser) Gravity.END else Gravity.START
                setMargins(if (isUser) 48 else 0, 0, if (isUser) 0 else 48, 12)
            }
        }

        val inner = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(20, 14, 20, 14)
        }

        val senderText = TextView(ctx).apply {
            text = if (isUser) "Anda" else "🤖 Asisten AI"
            setTextColor(if (isUser) Color.parseColor("#93C5FD") else Color.parseColor("#10B981"))
            textSize = 10f
            typeface = Typeface.DEFAULT_BOLD
            setPadding(0, 0, 0, 4)
        }
        inner.addView(senderText)

        val msgText = TextView(ctx).apply {
            text = message
            setTextColor(Color.WHITE)
            textSize = 13f
            setLineSpacing(4f, 1.15f)
        }
        inner.addView(msgText)

        // Button to re-play voice if it's an AI message
        if (!isUser && speechText.isNotEmpty()) {
            val btnReplay = TextView(ctx).apply {
                text = "🔊 Putar Suara"
                setTextColor(Color.parseColor("#38BDF8"))
                textSize = 11f
                typeface = Typeface.DEFAULT_BOLD
                setPadding(0, 10, 0, 0)
                isClickable = true
                setOnClickListener {
                    tvOrbStatus.text = "AI sedang berbicara..."
                    SoundboxSpeakerHelper.speak(ctx, speechText, withChime = false) {
                        tvOrbStatus.text = "Ketuk bola untuk berbicara langsung"
                    }
                }
            }
            inner.addView(btnReplay)
        }

        val timeStr = SimpleDateFormat("HH:mm", Locale("id", "ID")).format(Date())
        val timeText = TextView(ctx).apply {
            text = timeStr
            setTextColor(Color.parseColor("#64748B"))
            textSize = 9f
            gravity = Gravity.END
            setPadding(0, 4, 0, 0)
        }
        inner.addView(timeText)

        bubble.addView(inner)
        transcriptContainer.addView(bubble)
    }

    override fun onDestroyView() {
        SoundboxSpeakerHelper.shutdown()
        super.onDestroyView()
    }
}
