package com.alijaya.customer.ui.tickets

import android.content.Intent
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.cardview.widget.CardView
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.alijaya.customer.R
import com.alijaya.customer.data.api.ApiClient
import com.alijaya.customer.databinding.FragmentTicketsBinding
import kotlinx.coroutines.launch

class TicketsFragment : Fragment() {
    private var _binding: FragmentTicketsBinding? = null
    private val binding get() = _binding!!

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentTicketsBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        binding.btnCreateTicket.setOnClickListener {
            startActivity(Intent(context, CreateTicketActivity::class.java))
        }

        binding.swipeRefresh.setOnRefreshListener { loadTickets() }
        loadTickets()
    }

    override fun onResume() {
        super.onResume()
        loadTickets()
    }

    private fun loadTickets() {
        binding.swipeRefresh.isRefreshing = true
        lifecycleScope.launch {
            try {
                val res = ApiClient.getService().getTickets()
                binding.layoutTicketList.removeAllViews()

                if (res.isSuccessful && res.body()?.success == true) {
                    val list = res.body()?.data ?: emptyList()
                    binding.tvEmpty.visibility = if (list.isEmpty()) View.VISIBLE else View.GONE

                    val ctx = context ?: return@launch

                    for (t in list) {
                        val card = CardView(ctx).apply {
                            radius = 28f
                            setCardBackgroundColor(ContextCompat.getColor(ctx, R.color.card_dark))
                            val params = LinearLayout.LayoutParams(
                                LinearLayout.LayoutParams.MATCH_PARENT,
                                LinearLayout.LayoutParams.WRAP_CONTENT
                            ).apply { setMargins(0, 0, 0, 24) }
                            layoutParams = params
                        }

                        val inner = LinearLayout(ctx).apply {
                            orientation = LinearLayout.VERTICAL
                            setPadding(32, 28, 32, 28)
                        }

                        val statusStr = when (t.status.lowercase()) {
                            "closed", "selesai" -> " Selesai"
                            "in_progress", "proses" -> " Sedang Dikerjakan"
                            else -> " Menunggu Teknisi"
                        }

                        val tvHeader = TextView(ctx).apply {
                            text = t.ticketNo + "  " + statusStr
                            setTextColor(ContextCompat.getColor(ctx, R.color.accent))
                            textSize = 12f
                            setTypeface(typeface, android.graphics.Typeface.BOLD)
                        }

                        val tvTitle = TextView(ctx).apply {
                            text = t.title
                            setTextColor(ContextCompat.getColor(ctx, R.color.text_white))
                            textSize = 15f
                            setTypeface(typeface, android.graphics.Typeface.BOLD)
                            setPadding(0, 6, 0, 4)
                        }

                        val tvDesc = TextView(ctx).apply {
                            text = t.description
                            setTextColor(ContextCompat.getColor(ctx, R.color.text_muted))
                            textSize = 12f
                        }

                        val tvDate = TextView(ctx).apply {
                            text = "Dilaporkan: " + t.createdAt
                            setTextColor(ContextCompat.getColor(ctx, R.color.text_muted))
                            textSize = 11f
                            setPadding(0, 10, 0, 0)
                        }

                        inner.addView(tvHeader)
                        inner.addView(tvTitle)
                        inner.addView(tvDesc)
                        inner.addView(tvDate)

                        card.addView(inner)
                        binding.layoutTicketList.addView(card)
                    }
                } else {
                    binding.tvEmpty.visibility = View.VISIBLE
                }
            } catch (e: Exception) {
                Toast.makeText(context, "Error: " + e.message, Toast.LENGTH_SHORT).show()
                binding.tvEmpty.visibility = View.VISIBLE
            } finally {
                binding.swipeRefresh.isRefreshing = false
            }
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}
