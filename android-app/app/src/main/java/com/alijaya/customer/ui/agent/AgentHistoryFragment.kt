package com.alijaya.customer.ui.agent

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.alijaya.customer.CustomerApplication
import com.alijaya.customer.R
import com.alijaya.customer.databinding.FragmentAgentHistoryBinding
import com.alijaya.customer.databinding.ItemAgentTransactionBinding
import com.alijaya.customer.ui.login.LoginActivity
import com.alijaya.customer.ui.server.ServerConfigActivity
import com.alijaya.customer.util.BluetoothPrinterHelper
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.text.NumberFormat
import java.util.Locale
import java.util.concurrent.TimeUnit

class AgentHistoryFragment : Fragment() {
    private var _binding: FragmentAgentHistoryBinding? = null
    private val binding get() = _binding!!

    private var allTransactions = mutableListOf<JSONObject>()
    private lateinit var adapter: AgentTxAdapter

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
        _binding = FragmentAgentHistoryBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        adapter = AgentTxAdapter(allTransactions) { tx ->
            showTransactionDetailDialog(tx)
        }

        binding.rvHistory.layoutManager = LinearLayoutManager(context)
        binding.rvHistory.adapter = adapter

        binding.swipeRefresh.setOnRefreshListener {
            loadTransactions()
        }

        binding.btnConfigPrinter.setOnClickListener {
            startActivity(Intent(requireContext(), ServerConfigActivity::class.java))
        }

        binding.btnAgentLogout.setOnClickListener {
            AlertDialog.Builder(requireContext())
                .setTitle("🚪 Konfirmasi Keluar")
                .setMessage("Apakah Anda yakin ingin logout dari akun Agen?")
                .setPositiveButton("Ya, Logout") { _, _ ->
                    CustomerApplication.sessionManager.logout()
                    val intent = Intent(requireContext(), LoginActivity::class.java).apply {
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
                    }
                    startActivity(intent)
                    activity?.finish()
                }
                .setNegativeButton("Batal", null)
                .show()
        }

