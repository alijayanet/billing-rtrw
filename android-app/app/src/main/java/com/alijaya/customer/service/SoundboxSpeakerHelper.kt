package com.alijaya.customer.service

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.media.MediaPlayer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import android.util.Log
import com.alijaya.customer.CustomerApplication
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.net.URLEncoder
import java.util.Locale

object SoundboxSpeakerHelper {
    private const val TAG = "SoundboxSpeaker"
    private var tts: TextToSpeech? = null
    private var isTtsReady = false
    private var currentMediaPlayer: MediaPlayer? = null
    private val scope = CoroutineScope(Dispatchers.Main)

    fun init(context: Context) {
        if (tts != null) return
        try {
            tts = TextToSpeech(context.applicationContext) { status ->
                if (status == TextToSpeech.SUCCESS) {
                    val localeId = Locale.forLanguageTag("id-ID")
                    val result = tts?.setLanguage(localeId)
                    if (result == TextToSpeech.LANG_MISSING_DATA || result == TextToSpeech.LANG_NOT_SUPPORTED) {
                        tts?.setLanguage(Locale.getDefault())
                    } else {
                        // Coba aktifkan suara Neural / High-Quality Indonesian jika tersedia di ponsel
                        try {
                            val voices = tts?.voices
                            val neural = voices?.firstOrNull {
                                it.locale.language == "id" && (it.quality >= Voice.QUALITY_VERY_HIGH || it.name.contains("network", ignoreCase = true))
                            } ?: voices?.firstOrNull { it.locale.language == "id" && !it.name.contains("local", ignoreCase = true) }

                            if (neural != null) {
                                tts?.voice = neural
                                Log.i(TAG, "Selected Neural/Network voice: ${neural.name}")
                            }
                        } catch (_: Exception) {}
                    }
                    tts?.setSpeechRate(1.0f)
                    tts?.setPitch(1.0f)
                    isTtsReady = true
                    Log.i(TAG, "Soundbox TTS Initialized successfully")
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "TTS init error: ${e.message}")
        }
    }

    /**
     * Memainkan bel kasir 2 nada (880Hz -> 1320Hz) sintetis berkualitas tinggi
     */
    fun playChime() {
        try {
            val sampleRate = 44100
            val dur1 = 0.10 // 880Hz
            val dur2 = 0.40 // 1318.5Hz
            val n1 = (dur1 * sampleRate).toInt()
            val n2 = (dur2 * sampleRate).toInt()
            val total = n1 + n2
            val buffer = ShortArray(total)

            for (i in 0 until n1) {
                val t = i.toDouble() / sampleRate
                val decay = 1.0 - (i.toDouble() / n1) * 0.15
                buffer[i] = (Math.sin(2.0 * Math.PI * 880.0 * t) * Short.MAX_VALUE * 0.4 * decay).toInt().toShort()
            }
            for (i in 0 until n2) {
                val t = i.toDouble() / sampleRate
                val decay = Math.exp(-3.5 * (i.toDouble() / n2))
                buffer[n1 + i] = (Math.sin(2.0 * Math.PI * 1318.5 * t) * Short.MAX_VALUE * 0.45 * decay).toInt().toShort()
            }

            val audioTrack = AudioTrack.Builder()
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION_EVENT)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build()
                )
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(sampleRate)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .build()
                )
                .setBufferSizeInBytes(total * 2)
                .setTransferMode(AudioTrack.MODE_STATIC)
                .build()

