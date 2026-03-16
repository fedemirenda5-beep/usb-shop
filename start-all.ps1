$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$webDir = Join-Path $root "usbshop-web\\app\\usbshop"
$apiDir = Join-Path $root "usbshop-web\\api"
$npm = "C:\\Program Files\\nodejs\\npm.cmd"
$pythonCandidates = @(
  (Join-Path $apiDir ".venv\\Scripts\\python.exe"),
  (Join-Path $apiDir ".venv38\\Scripts\\python.exe")
)

if (-not (Test-Path $npm)) {
  throw "No se encontro npm.cmd en $npm"
}

$python = $null
foreach ($candidate in $pythonCandidates) {
  if (-not (Test-Path $candidate)) {
    continue
  }
  $check = & $candidate -m uvicorn --version 2>$null
  if ($LASTEXITCODE -eq 0) {
    $python = $candidate
    break
  }
}

if (-not $python) {
  throw "No se encontro un entorno Python valido con uvicorn en usbshop-web\\api"
}

Start-Process -FilePath $python -ArgumentList "-m","uvicorn","main:app","--reload","--host","0.0.0.0","--port","8000" -WorkingDirectory $apiDir
Start-Process -FilePath $npm -ArgumentList "run","dev" -WorkingDirectory $webDir
Start-Process "http://localhost:3000"
