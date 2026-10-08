package com.alijaya.customer.util

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothSocket
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.OutputStream
import java.nio.charset.Charset
import java.util.UUID

object BluetoothPrinterHelper {
    private const val TAG = "BluetoothPrinterHelper"
    private val SPP_UUID: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")

    // ESC/POS Commands
    private val ESC_INIT = byteArrayOf(0x1B, 0x40)
    private val ESC_CODEPAGE_USA = byteArrayOf(0x1B, 0x74, 0x00) // Page 0 PC437
    private val ESC_ALIGN_LEFT = byteArrayOf(0x1B, 0x61, 0x00)
    private val ESC_ALIGN_CENTER = byteArrayOf(0x1B, 0x61, 0x01)
    private val ESC_ALIGN_RIGHT = byteArrayOf(0x1B, 0x61, 0x02)
    private val ESC_BOLD_ON = byteArrayOf(0x1B, 0x45, 0x01)
    private val ESC_BOLD_OFF = byteArrayOf(0x1B, 0x45, 0x00)
    private val ESC_FONT_LARGE = byteArrayOf(0x1D, 0x21, 0x11)
    private val ESC_FONT_NORMAL = byteArrayOf(0x1D, 0x21, 0x00)
    private val ESC_FEED_LINES = byteArrayOf(0x1B, 0x64, 0x04) // Feed 4 lines

    data class PairedPrinter(val name: String, val address: String)

