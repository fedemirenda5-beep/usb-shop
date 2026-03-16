# Admin Web

## Objetivo

Mantener el panel admin operativo sin mezclar cambios a medias, fuentes de datos duplicadas o pantallas visibles sin backend real.

## Fuente de verdad

- Local: `usbshop-web/api/data/controlStock.db`
- API local: `http://127.0.0.1:8000`
- Web local: `http://localhost:3000`
- Produccion web: `https://usbshop.com.ar`
- Produccion API: `https://api.usbshop.com.ar`

Regla: el admin siempre debe leer desde la API. No se agregan pantallas que lean directo desde archivos o bases en el frontend.

## Modulos actuales

- `Dashboard`: operativo, usa `/admin/reports/overview`
- `Productos`: operativo
- `Pedidos`: operativo
- `Clientes`: operativo sobre `customers`
- `Comprobantes`: operativo sobre `invoices`
- `Cuentas corrientes`: operativo sobre `account_movements`
- `Balances`: operativo, vista financiera propia
- `Reportes`: operativo sobre resumen comercial

## Legacy

Estas rutas quedan solo por compatibilidad y no deben usarse para nuevos cambios:

- `/admin/account-customers`
- `/admin/account-customers/...`
- `/admin/account-documents`
- `/admin/account-documents/...`

La operacion actual del admin debe apoyarse en:

- `/admin/backoffice-customers`
- `/admin/invoices`
- `/admin/cc/...`
- `/admin/reports/overview`
- `/admin/orders`

## Como trabajar sin ensuciar el proyecto

Cada cambio nuevo del admin debe cerrar estas 5 capas cuando apliquen:

1. Datos
   - tabla existente o cambio de modelo claro
2. API
   - endpoint nuevo o ajuste del endpoint actual
3. UI
   - pantalla o bloque completo en `src/app/admin`
4. Navegacion
   - alta en `src/app/admin/adminModules.ts`
5. Verificacion
   - prueba manual local y build del frontend

Si una mejora no puede cerrar las capas necesarias, no debe quedar visible en el menu.

## Flujo local recomendado

1. Ejecutar `start-all.ps1`
2. Verificar que la API arranque en `127.0.0.1:8000`
3. Abrir `http://localhost:3000`
4. Entrar al admin
5. Validar:
   - clientes
   - comprobantes
   - cuentas corrientes
   - dashboard
   - balances/reportes

## Produccion

La web publicada apunta a `https://api.usbshop.com.ar`.

Para que produccion muestre clientes, comprobantes y cuentas corrientes reales, hace falta sincronizar:

```powershell
$env:USBSHOP_SYNC_API_BASE_URL="https://api.usbshop.com.ar"
$env:USB_SYNC_TOKEN="TU_SECRET"
python usbshop-web\api\scripts\sync_backoffice_to_api.py
```

Ademas, `USB_SYNC_SECRET` debe estar configurado en Render para la API.

## Checklist de cada cambio

- El cambio usa la API y no inventa una segunda fuente de datos
- El modulo aparece en `adminModules.ts` si corresponde
- El texto del menu y el nombre de pantalla son consistentes
- No quedan botones o enlaces apuntando a vistas vacias
- `cmd /c npm run build` pasa
- Si toca backend, `py_compile` sobre `usbshop-web/api/main.py` pasa
