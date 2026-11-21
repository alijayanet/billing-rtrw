package net.alijaya.nocdisplay.ui

import android.app.Dialog
import android.content.Context
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.os.Bundle
import android.view.View
import android.view.Window
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
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
                (context.resources.displayMetrics.widthPixels * 0.85).toInt(),
                WindowManager.LayoutParams.WRAP_CONTENT
            )
            // Ensure dialog doesn't get covered by keyboard
            setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_PAN)
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
        // Auto-hide virtual keyboard when moving focus to buttons or checkbox
        val buttonsAndBox = listOf(
            binding.btnSave,
            binding.btnTestConn,
            binding.btnClose,
            binding.cbAutoBoot,
            binding.btnThemeCyberpunk,
            binding.btnThemeMatrix,
            binding.btnThemeSapphire,
            binding.btnThemeAmoled,
            binding.btnThemeAmber
        )
        for (view in buttonsAndBox) {
            view.setOnFocusChangeListener { _, hasFocus ->
                if (hasFocus) {
                    hideKeyboard()
                }
            }
        }

        // IME Action Done on last input fields moves focus to Save button
        binding.etInterval.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_DONE) {
                hideKeyboard()
                binding.btnSave.requestFocus()
                true
            } else false
        }

        binding.etPassword.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_DONE) {
                hideKeyboard()
                binding.btnSave.requestFocus()
                true
            } else false
        }

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
            hideKeyboard()
            val host = binding.etHost.text.toString().trim()
            val portStr = binding.etPort.text.toString().trim()
            val port = portStr.toIntOrNull()
            if (port == null || port !in 1..65535) {
                binding.tvTestStatus.visibility = View.VISIBLE
                binding.tvTestStatus.setTextColor(Color.parseColor("#EF4444"))
                binding.tvTestStatus.text = "Port tidak valid! Masukkan angka port 1 - 65535."
                return@setOnClickListener
            }
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
            hideKeyboard()
            val host = binding.etHost.text.toString().trim()
            val portStr = binding.etPort.text.toString().trim()
            val port = portStr.toIntOrNull()
            if (port == null || port !in 1..65535) {
                binding.tvTestStatus.visibility = View.VISIBLE
                binding.tvTestStatus.setTextColor(Color.parseColor("#EF4444"))
                binding.tvTestStatus.text = "Port tidak valid! Masukkan angka port 1 - 65535."
                return@setOnClickListener
            }

            val oldTheme = settings.themeMode
            settings.host = host
            settings.port = port
            settings.username = binding.etUsername.text.toString().trim()
            settings.password = binding.etPassword.text.toString()
            settings.wanInterface = binding.etWan.text.toString().trim()
            val sec = binding.etInterval.text.toString().trim().toLongOrNull() ?: 2L
            settings.refreshIntervalMs = (sec.coerceAtLeast(1L)) * 1000L
            settings.themeMode = selectedTheme
            settings.autoStartOnBoot = binding.cbAutoBoot.isChecked

            android.widget.Toast.makeText(
                context,
                "Pengaturan tersimpan: $host:$port",
                android.widget.Toast.LENGTH_SHORT
            ).show()

            onConfigChanged(oldTheme != selectedTheme)
            dismiss()
        }

        binding.btnClose.setOnClickListener {
            hideKeyboard()
            dismiss()
        }
    }

    private fun hideKeyboard() {
        val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
        val view = currentFocus ?: binding.root
        imm?.hideSoftInputFromWindow(view.windowToken, 0)
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
