package com.alijaya.customer.ui.admin

import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.fragment.app.Fragment
import com.alijaya.customer.R
import com.alijaya.customer.ui.tech.TechMikrotikFragment
import com.alijaya.customer.ui.tech.TechOdpFragment
import com.alijaya.customer.ui.tech.TechOltFragment
import com.alijaya.customer.ui.tech.TechTr069Fragment

class AdminAllMenusFragment : Fragment() {

    data class MenuItem(val title: String, val category: String, val colorHex: String, val fragmentProvider: () -> Fragment)

    private val allMenus = listOf(
        // Operasional
        MenuItem("👥 Pelanggan", "OPERASIONAL", "#2563EB") { AdminCustomersFragment() },
        MenuItem("🧾 Billing & Kasir", "OPERASIONAL", "#3B82F6") { AdminBillingFragment() },
        MenuItem("📊 Riwayat Bayar", "OPERASIONAL", "#1D4ED8") { AdminPaidHistoryFragment() },
        MenuItem("📦 Paket Layanan", "OPERASIONAL", "#0284C7") { AdminPackagesFragment() },
        MenuItem("🎫 Tiket Gangguan", "OPERASIONAL", "#0369A1") { AdminTicketsFragment() },
        MenuItem("📍 Area Wilayah", "OPERASIONAL", "#1E40AF") { AdminAreasFragment() },

        // Jaringan
        MenuItem("⚡ MikroTik Live", "JARINGAN", "#0D9488") { TechMikrotikFragment() },
        MenuItem("🖧 Router List", "JARINGAN", "#0891B2") { AdminRoutersFragment() },
        MenuItem("📡 OLT PON", "JARINGAN", "#0F766E") { TechOltFragment() },
        MenuItem("🗃️ ODP Lapangan", "JARINGAN", "#155E75") { TechOdpFragment() },
        MenuItem("📡 Remote TR-069", "JARINGAN", "#0284C7") { TechTr069Fragment() },
        MenuItem("🗺️ Peta / Mapping ONU", "JARINGAN", "#0D9488") { com.alijaya.customer.ui.map.NetworkMapFragment() },
        MenuItem("🎟️ Voucher Hotspot", "JARINGAN", "#059669") { AdminVouchersFragment() },

        // Keuangan
        MenuItem("📈 Laporan Keuangan", "KEUANGAN", "#16A34A") { AdminReportsFragment() },
        MenuItem("💸 Pengeluaran Kas", "KEUANGAN", "#DC2626") { AdminExpensesFragment() },
        MenuItem("💵 Pemasukan Kas", "KEUANGAN", "#15803D") { AdminCashInFragment() },
        MenuItem("✅ Approval Kolektor", "KEUANGAN", "#D97706") { AdminCollectorPaymentsFragment() },

        // Tim & Mitra
        MenuItem("🛠️ Daftar Teknisi", "TIM & MITRA", "#7C3AED") { AdminTechniciansFragment() },
        MenuItem("🏪 Mitra Agen & Topup", "TIM & MITRA", "#9333EA") { AdminAgentsFragment() },
        MenuItem("💰 Daftar Kasir", "TIM & MITRA", "#6366F1") { AdminCashiersFragment() },
        MenuItem("📍 Absensi Kasir", "TIM & MITRA", "#0EA5E9") { CashierAttendanceFragment() },
        MenuItem("🛵 Kolektor Lapangan", "TIM & MITRA", "#6D28D9") { AdminCollectorsFragment() },
        MenuItem("📦 Gudang & Stok", "TIM & MITRA", "#475569") { AdminInventoryFragment() },

        // Server
        MenuItem("🖥️ Server Health", "SERVER & SISTEM", "#334155") { AdminMonitoringFragment() },
        MenuItem("⚡ Auto-Payment Gateway", "SERVER & SISTEM", "#F59E0B") { AdminWebhookGatewayFragment() },
        MenuItem("💬 WhatsApp Bot", "SERVER & SISTEM", "#15803D") { AdminWhatsAppFragment() },
        MenuItem("📱 Digiflazz PPOB", "SERVER & SISTEM", "#B45309") { AdminDigiflazzFragment() },
        MenuItem("⚙️ Pengaturan ISP", "SERVER & SISTEM", "#475569") { AdminSettingsFragment() },
        MenuItem("💾 Backup DB", "SERVER & SISTEM", "#2563EB") { AdminBackupFragment() },
        MenuItem("📋 Audit Log", "SERVER & SISTEM", "#374151") { AdminAuditLogFragment() }
    )

