# Estrategia de Imagenes de Producto

## Objetivo

Tener imagenes de producto estables, rapidas y recuperables sin depender de rutas locales fuera del repo ni de carpetas temporales de `dist`.

## Regla operativa

- Origen preferido: `usbshop-web/api/catalog_assets/productos/...`
- Origen alternativo estable: URL publica de Supabase
- Origen a evitar: rutas absolutas locales como `C:\...`
- Origen prohibido para web: archivos dentro de `dist\...`

## Criterio de performance

- Las imagenes en `catalog_assets` se sirven por `/catalog-assets/...`
- Esa ruta evita una consulta a base por cada imagen
- Esa ruta responde con `Cache-Control` de 7 dias
- Las URLs remotas se conservan si ya son validas
- El proxy `/products/{id}/image` queda para compatibilidad y para referencias locales legacy que aun no fueron migradas

## Flujo de recuperacion

1. Auditar referencias locales:
   `python usbshop-web\api\scripts\migrate_product_images.py --strategy audit --report image-audit.json`
2. Migrar recuperables al repo:
   `python usbshop-web\api\scripts\migrate_product_images.py --strategy copy-local --apply --report image-copy.json`
3. Si se prefiere storage externo:
   `python usbshop-web\api\scripts\migrate_product_images.py --strategy supabase --apply --report image-supabase.json`

## Estado esperado despues de cada alta nueva

- El producto debe terminar con:
  - URL remota valida de Supabase, o
  - ruta relativa `catalog_assets/productos/...`
- No debe guardarse:
  - una ruta absoluta de Windows
  - una ruta dentro de `dist`

## Pendientes historicos

- Si una referencia local no se puede resolver desde `C:\Users\Fede\ControlStock\documentos\Catálogo` ni desde otros backups, queda como faltante historico y debe reponerse desde la imagen original.
