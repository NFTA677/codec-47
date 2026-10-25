plugins {
    id("com.android.application")
}

android {
    namespace = "com.codec47.assistant"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.codec47.assistant"
        minSdk = 29
        targetSdk = 36
        versionCode = 4
        versionName = "1.3.0"
        // Solo procesadores ARM (los teléfonos reales): APK más liviana
        ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a") }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // Palabra de activación offline ("Codec")
    implementation("com.alphacephei:vosk-android:0.3.47@aar")
    implementation("net.java.dev.jna:jna:5.13.0@aar")
}
