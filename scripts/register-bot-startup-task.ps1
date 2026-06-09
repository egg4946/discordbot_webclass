param(
  [string]$TaskName = "WebClass Discord Slash Command Bot",
  [string]$ProjectDir = (Resolve-Path "$PSScriptRoot\..").Path
)

$powershellPath = (Get-Command powershell).Source
$runnerPath = Join-Path $ProjectDir "scripts\run-bot.ps1"
$logDir = Join-Path $ProjectDir "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$action = New-ScheduledTaskAction `
  -Execute $powershellPath `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$runnerPath`" -ProjectDir `"$ProjectDir`""

$trigger = New-ScheduledTaskTrigger -AtLogOn

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description "Runs the WebClass Discord slash command bot at logon." `
  -Force | Out-Null

Write-Host "Registered scheduled task: $TaskName"
