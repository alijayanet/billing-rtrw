package com.alijaya.customer.ui.splash

import android.annotation.SuppressLint
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.appcompat.app.AppCompatActivity
import com.alijaya.customer.CustomerApplication
import com.alijaya.customer.databinding.ActivitySplashBinding
import com.alijaya.customer.ui.main.MainActivity

@SuppressLint("CustomSplashScreen")
class SplashActivity : AppCompatActivity() {
    private lateinit var binding: ActivitySplashBinding

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivitySplashBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.tvIspName.text = CustomerApplication.sessionManager.getIspName()

        Thread {
            try {
                val session = CustomerApplication.sessionManager
                val base = session.getServerBaseUrl().removeSuffix("/")
                val client = okhttp3.OkHttpClient.Builder()
                    .connectTimeout(3, java.util.concurrent.TimeUnit.SECONDS)
                    .readTimeout(3, java.util.concurrent.TimeUnit.SECONDS)
                    .build()
                val req = okhttp3.Request.Builder().url("$base/api/customer/ping").build()
                val resp = client.newCall(req).execute()
                if (resp.isSuccessful) {
                    val str = resp.body?.string()
                    if (!str.isNullOrBlank()) {
                        val json = org.json.JSONObject(str)
                        val name = json.optString("companyHeader", json.optString("ispName", json.optString("appName", "")))
                        if (name.isNotBlank()) {
                            session.saveIspName(name)
                            runOnUiThread {
                                binding.tvIspName.text = name
                            }
                        }
                        val phone = json.optString("companyPhone", json.optString("adminPhone", ""))
                        if (phone.isNotBlank()) {
                            session.saveAdminPhone(phone)
                        }
                    }
                }
            } catch (_: Exception) {}
        }.start()

        Handler(Looper.getMainLooper()).postDelayed({
            val session = CustomerApplication.sessionManager
            val targetClass = if (session.isFirstTimeSetup()) {
                com.alijaya.customer.ui.server.ServerConfigActivity::class.java
            } else if (!session.isLoggedIn()) {
                com.alijaya.customer.ui.login.LoginActivity::class.java
            } else {
                MainActivity::class.java
            }
            startActivity(Intent(this, targetClass))
            finish()
        }, 1200)
    }
}
