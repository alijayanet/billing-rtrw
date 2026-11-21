package net.alijaya.nocdisplay.ui.views

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.DashPathEffect
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Shader
import android.util.AttributeSet
import android.view.View
import net.alijaya.nocdisplay.model.WanTrafficPoint
import java.util.LinkedList
import kotlin.math.max

class TrafficWaveView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0
) : View(context, attrs, defStyleAttr) {

    private val maxPoints = 35
    private val points = LinkedList<WanTrafficPoint>()

    private var primaryRxColor = Color.parseColor("#00F2FE")
    private var secondaryTxColor = Color.parseColor("#10B981")
    private var gridLineColor = Color.parseColor("#142240")
    private var textMutedColor = Color.parseColor("#64748B")
    private var textPrimaryColor = Color.parseColor("#F8FAFC")

    private var currentRxMbps = 0.0
    private var currentTxMbps = 0.0
    private var peakRxMbps = 0.0
    private var peakTxMbps = 0.0

    private val rxStrokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 4f
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }

    private val rxFillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
    }

    private val txStrokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 3.5f
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }

    private val txFillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
    }

    private val gridPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 1.5f
    }

    private val peakPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 1.5f
        pathEffect = DashPathEffect(floatArrayOf(10f, 10f), 0f)
    }

    private val labelPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textSize = 22f
        isFakeBoldText = true
    }

    private val hudPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textSize = 26f
        isFakeBoldText = true
    }

    private val rxPath = Path()
    private val rxFillPath = Path()
    private val txPath = Path()
    private val txFillPath = Path()

    init {
        // Pre-fill rolling buffer with zeros
        for (i in 0 until maxPoints) {
            points.add(WanTrafficPoint(0L, 0.0, 0.0))
        }
        updatePaints()
    }

    fun setThemeColors(
        rxColor: Int,
        txColor: Int,
        gridColor: Int,
        textPrimary: Int,
        textMuted: Int
    ) {
        this.primaryRxColor = rxColor
        this.secondaryTxColor = txColor
        this.gridLineColor = gridColor
        this.textPrimaryColor = textPrimary
        this.textMutedColor = textMuted
        updatePaints()
        updateGradients()
        invalidate()
    }

    fun addTrafficSample(rxMbps: Double, txMbps: Double) {
        currentRxMbps = rxMbps
        currentTxMbps = txMbps
        if (rxMbps > peakRxMbps) peakRxMbps = rxMbps
        if (txMbps > peakTxMbps) peakTxMbps = txMbps

        if (points.size >= maxPoints) {
            points.removeFirst()
        }
        points.add(WanTrafficPoint(System.currentTimeMillis(), rxMbps, txMbps))
        invalidate()
    }

    private fun updatePaints() {
        rxStrokePaint.color = primaryRxColor
        txStrokePaint.color = secondaryTxColor
        gridPaint.color = gridLineColor
        peakPaint.color = primaryRxColor
        peakPaint.alpha = 100
        labelPaint.color = textMutedColor
    }

    private fun updateGradients() {
        if (height <= 0) return
        rxFillPaint.shader = LinearGradient(
            0f, 0f, 0f, height.toFloat(),
            intArrayOf(
                adjustAlpha(primaryRxColor, 0.45f),
                adjustAlpha(primaryRxColor, 0.15f),
                Color.TRANSPARENT
            ),
            floatArrayOf(0f, 0.6f, 1f),
            Shader.TileMode.CLAMP
        )

        txFillPaint.shader = LinearGradient(
            0f, 0f, 0f, height.toFloat(),
            intArrayOf(
                adjustAlpha(secondaryTxColor, 0.40f),
                adjustAlpha(secondaryTxColor, 0.10f),
                Color.TRANSPARENT
            ),
            floatArrayOf(0f, 0.6f, 1f),
            Shader.TileMode.CLAMP
        )
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        updateGradients()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val w = width.toFloat()
        val h = height.toFloat()
        if (w <= 0 || h <= 0) return

        val paddingBottom = 40f
        val paddingTop = 50f
        val paddingLeft = 70f
        val paddingRight = 30f
        val chartHeight = h - paddingTop - paddingBottom
        val chartWidth = w - paddingLeft - paddingRight

        // 1. Calculate dynamic max scale
        var maxObserved = 50.0
        for (p in points) {
            if (p.rxMbps > maxObserved) maxObserved = p.rxMbps
            if (p.txMbps > maxObserved) maxObserved = p.txMbps
        }
        val scaleMax = when {
            maxObserved <= 50.0 -> 50.0
            maxObserved <= 100.0 -> 100.0
            maxObserved <= 250.0 -> 250.0
            maxObserved <= 500.0 -> 500.0
            else -> (Math.ceil(maxObserved / 250.0) * 250.0)
        }

        // 2. Draw Grid Lines and Labels
        val gridSteps = 4
        for (i in 0..gridSteps) {
            val stepVal = scaleMax * (gridSteps - i) / gridSteps
            val y = paddingTop + (chartHeight * i / gridSteps)

            canvas.drawLine(paddingLeft, y, w - paddingRight, y, gridPaint)
            val lbl = "${stepVal.toInt()}M"
            canvas.drawText(lbl, 10f, y + 8f, labelPaint)
        }

        // 3. Draw Peak RX Dash Line
        if (peakRxMbps > 0.0) {
            val peakY = (paddingTop + chartHeight * (1.0 - (peakRxMbps / scaleMax).coerceIn(0.0, 1.0))).toFloat()
            canvas.drawLine(paddingLeft, peakY, w - paddingRight, peakY, peakPaint)
            val peakText = "PEAK RX: ${String.format("%.1f", peakRxMbps)} Mbps"
            canvas.drawText(peakText, paddingLeft + 10f, peakY - 8f, labelPaint)
        }

        // 4. Build smooth bezier paths for RX and TX
        if (points.size >= 2) {
            val stepX = chartWidth / (maxPoints - 1)

            // Build RX Path
            buildBezierPaths(
                points.map { it.rxMbps },
                stepX,
                chartHeight,
                paddingLeft,
                paddingTop,
                scaleMax,
                h - paddingBottom,
                rxPath,
                rxFillPath
            )

            // Build TX Path
            buildBezierPaths(
                points.map { it.txMbps },
                stepX,
                chartHeight,
                paddingLeft,
                paddingTop,
                scaleMax,
                h - paddingBottom,
                txPath,
                txFillPath
            )

            // Draw Download (RX) Area & Stroke
            canvas.drawPath(rxFillPath, rxFillPaint)
            canvas.drawPath(rxPath, rxStrokePaint)

            // Draw Upload (TX) Area & Stroke
            canvas.drawPath(txFillPath, txFillPaint)
            canvas.drawPath(txPath, txStrokePaint)
        }

        // 5. Draw Top HUD Bar
        val hudY = paddingTop - 16f
        hudPaint.color = primaryRxColor
        val rxText = "▼ LIVE RX: ${String.format("%.1f", currentRxMbps)} Mbps"
        canvas.drawText(rxText, paddingLeft + 10f, hudY, hudPaint)

        val txTextX = paddingLeft + 360f
        hudPaint.color = secondaryTxColor
        val txText = "▲ LIVE TX: ${String.format("%.1f", currentTxMbps)} Mbps"
        canvas.drawText(txText, txTextX, hudY, hudPaint)
    }

    private fun buildBezierPaths(
        values: List<Double>,
        stepX: Float,
        chartHeight: Float,
        paddingLeft: Float,
        paddingTop: Float,
        scaleMax: Double,
        bottomY: Float,
        strokePath: Path,
        fillPath: Path
    ) {
        strokePath.reset()
        fillPath.reset()

        val coords = ArrayList<Pair<Float, Float>>(values.size)
        for (i in values.indices) {
            val x = paddingLeft + (i * stepX)
            val ratio = (values[i] / scaleMax).coerceIn(0.0, 1.0)
            val y = (paddingTop + chartHeight * (1.0 - ratio)).toFloat()
            coords.add(Pair(x, y))
        }

        if (coords.isEmpty()) return

        strokePath.moveTo(coords[0].first, coords[0].second)
        fillPath.moveTo(coords[0].first, bottomY)
        fillPath.lineTo(coords[0].first, coords[0].second)

        for (i in 1 until coords.size) {
            val prev = coords[i - 1]
            val curr = coords[i]
            val midX = (prev.first + curr.first) / 2f
            strokePath.cubicTo(midX, prev.second, midX, curr.second, curr.first, curr.second)
            fillPath.cubicTo(midX, prev.second, midX, curr.second, curr.first, curr.second)
        }

        val last = coords.last()
        fillPath.lineTo(last.first, bottomY)
        fillPath.close()
    }

    private fun adjustAlpha(color: Int, factor: Float): Int {
        val alpha = (Color.alpha(color) * factor).toInt()
        val red = Color.red(color)
        val green = Color.green(color)
        val blue = Color.blue(color)
        return Color.argb(alpha, red, green, blue)
    }
}
