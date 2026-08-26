from __future__ import annotations

import argparse
import json
import mimetypes
import os
import shutil
import sqlite3
import ssl
import unicodedata
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Optional
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request as UrlRequest, urlopen

DEFAULT_DB_PATH = Path(__file__).resolve().parents[1] / "data" / "controlStock.db"
DEFAULT_SOURCE_CATALOG = Path(r"C:\Users\Fede\ControlStock\documentos\Catálogo")
API_DIR = Path(__file__).resolve().parents[1]
CATALOG_ASSETS_DIR = API_DIR / "catalog_assets"
SUPPORTED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".jfif", ".avif"}


@dataclass
class ImageRef:
    table: str
    row_id: int
    product_id: int
    product_name: str
    column: str
    raw_value: str
    sort_order: int


def slugify(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", value or "")
    ascii_value = normalized.encode("ascii", "ignore").decode("ascii")
    cleaned = "".join(ch if ch.isalnum() else "-" for ch in ascii_value.lower())
    collapsed = "-".join(part for part in cleaned.split("-") if part)
    return collapsed or "producto"


def stable_target_name(product_id: int, product_name: str, sort_order: int, suffix: str) -> str:
    ext = suffix.lower()
    if ext not in SUPPORTED_EXTENSIONS:
        ext = ".jpg"
    base = slugify(product_name)
    slot = sort_order + 1
    return f"productos/{base}-id{product_id}-img{slot}{ext}"


def product_images_column(conn: sqlite3.Connection) -> Optional[str]:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='product_images' LIMIT 1"
    ).fetchone()
    if row is None:
        return None
    columns = {str(item[1]) for item in conn.execute("PRAGMA table_info(product_images)").fetchall()}
    if "image_path" in columns:
        return "image_path"
    if "image_url" in columns:
        return "image_url"
    return None


def collect_image_refs(conn: sqlite3.Connection) -> list[ImageRef]:
    conn.row_factory = sqlite3.Row
    refs: list[ImageRef] = []
    products = conn.execute(
        """
        SELECT id, name, image_path
        FROM products
        WHERE deleted_at IS NULL
          AND image_path IS NOT NULL
          AND TRIM(image_path) <> ''
        ORDER BY id ASC
        """
    ).fetchall()
    for row in products:
        raw_value = str(row["image_path"]).strip()
        if raw_value.startswith(("http://", "https://")):
            continue
        refs.append(
            ImageRef(
                table="products",
                row_id=int(row["id"]),
                product_id=int(row["id"]),
                product_name=str(row["name"] or "").strip(),
                column="image_path",
                raw_value=raw_value,
                sort_order=0,
            )
        )
    image_column = product_images_column(conn)
    if not image_column:
        return refs
    secondary = conn.execute(
        f"""
        SELECT pi.id, pi.product_id, pi.sort_order, pi.{image_column} AS image_value, p.name AS product_name
        FROM product_images pi
        JOIN products p ON p.id = pi.product_id
        WHERE p.deleted_at IS NULL
          AND pi.{image_column} IS NOT NULL
          AND TRIM(pi.{image_column}) <> ''
        ORDER BY pi.product_id ASC, pi.sort_order ASC, pi.id ASC
        """
    ).fetchall()
    for row in secondary:
        raw_value = str(row["image_value"]).strip()
        if raw_value.startswith(("http://", "https://")):
            continue
        refs.append(
            ImageRef(
                table="product_images",
                row_id=int(row["id"]),
                product_id=int(row["product_id"]),
                product_name=str(row["product_name"] or "").strip(),
                column=image_column,
                raw_value=raw_value,
                sort_order=int(row["sort_order"] or 0) + 1,
            )
        )
    return refs


def resolve_local_source(raw_value: str, source_catalog: Path) -> Optional[Path]:
    raw_path = Path(str(raw_value).strip()).expanduser()
    candidates: list[Path] = [raw_path]
    if not raw_path.is_absolute():
        candidates.append(API_DIR / raw_path)
    basename = raw_path.name.strip()
    if basename:
        candidates.append(CATALOG_ASSETS_DIR / basename)
        candidates.append(source_catalog / basename)
    seen: set[str] = set()
    for candidate in candidates:
        key = str(candidate).lower()
        if key in seen:
            continue
        seen.add(key)
        try:
            if candidate.exists() and candidate.is_file():
                return candidate
        except OSError:
            continue
    return None


def copy_to_catalog_assets(source_path: Path, target_name: str) -> str:
    target_path = CATALOG_ASSETS_DIR / target_name
    target_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source_path, target_path)
    return target_path.relative_to(API_DIR).as_posix()


def supabase_settings() -> tuple[str, str, str]:
    base_url = (os.getenv("SUPABASE_URL") or "").strip().rstrip("/")
    api_key = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    bucket = (os.getenv("SUPABASE_BUCKET") or "usbshop-catalogo").strip().strip("/")
    missing: list[str] = []
    if not base_url:
        missing.append("SUPABASE_URL")
    if not api_key:
        missing.append("SUPABASE_SERVICE_ROLE_KEY")
    if not bucket:
        missing.append("SUPABASE_BUCKET")
    if missing:
        raise SystemExit("Faltan variables para Supabase: " + ", ".join(missing))
    return base_url, api_key, bucket


def apply_supabase_auth_headers(request: UrlRequest, api_key: str) -> None:
    request.add_header("apikey", api_key)
    request.add_header("Authorization", f"Bearer {api_key}")


def public_storage_url(base_url: str, bucket: str, target_name: str) -> str:
    return f"{base_url}/storage/v1/object/public/{bucket}/{quote(target_name, safe='/')}"


