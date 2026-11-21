package net.alijaya.nocdisplay.ui

import android.app.Dialog
import android.content.Context
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.os.Bundle
import android.view.View
import android.view.Window
import android.view.WindowManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import net.alijaya.nocdisplay.databinding.DialogSettingsBinding
import net.alijaya.nocdisplay.mikrotik.MikrotikRepository
import net.alijaya.nocdisplay.settings.AppSettings
import net.alijaya.nocdisplay.ui.theme.ThemeMode

class SettingsDialog(
    context: Context,
    private val settings: AppSettings,
    private val repository: MikrotikRepository,
    private val onConfigChanged: (themeChanged: Boolean) -> Unit
) : Dialog(context) {

    private lateinit var binding: DialogSettingsBinding
    private var selectedTheme: ThemeMode = settings.themeMode

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        requestWindowFeature(Window.FEATURE_NO_TITLE)
        binding = DialogSettingsBinding.inflate(layoutInflater)
        setContentView(binding.root)

        window?.apply {
            setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
            setLayout(
                (context.resources.displayMetrics.widthPixels * 0.75).toInt(),
                WindowManager.LayoutParams.WRAP_CONTENT
            )
        }

        loadCurrentValues()
        setupListeners()
    }

    private fun loadCurrentValues() {
        binding.etHost.setText(settings.host)
        binding.etPort.setText(settings.port.toString())
        binding.etUsername.setText(settings.username)
        binding.etPassword.setText(settings.password)
        binding.etWan.setText(settings.wanInterface)
        binding.etInterval.setText((settings.refreshIntervalMs / 1000).toString())
        binding.cbAutoBoot.isChecked = settings.autoStartOnBoot
        selectedTheme = settings.themeMode
        highlightThemeButton()
    }

    private fun setupListeners() {
        binding.btnThemeCyberpunk.setOnClickListener {
            selectedTheme = ThemeMode.CYBERPUNK_NEON
            highlightThemeButton()
        }
        binding.btnThemeMatrix.setOnClickListener {
            selectedTheme = ThemeMode.EMERALD_MATRIX
            highlightThemeButton()
        }
        binding.btnThemeSapphire.setOnClickListener {
            selectedTheme = ThemeMode.SAPPHIRE_BLUE
            highlightThemeButton()
        }
        binding.btnThemeAmoled.setOnClickListener {
            selectedTheme = ThemeMode.AMOLED_DARK
            highlightThemeButton()
        }
        binding.btnThemeAmber.setOnClickListener {
            selectedTheme = ThemeMode.AMBER_SUNSET
            highlightThemeButton()
        }

        binding.btnTestConn.setOnClickListener {
            val host = binding.etHost.text.toString().trim()
            val port = binding.etPort.text.toString().trim().toIntOrNull() ?: 8728
            val user = binding.etUsername.text.toString().trim()
            val pass = binding.etPassword.text.toString()

            binding.tvTestStatus.visibility = View.VISIBLE
            binding.tvTestStatus.setTextColor(Color.parseColor("#00F2FE"))
            binding.tvTestStatus.text = "Menguji koneksi ke $host:$port..."

            CoroutineScope(Dispatchers.Main).launch {
                val (success, message) = repository.testConnection(host, port, user, pass)
                if (success) {
                    binding.tvTestStatus.setTextColor(Color.parseColor("#10B981"))
                    binding.tvTestStatus.text = "✓ $message"
                } else {
                    binding.tvTestStatus.setTextColor(Color.parseColor("#EF4444"))
                    binding.tvTestStatus.text = "✗ $message"
                }
            }
        }

        binding.btnSave.setOnClickListener {
            val oldTheme = settings.themeMode
            settings.host = binding.etHost.text.toString().trim()
            settings.port = binding.etPort.text.toString().trim().toIntOrNull() ?: 8728
            settings.username = binding.etUsername.text.toString().trim()
            settings.password = binding.etPassword.text.toString()
            settings.wanInterface = binding.etWan.text.toString().trim()
            val sec = binding.etInterval.text.toString().trim().toLongOrNull() ?: 2L
            settings.refreshIntervalMs = (sec.coerceAtLeast(1L)) * 1000L
            settings.themeMode = selectedTheme
            settings.autoStartOnBoot = binding.cbAutoBoot.isChecked

            onConfigChanged(oldTheme != selectedTheme)
            dismiss()
        }

        binding.btnClose.setOnClickListener {
            dismiss()
        }
    }

    private fun highlightThemeButton() {
        val activeAlpha = 1.0f
        val inactiveAlpha = 0.5f

        binding.btnThemeCyberpunk.alpha = if (selectedTheme == ThemeMode.CYBERPUNK_NEON) activeAlpha else inactiveAlpha
        binding.btnThemeMatrix.alpha = if (selectedTheme == ThemeMode.EMERALD_MATRIX) activeAlpha else inactiveAlpha
        binding.btnThemeSapphire.alpha = if (selectedTheme == ThemeMode.SAPPHIRE_BLUE) activeAlpha else inactiveAlpha
        binding.btnThemeAmoled.alpha = if (selectedTheme == ThemeMode.AMOLED_DARK) activeAlpha else inactiveAlpha
        binding.btnThemeAmber.alpha = if (selectedTheme == ThemeMode.AMBER_SUNSET) activeAlpha else inactiveAlpha
    }
}
