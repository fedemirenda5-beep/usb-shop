param(
  [string]$ApiBaseUrl = "https://api.usbshop.com.ar",
  [string]$OutputDir = ""
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$webDir = Join-Path $root "usbshop-web\app\usbshop"

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
  $OutputDir = Join-Path $root "dist\usbshop-win7"
}

if (-not (Test-Path $webDir)) {
  throw "No se encontro la carpeta web en $webDir"
}

$npmCmd = (Get-Command npm.cmd -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $npmCmd) {
  $npmCmd = (Get-Command npm -ErrorAction SilentlyContinue | Select-Object -First 1).Source
}
if (-not $npmCmd) {
  throw "No se encontro npm o npm.cmd en el sistema"
}

Write-Host "Build estatico en progreso..."
Push-Location $webDir
try {
  & $npmCmd run build | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "Fallo npm run build"
  }
} finally {
  Pop-Location
}

$outDir = Join-Path $webDir "out"
if (-not (Test-Path $outDir)) {
  throw "Next no genero la carpeta out en $outDir"
}

if (Test-Path $OutputDir) {
  Remove-Item $OutputDir -Recurse -Force
}

$siteDir = Join-Path $OutputDir "site"
New-Item -ItemType Directory -Force -Path $siteDir | Out-Null
Copy-Item (Join-Path $outDir "*") $siteDir -Recurse -Force

$config = @"
{
  "apiBaseUrl": "$ApiBaseUrl",
  "allowAbsoluteApiBaseUrlOnLocalhost": true
}
"@
Set-Content -Path (Join-Path $siteDir "usbshop-config.json") -Value $config -Encoding UTF8

Copy-Item (Join-Path $root "serve-win7-web.ps1") (Join-Path $OutputDir "serve-win7-web.ps1") -Force

$launcher = @"
@echo off
powershell -ExecutionPolicy Bypass -File "%~dp0serve-win7-web.ps1" -Root "%~dp0site"
"@
Set-Content -Path (Join-Path $OutputDir "iniciar-usbshop.bat") -Value $launcher -Encoding ASCII

$readme = @"
USB Shop exportado para Windows 7

Contenido:
- site\  -> web estatica lista para usar
- iniciar-usbshop.bat -> levanta un servidor local en http://localhost:8080
- serve-win7-web.ps1 -> servidor PowerShell sin Node

Uso en la PC destino:
1. Copiar toda esta carpeta.
2. Hacer doble click en iniciar-usbshop.bat.
3. Abrir http://localhost:8080

API configurada:
$ApiBaseUrl

Notas:
- Este paquete no necesita Node en Windows 7.
- Si PowerShell bloquea la ejecucion, correr el .bat como administrador o ejecutar el .ps1 con ExecutionPolicy Bypass.
"@
Set-Content -Path (Join-Path $OutputDir "LEEME-WINDOWS7.txt") -Value $readme -Encoding UTF8

$zipPath = "$OutputDir.zip"
if (Test-Path $zipPath) {
  Remove-Item $zipPath -Force
}

$compressArchive = Get-Command Compress-Archive -ErrorAction SilentlyContinue
if ($compressArchive) {
  Compress-Archive -Path (Join-Path $OutputDir "*") -DestinationPath $zipPath -Force
  Write-Host "Paquete listo en:"
  Write-Host "  $OutputDir"
  Write-Host "ZIP generado en:"
  Write-Host "  $zipPath"
} else {
  Write-Host "Paquete listo en:"
  Write-Host "  $OutputDir"
  Write-Host "No se genero ZIP automatico porque Compress-Archive no esta disponible."
}
