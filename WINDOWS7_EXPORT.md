# Exportar USB Shop para Windows 7

La forma soportada para Windows 7 es usar la web exportada como sitio estatico. No se ejecuta Node en la PC destino.

## Generar el paquete

Desde una PC moderna, en la raiz del repo:

```powershell
.\export-win7-web.ps1
```

Si quieres apuntar a otra API:

```powershell
.\export-win7-web.ps1 -ApiBaseUrl "https://api.usbshop.com.ar"
```

Salida:

- `dist\usbshop-win7\site`: archivos estaticos
- `dist\usbshop-win7\iniciar-usbshop.bat`: lanza la web en `http://localhost:8080`
- `dist\usbshop-win7\serve-win7-web.ps1`: servidor local en PowerShell
- `dist\usbshop-win7.zip`: zip listo para copiar, si `Compress-Archive` esta disponible

## Usar en la PC con Windows 7

1. Copiar `dist\usbshop-win7` o el zip descomprimido.
2. Abrir `iniciar-usbshop.bat`.
3. Entrar a `http://localhost:8080`.

## API remota en localhost

El paquete exportado escribe `site\usbshop-config.json` con:

```json
{
  "apiBaseUrl": "https://api.usbshop.com.ar",
  "allowAbsoluteApiBaseUrlOnLocalhost": true
}
```

Ese flag permite que una copia local servida desde `localhost` use una API HTTPS remota. Sin eso, la app conserva el comportamiento de desarrollo y apunta a `127.0.0.1:8000`.

## Limites

- El navegador de Windows 7 tiene que soportar sitios modernos. Chrome 109 suele ser el maximo practico.
- Si la API remota no permite CORS desde `http://localhost:8080`, hay que habilitar ese origen en la API.
- Abrir `index.html` directo con `file://` no es la forma correcta. Hay que usar el servidor local incluido.
