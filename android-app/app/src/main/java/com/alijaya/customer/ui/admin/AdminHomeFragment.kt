package com.alijaya.customer.ui.admin

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Toast
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.alijaya.customer.CustomerApplication
import com.alijaya.customer.databinding.FragmentAdminHomeBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.text.NumberFormat
import java.util.Locale
import java.util.concurrent.TimeUnit

class AdminHomeFragment : Fragment() {
    private var _binding: FragmentAdminHomeBinding? = null
    private val binding get() = _binding!!

    private fun httpClient() = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()

    private fun getBaseUrl(): String {
        val base = CustomerApplication.sessionManager.getServerBaseUrl()
        return if (base.endsWith("/")) base.dropLast(1) else base
    }

    private fun getToken(): String = CustomerApplication.sessionManager.getAuthToken()

    override fun onCreateView(
        inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?
    ): View {
        _binding = FragmentAdminHomeBinding.inflate(inflater, container, false)
        return binding.root
    }

    private fun openFragment(frag: Fragment) {
        parentFragmentManager.beginTransaction()
            .replace(com.alijaya.customer.R.id.fragment_container, frag)
            .addToBackStack(null)
            .commit()
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        binding.swipeRefresh.setOnRefreshListener {
            fetchDashboardData()
        }

        // Kategori 1: Operasional & Pelanggan
        binding.btnActionCustomers.setOnClickListener { openFragment(AdminCustomersFragment()) }
        binding.btnActionBilling.setOnClickListener { openFragment(AdminBillingFragment()) }
        binding.btnActionHistory.setOnClickListener { openFragment(AdminPaidHistoryFragment()) }
        binding.btnMenuPackages.setOnClickListener { openFragment(AdminPackagesFragment()) }
        binding.btnMenuTickets.setOnClickListener { openFragment(AdminTicketsFragment()) }
        binding.btnMenuAreas.setOnClickListener { openFragment(AdminAreasFragment()) }

        // Kategori 2: Jaringan & Infrastruktur
        binding.btnActionMikrotik.setOnClickListener { openFragment(com.alijaya.customer.ui.tech.TechMikrotikFragment()) }
        binding.btnMenuRouters.setOnClickListener { openFragment(AdminRoutersFragment()) }
        binding.btnMenuOlt.setOnClickListener { openFragment(com.alijaya.customer.ui.tech.TechOltFragment()) }
        binding.btnMenuOdp.setOnClickListener { openFragment(com.alijaya.customer.ui.tech.TechOdpFragment()) }
        binding.btnActionTr069.setOnClickListener { openFragment(com.alijaya.customer.ui.tech.TechTr069Fragment()) }
        binding.btnMenuVouchers.setOnClickListener { openFragment(AdminVouchersFragment()) }
        binding.btnMenuMap.setOnClickListener { openFragment(com.alijaya.customer.ui.map.NetworkMapFragment()) }

        // Kategori 3: Keuangan & Kas
        binding.btnMenuReports.setOnClickListener { openFragment(AdminReportsFragment()) }
        binding.btnMenuExpenses.setOnClickListener { openFragment(AdminExpensesFragment()) }
        binding.btnMenuCashin.setOnClickListener { openFragment(AdminCashInFragment()) }
        binding.btnMenuApproval.setOnClickListener { openFragment(AdminCollectorPaymentsFragment()) }

        // Kategori 4: Tim & Mitra
        binding.btnMenuTech.setOnClickListener { openFragment(AdminTechniciansFragment()) }
        binding.btnMenuAgent.setOnClickListener { openFragment(AdminAgentsFragment()) }
        binding.btnMenuCashier.setOnClickListener { openFragment(AdminCashiersFragment()) }
        binding.btnMenuCollector.setOnClickListener { openFragment(AdminCollectorsFragment()) }
        binding.btnMenuInventory.setOnClickListener { openFragment(AdminInventoryFragment()) }

        // Kategori 5: Server & Integrasi
        binding.btnMenuMonitoring.setOnClickListener { openFragment(AdminMonitoringFragment()) }
        binding.btnMenuWhatsapp.setOnClickListener { openFragment(AdminWhatsAppFragment()) }
        binding.btnMenuDigiflazz.setOnClickListener { openFragment(AdminDigiflazzFragment()) }
        binding.btnMenuSettings.setOnClickListener { openFragment(AdminSettingsFragment()) }
        binding.btnMenuBackup.setOnClickListener { openFragment(AdminBackupFragment()) }
        binding.btnMenuAudit.setOnClickListener { openFragment(AdminAuditLogFragment()) }

        binding.btnAdminLogout.setOnClickListener {
            val act = activity ?: return@setOnClickListener
            androidx.appcompat.app.AlertDialog.Builder(act)
                .setTitle("🚪 Konfirmasi Keluar")
                .setMessage("Apakah Anda yakin ingin logout dari sesi Administrator?")
                .setPositiveButton("Ya, Logout") { _, _ ->
                    CustomerApplication.sessionManager.logout()
                    val intent = android.content.Intent(act, com.alijaya.customer.ui.login.LoginActivity::class.java).apply {
                        flags = android.content.Intent.FLAG_ACTIVITY_NEW_TASK or android.content.Intent.FLAG_ACTIVITY_CLEAR_TASK
                    }
                    startActivity(intent)
                    act.finish()
                }
                .setNegativeButton("Batal", null)
                .show()
        }

        fetchDashboardData()
    }

