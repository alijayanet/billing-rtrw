package com.alijaya.customer.ui.tech

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.alijaya.customer.CustomerApplication
import com.alijaya.customer.R
import com.alijaya.customer.databinding.FragmentTechHomeBinding
import com.alijaya.customer.databinding.ItemTechTaskBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

data class TechTaskItem(
    val id: Int,
    val customerName: String,
    val customerPhone: String,
    val customerAddress: String,
    val subject: String,
    val message: String,
    val status: String,
    val notes: String,
    val createdAt: String,
    val isAssignedToMe: Boolean,
    val isOpenPool: Boolean
)

class TechHomeFragment : Fragment() {
    private var _binding: FragmentTechHomeBinding? = null
    private val binding get() = _binding!!

    private var allAssignedTasks = mutableListOf<TechTaskItem>()
    private var allOpenTasks = mutableListOf<TechTaskItem>()
    private var allResolvedTasks = mutableListOf<TechTaskItem>()
    private var displayedTasks = mutableListOf<TechTaskItem>()
    private lateinit var adapter: TechTasksAdapter
    private var currentFilterMode = 0 // 0 = Assigned, 1 = Open Pool, 2 = All, 3 = Resolved

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
        _binding = FragmentTechHomeBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        binding.tvTechName.text = CustomerApplication.sessionManager.getCustomerName().ifEmpty { "Teknisi Lapangan" }

        adapter = TechTasksAdapter(
            tasks = displayedTasks,
            onWhatsAppClick = { task -> openWhatsApp(task) },
            onMapsClick = { task -> openMaps(task) },
            onActionClick = { task -> handleTaskAction(task) }
        )

        binding.rvTechTasks.layoutManager = LinearLayoutManager(context)
        binding.rvTechTasks.adapter = adapter

        binding.swipeRefresh.setOnRefreshListener { fetchDashboardData() }

        binding.btnTechCreateCustomer.setOnClickListener {
            parentFragmentManager.beginTransaction()
                .replace(R.id.fragment_container, TechCreateCustomerFragment())
                .addToBackStack(null).commit()
        }

        binding.btnTechMap.setOnClickListener {
            parentFragmentManager.beginTransaction()
                .replace(R.id.fragment_container, com.alijaya.customer.ui.map.NetworkMapFragment())
                .addToBackStack(null).commit()
        }

        binding.btnTechAttendance.setOnClickListener {
            parentFragmentManager.beginTransaction()
                .replace(R.id.fragment_container, TechAttendanceFragment())
                .addToBackStack(null).commit()
        }

