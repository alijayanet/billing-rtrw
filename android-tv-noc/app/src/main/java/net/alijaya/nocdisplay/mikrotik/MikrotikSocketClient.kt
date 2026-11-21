package net.alijaya.nocdisplay.mikrotik

import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.IOException
import java.net.InetSocketAddress
import java.net.Socket
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import javax.net.ssl.SSLSocketFactory

class MikrotikSocketClient(
    private val host: String,
    private val port: Int = 8728,
    private val timeoutMs: Int = 5000,
    private val useSsl: Boolean = false
) : AutoCloseable {

    private var socket: Socket? = null
    private var inStream: DataInputStream? = null
    private var outStream: DataOutputStream? = null

    @Synchronized
    fun connect(username: String, password: String): Boolean {
        close()
        val s = if (useSsl) {
            SSLSocketFactory.getDefault().createSocket()
        } else {
            Socket()
        }
        s.tcpNoDelay = true
        s.soTimeout = timeoutMs
        s.connect(InetSocketAddress(host, port), timeoutMs)
        socket = s
        inStream = DataInputStream(BufferedInputStream(s.getInputStream(), 8192))
        outStream = DataOutputStream(BufferedOutputStream(s.getOutputStream(), 8192))

        return authenticate(username, password)
    }

    private fun authenticate(username: String, password: String): Boolean {
        // Step 1: Send /login to request challenge or initiate auth
        writeSentence(listOf("/login"))
        var challengeHex: String? = null

        while (true) {
            val sentence = readSentence()
            if (sentence.isEmpty()) break
            for (reply in sentence) {
                if (reply.startsWith("=ret=")) {
                    challengeHex = reply.substring(5)
                }
            }
            val first = sentence.firstOrNull() ?: ""
            if (first == "!done" || first == "!trap") {
                break
            }
        }

        if (challengeHex != null) {
            // Challenge-response flow (RouterOS 6.x)
            val challengeBytes = hexStringToByteArray(challengeHex)
            val md = MessageDigest.getInstance("MD5")
            md.update(0.toByte())
            md.update(password.toByteArray(StandardCharsets.UTF_8))
            md.update(challengeBytes)
            val responseHex = "00" + byteArrayToHexString(md.digest())

            writeSentence(
                listOf(
                    "/login",
                    "=name=$username",
                    "=response=$responseHex"
                )
            )

            var isAuthSuccess = false
            var trapMessage: String? = null
            while (true) {
                val sentence = readSentence()
                if (sentence.isEmpty()) break
                val first = sentence.firstOrNull() ?: ""
                if (first == "!done") {
                    if (trapMessage == null) {
                        isAuthSuccess = true
                    }
                    break
                }
                if (first == "!trap") {
                    trapMessage = sentence.find { it.startsWith("=message=") }?.substring(9) ?: "Login ditolak"
                }
            }
            if (!isAuthSuccess) {
                close()
                throw IOException(trapMessage ?: "Username atau password salah")
            }
            return true
        }

        // Direct plain auth (RouterOS 6.43+ and 7.x)
        writeSentence(
            listOf(
                "/login",
                "=name=$username",
                "=password=$password"
            )
        )
        var isAuthSuccess = false
        var trapMessage: String? = null
        while (true) {
            val sentence = readSentence()
            if (sentence.isEmpty()) break
            val first = sentence.firstOrNull() ?: ""
            if (first == "!done") {
                if (trapMessage == null) {
                    isAuthSuccess = true
                }
                break
            }
            if (first == "!trap") {
                trapMessage = sentence.find { it.startsWith("=message=") }?.substring(9) ?: "Login ditolak"
            }
        }
        if (!isAuthSuccess) {
            close()
            throw IOException(trapMessage ?: "Username atau password salah")
        }
        return true
    }

    @Synchronized
    fun execute(words: List<String>): List<Map<String, String>> {
        val inS = inStream ?: throw IOException("MikroTik socket not connected")
        writeSentence(words)

        val results = mutableListOf<Map<String, String>>()
        var currentMap = mutableMapOf<String, String>()

        while (true) {
            val sentence = readSentence()
            if (sentence.isEmpty()) break

            val firstWord = sentence.firstOrNull() ?: ""
            when {
                firstWord == "!re" -> {
                    currentMap = mutableMapOf()
                    for (i in 1 until sentence.size) {
                        val word = sentence[i]
                        if (word.startsWith("=")) {
                            val eqIdx = word.indexOf('=', 1)
                            if (eqIdx > 1) {
                                val key = word.substring(1, eqIdx)
                                val value = word.substring(eqIdx + 1)
                                currentMap[key] = value
                            }
                        }
                    }
                    results.add(currentMap)
                }
                firstWord == "!done" -> {
                    // Check if done contains ret values
                    for (i in 1 until sentence.size) {
                        val word = sentence[i]
                        if (word.startsWith("=")) {
                            val eqIdx = word.indexOf('=', 1)
                            if (eqIdx > 1) {
                                val key = word.substring(1, eqIdx)
                                val value = word.substring(eqIdx + 1)
                                currentMap[key] = value
                            }
                        }
                    }
                    if (currentMap.isNotEmpty() && !results.contains(currentMap)) {
                        results.add(currentMap)
                    }
                    break
                }
                firstWord == "!trap" -> {
                    var msg = "API trap error"
                    for (word in sentence) {
                        if (word.startsWith("=message=")) {
                            msg = word.substring(9)
                        }
                    }
                    throw IOException(msg)
                }
                firstWord == "!fatal" -> {
                    close()
                    throw IOException("Connection fatal error from router")
                }
            }
        }

        return results
    }

    private fun writeSentence(words: List<String>) {
        val outS = outStream ?: throw IOException("Socket not initialized")
        for (w in words) {
            writeWord(outS, w)
        }
        // Sentence terminator (length 0)
        outS.writeByte(0)
        outS.flush()
    }

    private fun writeWord(out: DataOutputStream, word: String) {
        val bytes = word.toByteArray(StandardCharsets.UTF_8)
        val len = bytes.size
        when {
            len < 0x80 -> {
                out.writeByte(len)
            }
            len < 0x4000 -> {
                out.writeByte((len ushr 8) or 0x80)
                out.writeByte(len and 0xFF)
            }
            len < 0x200000 -> {
                out.writeByte((len ushr 16) or 0xC0)
                out.writeByte((len ushr 8) and 0xFF)
                out.writeByte(len and 0xFF)
            }
            len < 0x10000000 -> {
                out.writeByte((len ushr 24) or 0xE0)
                out.writeByte((len ushr 16) and 0xFF)
                out.writeByte((len ushr 8) and 0xFF)
                out.writeByte(len and 0xFF)
            }
            else -> {
                out.writeByte(0xF0)
                out.writeInt(len)
            }
        }
        out.write(bytes)
    }

    private fun readSentence(): List<String> {
        val inS = inStream ?: throw IOException("Socket not initialized")
        val words = mutableListOf<String>()
        while (true) {
            val word = readWord(inS) ?: break
            words.add(word)
        }
        return words
    }

    private fun readWord(inStream: DataInputStream): String? {
        val b = inStream.read()
        if (b == -1) throw IOException("End of stream from router")
        if (b == 0) return null // End of sentence

        val len: Int = when {
            (b and 0x80) == 0 -> b
            (b and 0xC0) == 0x80 -> {
                val b2 = inStream.read()
                ((b and 0x3F) shl 8) or b2
            }
            (b and 0xE0) == 0xC0 -> {
                val b2 = inStream.read()
                val b3 = inStream.read()
                ((b and 0x1F) shl 16) or (b2 shl 8) or b3
            }
            (b and 0xF0) == 0xE0 -> {
                val b2 = inStream.read()
                val b3 = inStream.read()
                val b4 = inStream.read()
                ((b and 0x0F) shl 24) or (b2 shl 16) or (b3 shl 8) or b4
            }
            b == 0xF0 -> {
                inStream.readInt()
            }
            else -> throw IOException("Invalid length prefix byte: $b")
        }

        val buf = ByteArray(len)
        inStream.readFully(buf)
        return String(buf, StandardCharsets.UTF_8)
    }

    override fun close() {
        try {
            inStream?.close()
        } catch (_: Exception) {}
        try {
            outStream?.close()
        } catch (_: Exception) {}
        try {
            socket?.close()
        } catch (_: Exception) {}
        inStream = null
        outStream = null
        socket = null
    }

    val isConnected: Boolean
        get() = socket?.isConnected == true && socket?.isClosed == false

    companion object {
        private fun hexStringToByteArray(s: String): ByteArray {
            val len = s.length
            val data = ByteArray(len / 2)
            var i = 0
            while (i < len) {
                data[i / 2] = ((Character.digit(s[i], 16) shl 4) + Character.digit(s[i + 1], 16)).toByte()
                i += 2
            }
            return data
        }

        private fun byteArrayToHexString(bytes: ByteArray): String {
            val sb = StringBuilder(bytes.size * 2)
            for (b in bytes) {
                sb.append(String.format("%02x", b))
            }
            return sb.toString()
        }
    }
}
