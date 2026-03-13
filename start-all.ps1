$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$webDir = Join-Path $root "usbshop-web\\app\\usbshop"
$apiDir = Join-Path $root "usbshop-web\\api"
$npm = "C:\\Program Files\\nodejs\\npm.cmd"
$python = Join-Path $apiDir ".venv\\Scripts\\python.exe"

if (-not (Test-Path $npm)) {
  throw "No se encontro npm.cmd en $npm"
}
if (-not (Test-Path $python)) {
  throw "No se encontro el venv en $python"
}

Start-Process -FilePath $python -ArgumentList "-m","uvicorn","main:app","--reload","--host","0.0.0.0","--port","8000" -WorkingDirectory $apiDir
Start-Process -FilePath $npm -ArgumentList "run","dev" -WorkingDirectory $webDir
Start-Process "http://localhost:3000"
