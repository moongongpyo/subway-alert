param([string]$EnvFile = '.env.team', [switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
if (-not (Test-Path -LiteralPath $EnvFile)) { throw "Missing settings file: $EnvFile" }
foreach ($line in Get-Content -LiteralPath $EnvFile -Encoding UTF8) {
    if ($line -match '^\s*(#|$)') { continue }
    if ($line -notmatch '^([A-Z][A-Z0-9_]*)=(.*)$') { throw 'Invalid environment file line' }
    $settingName = $Matches[1]; $settingValue = $Matches[2].Trim()
    if ($settingValue.Length -ge 2 -and (($settingValue.StartsWith('"') -and $settingValue.EndsWith('"')) -or ($settingValue.StartsWith("'") -and $settingValue.EndsWith("'")))) {
        $settingValue = $settingValue.Substring(1, $settingValue.Length - 2)
    }
    [Environment]::SetEnvironmentVariable($settingName, $settingValue, 'Process')
}
foreach ($required in @('OPENAI_API_KEY','TMAP_APP_KEY','SEOUL_NOTICE_API_KEY')) {
    if (-not [Environment]::GetEnvironmentVariable($required, 'Process')) { throw "Missing setting: $required" }
}
if ($CheckOnly) { Write-Output 'Settings loaded; required keys present (values hidden).'; exit 0 }
& .\gradlew.bat bootRun
exit $LASTEXITCODE
