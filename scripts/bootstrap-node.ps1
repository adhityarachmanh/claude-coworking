# Bootstrap for setup.cmd: lets a Windows machine WITHOUT Node.js run scripts/setup.mjs.
# It uses the portable runtime first, then a system Node, and only then downloads the official Node.js LTS
# win-x64 ZIP into <runtime>\node (no admin, no PATH changes). The ZIP is checked against nodejs.org's
# SHASUMS256.txt before anything is extracted or executed.
# PowerShell 5.1 compatible. Exit code is setup.mjs's (0 ready, 1 not ready, 2 error).

[CmdletBinding()]
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$SetupArgs = @())

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
$NodeMajor = 24

function Fail([string]$Message) {
  Write-Host "  [!!] $Message" -ForegroundColor Yellow
  exit 2
}

$appDir = Split-Path -Parent $PSScriptRoot
$checkOnly = ($SetupArgs -contains '--check')
$runtimeDir = $env:OFFICE_RUNTIME_DIR
if (-not $runtimeDir) {
  if (Test-Path (Join-Path $appDir 'server.js')) {
    $runtimeDir = Join-Path $appDir 'runtime'
  } else {
    $base = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $env:USERPROFILE 'AppData\Local' }
    $runtimeDir = Join-Path $base 'AdhitOffice\runtime'
  }
}
$nodeRoot = Join-Path $runtimeDir 'node'

function Find-RuntimeNode {
  $current = Join-Path $nodeRoot 'current.txt'
  if (Test-Path $current) {
    $version = (Get-Content $current -TotalCount 1).Trim()
    if ($version -match '^v?\d+\.\d+\.\d+') {
      $clean = $version.TrimStart('v')
      $exe = Join-Path $nodeRoot "$clean\node.exe"
      if (Test-Path $exe) { return $exe }
    }
  }
  return $null
}

function Find-SystemNode {
  $command = Get-Command node -ErrorAction SilentlyContinue
  if ($command -and $command.Source) { return $command.Source }
  return $null
}

$node = Find-RuntimeNode
$from = 'runtime'
if (-not $node) {
  $node = Find-SystemNode
  $from = 'sistem'
}

if (-not $node) {
  if ($checkOnly) {
    Write-Host '  [!!] Node.js belum terpasang (runtime Adhitron maupun sistem).'
    exit 1
  }
  Write-Host ''
  Write-Host '  Node.js belum ada. Adhitron bisa mengunduh Node.js LTS resmi (win-x64, +/- 30 MB) ke folder runtime-nya.'
  Write-Host '  Tanpa administrator, tanpa mengubah PATH sistem. SHA-256 diperiksa sebelum dipakai.'
  $answer = 'y'
  if (-not $env:CI) {
    $reply = Read-Host '  Unduh Node.js sekarang? [Y/n]'
    if ($reply) { $answer = $reply }
  }
  if ($answer -notmatch '^[yY]') {
    Write-Host '  [!!] Dibatalkan. Pasang Node.js 20+ dari https://nodejs.org lalu jalankan setup.cmd lagi.'
    exit 1
  }

  try {
    Write-Host '  Mengambil daftar rilis Node.js...'
    $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing
    $release = $index | Where-Object { $_.lts -and $_.version -match "^v$NodeMajor\." -and ($_.files -contains 'win-x64-zip') } | Select-Object -First 1
    if (-not $release) {
      $release = $index | Where-Object { $_.lts -and ($_.files -contains 'win-x64-zip') } | Select-Object -First 1
    }
    if (-not $release) { Fail 'Tidak ada rilis LTS win-x64 di nodejs.org.' }
    $version = $release.version
    $zipName = "node-$version-win-x64.zip"
    $baseUrl = "https://nodejs.org/dist/$version"
    Write-Host "  Node.js $version"
    New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
    $tmp = Join-Path $runtimeDir 'tmp-node'
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    $zipFile = Join-Path $tmp $zipName
    $sumsFile = Join-Path $tmp 'SHASUMS256.txt'
    Invoke-WebRequest -Uri "$baseUrl/$zipName" -OutFile $zipFile -UseBasicParsing
    Invoke-WebRequest -Uri "$baseUrl/SHASUMS256.txt" -OutFile $sumsFile -UseBasicParsing
    $line = Get-Content $sumsFile | Where-Object { $_ -match "\s\*?$([regex]::Escape($zipName))\s*$" } | Select-Object -First 1
    if (-not $line) { Fail 'Checksum Node.js tidak ditemukan.' }
    $expected = ($line -split '\s+')[0].ToLowerInvariant()
    $actual = (Get-FileHash -Algorithm SHA256 -Path $zipFile).Hash.ToLowerInvariant()
    if ($expected -ne $actual) { Fail 'Checksum Node.js tidak cocok. Unduhan dibatalkan.' }

    Write-Host '  Mengekstrak...'
    Expand-Archive -Path $zipFile -DestinationPath $tmp -Force
    $extracted = Join-Path $tmp "node-$version-win-x64"
    if (-not (Test-Path $extracted)) { Fail 'Isi ZIP Node.js tidak seperti yang diharapkan.' }
    $clean = $version.TrimStart('v')
    $target = Join-Path $nodeRoot $clean
    New-Item -ItemType Directory -Force -Path $nodeRoot | Out-Null
    if (Test-Path $target) { Remove-Item $target -Recurse -Force }
    Move-Item -Path $extracted -Destination $target
    Set-Content -Path (Join-Path $nodeRoot 'current.txt') -Value $clean -Encoding ASCII
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    $node = Join-Path $target 'node.exe'
    if (-not (Test-Path $node)) { Fail 'node.exe tidak ditemukan setelah ekstrak.' }
    & $node --version | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail 'node.exe hasil ekstrak tidak bisa dijalankan.' }
    $from = 'runtime'
  } catch {
    Fail "Gagal menyiapkan Node.js: $($_.Exception.Message)"
  }
}

Write-Host "  Node.js dari $from"
$setup = Join-Path $appDir 'scripts\setup.mjs'
if (-not (Test-Path $setup)) { Fail "scripts\setup.mjs tidak ditemukan di $appDir." }
& $node $setup @SetupArgs
exit $LASTEXITCODE
