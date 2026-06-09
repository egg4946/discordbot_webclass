param(
  [string]$TaskName = "WebClass Discord Notifier",
  [string]$ProjectDir = (Resolve-Path "$PSScriptRoot\..").Path
)

$powershellPath = (Get-Command powershell).Source
$runnerPath = Join-Path $ProjectDir "scripts\run-check.ps1"
$logDir = Join-Path $ProjectDir "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$action = New-ScheduledTaskAction `
  -Execute $powershellPath `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$runnerPath`" -ProjectDir `"$ProjectDir`""

$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Hours 3) `
  -RepetitionDuration (New-TimeSpan -Days 3650)

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description "Checks Nanzan WebClass every 3 hours and posts new assignments or 24-hour deadline reminders to Discord." `
  -Force | Out-Null

Write-Host "Registered scheduled task: $TaskName"
