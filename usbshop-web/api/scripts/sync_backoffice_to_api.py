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
DELETE_ORDER = ["invoice_items", "account_movements", "invoices", "customers", "annual_balances"]
IMPORT_ORDER = ["customers", "invoices", "invoice_items", "account_movements", "annual_balances"]
TABLE_COLUMNS: dict[str, list[str]] = {
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
    "account_movements": [
        "id",
        "customer_id",
        "invoice_id",
        "amount",
        "movement_type",
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
    "customers": min(DEFAULT_CHUNK_SIZE, 250),
    "invoices": min(DEFAULT_CHUNK_SIZE, 250),
    "invoice_items": min(DEFAULT_CHUNK_SIZE, 150),
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


def _fetch_rows(conn: sqlite3.Connection, table_name: str, columns: list[str]) -> list[dict]:
    conn.row_factory = sqlite3.Row
    rows = conn.execute(f"SELECT {', '.join(columns)} FROM {table_name} ORDER BY id ASC").fetchall()
    return [{column: row[column] for column in columns} for row in rows]


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
