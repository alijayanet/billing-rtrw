package com.alijaya.customer.bridge

import android.app.Activity
import android.webkit.JavascriptInterface
import android.widget.Toast
import com.alijaya.customer.CustomerApplication
import com.alijaya.customer.util.BluetoothPrinterHelper
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

class AndroidBluetoothBridge(private val activity: Activity) {

    private val session = CustomerApplication.sessionManager

    @JavascriptInterface
    fun isBluetoothSupported(): Boolean {
        return BluetoothPrinterHelper.getPairedPrinters().isNotEmpty()
    }

    @JavascriptInterface
    fun getPairedPrintersJson(): String {
        val printers = BluetoothPrinterHelper.getPairedPrinters()
        val array = JSONArray()
        for (p in printers) {
            val obj = JSONObject()
            obj.put("name", p.name)
            obj.put("address", p.address)
            array.put(obj)
        }
        return array.toString()
    }

    @JavascriptInterface
    fun printInvoice(jsonString: String) {
        val savedPrinterMac = session.getPrinterMac()
        if (savedPrinterMac.isEmpty()) {
            activity.runOnUiThread {
                Toast.makeText(activity, "Belum ada printer Bluetooth dipilih. Atur di menu Pengaturan.", Toast.LENGTH_LONG).show()
            }
            return
        }

        try {
            val json = JSONObject(jsonString)
            val is80mm = session.isPrinter80mm()

            CoroutineScope(Dispatchers.Main).launch {
                val result = BluetoothPrinterHelper.printInvoiceReceipt(
                    deviceAddress = savedPrinterMac,
                    is80mm = is80mm,
                    companyName = json.optString("companyName", "ALIJAYA NETWORK"),
                    companyAddress = json.optString("companyAddress", ""),
                    companyPhone = json.optString("companyPhone", ""),
                    invoiceNumber = json.optString("invoiceNumber", "#INV-0000"),
                    customerName = json.optString("customerName", "-"),
                    packageName = json.optString("packageName", "Internet"),
                    period = json.optString("period", "-"),
                    amountFormatted = json.optString("amountFormatted", "Rp 0"),
                    collectorName = json.optString("collectorName", "Kasir"),
                    paymentDate = json.optString("paymentDate", "")
                )

                if (result.isSuccess) {
                    Toast.makeText(activity, "Struk berhasil dicetak!", Toast.LENGTH_SHORT).show()
                } else {
                    val err = result.exceptionOrNull()?.message ?: "Gagal mencetak struk"
                    Toast.makeText(activity, "Gagal mencetak: $err", Toast.LENGTH_LONG).show()
                }
            }
        } catch (e: Exception) {
            activity.runOnUiThread {
                Toast.makeText(activity, "Format data cetak salah: ${e.message}", Toast.LENGTH_SHORT).show()
            }
        }
    }

    @JavascriptInterface
    fun printVoucher(jsonString: String) {
        val savedPrinterMac = session.getPrinterMac()
        if (savedPrinterMac.isEmpty()) {
            activity.runOnUiThread {
                Toast.makeText(activity, "Belum ada printer Bluetooth dipilih. Atur di menu Pengaturan.", Toast.LENGTH_LONG).show()
            }
            return
        }

        try {
            val json = JSONObject(jsonString)
            val is80mm = session.isPrinter80mm()

            CoroutineScope(Dispatchers.Main).launch {
                val result = BluetoothPrinterHelper.printVoucherTicket(
                    deviceAddress = savedPrinterMac,
                    is80mm = is80mm,
                    companyName = json.optString("companyName", "ALIJAYA HOTSPOT"),
                    packageName = json.optString("packageName", "Voucher"),
                    voucherCode = json.optString("voucherCode", "000000"),
                    voucherPass = json.optString("voucherPass", "000000"),
                    priceFormatted = json.optString("priceFormatted", "Rp 0"),
                    validity = json.optString("validity", "1 Hari"),
                    contact = json.optString("contact", "")
                )

                if (result.isSuccess) {
                    Toast.makeText(activity, "Voucher berhasil dicetak!", Toast.LENGTH_SHORT).show()
                } else {
                    val err = result.exceptionOrNull()?.message ?: "Gagal mencetak voucher"
                    Toast.makeText(activity, "Gagal mencetak: $err", Toast.LENGTH_LONG).show()
                }
            }
        } catch (e: Exception) {
            activity.runOnUiThread {
                Toast.makeText(activity, "Format data voucher salah: ${e.message}", Toast.LENGTH_SHORT).show()
            }
        }
    }

    @JavascriptInterface
    fun showToast(message: String) {
        activity.runOnUiThread {
            Toast.makeText(activity, message, Toast.LENGTH_SHORT).show()
        }
    }
}
