package net.alijaya.nocdisplay.ui.theme

import android.graphics.Color

enum class ThemeMode(val title: String) {
    CYBERPUNK_NEON("Cyberpunk Neon"),
    EMERALD_MATRIX("Emerald Matrix"),
    SAPPHIRE_BLUE("Sapphire Blue"),
    AMOLED_DARK("AMOLED Pure Dark"),
    AMBER_SUNSET("Amber Sunset")
}

data class ThemePalette(
    val bg: Int,
    val surface: Int,
    val cardBg: Int,
    val cardBorder: Int,
    val primaryRx: Int,
    val secondaryTx: Int,
    val accent: Int,
    val textPrimary: Int,
    val textSecondary: Int,
    val textMuted: Int,
    val glowColor: Int,
    val gridLine: Int,
    val gaugeTrack: Int
)

object NocTheme {

    fun getPalette(mode: ThemeMode): ThemePalette {
        return when (mode) {
            ThemeMode.CYBERPUNK_NEON -> ThemePalette(
                bg = Color.parseColor("#070B14"),
                surface = Color.parseColor("#0B132B"),
                cardBg = Color.parseColor("#0D1730"),
                cardBorder = Color.parseColor("#1C2C4E"),
                primaryRx = Color.parseColor("#00F2FE"),
                secondaryTx = Color.parseColor("#10B981"),
                accent = Color.parseColor("#FF007F"),
                textPrimary = Color.parseColor("#F8FAFC"),
                textSecondary = Color.parseColor("#94A3B8"),
                textMuted = Color.parseColor("#64748B"),
                glowColor = Color.parseColor("#00F2FE"),
                gridLine = Color.parseColor("#142240"),
                gaugeTrack = Color.parseColor("#1A294A")
            )
            ThemeMode.EMERALD_MATRIX -> ThemePalette(
                bg = Color.parseColor("#020D06"),
                surface = Color.parseColor("#051C0E"),
                cardBg = Color.parseColor("#082B16"),
                cardBorder = Color.parseColor("#114D28"),
                primaryRx = Color.parseColor("#00FF66"),
                secondaryTx = Color.parseColor("#39FF14"),
                accent = Color.parseColor("#22C55E"),
                textPrimary = Color.parseColor("#DCFCE7"),
                textSecondary = Color.parseColor("#86EFAC"),
                textMuted = Color.parseColor("#4ADE80"),
                glowColor = Color.parseColor("#00FF66"),
                gridLine = Color.parseColor("#0B361B"),
                gaugeTrack = Color.parseColor("#0F3E22")
            )
            ThemeMode.SAPPHIRE_BLUE -> ThemePalette(
                bg = Color.parseColor("#03091E"),
                surface = Color.parseColor("#06133D"),
                cardBg = Color.parseColor("#0A1E5C"),
                cardBorder = Color.parseColor("#14358E"),
                primaryRx = Color.parseColor("#00A2FF"),
                secondaryTx = Color.parseColor("#00F0FF"),
                accent = Color.parseColor("#3B82F6"),
                textPrimary = Color.parseColor("#EFF6FF"),
                textSecondary = Color.parseColor("#93C5FD"),
                textMuted = Color.parseColor("#60A5FA"),
                glowColor = Color.parseColor("#00A2FF"),
                gridLine = Color.parseColor("#0F286E"),
                gaugeTrack = Color.parseColor("#132F7A")
            )
            ThemeMode.AMOLED_DARK -> ThemePalette(
                bg = Color.parseColor("#000000"),
                surface = Color.parseColor("#0A0A0A"),
                cardBg = Color.parseColor("#141414"),
                cardBorder = Color.parseColor("#2C2C2E"),
                primaryRx = Color.parseColor("#00E5FF"),
                secondaryTx = Color.parseColor("#30D158"),
                accent = Color.parseColor("#FF2D55"),
                textPrimary = Color.parseColor("#FFFFFF"),
                textSecondary = Color.parseColor("#E5E5EA"),
                textMuted = Color.parseColor("#8E8E93"),
                glowColor = Color.parseColor("#00E5FF"),
                gridLine = Color.parseColor("#1C1C1E"),
                gaugeTrack = Color.parseColor("#222224")
            )
            ThemeMode.AMBER_SUNSET -> ThemePalette(
                bg = Color.parseColor("#0D0A04"),
                surface = Color.parseColor("#1C1408"),
                cardBg = Color.parseColor("#2A1E0B"),
                cardBorder = Color.parseColor("#4A3514"),
                primaryRx = Color.parseColor("#FFAA00"),
                secondaryTx = Color.parseColor("#FFD700"),
                accent = Color.parseColor("#F59E0B"),
                textPrimary = Color.parseColor("#FFFBEB"),
                textSecondary = Color.parseColor("#FDE68A"),
                textMuted = Color.parseColor("#FBBF24"),
                glowColor = Color.parseColor("#FFAA00"),
                gridLine = Color.parseColor("#34250C"),
                gaugeTrack = Color.parseColor("#38270E")
            )
        }
    }
}