def upload_to_supabase(source_path: Path, target_name: str) -> str:
    base_url, api_key, bucket = supabase_settings()
    upload_url = f"{base_url}/storage/v1/object/{bucket}/{quote(target_name, safe='/')}"
    content = source_path.read_bytes()
    content_type = mimetypes.guess_type(source_path.name)[0] or "application/octet-stream"
    upload_request = UrlRequest(upload_url, data=content, method="PUT")
    apply_supabase_auth_headers(upload_request, api_key)
    upload_request.add_header("Content-Type", content_type)
    upload_request.add_header("x-upsert", "true")
    try:
        with urlopen(upload_request, timeout=120, context=ssl._create_unverified_context()):
            pass
    except HTTPError as exc:
        detail = ""
        try:
            detail = (exc.read() or b"").decode("utf-8", errors="replace")
        except Exception:
            detail = ""
        raise SystemExit(f"Fallo subiendo {source_path.name}: {detail[:300] or exc.reason}") from exc
    return public_storage_url(base_url, bucket, target_name)


def backup_db(db_path: Path) -> Path:
    stamp = datetime.now().strftime("%Y%m%d%H%M%S")
    backup_path = db_path.with_name(f"{db_path.stem}.before-image-migration-{stamp}{db_path.suffix}")
    shutil.copy2(db_path, backup_path)
    return backup_path


def summarize(results: list[dict]) -> dict:
    summary = {
        "total_local_refs": len(results),
        "resolved": sum(1 for item in results if item["status"] == "resolved"),
        "missing_source": sum(1 for item in results if item["status"] == "missing_source"),
        "updated": sum(1 for item in results if item["status"] == "updated"),
        "unchanged": sum(1 for item in results if item["status"] == "unchanged"),
    }
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Migra referencias locales de imagenes de productos a catalog_assets o Supabase."
    )
    parser.add_argument("--db", type=Path, default=DEFAULT_DB_PATH, help="Ruta a la base SQLite a actualizar.")
    parser.add_argument(
        "--source-catalog",
        type=Path,
        default=DEFAULT_SOURCE_CATALOG,
        help="Carpeta historica con imagenes fuente.",
    )
    parser.add_argument(
        "--strategy",
        choices=("audit", "copy-local", "supabase"),
        default="audit",
        help="audit solo informa; copy-local copia a catalog_assets; supabase sube al bucket configurado.",
    )
    parser.add_argument("--apply", action="store_true", help="Aplica cambios en la base. Sin esto solo audita.")
    parser.add_argument("--limit", type=int, default=0, help="Limita la cantidad de referencias procesadas.")
    parser.add_argument("--report", type=Path, help="Guarda un reporte JSON con el detalle.")
    args = parser.parse_args()

    db_path = args.db.resolve()
    source_catalog = args.source_catalog.resolve()
    if not db_path.exists():
        raise SystemExit(f"No existe la base: {db_path}")

    conn = sqlite3.connect(str(db_path))
    try:
        refs = collect_image_refs(conn)
        if args.limit > 0:
            refs = refs[: args.limit]
        results: list[dict] = []
        updates: list[tuple[str, str, int]] = []
        for ref in refs:
            source_path = resolve_local_source(ref.raw_value, source_catalog)
            result = {
                "table": ref.table,
                "row_id": ref.row_id,
                "product_id": ref.product_id,
                "product_name": ref.product_name,
                "column": ref.column,
                "old_value": ref.raw_value,
                "sort_order": ref.sort_order,
            }
            if source_path is None:
                result["status"] = "missing_source"
                results.append(result)
                continue
            result["source_path"] = str(source_path)
            target_name = stable_target_name(
                ref.product_id,
                ref.product_name,
                ref.sort_order,
                source_path.suffix or Path(ref.raw_value).suffix or ".jpg",
            )
            result["target_name"] = target_name
            if args.strategy == "audit" or not args.apply:
                result["status"] = "resolved"
                if args.strategy == "copy-local":
                    result["new_value"] = (CATALOG_ASSETS_DIR / target_name).relative_to(API_DIR).as_posix()
                elif args.strategy == "supabase":
                    bucket = (os.getenv("SUPABASE_BUCKET") or "usbshop-catalogo").strip().strip("/")
                    base_url = (os.getenv("SUPABASE_URL") or "").strip().rstrip("/")
                    if base_url and bucket:
                        result["new_value"] = public_storage_url(base_url, bucket, target_name)
                results.append(result)
                continue
            if args.strategy == "copy-local":
                new_value = copy_to_catalog_assets(source_path, target_name)
            elif args.strategy == "supabase":
                new_value = upload_to_supabase(source_path, target_name)
            else:
                result["status"] = "unchanged"
                results.append(result)
                continue
            updates.append((ref.table, ref.column, ref.row_id, new_value))
            result["status"] = "updated"
            result["new_value"] = new_value
            results.append(result)

        backup_path: Optional[Path] = None
        if updates:
            backup_path = backup_db(db_path)
            for table, column, row_id, new_value in updates:
                conn.execute(f"UPDATE {table} SET {column} = ? WHERE id = ?", (new_value, row_id))
            conn.commit()
        else:
            conn.rollback()

        payload = {
            "db_path": str(db_path),
            "source_catalog": str(source_catalog),
            "strategy": args.strategy,
            "apply": bool(args.apply),
            "backup_path": str(backup_path) if backup_path else None,
            "summary": summarize(results),
            "results": results,
        }
        if args.report:
            args.report.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
