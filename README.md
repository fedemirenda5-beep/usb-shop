# USB Shop Repo

Repositorio operativo de la web publica y la API/admin de USB Shop.

## Estructura

- `usbshop-web/app/usbshop`: frontend Next.js exportado como sitio estatico
- `usbshop-web/api`: API FastAPI para admin, catalogo, pedidos, comprobantes y cuentas corrientes
- `render.yaml`: referencia de configuracion de servicios en Render
- `.github/workflows/firebase-hosting.yml`: deploy del frontend a Firebase Hosting
- `ADMIN_WEB.md`: guia operativa del panel admin y criterios para cambios

## Fuente de verdad

- Frontend publicado: `https://www.usbshop.com.ar`
- API publicada: `https://api.usbshop.com.ar`
- Config runtime web: `https://www.usbshop.com.ar/usbshop-config.json`

La web siempre consume la API. No se agregan lecturas directas desde bases o archivos en el frontend.

## Flujo local

1. Levantar la API:

```powershell
cd usbshop-web\api
pip install -r requirements.txt
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

2. Levantar la web:

```powershell
cd usbshop-web\app\usbshop
npm install
npm run dev
```

3. Entrar a:

- `http://localhost:3000`
- `http://127.0.0.1:8000/health`

## Validaciones minimas

- Frontend: `cmd /c npm run build` en `usbshop-web/app/usbshop`
- API: `python -m py_compile usbshop-web/api/main.py`

## Deploy y ramas

- `release`: rama operativa unica
- Firebase Hosting despliega desde `release`
- Cualquier referencia a `main` o `master` en automatizaciones debe considerarse residuo o compatibilidad transitoria

Si alguna infraestructura externa sigue mirando otra rama, hay que corregir esa configuracion para que el deploy real lea `release`.

## Sincronizacion de datos productivos

```powershell
$env:USBSHOP_SYNC_API_BASE_URL="https://api.usbshop.com.ar"
$env:USB_SYNC_TOKEN="TU_SECRET"
python usbshop-web\api\scripts\sync_backoffice_to_api.py
```

## Criterio de limpieza

- No dejar rutas visibles sin backend real
- No dejar defaults apuntando a dominios viejos
- No dejar ramas de deploy referenciadas que no existan
- No dejar archivos locales/cookies/debug trackeados en git
