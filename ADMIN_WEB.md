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

- `Dashboard`: usa `/admin/dashboard`, un resumen de consultas agregadas. Si la API aun no tiene esa ruta, vuelve temporalmente a `/admin/reports/overview`.
- `Productos`: operativo
- `Pedidos`: operativo
- `Clientes`: operativo sobre `customers`
- `Vendedores`: operativo sobre `sellers`, `invoices` y resumenes comerciales
- `Gastos`: operativo sobre `expenses`
- `Comprobantes`: operativo sobre `invoices`
- `Cuentas corrientes`: operativo sobre `account_movements`
- `Balances`: operativo, vista financiera propia
- `Reportes`: operativo sobre resumen comercial
- `Usuarios`: operativo sobre `users`

## Calculo de rentabilidad

- Ganancia bruta por venta: cantidad por (precio unitario vendido menos costo).
  Se conserva el resultado negativo cuando se vende por debajo del costo.
- Las notas de credito revierten la ganancia o perdida de las unidades devueltas.
  Los descuentos reducen la ganancia; su devolucion revierte esa reduccion.
- Escritorio, reportes diarios, balances y resumenes de clientes y vendedores
  usan el costo historico `cost_snapshot`; si falta, usan el costo actual.
  Un costo historico de cero es valido y no se reemplaza por el costo actual.
- El resultado operativo descuenta gastos y comisiones de la ganancia bruta.
- Los cierres anuales ya guardados y los ajustes historicos importados conservan
  sus valores. La correccion aplica a los calculos y a los nuevos cierres.
- Prueba: `.venv/Scripts/python.exe -m unittest test_admin_performance` desde
  `usbshop-web/api`. Usa una base temporal y verifica perdidas, ventas al costo,
  costo cero, devoluciones, descuentos y coincidencia entre reportes.

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

En particular, `Cuentas corrientes` quedo alineado asi:

- listado inicial: `/admin/backoffice-customers`
- detalle, altas, edicion y borrado: `/admin/cc/...`
- los comprobantes asociados son complementarios y no deben bloquear la apertura de la cuenta
- `staff` tambien tiene acceso operativo al modulo; solo se ocultan metricas globales sensibles

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

Ademas:

- los limites operativos visibles en frontend deben salir de una configuracion comun del admin; no se repiten numeros magicos por pantalla
- si un flujo necesita mas de un dataset grande para operar, primero se evalua si corresponde resolverlo por endpoint puntual en API antes de cargar listados completos en cliente

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

### Demoras de acceso

- `/auth/me` verifica la firma y el vencimiento de la cookie sin esperar la cola
  de trabajadores de consultas e imagenes. Una sesion invalida sigue devolviendo 401.
- Las conexiones PostgreSQL tienen un limite de 8 segundos, configurable con
  `USB_DB_CONNECT_TIMEOUT_SECONDS`. Este limite aplica a la conexion, no a la
  duracion de las consultas.
- `render.yaml` declara la API con `plan: free`. Si el servicio publicado usa ese
  plan, Render lo suspende tras 15 minutos sin trafico y el siguiente acceso puede
  esperar aproximadamente un minuto: https://render.com/docs/free.
  Confirmar el plan real en Render; el archivo no prueba la configuracion activa.
- Para eliminar la suspension por inactividad, usar una instancia siempre activa.
  El cambio de plan tiene costo y debe decidirse antes de modificar el alojamiento.
- Verificacion local: desde `usbshop-web/api`, ejecutar
  `.venv/Scripts/python.exe -m unittest test_api_availability test_admin_performance`.
  Incluye la verificacion de sesion con todos los trabajadores ocupados y el
  limite de conexion PostgreSQL; no usa datos productivos.

Rama operativa:

- `release` es la rama de trabajo y publicacion
- cualquier referencia a `main` o `master` en deploys debe corregirse o tratarse como compatibilidad transitoria
- no se considera valido asumir que un push a otra rama publica cambios del admin

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
