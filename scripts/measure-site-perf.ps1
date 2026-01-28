param(
  [string]$OutDir = "docs/archive"
)

$ErrorActionPreference = "Stop"

function Write-Section([string]$Title) {
  "`n## $Title`n"
}

Set-Location (Split-Path -Parent $PSScriptRoot)

$repoRoot = (Get-Location).Path
$timestamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$commit = ""
try {
  $commit = (git rev-parse --short HEAD 2>$null).Trim()
} catch {
  $commit = "unknown"
}

$outPath = Join-Path $OutDir ("site-perf-baseline_{0}_{1}.md" -f $timestamp, $commit)

$report = @()
$report += "# Site Performance Baseline"
$report += ""
$report += "- Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
$report += "- Commit: $commit"
$report += "- Host: $env:COMPUTERNAME"
$report += ""

$report += Write-Section "Build (Next route sizes)"

$prevEap = $ErrorActionPreference
$ErrorActionPreference = "Continue"
$buildOutput = (& pnpm -s --filter site build 2>&1 | Out-String)
$buildExitCode = $LASTEXITCODE
$ErrorActionPreference = $prevEap

$report += '```text'
$report += ("pnpm exit code: {0}" -f $buildExitCode)
$report += ($buildOutput.TrimEnd() -split "\r?\n")
$report += '```'
$report += ""

function Add-DirStats {
  param(
    [string]$Title,
    [string]$TargetPath,
    [string[]]$IncludePatterns,
    [int]$TopN = 15
  )

  $reportLines = @()
  $reportLines += Write-Section $Title

  if (!(Test-Path -LiteralPath $TargetPath)) {
    $reportLines += ('- Missing path: {0}' -f $TargetPath)
    return $reportLines
  }

  $files =
    Get-ChildItem -LiteralPath $TargetPath -Recurse -File |
    Where-Object {
      if (!$IncludePatterns -or $IncludePatterns.Count -eq 0) { return $true }
      foreach ($p in $IncludePatterns) {
        if ($_.Name -like $p) { return $true }
      }
      return $false
    }

  $totalBytes = ($files | Measure-Object -Property Length -Sum).Sum
  if (-not $totalBytes) { $totalBytes = 0 }

  $reportLines += ('- Path: {0}' -f $TargetPath)
  $reportLines += ('- Files matched: {0}' -f $files.Count)
  $reportLines += ('- Total bytes: {0:n0}' -f $totalBytes)
  $reportLines += ""

  $top =
    $files |
    Sort-Object Length -Descending |
    Select-Object -First $TopN |
    ForEach-Object {
      $relative = $_.FullName.Replace($repoRoot, "").TrimStart('\')
      '{0:n0}  {1}' -f $_.Length, $relative
    }

  $reportLines += '```text'
  $reportLines += 'Top files:'
  $reportLines += $top
  $reportLines += '```'
  $reportLines += ""

  return $reportLines
}

$report += Add-DirStats -Title "Client bundles (.next/static/chunks)" -TargetPath "apps/site/.next/static/chunks" -IncludePatterns @("*.js", "*.css") -TopN 20

$report += Add-DirStats -Title "Public images (apps/site/public/images)" -TargetPath "apps/site/public/images" -IncludePatterns @("*.png", "*.jpg", "*.jpeg", "*.webp", "*.svg", "*.gif") -TopN 20

$reportText = ($report -join "`n").TrimEnd() + "`n"
$reportText | Set-Content -LiteralPath $outPath -Encoding UTF8

Write-Host "Wrote report: $outPath"