        setupFilterButtons()
        fetchDashboardData()
    }

    private fun setupFilterButtons() {
        binding.btnFilterAssigned.setOnClickListener {
            currentFilterMode = 0
            updateFilterButtonStyles()
            applyFilter()
        }
        binding.btnFilterOpen.setOnClickListener {
            currentFilterMode = 1
            updateFilterButtonStyles()
            applyFilter()
        }
        binding.btnFilterAll.setOnClickListener {
            currentFilterMode = 2
            updateFilterButtonStyles()
            applyFilter()
        }
        binding.btnFilterResolved.setOnClickListener {
            currentFilterMode = 3
            updateFilterButtonStyles()
            applyFilter()
        }
    }

    private fun updateFilterButtonStyles() {
        val activeBg = android.graphics.Color.parseColor("#2563EB")
        val inactiveBg = android.graphics.Color.parseColor("#334155")

        val buttons = listOf(binding.btnFilterAssigned, binding.btnFilterOpen, binding.btnFilterAll, binding.btnFilterResolved)
        for (i in buttons.indices) {
            val isActive = i == currentFilterMode
            buttons[i].backgroundTintList = android.content.res.ColorStateList.valueOf(if (isActive) activeBg else inactiveBg)
            buttons[i].setTextColor(if (isActive) android.graphics.Color.WHITE else android.graphics.Color.parseColor("#CBD5E1"))
        }
    }

    private fun applyFilter() {
        displayedTasks.clear()
        when (currentFilterMode) {
            0 -> displayedTasks.addAll(allAssignedTasks)
            1 -> displayedTasks.addAll(allOpenTasks)
            2 -> {
                displayedTasks.addAll(allAssignedTasks)
                displayedTasks.addAll(allOpenTasks)
            }
            3 -> displayedTasks.addAll(allResolvedTasks)
        }
        adapter.notifyDataSetChanged()

        if (displayedTasks.isEmpty()) {
            binding.layoutEmptyTasks.visibility = View.VISIBLE
            binding.rvTechTasks.visibility = View.GONE
        } else {
            binding.layoutEmptyTasks.visibility = View.GONE
            binding.rvTechTasks.visibility = View.VISIBLE
        }
    }

    private fun fetchDashboardData() {
        binding.swipeRefresh.isRefreshing = true
        lifecycleScope.launch {
            val techId = CustomerApplication.sessionManager.getCustomerId()
            val url = "${getBaseUrl()}/api/customer/app/tech/dashboard?techId=${if (techId > 0) techId else 1}"
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
                        val tech = data.optJSONObject("tech")
                        if (tech != null) {
                            val name = tech.optString("name", "Teknisi Lapangan")
                            val area = tech.optString("area", "Semua Area")
                            binding.tvTechName.text = "$name (Online)"
                            binding.tvTechArea.text = "📍 Area: $area"
                        }

                        val stats = data.optJSONObject("stats")
                        if (stats != null) {
                            binding.tvCountAssigned.text = stats.optInt("inProgress", 0).toString()
                            binding.tvCountOpen.text = stats.optInt("open", 0).toString()
                            binding.tvCountResolved.text = stats.optInt("resolved", 0).toString()
                        }

                        allAssignedTasks.clear()
                        val assignedArr = data.optJSONArray("assignedTickets") ?: JSONArray()
                        for (i in 0 until assignedArr.length()) {
                            val item = assignedArr.getJSONObject(i)
                            allAssignedTasks.add(parseTaskItem(item, isAssigned = true, isOpen = false))
                        }

                        allOpenTasks.clear()
                        val openArr = data.optJSONArray("openTickets") ?: JSONArray()
                        for (i in 0 until openArr.length()) {
                            val item = openArr.getJSONObject(i)
                            allOpenTasks.add(parseTaskItem(item, isAssigned = false, isOpen = true))
                        }

                        allResolvedTasks.clear()
                        val resolvedArr = data.optJSONArray("resolvedTickets") ?: JSONArray()
                        for (i in 0 until resolvedArr.length()) {
                            val item = resolvedArr.getJSONObject(i)
                            allResolvedTasks.add(parseTaskItem(item, isAssigned = false, isOpen = false))
                        }

                        applyFilter()
                    }
                } catch (_: Exception) {}
            }
        }
    }

    private fun parseTaskItem(obj: JSONObject, isAssigned: Boolean, isOpen: Boolean): TechTaskItem {
        return TechTaskItem(
            id = obj.optInt("id", 0),
            customerName = obj.optString("customer_name", "Pelanggan"),
            customerPhone = obj.optString("customer_phone", "-"),
            customerAddress = obj.optString("customer_address", "Alamat Belum Terisi"),
            subject = obj.optString("subject", obj.optString("title", "Keluhan Teknis")),
            message = obj.optString("message", obj.optString("description", "-")),
            status = obj.optString("status", "open"),
            notes = obj.optString("technician_notes", ""),
            createdAt = obj.optString("created_at", "-"),
            isAssignedToMe = isAssigned,
            isOpenPool = isOpen
        )
    }

    private fun openWhatsApp(task: TechTaskItem) {
        val phone = task.customerPhone.replace(Regex("[^0-9]"), "")
        if (phone.isEmpty()) {
            Toast.makeText(context, "Nomor WhatsApp pelanggan tidak tersedia", Toast.LENGTH_SHORT).show()
            return
        }
        val targetPhone = if (phone.startsWith("0")) "62" + phone.substring(1) else phone
        val techName = CustomerApplication.sessionManager.getCustomerName().ifEmpty { "Teknisi" }
        val msg = "Halo Bapak/Ibu ${task.customerName}, saya $techName dari Tim Teknisi ISP Alijaya terkait tiket keluhan #${task.id} (${task.subject}). Apakah saat ini dapat dikunjungi untuk pengecekan?"
        val uri = Uri.parse("https://wa.me/$targetPhone?text=" + URLEncoder.encode(msg, "UTF-8"))
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri))
        } catch (_: Exception) {
            Toast.makeText(context, "Aplikasi WhatsApp tidak ditemukan", Toast.LENGTH_SHORT).show()
        }
    }

    private fun openMaps(task: TechTaskItem) {
        val addr = task.customerAddress
        if (addr.isBlank() || addr == "-") {
            Toast.makeText(context, "Alamat pelanggan belum tersedia", Toast.LENGTH_SHORT).show()
            return
        }
        val uri = Uri.parse("geo:0,0?q=" + URLEncoder.encode(addr, "UTF-8"))
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri))
        } catch (_: Exception) {
            Toast.makeText(context, "Membuka Google Maps...", Toast.LENGTH_SHORT).show()
        }
    }

    private fun handleTaskAction(task: TechTaskItem) {
        if (task.isOpenPool) {
            // Ambil tiket
            AlertDialog.Builder(requireContext())
                .setTitle("✋ Ambil Tugas SPK #${task.id}")
                .setMessage("Apakah Anda ingin mengambil tugas keluhan untuk pelanggan ${task.customerName}?")
                .setPositiveButton("Ambil Tugas") { _, _ -> takeTicket(task.id) }
                .setNegativeButton("Batal", null)
                .show()
        } else if (task.status == "open") {
            // Mulai pengerjaan
            updateTicketStatus(task.id, "in_progress", "Mulai pengerjaan oleh teknisi.")
        } else if (task.status == "in_progress") {
            // Selesaikan tiket dengan catatan
            showCompleteDialog(task)
        } else {
            Toast.makeText(context, "Tiket #${task.id} sudah selesai.", Toast.LENGTH_SHORT).show()
        }
    }

    private fun showCompleteDialog(task: TechTaskItem) {
        val ctx = context ?: return
        val layout = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(50, 30, 50, 10)
        }
        val etNotes = EditText(ctx).apply {
            hint = "Catatan perbaikan / hasil pekerjaan (cth: Kabel diganti, redaman normal)"
            minLines = 2
        }
        layout.addView(etNotes)

        AlertDialog.Builder(ctx)
            .setTitle("✅ Selesaikan Tiket #${task.id}")
            .setMessage("Selesaikan tiket untuk ${task.customerName}. Notifikasi otomatis akan dikirim ke WhatsApp pelanggan.")
            .setView(layout)
            .setPositiveButton("Selesaikan") { _, _ ->
                val notes = etNotes.text.toString().trim().ifEmpty { "Perbaikan selesai dilakukan dan layanan telah normal." }
                updateTicketStatus(task.id, "resolved", notes)
            }
            .setNegativeButton("Batal", null)
            .show()
    }

    private fun takeTicket(ticketId: Int) {
        lifecycleScope.launch {
            val techId = CustomerApplication.sessionManager.getCustomerId()
            val url = "${getBaseUrl()}/api/customer/app/tech/tickets/take"
            val bodyJson = JSONObject().apply {
                put("ticketId", ticketId)
                put("techId", if (techId > 0) techId else 1)
            }.toString()

            val respStr = withContext(Dispatchers.IO) {
                try {
                    val body = bodyJson.toRequestBody("application/json".toMediaType())
                    val req = Request.Builder().url(url)
                        .addHeader("Authorization", "Bearer ${getToken()}")
                        .post(body).build()
                    val resp = httpClient().newCall(req).execute()
                    resp.body?.string()
                } catch (_: Exception) { null }
            }

            if (respStr != null) {
                try {
                    val json = JSONObject(respStr)
                    val msg = json.optString("message", "Tiket #$ticketId berhasil diambil!")
                    if (json.optBoolean("success", true)) {
                        Toast.makeText(context, "✅ $msg", Toast.LENGTH_SHORT).show()
                        fetchDashboardData()
                    } else {
                        Toast.makeText(context, "⚠️ $msg", Toast.LENGTH_LONG).show()
                    }
                } catch (_: Exception) {
                    Toast.makeText(context, "Tiket #$ticketId berhasil diambil!", Toast.LENGTH_SHORT).show()
                    fetchDashboardData()
                }
            } else {
                Toast.makeText(context, "Gagal mengambil tiket. Periksa koneksi.", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun updateTicketStatus(ticketId: Int, status: String, notes: String) {
        lifecycleScope.launch {
            val techId = CustomerApplication.sessionManager.getCustomerId()
            val url = "${getBaseUrl()}/api/customer/app/tech/tickets/update"
            val bodyJson = JSONObject().apply {
                put("ticketId", ticketId)
                put("techId", if (techId > 0) techId else 1)
                put("status", status)
                put("notes", notes)
            }.toString()

            val respStr = withContext(Dispatchers.IO) {
                try {
                    val body = bodyJson.toRequestBody("application/json".toMediaType())
                    val req = Request.Builder().url(url)
                        .addHeader("Authorization", "Bearer ${getToken()}")
                        .post(body).build()
                    val resp = httpClient().newCall(req).execute()
                    resp.body?.string()
                } catch (_: Exception) { null }
            }

            if (respStr != null) {
                try {
                    val json = JSONObject(respStr)
                    val msg = json.optString("message", "Status tiket berhasil diperbarui!")
                    if (json.optBoolean("success", true)) {
                        Toast.makeText(context, "✅ $msg", Toast.LENGTH_SHORT).show()
                        fetchDashboardData()
                    } else {
                        Toast.makeText(context, "⚠️ $msg", Toast.LENGTH_LONG).show()
                    }
                } catch (_: Exception) {
                    Toast.makeText(context, "Status tiket #$ticketId berhasil diperbarui!", Toast.LENGTH_SHORT).show()
                    fetchDashboardData()
                }
            } else {
                Toast.makeText(context, "Gagal memperbarui status tiket", Toast.LENGTH_SHORT).show()
            }
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}

class TechTasksAdapter(
    private val tasks: List<TechTaskItem>,
    private val onWhatsAppClick: (TechTaskItem) -> Unit,
    private val onMapsClick: (TechTaskItem) -> Unit,
    private val onActionClick: (TechTaskItem) -> Unit
) : RecyclerView.Adapter<TechTasksAdapter.ViewHolder>() {

    class ViewHolder(val binding: ItemTechTaskBinding) : RecyclerView.ViewHolder(binding.root)

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): ViewHolder {
        val binding = ItemTechTaskBinding.inflate(LayoutInflater.from(parent.context), parent, false)
        return ViewHolder(binding)
    }

    override fun onBindViewHolder(holder: ViewHolder, position: Int) {
        val task = tasks[position]
        val b = holder.binding

        b.tvTaskId.text = "Tiket #${task.id}"
        b.tvCustomerName.text = task.customerName
        b.tvCustomerPhone.text = "📞 " + task.customerPhone
        b.tvCustomerAddress.text = "📍 " + task.customerAddress
        b.tvTaskSubject.text = task.subject
        b.tvTaskMessage.text = task.message
        b.tvTaskDate.text = "Waktu: " + task.createdAt

        if (task.notes.isNotBlank() && task.notes != "-") {
            b.tvTaskNotes.visibility = View.VISIBLE
            b.tvTaskNotes.text = "Catatan: " + task.notes
        } else {
            b.tvTaskNotes.visibility = View.GONE
        }

        // Status Badge & Action Button styling
        when (task.status) {
            "resolved", "closed" -> {
                b.tvTaskStatus.text = "🟢 SELESAI"
                b.tvTaskStatus.setTextColor(android.graphics.Color.WHITE)
                b.tvTaskStatus.setBackgroundColor(android.graphics.Color.parseColor("#16A34A"))
                b.btnTaskAction.text = "✔ Selesai"
                b.btnTaskAction.backgroundTintList = android.content.res.ColorStateList.valueOf(android.graphics.Color.parseColor("#334155"))
                b.btnTaskAction.setTextColor(android.graphics.Color.parseColor("#94A3B8"))
                b.btnTaskAction.isEnabled = false
                b.btnTaskAction.alpha = 0.7f
            }
            "in_progress" -> {
                b.tvTaskStatus.text = "🔵 DIPROSES"
                b.tvTaskStatus.setTextColor(android.graphics.Color.WHITE)
                b.tvTaskStatus.setBackgroundColor(android.graphics.Color.parseColor("#2563EB"))
                b.btnTaskAction.text = "✅ Selesaikan"
                b.btnTaskAction.backgroundTintList = android.content.res.ColorStateList.valueOf(android.graphics.Color.parseColor("#16A34A"))
                b.btnTaskAction.setTextColor(android.graphics.Color.WHITE)
                b.btnTaskAction.isEnabled = true
                b.btnTaskAction.alpha = 1.0f
            }
            else -> {
                if (task.isOpenPool) {
                    b.tvTaskStatus.text = "🟡 POOL BARU"
                    b.tvTaskStatus.setTextColor(android.graphics.Color.WHITE)
                    b.tvTaskStatus.setBackgroundColor(android.graphics.Color.parseColor("#D97706"))
                    b.btnTaskAction.text = "✋ Ambil Tugas"
                    b.btnTaskAction.backgroundTintList = android.content.res.ColorStateList.valueOf(android.graphics.Color.parseColor("#D97706"))
                    b.btnTaskAction.setTextColor(android.graphics.Color.WHITE)
                } else {
                    b.tvTaskStatus.text = "🟣 DITUGASKAN"
                    b.tvTaskStatus.setTextColor(android.graphics.Color.WHITE)
                    b.tvTaskStatus.setBackgroundColor(android.graphics.Color.parseColor("#7C3AED"))
                    b.btnTaskAction.text = "⚙ Mulai Proses"
                    b.btnTaskAction.backgroundTintList = android.content.res.ColorStateList.valueOf(android.graphics.Color.parseColor("#2563EB"))
                    b.btnTaskAction.setTextColor(android.graphics.Color.WHITE)
                }
                b.btnTaskAction.isEnabled = true
                b.btnTaskAction.alpha = 1.0f
            }
        }

        b.btnTaskWhatsapp.setOnClickListener { onWhatsAppClick(task) }
        b.btnTaskMaps.setOnClickListener { onMapsClick(task) }
        b.btnTaskAction.setOnClickListener { onActionClick(task) }
    }

    override fun getItemCount(): Int = tasks.size
}
