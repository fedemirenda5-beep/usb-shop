from __future__ import annotations

import json
import os
import sqlite3
import urllib.request
from pathlib import Path

API_BASE_URL = (os.getenv("USBSHOP_SYNC_API_BASE_URL") or "https://usbshop-api.onrender.com").rstrip("/")
SYNC_TOKEN = (os.getenv("USB_SYNC_TOKEN") or os.getenv("USB_SYNC_SECRET") or "").strip()
SOURCE_DB_CANDIDATES = [
    Path(r"C:\Users\Fede\ControlStock\documentos\controlStock.db"),
    Path(__file__).resolve().parents[1] / "data" / "controlStock.db",
]
CHUNK_SIZE = 500
DELETE_ORDER = ["invoice_items", "account_movements", "invoices", "customers"]
IMPORT_ORDER = ["customers", "invoices", "invoice_items", "account_movements"]
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
}


def _source_db() -> Path:
    for candidate in SOURCE_DB_CANDIDATES:
        if candidate.exists():
            return candidate
    joined = ", ".join(str(path) for path in SOURCE_DB_CANDIDATES)
    raise SystemExit(f"No se encontro ninguna base fuente en: {joined}")


def _request_json(path: str, payload: dict) -> dict:
    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        f"{API_BASE_URL}{path}",
        data=data,
        method="POST",
        headers={
            "Authorization": f"Bearer {SYNC_TOKEN}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.loads(response.read().decode("utf-8"))


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
            for index in range(0, len(rows), CHUNK_SIZE):
                chunk = rows[index : index + CHUNK_SIZE]
                result = _request_json(
                    "/admin/sync/table",
                    {
                        "table": table_name,
                        "rows": chunk,
                        "replace": False,
                        "finalize": index + CHUNK_SIZE >= len(rows),
                    },
                )
                print(
                    f"{table_name}: lote {index // CHUNK_SIZE + 1} "
                    f"({len(chunk)} filas) -> {result.get('status')}"
                )
    finally:
        conn.close()


if __name__ == "__main__":
    main()
