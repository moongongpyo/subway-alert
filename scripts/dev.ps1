[CmdletBinding()]
param(
    [ValidateSet('run', 'test', 'build')]
    [string]$Task = 'run'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot

# Respect the caller's JDK. If unset, look for a Java 21 JDK managed by IntelliJ.
if (-not $env:JAVA_HOME) {
    $jdkDirectory = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.jdks'
    if (Test-Path -LiteralPath $jdkDirectory) {
        $jdk = Get-ChildItem -LiteralPath $jdkDirectory -Directory |
            Where-Object { $_.Name -match '(^|[-_])21([.\-_]|$)' } |
            Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'bin\javac.exe') } |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 1
        if ($jdk) {
            $env:JAVA_HOME = $jdk.FullName
        }
    }
}

if ($env:JAVA_HOME) {
    $javaPath = Join-Path $env:JAVA_HOME 'bin\java.exe'
    if (-not (Test-Path -LiteralPath $javaPath)) {
        throw 'JAVA_HOME must point to a Java 21 JDK directory.'
    }
    $env:PATH = (Join-Path $env:JAVA_HOME 'bin') + [IO.Path]::PathSeparator + $env:PATH
} elseif (-not (Get-Command java -ErrorAction SilentlyContinue)) {
    throw 'Java 21 JDK is required. Install it or set JAVA_HOME, then retry.'
}

$gradleTask = switch ($Task) {
    'run' { 'bootRun' }
    'test' { 'test' }
    'build' { 'build' }
}

Push-Location $projectRoot
try {
    & (Join-Path $projectRoot 'gradlew.bat') --no-daemon $gradleTask
    $exitCode = $LASTEXITCODE
} finally {
    Pop-Location
}
exit $exitCode
