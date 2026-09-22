# Pruebas del carrito

## Acceso móvil al admin

`node --test tests/api-recovery.test.cjs` verifica reintentos de lectura/login,
errores de red de Safari, cancelaciones y que las ventas no se repitan automáticamente.

Después de compilar, servir `out` en el puerto 3012 y ejecutar
`node tests/admin-mobile-session.cjs` con Playwright disponible. Acepta
`PLAYWRIGHT_MODULE` y `TEST_WEB_URL`. Simula una pantalla móvil en Chromium,
login lento, almacenamiento bloqueado, cookies rechazadas, cortes temporales,
recuperación de conexión y vencimiento real de sesión. No usa cuentas reales.

## IMEI y garantías

La API se verifica con `python -m unittest test_imei_tracking`, desde `usbshop-web/api`
y usando su entorno virtual. Las pruebas crean una base descartable y cubren venta,
duplicados, concurrencia, devolución, reventa, rollback, cliente histórico y garantía.

Para probar ingreso por lector, venta obligatoria con IMEI, consulta y vista móvil,
compilar con `npm run build`, servir `out` localmente en el puerto 3012 y ejecutar
`node tests/imeis.cjs`. Requiere Playwright; `PLAYWRIGHT_MODULE` permite indicar una
instalación existente y `TEST_WEB_URL` cambiar el servidor. Las peticiones de API
están interceptadas: no se crean ventas reales.

## Catalogo y sesion del admin

Crear el build con `npm run build` y servir `out` en `http://127.0.0.1:3010`
(por ejemplo, `python -m http.server 3010 --bind 127.0.0.1 --directory out`).
Ejecutar `node tests/catalog-admin.cjs`, con Playwright disponible o `PLAYWRIGHT_MODULE`
apuntando a su modulo. `TEST_WEB_URL` permite cambiar la URL del servidor.

La prueba usa 225 productos simulados y verifica categorias fuera de la primera
pagina, recuperacion de errores, productos no destacados, busquedas de mas de 48
resultados, renderizado inicial de 12 tarjetas y verificacion/expiracion de sesion.
Todas las llamadas a la API estan interceptadas; no accede al admin productivo.

## Pruebas unitarias del carrito

Desde `usbshop-web/app/usbshop`:

```powershell
node --test tests/cart.test.cjs
```

Para probar el navegador, iniciar `npm run dev -- --hostname 127.0.0.1` en otra terminal y ejecutar:

```powershell
node tests/mobile-cart.cjs
```

La prueba de navegador requiere Playwright y Chromium instalados. Si Playwright esta
fuera del proyecto, definir `PLAYWRIGHT_MODULE` con la ruta a su modulo Node.
Las peticiones de productos y pedidos del navegador se interceptan con respuestas
simuladas: estas pruebas no crean pedidos reales.

Se verifica escritura sin perder foco, apertura y cierre del panel, acceso al boton
de confirmar, consultas de stock que se estabilizan y un unico pedido por confirmacion.
Incluye el panel movil a 320 y 390 px y `/carrito/` a 390 y 1280 px.

## Compra completa con API real y base temporal

Iniciar una instancia nueva de la API de prueba (usa una base descartable y desactiva emails):

```powershell
cd usbshop-web/api
.\.venv\Scripts\python.exe test_consignments.py --serve
```

Con la web local iniciada, ejecutar desde `usbshop-web/app/usbshop`:

```powershell
node tests/checkout-integration.cjs
```

La prueba agrega un producto desde el catalogo, aumenta y reduce cantidades,
recarga el carrito, completa los datos y confirma. Consulta luego la API para
verificar un unico pedido, sus items, el total, una sola reserva de stock y que
el carrito quede vacio al navegar. Incluye perder la respuesta despues de guardar
el pedido y reintentar tras recargar, en ambas pantallas de confirmacion.

Para verificar el frontend publicado, definir `CHECKOUT_WEB_URL=https://www.usbshop.com.ar`.
Incluso en ese modo, las llamadas al catalogo y pedidos se redirigen a la API
local del puerto 8011: no se generan pedidos ni se prueban escrituras en produccion.
Reiniciar la API temporal antes de repetir toda la prueba para restaurar el stock.
