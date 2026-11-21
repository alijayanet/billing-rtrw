package net.alijaya.nocdisplay.ui.views

import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import net.alijaya.nocdisplay.R
import net.alijaya.nocdisplay.databinding.ItemInterfaceBinding
import net.alijaya.nocdisplay.model.InterfaceInfo

class InterfaceMatrixAdapter : ListAdapter<InterfaceInfo, InterfaceMatrixAdapter.ViewHolder>(DiffCallback) {

    private var primaryRxColor: Int = 0
    private var secondaryTxColor: Int = 0

    fun setThemeColors(rxColor: Int, txColor: Int) {
        this.primaryRxColor = rxColor
        this.secondaryTxColor = txColor
        notifyDataSetChanged()
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): ViewHolder {
        val binding = ItemInterfaceBinding.inflate(
            LayoutInflater.from(parent.context),
            parent,
            false
        )
        return ViewHolder(binding)
    }

    override fun onBindViewHolder(holder: ViewHolder, position: Int) {
        holder.bind(getItem(position))
    }

    inner class ViewHolder(private val binding: ItemInterfaceBinding) : RecyclerView.ViewHolder(binding.root) {
        fun bind(item: InterfaceInfo) {
            binding.tvInterfaceName.text = item.name

            // Status dot
            when {
                item.disabled -> {
                    binding.viewStatusDot.setBackgroundResource(R.drawable.shape_dot_gray)
                    binding.tvInterfaceName.alpha = 0.5f
                }
                item.running -> {
                    binding.viewStatusDot.setBackgroundResource(R.drawable.shape_dot_green)
                    binding.tvInterfaceName.alpha = 1.0f
                }
                else -> {
                    binding.viewStatusDot.setBackgroundResource(R.drawable.shape_dot_red)
                    binding.tvInterfaceName.alpha = 0.8f
                }
            }

            // RX / TX speed
            binding.tvRxSpeed.text = "↓ ${formatSpeed(item.rxMbps)}"
            binding.tvTxSpeed.text = "↑ ${formatSpeed(item.txMbps)}"

            if (primaryRxColor != 0) {
                binding.tvRxSpeed.setTextColor(primaryRxColor)
            }
            if (secondaryTxColor != 0) {
                binding.tvTxSpeed.setTextColor(secondaryTxColor)
            }
        }

        private fun formatSpeed(mbps: Double): String {
            return when {
                mbps >= 1000 -> "${String.format("%.1f", mbps / 1000)}G"
                mbps >= 1.0 -> "${String.format("%.1f", mbps)}M"
                mbps >= 0.01 -> "${(mbps * 1000).toInt()}K"
                else -> "0"
            }
        }
    }

    companion object DiffCallback : DiffUtil.ItemCallback<InterfaceInfo>() {
        override fun areItemsTheSame(oldItem: InterfaceInfo, newItem: InterfaceInfo): Boolean =
            oldItem.name == newItem.name

        override fun areContentsTheSame(oldItem: InterfaceInfo, newItem: InterfaceInfo): Boolean =
            oldItem == newItem
    }
}
