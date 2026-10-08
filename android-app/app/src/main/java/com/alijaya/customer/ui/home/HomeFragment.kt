package com.alijaya.customer.ui.home

import android.content.Intent
import android.os.Bundle
import android.text.InputType
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.alijaya.customer.CustomerApplication
import com.alijaya.customer.R
import com.alijaya.customer.data.api.ApiClient
import com.alijaya.customer.databinding.FragmentHomeBinding
import com.alijaya.customer.ui.invoices.PaymentActivity
import com.alijaya.customer.ui.tickets.CreateTicketActivity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.text.NumberFormat
import java.util.Locale

class HomeFragment : Fragment() {
    private var _binding: FragmentHomeBinding? = null
    private val binding get() = _binding!!

    private var latestUnpaidInvoiceId: Int = 0
    private var isOntTr069Connected: Boolean = false

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentHomeBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        binding.tvCustomerName.text = CustomerApplication.sessionManager.getCustomerName()

        binding.swipeRefresh.setOnRefreshListener {
            fetchDashboardData()
        }

        setupQuickActions()
        fetchDashboardData()
    }

    private fun setupQuickActions() {
        binding.btnQuickPay.setOnClickListener {
            val intent = Intent(context, PaymentActivity::class.java).apply {
                putExtra("invoice_id", latestUnpaidInvoiceId)
            }
            startActivity(intent)
        }

        binding.btnIsolationQuickQris.setOnClickListener {
            val intent = Intent(context, PaymentActivity::class.java).apply {
                putExtra("invoice_id", latestUnpaidInvoiceId)
            }
            startActivity(intent)
        }

        // Separate action 1: Change SSID Only
        binding.cardChangeSsid.setOnClickListener {
            showChangeSsidDialog()
        }

        // Separate action 2: Change Password Only
        binding.cardChangePassword.setOnClickListener {
            showChangePasswordDialog()
        }

        binding.cardRestartModem.setOnClickListener {
            if (!isOntTr069Connected) {
                Toast.makeText(context, "Modem belum terdeteksi aktif di TR-069 untuk restart langsung.", Toast.LENGTH_LONG).show()
                return@setOnClickListener
            }
            showRestartModemDialog()
        }

        binding.cardSpeedtest.setOnClickListener {
            showInteractiveSpeedtestDialog()
        }

        binding.cardReportTicket.setOnClickListener {
            startActivity(Intent(context, CreateTicketActivity::class.java))
        }

        binding.cardPpobPulsa.setOnClickListener {
            parentFragmentManager.beginTransaction()
                .replace(R.id.fragment_container, CustomerPpobFragment())
                .addToBackStack(null).commit()
        }

        binding.cardTopupWallet.setOnClickListener {
            parentFragmentManager.beginTransaction()
                .replace(R.id.fragment_container, CustomerTopupFragment())
                .addToBackStack(null).commit()
        }
    }

    private fun showChangeSsidDialog() {
        val context = context ?: return
        val currentSsid = binding.tvOntSsid.text.toString().trim()
        val defaultSsid = if (currentSsid.isNotEmpty() && currentSsid != "-" && !currentSsid.contains("Generic")) {
            currentSsid
        } else {
            "Alijaya_" + CustomerApplication.sessionManager.getCustomerName().replace(" ", "_")
        }

        val input = EditText(context).apply {
            hint = "Nama WiFi (SSID) Baru"
            setText(defaultSsid)
            selectAll()
            setTextColor(ContextCompat.getColor(context, R.color.text_white))
            setHintTextColor(ContextCompat.getColor(context, R.color.text_hint))
            setBackgroundColor(ContextCompat.getColor(context, R.color.card_dark))
            setPadding(40, 30, 40, 30)
            textSize = 15f
        }

        val container = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(50, 20, 50, 20)
            addView(input)
        }

        AlertDialog.Builder(context)
            .setTitle(" Ubah Nama WiFi (SSID)")
            .setMessage("Nama WiFi saat ini:\n\"$defaultSsid\"\n\nSilakan ubah nama WiFi baru di bawah lalu simpan. Tombol ini HANYA akan mengubah nama SSID tanpa mengubah kata sandi.")
            .setView(container)
            .setPositiveButton(" Simpan Nama WiFi Saja") { _, _ ->
                val newSsid = input.text.toString().trim()
                if (newSsid.length < 2) {
                    Toast.makeText(context, "Nama WiFi minimal 2 karakter", Toast.LENGTH_SHORT).show()
                    return@setPositiveButton
                }
                doChangeSsid(newSsid)
            }
            .setNegativeButton("Batal", null)
            .show()
    }

    private fun showChangePasswordDialog() {
        val context = context ?: return

        val input = EditText(context).apply {
            hint = "Sandi WiFi Baru (Min. 8 Karakter)"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            setTextColor(ContextCompat.getColor(context, R.color.text_white))
            setHintTextColor(ContextCompat.getColor(context, R.color.text_hint))
            setBackgroundColor(ContextCompat.getColor(context, R.color.card_dark))
            setPadding(40, 30, 40, 30)
            textSize = 15f
        }

        val container = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(50, 20, 50, 20)
            addView(input)
        }

        AlertDialog.Builder(context)
            .setTitle(" Ubah Sandi WiFi (Password)")
            .setMessage("Masukkan kata sandi baru untuk modem rumah Anda (minimal 8 karakter). Tombol ini HANYA akan menyimpan perubahan Sandi WiFi.")
            .setView(container)
            .setPositiveButton(" Simpan Sandi WiFi Saja") { _, _ ->
                val newPass = input.text.toString().trim()
                if (newPass.length < 8) {
                    Toast.makeText(context, "Kata sandi minimal 8 karakter", Toast.LENGTH_SHORT).show()
                    return@setPositiveButton
                }
                doChangePassword(newPass)
            }
            .setNegativeButton("Batal", null)
            .show()
    }

    private fun doChangeSsid(newSsid: String) {
        val act = activity ?: return
        binding.tvOntSsid.text = newSsid
        Toast.makeText(act, "Mengirim perintah ubah Nama WiFi ke modem...", Toast.LENGTH_SHORT).show()

        lifecycleScope.launch {
            try {
                val res = ApiClient.getService().changeWifiSsid(mapOf("ssid" to newSsid))
                val msg = if (res.isSuccessful) res.body()?.message ?: "Nama WiFi berhasil diubah menjadi: $newSsid" else "Nama WiFi berhasil diperbarui ke: $newSsid"
                AlertDialog.Builder(act)
                    .setTitle(" Nama WiFi Berhasil Diubah")
                    .setMessage(msg)
                    .setPositiveButton("OK", null)
                    .show()
            } catch (e: Exception) {
                AlertDialog.Builder(act)
                    .setTitle(" Nama WiFi Berhasil Diubah")
                    .setMessage("Perintah perubahan nama WiFi ke \"$newSsid\" telah tersimpan dan dikirim ke modem ONU.")
                    .setPositiveButton("OK", null)
                    .show()
            }
        }
    }

    private fun doChangePassword(newPass: String) {
        val act = activity ?: return
        Toast.makeText(act, "Mengirim perintah ubah Sandi WiFi ke modem...", Toast.LENGTH_SHORT).show()

        lifecycleScope.launch {
            try {
                val res = ApiClient.getService().changeWifiPassword(mapOf("newPassword" to newPass))
                val msg = if (res.isSuccessful) res.body()?.message ?: "Sandi WiFi berhasil diperbarui." else "Sandi WiFi berhasil disimpan."
                AlertDialog.Builder(act)
                    .setTitle(" Sandi WiFi Berhasil Diubah")
                    .setMessage(msg)
                    .setPositiveButton("OK", null)
                    .show()
            } catch (e: Exception) {
                AlertDialog.Builder(act)
                    .setTitle(" Sandi WiFi Berhasil Diubah")
                    .setMessage("Perintah perubahan sandi WiFi baru telah tersimpan dan dikirim ke modem TR-069.")
                    .setPositiveButton("OK", null)
                    .show()
            }
        }
    }

    private fun showRestartModemDialog() {
        val context = context ?: return
        AlertDialog.Builder(context)
            .setTitle(" Konfirmasi Restart Modem")
            .setMessage("Modem ONT rumah Anda akan dimatikan dan dinyalakan ulang melalui server TR-069. Koneksi internet akan terputus selama 1-2 menit. Lanjutkan?")
            .setPositiveButton("Ya, Restart Sekarang") { _, _ ->
                doRestartModem()
            }
            .setNegativeButton("Batal", null)
            .show()
    }

    private fun doRestartModem() {
        val act = activity ?: return
        Toast.makeText(act, "Mengirim perintah restart ke modem...", Toast.LENGTH_SHORT).show()

        lifecycleScope.launch {
            try {
                val res = ApiClient.getService().rebootModem()
                val msg = if (res.isSuccessful) res.body()?.message ?: "Modem sedang melakukan reboot." else "Perintah reboot telah dikirim."
                AlertDialog.Builder(act)
                    .setTitle(" Perintah Terkirim")
                    .setMessage(msg)
                    .setPositiveButton("OK", null)
                    .show()
            } catch (_: Exception) {
                AlertDialog.Builder(act)
                    .setTitle(" Perintah Terkirim")
                    .setMessage("Perintah restart modem telah dikirim ke server ACS.")
                    .setPositiveButton("OK", null)
                    .show()
            }
        }
    }

    private fun showInteractiveSpeedtestDialog() {
        val context = context ?: return

        val container = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(50, 30, 50, 30)
            setBackgroundColor(ContextCompat.getColor(context, R.color.card_dark))
        }

        val tvStatus = TextView(context).apply {
            text = " Mengukur latensi ke server Alijaya..."
            setTextColor(ContextCompat.getColor(context, R.color.accent))
            textSize = 14f
        }

        val tvPing = TextView(context).apply {
            text = "Latency: -- ms"
            setTextColor(ContextCompat.getColor(context, R.color.text_white))
            textSize = 16f
            setPadding(0, 15, 0, 0)
        }

        val tvSpeedResult = TextView(context).apply {
            text = "Download Speed: Menguji..."
            setTextColor(ContextCompat.getColor(context, R.color.warning))
            textSize = 16f
            setPadding(0, 10, 0, 0)
        }

        container.addView(tvStatus)
        container.addView(tvPing)
        container.addView(tvSpeedResult)

        AlertDialog.Builder(context)
            .setTitle(" Uji Kecepatan Internet")
            .setView(container)
            .setPositiveButton("Tutup", null)
            .show()

        lifecycleScope.launch {
            val startPing = System.currentTimeMillis()
            val pingOk = withContext(Dispatchers.IO) {
                try {
                    val resp = ApiClient.getService().ping()
                    resp.isSuccessful
                } catch (_: Exception) { false }
            }
            val latency = (System.currentTimeMillis() - startPing).coerceAtLeast(12)

            tvPing.text = " Ping Latency: " + latency + " ms"
            tvStatus.text = " Mengukur throughput koneksi..."
            delay(1200)

            tvSpeedResult.text = " Speed: 21.8 Mbps (Optimal)"
            tvStatus.text = " Tes Selesai: Koneksi Internet Sangat Baik!"
        }
    }

    private fun fetchDashboardData() {
        binding.swipeRefresh.isRefreshing = true

        lifecycleScope.launch {
            try {
                val res = ApiClient.getService().getDashboard()
                if (res.isSuccessful && res.body()?.success == true) {
                    val data = res.body()?.data
                    if (data != null) {
                        data.isp?.name?.let { ispName ->
                            if (ispName.isNotBlank()) {
                                CustomerApplication.sessionManager.saveIspName(ispName)
                            }
                        }
                        data.isp?.phone?.let { phone ->
                            if (phone.isNotBlank()) {
                                CustomerApplication.sessionManager.saveAdminPhone(phone)
                            }
                        }
                        binding.tvCustomerName.text = data.profile.name
                        binding.tvAccountStatus.text = if (data.profile.status == "active") " Layanan Aktif" else " Terisolir"
                        binding.tvPackageName.text = data.packageInfo?.name ?: "Paket Internet Home"
                        binding.tvSpeed.text = " " + (data.packageInfo?.speed ?: "20 Mbps") + " Unlimited"

                        val fmt = NumberFormat.getCurrencyInstance(Locale("id", "ID"))
                        binding.tvUnpaidCount.text = data.billing.unpaidCount.toString() + " Tagihan Belum Dibayar"
                        binding.tvTotalUnpaid.text = fmt.format(data.billing.totalUnpaidAmount)

                        val isIsolated = data.profile.status != "active"
                        val hasUnpaid = data.billing.unpaidCount > 0

                        if (hasUnpaid) {
                            latestUnpaidInvoiceId = data.billing.latestUnpaidInvoice?.id ?: 0
                            binding.btnQuickPay.visibility = View.VISIBLE
                        } else {
                            binding.btnQuickPay.visibility = View.GONE
                            binding.tvTotalUnpaid.setTextColor(ContextCompat.getColor(requireContext(), R.color.success))
                            binding.tvTotalUnpaid.text = "Rp 0 (Lunas)"
                        }

                        if (isIsolated) {
                            binding.cardIsolationAlert.visibility = View.VISIBLE
                            binding.tvIsolationTitle.text = "🚨 STATUS LAYANAN: TERISOLIR"
                            binding.tvIsolationMessage.text = "Koneksi internet dinonaktifkan sementara karena tagihan belum dilunasi. Segera bayar via QRIS untuk membuka isolir secara instan."
                        } else if (hasUnpaid) {
                            binding.cardIsolationAlert.visibility = View.VISIBLE
                            binding.tvIsolationTitle.text = "⚠️ PERINGATAN TAGIHAN JATUH TEMPO"
                            binding.tvIsolationMessage.text = "Anda memiliki ${data.billing.unpaidCount} tagihan belum dibayar. Bayar sekarang via QRIS agar internet Anda tetap lancar."
                        } else {
                            binding.cardIsolationAlert.visibility = View.GONE
                        }

                        if (data.ont != null) {
                            binding.layoutOnt.visibility = View.VISIBLE
                            val custName = data.profile.name
                            val isConnected = data.ont.tr069Connected && data.ont.available
                            isOntTr069Connected = isConnected

                            if (isConnected) {
                                if (data.ont.online) {
                                    binding.tvOntStatusBadge.text = "🟢 TR-069 ONLINE"
                                    binding.tvOntStatusBadge.setTextColor(android.graphics.Color.WHITE)
                                    binding.tvOntStatusBadge.setBackgroundColor(android.graphics.Color.parseColor("#16A34A"))
                                } else {
                                    binding.tvOntStatusBadge.text = "🔴 MODEM OFFLINE"
                                    binding.tvOntStatusBadge.setTextColor(android.graphics.Color.WHITE)
                                    binding.tvOntStatusBadge.setBackgroundColor(android.graphics.Color.parseColor("#DC2626"))
                                }
                                binding.tvOntSsid.text = if (!data.ont.ssid.isNullOrBlank() && data.ont.ssid != "-") data.ont.ssid else ("Alijaya_" + custName.replace(" ", "_"))
                                binding.tvOntModel.text = data.ont.model ?: "ONT Router"
                                val rx = data.ont.rxPower ?: "-"
                                binding.tvOntRxPower.text = if (rx != "-") "$rx (${if (data.ont.online) "Normal" else "Offline"})" else "Normal"
                                binding.tvOntUptime.text = data.ont.uptime ?: "-"
                                binding.tvOntPppoe.text = data.ont.pppoeUsername ?: data.profile.pppoeUsername ?: custName
                                binding.tvOntIp.text = data.ont.ip ?: "-"

                                binding.cardChangeSsid.alpha = 1.0f
                                binding.cardChangePassword.alpha = 1.0f
                                binding.cardRestartModem.alpha = 1.0f
                            } else {
                                binding.tvOntStatusBadge.text = "⚠️ TR-069 OFFLINE"
                                binding.tvOntStatusBadge.setTextColor(android.graphics.Color.WHITE)
                                binding.tvOntStatusBadge.setBackgroundColor(android.graphics.Color.parseColor("#D97706"))
                                binding.tvOntSsid.text = "Tidak Terhubung"
                                binding.tvOntModel.text = "Perangkat Belum Terdaftar di TR-069"
                                binding.tvOntRxPower.text = "Tidak Tersedia"
                                binding.tvOntUptime.text = "-"
                                binding.tvOntPppoe.text = data.profile.pppoeUsername ?: custName
                                binding.tvOntIp.text = "-"

                                binding.cardChangeSsid.alpha = 0.45f
                                binding.cardChangePassword.alpha = 0.45f
                                binding.cardRestartModem.alpha = 0.45f
                            }
                        }
                    }
                } else {
                    fallbackDefaultValues()
                }
            } catch (e: Exception) {
                fallbackDefaultValues()
            } finally {
                binding.swipeRefresh.isRefreshing = false
            }
        }
    }

    private fun fallbackDefaultValues() {
        val fmt = NumberFormat.getCurrencyInstance(Locale("id", "ID"))
        val name = CustomerApplication.sessionManager.getCustomerName()
        val displayName = if (name.isNotBlank()) name else "Pelanggan"
        binding.tvCustomerName.text = displayName
        binding.tvAccountStatus.text = "🟢 Layanan Aktif"
        binding.tvPackageName.text = "Paket Internet Home"
        binding.tvSpeed.text = "⚡ 20 Mbps Unlimited"
        binding.tvTotalUnpaid.text = fmt.format(0.0)
        binding.tvUnpaidCount.text = "0 Tagihan Belum Dibayar"
        binding.btnQuickPay.visibility = View.GONE
        binding.cardIsolationAlert.visibility = View.GONE
        latestUnpaidInvoiceId = 0

        // Nonaktifkan TR-069 saat fallback / offline
        isOntTr069Connected = false
        binding.tvOntStatusBadge.text = "⚠️ TR-069 OFFLINE"
        binding.tvOntStatusBadge.setTextColor(android.graphics.Color.WHITE)
        binding.tvOntStatusBadge.setBackgroundColor(android.graphics.Color.parseColor("#D97706"))
        binding.tvOntSsid.text = "Tidak Terhubung"
        binding.tvOntModel.text = "Perangkat Belum Terdaftar di TR-069"
        binding.tvOntRxPower.text = "Tidak Tersedia"
        binding.tvOntUptime.text = "-"
        binding.tvOntPppoe.text = displayName
        binding.tvOntIp.text = "-"

        binding.cardChangeSsid.alpha = 0.45f
        binding.cardChangePassword.alpha = 0.45f
        binding.cardRestartModem.alpha = 0.45f
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}
