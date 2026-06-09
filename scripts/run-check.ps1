param(
  [string]$ProjectDir = (Resolve-Path "$PSScriptRoot\..").Path
)

$logDir = Join-Path $ProjectDir "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

Set-Location -LiteralPath $ProjectDir
npm run check *>> (Join-Path $logDir "scheduled-task.log")