    private lateinit var contentContainer: LinearLayout
    private lateinit var gridContainer: LinearLayout

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        val scroll = ScrollView(requireContext()).apply {
            setBackgroundColor(Color.parseColor("#0F172A"))
            isFillViewport = true
        }
        contentContainer = LinearLayout(requireContext()).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(28, 28, 28, 36)
        }
        scroll.addView(contentContainer)
        return scroll
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        val ctx = requireContext()

        contentContainer.addView(TextView(ctx).apply {
            text = "🗂️ Direktori Lengkap Modul"
            setTextColor(Color.WHITE); textSize = 20f; typeface = Typeface.DEFAULT_BOLD; setPadding(0, 0, 0, 4)
        })
        contentContainer.addView(TextView(ctx).apply {
            text = "Akses langsung ke seluruh 24 modul administrator tanpa harus kembali ke beranda."
            setTextColor(Color.parseColor("#94A3B8")); textSize = 12f; setPadding(0, 0, 0, 16)
        })

        val etSearch = EditText(ctx).apply {
            hint = "🔍 Cari modul (cth: mikrotik, kas, wa, odp)..."
            setHintTextColor(Color.parseColor("#64748B"))
            setTextColor(Color.WHITE); textSize = 13.5f
            setBackgroundColor(Color.parseColor("#1E293B"))
            setPadding(24, 20, 24, 20)
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { setMargins(0, 0, 0, 20) }
            addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
                    renderMenuGrid(ctx, s.toString().trim())
                }
                override fun afterTextChanged(s: Editable?) {}
            })
        }
        contentContainer.addView(etSearch)

        gridContainer = LinearLayout(ctx).apply {
            id = View.generateViewId()
            orientation = LinearLayout.VERTICAL
        }
        contentContainer.addView(gridContainer)

        renderMenuGrid(ctx, "")
    }

    private fun renderMenuGrid(ctx: android.content.Context, q: String) {
        gridContainer.removeAllViews()

        val filtered = if (q.isEmpty()) {
            allMenus
        } else {
            val lower = q.lowercase()
            allMenus.filter { it.title.lowercase().contains(lower) || it.category.lowercase().contains(lower) }
        }

        val categories = listOf("OPERASIONAL", "JARINGAN", "KEUANGAN", "TIM & MITRA", "SERVER & SISTEM")

        for (cat in categories) {
            val itemsInCat = filtered.filter { it.category == cat }
            if (itemsInCat.isEmpty()) continue

            // Category Header
            gridContainer.addView(TextView(ctx).apply {
                text = "📌 $cat"
                setTextColor(Color.parseColor("#38BDF8"))
                textSize = 12.5f
                typeface = Typeface.DEFAULT_BOLD
                setBackgroundColor(Color.parseColor("#1E293B"))
                setPadding(18, 10, 18, 10)
                layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { setMargins(0, 12, 0, 10) }
            })

            // 2 items per row
            var row: LinearLayout? = null
            for (i in itemsInCat.indices) {
                if (i % 2 == 0) {
                    row = LinearLayout(ctx).apply {
                        orientation = LinearLayout.HORIZONTAL
                        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { setMargins(0, 0, 0, 10) }
                    }
                    gridContainer.addView(row)
                }

                val item = itemsInCat[i]
                val btn = Button(ctx).apply {
                    layoutParams = LinearLayout.LayoutParams(0, 100, 1f).apply {
                        if (i % 2 == 0) marginEnd = 8 else marginStart = 8
                    }
                    text = item.title
                    setTextColor(Color.WHITE)
                    textSize = 12f
                    typeface = Typeface.DEFAULT_BOLD
                    backgroundTintList = android.content.res.ColorStateList.valueOf(Color.parseColor(item.colorHex))
                    setOnClickListener {
                        openFragment(item.fragmentProvider())
                    }
                }
                row?.addView(btn)
            }

            // If odd count, add invisible dummy
            if (itemsInCat.size % 2 != 0 && row != null) {
                row.addView(View(ctx).apply {
                    layoutParams = LinearLayout.LayoutParams(0, 100, 1f).apply { marginStart = 8 }
                })
            }
        }
    }

    private fun openFragment(fragment: Fragment) {
        parentFragmentManager.beginTransaction()
            .replace(R.id.fragment_container, fragment)
            .addToBackStack(null)
            .commit()
    }
}
