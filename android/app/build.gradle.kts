plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.premiereremote.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.premiereremote.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }

    signingConfigs {
        // Release signing is read from environment variables so no secret lives in the repo.
        create("release") {
            val ks = System.getenv("PR_KEYSTORE")
            if (ks != null) {
                storeFile = file(ks)
                storePassword = System.getenv("PR_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("PR_KEY_ALIAS")
                keyPassword = System.getenv("PR_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (System.getenv("PR_KEYSTORE") != null) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { compose = true }
    packaging { resources.excludes += "/META-INF/{AL2.0,LGPL2.1}" }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.12.01")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // Maintained prebuilt of Google's libwebrtc for Android (Apache-2.0 / BSD)
    implementation("io.github.webrtc-sdk:android:144.7559.15")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
