package net.alijaya.nocdisplay.mikrotik

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import net.alijaya.nocdisplay.model.InterfaceInfo
import net.alijaya.nocdisplay.model.NocSnapshot
import net.alijaya.nocdisplay.model.SystemHealth
import net.alijaya.nocdisplay.model.SystemResource
import net.alijaya.nocdisplay.settings.AppSettings

class MikrotikRepository(private val settings: AppSettings) {

    private var client: MikrotikSocketClient? = null
    private val previousBytesMap = mutableMapOf<String, ByteStamp>()
    private var peakRx = 0.0
    private var peakTx = 0.0

    private data class ByteStamp(
        val rxBytes: Long,
        val txBytes: Long,
        val timestamp: Long
    )

    suspend fun fetchSnapshot(): NocSnapshot = withContext(Dispatchers.IO) {
        val host = settings.host
        val port = settings.port
        val user = settings.username
        val pass = settings.password

        try {
            var activeClient = client
            if (activeClient == null || !activeClient.isConnected) {
                activeClient?.close()
                activeClient = MikrotikSocketClient(host, port, timeoutMs = 4000)
                val ok = activeClient.connect(user, pass)
                if (!ok) {
                    activeClient.close()
                    return@withContext NocSnapshot(
                        isConnected = false,
                        connectionError = "Autentikasi gagal. Cek user/password MikroTik.",
                        routerIp = host
                    )
                }
                client = activeClient
            }

            // 1. System Resource
            val resList = activeClient.execute(listOf("/system/resource/print"))
            val resMap = resList.firstOrNull() ?: emptyMap()
            val resource = SystemResource(
                cpuLoad = resMap["cpu-load"]?.toIntOrNull() ?: 0,
                freeMemory = resMap["free-memory"]?.toLongOrNull() ?: 0L,
                totalMemory = resMap["total-memory"]?.toLongOrNull() ?: 0L,
                cpuCount = resMap["cpu-count"]?.toIntOrNull() ?: 1,
                cpuFrequency = resMap["cpu-frequency"]?.toIntOrNull() ?: 0,
                uptime = resMap["uptime"] ?: "-",
                boardName = resMap["board-name"] ?: "MikroTik",
                version = resMap["version"] ?: "-"
            )

            // 2. System Health
            var health = SystemHealth()
            try {
                val healthList = activeClient.execute(listOf("/system/health/print"))
                val healthMap = healthList.firstOrNull() ?: emptyMap()
                val temp = healthMap["temperature"]?.toDoubleOrNull() ?: healthMap["cpu-temperature"]?.toDoubleOrNull()
                val volt = healthMap["voltage"]?.toDoubleOrNull()
                health = SystemHealth(temp, volt)
            } catch (_: Exception) {}

            // 3. PPPoE Active Count
            var pppoeCount = 0
            try {
                val pppList = activeClient.execute(listOf("/ppp/active/print"))
                pppoeCount = pppList.size
            } catch (_: Exception) {}

            // 4. Hotspot Active Count
            var hotspotCount = 0
            try {
                val hsList = activeClient.execute(listOf("/ip/hotspot/active/print"))
                hotspotCount = hsList.size
            } catch (_: Exception) {}

            // 5. Interfaces & Traffic Delta
            val ifListRaw = activeClient.execute(listOf("/interface/print", "=.proplist=.id,name,type,running,disabled,comment,rx-byte,tx-byte"))
            val now = System.currentTimeMillis()
            val parsedInterfaces = mutableListOf<InterfaceInfo>()

            var wanRx = 0.0
            var wanTx = 0.0
            val targetWan = settings.wanInterface.ifEmpty { "ether1-ISP" }

            for (raw in ifListRaw) {
                val name = raw["name"] ?: continue
                val type = raw["type"] ?: "ether"
                val running = raw["running"]?.toBoolean() ?: false
                val disabled = raw["disabled"]?.toBoolean() ?: false
                val comment = raw["comment"] ?: ""
                val rxBytes = raw["rx-byte"]?.toLongOrNull() ?: 0L
                val txBytes = raw["tx-byte"]?.toLongOrNull() ?: 0L

                var rxBps = 0L
                var txBps = 0L

                val prev = previousBytesMap[name]
                if (prev != null) {
                    val dtSec = (now - prev.timestamp) / 1000.0
                    if (dtSec > 0.4) {
                        val dRx = (rxBytes - prev.rxBytes).coerceAtLeast(0L)
                        val dTx = (txBytes - prev.txBytes).coerceAtLeast(0L)
                        rxBps = ((dRx * 8.0) / dtSec).toLong()
                        txBps = ((dTx * 8.0) / dtSec).toLong()
                    }
                }
                previousBytesMap[name] = ByteStamp(rxBytes, txBytes, now)

                val ifInfo = InterfaceInfo(
                    id = raw[".id"] ?: "",
                    name = name,
                    type = type,
                    running = running,
                    disabled = disabled,
                    comment = comment,
                    rxBytes = rxBytes,
                    txBytes = txBytes,
                    rxBps = rxBps,
                    txBps = txBps
                )

                // Only keep physical, SFP, bonding, and VLANs for the matrix (avoid flooding with 200+ pppoe-in)
                if (!type.startsWith("pppoe") && !type.startsWith("ovpn") && !type.startsWith("sstp")) {
                    parsedInterfaces.add(ifInfo)
                }

                // Check WAN
                if (name.equals(targetWan, ignoreCase = true) || (name.contains("ISP", ignoreCase = true) && wanRx == 0.0)) {
                    wanRx = ifInfo.rxMbps
                    wanTx = ifInfo.txMbps
                }
            }

            // Fallback WAN if not matched by name: pick physical interface with highest RX
            if (wanRx == 0.0 && parsedInterfaces.isNotEmpty()) {
                val highestRx = parsedInterfaces.maxByOrNull { it.rxMbps }
                if (highestRx != null && highestRx.rxMbps > 0.0) {
                    wanRx = highestRx.rxMbps
                    wanTx = highestRx.txMbps
                }
            }

            if (wanRx > peakRx) peakRx = wanRx
            if (wanTx > peakTx) peakTx = wanTx

            return@withContext NocSnapshot(
                isConnected = true,
                connectionError = null,
                routerIp = host,
                resource = resource,
                health = health,
                pppoeCount = pppoeCount,
                hotspotCount = hotspotCount,
                interfaces = parsedInterfaces,
                wanInterfaceName = targetWan,
                wanRxMbps = wanRx,
                wanTxMbps = wanTx,
                peakRxMbps = peakRx,
                peakTxMbps = peakTx,
                lastUpdated = now
            )
        } catch (e: Exception) {
            client?.close()
            client = null
            return@withContext NocSnapshot(
                isConnected = false,
                connectionError = e.message ?: "Koneksi ke MikroTik terputus",
                routerIp = host
            )
        }
    }

    suspend fun testConnection(host: String, port: Int, user: String, pass: String): Pair<Boolean, String> =
        withContext(Dispatchers.IO) {
            var testClient: MikrotikSocketClient? = null
            try {
                testClient = MikrotikSocketClient(host, port, timeoutMs = 3000)
                val ok = testClient.connect(user, pass)
                if (!ok) {
                    return@withContext Pair(false, "Login ditolak. Periksa username dan password!")
                }
                val res = testClient.execute(listOf("/system/resource/print"))
                val board = res.firstOrNull()?.get("board-name") ?: "MikroTik"
                Pair(true, "Terhubung sukses ke $board ($host:$port)!")
            } catch (e: Exception) {
                Pair(false, "Koneksi gagal: ${e.message}")
            } finally {
                testClient?.close()
            }
        }

    fun close() {
        client?.close()
        client = null
    }
}