    private fun fetchDashboardData() {
        binding.swipeRefresh.isRefreshing = true
        lifecycleScope.launch {
            val url = "${getBaseUrl()}/api/customer/app/admin/dashboard"
            val responseStr = withContext(Dispatchers.IO) {
                try {
                    val req = Request.Builder().url(url)
                        .addHeader("Authorization", "Bearer ${getToken()}")
                        .build()
                    val resp = httpClient().newCall(req).execute()
                    if (resp.isSuccessful) resp.body?.string() else null
                } catch (_: Exception) { null }
            }

            binding.swipeRefresh.isRefreshing = false

            if (responseStr != null) {
                try {
                    val json = JSONObject(responseStr)
                    val data = json.optJSONObject("data")
                    if (data != null) {
                        val billing = data.optJSONObject("billing")
                        val custStats = data.optJSONObject("custStats")
                        val onuStats = data.optJSONObject("onuStats")

                        val fmt = NumberFormat.getCurrencyInstance(Locale("id", "ID"))

                        if (billing != null) {
                            val thisMonth = billing.optDouble("thisMonth", 0.0)
                            val todayRev = billing.optDouble("todayRevenue", 0.0)
                            val pendingAmt = billing.optDouble("pendingAmount", 0.0)
                            val unpaidCount = billing.optInt("unpaidCount", 0)

                            binding.tvOmsetMonth.text = fmt.format(thisMonth)
                            binding.tvOmsetToday.text = "Hari ini: ${fmt.format(todayRev)}"
                            binding.tvUnpaidAmount.text = fmt.format(pendingAmt)
                            binding.tvUnpaidCount.text = "$unpaidCount Tagihan Tertunggak"
                        }

                        if (custStats != null) {
                            binding.tvCustActive.text = custStats.optInt("active", 0).toString()
                            binding.tvCustIsolated.text = custStats.optInt("suspended", 0).toString()
                            binding.tvCustDeferred.text = custStats.optInt("deferred", 0).toString()
                            binding.tvCustTotal.text = custStats.optInt("total", 0).toString()
                        }

                        if (onuStats != null) {
                            val totalOnu = onuStats.optInt("total", 0)
                            val onlineOnu = onuStats.optInt("online", 0)
                            binding.tvOnuDetail.text = "Total: $totalOnu Perangkat ($onlineOnu Terhubung)"
                        }
                    }
                } catch (_: Exception) {}
            }
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}