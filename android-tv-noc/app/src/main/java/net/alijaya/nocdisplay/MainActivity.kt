package net.alijaya.nocdisplay

import android.graphics.Color
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import net.alijaya.nocdisplay.databinding.ActivityMainBinding
import net.alijaya.nocdisplay.mikrotik.MikrotikRepository
import net.alijaya.nocdisplay.model.NocSnapshot
import net.alijaya.nocdisplay.settings.AppSettings
import net.alijaya.nocdisplay.ui.SettingsDialog
import net.alijaya.nocdisplay.ui.theme.NocTheme
import net.alijaya.nocdisplay.ui.theme.ThemeMode
import net.alijaya.nocdisplay.ui.views.InterfaceMatrixAdapter
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var appSettings: AppSettings
    private lateinit var repository: MikrotikRepository
    private lateinit var interfaceAdapter: InterfaceMatrixAdapter

    private var pollerJob: Job? = null
    private var clockJob: Job? = null
    private var retryJob: Job? = null
    private var hasWebError = false

    private val timeFormat = SimpleDateFormat("HH:mm:ss 'WIB'", Locale("id", "ID"))
    private val dateFormat = SimpleDateFormat("EEEE, dd MMM yyyy", Locale("id", "ID"))

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        hideSystemUI()

        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        appSettings = AppSettings(this)
        repository = MikrotikRepository(appSettings)

        setupUI()
        setupEngineMode()
    }

    override fun onResume() {
        super.onResume()
        hideSystemUI()
    }

    private fun hideSystemUI() {
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_FULLSCREEN
        )
    }

    private fun setupUI() {
        // Native UI setup
        interfaceAdapter = InterfaceMatrixAdapter()
        binding.rvInterfaces.apply {
            layoutManager = LinearLayoutManager(this@MainActivity, LinearLayoutManager.HORIZONTAL, false)
            adapter = interfaceAdapter
        }

        binding.btnOpenSettings.setOnClickListener {
            openSettingsDialog()
        }

        binding.btnQuickTheme.setOnClickListener {
            cycleTheme()
        }

        // Offline overlay buttons
        binding.btnRetryNow.setOnClickListener {
            loadNocWeb()
        }

        binding.btnSettingsFromOffline.setOnClickListener {
            openSettingsDialog()
        }

        // WebView configuration for TV Leanback
        setupWebView()
    }

    private fun setupWebView() {
        binding.webViewNoc.apply {
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                databaseEnabled = true
                useWideViewPort = true
                loadWithOverviewMode = true
                setSupportZoom(false)
                builtInZoomControls = false
                mediaPlaybackRequiresUserGesture = false
                cacheMode = WebSettings.LOAD_DEFAULT
                userAgentString = "AlijayaNocTV/1.1.0 (Android TV Leanback; Mobile Safari)"
            }
            setBackgroundColor(Color.parseColor("#050B14"))
            isFocusable = true
            isFocusableInTouchMode = true

            webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView?, url: String?) {
                    super.onPageFinished(view, url)
                    if (!hasWebError) {
                        binding.offlineOverlay.visibility = View.GONE
                        binding.webViewNoc.visibility = View.VISIBLE
                        cancelRetryTimer()
                    }
                }

                override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
                    super.onReceivedError(view, request, error)
                    if (request?.isForMainFrame == true) {
                        hasWebError = true
                        showOfflineOverlay(
                            title = "Koneksi ke Server NOC Terputus",
                            subtitle = "Target: ${appSettings.serverUrl}"
                        )
                        scheduleAutoRetry()
                    }
                }
            }

            webChromeClient = WebChromeClient()
        }
    }

    private fun setupEngineMode() {
        if (appSettings.useWebEngine) {
            // Mode 1: High-Performance Web Engine (Identik 100% noc.ejs)
            stopNativePoller()
            binding.nativeContainer.visibility = View.GONE
            loadNocWeb()
        } else {
            // Mode 2: Standalone Native Socket MikroTik
            binding.webViewNoc.visibility = View.GONE
            binding.offlineOverlay.visibility = View.GONE
            binding.nativeContainer.visibility = View.VISIBLE
            applyTheme(appSettings.themeMode)
            startClock()
            startTelemetryPoller()
        }
    }

    private fun loadNocWeb() {
        hasWebError = false
        cancelRetryTimer()
        val url = appSettings.serverUrl.ifEmpty { "http://192.168.8.8:3001/noc" }
        binding.offlineOverlay.visibility = View.GONE
        binding.webViewNoc.visibility = View.VISIBLE
        binding.webViewNoc.loadUrl(url)
    }

    private fun showOfflineOverlay(title: String, subtitle: String) {
        binding.webViewNoc.visibility = View.GONE
        binding.offlineOverlay.visibility = View.VISIBLE
        binding.tvOfflineTitle.text = title
        binding.tvOfflineSubtitle.text = subtitle
        binding.btnRetryNow.requestFocus()
    }

    private fun scheduleAutoRetry() {
        cancelRetryTimer()
        retryJob = lifecycleScope.launch {
            var seconds = 5
            while (isActive && seconds > 0) {
                binding.tvRetryCountdown.text = "Mencoba menghubungkan kembali dalam ${seconds}s..."
                delay(1000L)
                seconds--
            }
            if (isActive) {
                binding.tvRetryCountdown.text = "Sedang menghubungkan..."
                loadNocWeb()
            }
        }
    }

    private fun cancelRetryTimer() {
        retryJob?.cancel()
        retryJob = null
    }

    private fun openSettingsDialog() {
        val dialog = SettingsDialog(this, appSettings, repository) { configChanged ->
            if (configChanged) {
                setupEngineMode()
            }
        }
        dialog.show()
    }

    private fun cycleTheme() {
        if (appSettings.useWebEngine) {
            binding.webViewNoc.evaluateJavascript("if (typeof toggleTheme === 'function') toggleTheme();", null)
            return
        }
        val modes = ThemeMode.values()
        val nextIdx = (appSettings.themeMode.ordinal + 1) % modes.size
        val nextTheme = modes[nextIdx]
        appSettings.themeMode = nextTheme
        applyTheme(nextTheme)
        Toast.makeText(this, "Tema: ${nextTheme.title}", Toast.LENGTH_SHORT).show()
    }

    private fun applyTheme(mode: ThemeMode) {
        val palette = NocTheme.getPalette(mode)
        binding.rootContainer.setBackgroundColor(palette.bg)
        binding.tvAppTitle.setTextColor(palette.primaryRx)
        binding.btnQuickTheme.setTextColor(palette.primaryRx)

        binding.gaugeCpu.setThemeColors(
            primary = palette.primaryRx,
            secondary = palette.secondaryTx,
            track = palette.gaugeTrack,
            textPrimary = palette.textPrimary,
            textMuted = palette.textMuted
        )

        binding.gaugeRam.setThemeColors(
            primary = palette.secondaryTx,
            secondary = palette.primaryRx,
            track = palette.gaugeTrack,
            textPrimary = palette.textPrimary,
            textMuted = palette.textMuted
        )

        binding.waveChart.setThemeColors(
            rxColor = palette.primaryRx,
            txColor = palette.secondaryTx,
            gridColor = palette.gridLine,
            textPrimary = palette.textPrimary,
            textMuted = palette.textMuted
        )
    }

    private fun startClock() {
        clockJob?.cancel()
        clockJob = lifecycleScope.launch {
            while (isActive) {
                val now = Date()
                binding.tvDigitalClock.text = timeFormat.format(now)
                binding.tvDateDisplay.text = dateFormat.format(now)
                delay(1000L)
            }
        }
    }

    private fun startTelemetryPoller() {
        pollerJob?.cancel()
        pollerJob = lifecycleScope.launch {
            while (isActive) {
                val snapshot = repository.fetchSnapshot()
                withContext(Dispatchers.Main) {
                    renderSnapshot(snapshot)
                }
                delay(appSettings.refreshIntervalMs)
            }
        }
    }

    private fun stopNativePoller() {
        pollerJob?.cancel()
        pollerJob = null
        clockJob?.cancel()
        clockJob = null
        repository.close()
    }

    private fun renderSnapshot(s: NocSnapshot) {
        if (!s.isConnected) {
            binding.dotStatus.setBackgroundResource(R.drawable.shape_dot_red)
            binding.tvStatusText.setTextColor(Color.parseColor("#EF4444"))
            binding.tvStatusText.text = "OFFLINE (${s.routerIp})"
            binding.tvUptime.text = s.connectionError ?: "Koneksi terputus"
            return
        }

        binding.dotStatus.setBackgroundResource(R.drawable.shape_dot_green)
        binding.tvStatusText.setTextColor(Color.parseColor("#10B981"))
        binding.tvStatusText.text = "ONLINE (${s.routerIp})"

        val r = s.resource
        binding.tvRouterBoard.text = "${r.boardName} (v${r.version})"
        binding.tvUptime.text = "Uptime: ${r.uptime} • Cores: ${r.cpuCount} @ ${r.cpuFrequency}MHz"

        binding.tvKpiWanRx.text = String.format(Locale.US, "%.1f Mbps", s.wanRxMbps)
        binding.tvKpiWanTx.text = String.format(Locale.US, "%.1f Mbps", s.wanTxMbps)

        binding.tvKpiPppoe.text = "${s.pppoeCount} Sesi"
        binding.tvKpiHotspot.text = "${s.hotspotCount} User"

        val h = s.health
        binding.tvHealthTemp.text = if (h.temperature != null) "Temp: ${h.temperature.toInt()}°C" else "Temp: --"
        binding.tvHealthVolt.text = if (h.voltage != null) String.format(Locale.US, "Volt: %.1fV", h.voltage) else "Volt: --"

        val cpuPct = r.cpuLoad.coerceIn(0, 100)
        binding.gaugeCpu.setGaugeData(
            value = cpuPct.toFloat(),
            title = "CPU LOAD",
            subtitle = "$cpuPct%",
            max = 100f
        )

        val totalMb = r.totalMemory / (1024 * 1024)
        val freeMb = r.freeMemory / (1024 * 1024)
        val usedMb = (totalMb - freeMb).coerceAtLeast(0)
        val ramPct = if (totalMb > 0) ((usedMb.toDouble() / totalMb.toDouble()) * 100).toInt() else 0

        binding.gaugeRam.setGaugeData(
            value = ramPct.toFloat(),
            title = "RAM",
            subtitle = "$ramPct% ($usedMb/$totalMb MB)",
            max = 100f
        )

        binding.waveChart.addTrafficSample(s.wanRxMbps, s.wanTxMbps)
        interfaceAdapter.submitList(s.interfaces)
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        return when (keyCode) {
            KeyEvent.KEYCODE_MENU, KeyEvent.KEYCODE_SETTINGS -> {
                openSettingsDialog()
                true
            }
            KeyEvent.KEYCODE_0, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> {
                if (appSettings.useWebEngine) {
                    loadNocWeb()
                    Toast.makeText(this, "Memuat ulang NOC...", Toast.LENGTH_SHORT).show()
                } else {
                    startTelemetryPoller()
                }
                true
            }
            KeyEvent.KEYCODE_1 -> {
                if (appSettings.useWebEngine) {
                    binding.webViewNoc.evaluateJavascript("if (typeof switchTheme === 'function') switchTheme('cyberpunk');", null)
                } else {
                    appSettings.themeMode = ThemeMode.CYBERPUNK_NEON
                    applyTheme(ThemeMode.CYBERPUNK_NEON)
                }
                true
            }
            KeyEvent.KEYCODE_2 -> {
                if (appSettings.useWebEngine) {
                    binding.webViewNoc.evaluateJavascript("if (typeof switchTheme === 'function') switchTheme('matrix');", null)
                } else {
                    appSettings.themeMode = ThemeMode.EMERALD_MATRIX
                    applyTheme(ThemeMode.EMERALD_MATRIX)
                }
                true
            }
            KeyEvent.KEYCODE_3 -> {
                if (appSettings.useWebEngine) {
                    binding.webViewNoc.evaluateJavascript("if (typeof switchTheme === 'function') switchTheme('sapphire');", null)
                } else {
                    appSettings.themeMode = ThemeMode.SAPPHIRE_BLUE
                    applyTheme(ThemeMode.SAPPHIRE_BLUE)
                }
                true
            }
            KeyEvent.KEYCODE_4 -> {
                if (appSettings.useWebEngine) {
                    binding.webViewNoc.evaluateJavascript("if (typeof switchTheme === 'function') switchTheme('amoled');", null)
                } else {
                    appSettings.themeMode = ThemeMode.AMOLED_DARK
                    applyTheme(ThemeMode.AMOLED_DARK)
                }
                true
            }
            KeyEvent.KEYCODE_5 -> {
                if (appSettings.useWebEngine) {
                    binding.webViewNoc.evaluateJavascript("if (typeof switchTheme === 'function') switchTheme('amber');", null)
                } else {
                    appSettings.themeMode = ThemeMode.AMBER_SUNSET
                    applyTheme(ThemeMode.AMBER_SUNSET)
                }
                true
            }
            KeyEvent.KEYCODE_BACK -> {
                if (appSettings.useWebEngine && binding.webViewNoc.canGoBack()) {
                    binding.webViewNoc.goBack()
                    true
                } else {
                    super.onKeyDown(keyCode, event)
                }
            }
            else -> super.onKeyDown(keyCode, event)
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        stopNativePoller()
        cancelRetryTimer()
        binding.webViewNoc.destroy()
    }
}
