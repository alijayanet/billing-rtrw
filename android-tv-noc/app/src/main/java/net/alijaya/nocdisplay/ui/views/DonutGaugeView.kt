package net.alijaya.nocdisplay.ui.views

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.SweepGradient
import android.util.AttributeSet
import android.view.View
import android.view.animation.DecelerateInterpolator
import kotlin.math.min

class DonutGaugeView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0
) : View(context, attrs, defStyleAttr) {

    private var targetValue: Float = 0f
    private var currentValue: Float = 0f
    private var maxValue: Float = 100f

    private var titleText: String = "CPU LOAD"
    private var subtitleText: String = ""
    private var unitText: String = "%"

    private var primaryColor: Int = Color.parseColor("#00F2FE")
    private var accentColor: Int = Color.parseColor("#10B981")
    private var trackColor: Int = Color.parseColor("#142240")
    private var textColor: Int = Color.parseColor("#F8FAFC")
    private var textMutedColor: Int = Color.parseColor("#94A3B8")

    private val trackPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
    }

    private val progressPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
    }

    private val glowPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
    }

    private val valuePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textAlign = Paint.Align.CENTER
        isFakeBoldText = true
    }

    private val titlePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textAlign = Paint.Align.CENTER
        isFakeBoldText = true
        letterSpacing = 0.1f
    }

    private val subtitlePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textAlign = Paint.Align.CENTER
        letterSpacing = 0.05f
    }

    private val arcBounds = RectF()
    private val startAngle = 135f
    private val totalSweep = 270f
    private var strokeWidthPx = 18f

    private var animator: ValueAnimator? = null

    init {
        updatePaints()
    }

    fun setThemeColors(
        primary: Int,
        secondary: Int,
        track: Int,
        textPrimary: Int,
        textMuted: Int
    ) {
        this.primaryColor = primary
        this.accentColor = secondary
        this.trackColor = track
        this.textColor = textPrimary
        this.textMutedColor = textMuted
        updatePaints()
        invalidate()
    }

    fun setGaugeData(
        value: Float,
        title: String,
        subtitle: String,
        max: Float = 100f
    ) {
        this.titleText = title
        this.subtitleText = subtitle
        this.maxValue = max.coerceAtLeast(1f)
        val clamped = value.coerceIn(0f, maxValue)

        animator?.cancel()
        animator = ValueAnimator.ofFloat(currentValue, clamped).apply {
            duration = 600
            interpolator = DecelerateInterpolator()
            addUpdateListener { anim ->
                currentValue = anim.animatedValue as Float
                invalidate()
            }
            start()
        }
        targetValue = clamped
    }

    private fun updatePaints() {
        trackPaint.color = trackColor
        valuePaint.color = textColor
        titlePaint.color = textMutedColor
        subtitlePaint.color = textMutedColor
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        val size = min(w, h).toFloat()
        strokeWidthPx = size * 0.085f

        trackPaint.strokeWidth = strokeWidthPx
        progressPaint.strokeWidth = strokeWidthPx
        glowPaint.strokeWidth = strokeWidthPx * 1.5f

        val padding = strokeWidthPx * 1.2f
        val cx = w / 2f
        val cy = h / 2f
        val radius = (size / 2f) - padding

        arcBounds.set(cx - radius, cy - radius, cx + radius, cy + radius)

        valuePaint.textSize = size * 0.22f
        titlePaint.textSize = size * 0.085f
        subtitlePaint.textSize = size * 0.07f
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (width <= 0 || height <= 0) return

        val cx = width / 2f
        val cy = height / 2f

        // Draw background track arc
        trackPaint.color = trackColor
        canvas.drawArc(arcBounds, startAngle, totalSweep, false, trackPaint)

        // Calculate progress sweep
        val ratio = (currentValue / maxValue).coerceIn(0f, 1f)
        val sweep = totalSweep * ratio

        if (sweep > 0.5f) {
            // Dynamic color determination based on load
            val currentColor = when {
                ratio >= 0.85f -> Color.parseColor("#EF4444") // Critical Red
                ratio >= 0.70f -> Color.parseColor("#EAB308") // Warning Yellow
                else -> primaryColor
            }

            // Outer glow arc
            glowPaint.color = currentColor
            glowPaint.alpha = 50
            canvas.drawArc(arcBounds, startAngle, sweep, false, glowPaint)

            // Progress arc
            progressPaint.color = currentColor
            canvas.drawArc(arcBounds, startAngle, sweep, false, progressPaint)
        }

        // Draw Center Value: "42%"
        val valueStr = "${currentValue.toInt()}$unitText"
        val valueY = cy + (valuePaint.textSize * 0.35f) - (height * 0.04f)
        valuePaint.color = when {
            ratio >= 0.85f -> Color.parseColor("#EF4444")
            ratio >= 0.70f -> Color.parseColor("#EAB308")
            else -> textColor
        }
        canvas.drawText(valueStr, cx, valueY, valuePaint)

        // Draw Title above or below
        titlePaint.color = textMutedColor
        val titleY = valueY - valuePaint.textSize * 0.95f
        canvas.drawText(titleText, cx, titleY, titlePaint)

        // Draw Subtitle: "4 Cores @ 1400MHz"
        if (subtitleText.isNotEmpty()) {
            subtitlePaint.color = textMutedColor
            val subY = valueY + subtitlePaint.textSize * 1.5f
            canvas.drawText(subtitleText, cx, subY, subtitlePaint)
        }
    }
}
