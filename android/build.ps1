# Assembles the debug APK via the Gradle wrapper.
# Usage: .\build.ps1
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

# Resolve the Android SDK: ANDROID_HOME, then ANDROID_SDK_ROOT, then the Android Studio default.
$sdk = $env:ANDROID_HOME
if (-not $sdk) { $sdk = $env:ANDROID_SDK_ROOT }
if (-not $sdk) { $sdk = Join-Path $env:LOCALAPPDATA "Android\Sdk" }
if (-not (Test-Path $sdk)) {
    Write-Error "Android SDK not found. Set ANDROID_HOME to your SDK path (e.g. $env:LOCALAPPDATA\Android\Sdk)."
}

# Gradle reads sdk.dir from local.properties (gitignored).
if (-not (Test-Path "local.properties")) {
    $escaped = $sdk -replace '\', '\' -replace ':', '\:'
    Set-Content -Path "local.properties" -Value "sdk.dir=$escaped" -Encoding ascii
    Write-Host "Wrote local.properties (sdk.dir=$sdk)"
}

# Gradle needs a JDK 17+. Fall back to Android Studio's bundled JBR if none is configured.
if (-not $env:JAVA_HOME -and -not (Get-Command java -ErrorAction SilentlyContinue)) {
    $jbr = Join-Path $env:ProgramFiles "Android\Android Studio\jbr"
    if (Test-Path $jbr) {
        $env:JAVA_HOME = $jbr
        Write-Host "Using Android Studio JDK: $jbr"
    } else {
        Write-Error "No JDK found. Install JDK 17+ or set JAVA_HOME."
    }
}

& .\gradlew.bat assembleDebug
if ($LASTEXITCODE -ne 0) {
    Write-Error "Gradle build failed (exit code $LASTEXITCODE)."
}

$apk = Join-Path $PSScriptRoot "app\build\outputs\apk\debug\app-debug.apk"
Write-Host ""
Write-Host "Built: $apk"
Write-Host "Next:  python serve_apk.py"
