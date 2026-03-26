# ControlStock

## Web admin

La guia operativa del panel web esta en [ADMIN_WEB.md](./ADMIN_WEB.md).

Puntos base:

- En local, la web debe correr junto con la API local para leer `controlStock.db`
- En produccion, la web lee `https://api.usbshop.com.ar`
- Los modulos del admin se centralizan en `usbshop-web/app/usbshop/src/app/admin/adminModules.ts`

Aplicación de escritorio para la gestión de inventario, clientes, vendedores, ventas y cuentas corrientes.

## Windows 7

Para usar la web en una PC con Windows 7, exportala como sitio estatico y servila localmente sin Node.

Guia:

- [WINDOWS7_EXPORT.md](./WINDOWS7_EXPORT.md)

## Requisitos

- Python 3.11+
- PyQt6
- SQLite 3 (incluido con Python)

Instala las dependencias con:

```bash
pip install -r requirements.txt
```

Por defecto la aplicación utilizará el archivo de base de datos `~/controlStock.db`.
Si ya tienes la base en `C:\Users\Fede\controlStock.db`, no necesitas cambiar nada. Para apuntar a otra ruta ajusta `DatabaseConfig.path` en `controlstock/config.py`.

## Estructura del proyecto

```text
controlStock/
+-- main.py
+-- README.md
+-- requirements.txt
+-- controlstock/
    +-- __init__.py
    +-- app.py
    +-- config.py
    +-- database.py
    +-- models/
    ¦   +-- __init__.py
    ¦   +-- account_movement.py
    ¦   +-- category.py
    ¦   +-- customer.py
    ¦   +-- invoice.py
    ¦   +-- product.py
    ¦   +-- seller.py
    ¦   +-- stock_movement.py
    +-- services/
    ¦   +-- __init__.py
    ¦   +-- account_service.py
    ¦   +-- category_service.py
    ¦   +-- customer_service.py
    ¦   +-- product_service.py
    ¦   +-- report_service.py
    ¦   +-- sales_service.py
    ¦   +-- seller_service.py
    +-- ui/
        +-- __init__.py
        +-- category_dialog.py
        +-- customer_dialog.py
        +-- invoice_history_view.py
        +-- main_window.py
        +-- product_detail_dialog.py
        +-- product_dialog.py
        +-- report_dialog.py
        +-- sale_dialog.py
        +-- seller_dialog.py
```

## Flujo básico

1. Alta y administración de clientes con modo de venta (contado o cuenta corriente).
2. Alta y administración de vendedores con porcentaje de comisión.
3. Alta de productos con categoría, foto, costo, margen y precio de venta.
4. Registro de documentos de venta (factura o remito); se asigna vendedor, se elige la lista de precios, se descuenta stock y se genera la comisión correspondiente.
5. Consultas de facturas y remitos emitidos, disponibilidad de inventario y detalle por producto.
6. Cuentas corrientes: visualización de saldos por cliente y generación automática de débitos.
7. Reportes: ranking de ventas, stock bajo, listas de precios/costos, detalle de ventas/margen por período e informes de inventario (existencia y valorización).

## Próximos pasos sugeridos

- Agregar edición de clientes/productos/vendedores y registros de pagos a cuenta corriente.
- Mostrar comisiones en informes consolidados y permitir liquidaciones.
- Añadir autenticación de usuarios y pruebas automatizadas.
