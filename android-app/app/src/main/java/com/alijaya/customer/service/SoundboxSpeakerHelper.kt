package com.alijaya.customer.service

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.speech.tts.TextToSpeech
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.Locale

object SoundboxSpeakerHelper {
    private const val TAG = "SoundboxSpeaker"
    private var tts: TextToSpeech? = null
    private var isTtsReady = false
    private val scope = CoroutineScope(Dispatchers.Main)

    fun init(context: Context) {
        if (tts != null) return
        try {
            tts = TextToSpeech(context.applicationContext) { status ->
                if (status == TextToSpeech.SUCCESS) {
                    val result = tts?.setLanguage(Locale("id", "ID"))
                    if (result == TextToSpeech.LANG_MISSING_DATA || result == TextToSpeech.LANG_NOT_SUPPORTED) {
                        tts?.setLanguage(Locale.getDefault())
                    }
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

    /**
     * Berbicara melalui speaker kasir (didahului bel kasir)
     */
    fun speak(context: Context, text: String, withChime: Boolean = true) {
        init(context)
        scope.launch {
            if (withChime) {
                playChime()
                delay(400)
            }
            if (isTtsReady && tts != null) {
                tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, "soundbox_" + System.currentTimeMillis())
            }
        }
    }

    fun shutdown() {
        try {
            tts?.stop()
            tts?.shutdown()
            tts = null
            isTtsReady = false
        } catch (_: Exception) {}
    }
}
