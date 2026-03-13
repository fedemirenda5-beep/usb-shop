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
- Default: `http://localhost:3000,http://127.0.0.1:3000`
- Variable opcional `USB_AUTO_SYNC` (0/1) para sincronizar automaticamente la DB local con la principal.
- Default: `1`
- Variable opcional `USB_ORDER_SECRET` para proteger `POST /orders` con el header `X-USB-ORDER-SECRET`.
- Variable opcional `USB_SYNC_SECRET` para habilitar `POST /sync/remote` con el header `X-USB-SYNC-SECRET`.
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
```
pip install -r requirements.txt
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

## Endpoints
- `GET /health`
- `GET /products?limit=50&q=`
- `GET /featured?limit=6`
- `GET /products/{id}/image`
- `POST /sync` (copia la base desde `CONTROLSTOCK_SOURCE_DB` a `CONTROLSTOCK_DB`)
- `POST /sync/remote` (requiere `USB_SYNC_SECRET` + header `X-USB-SYNC-SECRET`)
- `POST /orders` (si `USB_ORDER_SECRET` esta definido, requiere header `X-USB-ORDER-SECRET`)
