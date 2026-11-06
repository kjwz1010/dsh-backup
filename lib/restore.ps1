# dsh-backup 离线恢复脚本
# 由 DSH 的「备份」设置页生成，运行时不依赖 DSH。
# 用法：关闭 DSH（或退出占用目标文件的程序）后，双击同目录下的 run.cmd。
# 脚本会等待文件锁释放后再覆盖，最多等 plan.json 里的 waitSeconds 秒。

$ErrorActionPreference = 'Stop'
$Utf8 = New-Object System.Text.UTF8Encoding($false)
try { [Console]::OutputEncoding = $Utf8 } catch { }
$PlanPath = Join-Path $PSScriptRoot 'plan.json'

if (-not (Test-Path -LiteralPath $PlanPath)) {
  Write-Host ('找不到 ' + $PlanPath) -ForegroundColor Red
  exit 1
}

$plan = Get-Content -LiteralPath $PlanPath -Raw -Encoding UTF8 | ConvertFrom-Json
$mapping = @($plan.mapping)

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$stage = Join-Path $env:TEMP ('dsh-restore-' + $stamp)
$undoRoot = Join-Path $PSScriptRoot ('undo-' + $stamp)

$waitSeconds = 600
if ($plan.waitSeconds) { $waitSeconds = [int]$plan.waitSeconds }
$mode = 'skip'
if ($plan.mode) { $mode = [string]$plan.mode }

$summary = [ordered]@{
  ok         = $true
  runId      = $plan.runId
  planName   = $plan.planName
  startedAt  = (Get-Date).ToString('o')
  finishedAt = $null
  mode       = $mode
  restored   = 0
  skipped    = @()
  sideloaded = @()
  failed     = @()
  undo       = $undoRoot
}

function Test-Locked([string]$p) {
  if (-not (Test-Path -LiteralPath $p)) { return $false }
  try {
    $fs = [System.IO.File]::Open($p, 'Open', 'ReadWrite', 'None')
    $fs.Close()
    return $false
  } catch {
    return $true
  }
}

function Wait-Unlocked([string]$p) {
  if (-not (Test-Locked $p)) { return $true }
  $deadline = (Get-Date).AddSeconds($waitSeconds)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    if (-not (Test-Locked $p)) { return $true }
  }
  return $false
}

function Place([string]$src, [string]$dest, [string]$rel) {
  $dir = Split-Path -Parent $dest
  if ($dir -and -not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
  }
  if (Test-Path -LiteralPath $dest) {
    if (-not (Wait-Unlocked $dest)) {
      if ($mode -eq 'strict') { throw ('文件被占用：' + $dest) }
      if ($mode -eq 'sideload') {
        $aside = $dest + '.restore-' + $stamp
        Copy-Item -LiteralPath $src -Destination $aside -Force
        $summary.sideloaded += $aside
        return
      }
      $summary.skipped += $dest
      return
    }
    $undo = Join-Path $undoRoot ($rel -replace '/', '\')
    $undoDir = Split-Path -Parent $undo
    if (-not (Test-Path -LiteralPath $undoDir)) {
      New-Item -ItemType Directory -Force -Path $undoDir | Out-Null
    }
    Copy-Item -LiteralPath $dest -Destination $undo -Force
  }
  $tmp = $dest + '.dsh-restoring'
  Copy-Item -LiteralPath $src -Destination $tmp -Force
  Move-Item -LiteralPath $tmp -Destination $dest -Force
  $summary.restored = $summary.restored + 1
}

try {
  $targets = New-Object System.Collections.ArrayList
  if ($plan.archive) {
    if (-not (Test-Path -LiteralPath $plan.archive.path)) { throw ('备份包不存在：' + $plan.archive.path) }
    New-Item -ItemType Directory -Force -Path $stage | Out-Null
    if ($plan.archive.kind -eq 'zip') {
      Expand-Archive -LiteralPath $plan.archive.path -DestinationPath $stage -Force
    } else {
      # GNU tar 需要 --force-local 才把 C:\ 当本地路径；Windows 自带的 bsdtar 不认识这个参数
      $tarArgs = @('-xzf', $plan.archive.path, '-C', $stage)
      if ((& tar.exe --version 2>&1 | Select-Object -First 1) -match 'GNU tar') { $tarArgs = @('--force-local') + $tarArgs }
      & tar.exe @tarArgs
      if ($LASTEXITCODE -ne 0) { throw 'tar 解压失败' }
    }
    Get-ChildItem -LiteralPath $stage -Recurse -File | ForEach-Object {
      $rel = $_.FullName.Substring($stage.Length).TrimStart('\', '/') -replace '\\', '/'
      [void]$targets.Add([pscustomobject]@{ Source = $_.FullName; Rel = $rel })
    }
  }

  $byLabel = @{}
  foreach ($m in $mapping) { $byLabel[[string]$m.label] = [string]$m.source }

  Write-Host ''
  Write-Host ('待恢复 ' + $targets.Count + ' 个文件，占用策略：' + $mode)
  Write-Host '如果文件正被占用，本窗口会等待它释放，请先关闭对应程序。'
  Write-Host ''

  $index = 0
  foreach ($t in $targets) {
    $index = $index + 1
    $rel = [string]$t.Rel
    $cut = $rel.IndexOf('/')
    if ($cut -lt 0) {
      $label = ''
      $inner = $rel
    } else {
      $label = $rel.Substring(0, $cut)
      $inner = $rel.Substring($cut + 1)
    }
    if ($plan.dest) {
      $dest = Join-Path $plan.dest ($rel -replace '/', '\')
    } else {
      if (-not $byLabel.ContainsKey($label)) {
        $summary.skipped += $rel
        continue
      }
      $dest = Join-Path $byLabel[$label] ($inner -replace '/', '\')
    }
    Place $t.Source $dest $rel
    if ($index % 50 -eq 0) { Write-Host ('已处理 ' + $index + '/' + $targets.Count) }
  }
} catch {
  $summary.ok = $false
  $summary.failed += $_.Exception.Message
} finally {
  if (Test-Path -LiteralPath $stage) {
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
  }
  $summary.finishedAt = (Get-Date).ToString('o')
  $json = $summary | ConvertTo-Json -Depth 6
  [System.IO.File]::WriteAllText((Join-Path $PSScriptRoot 'result.json'), $json, $Utf8)
  Write-Host ''
  Write-Host ('恢复结束：成功 ' + $summary.restored + ' 个，跳过 ' + @($summary.skipped).Count + ' 个，旁路 ' + @($summary.sideloaded).Count + ' 个')
  if (@($summary.failed).Count -gt 0) {
    Write-Host ('失败：' + (@($summary.failed) -join '；')) -ForegroundColor Red
  }
  Write-Host '结果已写入 result.json，下次打开 DSH 的备份设置页会显示。'
}

if ($plan.relaunch -and $summary.ok) {
  Start-Process -FilePath $plan.relaunch
}
