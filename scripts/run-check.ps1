param(
  [string]$ProjectDir = (Resolve-Path "$PSScriptRoot\..").Path
)

Set-Location -LiteralPath $ProjectDir
npm run check
