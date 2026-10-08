package com.alijaya.customer.util

import android.app.Activity
import android.app.ProgressDialog
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.core.content.FileProvider
import com.alijaya.customer.CustomerApplication
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

object AppUpdateHelper {

    private fun getUnsafeOkHttpClient(): OkHttpClient {
        val builder = OkHttpClient.Builder()
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)

        try {
            val trustAllCerts = arrayOf<TrustManager>(
                object : X509TrustManager {
                    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
                    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
                    override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
                }
            )
            val sslContext = SSLContext.getInstance("SSL")
            sslContext.init(null, trustAllCerts, SecureRandom())
            builder.sslSocketFactory(sslContext.socketFactory, trustAllCerts[0] as X509TrustManager)
            builder.hostnameVerifier { _, _ -> true }
        } catch (_: Exception) {}

        return builder.build()
    }

    fun checkForUpdate(activity: Activity, showToastIfLatest: Boolean = false) {
        val base = CustomerApplication.sessionManager.getServerBaseUrl()
        val url = if (base.endsWith("/")) base + "api/customer/app/version" else "$base/api/customer/app/version"

        CoroutineScope(Dispatchers.Main).launch {
            val jsonStr = withContext(Dispatchers.IO) {
                try {
                    val client = getUnsafeOkHttpClient()
                    val req = Request.Builder().url(url).build()
                    val resp = client.newCall(req).execute()
                    if (resp.isSuccessful) resp.body?.string() else null
                } catch (_: Exception) { null }
            }

            if (jsonStr != null) {
                try {
                    val obj = JSONObject(jsonStr).optJSONObject("data")
                    if (obj != null) {
                        val serverVersionCode = obj.optInt("versionCode", 1)
                        val versionName = obj.optString("versionName", "1.0.0")
                        val downloadPath = obj.optString("downloadUrl", "/downloads/billing-rtrw.apk")
                        val releaseNotes = obj.optString("releaseNotes", "Pembaruan versi terbaru.")

                        val currentVersionCode = try {
                            val pInfo = activity.packageManager.getPackageInfo(activity.packageName, 0)
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) pInfo.longVersionCode.toInt() else pInfo.versionCode
                        } catch (_: Exception) { 1 }

                        val forceUpdate = obj.optBoolean("forceUpdate", false)

                        if (serverVersionCode > currentVersionCode) {
                            val builder = AlertDialog.Builder(activity)
                                .setTitle("🚀 Pembaruan Aplikasi Tersedia (v" + versionName + ")")
                                .setMessage(releaseNotes + "\n\nApakah Anda ingin mengunduh dan memasang pembaruan sekarang?")
                                .setPositiveButton("⬇️ Unduh & Pasang") { _, _ ->
                                    val fullDownloadUrl = if (downloadPath.startsWith("http")) downloadPath else if (base.endsWith("/")) base + downloadPath.removePrefix("/") else "$base$downloadPath"
                                    downloadAndInstallApk(activity, fullDownloadUrl)
                                }
                                .setCancelable(!forceUpdate)

                            if (!forceUpdate) {
                                builder.setNegativeButton("Nanti", null)
                            }
                            builder.show()
                        } else if (showToastIfLatest) {
                            Toast.makeText(activity, "Aplikasi Anda sudah versi terbaru (v" + versionName + ")", Toast.LENGTH_SHORT).show()
                        }
                    }
                } catch (e: Exception) {
                    if (showToastIfLatest) Toast.makeText(activity, "Gagal memeriksa pembaruan: " + e.message, Toast.LENGTH_SHORT).show()
                }
            } else if (showToastIfLatest) {
                Toast.makeText(activity, "Gagal terhubung ke server pembaruan", Toast.LENGTH_SHORT).show()
            }
        }
    }

    @Suppress("DEPRECATION")
    fun downloadAndInstallApk(activity: Activity, downloadUrl: String) {
        val progressDialog = ProgressDialog(activity).apply {
            setTitle("Mengunduh Pembaruan APK")
            setMessage("Sedang mengunduh file versi terbaru dari server...")
            setProgressStyle(ProgressDialog.STYLE_HORIZONTAL)
            isIndeterminate = false
            max = 100
            setCancelable(false)
            show()
        }

        CoroutineScope(Dispatchers.Main).launch {
            val apkFile = withContext(Dispatchers.IO) {
                try {
                    val client = getUnsafeOkHttpClient()
                    val req = Request.Builder().url(downloadUrl).build()
                    val resp = client.newCall(req).execute()

                    if (resp.isSuccessful) {
                        val body = resp.body ?: return@withContext null
                        val totalBytes = body.contentLength()
                        val inputStream = body.byteStream()

                        val downloadDir = activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: activity.filesDir
                        val targetFile = File(downloadDir, "billing-rtrw_Update.apk")
                        if (targetFile.exists()) targetFile.delete()

                        val outputStream = FileOutputStream(targetFile)
                        val buffer = ByteArray(8192)
                        var bytesRead: Int
                        var downloadedBytes: Long = 0

                        while (inputStream.read(buffer).also { bytesRead = it } != -1) {
                            outputStream.write(buffer, 0, bytesRead)
                            downloadedBytes += bytesRead
                            if (totalBytes > 0) {
                                val progress = ((downloadedBytes * 100) / totalBytes).toInt()
                                withContext(Dispatchers.Main) {
                                    progressDialog.progress = progress
                                }
                            }
                        }

                        outputStream.flush()
                        outputStream.close()
                        inputStream.close()
                        targetFile
                    } else null
                } catch (e: Exception) { null }
            }

            progressDialog.dismiss()

            if (apkFile != null && apkFile.exists()) {
                installApk(activity, apkFile)
            } else {
                Toast.makeText(activity, "Gagal mengunduh file APK dari server", Toast.LENGTH_LONG).show()
            }
        }
    }

    fun installApk(context: Context, apkFile: File) {
        try {
            val uri: Uri = FileProvider.getUriForFile(
                context,
                context.packageName + ".fileprovider",
                apkFile
            )

            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK
            }
            context.startActivity(intent)
        } catch (e: Exception) {
            Toast.makeText(context, "Gagal membuka penginstal paket: " + e.message, Toast.LENGTH_LONG).show()
        }
    }
}
