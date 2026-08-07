from __future__ import annotations

import json
import os
import sqlite3
import time
import urllib.request
from urllib.error import HTTPError, URLError
from pathlib import Path

API_BASE_URL = (os.getenv("USBSHOP_SYNC_API_BASE_URL") or "https://api.usbshop.com.ar").rstrip("/")
SYNC_TOKEN = (os.getenv("USB_SYNC_TOKEN") or os.getenv("USB_SYNC_SECRET") or "").strip()
SOURCE_DB_CANDIDATES = [
    Path(r"C:\Users\Fede\ControlStock\documentos\controlStock.db"),
    Path(__file__).resolve().parents[1] / "data" / "controlStock.db",
]
DEFAULT_CHUNK_SIZE = int((os.getenv("USBSHOP_SYNC_CHUNK_SIZE") or "250").strip() or "250")
RETRY_ATTEMPTS = int((os.getenv("USBSHOP_SYNC_RETRIES") or "4").strip() or "4")
RETRYABLE_STATUS_CODES = {502, 503, 504}
DELETE_ORDER = [
    "invoice_item_imeis",
    "invoice_items",
    "product_imeis",
    "product_bundle_items",
    "product_images",
    "account_movements",
    "invoices",
    "products",
    "customers",
    "categories",
    "annual_balances",
]
IMPORT_ORDER = [
    "categories",
    "products",
    "product_images",
    "product_bundle_items",
    "customers",
    "invoices",
    "invoice_items",
    "invoice_item_imeis",
    "product_imeis",
    "account_movements",
    "annual_balances",
]
TABLE_COLUMNS: dict[str, list[str]] = {
    "categories": [
        "id",
        "name",
        "created_at",
    ],
    "products": [
        "id",
        "name",
        "sku",
        "barcode",
        "price",
        "stock",
        "created_at",
        "updated_at",
        "cost",
        "margin",
        "image_path",
        "category_id",
        "price_list_1",
        "price_list_2",
        "external_ref",
        "is_active",
        "deleted_at",
        "reorder_point",
        "reorder_qty",
        "is_featured",
        "is_offer",
        "is_recommended",
        "image_paths",
        "description",
        "highlight_new_arrivals",
        "is_bundle",
        "flash_offer_price",
        "flash_offer_ends_at",
    ],
    "product_images": [
        "id",
        "product_id",
        "image_url",
        "sort_order",
        "created_at",
    ],
    "product_bundle_items": [
        "id",
        "bundle_product_id",
        "product_id",
        "quantity",
    ],
    "customers": [
        "id",
        "name",
        "email",
        "phone",
        "created_at",
        "sale_mode",
        "locality",
        "address",
        "tax_condition",
        "cuit",
        "external_ref",
        "is_active",
        "deleted_at",
    ],
    "invoices": [
        "id",
        "customer_id",
        "total",
        "created_at",
        "seller_id",
        "document_type",
        "commission_amount",
        "sale_mode",
        "price_list",
        "external_ref",
        "due_date",
        "notes",
    ],
    "invoice_items": [
        "id",
        "invoice_id",
        "product_id",
        "quantity",
        "unit_price",
    ],
    "invoice_item_imeis": [
        "id",
        "invoice_item_id",
        "invoice_id",
        "product_id",
        "imei",
    ],
    "product_imeis": [
        "id",
        "product_id",
        "imei",
        "sold_invoice_id",
        "sold_at",
        "created_at",
    ],
    "account_movements": [
        "id",
        "customer_id",
        "invoice_id",
        "amount",
        "movement_type",
        "entry_kind",
        "reference",
        "created_at",
        "payment_method",
    ],
    "annual_balances": [
        "year",
        "total_sales",
        "capital_ars",
        "exchange_rate",
        "capital_usd",
        "notes",
        "created_at",
        "updated_at",
        "january_sales",
        "february_sales",
        "march_sales",
        "april_sales",
        "may_sales",
        "june_sales",
        "july_sales",
        "august_sales",
        "september_sales",
        "october_sales",
        "november_sales",
        "december_sales",
        "total_profit",
        "cash_closure",
    ],
}
TABLE_CHUNK_SIZES: dict[str, int] = {
    "categories": min(DEFAULT_CHUNK_SIZE, 250),
    "products": min(DEFAULT_CHUNK_SIZE, 150),
    "product_images": min(DEFAULT_CHUNK_SIZE, 250),
    "product_bundle_items": min(DEFAULT_CHUNK_SIZE, 250),
    "customers": min(DEFAULT_CHUNK_SIZE, 250),
    "invoices": min(DEFAULT_CHUNK_SIZE, 250),
    "invoice_items": min(DEFAULT_CHUNK_SIZE, 150),
    "invoice_item_imeis": min(DEFAULT_CHUNK_SIZE, 250),
    "product_imeis": min(DEFAULT_CHUNK_SIZE, 250),
    "account_movements": min(DEFAULT_CHUNK_SIZE, 250),
    "annual_balances": min(DEFAULT_CHUNK_SIZE, 100),
}