            audioTrack.write(buffer, 0, total)
            audioTrack.play()
        } catch (e: Exception) {
            Log.w(TAG, "Chime error: ${e.message}")
        }
    }

    fun stopCurrentPlayback() {
        try {
            currentMediaPlayer?.stop()
            currentMediaPlayer?.release()
        } catch (_: Exception) {}
        currentMediaPlayer = null

        try {
            tts?.stop()
        } catch (_: Exception) {}
    }

    /**
     * Memainkan suara AI Neural Indonesia persis seperti yang digunakan di Web Admin.
     * Mengalirkan audio langsung dari server Google ID TTS (/api/voice-assistant/tts).
     * Jika koneksi offline/gagal, otomatis fallback ke TTS lokal dengan suara terbaik.
     */
    fun speak(
        context: Context,
        text: String,
        withChime: Boolean = true,
        onComplete: (() -> Unit)? = null
    ) {
        init(context)
        stopCurrentPlayback()

        scope.launch {
            if (withChime) {
                playChime()
                delay(380)
            }

            val clean = cleanForSpeech(text)
            if (clean.isBlank()) {
                onComplete?.invoke()
                return@launch
            }

            // Ambil Base URL server dari SessionManager
            var baseUrl = ""
            try {
                baseUrl = CustomerApplication.sessionManager.getServerBaseUrl().trimEnd('/')
            } catch (_: Exception) {}

            if (baseUrl.isNotBlank()) {
                playFromServerTts(context, clean, baseUrl, onComplete)
            } else {
                speakWithLocalTts(context, clean, onComplete)
            }
        }
    }

    private fun playFromServerTts(
        context: Context,
        cleanText: String,
        baseUrl: String,
        onComplete: (() -> Unit)?
    ) {
        try {
            val encoded = URLEncoder.encode(cleanText, "UTF-8")
            val ttsUrl = "$baseUrl/api/voice-assistant/tts?token=alijaya-voice-ai-2026&text=$encoded"

            val player = MediaPlayer().apply {
                setAudioAttributes(
                    AudioAttributes.Builder()
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
                        .build()
                )
                setDataSource(ttsUrl)
                setOnPreparedListener { mp ->
                    mp.start()
                }
                setOnCompletionListener { mp ->
                    mp.release()
                    if (currentMediaPlayer == mp) currentMediaPlayer = null
                    onComplete?.invoke()
                }
                setOnErrorListener { mp, what, extra ->
                    Log.w(TAG, "Server TTS error (what=$what, extra=$extra). Falling back to local TTS.")
                    mp.release()
                    if (currentMediaPlayer == mp) currentMediaPlayer = null
                    speakWithLocalTts(context, cleanText, onComplete)
                    true
                }
                prepareAsync()
            }
            currentMediaPlayer = player
        } catch (e: Exception) {
            Log.w(TAG, "Stream server TTS failed: ${e.message}. Using local TTS.")
            speakWithLocalTts(context, cleanText, onComplete)
        }
    }

    private fun speakWithLocalTts(context: Context, text: String, onComplete: (() -> Unit)?) {
        if (!isTtsReady || tts == null) {
            onComplete?.invoke()
            return
        }

        try {
            val utteranceId = "soundbox_" + System.currentTimeMillis()
            tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String?) {}
                override fun onDone(utteranceId: String?) {
                    scope.launch { onComplete?.invoke() }
                }
                override fun onError(utteranceId: String?) {
                    scope.launch { onComplete?.invoke() }
                }
            })
            tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, utteranceId)
        } catch (e: Exception) {
            Log.w(TAG, "Local TTS speak error: ${e.message}")
            onComplete?.invoke()
        }
    }

    private fun cleanForSpeech(raw: String): String {
        return raw
            .replace(Regex("```[\\s\\S]*?```"), " ")
            .replace(Regex("`([^`]+)`"), "$1")
            .replace(Regex("\\[([^\\]]+)\\]\\([^)]+\\)"), "$1")
            .replace(Regex("<[^>]+>"), " ")
            .replace(Regex("(?i)\\bRp\\.?\\s*([0-9.,]+)"), "$1 rupiah")
            .replace(Regex("(?i)-(\\d+(?:\\.\\d+)?)\\s*(?:dBm)\\b"), "minus $1 desibel")
            .replace(Regex("(?i)\\b(\\d+(?:\\.\\d+)?)\\s*(?:dBm)\\b"), "$1 desibel")
            .replace(Regex("(?i)\\bRX\\s*Power\\b"), "daya sinyal")
            .replace(Regex("(?i)\\bTX\\s*Power\\b"), "daya kirim")
            .replace(Regex("(?i)\\bONU\\b|\\bONT\\b"), "modem")
            .replace(Regex("(?i)\\bPPPoE\\b"), "pe pe po e")
            .replace(Regex("(?i)\\bSSID\\b"), "nama wifi")
            .replace(Regex("(?i)\\bQRIS\\b"), "kris")
            .replace(Regex("[🟢🔴🟡⚪⚫🟠🔵🟣🟥🟩🟦🟧🟨⭕❌✅⚠️💡🤖🧾💳📡📶🔒🔓🔄🔑👉⏱️📱🔧🏷️💾💬⚙️🛡️💰📋🙏✔️✖️]"), " ")
            .replace(Regex("[\\p{So}\\p{Cn}]"), " ")
            .replace(Regex("[*_~#|\\\\^$<>\\[\\]{}()•·▪▫➢➔★☆✓✕✖]"), " ")
            .replace(Regex("[^\\p{L}\\p{N}\\s,.\\?!]"), " ")
            .replace(Regex("\\s+"), " ")
            .trim()
    }

    fun shutdown() {
        stopCurrentPlayback()
        try {
            tts?.stop()
            tts?.shutdown()
            tts = null
            isTtsReady = false
        } catch (_: Exception) {}
    }
}
