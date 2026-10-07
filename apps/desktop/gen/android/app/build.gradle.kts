import groovy.json.JsonSlurper
import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

android {
    compileSdk = 37
    namespace = "tools.ghostly.app"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "tools.ghostly.app"
        minSdk = 26
        targetSdk = 37
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {
                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            optimization {
               enable = true
            }
            proguardFiles(
                *fileTree(".") {
                  include("**/*.pro")
                  exclude("build/**")
                }.files.toTypedArray()
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    buildFeatures {
        buildConfig = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_1_8
    }
}

rust {
    rootDirRel = "../../../"
}

// HTTPS from Rust checks certificates with Android's own verifier (rustls-platform-verifier). Its Kotlin half ships
// inside the crate as a Maven folder, found through `cargo metadata` (the crate's own instructions).
val rustlsPlatformVerifierMaven: String = run {
    val metadata = providers.exec {
        workingDir = file("../../..")
        commandLine(
            "cargo", "metadata", "--format-version", "1",
            "--filter-platform", "aarch64-linux-android", "--manifest-path", "Cargo.toml",
        )
    }.standardOutput.asText.get()
    @Suppress("UNCHECKED_CAST")
    val packages = (JsonSlurper().parseText(metadata) as Map<String, Any>)["packages"] as List<Map<String, Any>>
    val manifest = packages.first { it["name"] == "rustls-platform-verifier-android" }["manifest_path"] as String
    File(File(manifest).parentFile, "maven").path
}

repositories {
    maven {
        url = uri(rustlsPlatformVerifierMaven)
        metadataSources { artifact() }
    }
}

dependencies {
    implementation("rustls:rustls-platform-verifier:0.1.1")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = file("tauri.build.gradle.kts"))
