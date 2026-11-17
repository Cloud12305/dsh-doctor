# restart-dsh.ps1 - delayed restart of the DSH desktop app (dsh-doctor auto-fix).
# Runs detached. Flow: grace period (let in-flight turns finish) -> re-export
# every session queue -> stop DeepSeek Harness processes -> relaunch.
param(
    [int]$GraceSeconds = 20,
    [string]$ExePath = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\DeepSeek Harness.exe",
    [string]$DshHome = "$env:USERPROFILE\.dsh",
    [string]$StateDir = "$env:USERPROFILE\.dsh\dsh-doctor",
    [string]$LogFile = "$env:USERPROFILE\.dsh\dsh-doctor\restart.log"
)

function Log([string]$msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    try { Add-Content -Path $LogFile -Value $line -Encoding UTF8 } catch {}
}

Log "restart-dsh start: grace=${GraceSeconds}s exe=$ExePath"
Start-Sleep -Seconds $GraceSeconds

# Re-export queued messages from every session projcache (restart clears the
# queues; this catches messages that arrived during the grace period).
$rescueDir = Join-Path $StateDir 'rescue'
try {
    New-Item -ItemType Directory -Path $rescueDir -Force | Out-Null
    $projDir = Join-Path $DshHome 'storages\session_projcache\sessions'
    $ts = Get-Date -Format 'yyyyMMdd-HHmmss'
    foreach ($f in Get-ChildItem $projDir -Filter '*.json' -ErrorAction SilentlyContinue) {
        try {
            $j = Get-Content $f.FullName -Raw | ConvertFrom-Json
            $rows = $j.record.inbox.val.'next-turn'
            if ($rows -and $rows.Count -gt 0) {
                $sid = $f.BaseName.Replace('session-', '')
                if ($sid.Length -gt 8) { $sid = $sid.Substring(0, 8) }
                $out = Join-Path $rescueDir ("restart-queue-{0}-{1}.md" -f $sid, $ts)
                $lines = @("# Queue snapshot before restart: $($f.BaseName)", "")
                foreach ($m in $rows) {
                    $text = ($m.content | ForEach-Object { $_.text }) -join "`n"
                    $lines += "## [$($m.source.kind)]", "", $text, ""
                }
                Set-Content -Path $out -Value ($lines -join "`n") -Encoding UTF8
                Log "rescued $($rows.Count) queued message(s) from $($f.BaseName) -> $out"
            }
        } catch {}
    }
} catch {
    Log "rescue pass failed: $($_.Exception.Message)"
}

# Stop DSH by exact process name only (never other programs).
Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | ForEach-Object {
    Log "stopping pid=$($_.Id)"
    try { Stop-Process -Id $_.Id -Force } catch { Log "stop failed pid=$($_.Id): $($_.Exception.Message)" }
}
Start-Sleep -Seconds 2

if (Test-Path $ExePath) {
    Start-Process -FilePath $ExePath
    Log "relaunched: $ExePath"
} else {
    Log "exe not found: $ExePath - start DSH manually"
}
Log "restart-dsh done"
