param(
  [string]$ProjectDir = (Resolve-Path "$PSScriptRoot\..").Path
)

$logDir = Join-Path $ProjectDir "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

Set-Location -LiteralPath $ProjectDir
npm run bot *>> (Join-Path $logDir "bot.log")
