package com.alijaya.customer.ui.invoices

import android.content.Intent
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.cardview.widget.CardView
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.alijaya.customer.R
import com.alijaya.customer.data.api.ApiClient
import com.alijaya.customer.databinding.FragmentInvoicesBinding
import kotlinx.coroutines.launch
import java.text.NumberFormat
import java.util.Locale

class InvoicesFragment : Fragment() {
    private var _binding: FragmentInvoicesBinding? = null
    private val binding get() = _binding!!

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentInvoicesBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        binding.swipeRefresh.setOnRefreshListener { loadInvoices() }
        loadInvoices()
    }

    override fun onResume() {
        super.onResume()
        loadInvoices()
    }

    private fun loadInvoices() {
        binding.swipeRefresh.isRefreshing = true
        lifecycleScope.launch {
            try {
                val res = ApiClient.getService().getInvoices()
                binding.layoutInvoiceList.removeAllViews()

                if (res.isSuccessful && res.body()?.success == true) {
                    val list = res.body()?.data ?: emptyList()
                    binding.tvEmpty.visibility = if (list.isEmpty()) View.VISIBLE else View.GONE

                    val ctx = context ?: return@launch
                    val fmt = NumberFormat.getCurrencyInstance(Locale("id", "ID"))

                    for (inv in list) {
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

                        val tvHeader = TextView(ctx).apply {
                            text = inv.invoiceNo + "  Periode " + inv.periodMonth + "/" + inv.periodYear
                            setTextColor(ContextCompat.getColor(ctx, R.color.accent))
                            textSize = 12f
                        }

                        val tvAmt = TextView(ctx).apply {
                            text = fmt.format(inv.amount)
                            setTextColor(ContextCompat.getColor(ctx, R.color.text_white))
                            textSize = 18f
                            setTypeface(typeface, android.graphics.Typeface.BOLD)
                            setPadding(0, 8, 0, 12)
                        }

                        val isPaid = inv.status == "paid" || inv.status == "lunas"

                        inner.addView(tvHeader)
                        inner.addView(tvAmt)

                        if (!isPaid) {
                            val btnPay = Button(ctx).apply {
                                text = " Bayar Tagihan (QRIS)"
                                setBackgroundColor(ContextCompat.getColor(ctx, R.color.primary))
                                setTextColor(ContextCompat.getColor(ctx, R.color.text_white))
                                setOnClickListener {
                                    val intent = Intent(ctx, PaymentActivity::class.java).apply {
                                        putExtra("invoice_id", inv.id)
                                    }
                                    startActivity(intent)
                                }
                            }
                            inner.addView(btnPay)
                        } else {
                            val tvStatus = TextView(ctx).apply {
                                text = " Lunas (" + (inv.paidAt ?: "Terbayar") + ")"
                                setTextColor(ContextCompat.getColor(ctx, R.color.success))
                                textSize = 13f
                                setTypeface(typeface, android.graphics.Typeface.BOLD)
                            }
                            inner.addView(tvStatus)
                        }

                        card.addView(inner)
                        binding.layoutInvoiceList.addView(card)
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
