# Pruebas del carrito

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
