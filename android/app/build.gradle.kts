plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Versionsnummer kommt im CI aus der Build-Nummer, damit jedes neue APK ein Update ist
val buildNumber = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()

android {
    namespace = "de.watchparty.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "de.watchparty.app"
        minSdk = 25 // Fire OS 6 (Fire TV Stick 2. Gen.) und neuer
        targetSdk = 35
        versionCode = buildNumber
        versionName = "1.0.$buildNumber"
    }

    // Signierschlüssel kommt aus dem CI (GitHub-Secret APP_KEYSTORE_B64), nie aus dem Repo.
    // Ohne Schlüssel wird mit dem Debug-Schlüssel signiert (lokale Tests; Updates gehen dann nur nach Deinstallation).
    val keystore = System.getenv("APP_KEYSTORE")?.takeIf { it.isNotBlank() && file(it).exists() }
    signingConfigs {
        if (keystore != null) {
            create("release") {
                storeFile = file(keystore)
                storePassword = System.getenv("APP_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("APP_KEY_ALIAS") ?: "watchparty"
                keyPassword = System.getenv("APP_KEY_PASSWORD") ?: System.getenv("APP_KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName(if (keystore != null) "release" else "debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}
