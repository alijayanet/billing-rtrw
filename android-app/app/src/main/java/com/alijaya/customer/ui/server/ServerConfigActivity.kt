package com.alijaya.customer.ui.server

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.webkit.CookieManager
import android.widget.ArrayAdapter
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.alijaya.customer.CustomerApplication
import com.alijaya.customer.data.pref.SessionManager
import com.alijaya.customer.databinding.ActivityServerConfigBinding
import com.alijaya.customer.ui.login.LoginActivity
import com.alijaya.customer.ui.main.MainActivity
import com.alijaya.customer.util.BluetoothPrinterHelper
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanIntentResult
import com.journeyapps.barcodescanner.ScanOptions
import android.net.Uri
import org.json.JSONObject
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

class ServerConfigActivity : AppCompatActivity() {
    private lateinit var binding: ActivityServerConfigBinding
    private var pairedPrinters: List<BluetoothPrinterHelper.PairedPrinter> = emptyList()

    private val qrScanLauncher = registerForActivityResult(ScanContract()) { result: ScanIntentResult ->
        if (result.contents != null) {
            handleQrCodeResult(result.contents)
        }
    }

    private val requestBtPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { permissions ->
        val isGranted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            permissions[Manifest.permission.BLUETOOTH_CONNECT] == true
        } else {
            permissions[Manifest.permission.ACCESS_FINE_LOCATION] == true || permissions[Manifest.permission.BLUETOOTH] == true
        }

        if (isGranted) {
            loadBluetoothPrinters()
            Toast.makeText(this, "Izin Bluetooth berhasil diberikan", Toast.LENGTH_SHORT).show()
        } else {
            Toast.makeText(this, "Izin Bluetooth diperlukan untuk membaca daftar printer", Toast.LENGTH_LONG).show()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityServerConfigBinding.inflate(layoutInflater)
        setContentView(binding.root)

        val session = CustomerApplication.sessionManager

        // Load existing values
        binding.etServerUrl.setText(session.getServerBaseUrl())

        when (session.getPortalType()) {
            SessionManager.PORTAL_AGENT -> binding.rbAgent.isChecked = true
            SessionManager.PORTAL_TECH -> binding.rbTech.isChecked = true
            SessionManager.PORTAL_ADMIN -> binding.rbAdmin.isChecked = true
            SessionManager.PORTAL_COLLECTOR -> binding.rbCollector.isChecked = true
            else -> binding.rbCustomer.isChecked = true
        }

        if (session.isPrinter80mm()) {
            binding.rb80mm.isChecked = true
        } else {
            binding.rb58mm.isChecked = true
        }

        checkAndRequestBtPermissions()
        updatePreviewUrl()

        // Radio button changes
        binding.rgPortalType.setOnCheckedChangeListener { _, _ ->
            updatePreviewUrl()
        }

        // QR Code Scanner Button
        binding.btnScanQr.setOnClickListener {
            launchQrScanner()
        }

        // Quick Preset Buttons
        binding.btnPresetAlijaya.setOnClickListener {
            binding.etServerUrl.setText("https://app.alijaya.com")
            updatePreviewUrl()
            testConnection()
        }

        binding.btnPresetLocal.setOnClickListener {
            binding.etServerUrl.setText("http://192.168.8.5:3001")
            updatePreviewUrl()
            testConnection()
        }

        // Test Connection Button
        binding.btnTestConnection.setOnClickListener {
            testConnection()
        }

        // Scan Bluetooth Printers
        binding.btnScanPrinters.setOnClickListener {
            checkAndRequestBtPermissions(force = true)
        }

        // Open Phone's Bluetooth Settings
        binding.btnOpenBtSettings.setOnClickListener {
            try {
                startActivity(Intent(Settings.ACTION_BLUETOOTH_SETTINGS))
            } catch (_: Exception) {
                Toast.makeText(this, "Buka menu Pengaturan Bluetooth di HP Anda", Toast.LENGTH_SHORT).show()
            }
        }

        // Test Print Struk
        binding.btnTestPrint.setOnClickListener {
            val selectedIdx = binding.spPrinters.selectedItemPosition
            if (selectedIdx >= 0 && selectedIdx < pairedPrinters.size) {
                val p = pairedPrinters[selectedIdx]
                val is80mm = binding.rb80mm.isChecked
                lifecycleScope.launch {
                    binding.btnTestPrint.isEnabled = false
                    binding.btnTestPrint.text = " Mencetak..."
                    val res = BluetoothPrinterHelper.printInvoiceReceipt(
                        deviceAddress = p.address,
                        is80mm = is80mm,
                        companyName = "ALIJAYA NETWORK",
                        companyAddress = "Jl. Raya Utama No. 123",
                        companyPhone = "08123456789",
                        invoiceNumber = "#TEST-001",
                        customerName = "Tes Cetak Struk",
                        packageName = "Paket Internet 20 Mbps",
                        period = "Agu 2026",
                        amountFormatted = "Rp 150.000",
                        collectorName = "Admin",
                        paymentDate = "24/08/2026 08:00"
                    )
                    binding.btnTestPrint.isEnabled = true
                    binding.btnTestPrint.text = " Tes Cetak Struk Contoh"

                    if (res.isSuccess) {
                        Toast.makeText(this@ServerConfigActivity, "Berhasil mencetak ke ${p.name}", Toast.LENGTH_SHORT).show()
                    } else {
                        Toast.makeText(this@ServerConfigActivity, "Gagal: ${res.exceptionOrNull()?.message}", Toast.LENGTH_LONG).show()
                    }
                }
            } else {
                Toast.makeText(this, "Silakan pilih printer Bluetooth yang terpasang", Toast.LENGTH_SHORT).show()
            }
        }

        // Save Button
        binding.btnSave.setOnClickListener {
            val url = binding.etServerUrl.text.toString().trim()
            if (url.isEmpty()) {
                Toast.makeText(this, "Alamat server tidak boleh kosong", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }

            val selectedPortal = when (binding.rgPortalType.checkedRadioButtonId) {
                binding.rbAgent.id -> SessionManager.PORTAL_AGENT
                binding.rbTech.id -> SessionManager.PORTAL_TECH
                binding.rbAdmin.id -> SessionManager.PORTAL_ADMIN
                binding.rbCollector.id -> SessionManager.PORTAL_COLLECTOR
                else -> SessionManager.PORTAL_CUSTOMER
            }

            // Save printer
            val selectedIdx = binding.spPrinters.selectedItemPosition
            if (selectedIdx >= 0 && selectedIdx < pairedPrinters.size) {
                val p = pairedPrinters[selectedIdx]
                session.setPrinter(p.address, p.name, binding.rb80mm.isChecked)
            }

            // Clear old session cookies when changing server or portal
            CookieManager.getInstance().removeAllCookies(null)
            CookieManager.getInstance().flush()

            session.saveConfig(url, selectedPortal)
            Toast.makeText(this, "Pengaturan berhasil disimpan!", Toast.LENGTH_SHORT).show()

            val targetClass = if (!session.isLoggedIn()) {
                LoginActivity::class.java
            } else {
                MainActivity::class.java
            }

            val intent = Intent(this, targetClass).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
            }
            startActivity(intent)
            finish()
        }

        // Reset Button
        binding.btnReset.setOnClickListener {
            session.resetToDefault()
            binding.etServerUrl.setText(SessionManager.DEFAULT_SERVER_URL)
            binding.rbCustomer.isChecked = true
            updatePreviewUrl()
            Toast.makeText(this, "Server direset ke Default", Toast.LENGTH_SHORT).show()
        }
    }

