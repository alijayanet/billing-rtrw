package com.alijaya.customer.ui.tech

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Toast
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.alijaya.customer.CustomerApplication
import com.alijaya.customer.R
import com.alijaya.customer.databinding.FragmentTechOdpBinding
import com.alijaya.customer.databinding.ItemTechOdpBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

data class OdpItem(
    val id: Int,
    val name: String,
    val area: String,
    val capacity: Int,
    val used: Int,
    val lat: String,
    val lng: String
)

class TechOdpFragment : Fragment() {
    private var _binding: FragmentTechOdpBinding? = null
    private val binding get() = _binding!!

    private val allOdps = mutableListOf<OdpItem>()
    private val displayedOdps = mutableListOf<OdpItem>()
    private lateinit var adapter: OdpAdapter

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
        _binding = FragmentTechOdpBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        adapter = OdpAdapter(displayedOdps) { odp ->
            openMapsToOdp(odp)
        }

        binding.rvOdps.layoutManager = LinearLayoutManager(context)
        binding.rvOdps.adapter = adapter

        binding.swipeRefresh.setOnRefreshListener { fetchOdps() }

        binding.etSearchOdp.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
                filterOdps(s.toString())
            }
            override fun afterTextChanged(s: Editable?) {}
        })

        fetchOdps()
    }

    private fun filterOdps(query: String) {
        displayedOdps.clear()
        if (query.isBlank()) {
            displayedOdps.addAll(allOdps)
        } else {
            val q = query.lowercase().trim()
            displayedOdps.addAll(allOdps.filter {
                it.name.lowercase().contains(q) || it.area.lowercase().contains(q)
            })
        }
        adapter.notifyDataSetChanged()
    }

    private fun fetchOdps() {
        binding.swipeRefresh.isRefreshing = true
        lifecycleScope.launch {
            val url = "${getBaseUrl()}/api/customer/app/tech/odps"
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
                    allOdps.clear()
                    var totalCap = 0
                    var totalUsed = 0

                    for (i in 0 until arr.length()) {
                        val obj = arr.getJSONObject(i)
                        val cap = obj.optInt("capacity", obj.optInt("port_capacity", 16))
                        val used = obj.optInt("used_ports", obj.optInt("used", 0))
                        totalCap += cap
                        totalUsed += used

                        allOdps.add(
                            OdpItem(
                                id = obj.optInt("id", 0),
                                name = obj.optString("name", "ODP"),
                                area = obj.optString("area", obj.optString("address", "Area Lapangan")),
                                capacity = cap,
                                used = used,
                                lat = obj.optString("lat", obj.optString("latitude", "")),
                                lng = obj.optString("lng", obj.optString("longitude", ""))
                            )
                        )
                    }

                    binding.tvOdpSummary.text = "Total ${allOdps.size} ODP | $totalUsed / $totalCap Port Terpakai"
                    filterOdps(binding.etSearchOdp.text.toString())
                } catch (_: Exception) {}
            }
        }
    }

    private fun openMapsToOdp(odp: OdpItem) {
        val geoUri = if (odp.lat.isNotBlank() && odp.lng.isNotBlank() && odp.lat != "0") {
            Uri.parse("geo:${odp.lat},${odp.lng}?q=${odp.lat},${odp.lng}(${URLEncoder.encode(odp.name, "UTF-8")})")
        } else {
            Uri.parse("geo:0,0?q=" + URLEncoder.encode("ODP ${odp.name} ${odp.area}", "UTF-8"))
        }
        try {
            startActivity(Intent(Intent.ACTION_VIEW, geoUri))
        } catch (_: Exception) {
            Toast.makeText(context, "Membuka Google Maps ke ${odp.name}...", Toast.LENGTH_SHORT).show()
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}

class OdpAdapter(
    private val odps: List<OdpItem>,
    private val onMapsClick: (OdpItem) -> Unit
) : RecyclerView.Adapter<OdpAdapter.ViewHolder>() {

    class ViewHolder(val binding: ItemTechOdpBinding) : RecyclerView.ViewHolder(binding.root)

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): ViewHolder {
        val binding = ItemTechOdpBinding.inflate(LayoutInflater.from(parent.context), parent, false)
        return ViewHolder(binding)
    }

    override fun onBindViewHolder(holder: ViewHolder, position: Int) {
        val odp = odps[position]
        val b = holder.binding

        b.tvOdpName.text = odp.name
        b.tvOdpArea.text = "📍 " + odp.area
        val sisa = odp.capacity - odp.used
        b.tvOdpPorts.text = "🔌 ${odp.used} / ${odp.capacity} Port Terpakai (Sisa $sisa Port)"

        if (odp.lat.isNotBlank() && odp.lng.isNotBlank()) {
            b.tvOdpCoords.text = "${odp.lat}, ${odp.lng}"
            b.tvOdpCoords.visibility = View.VISIBLE
        } else {
            b.tvOdpCoords.visibility = View.GONE
        }

        val ctx = holder.itemView.context
        if (sisa <= 0) {
            b.tvOdpStatusBadge.text = "Penuh"
            b.tvOdpStatusBadge.setBackgroundColor(ContextCompat.getColor(ctx, R.color.danger))
        } else {
            b.tvOdpStatusBadge.text = "Tersedia"
            b.tvOdpStatusBadge.setBackgroundColor(ContextCompat.getColor(ctx, R.color.success))
        }

        b.btnOdpMaps.setOnClickListener { onMapsClick(odp) }
    }

    override fun getItemCount(): Int = odps.size
}
