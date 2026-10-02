# Implementation Plan: Phase 2.1 - Android App Scaffolding & Distribution
**Task ID:** phase-2.1

## Goal
Scaffold the native Android Capture app using Kotlin and Jetpack Compose. Produce a debug APK and provide a frictionless local download script so Jose can easily install and test it on his Android phone over his local network (or Tailscale).

## Scope
- Scaffold a standard Android Jetpack Compose project inside the `android/` directory (package name: `com.bespoke.copilot`).
- Set up the Gradle Kotlin DSL scripts (`build.gradle.kts`, `settings.gradle.kts`, `app/build.gradle.kts`).
- Create `AndroidManifest.xml` and a minimal `MainActivity.kt`.
- The `MainActivity` should display a placeholder screen reading "Daily Co-Pilot Capture" using a dark-mode-first Jetpack Compose theme.
- Create a `android/build.ps1` script that runs the Gradle Wrapper to assemble a debug APK (`./gradlew assembleDebug`).
- Create a `android/serve_apk.py` script that acts as a simple HTTP server on port `8000`. It should host the generated `app-debug.apk` file and print out the PC's local IP address (or Tailscale IP) so Jose can instantly download the APK on his phone browser.

## Relevant Context
- The app must use Jetpack Compose (no XML layouts).
- The mockups dictate a dark, calm, engineering-tool feel (dark mode by default). 
- Since the workspace is already on Jose's PC, running a local python server is the absolute fastest way to beam the APK to his phone without messing with USB cables or Google Drive.

## Files to Modify / Create
- `android/settings.gradle.kts` (New)
- `android/build.gradle.kts` (New)
- `android/gradle.properties` (New)
- `android/app/build.gradle.kts` (New)
- `android/app/src/main/AndroidManifest.xml` (New)
- `android/app/src/main/java/com/bespoke/copilot/MainActivity.kt` (New)
- `android/build.ps1` (New)
- `android/serve_apk.py` (New)

## Interfaces
- `$ .\build.ps1`
- `$ python serve_apk.py` -> "Scan this or visit http://100.x.y.z:8000/app-debug.apk on your phone"

## Constraints
- Do not build the actual Capture UI or Tailscale networking logic yet (Phase 2.2). This is purely the boilerplate scaffolding and deployment pipeline.
- Assume the user has the Android SDK installed and `ANDROID_HOME` configured on their machine.

## User-Driven Manual Test Plan
1. Open PowerShell in `C:\Users\designer\Documents\assistant\copilot\android`.
2. Run `.\build.ps1` to compile the app.
3. Once the build succeeds, run `python serve_apk.py`.
4. Open the printed URL on your phone's browser (while on the same network or Tailscale) to download and install the APK.
5. Open the app on your phone and verify it displays "Daily Co-Pilot Capture" in dark mode.

## Out of Scope
- Actually querying the backend API.
- The Capture Form UI components.
