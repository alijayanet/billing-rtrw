package com.alijaya.customer

import android.app.Application
import com.alijaya.customer.data.pref.SessionManager

class CustomerApplication : Application() {
    companion object {
        lateinit var sessionManager: SessionManager
            private set
    }

    override fun onCreate() {
        super.onCreate()
        sessionManager = SessionManager(applicationContext)
    }
}
