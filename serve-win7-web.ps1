param(
  [string]$Root = "",
  [int]$Port = 8080
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Root)) {
  $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
  $Root = Join-Path $scriptDir "site"
}

$Root = [System.IO.Path]::GetFullPath($Root)
if (-not (Test-Path $Root)) {
  throw "No se encontro la carpeta del sitio: $Root"
}

Add-Type -AssemblyName System.Web

$contentTypes = @{
  ".css" = "text/css"
  ".gif" = "image/gif"
  ".htm" = "text/html"
  ".html" = "text/html"
  ".ico" = "image/x-icon"
  ".jpeg" = "image/jpeg"
  ".jpg" = "image/jpeg"
  ".js" = "application/javascript"
  ".json" = "application/json"
  ".mjs" = "application/javascript"
  ".png" = "image/png"
  ".svg" = "image/svg+xml"
  ".txt" = "text/plain"
  ".webp" = "image/webp"
  ".xml" = "application/xml"
}

function Get-SitePath {
  param([string]$RequestPath)

  if ([string]::IsNullOrWhiteSpace($RequestPath) -or $RequestPath -eq "/") {
    return Join-Path $Root "index.html"
  }

  $decoded = [System.Web.HttpUtility]::UrlDecode($RequestPath)
  $relativePath = $decoded.TrimStart("/").Replace("/", "\")
  $candidate = Join-Path $Root $relativePath

  if (Test-Path $candidate -PathType Leaf) {
    return $candidate
  }

  if (Test-Path $candidate -PathType Container) {
    $indexPath = Join-Path $candidate "index.html"
    if (Test-Path $indexPath -PathType Leaf) {
      return $indexPath
    }
  }

  if ([System.IO.Path]::GetExtension($candidate) -eq "") {
    $directoryIndex = Join-Path $candidate "index.html"
    if (Test-Path $directoryIndex -PathType Leaf) {
      return $directoryIndex
    }

    $htmlPath = "$candidate.html"
    if (Test-Path $htmlPath -PathType Leaf) {
      return $htmlPath
    }
  }

  return $null
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()

Write-Host "USB Shop disponible en http://localhost:$Port"
Write-Host "Sirviendo archivos desde $Root"
Write-Host "Ctrl+C para cerrar."

try {
  while ($listener.IsListening) {
    $context = $listener.GetContext()
    $request = $context.Request
    $response = $context.Response

    try {
      $filePath = Get-SitePath -RequestPath $request.Url.AbsolutePath
      if (-not $filePath) {
        $response.StatusCode = 404
        $buffer404 = [System.Text.Encoding]::UTF8.GetBytes("404 - No encontrado")
        $response.ContentType = "text/plain; charset=utf-8"
        $response.ContentLength64 = $buffer404.Length
        $response.OutputStream.Write($buffer404, 0, $buffer404.Length)
        continue
      }

      $fullPath = [System.IO.Path]::GetFullPath($filePath)
      if (-not $fullPath.StartsWith($Root, [System.StringComparison]::OrdinalIgnoreCase)) {
        $response.StatusCode = 403
        $buffer403 = [System.Text.Encoding]::UTF8.GetBytes("403 - Acceso denegado")
        $response.ContentType = "text/plain; charset=utf-8"
        $response.ContentLength64 = $buffer403.Length
        $response.OutputStream.Write($buffer403, 0, $buffer403.Length)
        continue
      }

      $extension = [System.IO.Path]::GetExtension($fullPath).ToLowerInvariant()
      $contentType = $contentTypes[$extension]
      if (-not $contentType) {
        $contentType = "application/octet-stream"
      }

      $bytes = [System.IO.File]::ReadAllBytes($fullPath)
      $response.StatusCode = 200
      $response.ContentType = $contentType
      $response.ContentLength64 = $bytes.Length
      $response.OutputStream.Write($bytes, 0, $bytes.Length)
    } catch {
      $response.StatusCode = 500
      $buffer500 = [System.Text.Encoding]::UTF8.GetBytes("500 - Error interno")
      $response.ContentType = "text/plain; charset=utf-8"
      $response.ContentLength64 = $buffer500.Length
      $response.OutputStream.Write($buffer500, 0, $buffer500.Length)
    } finally {
      $response.OutputStream.Close()
    }
  }
} finally {
  $listener.Stop()
  $listener.Close()
}
