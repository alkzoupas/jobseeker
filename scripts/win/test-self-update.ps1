# The Windows updater, run for real against a throwaway install.
#
#   powershell -ExecutionPolicy Bypass -File scripts\win\test-self-update.ps1
#
# scripts/test-update.mjs drives the bash updater only, so nothing exercised self-update.ps1 -- and
# the one thing that goes wrong on Windows and nowhere else, a file held open by another process in
# the middle of the swap, turned out to lose the server folder while reporting "rolled back".
# Everything happens under %TEMP%. Nothing is launched and nothing outside that folder is touched.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$base = Join-Path $env:TEMP ("jobseeker-updtest-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
$inst = Join-Path $base "inst"
$fail = 0
$utf8 = New-Object Text.UTF8Encoding $false
Add-Type -AssemblyName System.IO.Compression.FileSystem

# The tree as a release would ship it: no checkout, no dependencies, none of the user's own files.
function Copy-Tree([string]$to) {
  New-Item -ItemType Directory -Force -Path $to | Out-Null
  & robocopy $root $to /E /NFL /NDL /NJH /NJS /NP /XD .git node_modules data config | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)" }
  # A successful update refreshes the Start Menu and Desktop shortcuts. Left real, that repoints
  # this machine's own shortcuts at a throwaway folder that is about to be deleted.
  Set-Content -LiteralPath (Join-Path $to "scripts\win\make-shortcuts.ps1") -Value "exit 0"
}
function Set-Version([string]$dir, [string]$v, [string]$node) {
  $p = Join-Path $dir "package.json"
  $t = [IO.File]::ReadAllText($p) -replace '"version":\s*"[^"]+"', ('"version": "' + $v + '"')
  if ($node) { $t = $t -replace '"node":\s*"[^"]+"', ('"node": "' + $node + '"') }
  [IO.File]::WriteAllText($p, $t, $utf8)
}
# GitHub's layout: one <repo>-<ref> folder holding the tree.
function New-Release([string]$name, [scriptblock]$tweak) {
  $w = Join-Path $base "rel-$name\jobseeker-0.99.0"
  Copy-Tree $w
  Set-Version $w "0.99.0" ""
  if ($tweak) { & $tweak $w }
  $zip = Join-Path $base "$name.zip"
  [IO.Compression.ZipFile]::CreateFromDirectory((Split-Path -Parent $w), $zip)
  return $zip
}
function Run-Update([string]$url, [switch]$Check) {
  $status = Join-Path $inst "data\.setup\update.json"
  Remove-Item -LiteralPath $status -Force -ErrorAction SilentlyContinue
  $env:JOBSEEKER_URL = $url
  # The updater re-launches itself from %TEMP% and reads these to know it has; a value left over
  # from the last case would make it skip that step.
  $env:JOBSEEKER_UPDATE_STAGE = $null; $env:JOBSEEKER_REPO = $null; $env:JOBSEEKER_UPDATER_TMP = $null
  $a = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $inst "scripts\win\self-update.ps1"), "-Tag", "v0.99.0")
  if ($Check) { $a += "-Check" }
  & powershell.exe @a | Out-Null
  $st = $null
  for ($i = 0; $i -lt 240; $i++) {
    Start-Sleep -Milliseconds 500
    try { $st = Get-Content -Raw -LiteralPath $status | ConvertFrom-Json } catch { $st = $null }
    if ($st -and @("done", "failed", "refused", "checked") -contains $st.phase) { break }
  }
  return $st
}
function Ver { (Get-Content -Raw -LiteralPath (Join-Path $inst "package.json") | ConvertFrom-Json).version }
function Check([bool]$ok, [string]$name, $detail = "") {
  if (-not $ok) { $script:fail++ }
  Write-Output ("  {0}  {1}{2}" -f $(if ($ok) { "ok  " } else { "FAIL" }), $name, $(if ("$detail") { " -- $detail" } else { "" }))
}
function Has([string]$rel) { Test-Path -LiteralPath (Join-Path $inst $rel) }

try {
  Write-Output "`nself-update.ps1`n"
  Copy-Tree $inst
  Set-Version $inst "0.1.0" ""
  foreach ($d in "config", "data", ".claude") { New-Item -ItemType Directory -Force -Path (Join-Path $inst $d) | Out-Null }
  # A port nothing uses, so the stop step can never mistake a real JobSeeker for this one.
  Set-Content -LiteralPath (Join-Path $inst "config\job-seeker.config.md") -Value "---`ndashboard_port: 4391`n---`n"
  Set-Content -LiteralPath (Join-Path $inst "data\mine.md") -Value "my data"
  Set-Content -LiteralPath (Join-Path $inst ".claude\settings.local.json") -Value "{}"
  Set-Content -LiteralPath (Join-Path $inst "gone-upstream.txt") -Value "stale"

  $good = New-Release "good" $null
  $noparse = New-Release "noparse" { param($w) Add-Content -LiteralPath (Join-Path $w "server\dashboard.mjs") -Value "`nthis is (not javascript" }
  $oldnode = New-Release "oldnode" { param($w) Set-Version $w "0.99.0" ">=99" }
  $env:JOBSEEKER_NO_LAUNCH = "1"

  $st = Run-Update $good -Check
  Check ($st.phase -eq "checked" -and (Ver) -eq "0.1.0") "-Check verifies and changes nothing" $st.phase

  $st = Run-Update $noparse
  Check ($st.phase -eq "failed" -and "$($st.error)" -match "parse" -and (Ver) -eq "0.1.0") "a release whose dashboard does not parse is refused" $st.error

  $st = Run-Update $oldnode
  Check ($st.phase -eq "failed" -and "$($st.error)" -match "needs Node 99" -and (Ver) -eq "0.1.0") "a release that needs a newer Node is refused" $st.error

  $st = Run-Update "http://example.com/x.zip"
  Check ($st.phase -eq "failed" -and "$($st.error)" -match "https" -and (Ver) -eq "0.1.0") "a plain http download is refused" $st.error

  # A file held open, as antivirus or a stray node would hold it: the folder cannot be moved.
  $held = [IO.File]::Open((Join-Path $inst "server\md.mjs"), "Open", "Read", "None")
  try { $st = Run-Update $good } finally { $held.Close() }
  Check ($st.phase -eq "failed" -and $st.rolledBack -eq $true -and (Ver) -eq "0.1.0") "a swap that cannot finish fails and says it rolled back" $st.error
  Check ((Has "server\dashboard.mjs") -and (Has "server\md.mjs") -and (Has "scripts\win\self-update.ps1") -and (Has "gone-upstream.txt") -and (Has "data\mine.md")) "...and everything really is back"
  Check (-not (Has "data\.setup\update.broken")) "...with no broken marker left"

  $st = Run-Update $good
  Check ($st.phase -eq "done" -and (Ver) -eq "0.99.0") "the real update lands" $st.error
  Check ((Has "data\mine.md") -and (Has ".claude\settings.local.json") -and (Has "config\job-seeker.config.md")) "...and the user's files survive"
  Check (-not (Has "gone-upstream.txt")) "...and a file gone upstream is gone"
  Check (@(Get-ChildItem -LiteralPath $base -Force -Filter ".jobseeker-update-*").Count -eq 0) "...and no staging folder is left behind"
} finally {
  Remove-Item -LiteralPath $base -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Output $(if ($fail) { "`nFAIL -- $fail check(s) failed`n" } else { "`nPASS`n" })
exit $(if ($fail) { 1 } else { 0 })
