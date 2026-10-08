package com.alijaya.customer.ui.map

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.net.http.SslError
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.webkit.*
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.fragment.app.Fragment
import com.alijaya.customer.CustomerApplication

class NetworkMapFragment : Fragment() {

    private var webView: WebView? = null
    private var progressBar: ProgressBar? = null

    private fun getBaseUrl(): String {
        val base = CustomerApplication.sessionManager.getServerBaseUrl()
        return if (base.endsWith("/")) base.dropLast(1) else base
    }

    private fun getToken(): String = CustomerApplication.sessionManager.getAuthToken()

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View {
        val ctx = requireContext()

        val rootLayout = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#0F172A"))
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        }

        // 1. Top Bar
        val topBar = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            setBackgroundColor(Color.parseColor("#1E293B"))
            setPadding(16, 16, 16, 16)
            gravity = android.view.Gravity.CENTER_VERTICAL
            elevation = 8f
        }

        val btnBack = ImageButton(ctx).apply {
            setImageResource(android.R.drawable.ic_menu_revert)
            setBackgroundColor(Color.TRANSPARENT)
            setColorFilter(Color.WHITE)
            setPadding(12, 12, 12, 12)
            contentDescription = "Kembali"
            setOnClickListener {
                if (parentFragmentManager.backStackEntryCount > 0) {
                    parentFragmentManager.popBackStack()
                } else {
                    activity?.onBackPressedDispatcher?.onBackPressed()
                }
            }
        }
        topBar.addView(btnBack)

        val textLayout = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                marginStart = 12
            }
        }

        val tvTitle = TextView(ctx).apply {
            text = "🗺️ Peta / Mapping ONU"
            setTextColor(Color.WHITE)
            textSize = 16f
            setTypeface(null, android.graphics.Typeface.BOLD)
        }

        val tvSubtitle = TextView(ctx).apply {
            text = "ODP, Pelanggan, Jalur Kabel & Navigasi"
            setTextColor(Color.parseColor("#94A3B8"))
            textSize = 11.5f
        }

        textLayout.addView(tvTitle)
        textLayout.addView(tvSubtitle)
        topBar.addView(textLayout)

        val btnRefresh = ImageButton(ctx).apply {
            setImageResource(android.R.drawable.ic_menu_rotate)
            setBackgroundColor(Color.TRANSPARENT)
            setColorFilter(Color.parseColor("#38BDF8"))
            setPadding(12, 12, 12, 12)
            contentDescription = "Muat Ulang Peta"
            setOnClickListener {
                reloadMap()
                Toast.makeText(ctx, "Memperbarui data peta...", Toast.LENGTH_SHORT).show()
            }
        }
        topBar.addView(btnRefresh)

        rootLayout.addView(topBar)

        // 2. Progress Bar
        progressBar = ProgressBar(ctx, null, android.R.attr.progressBarStyleHorizontal).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                6
            )
            isIndeterminate = false
            max = 100
            progress = 0
            visibility = View.VISIBLE
        }
        rootLayout.addView(progressBar)

        // 3. WebView
        webView = WebView(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                0,
                1f
            )
            setBackgroundColor(Color.parseColor("#0B1120"))
        }

        setupWebView(webView!!)
        rootLayout.addView(webView)

        loadMapUrl()

        return rootLayout
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView(wv: WebView) {
        val s = wv.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        s.allowFileAccess = true
        s.allowContentAccess = true
        s.setSupportZoom(true)
        s.builtInZoomControls = false
        s.displayZoomControls = false
        s.useWideViewPort = true
        s.loadWithOverviewMode = true
        s.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        s.setGeolocationEnabled(true)
        s.cacheMode = WebSettings.LOAD_DEFAULT

        val cookieManager = CookieManager.getInstance()
        cookieManager.setAcceptCookie(true)
        cookieManager.setAcceptThirdPartyCookies(wv, true)

        wv.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                progressBar?.progress = newProgress
                if (newProgress >= 100) {
                    progressBar?.visibility = View.GONE
                } else {
                    progressBar?.visibility = View.VISIBLE
                }
            }

            override fun onGeolocationPermissionsShowPrompt(
                origin: String?,
                callback: GeolocationPermissions.Callback?
            ) {
                callback?.invoke(origin, true, false)
            }
        }

        wv.webViewClient = object : WebViewClient() {
            override fun onReceivedSslError(view: WebView?, handler: SslErrorHandler?, error: SslError?) {
                handler?.cancel()
            }

            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val url = request?.url?.toString() ?: return false
                if (url.startsWith("whatsapp:") || url.contains("wa.me") ||
                    url.startsWith("tel:") || url.startsWith("geo:") ||
                    url.startsWith("google.navigation:") || url.contains("google.com/maps")) {
                    try {
                        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
                        startActivity(intent)
                        return true
                    } catch (_: Exception) {
                        Toast.makeText(context, "Aplikasi eksternal tidak ditemukan", Toast.LENGTH_SHORT).show()
                        return true
                    }
                }
                return false
            }
        }
    }

    private fun loadMapUrl() {
        val url = "${getBaseUrl()}/api/customer/app/map?token=${getToken()}"
        webView?.loadUrl(url)
    }

    private fun reloadMap() {
        webView?.reload()
    }

    override fun onDestroyView() {
        webView?.apply {
            stopLoading()
            webChromeClient = null
            destroy()
        }
        webView = null
        progressBar = null
        super.onDestroyView()
    }
}
