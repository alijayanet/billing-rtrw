package net.alijaya.nocdisplay

import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
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
    private lateinit var settings: AppSettings
    private lateinit var repository: MikrotikRepository
    private lateinit var interfaceAdapter: InterfaceMatrixAdapter

    private var pollerJob: Job? = null
    private var clockJob: Job? = null

    private val timeFormat = SimpleDateFormat("HH:mm:ss 'WIB'", Locale("id", "ID"))
    private val dateFormat = SimpleDateFormat("EEEE, dd MMM yyyy", Locale("id", "ID"))

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        hideSystemUI()

        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        settings = AppSettings(this)
        repository = MikrotikRepository(settings)

        setupUI()
        applyTheme(settings.themeMode)
        startClock()
        startTelemetryPoller()
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
    }

    private fun openSettingsDialog() {
        val dialog = SettingsDialog(this, settings, repository) { themeChanged ->
            if (themeChanged) {
                applyTheme(settings.themeMode)
            }
            restartTelemetryPoller()
        }
        dialog.show()
    }

    private fun cycleTheme() {
        val modes = ThemeMode.values()
        val nextIdx = (settings.themeMode.ordinal + 1) % modes.size
        val nextTheme = modes[nextIdx]
        settings.themeMode = nextTheme
        applyTheme(nextTheme)
        Toast.makeText(this, "Tema: ${nextTheme.title}", Toast.LENGTH_SHORT).show()
    }

    private fun applyTheme(mode: ThemeMode) {
        val palette = NocTheme.getPalette(mode)

        // Root Background
        binding.rootContainer.setBackgroundColor(palette.bg)

        // Title and subtitles
        binding.tvAppTitle.setTextColor(palette.primaryRx)
        binding.btnQuickTheme.setTextColor(palette.primaryRx)

        // Update Donut Gauges
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

        // Update Traffic Wave
        binding.waveChart.setThemeColors(
            rxColor = palette.primaryRx,
            txColor = palette.secondaryTx,
            gridColor = palette.gridLine,
            textPrimary = palette.textPrimary,
            textMuted = palette.textMuted
        )

        // Update KPI card text colors
        binding.tvKpiWanRx.setTextColor(palette.primaryRx)
        binding.tvKpiWanTx.setTextColor(palette.secondaryTx)

        // Update Cards Background and Border
        val cardViews = listOf(
            binding.cardWanRx,
            binding.cardWanTx,
            binding.cardPppoe,
            binding.cardHotspot,
            binding.cardHardware,
            binding.panelGauges,
            binding.panelWave,
            binding.panelInterfaces
        )

        for (cv in cardViews) {
            val bg = GradientDrawable().apply {
                setColor(palette.cardBg)
                setStroke(2, palette.cardBorder)
                cornerRadius = 16f
            }
            cv.background = bg
        }

        // Interface Adapter
        interfaceAdapter.setThemeColors(palette.primaryRx, palette.secondaryTx)
    }

    private fun startClock() {
        clockJob?.cancel()
        clockJob = lifecycleScope.launch(Dispatchers.Default) {
            while (isActive) {
                val now = Date()
                val timeStr = timeFormat.format(now)
                val dateStr = dateFormat.format(now)

                withContext(Dispatchers.Main) {
                    binding.tvDigitalClock.text = timeStr
                    binding.tvDateDisplay.text = dateStr
                }
                delay(1000)
            }
        }
    }

    private fun startTelemetryPoller() {
        pollerJob?.cancel()
        pollerJob = lifecycleScope.launch(Dispatchers.Default) {
            while (isActive) {
                val snapshot = repository.fetchSnapshot()
                withContext(Dispatchers.Main) {
                    updateUI(snapshot)
                }
                delay(settings.refreshIntervalMs)
            }
        }
    }

    private fun restartTelemetryPoller() {
        repository.close()
        startTelemetryPoller()
    }

    private fun updateUI(snapshot: NocSnapshot) {
        val palette = NocTheme.getPalette(settings.themeMode)

        if (snapshot.isConnected) {
            binding.dotStatus.setBackgroundResource(R.drawable.shape_dot_green)
            binding.tvStatusText.text = "ONLINE (${snapshot.routerIp}:${settings.port})"
            binding.tvStatusText.setTextColor(palette.secondaryTx)

            // KPI Cards
            binding.tvKpiWanRx.text = "${String.format("%.1f", snapshot.wanRxMbps)} Mbps"
            binding.tvKpiWanTx.text = "${String.format("%.1f", snapshot.wanTxMbps)} Mbps"
            binding.tvKpiPppoe.text = "${snapshot.pppoeCount} Sesi"
            binding.tvKpiHotspot.text = "${snapshot.hotspotCount} User"

            // Hardware info
            val res = snapshot.resource
            binding.tvRouterBoard.text = "${res.boardName} (v${res.version})"
            val tempStr = snapshot.health.temperature?.let { "Temp: ${it.toInt()}°C" } ?: "Temp: N/A"
            val voltStr = snapshot.health.voltage?.let { "Volt: ${String.format("%.1f", it)}V" } ?: "Volt: N/A"
            binding.tvHealthTemp.text = tempStr
            binding.tvHealthVolt.text = voltStr

            // Donut Gauges
            val cpuSubtitle = "${res.cpuCount} Cores @ ${res.cpuFrequency}MHz"
            binding.gaugeCpu.setGaugeData(res.cpuLoad.toFloat(), "CPU LOAD", cpuSubtitle, 100f)

            val ramSubtitle = "${res.usedMemoryMb} MB / ${res.totalMemoryMb} MB"
            binding.gaugeRam.setGaugeData(res.ramPercent.toFloat(), "RAM USAGE", ramSubtitle, 100f)

            // Wave Chart
            binding.waveChart.addTrafficSample(snapshot.wanRxMbps, snapshot.wanTxMbps)

            // Interfaces Matrix
            interfaceAdapter.submitList(snapshot.interfaces)

            // Uptime
            binding.tvUptime.text = "Uptime: ${res.uptime}"
        } else {
            binding.dotStatus.setBackgroundResource(R.drawable.shape_dot_red)
            val err = snapshot.connectionError ?: "Terputus"
            binding.tvStatusText.text = "OFFLINE (${settings.host}:${settings.port}): $err"
            binding.tvStatusText.setTextColor(Color.parseColor("#EF4444"))
        }
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        return when (keyCode) {
            KeyEvent.KEYCODE_MENU -> {
                openSettingsDialog()
                true
            }
            KeyEvent.KEYCODE_1 -> {
                settings.themeMode = ThemeMode.CYBERPUNK_NEON
                applyTheme(ThemeMode.CYBERPUNK_NEON)
                true
            }
            KeyEvent.KEYCODE_2 -> {
                settings.themeMode = ThemeMode.EMERALD_MATRIX
                applyTheme(ThemeMode.EMERALD_MATRIX)
                true
            }
            KeyEvent.KEYCODE_3 -> {
                settings.themeMode = ThemeMode.SAPPHIRE_BLUE
                applyTheme(ThemeMode.SAPPHIRE_BLUE)
                true
            }
            KeyEvent.KEYCODE_4 -> {
                settings.themeMode = ThemeMode.AMOLED_DARK
                applyTheme(ThemeMode.AMOLED_DARK)
                true
            }
            KeyEvent.KEYCODE_5 -> {
                settings.themeMode = ThemeMode.AMBER_SUNSET
                applyTheme(ThemeMode.AMBER_SUNSET)
                true
            }
            else -> super.onKeyDown(keyCode, event)
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        pollerJob?.cancel()
        clockJob?.cancel()
        repository.close()
    }
}
