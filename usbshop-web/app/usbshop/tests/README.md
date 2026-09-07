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
