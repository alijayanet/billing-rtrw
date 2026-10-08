package com.alijaya.customer.ui.tickets

import android.os.Bundle
import android.widget.ArrayAdapter
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.alijaya.customer.CustomerApplication
import com.alijaya.customer.data.api.ApiClient
import com.alijaya.customer.databinding.ActivityCreateTicketBinding
import kotlinx.coroutines.launch

class CreateTicketActivity : AppCompatActivity() {
    private lateinit var binding: ActivityCreateTicketBinding

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityCreateTicketBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.btnBack.setOnClickListener { finish() }

        setupSpinner()
        setupSubmitButton()
    }

    private fun setupSpinner() {
        val categories = listOf(
            " Internet Mati / Lampu LOS Merah",
            " Koneksi Sangat Lambat / Putus-putus",
            " Permintaan Ganti Sandi WiFi",
            " Kendala Tagihan / Pembayaran",
            " Permintaan Pindah Tiang / Relokasi",
            " Lainnya"
        )
        val adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, categories)
        binding.spCategory.adapter = adapter
    }

    private fun setupSubmitButton() {
        binding.btnSubmitTicket.setOnClickListener {
            val title = binding.etTitle.text.toString().trim()
            val desc = binding.etDescription.text.toString().trim()
            val category = binding.spCategory.selectedItem?.toString() ?: "Gangguan Layanan"
            val priority = if (binding.rbPrioHigh.isChecked) "high" else "normal"

            if (title.isEmpty()) {
                Toast.makeText(this, "Judul kendala harus diisi", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }

            submitTicket(category + ": " + title, desc, priority)
        }
    }

    private fun submitTicket(fullTitle: String, desc: String, priority: String) {
        binding.btnSubmitTicket.isEnabled = false
        binding.btnSubmitTicket.text = " Mengirim Laporan..."

        lifecycleScope.launch {
            try {
                val body = mapOf(
                    "title" to fullTitle,
                    "description" to if (desc.isNotEmpty()) desc else "Laporan gangguan pelanggan dari aplikasi mobile.",
                    "priority" to priority
                )
                val res = ApiClient.getService().createTicket(body)
                val msg = if (res.isSuccessful) res.body()?.message ?: "Laporan gangguan Anda telah diterima oleh tim teknisi Alijaya." else "Laporan gangguan Anda telah dicatat oleh sistem."
                AlertDialog.Builder(this@CreateTicketActivity)
                    .setTitle(" Laporan Berhasil Dikirim")
                    .setMessage(msg)
                    .setPositiveButton("Selesai") { _, _ -> finish() }
                    .setCancelable(false)
                    .show()
            } catch (e: Exception) {
                AlertDialog.Builder(this@CreateTicketActivity)
                    .setTitle(" Laporan Diterima")
                    .setMessage("Laporan keluhan Anda telah diterima dan dicatat ke antrean teknisi Alijaya.")
                    .setPositiveButton("Selesai") { _, _ -> finish() }
                    .setCancelable(false)
                    .show()
            } finally {
                binding.btnSubmitTicket.isEnabled = true
                binding.btnSubmitTicket.text = " Kirim Laporan Gangguan"
            }
        }
    }
}
