"""Consignment balances. Callers own the inventory lock and transaction."""
from datetime import datetime
import uuid

from fastapi import HTTPException


def ensure_schema(conn):
    identity = "SERIAL PRIMARY KEY" if conn.is_postgres else "INTEGER PRIMARY KEY AUTOINCREMENT"
    conn.execute(f"""
        CREATE TABLE IF NOT EXISTS consignments (
            id {identity}, customer_id INTEGER NOT NULL REFERENCES customers(id),
            created_at TEXT NOT NULL, notes TEXT, request_key TEXT NOT NULL UNIQUE
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS consignment_items (
            consignment_id INTEGER NOT NULL REFERENCES consignments(id),
            product_id INTEGER NOT NULL REFERENCES products(id),
            delivered INTEGER NOT NULL CHECK (delivered > 0),
            sold INTEGER NOT NULL DEFAULT 0 CHECK (sold >= 0),
            returned INTEGER NOT NULL DEFAULT 0 CHECK (returned >= 0),
            PRIMARY KEY (consignment_id, product_id),
            CHECK (sold + returned <= delivered)
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS consignment_movements (
            id TEXT PRIMARY KEY, consignment_id INTEGER NOT NULL REFERENCES consignments(id),
            product_id INTEGER NOT NULL REFERENCES products(id),
            kind TEXT NOT NULL, quantity INTEGER NOT NULL CHECK (quantity > 0),
            invoice_id INTEGER, created_at TEXT NOT NULL, request_key TEXT NOT NULL,
            UNIQUE (request_key, product_id, kind)
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_consignment_customer ON consignments(customer_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_consignment_product ON consignment_items(product_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_consignment_invoice ON consignment_movements(invoice_id)")
    conn.execute("""CREATE TABLE IF NOT EXISTS consignment_invoice_requests (
        request_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
        consignment_id INTEGER NOT NULL REFERENCES consignments(id),
        invoice_id INTEGER UNIQUE REFERENCES invoices(id) ON DELETE SET NULL
    )""")


def reserved_stock(conn):
    return {int(row['product_id']): int(row['quantity']) for row in conn.execute("""
        SELECT product_id, SUM(delivered - sold - returned) AS quantity
        FROM consignment_items GROUP BY product_id HAVING SUM(delivered - sold - returned) > 0
    """).fetchall()}


def positive_int(value, label="Cantidad"):
    try:
        number = int(value)
        if isinstance(value, bool) or number <= 0 or float(value) != number:
            raise ValueError()
        return number
    except (ValueError, TypeError, OverflowError):
        raise HTTPException(400, f"{label} debe ser un entero mayor a cero")


def normalize_items(items):
    if not isinstance(items, list) or not items:
        raise HTTPException(400, "Agrega productos a la consignacion")
    result = {}
    for item in items:
        if not isinstance(item, dict):
            raise HTTPException(400, "Producto invalido")
        product_id = positive_int(item.get('product_id'), 'Producto')
        result[product_id] = result.get(product_id, 0) + positive_int(item.get('quantity'))
    return result


def request_key(payload):
    key = str(payload.get('idempotency_key') or '').strip()
    if not key or len(key) > 128:
        raise HTTPException(400, "Identificador de operacion requerido")
    return key


def movement(conn, consignment_id, product_id, kind, quantity, key, invoice_id=None):
    conn.execute("""
        INSERT INTO consignment_movements
            (id, consignment_id, product_id, kind, quantity, invoice_id, created_at, request_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    """, (str(uuid.uuid4()), consignment_id, product_id, kind, quantity,
          invoice_id, datetime.utcnow().isoformat(), key))


def detail(conn, consignment_id):
    row = conn.execute("""
        SELECT c.*, cu.name AS customer_name FROM consignments c
        JOIN customers cu ON cu.id = c.customer_id WHERE c.id = ?
    """, (consignment_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "Consignacion no encontrada")
    result = dict(row)
    result.pop('request_key', None)
    result['items'] = [dict(item) for item in conn.execute("""
        SELECT ci.*, p.name, p.sku, p.price, p.stock AS general_stock,
               ci.delivered - ci.sold - ci.returned AS pending
        FROM consignment_items ci JOIN products p ON p.id = ci.product_id
        WHERE ci.consignment_id = ? ORDER BY p.name, p.id
    """, (consignment_id,)).fetchall()]
    result['movements'] = [dict(item) for item in conn.execute("""
        SELECT m.*, p.name FROM consignment_movements m JOIN products p ON p.id = m.product_id
        WHERE consignment_id = ? ORDER BY created_at DESC, id
    """, (consignment_id,)).fetchall()]
    result['pending'] = sum(item['pending'] for item in result['items'])
    return result


def list_consignments(conn, q='', customer_id=None, pending_only=True, limit=100, offset=0):
    conditions, params = [], []
    if customer_id:
        conditions.append('c.customer_id = ?')
        params.append(customer_id)
    if q.strip():
        conditions.append("""(LOWER(cu.name) LIKE ? OR EXISTS (
            SELECT 1 FROM consignment_items qi JOIN products p ON p.id = qi.product_id
            WHERE qi.consignment_id = c.id AND (LOWER(p.name) LIKE ? OR LOWER(p.sku) LIKE ?)
        ))""")
        params.extend(['%' + q.strip().lower() + '%'] * 3)
    where = 'WHERE ' + ' AND '.join(conditions) if conditions else ''
    having = 'HAVING SUM(ci.delivered - ci.sold - ci.returned) > 0' if pending_only else ''
    return [dict(row) for row in conn.execute(f"""
        SELECT c.id, c.customer_id, cu.name AS customer_name, c.created_at, c.notes,
               SUM(ci.delivered) AS delivered, SUM(ci.sold) AS sold, SUM(ci.returned) AS returned,
               SUM(ci.delivered - ci.sold - ci.returned) AS pending
        FROM consignments c JOIN customers cu ON cu.id = c.customer_id
        JOIN consignment_items ci ON ci.consignment_id = c.id
        {where} GROUP BY c.id, c.customer_id, cu.name, c.created_at, c.notes {having}
        ORDER BY c.id DESC LIMIT ? OFFSET ?
    """, [*params, limit, offset]).fetchall()]


def create(conn, payload, quantities, reservations):
    key = request_key(payload)
    customer_id = positive_int(payload.get('customer_id'), 'Cliente')
    existing = conn.execute('SELECT id, customer_id, notes FROM consignments WHERE request_key = ?', (key,)).fetchone()
    notes = str(payload.get('notes') or '').strip()
    if existing:
        previous = detail(conn, existing['id'])
        if (existing['customer_id'] != customer_id or (existing['notes'] or '') != notes
                or {item['product_id']: item['delivered'] for item in previous['items']} != quantities):
            raise HTTPException(409, 'La operacion ya fue utilizada con otros datos')
        return previous
    customer = conn.execute("""SELECT id FROM customers
        WHERE id = ? AND deleted_at IS NULL AND COALESCE(is_active, 1) = 1""", (customer_id,)).fetchone()
    if not customer:
        raise HTTPException(404, 'Cliente no encontrado')
    for product_id, quantity in quantities.items():
        product = conn.execute("""SELECT name, stock FROM products
            WHERE id = ? AND deleted_at IS NULL AND COALESCE(is_active, 1) = 1""", (product_id,)).fetchone()
        if not product:
            raise HTTPException(404, f'Producto {product_id} no encontrado')
        available = int(product['stock'] or 0) - reservations.get(product_id, 0)
        if quantity > available:
            raise HTTPException(400, f"Stock disponible insuficiente para {product['name']}: {max(0, available)}")
    sql = 'INSERT INTO consignments (customer_id, created_at, notes, request_key) VALUES (?, ?, ?, ?)'
    created_at = str(payload.get('created_at') or '').strip() or datetime.utcnow().isoformat()
    params = (customer_id, created_at, notes, key)
    if conn.is_postgres:
        consignment_id = conn.execute(sql + ' RETURNING id', params).fetchone()['id']
    else:
        consignment_id = conn.execute(sql, params).lastrowid
    for product_id, quantity in quantities.items():
        conn.execute('INSERT INTO consignment_items (consignment_id, product_id, delivered) VALUES (?, ?, ?)',
                     (consignment_id, product_id, quantity))
        movement(conn, consignment_id, product_id, 'DELIVERY', quantity, key)
    return detail(conn, consignment_id)


def return_items(conn, consignment_id, payload):
    key = request_key(payload)
    quantities = normalize_items(payload.get('items'))
    previous = conn.execute("SELECT * FROM consignment_movements WHERE request_key = ? AND kind = 'RETURN'", (key,)).fetchall()
    if previous:
        if any(row['consignment_id'] != consignment_id for row in previous) or {
            row['product_id']: row['quantity'] for row in previous
        } != quantities:
            raise HTTPException(409, 'La operacion ya fue utilizada con otros datos')
        return detail(conn, consignment_id)
    pending = {item['product_id']: item['pending'] for item in detail(conn, consignment_id)['items']}
    for product_id, quantity in quantities.items():
        if quantity > pending.get(product_id, 0):
            raise HTTPException(400, 'La devolucion supera las unidades pendientes del cliente')
        conn.execute('UPDATE consignment_items SET returned = returned + ? WHERE consignment_id = ? AND product_id = ?',
                     (quantity, consignment_id, product_id))
        movement(conn, consignment_id, product_id, 'RETURN', quantity, key)
    return detail(conn, consignment_id)


def validate_sale(conn, consignment_id, customer_id, items):
    consignment = detail(conn, consignment_id)
    if consignment['customer_id'] != customer_id:
        raise HTTPException(400, 'La consignacion pertenece a otro cliente')
    quantities = normalize_items(items)
    pending = {item['product_id']: item['pending'] for item in consignment['items']}
    for product_id, quantity in quantities.items():
        if quantity > pending.get(product_id, 0):
            raise HTTPException(400, f'La venta supera la consignacion pendiente del producto {product_id}')
    return quantities


def record_sale(conn, consignment_id, invoice_id, quantities):
    for product_id, quantity in quantities.items():
        conn.execute('UPDATE consignment_items SET sold = sold + ? WHERE consignment_id = ? AND product_id = ?',
                     (quantity, consignment_id, product_id))
        movement(conn, consignment_id, product_id, 'SALE', quantity, str(uuid.uuid4()), invoice_id)


def reverse_sale(conn, invoice_id):
    sales = conn.execute("""SELECT * FROM consignment_movements WHERE invoice_id = ? AND kind = 'SALE'
        AND NOT EXISTS (SELECT 1 FROM consignment_movements r
                        WHERE r.request_key = consignment_movements.id AND r.kind = 'SALE_CANCEL')""", (invoice_id,)).fetchall()
    for sale in sales:
        conn.execute('UPDATE consignment_items SET sold = sold - ? WHERE consignment_id = ? AND product_id = ?',
                     (sale['quantity'], sale['consignment_id'], sale['product_id']))
        movement(conn, sale['consignment_id'], sale['product_id'], 'SALE_CANCEL', sale['quantity'], sale['id'], invoice_id)