    private fun checkAndRequestBtPermissions(force: Boolean = false) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val connectGranted = ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED
            val scanGranted = ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED
            if (!connectGranted || !scanGranted) {
                requestBtPermissionLauncher.launch(arrayOf(
                    Manifest.permission.BLUETOOTH_CONNECT,
                    Manifest.permission.BLUETOOTH_SCAN
                ))
                return
            }
        } else {
            val locGranted = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
            if (!locGranted) {
                requestBtPermissionLauncher.launch(arrayOf(
                    Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION
                ))
                return
            }
        }

        loadBluetoothPrinters()
    }

    private fun loadBluetoothPrinters() {
        pairedPrinters = BluetoothPrinterHelper.getPairedPrinters()
        val session = CustomerApplication.sessionManager

        val items = if (pairedPrinters.isEmpty()) {
            listOf("Tidak ada printer Bluetooth terhubung (Tekan )")
        } else {
            pairedPrinters.map { "${it.name} (${it.address})" }
        }

        val adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, items)
        binding.spPrinters.adapter = adapter

        // Select previously saved printer
        val savedMac = session.getPrinterMac()
        if (savedMac.isNotEmpty()) {
            val idx = pairedPrinters.indexOfFirst { it.address.equals(savedMac, ignoreCase = true) }
            if (idx >= 0) binding.spPrinters.setSelection(idx)
        }
    }

    private fun getUnsafeOkHttpClient(): OkHttpClient {
        return try {
            val trustAllCerts = arrayOf<TrustManager>(object : X509TrustManager {
                override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
                override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
                override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
            })

            val sslContext = SSLContext.getInstance("SSL")
            sslContext.init(null, trustAllCerts, SecureRandom())

            OkHttpClient.Builder()
                .sslSocketFactory(sslContext.socketFactory, trustAllCerts[0] as X509TrustManager)
                .hostnameVerifier { _, _ -> true }
                .connectTimeout(6, TimeUnit.SECONDS)
                .readTimeout(6, TimeUnit.SECONDS)
                .followRedirects(true)
                .build()
        } catch (_: Exception) {
            OkHttpClient.Builder()
                .connectTimeout(6, TimeUnit.SECONDS)
                .readTimeout(6, TimeUnit.SECONDS)
                .build()
        }
    }

    private fun testConnection() {
        val rawUrl = binding.etServerUrl.text.toString().trim()
        val base = if (rawUrl.isEmpty()) "https://app.alijaya.com" else rawUrl
        val cleanBase = if (base.startsWith("http://") || base.startsWith("https://")) base else "https://$base"
        val pingUrl = if (cleanBase.endsWith("/")) "${cleanBase}api/customer/ping" else "$cleanBase/api/customer/ping"

        binding.tvConnectionStatus.text = "Status:  Menghubungkan ke $cleanBase..."
        binding.tvConnectionStatus.setTextColor(Color.parseColor("#38BDF8"))

        lifecycleScope.launch {
            var detectedIsp = ""
            val isSuccess = withContext(Dispatchers.IO) {
                try {
                    val client = getUnsafeOkHttpClient()
                    val request = Request.Builder().url(pingUrl).build()
                    val response = client.newCall(request).execute()
                    if (response.isSuccessful) {
                        val str = response.body?.string()
                        if (!str.isNullOrBlank()) {
                            try {
                                val json = org.json.JSONObject(str)
                                detectedIsp = json.optString("companyHeader", json.optString("ispName", json.optString("appName", "")))
                                if (detectedIsp.isNotBlank()) {
                                    CustomerApplication.sessionManager.saveIspName(detectedIsp)
                                }
                                val phone = json.optString("companyPhone", json.optString("adminPhone", ""))
                                if (phone.isNotBlank()) {
                                    CustomerApplication.sessionManager.saveAdminPhone(phone)
                                }
                            } catch (_: Exception) {}
                        }
                        true
                    } else {
                        val rootReq = Request.Builder().url(cleanBase).build()
                        val rootResp = client.newCall(rootReq).execute()
                        rootResp.isSuccessful || rootResp.code < 500
                    }
                } catch (_: Exception) {
                    try {
                        val client = getUnsafeOkHttpClient()
                        val rootReq = Request.Builder().url(cleanBase).build()
                        val rootResp = client.newCall(rootReq).execute()
                        rootResp.isSuccessful || rootResp.code < 500
                    } catch (_: Exception) {
                        false
                    }
                }
            }

            if (isSuccess) {
                val headerNote = if (detectedIsp.isNotEmpty()) " [$detectedIsp]" else ""
                binding.tvConnectionStatus.text = "Status:  ONLINE$headerNote"
                binding.tvConnectionStatus.setTextColor(Color.parseColor("#10B981"))
            } else {
                binding.tvConnectionStatus.text = "Status:  OFFLINE / Menunggu Jaringan (Cek URL/Koneksi)"
                binding.tvConnectionStatus.setTextColor(Color.parseColor("#EF4444"))
            }
        }
    }

    private fun updatePreviewUrl() {
        val rawUrl = binding.etServerUrl.text.toString().trim()
        val base = if (rawUrl.isEmpty()) "https://app.alijaya.com" else rawUrl

        val path = when (binding.rgPortalType.checkedRadioButtonId) {
            binding.rbAgent.id -> "/agent/login"
            binding.rbTech.id -> "/tech/login"
            binding.rbAdmin.id -> "/admin/login"
            binding.rbCollector.id -> "/collector/login"
            else -> "/customer/login"
        }

        binding.tvPreviewUrl.text = "Target: $base$path"
    }

    private fun launchQrScanner() {
        val options = ScanOptions().apply {
            setDesiredBarcodeFormats(ScanOptions.QR_CODE)
            setPrompt("Arahkan kamera ke QR Code pada stiker modem ONU")
            setCameraId(0)
            setBeepEnabled(true)
            setBarcodeImageEnabled(false)
            setOrientationLocked(false)
        }
        qrScanLauncher.launch(options)
    }

    private fun handleQrCodeResult(raw: String) {
        val str = raw.trim()
        if (str.isEmpty()) return

        var targetUrl = ""
        var customerId: String? = null

        try {
            if (str.startsWith("{") && str.endsWith("}")) {
                val json = JSONObject(str)
                targetUrl = json.optString("url", json.optString("server", ""))
                customerId = json.optString("cid", json.optString("customerId", null))
            } else if (str.startsWith("http://", ignoreCase = true) || str.startsWith("https://", ignoreCase = true)) {
                val uri = Uri.parse(str)
                val scheme = uri.scheme ?: "http"
                val host = uri.host ?: ""
                val port = uri.port
                targetUrl = if (port != -1 && port != 80 && port != 443) {
                    "$scheme://$host:$port"
                } else {
                    "$scheme://$host"
                }
                customerId = uri.getQueryParameter("cid")
            } else {
                targetUrl = if (str.contains("://")) str else "http://$str"
            }
        } catch (e: Exception) {
            targetUrl = str
        }

        if (targetUrl.isNotBlank()) {
            val cleanUrl = targetUrl.trimEnd('/')
            binding.etServerUrl.setText(cleanUrl)
            updatePreviewUrl()
            Toast.makeText(this, "QR Code terdeteksi. Menghubungkan ke $cleanUrl...", Toast.LENGTH_SHORT).show()
            testConnectionAndProceed(cleanUrl, customerId)
        } else {
            Toast.makeText(this, "QR Code tidak valid: $str", Toast.LENGTH_LONG).show()
        }
    }

    private fun testConnectionAndProceed(baseUrl: String, customerId: String?) {
        binding.tvConnectionStatus.text = "Status: Menguji koneksi ke $baseUrl..."
        binding.tvConnectionStatus.setTextColor(Color.parseColor("#38BDF8"))

        val cleanBase = if (baseUrl.startsWith("http://") || baseUrl.startsWith("https://")) baseUrl else "https://$baseUrl"
        val pingUrl = "$cleanBase/api/customer/ping"

        lifecycleScope.launch {
            var detectedIsp = ""
            val isSuccess = withContext(Dispatchers.IO) {
                try {
                    val client = getUnsafeOkHttpClient()
                    val request = Request.Builder().url(pingUrl).build()
                    val response = client.newCall(request).execute()
                    if (response.isSuccessful) {
                        val str = response.body?.string()
                        if (!str.isNullOrBlank()) {
                            try {
                                val json = JSONObject(str)
                                detectedIsp = json.optString("companyHeader", json.optString("ispName", json.optString("appName", "")))
                                if (detectedIsp.isNotBlank()) {
                                    CustomerApplication.sessionManager.saveIspName(detectedIsp)
                                }
                                val phone = json.optString("companyPhone", json.optString("adminPhone", ""))
                                if (phone.isNotBlank()) {
                                    CustomerApplication.sessionManager.saveAdminPhone(phone)
                                }
                            } catch (_: Exception) {}
                        }
                        true
                    } else {
                        val rootReq = Request.Builder().url(cleanBase).build()
                        val rootResp = client.newCall(rootReq).execute()
                        rootResp.isSuccessful || rootResp.code < 500
                    }
                } catch (_: Exception) {
                    try {
                        val client = getUnsafeOkHttpClient()
                        val rootReq = Request.Builder().url(cleanBase).build()
                        val rootResp = client.newCall(rootReq).execute()
                        rootResp.isSuccessful || rootResp.code < 500
                    } catch (_: Exception) {
                        false
                    }
                }
            }

            if (isSuccess) {
                val displayName = if (detectedIsp.isNotBlank()) detectedIsp else "Server"
                binding.tvConnectionStatus.text = "Status: Terhubung ke $displayName"
                binding.tvConnectionStatus.setTextColor(Color.parseColor("#10B981"))

                // Simpan konfigurasi
                val session = CustomerApplication.sessionManager
                session.saveServerBaseUrl(cleanBase)
                if (detectedIsp.isNotBlank()) {
                    session.saveIspName(detectedIsp)
                }
                session.setFirstTimeSetup(false)

                Toast.makeText(this@ServerConfigActivity, "Berhasil terhubung ke $displayName!", Toast.LENGTH_SHORT).show()

                // Buka LoginActivity
                val intent = Intent(this@ServerConfigActivity, LoginActivity::class.java).apply {
                    if (!customerId.isNullOrBlank()) {
                        putExtra("PREFILL_ID", customerId)
                    }
                }
                startActivity(intent)
                finish()
            } else {
                binding.tvConnectionStatus.text = "Status: Gagal menghubungi server"
                binding.tvConnectionStatus.setTextColor(Color.parseColor("#EF4444"))
                Toast.makeText(this@ServerConfigActivity, "Server tidak dapat dijangkau. Periksa koneksi internet Anda.", Toast.LENGTH_LONG).show()
            }
        }
    }
}
