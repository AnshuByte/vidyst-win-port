# Builds the portable exe and copies it to the delivery folder.
param([string]$Dest = (Join-Path $env:USERPROFILE 'Downloads\final vidyst win port exe'))
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path

Set-Location $root

if (-not (Test-Path (Join-Path $root 'vendor\ffmpeg\ffmpeg.exe'))) {
  throw 'vendor\ffmpeg\ffmpeg.exe is missing - download an ffmpeg Windows build first.'
}

if (-not (Test-Path (Join-Path $root 'node_modules\electron\dist\electron.exe'))) {
  throw 'Electron binary missing - run npm install (and node node_modules\electron\install.js).'
}

Write-Host 'Packaging with electron-builder...'
npm run dist

$exe = Get-ChildItem (Join-Path $root 'dist') -Filter '*.exe' |
       Where-Object { $_.Name -notlike '*unpacked*' } |
       Select-Object -First 1

if (-not $exe) { throw 'No exe produced in dist\' }

New-Item -ItemType Directory -Force -Path $Dest | Out-Null
Copy-Item $exe.FullName (Join-Path $Dest 'VidystWinPort.exe') -Force

Write-Host ''
Write-Host ("Built:  " + $exe.FullName)
Write-Host ("Copied: " + (Join-Path $Dest 'VidystWinPort.exe'))
Write-Host ("Size:   " + [math]::Round($exe.Length / 1MB, 1) + ' MB')
