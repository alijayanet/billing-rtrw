package com.alijaya.customer.ui.main

import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.net.http.SslError
import android.os.Bundle
import android.os.Environment
import android.view.KeyEvent
import android.view.View
import android.webkit.*
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.alijaya.customer.CustomerApplication
import com.alijaya.customer.bridge.AndroidBluetoothBridge
import com.alijaya.customer.data.pref.SessionManager
import com.alijaya.customer.databinding.ActivityMainBinding
import com.alijaya.customer.ui.admin.AdminAllMenusFragment
import com.alijaya.customer.ui.admin.AdminBillingFragment
import com.alijaya.customer.ui.admin.AdminCustomersFragment
import com.alijaya.customer.ui.admin.AdminHomeFragment
import com.alijaya.customer.ui.admin.AdminPaidHistoryFragment
import com.alijaya.customer.ui.agent.AgentBillingFragment
import com.alijaya.customer.ui.agent.AgentHistoryFragment
import com.alijaya.customer.ui.agent.AgentHomeFragment
import com.alijaya.customer.ui.agent.AgentPulsaFragment
import com.alijaya.customer.ui.collector.CollectorAttendanceFragment
import com.alijaya.customer.ui.collector.CollectorHistoryFragment
import com.alijaya.customer.ui.collector.CollectorHomeFragment
import com.alijaya.customer.ui.collector.CollectorMapFragment
import com.alijaya.customer.ui.home.CustomerPpobFragment
import com.alijaya.customer.ui.home.HomeFragment
import com.alijaya.customer.ui.invoices.InvoicesFragment
import com.alijaya.customer.ui.login.LoginActivity
import com.alijaya.customer.ui.profile.ProfileFragment
import com.alijaya.customer.ui.server.ServerConfigActivity
import com.alijaya.customer.ui.tech.TechAttendanceFragment
import com.alijaya.customer.ui.tech.TechCreateCustomerFragment
import com.alijaya.customer.ui.tech.TechHomeFragment
import com.alijaya.customer.ui.tech.TechMikrotikFragment
import com.alijaya.customer.ui.tech.TechProfileFragment
import com.alijaya.customer.ui.tech.TechTr069Fragment
import com.alijaya.customer.ui.tickets.TicketsFragment
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class MainActivity : AppCompatActivity() {
    private lateinit var binding: ActivityMainBinding
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null
    private var lastLoadedUrl: String = ""
    private var currentTabIsNative: Boolean = true

    private val filePickerLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == RESULT_OK) {
            val data = result.data
            val results: Array<Uri>? = when {
                data?.data != null -> arrayOf(data.data!!)
                data?.clipData != null -> {
                    val clipData = data.clipData!!
                    Array(clipData.itemCount) { i -> clipData.getItemAt(i).uri }
                }
                else -> null
            }
            fileChooserCallback?.onReceiveValue(results)
        } else {
            fileChooserCallback?.onReceiveValue(null)
        }
        fileChooserCallback = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        val session = CustomerApplication.sessionManager
        if (!session.isLoggedIn()) {
            startActivity(Intent(this, LoginActivity::class.java))
            finish()
            return
        }

        setupTopBar()
        setupWebView()
        setupSwipeRefresh()
        setupNavigationMode()
        setupErrorView()
    }

    private fun setupTopBar() {
        val session = CustomerApplication.sessionManager
        binding.tvTopIspName.text = session.getIspName()
        binding.tvTopRoleBadge.text = session.getPortalDisplayName()

        // Printer status
        if (session.getPrinterMac().isNotEmpty()) {
            binding.btnPrinterStatus.setColorFilter(Color.parseColor("#10B981"))
            binding.btnPrinterStatus.contentDescription = "Printer: " + session.getPrinterName()
        } else {
            binding.btnPrinterStatus.setColorFilter(Color.parseColor("#94A3B8"))
        }

        binding.btnPrinterStatus.setOnClickListener {
            startActivity(Intent(this, ServerConfigActivity::class.java))
        }

        binding.btnServerSetting.setOnClickListener {
            startActivity(Intent(this, ServerConfigActivity::class.java))
        }

        binding.btnTopLogout.setOnClickListener {
            androidx.appcompat.app.AlertDialog.Builder(this)
                .setTitle("🚪 Konfirmasi Keluar")
                .setMessage("Apakah Anda yakin ingin keluar (logout) dari akun " + session.getPortalDisplayName() + "?")
                .setPositiveButton("Ya, Keluar") { _, _ ->
                    session.logout()
                    val intent = Intent(this, com.alijaya.customer.ui.login.LoginActivity::class.java).apply {
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
                    }
                    startActivity(intent)
                    finish()
                }
                .setNegativeButton("Batal", null)
                .show()
        }

        fetchServerHeader()
    }

    private fun fetchServerHeader() {
        val session = CustomerApplication.sessionManager
        val base = session.getServerBaseUrl().removeSuffix("/")
        val pingUrl = "$base/api/customer/ping"

        lifecycleScope.launch(Dispatchers.IO) {
            try {
                val client = OkHttpClient.Builder()
                    .connectTimeout(5, TimeUnit.SECONDS)
                    .readTimeout(5, TimeUnit.SECONDS)
                    .build()
                val req = Request.Builder().url(pingUrl).build()
                val resp = client.newCall(req).execute()
                if (resp.isSuccessful) {
                    val str = resp.body?.string()
                    if (!str.isNullOrBlank()) {
                        val json = JSONObject(str)
                        val name = json.optString("companyHeader", json.optString("ispName", json.optString("appName", "")))
                        if (name.isNotBlank()) {
                            session.saveIspName(name)
                            withContext(Dispatchers.Main) {
                                binding.tvTopIspName.text = name
                            }
                        }
                        val phone = json.optString("companyPhone", json.optString("adminPhone", ""))
                        if (phone.isNotBlank()) {
                            session.saveAdminPhone(phone)
                        }
                    }
                }
            } catch (_: Exception) {}
        }
    }

    private fun setupNavigationMode() {
        val session = CustomerApplication.sessionManager

        when (session.getPortalType()) {
            SessionManager.PORTAL_AGENT -> {
                binding.navIcon1.setImageResource(com.alijaya.customer.R.drawable.ic_nav_ticket)
                binding.navText1.text = "Voucher"
                binding.navIcon2.setImageResource(com.alijaya.customer.R.drawable.ic_nav_phone)
                binding.navText2.text = "Pulsa"
                binding.navIcon3.setImageResource(com.alijaya.customer.R.drawable.ic_nav_bill)
                binding.navText3.text = "Tagihan"
                binding.navIcon4.setImageResource(com.alijaya.customer.R.drawable.ic_nav_history)
                binding.navText4.text = "Riwayat"
                binding.navIcon5.setImageResource(com.alijaya.customer.R.drawable.ic_nav_user)
                binding.navText5.text = "Profil"

                binding.navItem1.setOnClickListener { showNativeFragment(0, AgentHomeFragment()) }
                binding.navItem2.setOnClickListener { showNativeFragment(1, AgentPulsaFragment()) }
                binding.navItem3.setOnClickListener { showNativeFragment(2, AgentBillingFragment()) }
                binding.navItem4.setOnClickListener { showNativeFragment(3, AgentHistoryFragment()) }
                binding.navItem5.setOnClickListener { showNativeFragment(4, ProfileFragment()) }

                showNativeFragment(0, AgentHomeFragment())
            }
            SessionManager.PORTAL_ADMIN -> {
                binding.navIcon1.setImageResource(com.alijaya.customer.R.drawable.ic_nav_dashboard)
                binding.navText1.text = "Dashboard"
                binding.navIcon2.setImageResource(com.alijaya.customer.R.drawable.ic_nav_users)
                binding.navText2.text = "Pelanggan"
                binding.navIcon3.setImageResource(com.alijaya.customer.R.drawable.ic_nav_bill)
                binding.navText3.text = "Billing"
                binding.navIcon4.setImageResource(com.alijaya.customer.R.drawable.ic_nav_history)
                binding.navText4.text = "Riwayat"
                binding.navIcon5.setImageResource(com.alijaya.customer.R.drawable.ic_nav_menu)
                binding.navText5.text = "Semua Menu"

                binding.navItem1.setOnClickListener { showNativeFragment(0, AdminHomeFragment()) }
                binding.navItem2.setOnClickListener { showNativeFragment(1, AdminCustomersFragment()) }
                binding.navItem3.setOnClickListener { showNativeFragment(2, AdminBillingFragment()) }
                binding.navItem4.setOnClickListener { showNativeFragment(3, AdminPaidHistoryFragment()) }
                binding.navItem5.setOnClickListener { showNativeFragment(4, AdminAllMenusFragment()) }

                showNativeFragment(0, AdminHomeFragment())
            }
            SessionManager.PORTAL_TECH -> {
                binding.navIcon1.setImageResource(com.alijaya.customer.R.drawable.ic_nav_dashboard)
                binding.navText1.text = "SPK Tugas"
                binding.navIcon2.setImageResource(com.alijaya.customer.R.drawable.ic_nav_add)
                binding.navText2.text = "Pasang Baru"
                binding.navIcon3.setImageResource(com.alijaya.customer.R.drawable.ic_nav_users)
                binding.navText3.text = "MikroTik"
                binding.navIcon4.setImageResource(com.alijaya.customer.R.drawable.ic_nav_help)
                binding.navText4.text = "TR-069 ONU"
                binding.navIcon5.setImageResource(com.alijaya.customer.R.drawable.ic_nav_attendance)
                binding.navText5.text = "Absensi"

                binding.navItem1.setOnClickListener { showNativeFragment(0, TechHomeFragment()) }
                binding.navItem2.setOnClickListener { showNativeFragment(1, TechCreateCustomerFragment()) }
                binding.navItem3.setOnClickListener { showNativeFragment(2, TechMikrotikFragment()) }
                binding.navItem4.setOnClickListener { showNativeFragment(3, TechTr069Fragment()) }
                binding.navItem5.setOnClickListener { showNativeFragment(4, TechAttendanceFragment()) }

                showNativeFragment(0, TechHomeFragment())
            }
            SessionManager.PORTAL_COLLECTOR -> {
                binding.navIcon1.setImageResource(com.alijaya.customer.R.drawable.ic_nav_bill)
                binding.navText1.text = "Tagihan"
                binding.navIcon2.setImageResource(com.alijaya.customer.R.drawable.ic_nav_history)
                binding.navText2.text = "Setoran"
                binding.navIcon3.setImageResource(com.alijaya.customer.R.drawable.ic_nav_map)
                binding.navText3.text = "Rute Peta"
                binding.navIcon4.setImageResource(com.alijaya.customer.R.drawable.ic_nav_attendance)
                binding.navText4.text = "Absensi"
                binding.navIcon5.setImageResource(com.alijaya.customer.R.drawable.ic_nav_user)
                binding.navText5.text = "Profil"

                binding.navItem1.setOnClickListener { showNativeFragment(0, CollectorHomeFragment()) }
                binding.navItem2.setOnClickListener { showNativeFragment(1, CollectorHistoryFragment()) }
                binding.navItem3.setOnClickListener { showNativeFragment(2, CollectorMapFragment()) }
                binding.navItem4.setOnClickListener { showNativeFragment(3, CollectorAttendanceFragment()) }
                binding.navItem5.setOnClickListener { showNativeFragment(4, TechProfileFragment()) }

                showNativeFragment(0, CollectorHomeFragment())
            }
            else -> {
                // Pelanggan (100% Pure Native)
                binding.navIcon1.setImageResource(com.alijaya.customer.R.drawable.ic_nav_home)
                binding.navText1.text = "Beranda"
                binding.navIcon2.setImageResource(com.alijaya.customer.R.drawable.ic_nav_bill)
                binding.navText2.text = "Tagihan"
                binding.navIcon3.setImageResource(com.alijaya.customer.R.drawable.ic_nav_phone)
                binding.navText3.text = "Beli Pulsa"
                binding.navIcon4.setImageResource(com.alijaya.customer.R.drawable.ic_nav_help)
                binding.navText4.text = "Bantuan"
                binding.navIcon5.setImageResource(com.alijaya.customer.R.drawable.ic_nav_user)
                binding.navText5.text = "Profil"

                binding.navItem1.setOnClickListener { showNativeFragment(0, HomeFragment()) }
                binding.navItem2.setOnClickListener { showNativeFragment(1, InvoicesFragment()) }
                binding.navItem3.setOnClickListener { showNativeFragment(2, CustomerPpobFragment()) }
                binding.navItem4.setOnClickListener { showNativeFragment(3, TicketsFragment()) }
                binding.navItem5.setOnClickListener { showNativeFragment(4, ProfileFragment()) }

                showNativeFragment(0, HomeFragment())
            }
        }
    }

    private fun showNativeFragment(idx: Int, fragment: Fragment) {
        currentTabIsNative = true
        highlightTab(idx)
        binding.fragmentContainer.visibility = View.VISIBLE
        binding.swipeRefresh.visibility = View.GONE
        supportFragmentManager.beginTransaction()
            .replace(binding.fragmentContainer.id, fragment)
            .commit()
    }

    private fun showWebPage(idx: Int, url: String) {
        currentTabIsNative = false
        highlightTab(idx)
        binding.fragmentContainer.visibility = View.GONE
        binding.swipeRefresh.visibility = View.VISIBLE
        navigateTo(url)
    }

    private fun highlightTab(selectedIdx: Int) {
        val texts = listOf(binding.navText1, binding.navText2, binding.navText3, binding.navText4, binding.navText5)
        val icons = listOf(binding.navIcon1, binding.navIcon2, binding.navIcon3, binding.navIcon4, binding.navIcon5)
        for (i in texts.indices) {
            val isSelected = i == selectedIdx
            val color = androidx.core.content.ContextCompat.getColor(
                this,
                if (isSelected) com.alijaya.customer.R.color.accent else com.alijaya.customer.R.color.text_muted
            )
            texts[i].setTextColor(color)
            texts[i].setTypeface(null, if (isSelected) android.graphics.Typeface.BOLD else android.graphics.Typeface.NORMAL)
            icons[i].setColorFilter(color)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        val webView = binding.webView
        val settings = webView.settings

        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.allowFileAccess = true
        settings.allowContentAccess = true
        settings.setSupportZoom(true)
        settings.builtInZoomControls = false
        settings.displayZoomControls = false
        settings.useWideViewPort = true
        settings.loadWithOverviewMode = true
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        settings.cacheMode = WebSettings.LOAD_DEFAULT
        settings.userAgentString = settings.userAgentString + " AlijayaSuperApp/2.0 (Android Native App)"

        // Add Bluetooth ESC/POS Bridge
        webView.addJavascriptInterface(AndroidBluetoothBridge(this), "AndroidPrinter")

        // Enable Cookies
        val cookieManager = CookieManager.getInstance()
        cookieManager.setAcceptCookie(true)
        cookieManager.setAcceptThirdPartyCookies(webView, true)

        webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
                super.onPageStarted(view, url, favicon)
                binding.progressBar.visibility = View.VISIBLE
                binding.layoutError.visibility = View.GONE
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                binding.progressBar.visibility = View.GONE
                binding.swipeRefresh.isRefreshing = false
            }

            override fun onReceivedSslError(view: WebView?, handler: SslErrorHandler?, error: SslError?) {
                handler?.cancel()
                binding.progressBar.visibility = View.GONE
                binding.swipeRefresh.isRefreshing = false
                showErrorView("Koneksi SSL tidak valid atau tidak aman")
            }

            override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
                super.onReceivedError(view, request, error)
                if (request?.isForMainFrame == true) {
                    binding.progressBar.visibility = View.GONE
                    binding.swipeRefresh.isRefreshing = false
                    showErrorView(error?.description?.toString() ?: "Gagal terhubung ke server")
                }
            }

            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val url = request?.url?.toString() ?: return false

                if (url.startsWith("whatsapp:") || url.startsWith("intent:") || 
                    url.startsWith("tel:") || url.startsWith("mailto:") || 
                    url.startsWith("market:") || url.contains("wa.me") ||
                    url.startsWith("gojek:") || url.startsWith("shopeepay:") || url.startsWith("dana:") ||
                    url.startsWith("geo:")) {
                    try {
                        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
                        startActivity(intent)
                        return true
                    } catch (_: Exception) {
                        try {
                            if (url.startsWith("intent:")) {
                                val parsedIntent = Intent.parseUri(url, Intent.URI_INTENT_SCHEME)
                                val fallbackUrl = parsedIntent.getStringExtra("browser_fallback_url")
                                if (!fallbackUrl.isNullOrEmpty()) {
                                    view?.loadUrl(fallbackUrl)
                                    return true
                                }
                            }
                        } catch (_: Exception) {}
                        Toast.makeText(this@MainActivity, "Aplikasi pendukung tidak ditemukan", Toast.LENGTH_SHORT).show()
                        return true
                    }
                }

                return false
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                if (newProgress < 100) {
                    binding.progressBar.visibility = View.VISIBLE
                    binding.progressBar.progress = newProgress
                } else {
                    binding.progressBar.visibility = View.GONE
                }
            }

            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                fileChooserCallback?.onReceiveValue(null)
                fileChooserCallback = filePathCallback

                val intent = fileChooserParams?.createIntent() ?: Intent(Intent.ACTION_GET_CONTENT).apply {
                    type = "*/*"
                }
                try {
                    filePickerLauncher.launch(intent)
                } catch (_: Exception) {
                    fileChooserCallback = null
                    Toast.makeText(this@MainActivity, "Gagal membuka pemilih berkas", Toast.LENGTH_SHORT).show()
                    return false
                }
                return true
            }
        }

        webView.setDownloadListener { url, userAgent, contentDisposition, mimetype, _ ->
            try {
                val request = DownloadManager.Request(Uri.parse(url))
                request.setMimeType(mimetype)
                request.addRequestHeader("User-Agent", userAgent)
                request.setDescription("Mengunduh berkas...")
                val filename = URLUtil.guessFileName(url, contentDisposition, mimetype)
                request.setTitle(filename)
                request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, filename)

                val dm = getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
                dm.enqueue(request)
                Toast.makeText(this, "Mengunduh $filename...", Toast.LENGTH_LONG).show()
            } catch (_: Exception) {
                try {
                    startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                } catch (_: Exception) {
                    Toast.makeText(this, "Gagal mengunduh berkas", Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    private fun navigateTo(url: String) {
        lastLoadedUrl = url
        binding.webView.loadUrl(url)
    }

    private fun setupSwipeRefresh() {
        binding.swipeRefresh.setOnRefreshListener {
            binding.webView.reload()
        }
    }

    private fun setupErrorView() {
        binding.btnRetry.setOnClickListener {
            binding.layoutError.visibility = View.GONE
            if (lastLoadedUrl.isNotEmpty()) {
                binding.webView.loadUrl(lastLoadedUrl)
            }
        }
        binding.btnErrorConfig.setOnClickListener {
            startActivity(Intent(this, ServerConfigActivity::class.java))
        }
    }

    private fun showErrorView(msg: String) {
        binding.layoutError.visibility = View.VISIBLE
        binding.tvErrorMessage.text = msg
        binding.tvErrorUrl.text = "URL: " + lastLoadedUrl
    }

    override fun onResume() {
        super.onResume()
        setupTopBar()
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (!currentTabIsNative && keyCode == KeyEvent.KEYCODE_BACK && binding.webView.canGoBack()) {
            binding.webView.goBack()
            return true
        }
        return super.onKeyDown(keyCode, event)
    }
}
