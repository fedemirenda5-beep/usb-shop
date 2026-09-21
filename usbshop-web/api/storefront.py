"""Storefront curation, independent of backoffice catalog replacements."""
from fastapi import HTTPException

MAX_FEATURED = 8


def ensure_schema(conn, postgres=False):
    conn.execute("""CREATE TABLE IF NOT EXISTS storefront_products (
        product_id INTEGER PRIMARY KEY, sku TEXT, position INTEGER,
        last_stock INTEGER, restocked_at TIMESTAMP)""")
    conn.execute("CREATE TABLE IF NOT EXISTS storefront_settings (id INTEGER PRIMARY KEY)")
    conn.execute("""INSERT INTO storefront_products (product_id, sku, last_stock)
        SELECT id, sku, COALESCE(stock, 0) FROM products WHERE 1=1
        ON CONFLICT(product_id) DO NOTHING""")
    # Keep stock history across sync batches, including DELETE followed by INSERT.
    upsert = """INSERT INTO storefront_products (product_id, sku, last_stock)
        VALUES (NEW.id, NEW.sku, COALESCE(NEW.stock, 0))
        ON CONFLICT(product_id) DO UPDATE SET
        restocked_at = CASE
            WHEN storefront_products.sku IS DISTINCT FROM excluded.sku THEN NULL
            WHEN storefront_products.last_stock <= 0 AND excluded.last_stock > 0
            THEN CURRENT_TIMESTAMP ELSE storefront_products.restocked_at END,
        position = CASE WHEN storefront_products.sku IS DISTINCT FROM excluded.sku
            THEN NULL ELSE storefront_products.position END,
        sku = excluded.sku, last_stock = excluded.last_stock;"""
    if postgres:
        conn.execute("""CREATE OR REPLACE FUNCTION storefront_track_stock() RETURNS trigger AS $$
            BEGIN """ + upsert + " RETURN NEW; END; $$ LANGUAGE plpgsql")
        conn.execute("DROP TRIGGER IF EXISTS storefront_stock ON products")
        conn.execute("""CREATE TRIGGER storefront_stock AFTER INSERT OR UPDATE OF stock, sku ON products
            FOR EACH ROW EXECUTE FUNCTION storefront_track_stock()""")
    else:
        for event in ("INSERT", "UPDATE OF stock, sku"):
            suffix = "insert" if event == "INSERT" else "update"
            conn.execute(f"CREATE TRIGGER IF NOT EXISTS storefront_stock_{suffix} AFTER {event} ON products BEGIN {upsert} END")


def configured(conn):
    return conn.execute("SELECT id FROM storefront_settings WHERE id = 1").fetchone() is not None


def selection(conn):
    if configured(conn):
        return conn.execute("""SELECT p.id, p.name, p.sku, p.stock, p.is_active, s.position
            FROM storefront_products s JOIN products p ON p.id=s.product_id AND p.sku=s.sku
            WHERE s.position IS NOT NULL AND p.deleted_at IS NULL ORDER BY s.position""").fetchall()
    return conn.execute("""SELECT id, name, sku, stock, is_active, NULL AS position FROM products
        WHERE is_featured=1 AND deleted_at IS NULL ORDER BY id DESC""").fetchall()


def save(conn, ids):
    if not isinstance(ids, list) or any(type(value) is not int or value <= 0 for value in ids):
        raise HTTPException(400, "La selección debe contener identificadores de productos válidos")
    if len(ids) > MAX_FEATURED or len(ids) != len(set(ids)):
        raise HTTPException(400, "Elegí hasta 8 productos, sin repetir")
    for product_id in ids:
        if not conn.execute("SELECT id FROM products WHERE id=? AND deleted_at IS NULL", (product_id,)).fetchone():
            raise HTTPException(404, "Uno de los productos ya no está disponible. Actualizá la selección")
    conn.execute("INSERT INTO storefront_settings (id) VALUES (1) ON CONFLICT(id) DO NOTHING")
    conn.execute("UPDATE storefront_products SET position=NULL")
    for position, product_id in enumerate(ids):
        conn.execute("""INSERT INTO storefront_products (product_id, sku, last_stock, position)
            SELECT id, sku, stock, ? FROM products WHERE id=?
            ON CONFLICT(product_id) DO UPDATE SET position=excluded.position, sku=excluded.sku""", (position, product_id))
    restore_flags(conn)


def toggle(conn, product_id, enabled):
    rows = selection(conn)
    ids = [int(row['id']) for row in rows]
    if enabled and product_id in ids:
        return
    if enabled and len(ids) >= MAX_FEATURED:
        raise HTTPException(409, "La Vidriera tiene 8 o más destacados. Elegí cuáles mantener desde Admin → Vidriera")
    # Do not silently migrate an oversized legacy selection on a single removal.
    if not configured(conn) and len(ids) > MAX_FEATURED:
        return
    ids = [value for value in ids if value != product_id]
    if enabled:
        ids.append(product_id)
    save(conn, ids)


def restore_flags(conn):
    if configured(conn):
        conn.execute("""UPDATE products SET is_featured = CASE WHEN EXISTS (
            SELECT 1 FROM storefront_products s WHERE s.product_id=products.id
            AND s.sku=products.sku AND s.position IS NOT NULL) THEN 1 ELSE 0 END""")