def _source_db() -> Path:
    for candidate in SOURCE_DB_CANDIDATES:
        if candidate.exists():
            return candidate
    joined = ", ".join(str(path) for path in SOURCE_DB_CANDIDATES)
    raise SystemExit(f"No se encontro ninguna base fuente en: {joined}")


def _request_json(path: str, payload: dict) -> dict:
    data = json.dumps(payload).encode("utf-8")
    last_error: Exception | None = None
    for attempt in range(1, RETRY_ATTEMPTS + 1):
        request = urllib.request.Request(
            f"{API_BASE_URL}{path}",
            data=data,
            method="POST",
            headers={
                "Authorization": f"Bearer {SYNC_TOKEN}",
                "Content-Type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                return json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            last_error = exc
            if exc.code not in RETRYABLE_STATUS_CODES or attempt >= RETRY_ATTEMPTS:
                raise
        except URLError as exc:
            last_error = exc
            if attempt >= RETRY_ATTEMPTS:
                raise
        time.sleep(min(8, attempt * 2))
    if last_error is not None:
        raise last_error
    raise RuntimeError("No se pudo completar la solicitud")


def _table_exists(conn: sqlite3.Connection, table_name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1",
        (table_name,),
    ).fetchone()
    return row is not None


def _fetch_rows(conn: sqlite3.Connection, table_name: str, columns: list[str]) -> list[dict]:
    conn.row_factory = sqlite3.Row
    if not _table_exists(conn, table_name):
        return []
    available_columns = {
        str(row[1])
        for row in conn.execute(f"PRAGMA table_info({table_name})").fetchall()
    }
    if not available_columns:
        return []
    selected_columns = [column for column in columns if column in available_columns]
    if not selected_columns:
        return []
    order_by = "id ASC" if "id" in available_columns else "rowid ASC"
    rows = conn.execute(
        f"SELECT {', '.join(selected_columns)} FROM {table_name} ORDER BY {order_by}"
    ).fetchall()
    payload: list[dict] = []
    for row in rows:
        payload.append({column: row[column] if column in selected_columns else None for column in columns})
    return payload


def main() -> None:
    if not SYNC_TOKEN:
        raise SystemExit("Falta USB_SYNC_TOKEN o USB_SYNC_SECRET.")

    db_path = _source_db()
    conn = sqlite3.connect(db_path)
    try:
        for table_name in DELETE_ORDER:
            result = _request_json(
                "/admin/sync/table",
                {"table": table_name, "rows": [], "replace": True, "finalize": True},
            )
            print(f"{table_name}: limpieza -> {result.get('status')}")

        for table_name in IMPORT_ORDER:
            columns = TABLE_COLUMNS[table_name]
            rows = _fetch_rows(conn, table_name, columns)
            if not rows:
                print(f"{table_name}: sin filas")
                continue
            chunk_size = TABLE_CHUNK_SIZES.get(table_name, DEFAULT_CHUNK_SIZE)
            for index in range(0, len(rows), chunk_size):
                chunk = rows[index : index + chunk_size]
                result = _request_json(
                    "/admin/sync/table",
                    {
                        "table": table_name,
                        "rows": chunk,
                        "replace": False,
                        "finalize": index + chunk_size >= len(rows),
                    },
                )
                print(
                    f"{table_name}: lote {index // chunk_size + 1} "
                    f"({len(chunk)} filas) -> {result.get('status')}"
                )
    finally:
        conn.close()


if __name__ == "__main__":
    main()
