package net.alijaya.nocdisplay.model

data class SystemResource(
    val cpuLoad: Int = 0,
    val freeMemory: Long = 0L,
    val totalMemory: Long = 0L,
    val cpuCount: Int = 1,
    val cpuFrequency: Int = 0,
    val uptime: String = "-",
    val boardName: String = "MikroTik",
    val version: String = "-"
) {
    val usedMemory: Long
        get() = (totalMemory - freeMemory).coerceAtLeast(0L)

    val ramPercent: Int
        get() = if (totalMemory > 0) ((usedMemory.toDouble() / totalMemory) * 100).toInt() else 0

    val freeMemoryMb: Long
        get() = freeMemory / (1024 * 1024)

    val totalMemoryMb: Long
        get() = totalMemory / (1024 * 1024)

    val usedMemoryMb: Long
        get() = usedMemory / (1024 * 1024)
}

data class SystemHealth(
    val temperature: Double? = null,
    val voltage: Double? = null
)

data class InterfaceInfo(
    val id: String = "",
    val name: String = "",
    val type: String = "ether",
    val running: Boolean = false,
    val disabled: Boolean = false,
    val comment: String = "",
    val rxBytes: Long = 0L,
    val txBytes: Long = 0L,
    val rxBps: Long = 0L,
    val txBps: Long = 0L
) {
    val rxMbps: Double
        get() = (rxBps * 8.0) / 1_000_000.0

    val txMbps: Double
        get() = (txBps * 8.0) / 1_000_000.0
}

data class WanTrafficPoint(
    val timestamp: Long = System.currentTimeMillis(),
    val rxMbps: Double = 0.0,
    val txMbps: Double = 0.0
)

data class NocSnapshot(
    val isConnected: Boolean = false,
    val connectionError: String? = null,
    val routerIp: String = "",
    val resource: SystemResource = SystemResource(),
    val health: SystemHealth = SystemHealth(),
    val pppoeCount: Int = 0,
    val hotspotCount: Int = 0,
    val interfaces: List<InterfaceInfo> = emptyList(),
    val wanInterfaceName: String = "ether1-ISP",
    val wanRxMbps: Double = 0.0,
    val wanTxMbps: Double = 0.0,
    val peakRxMbps: Double = 0.0,
    val peakTxMbps: Double = 0.0,
    val lastUpdated: Long = System.currentTimeMillis()
)