    @SuppressLint("MissingPermission")
    fun getPairedPrinters(): List<PairedPrinter> {
        val adapter = BluetoothAdapter.getDefaultAdapter() ?: return emptyList()
        val list = mutableListOf<PairedPrinter>()
        try {
            val paired = adapter.bondedDevices
            if (paired != null) {
                for (device in paired) {
                    val name = device.name ?: "Unknown Device"
                    list.add(PairedPrinter(name, device.address))
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error getting paired printers: ${e.message}")
        }
        return list
    }

    @SuppressLint("MissingPermission")
    suspend fun printInvoiceReceipt(
        deviceAddress: String,
        is80mm: Boolean,
        companyName: String,
        companyAddress: String,
        companyPhone: String,
        invoiceNumber: String,
        customerName: String,
        packageName: String,
        period: String,
        amountFormatted: String,
        collectorName: String,
        paymentDate: String
    ): Result<Boolean> = withContext(Dispatchers.IO) {
        val adapter = BluetoothAdapter.getDefaultAdapter()
            ?: return@withContext Result.failure(Exception("Bluetooth tidak tersedia di HP ini"))

        if (!adapter.isEnabled) {
            return@withContext Result.failure(Exception("Bluetooth belum aktif di HP"))
        }

        var socket: BluetoothSocket? = null
        var outputStream: OutputStream? = null

        try {
            val device: BluetoothDevice = adapter.getRemoteDevice(deviceAddress)
            adapter.cancelDiscovery()

            // Try standard SPP first, fallback to reflection channel 1
            socket = try {
                val s = device.createRfcommSocketToServiceRecord(SPP_UUID)
                s.connect()
                s
            } catch (_: Exception) {
                val m = device.javaClass.getMethod("createRfcommSocket", Int::class.javaPrimitiveType)
                val s = m.invoke(device, 1) as BluetoothSocket
                s.connect()
                s
            }

            outputStream = socket.outputStream

            val width = if (is80mm) 48 else 32
            val charset = Charset.forName("ISO-8859-1")

            // Initialize Printer
            outputStream.write(ESC_INIT)
            outputStream.write(ESC_CODEPAGE_USA)

            // Header (Centered)
            outputStream.write(ESC_ALIGN_CENTER)
            outputStream.write(ESC_BOLD_ON)
            outputStream.write(ESC_FONT_LARGE)
            outputStream.write("$companyName\n".toByteArray(charset))
            outputStream.write(ESC_FONT_NORMAL)
            outputStream.write(ESC_BOLD_OFF)

            if (companyAddress.isNotEmpty()) {
                outputStream.write("$companyAddress\n".toByteArray(charset))
            }
            if (companyPhone.isNotEmpty()) {
                outputStream.write("Telp/WA: $companyPhone\n".toByteArray(charset))
            }

            // Divider
            outputStream.write(createDashedLine(width).toByteArray(charset))

            // Subtitle
            outputStream.write(ESC_BOLD_ON)
            outputStream.write("STRUK BUKTI PEMBAYARAN\n".toByteArray(charset))
            outputStream.write(ESC_BOLD_OFF)
            outputStream.write(createDashedLine(width).toByteArray(charset))

            // Left-aligned details
            outputStream.write(ESC_ALIGN_LEFT)
            outputStream.write(formatTwoColumns("No. Faktur", invoiceNumber, width).toByteArray(charset))
            outputStream.write(formatTwoColumns("Waktu", paymentDate, width).toByteArray(charset))
            outputStream.write(formatTwoColumns("Petugas", collectorName, width).toByteArray(charset))
            outputStream.write(createDashedLine(width).toByteArray(charset))

            outputStream.write(formatTwoColumns("Pelanggan", customerName, width).toByteArray(charset))
            outputStream.write(formatTwoColumns("Paket", packageName, width).toByteArray(charset))
            outputStream.write(formatTwoColumns("Periode", period, width).toByteArray(charset))
            outputStream.write(createDashedLine(width).toByteArray(charset))

            // Total (Centered Box)
            outputStream.write(ESC_ALIGN_CENTER)
            outputStream.write("TOTAL PEMBAYARAN\n".toByteArray(charset))
            outputStream.write(ESC_BOLD_ON)
            outputStream.write(ESC_FONT_LARGE)
            outputStream.write("$amountFormatted\n".toByteArray(charset))
            outputStream.write(ESC_FONT_NORMAL)
            outputStream.write("*** LUNAS ***\n".toByteArray(charset))
            outputStream.write(ESC_BOLD_OFF)

            outputStream.write(createDashedLine(width).toByteArray(charset))
            outputStream.write("Simpan struk ini sebagai bukti\npembayaran yang sah.\nTerima Kasih!\n".toByteArray(charset))
            
            // Feed Paper Command
            outputStream.write(ESC_FEED_LINES)
            outputStream.write(byteArrayOf(0x0A, 0x0A, 0x0A, 0x0A))

            outputStream.flush()

            // Wait for transmission to printer hardware buffer before closing socket
            Thread.sleep(800)

            Result.success(true)
        } catch (e: Exception) {
            Log.e(TAG, "Print invoice error: ${e.message}", e)
            Result.failure(e)
        } finally {
            try { outputStream?.close() } catch (_: Exception) {}
            try { socket?.close() } catch (_: Exception) {}
        }
    }

    @SuppressLint("MissingPermission")
    suspend fun printVoucherTicket(
        deviceAddress: String,
        is80mm: Boolean,
        companyName: String,
        packageName: String,
        voucherCode: String,
        voucherPass: String,
        priceFormatted: String,
        validity: String,
        contact: String,
        hotspotDns: String = ""
    ): Result<Boolean> = withContext(Dispatchers.IO) {
        val adapter = BluetoothAdapter.getDefaultAdapter()
            ?: return@withContext Result.failure(Exception("Bluetooth tidak tersedia di HP ini"))

        if (!adapter.isEnabled) {
            return@withContext Result.failure(Exception("Bluetooth belum aktif di HP"))
        }

        var socket: BluetoothSocket? = null
        var outputStream: OutputStream? = null

        try {
            val device: BluetoothDevice = adapter.getRemoteDevice(deviceAddress)
            adapter.cancelDiscovery()

            socket = try {
                val s = device.createRfcommSocketToServiceRecord(SPP_UUID)
                s.connect()
                s
            } catch (_: Exception) {
                val m = device.javaClass.getMethod("createRfcommSocket", Int::class.javaPrimitiveType)
                val s = m.invoke(device, 1) as BluetoothSocket
                s.connect()
                s
            }

            outputStream = socket.outputStream

            val width = if (is80mm) 48 else 32
            val charset = Charset.forName("ISO-8859-1")

            // Initialize
            outputStream.write(ESC_INIT)
            outputStream.write(ESC_CODEPAGE_USA)

            // Header
            outputStream.write(ESC_ALIGN_CENTER)
            outputStream.write(ESC_BOLD_ON)
            outputStream.write("$companyName\n".toByteArray(charset))
            outputStream.write(ESC_BOLD_OFF)
            outputStream.write("VOUCHER INTERNET HOTSPOT\n".toByteArray(charset))
            outputStream.write(createDashedLine(width).toByteArray(charset))

            // Package & Price
            outputStream.write(ESC_BOLD_ON)
            outputStream.write("$packageName - $priceFormatted\n".toByteArray(charset))
            outputStream.write("Masa Aktif: $validity\n".toByteArray(charset))
            outputStream.write(ESC_BOLD_OFF)
            outputStream.write(createDashedLine(width).toByteArray(charset))

            // Code
            if (voucherCode == voucherPass) {
                outputStream.write("KODE LOGIN VOUCHER:\n".toByteArray(charset))
                outputStream.write(ESC_BOLD_ON)
                outputStream.write(ESC_FONT_LARGE)
                outputStream.write("$voucherCode\n".toByteArray(charset))
                outputStream.write(ESC_FONT_NORMAL)
                outputStream.write(ESC_BOLD_OFF)
            } else {
                outputStream.write(ESC_ALIGN_LEFT)
                outputStream.write(ESC_BOLD_ON)
                outputStream.write("Username : $voucherCode\n".toByteArray(charset))
                outputStream.write("Password : $voucherPass\n".toByteArray(charset))
                outputStream.write(ESC_BOLD_OFF)
                outputStream.write(ESC_ALIGN_CENTER)
            }

            outputStream.write(createDashedLine(width).toByteArray(charset))
            if (hotspotDns.isNotEmpty()) {
                outputStream.write("Login: $hotspotDns\n".toByteArray(charset))
            } else {
                outputStream.write("Hubungkan ke WiFi & masukkan kode.\n".toByteArray(charset))
            }
            if (contact.isNotEmpty()) {
                outputStream.write("CS/WA: $contact\n".toByteArray(charset))
            }
            
            outputStream.write(ESC_FEED_LINES)
            outputStream.write(byteArrayOf(0x0A, 0x0A, 0x0A, 0x0A))

            outputStream.flush()
            Thread.sleep(800)

            Result.success(true)
        } catch (e: Exception) {
            Log.e(TAG, "Print voucher error: ${e.message}", e)
            Result.failure(e)
        } finally {
            try { outputStream?.close() } catch (_: Exception) {}
            try { socket?.close() } catch (_: Exception) {}
        }
    }

    @SuppressLint("MissingPermission")
    suspend fun printVoucherBatchContinuous(
        deviceAddress: String,
        is80mm: Boolean,
        companyName: String,
        packageName: String,
        priceFormatted: String,
        validity: String,
        contact: String,
        hotspotDns: String,
        vouchers: List<Pair<String, String>>,
        onProgress: ((current: Int, total: Int) -> Unit)? = null
    ): Result<Int> = withContext(Dispatchers.IO) {
        val adapter = BluetoothAdapter.getDefaultAdapter()
            ?: return@withContext Result.failure(Exception("Bluetooth tidak tersedia di HP ini"))

        if (!adapter.isEnabled) {
            return@withContext Result.failure(Exception("Bluetooth belum aktif di HP"))
        }

        var socket: BluetoothSocket? = null
        var outputStream: OutputStream? = null

        try {
            val device: BluetoothDevice = adapter.getRemoteDevice(deviceAddress)
            adapter.cancelDiscovery()

            socket = try {
                val s = device.createRfcommSocketToServiceRecord(SPP_UUID)
                s.connect()
                s
            } catch (_: Exception) {
                val m = device.javaClass.getMethod("createRfcommSocket", Int::class.javaPrimitiveType)
                val s = m.invoke(device, 1) as BluetoothSocket
                s.connect()
                s
            }

            outputStream = socket.outputStream

            val width = if (is80mm) 48 else 32
            val charset = Charset.forName("ISO-8859-1")

            // Initialize
            outputStream.write(ESC_INIT)
            outputStream.write(ESC_CODEPAGE_USA)

            var printedCount = 0
            val total = vouchers.size

            for ((index, voucher) in vouchers.withIndex()) {
                val (code, pass) = voucher
                val isSame = code == pass

                // Ticket Header
                outputStream.write(ESC_ALIGN_CENTER)
                outputStream.write(ESC_BOLD_ON)
                outputStream.write("$companyName\n".toByteArray(charset))
                outputStream.write(ESC_BOLD_OFF)
                outputStream.write("VOUCHER INTERNET HOTSPOT\n".toByteArray(charset))
                outputStream.write(createDashedLine(width).toByteArray(charset))

                // Package & Price
                outputStream.write(ESC_BOLD_ON)
                outputStream.write("$packageName - $priceFormatted\n".toByteArray(charset))
                outputStream.write("Masa Aktif: $validity\n".toByteArray(charset))
                outputStream.write(ESC_BOLD_OFF)
                outputStream.write(createDashedLine(width).toByteArray(charset))

                // Credentials
                if (isSame) {
                    outputStream.write("KODE LOGIN VOUCHER:\n".toByteArray(charset))
                    outputStream.write(ESC_BOLD_ON)
                    outputStream.write(ESC_FONT_LARGE)
                    outputStream.write("$code\n".toByteArray(charset))
                    outputStream.write(ESC_FONT_NORMAL)
                    outputStream.write(ESC_BOLD_OFF)
                } else {
                    outputStream.write(ESC_ALIGN_LEFT)
                    outputStream.write(ESC_BOLD_ON)
                    outputStream.write("Username : $code\n".toByteArray(charset))
                    outputStream.write("Password : $pass\n".toByteArray(charset))
                    outputStream.write(ESC_BOLD_OFF)
                    outputStream.write(ESC_ALIGN_CENTER)
                }

                outputStream.write(createDashedLine(width).toByteArray(charset))
                if (hotspotDns.isNotEmpty()) {
                    outputStream.write("Login: $hotspotDns\n".toByteArray(charset))
                } else {
                    outputStream.write("Hubungkan ke WiFi & masukkan kode.\n".toByteArray(charset))
                }
                if (contact.isNotEmpty()) {
                    outputStream.write("CS/WA: $contact\n".toByteArray(charset))
                }

                // Tear line between continuous tickets
                outputStream.write("- - - - - - - - - - - - - - - -\n".toByteArray(charset))
                outputStream.write(byteArrayOf(0x0A, 0x0A))
                outputStream.flush()

                printedCount++
                onProgress?.invoke(printedCount, total)

                // Brief pause to allow thermal print head to keep up without buffer dropping
                Thread.sleep(180)
            }

            // Final feed lines after last ticket
            outputStream.write(ESC_FEED_LINES)
            outputStream.write(byteArrayOf(0x0A, 0x0A))
            outputStream.flush()
            Thread.sleep(500)

            Result.success(printedCount)
        } catch (e: Exception) {
            Log.e(TAG, "Print batch continuous error: ${e.message}", e)
            Result.failure(e)
        } finally {
            try { outputStream?.close() } catch (_: Exception) {}
            try { socket?.close() } catch (_: Exception) {}
        }
    }

    fun centerText(text: String, width: Int = 32): String {
        if (text.length >= width) return text
        val pad = (width - text.length) / 2
        return " ".repeat(pad) + text
    }

    @SuppressLint("MissingPermission")
    fun printRawLines(context: android.content.Context, deviceAddress: String, lines: List<String>) {
        if (deviceAddress.isBlank()) return
        Thread {
            val adapter = BluetoothAdapter.getDefaultAdapter() ?: return@Thread
            if (!adapter.isEnabled) return@Thread

            var socket: BluetoothSocket? = null
            var outputStream: OutputStream? = null

            try {
                val device: BluetoothDevice = adapter.getRemoteDevice(deviceAddress)
                adapter.cancelDiscovery()

                socket = try {
                    val s = device.createRfcommSocketToServiceRecord(SPP_UUID)
                    s.connect()
                    s
                } catch (_: Exception) {
                    val m = device.javaClass.getMethod("createRfcommSocket", Int::class.javaPrimitiveType)
                    val s = m.invoke(device, 1) as BluetoothSocket
                    s.connect()
                    s
                }

                outputStream = socket.outputStream
                val charset = Charset.forName("ISO-8859-1")

                outputStream.write(ESC_INIT)
                outputStream.write(ESC_CODEPAGE_USA)

                for (line in lines) {
                    outputStream.write("$line\n".toByteArray(charset))
                }

                outputStream.write(ESC_FEED_LINES)
                outputStream.write(byteArrayOf(0x0A, 0x0A, 0x0A, 0x0A))
                outputStream.flush()
                Thread.sleep(800)
            } catch (e: Exception) {
                Log.e(TAG, "Print raw error: ${e.message}")
            } finally {
                try { outputStream?.close() } catch (_: Exception) {}
                try { socket?.close() } catch (_: Exception) {}
            }
        }.start()
    }

    private fun createDashedLine(width: Int): String {
        return "-".repeat(width) + "\n"
    }

    private fun formatTwoColumns(left: String, right: String, totalWidth: Int): String {
        val maxLeft = (totalWidth * 0.45).toInt()
        val trimmedLeft = if (left.length > maxLeft) left.substring(0, maxLeft) else left
        val spacesCount = totalWidth - trimmedLeft.length - right.length
        val spaces = if (spacesCount > 0) " ".repeat(spacesCount) else " "
        return "$trimmedLeft$spaces$right\n"
    }
}