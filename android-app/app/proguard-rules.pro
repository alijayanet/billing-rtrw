# ----------------------------------------------------
# Proguard / R8 Configuration for Alijaya Billing RTRW
# ----------------------------------------------------

# Keep line numbers and file names for clear debugging in Play Console
-renamesourcefileattribute SourceFile
-keepattributes SourceFile,LineNumberTable

# Keep Annotations and Signatures for Generics / Reflection
-keepattributes *Annotation*,Signature,InnerClasses,EnclosingMethod
-keepattributes RuntimeVisibleAnnotations,RuntimeVisibleParameterAnnotations

# ----------------------------------------------------
# Application Data Models (Preserve fields for Gson)
# ----------------------------------------------------
-keep class com.alijaya.customer.data.model.** { *; }
-keepclassmembers class com.alijaya.customer.data.model.** { <fields>; }
-keep class com.alijaya.customer.data.api.** { *; }
-keepclassmembers class com.alijaya.customer.data.api.** { *; }

# ----------------------------------------------------
# WebView & JavaScript Interface Bridge
# ----------------------------------------------------
-keepattributes JavascriptInterface
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class com.alijaya.customer.bridge.** { *; }
-keepclassmembers class com.alijaya.customer.bridge.** { *; }

# ----------------------------------------------------
# Retrofit 2
# ----------------------------------------------------
-dontwarn retrofit2.**
-keep class retrofit2.** { *; }
-keepclasseswithmembers class * {
    @retrofit2.http.* <methods>;
}

# ----------------------------------------------------
# Gson
# ----------------------------------------------------
-dontwarn com.google.gson.**
-keep class com.google.gson.** { *; }
-keep class * implements com.google.gson.TypeAdapter
-keep class * implements com.google.gson.TypeAdapterFactory
-keep class * implements com.google.gson.JsonSerializer
-keep class * implements com.google.gson.JsonDeserializer

# ----------------------------------------------------
# OkHttp & Okio
# ----------------------------------------------------
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn javax.annotation.**
-keepnames class okhttp3.internal.publicsuffix.PublicSuffixDatabase

# ----------------------------------------------------
# ZXing Barcode / QR Scanner
# ----------------------------------------------------
-dontwarn com.google.zxing.**
-keep class com.google.zxing.** { *; }
-keep class com.journeyapps.barcodescanner.** { *; }
-keepclassmembers class com.journeyapps.barcodescanner.** { *; }

# ----------------------------------------------------
# AndroidX & Coroutines
# ----------------------------------------------------
-dontwarn androidx.**
-dontwarn kotlinx.coroutines.**
