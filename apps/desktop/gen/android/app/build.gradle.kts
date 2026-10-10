import java.security.MessageDigest
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
        applicationId = "tools.ghostly.app"
        minSdk = 26
        targetSdk = 37
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    // A release build is signed with the upload key when ANDROID_KEYSTORE names a keystore file (CI's android.yml
    // sets it from the repository's secrets; docs/ANDROID.md); without it, the release APK comes out unsigned.
    val uploadKeystore = providers.environmentVariable("ANDROID_KEYSTORE").orNull?.takeIf { it.isNotEmpty() }
    signingConfigs {
        if (uploadKeystore != null) {
            create("upload") {
                storeFile = file(uploadKeystore)
                storePassword = providers.environmentVariable("ANDROID_KEYSTORE_PASSWORD").orNull
                keyAlias = providers.environmentVariable("ANDROID_KEY_ALIAS").orNull
                keyPassword = providers.environmentVariable("ANDROID_KEY_PASSWORD").orNull
            }
        }
    }
    buildTypes {
        getByName("debug") {
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
            signingConfigs.findByName("upload")?.let { signingConfig = it }
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

// HTTPS from Rust checks certificates with Android's own verifier (rustls-platform-verifier). Its Kotlin half is an
// .aar in a Maven repository the crate's authors serve from a git branch (the crate's own instructions), at the
// version Cargo.lock gives the `rustls-platform-verifier-android` crate. Cargo.lock's checksum does not cover that
// file and a branch can change, so its SHA-256 is pinned here and checked before anything is built: a new version of
// the crate needs the new .aar read and its hash put here.
val rustlsPlatformVerifierSha256 = "aa021794230fbc2f0be355999e2cf67398dd563de066a2e17001ffbd0b69101b" // 0.2.0
val rustlsPlatformVerifierVersion: String = run {
    val lines = providers.fileContents(layout.projectDirectory.file("../../../../../Cargo.lock")).asText.get().lines()
    val name = lines.indexOfFirst { it.trim() == "name = \"rustls-platform-verifier-android\"" }
    check(name >= 0) { "rustls-platform-verifier-android is not in Cargo.lock" }
    lines.drop(name + 1).first { it.startsWith("version = ") }.substringAfter('"').substringBefore('"')
}
val rustlsPlatformVerifierAar = "org.rustls:rustls-platform-verifier:$rustlsPlatformVerifierVersion@aar"

repositories {
    // Only this module comes from there, and from nowhere else.
    exclusiveContent {
        forRepository {
            maven {
                url = uri("https://github.com/rustls/rustls-platform-verifier/raw/maven-archive/android-release-support/maven/")
            }
        }
        filter { includeModule("org.rustls", "rustls-platform-verifier") }
    }
}

// The same file the app links: Gradle keeps one copy of a module's artifact.
val rustlsPlatformVerifierPinned = configurations.detachedConfiguration(dependencies.create(rustlsPlatformVerifierAar))
val verifyRustlsPlatformVerifier = tasks.register("verifyRustlsPlatformVerifier") {
    val aar = files(rustlsPlatformVerifierPinned)
    val expected = rustlsPlatformVerifierSha256
    inputs.files(aar)
    inputs.property("sha256", expected)
    doLast {
        val file = aar.singleFile
        val actual = MessageDigest.getInstance("SHA-256").digest(file.readBytes()).joinToString("") { "%02x".format(it) }
        if (actual != expected) {
            throw GradleException(
                "${file.name} has SHA-256 $actual, and app/build.gradle.kts pins $expected: " +
                    "read the new .aar before its hash goes there."
            )
        }
    }
}
tasks.matching { it.name == "preBuild" }.configureEach { dependsOn(verifyRustlsPlatformVerifier) }

dependencies {
    implementation(rustlsPlatformVerifierAar)
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