        updatePrinterStatus()
        loadTransactions()
    }

    override fun onResume() {
        super.onResume()
        updatePrinterStatus()
    }

    private fun updatePrinterStatus() {
        val session = CustomerApplication.sessionManager
        if (session.getPrinterMac().isNotEmpty()) {
            binding.tvHistoryPrinterName.text = "${session.getPrinterName()} (${if (session.isPrinter80mm()) "80mm" else "58mm"}) - Siap Cetak"
            binding.tvHistoryPrinterName.setTextColor(ContextCompat.getColor(requireContext(), R.color.success))
        } else {
            binding.tvHistoryPrinterName.text = "Belum Terkoneksi (Klik Setup untuk memilih printer)"
            binding.tvHistoryPrinterName.setTextColor(ContextCompat.getColor(requireContext(), R.color.text_muted))
        }
    }

    private fun loadTransactions() {
        binding.swipeRefresh.isRefreshing = true
        lifecycleScope.launch {
            val url = "${getBaseUrl()}/api/customer/agent/transactions"
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
                    val arr = json.optJSONArray("data") ?: JSONArray()
                    allTransactions.clear()
                    for (i in 0 until arr.length()) {
                        allTransactions.add(arr.getJSONObject(i))
                    }

                    adapter.notifyDataSetChanged()

                    if (allTransactions.isEmpty()) {
                        binding.tvEmptyHistory.visibility = View.VISIBLE
                        binding.rvHistory.visibility = View.GONE
                    } else {
                        binding.tvEmptyHistory.visibility = View.GONE
                        binding.rvHistory.visibility = View.VISIBLE
                    }
                } catch (_: Exception) {
                    binding.tvEmptyHistory.visibility = View.VISIBLE
                    binding.tvEmptyHistory.text = "Gagal memproses riwayat transaksi"
                }
            } else {
                binding.tvEmptyHistory.visibility = View.VISIBLE
                binding.tvEmptyHistory.text = "Gagal terhubung ke server"
            }
        }
    }

    private fun showTransactionDetailDialog(tx: JSONObject) {
        val ctx = context ?: return
        val type = tx.optString("type", "voucher_sale")
        val amount = tx.optLong("amount_sell", tx.optLong("amount_buy", 0))
        val fee = tx.optLong("fee", 0)
        val note = tx.optString("note", "-")
        val date = tx.optString("created_at", "-")
        val vCode = tx.optString("voucher_code", "")
        val vPass = tx.optString("voucher_password", vCode)
        val digiSku = tx.optString("digi_sku", "")
        val digiTarget = tx.optString("digi_target", "")
        val digiSn = tx.optString("digi_sn", "")
        val digiStatus = tx.optString("digi_status", "")

        val fmt = NumberFormat.getNumberInstance(Locale("id", "ID"))

        val scroll = android.widget.ScrollView(ctx).apply {
            isFillViewport = true
        }

        val layout = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(36, 16, 36, 10)
        }
        scroll.addView(layout)

        val isPending = digiStatus.equals("pending", true) || digiStatus.equals("process", true)
        val isFailed = digiStatus.equals("failed", true)

        // 1. Status & Type Header Banner
        val headerCard = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = android.view.Gravity.CENTER_VERTICAL
            setBackgroundColor(
                if (isPending) android.graphics.Color.parseColor("#854D0E") // Dark Yellow
                else if (isFailed) android.graphics.Color.parseColor("#991B1B") // Dark Red
                else android.graphics.Color.parseColor("#1E293B")
            )
            setPadding(16, 12, 16, 12)
        }
        val tvType = TextView(ctx).apply {
            text = "📄 ${formatTypeLabel(type).uppercase()}"
            setTextColor(android.graphics.Color.WHITE)
            textSize = 13.5f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        val tvStatus = TextView(ctx).apply {
            text = if (isPending) "⏳ MENUNGGU" else if (isFailed) "❌ GAGAL" else "✅ SUKSES"
            setTextColor(
                if (isPending) android.graphics.Color.parseColor("#FACC15")
                else if (isFailed) android.graphics.Color.parseColor("#F87171")
                else android.graphics.Color.parseColor("#4ADE80")
            )
            textSize = 12f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
        }
        headerCard.addView(tvType)
        headerCard.addView(tvStatus)
        layout.addView(headerCard)

        // 2. High-Contrast Details Card
        val detailsCard = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(android.graphics.Color.parseColor("#1E293B"))
            setPadding(20, 14, 20, 14)
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply {
                setMargins(0, 8, 0, 8)
            }
        }

        fun addRow(label: String, value: String, color: Int = android.graphics.Color.WHITE, isBold: Boolean = false, sizeSp: Float = 13.5f) {
            val row = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                setPadding(0, 4, 0, 4)
            }
            val tvL = TextView(ctx).apply {
                text = label
                setTextColor(android.graphics.Color.parseColor("#94A3B8")) // Slate 400
                textSize = 13f
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1.2f)
            }
            val tvV = TextView(ctx).apply {
                text = value
                setTextColor(color)
                textSize = sizeSp
                if (isBold) typeface = android.graphics.Typeface.DEFAULT_BOLD
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 2f)
                gravity = android.view.Gravity.END
            }
            row.addView(tvL)
            row.addView(tvV)
            detailsCard.addView(row)
        }

        addRow("Waktu Transaksi", date, android.graphics.Color.parseColor("#CBD5E1"))
        addRow("Nominal Total", "Rp " + fmt.format(amount), android.graphics.Color.parseColor("#4ADE80"), true, 16f)
        if (fee > 0) {
            addRow("Keuntungan / Fee", "Rp " + fmt.format(fee), android.graphics.Color.parseColor("#38BDF8"), true, 14f)
        }

        // Voucher Specific Highlight
        if (vCode.isNotEmpty()) {
            val vBox = LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
                setBackgroundColor(android.graphics.Color.parseColor("#0F172A"))
                setPadding(14, 10, 14, 10)
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                ).apply {
                    setMargins(0, 8, 0, 4)
                }
            }
            val tvVLabel = TextView(ctx).apply {
                text = "KREDENSIAL VOUCHER HOTSPOT:"
                setTextColor(android.graphics.Color.parseColor("#94A3B8"))
                textSize = 11f
            }
            val tvVCode = TextView(ctx).apply {
                text = "KODE / USER : $vCode"
                setTextColor(android.graphics.Color.parseColor("#FACC15")) // Bright Yellow Gold
                textSize = 16f
                typeface = android.graphics.Typeface.DEFAULT_BOLD
                letterSpacing = 0.04f
            }
            val tvVPass = TextView(ctx).apply {
                text = "PASSWORD    : $vPass"
                setTextColor(android.graphics.Color.WHITE)
                textSize = 14f
                typeface = android.graphics.Typeface.DEFAULT_BOLD
            }
            vBox.addView(tvVLabel)
            vBox.addView(tvVCode)
            if (vPass.isNotEmpty() && vPass != vCode) vBox.addView(tvVPass)
            detailsCard.addView(vBox)
        }

        // Pulsa Specific Highlight
        if (digiSku.isNotEmpty()) {
            addRow("Produk / SKU", digiSku, android.graphics.Color.WHITE, true)
            if (digiTarget.isNotEmpty()) addRow("Nomor Tujuan", digiTarget, android.graphics.Color.parseColor("#38BDF8"), true, 15f)
            if (digiSn.isNotEmpty() && digiSn != "-") {
                val snBox = LinearLayout(ctx).apply {
                    orientation = LinearLayout.VERTICAL
                    setBackgroundColor(android.graphics.Color.parseColor("#0F172A"))
                    setPadding(12, 8, 12, 8)
                    layoutParams = LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.MATCH_PARENT,
                        LinearLayout.LayoutParams.WRAP_CONTENT
                    ).apply {
                        setMargins(0, 6, 0, 4)
                    }
                }
                val tvSnLabel = TextView(ctx).apply {
                    text = "Serial Number (SN) / Token:"
                    setTextColor(android.graphics.Color.parseColor("#94A3B8"))
                    textSize = 11f
                }
                val tvSnVal = TextView(ctx).apply {
                    text = digiSn
                    setTextColor(android.graphics.Color.parseColor("#FACC15")) // Bright Gold
                    textSize = 15f
                    typeface = android.graphics.Typeface.DEFAULT_BOLD
                    letterSpacing = 0.04f
                }
                snBox.addView(tvSnLabel)
                snBox.addView(tvSnVal)
                detailsCard.addView(snBox)
            }
            if (digiStatus.isNotEmpty()) {
                val statColor = if (isPending) android.graphics.Color.parseColor("#FACC15")
                                else if (isFailed) android.graphics.Color.parseColor("#F87171")
                                else android.graphics.Color.parseColor("#4ADE80")
                addRow("Status Operator", digiStatus.uppercase(), statColor, true)
            }
        }

        if (note.isNotEmpty() && note != "-") {
            addRow("Keterangan", note, android.graphics.Color.parseColor("#94A3B8"), false, 12.5f)
        }

        layout.addView(detailsCard)

        var dialog: AlertDialog? = null

        // Check Status Button for Pending Pulsa
        if (type == "pulsa" && isPending) {
            val btnCheckStatus = Button(ctx).apply {
                text = "🔄 Cek Status Terkini ke Digiflazz"
                setTextColor(android.graphics.Color.WHITE)
                textSize = 13f
                typeface = android.graphics.Typeface.DEFAULT_BOLD
                backgroundTintList = android.content.res.ColorStateList.valueOf(android.graphics.Color.parseColor("#D97706")) // Amber 600
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                ).apply {
                    setMargins(0, 4, 0, 10)
                }
                setOnClickListener {
                    checkPulsaStatusLive(tx, dialog)
                }
            }
            layout.addView(btnCheckStatus)
        }

        dialog = AlertDialog.Builder(ctx)
            .setTitle("🔍 Detail Transaksi & Cetak Ulang")
            .setView(scroll)
            .setPositiveButton("🖨️ Cetak Struk Ulang (Bluetooth)") { _, _ ->
                reprintTransactionBluetooth(tx)
            }
            .setNegativeButton("Tutup", null)
            .show()
    }

    private fun checkPulsaStatusLive(tx: JSONObject, dialog: AlertDialog?) {
        val ctx = context ?: return
        val txId = tx.optLong("id", 0)
        if (txId <= 0) return

        val progress = android.app.ProgressDialog(ctx).apply {
            setMessage("Mengecek status terkini ke server Digiflazz...")
            setCancelable(false)
            show()
        }

        lifecycleScope.launch {
            val url = "${getBaseUrl()}/api/customer/agent/pulsa/check-status"
            val bodyJson = JSONObject().apply { put("tx_id", txId) }.toString()
            val respStr = withContext(Dispatchers.IO) {
                try {
                    val reqBody = bodyJson.toRequestBody("application/json".toMediaType())
                    val req = Request.Builder().url(url)
                        .addHeader("Authorization", "Bearer ${getToken()}")
                        .post(reqBody).build()
                    val resp = httpClient().newCall(req).execute()
                    resp.body?.string()
                } catch (_: Exception) { null }
            }

            progress.dismiss()

            if (respStr != null) {
                try {
                    val json = JSONObject(respStr)
                    val data = json.optJSONObject("data")
                    val newStatus = data?.optString("status", "pending") ?: "pending"
                    val newSn = data?.optString("sn", "") ?: ""
                    val newMsg = data?.optString("message", "") ?: ""

                    tx.put("digi_status", newStatus)
                    if (newSn.isNotEmpty()) tx.put("digi_sn", newSn)
                    if (newMsg.isNotEmpty()) tx.put("digi_message", newMsg)

                    dialog?.dismiss()

                    if (newStatus.equals("success", true)) {
                        Toast.makeText(ctx, "✅ Transaksi SUKSES! SN: $newSn", Toast.LENGTH_LONG).show()
                    } else if (newStatus.equals("failed", true)) {
                        Toast.makeText(ctx, "❌ Transaksi GAGAL dari provider!", Toast.LENGTH_LONG).show()
                    } else {
                        Toast.makeText(ctx, "⏳ Transaksi masih dalam proses provider.", Toast.LENGTH_SHORT).show()
                    }

                    // Re-open updated dialog and refresh list
                    loadTransactions()
                    showTransactionDetailDialog(tx)
                } catch (e: Exception) {
                    Toast.makeText(ctx, "Gagal memproses respon: ${e.message}", Toast.LENGTH_SHORT).show()
                }
            } else {
                Toast.makeText(ctx, "Gagal terhubung ke server untuk cek status", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun reprintTransactionBluetooth(tx: JSONObject) {
        val session = CustomerApplication.sessionManager
        val mac = session.getPrinterMac()
        if (mac.isEmpty()) {
            Toast.makeText(context, "Printer bluetooth belum dipilih. Silakan atur printer terlebih dahulu.", Toast.LENGTH_SHORT).show()
            return
        }

        val type = tx.optString("type", "voucher_sale")
        val amount = tx.optLong("amount_sell", tx.optLong("amount_buy", 0))
        val note = tx.optString("note", "-")
        val date = tx.optString("created_at", "-")
        val vCode = tx.optString("voucher_code", "")
        val vPass = tx.optString("voucher_password", vCode)
        val digiSku = tx.optString("digi_sku", "")
        val digiTarget = tx.optString("digi_target", "")
        val digiSn = tx.optString("digi_sn", "")

        val fmt = NumberFormat.getNumberInstance(Locale("id", "ID")).format(amount)

        val lines = mutableListOf<String>()
        lines.add(BluetoothPrinterHelper.centerText("================================"))
        lines.add(BluetoothPrinterHelper.centerText(session.getIspName()))
        lines.add(BluetoothPrinterHelper.centerText("STRUK TRANSAKSI RESMI"))
        lines.add(BluetoothPrinterHelper.centerText("================================"))
        lines.add("Tipe      : " + formatTypeLabel(type))
        lines.add("Waktu     : $date")
        lines.add("--------------------------------")

        if (vCode.isNotEmpty()) {
            lines.add("USERNAME  : $vCode")
            lines.add("PASSWORD  : $vPass")
        }
        if (digiSku.isNotEmpty()) {
            lines.add("Produk    : $digiSku")
            lines.add("Tujuan    : $digiTarget")
            if (digiSn.isNotEmpty() && digiSn != "-") lines.add("SN        : $digiSn")
        }

        lines.add("Keterangan: $note")
        lines.add("--------------------------------")
        lines.add("Total     : Rp $fmt")
        lines.add("Status    : SUKSES / LUNAS")
        lines.add("================================")
        lines.add(BluetoothPrinterHelper.centerText("Terima kasih atas transaksi Anda!"))
        lines.add(BluetoothPrinterHelper.centerText("================================"))
        lines.add("\n\n")

        BluetoothPrinterHelper.printRawLines(requireContext(), mac, lines)
        Toast.makeText(context, "Mencetak ulang struk ke printer...", Toast.LENGTH_SHORT).show()
    }

    private fun formatTypeLabel(type: String): String {
        return when (type) {
            "voucher_sale" -> "VOUCHER HOTSPOT"
            "pulsa" -> "PULSA / PPOB"
            "invoice", "bill_payment" -> "BAYAR TAGIHAN"
            "topup" -> "TOP UP SALDO"
            else -> type.uppercase()
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }

    inner class AgentTxAdapter(
        private val list: List<JSONObject>,
        private val onItemClick: (JSONObject) -> Unit
    ) : RecyclerView.Adapter<AgentTxAdapter.VH>() {

        inner class VH(val b: ItemAgentTransactionBinding) : RecyclerView.ViewHolder(b.root)

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
            val b = ItemAgentTransactionBinding.inflate(LayoutInflater.from(parent.context), parent, false)
            return VH(b)
        }

        override fun onBindViewHolder(holder: VH, position: Int) {
            val tx = list[position]
            val type = tx.optString("type", "voucher_sale")
            val amount = tx.optLong("amount_sell", tx.optLong("amount_buy", 0))
            val date = tx.optString("created_at", "-")
            val note = tx.optString("note", "-")
            val balAfter = tx.optLong("balance_after", 0)

            val fmt = NumberFormat.getNumberInstance(Locale("id", "ID"))

            holder.b.tvTxBadge.text = formatTypeLabel(type)
            holder.b.tvTxDate.text = date
            holder.b.tvTxTitle.text = note
            holder.b.tvTxSubtitle.text = "Sisa Saldo: Rp ${fmt.format(balAfter)}"

            if (type == "topup") {
                holder.b.tvTxAmount.text = "+ Rp ${fmt.format(amount)}"
                holder.b.tvTxAmount.setTextColor(ContextCompat.getColor(holder.itemView.context, R.color.success))
            } else {
                holder.b.tvTxAmount.text = "- Rp ${fmt.format(amount)}"
                holder.b.tvTxAmount.setTextColor(ContextCompat.getColor(holder.itemView.context, R.color.danger))
            }

            holder.b.btnTxPrint.setOnClickListener {
                onItemClick(tx)
            }

            holder.itemView.setOnClickListener {
                onItemClick(tx)
            }
        }

        override fun getItemCount() = list.size
    }
}