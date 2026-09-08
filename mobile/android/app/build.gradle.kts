plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.cipher.manager"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.cipher.manager"
        minSdk = 24
        targetSdk = 35
        versionCode = 7
        versionName = "0.1.6"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // Debug-signed so `assembleRelease` produces an installable APK
            // without a keystore. Swap in a real signingConfig for the Play Store.
            signingConfig = signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")

    // Test-only, never shipped: the SDK's android.jar ships a stubbed org.json
    // whose methods throw in JVM unit tests, so put a real one on the test
    // classpath ahead of it.
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
