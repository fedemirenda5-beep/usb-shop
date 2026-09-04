# USB Shop API

API local para leer stock y precios desde la base de datos de ControlStock.

## Requisitos
- Python 3.10+

## Configuracion
- Variable opcional `CONTROLSTOCK_DB` para la ruta de la base.
- Default: `usbshop-web\api\data\controlStock.db`
- Variable opcional `CONTROLSTOCK_DATABASE_URL` (o `DATABASE_URL`) para usar PostgreSQL.
- Variable opcional `CONTROLSTOCK_SOURCE_DB` para sincronizar desde la base principal.
- Default: `C:\Users\Fede\ControlStock\documentos\controlStock.db`
- Variable opcional `USB_ALLOWED_ORIGINS` (separadas por coma) para CORS.
- Default: `http://localhost:3000,http://127.0.0.1:3000,http://localhost:8080,http://127.0.0.1:8080`
- Variable opcional `USB_ALLOWED_ORIGIN_REGEX` para aceptar variantes del dominio via regex.
- Default: `^https://([a-z0-9-]+\.)*usbshop\.com\.ar$`
- Variable opcional `USB_AUTO_SYNC` (0/1) para sincronizar automaticamente la DB local con la principal.
- Default: `1`
- Variable obligatoria en produccion `USB_AUTH_SECRET` para firmar sesiones. Configurarla en el panel de Render, nunca en Git.
- Variable temporal `USB_LEGACY_AUTH_SECRET` para validar hashes anteriores durante una rotacion. Debe conservar el secreto viejo hasta que todos los usuarios hayan iniciado sesion al menos una vez.
- Limite de accesos fallidos: `USB_AUTH_LOGIN_MAX_FAILURES` y `USB_AUTH_LOGIN_LOCKOUT_SECONDS`.
- Defaults: 8 intentos durante 15 minutos por usuario.
- Variables opcionales `USB_ADMIN_USERNAME` y `USB_ADMIN_PASSWORD` para crear o actualizar un admin bootstrap al iniciar login.
- Variable opcional `USB_ORDER_SECRET` para proteger `POST /orders` con el header `X-USB-ORDER-SECRET`.
- Variable opcional `USB_SYNC_TOKEN` o `USB_SYNC_SECRET` para habilitar sincronizaciones remotas administrativas.
- Log de errores: `usbshop-web\api\logs\api.log`
- Email de pedidos:
  - `USB_MAIL_PROVIDER=mailgun` (recomendado) o `smtp`
  - `USB_ORDER_NOTIFY_EMAIL` (destino interno)
  - `USB_MAIL_FROM` (remitente)
  - Mailgun: `USB_MAILGUN_API_BASE_URL`, `USB_MAILGUN_DOMAIN`, `USB_MAILGUN_API_KEY`
  - SMTP fallback: `USB_SMTP_HOST`, `USB_SMTP_PORT`, `USB_SMTP_USER`, `USB_SMTP_PASSWORD`, `USB_SMTP_FROM`, `USB_SMTP_USE_TLS`

## Destacados
- Se agrega la columna `is_featured` en `products`.
- Para marcar destacados: `UPDATE products SET is_featured = 1 WHERE id = X`.

## Ejecutar
```bash
pip install -r requirements.txt
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

## Sincronizar catalogo, stock, cuentas corrientes y comprobantes a la API publicada
```powershell
set USBSHOP_SYNC_API_BASE_URL=https://api.usbshop.com.ar
set USB_SYNC_TOKEN=tu-token
python usbshop-web\api\scripts\sync_backoffice_to_api.py
```

Esto empuja `categories`, `products`, `product_images`, `product_bundle_items`, `customers`, `invoices`, `invoice_items` y `account_movements` desde la base local actual hacia la API remota para que el panel admin use el mismo catalogo y stock real que ControlStock.

## Auditar o migrar imagenes locales de productos
```powershell
python usbshop-web\api\scripts\migrate_product_images.py --strategy audit --report image-audit.json
python usbshop-web\api\scripts\migrate_product_images.py --strategy copy-local --apply --report image-copy.json
```

- `audit` no toca la base y solo informa que referencias locales se pueden resolver.
- `copy-local` copia las imagenes encontradas a `usbshop-web\api\catalog_assets\productos\...` y actualiza la base en una transaccion.
- `supabase` requiere `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` y `SUPABASE_BUCKET` para subir a almacenamiento estable y actualizar la base con URLs publicas.
- Antes de aplicar cambios se crea un backup `controlStock.before-image-migration-YYYYMMDDHHMMSS.db`.

## Estrategia recomendada para imagenes

- `catalog_assets/productos/...` es el origen local estable para la web.
- Las imagenes migradas ahi se sirven por `/catalog-assets/...` con cache de 7 dias.
- `/products/{id}/image` queda para compatibilidad y referencias legacy.
- No guardar nuevas referencias a rutas absolutas de Windows ni a `dist\...`.
- Ver [IMAGE_STRATEGY.md](./IMAGE_STRATEGY.md).

## Endpoints
- `GET /health`
- `GET /products?limit=50&q=`
- `GET /featured?limit=6`
- `GET /products/{id}/image`
- `GET /catalog-assets/{asset_path}`
- `POST /sync` (copia la base desde `CONTROLSTOCK_SOURCE_DB` a `CONTROLSTOCK_DB`)
- `POST /sync/remote` (requiere `USB_SYNC_TOKEN` o `USB_SYNC_SECRET`)
- `POST /orders` (si `USB_ORDER_SECRET` esta definido, requiere header `X-USB-ORDER-SECRET`)

## Rotacion de secreto de autenticacion

1. Desplegar una version que soporte hashes PBKDF2 y configurar `USB_LEGACY_AUTH_SECRET` con el secreto actual.
2. Cambiar `USB_AUTH_SECRET` por un valor aleatorio nuevo desde Environment en Render.
3. Mantener `USB_LEGACY_AUTH_SECRET` hasta que los usuarios activos hayan vuelto a iniciar sesion; cada acceso actualiza su hash automaticamente.
4. Eliminar `USB_LEGACY_AUTH_SECRET` y revocar las sesiones activas cuando la migracion este completa.
