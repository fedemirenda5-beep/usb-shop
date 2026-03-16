from __future__ import annotations

import base64
import hashlib
import hmac
import io
import json
import logging
import mimetypes
import os
import sqlite3
import ssl
import time
import smtplib
import threading
import unicodedata
from email.message import EmailMessage
from datetime import datetime, timedelta
from functools import lru_cache
from pathlib import Path
from typing import Optional, List, Any
from urllib.error import HTTPError
from urllib.parse import urlencode, quote
from urllib.request import Request as UrlRequest, urlopen

from fastapi import Body, Cookie, FastAPI, File, Form, HTTPException, Query, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

try:
    import psycopg2
    from psycopg2.extras import RealDictCursor
except Exception:  # pragma: no cover - optional for sqlite-only installs
    psycopg2 = None
    RealDictCursor = None

try:
    from PIL import Image, ImageOps
except Exception:  # pragma: no cover - optional thumbnail support
    Image = None
    ImageOps = None

BASE_DIR = Path(__file__).resolve().parent
CATALOG_ASSETS_DIR = BASE_DIR / "catalog_assets"
DB_PATH = Path(os.getenv("CONTROLSTOCK_DB", str(BASE_DIR / "data" / "controlStock.db")))
SOURCE_DB_PATH = Path(
    os.getenv("CONTROLSTOCK_SOURCE_DB", r"C:\Users\Fede\ControlStock\documentos\controlStock.db")
)
DB_URL = (os.getenv("CONTROLSTOCK_DATABASE_URL") or os.getenv("DATABASE_URL") or "").strip()
DB_IS_POSTGRES = DB_URL.lower().startswith("postgres")
ENV_PATH = Path(__file__).resolve().parent / ".env"
LOG_DIR = BASE_DIR / "logs"
LOG_PATH = LOG_DIR / "api.log"
SESSION_COOKIE = "usbshop_session"
SESSION_TTL_SECONDS = 8 * 60 * 60
AUTH_SECRET = os.getenv("USB_AUTH_SECRET")
DEFAULT_ORDER_DOC = os.getenv("USB_ORDER_DOCUMENT", "PEDIDO_WEB")
DEFAULT_ORDER_SALE_MODE = os.getenv("USB_ORDER_SALE_MODE", "ONLINE")
DEFAULT_ORDER_EXTERNAL_REF = os.getenv("USB_ORDER_EXTERNAL_REF", "WEB-PENDIENTE")
ORDER_NOTIFY_EMAIL = (os.getenv("USB_ORDER_NOTIFY_EMAIL") or "usbshoparg@gmail.com").strip()
SMTP_HOST = (os.getenv("USB_SMTP_HOST") or "").strip()
SMTP_PORT = int(os.getenv("USB_SMTP_PORT") or "587")
SMTP_USER = (os.getenv("USB_SMTP_USER") or "").strip()
SMTP_PASSWORD = (os.getenv("USB_SMTP_PASSWORD") or "").strip()
SMTP_FROM = (os.getenv("USB_SMTP_FROM") or "").strip()
SMTP_USE_TLS = os.getenv("USB_SMTP_USE_TLS", "1").strip() != "0"
MAIL_PROVIDER = (os.getenv("USB_MAIL_PROVIDER") or "mailgun").strip().lower()
MAIL_FROM = (
    os.getenv("USB_MAIL_FROM")
    or "Usb-Shop <postmaster@sandbox4ff3d4dc5c6547398b94b4dd7a05d6ff.mailgun.org>"
).strip()
MAILGUN_API_BASE_URL = (os.getenv("USB_MAILGUN_API_BASE_URL") or "https://api.mailgun.net").strip()
MAILGUN_DOMAIN = (
    os.getenv("USB_MAILGUN_DOMAIN")
    or os.getenv("MAILGUN_DOMAIN")
    or "sandbox4ff3d4dc5c6547398b94b4dd7a05d6ff.mailgun.org"
).strip()
MAILGUN_API_KEY = (
    os.getenv("USB_MAILGUN_API_KEY")
    or os.getenv("MAILGUN_API_KEY")
    or os.getenv("API_KEY")
    or ""
).strip()

def _adapt_query(query: str) -> str:
    if not DB_IS_POSTGRES:
        return query
    return query.replace("?", "%s")


class DBConn:
    def __init__(self, conn: Any, is_postgres: bool) -> None:
        self._conn = conn
        self.is_postgres = is_postgres

    def execute(self, query: str, params: Optional[list | tuple] = None):
        sql = _adapt_query(query)
        if self.is_postgres:
            if psycopg2 is None or RealDictCursor is None:
                raise RuntimeError("psycopg2 no disponible para Postgres")
            cur = self._conn.cursor(cursor_factory=RealDictCursor)
            cur.execute(sql, params or ())
            return cur
        return self._conn.execute(sql, params or ())

    def commit(self) -> None:
        self._conn.commit()

    def close(self) -> None:
        self._conn.close()


def _effective_db_path() -> Path:
    if DB_IS_POSTGRES:
        return DB_PATH
    # If CONTROLSTOCK_DB is explicitly set, respect it.
    if os.getenv("CONTROLSTOCK_DB"):
        return DB_PATH
    source = SOURCE_DB_PATH.expanduser()
    return source if source.exists() else DB_PATH


def _connect() -> DBConn:
    if DB_IS_POSTGRES:
        if psycopg2 is None:
            raise FileNotFoundError("psycopg2 no instalado para Postgres")
        if "sslmode=" in DB_URL:
            conn = psycopg2.connect(DB_URL)
        else:
            conn = psycopg2.connect(DB_URL, sslmode="require")
        return DBConn(conn, True)
    db_path = _effective_db_path()
    if not db_path.exists():
        if SOURCE_DB_PATH.exists():
            _sync_from_source()
        else:
            raise FileNotFoundError(f"DB no encontrada en {db_path}")
        db_path = _effective_db_path()
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return DBConn(conn, False)


def _write_db_path() -> Path:
    if DB_IS_POSTGRES:
        return DB_PATH
    source = SOURCE_DB_PATH.expanduser()
    return source if source.exists() else DB_PATH


def _source_available() -> bool:
    if DB_IS_POSTGRES:
        return True
    return SOURCE_DB_PATH.expanduser().exists()


def _require_local(request: Request) -> None:
    host = (request.client.host or "").strip()
    if host not in {"127.0.0.1", "localhost", "::1"}:
        raise HTTPException(status_code=403, detail="Sync solo permitido en localhost")


def _load_env_file() -> None:
    if not ENV_PATH.exists():
        return
    for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
        raw = line.strip()
        if not raw or raw.startswith("#") or "=" not in raw:
            continue
        key, value = raw.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def _setup_logging() -> logging.Logger:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger("usbshop-api")
    if logger.handlers:
        return logger
    logger.setLevel(logging.INFO)
    handler = logging.FileHandler(LOG_PATH, encoding="utf-8")
    formatter = logging.Formatter("%(asctime)s %(levelname)s %(message)s")
    handler.setFormatter(formatter)
    logger.addHandler(handler)
    return logger


def _can_send_order_email() -> bool:
    settings = _mail_settings()
    provider = settings["provider"]
    if provider == "mailgun":
        return bool(
            settings["order_notify_email"]
            and settings["mail_from"]
            and settings["mailgun_domain"]
            and settings["mailgun_api_key"]
        )
    if provider == "smtp":
        return bool(
            settings["order_notify_email"]
            and settings["smtp_host"]
            and settings["smtp_user"]
            and settings["smtp_password"]
        )
    return False


def _mail_settings() -> dict[str, Any]:
    order_notify_email = (os.getenv("USB_ORDER_NOTIFY_EMAIL") or ORDER_NOTIFY_EMAIL or "").strip()

    smtp_host = (os.getenv("USB_SMTP_HOST") or SMTP_HOST or "").strip()
    smtp_port = int((os.getenv("USB_SMTP_PORT") or str(SMTP_PORT or 587)).strip() or "587")
    smtp_user = (os.getenv("USB_SMTP_USER") or SMTP_USER or "").strip()
    smtp_password = (os.getenv("USB_SMTP_PASSWORD") or SMTP_PASSWORD or "").strip()
    smtp_from = (os.getenv("USB_SMTP_FROM") or SMTP_FROM or "").strip()
    smtp_use_tls = (os.getenv("USB_SMTP_USE_TLS") or ("1" if SMTP_USE_TLS else "0")).strip() != "0"

    mail_from = (os.getenv("USB_MAIL_FROM") or MAIL_FROM or smtp_from or smtp_user).strip()
    mailgun_api_base_url = (
        os.getenv("USB_MAILGUN_API_BASE_URL")
        or MAILGUN_API_BASE_URL
        or "https://api.mailgun.net"
    ).strip().rstrip("/")
    mailgun_domain = (
        os.getenv("USB_MAILGUN_DOMAIN")
        or os.getenv("MAILGUN_DOMAIN")
        or MAILGUN_DOMAIN
        or ""
    ).strip()
    mailgun_api_key = (
        os.getenv("USB_MAILGUN_API_KEY")
        or os.getenv("MAILGUN_API_KEY")
        or os.getenv("API_KEY")
        or MAILGUN_API_KEY
        or ""
    ).strip()

    provider = (
        (os.getenv("USB_MAIL_PROVIDER") or MAIL_PROVIDER or "").strip().lower()
        or ("mailgun" if (mailgun_domain and mailgun_api_key) else "smtp")
    )
    if provider not in {"smtp", "mailgun"}:
        provider = "smtp"

    return {
        "provider": provider,
        "order_notify_email": order_notify_email,
        "mail_from": mail_from,
        "smtp_host": smtp_host,
        "smtp_port": smtp_port,
        "smtp_user": smtp_user,
        "smtp_password": smtp_password,
        "smtp_from": smtp_from,
        "smtp_use_tls": smtp_use_tls,
        "mailgun_api_base_url": mailgun_api_base_url,
        "mailgun_domain": mailgun_domain,
        "mailgun_api_key": mailgun_api_key,
    }


def _send_order_email(order_id: int, total: float, customer: dict, items: list[dict]) -> None:
    if not _can_send_order_email():
        return
    settings = _mail_settings()
    subject = f"Nuevo pedido web #{order_id}"
    lines = [
        f"Pedido: #{order_id}",
        f"Total: ${total:,.2f}",
        "",
        "Cliente:",
        f"Nombre: {customer.get('name') or '-'}",
        f"Telefono: {customer.get('phone') or '-'}",
        f"Email: {customer.get('email') or '-'}",
        f"Notas: {customer.get('notes') or '-'}",
        "",
        "Productos:",
    ]
    for item in items:
        lines.append(
            f"- {item.get('name') or 'Producto'} x{item.get('qty')} (${item.get('unit_price'):,.2f})"
        )
    body = "\n".join(lines)

    try:
        if settings["provider"] == "mailgun":
            endpoint = f"{settings['mailgun_api_base_url']}/v3/{settings['mailgun_domain']}/messages"
            form_payload = {
                "from": settings["mail_from"],
                "to": settings["order_notify_email"],
                "subject": subject,
                "text": body,
            }
            encoded_form = urlencode(form_payload).encode("utf-8")
            basic_token = base64.b64encode(
                f"api:{settings['mailgun_api_key']}".encode("utf-8")
            ).decode("ascii")
            request = Request(endpoint, data=encoded_form, method="POST")
            request.add_header("Authorization", f"Basic {basic_token}")
            request.add_header("Content-Type", "application/x-www-form-urlencoded")
            request.add_header("Accept", "application/json")
            with urlopen(request, timeout=20) as response:
                response.read()
            LOGGER.info(
                "Email de pedido enviado a %s (pedido %s) via Mailgun.",
                settings["order_notify_email"],
                order_id,
            )
            return

        msg = EmailMessage()
        msg["Subject"] = subject
        msg["From"] = settings["smtp_from"] or settings["smtp_user"]
        msg["To"] = settings["order_notify_email"]
        msg.set_content(body)
        with smtplib.SMTP(settings["smtp_host"], settings["smtp_port"], timeout=20) as smtp:
            if settings["smtp_use_tls"]:
                smtp.starttls()
            smtp.login(settings["smtp_user"], settings["smtp_password"])
            smtp.send_message(msg)
        LOGGER.info(
            "Email de pedido enviado a %s (pedido %s) via SMTP.",
            settings["order_notify_email"],
            order_id,
        )
    except HTTPError as exc:
        detail = ""
        try:
            detail = (exc.read() or b"").decode("utf-8", errors="replace")
        except Exception:
            detail = ""
        LOGGER.error(
            "Mailgun respondio %s en pedido %s. %s",
            exc.code,
            order_id,
            detail[:400],
        )
    except Exception:
        LOGGER.exception("No se pudo enviar email de pedido (pedido %s).", order_id)


def _send_order_email_async(order_id: int, total: float, customer: dict, items: list[dict]) -> None:
    threading.Thread(
        target=_send_order_email,
        args=(order_id, total, customer, items),
        daemon=True,
    ).start()


def _allowed_origins() -> list[str]:
    raw = os.getenv("USB_ALLOWED_ORIGINS", "").strip()
    if not raw:
        return [
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            "https://usbshop.com.ar",
            "https://www.usbshop.com.ar",
        ]
    origins = {origin.strip() for origin in raw.split(",") if origin.strip()}
    if "https://www.usbshop.com.ar" in origins:
        origins.add("https://usbshop.com.ar")
    if "https://usbshop.com.ar" in origins:
        origins.add("https://www.usbshop.com.ar")
    return sorted(origins)


def _allowed_origin_regex() -> str:
    raw = os.getenv("USB_ALLOWED_ORIGIN_REGEX", "").strip()
    if raw:
        return raw
    return r"^https://([a-z0-9-]+\.)*usbshop\.com\.ar$"


_load_env_file()
DB_URL = (os.getenv("CONTROLSTOCK_DATABASE_URL") or os.getenv("DATABASE_URL") or "").strip()
DB_IS_POSTGRES = DB_URL.lower().startswith("postgres")
LOGGER = _setup_logging()

app = FastAPI(title="USB Shop API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins(),
    allow_origin_regex=_allowed_origin_regex(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(HTTPException)
def http_exception_handler(request: Request, exc: HTTPException) -> JSONResponse:
    LOGGER.warning("HTTP %s %s -> %s", request.method, request.url.path, exc.detail)
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})


@app.exception_handler(Exception)
def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    LOGGER.exception("Unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(status_code=500, content={"detail": "Error interno del servidor"})

def _auth_secret() -> str:
    global AUTH_SECRET
    if AUTH_SECRET:
        return AUTH_SECRET
    _load_env_file()
    AUTH_SECRET = os.getenv("USB_AUTH_SECRET")
    if not AUTH_SECRET:
        raise HTTPException(status_code=500, detail="Falta USB_AUTH_SECRET")
    return AUTH_SECRET


def _hash_password(password: str) -> str:
    secret = _auth_secret().encode("utf-8")
    data = f"{password}".encode("utf-8")
    return hashlib.sha256(secret + b":" + data).hexdigest()


def _sign_session(payload: dict) -> str:
    secret = _auth_secret().encode("utf-8")
    raw = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    encoded = base64.urlsafe_b64encode(raw).decode("utf-8").rstrip("=")
    signature = hmac.new(secret, encoded.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{encoded}.{signature}"


def _verify_session(token: str) -> Optional[dict]:
    if not token or "." not in token:
        return None
    encoded, signature = token.rsplit(".", 1)
    secret = _auth_secret().encode("utf-8")
    expected = hmac.new(secret, encoded.encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        return None
    padding = "=" * (-len(encoded) % 4)
    try:
        raw = base64.urlsafe_b64decode(encoded + padding)
        payload = json.loads(raw.decode("utf-8"))
    except Exception:
        return None
    exp = payload.get("exp")
    if not isinstance(exp, (int, float)) or exp < time.time():
        return None
    return payload


def _require_admin(session_token: Optional[str]) -> None:
    payload = _verify_session(session_token or "")
    if not payload or payload.get("role") != "admin":
        raise HTTPException(status_code=401, detail="No autorizado")


def _ensure_users_table(conn: DBConn) -> None:
    if DB_IS_POSTGRES:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL,
                active INTEGER NOT NULL DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.commit()
        return
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL,
            active INTEGER NOT NULL DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    conn.commit()


def _ensure_bootstrap_admin(conn: DBConn) -> None:
    username = (os.getenv("USB_ADMIN_USERNAME") or "").strip()
    password = os.getenv("USB_ADMIN_PASSWORD") or ""
    if not username or not password:
        return
    password_hash = _hash_password(password)
    row = conn.execute(
        "SELECT id FROM users WHERE username = ?",
        (username,),
    ).fetchone()
    if row is None:
        conn.execute(
            """
            INSERT INTO users (username, password_hash, role, active)
            VALUES (?, ?, ?, 1)
            """,
            (username, password_hash, "admin"),
        )
    else:
        conn.execute(
            """
            UPDATE users
            SET password_hash = ?, role = ?, active = 1
            WHERE username = ?
            """,
            (password_hash, "admin", username),
        )
    conn.commit()


def _pick_price(row: Any) -> float:
    price_list_1 = row["price_list_1"] or 0
    price = row["price"] or 0
    return float(price_list_1) if price_list_1 > 0 else float(price)


def _pick_price_by_list(row: Any, price_list: int) -> float:
    base_price = float(row["price"] or 0)
    if price_list == 1:
        price_list_1 = float(row["price_list_1"] or 0)
        return price_list_1 if price_list_1 > 0 else base_price
    if price_list == 2:
        price_list_2 = float(row["price_list_2"] or 0)
        return price_list_2 if price_list_2 > 0 else base_price
    return base_price


def _public_image_url(image_path: Optional[str], product_id: Optional[int] = None) -> Optional[str]:
    if not image_path:
        return None
    raw = str(image_path).strip()
    if raw.startswith("http://") or raw.startswith("https://"):
        return raw
    if product_id is None:
        return None
    return f"/products/{product_id}/image"


def _as_existing_local_image_path(image_value: Optional[str]) -> Optional[Path]:
    if not image_value:
        return None
    raw = str(image_value).strip()
    if not raw:
        return None
    candidates: list[Path] = []
    try:
        expanded = Path(raw).expanduser()
        candidates.append(expanded)
        basename = expanded.name.strip()
        if not expanded.is_absolute():
            candidates.append(BASE_DIR / expanded)
        if basename:
            candidates.append(CATALOG_ASSETS_DIR / basename)
    except Exception:
        return None
    for path in candidates:
        try:
            if path.exists() and path.is_file():
                return path
        except OSError:
            continue
    return None


def _first_product_image_candidate(conn: DBConn, product_id: int) -> Optional[str]:
    column = _product_images_column(conn)
    if not column:
        return None
    row = conn.execute(
        f"""
        SELECT {column}
        FROM product_images
        WHERE product_id = ?
        ORDER BY sort_order ASC, id ASC
        LIMIT 1
        """,
        (int(product_id),),
    ).fetchone()
    if row is None:
        return None
    value = row[column] if isinstance(row, dict) else row[0]
    return str(value).strip() if value else None


def _product_image_candidates(conn: DBConn, product_id: int, primary_image: Optional[str]) -> list[str]:
    candidates: list[str] = []
    seen: set[str] = set()

    def add_candidate(value: Optional[str]) -> None:
        if not value:
            return
        normalized = str(value).strip()
        if not normalized or normalized in seen:
            return
        seen.add(normalized)
        candidates.append(normalized)

    add_candidate(primary_image)
    column = _product_images_column(conn)
    if not column:
        return candidates
    rows = conn.execute(
        f"""
        SELECT {column}
        FROM product_images
        WHERE product_id = ?
        ORDER BY sort_order ASC, id ASC
        """,
        (int(product_id),),
    ).fetchall()
    for row in rows:
        value = row[column] if isinstance(row, dict) else row[0]
        add_candidate(value)
    return candidates


def _normalize_thumbnail_params(
    width: Optional[int],
    height: Optional[int],
    quality: Optional[int],
    fmt: Optional[str],
) -> tuple[Optional[int], Optional[int], int, str]:
    normalized_width = max(80, min(int(width), 1600)) if width else None
    normalized_height = max(80, min(int(height), 1600)) if height else None
    normalized_quality = max(45, min(int(quality or 72), 90))
    normalized_format = (fmt or "webp").strip().lower()
    if normalized_format not in {"webp", "jpeg", "png"}:
        normalized_format = "webp"
    return normalized_width, normalized_height, normalized_quality, normalized_format


@lru_cache(maxsize=512)
def _render_thumbnail_bytes(
    path_str: str,
    modified_ns: int,
    width: Optional[int],
    height: Optional[int],
    quality: int,
    fmt: str,
) -> tuple[bytes, str]:
    if Image is None or ImageOps is None:
        raise RuntimeError("Pillow no disponible")
    path = Path(path_str)
    with Image.open(path) as source_image:
        image = ImageOps.exif_transpose(source_image)
        working = image.copy()
    if width or height:
        max_width = width or working.width
        max_height = height or working.height
        working.thumbnail((max_width, max_height), Image.Resampling.LANCZOS)
    output = io.BytesIO()
    if fmt == "jpeg":
        if working.mode not in {"RGB", "L"}:
            working = working.convert("RGB")
        working.save(output, format="JPEG", quality=quality, optimize=True, progressive=True)
        return output.getvalue(), "image/jpeg"
    if fmt == "png":
        if working.mode not in {"RGB", "RGBA", "L"}:
            working = working.convert("RGBA")
        working.save(output, format="PNG", optimize=True)
        return output.getvalue(), "image/png"
    if working.mode not in {"RGB", "RGBA", "L"}:
        working = working.convert("RGBA")
    working.save(output, format="WEBP", quality=quality, method=6)
    return output.getvalue(), "image/webp"


def _has_column(conn: DBConn, table: str, column: str) -> bool:
    if DB_IS_POSTGRES:
        row = conn.execute(
            "SELECT 1 FROM information_schema.columns WHERE table_name = ? AND column_name = ?",
            (table, column),
        ).fetchone()
        return row is not None
    info = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return any(row[1] == column for row in info)


def _has_table(conn: DBConn, table: str) -> bool:
    if DB_IS_POSTGRES:
        row = conn.execute(
            "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ?",
            (table,),
        ).fetchone()
        return row is not None
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
        (table,),
    ).fetchone()
    return row is not None


def _ensure_products_cost_column(conn: DBConn) -> None:
    if _has_column(conn, "products", "cost"):
        return
    if DB_IS_POSTGRES:
        conn.execute("ALTER TABLE products ADD COLUMN IF NOT EXISTS cost NUMERIC(12, 2) DEFAULT 0")
    else:
        conn.execute("ALTER TABLE products ADD COLUMN cost REAL DEFAULT 0")
    conn.commit()


def _ensure_invoice_payment_method_column(conn: DBConn) -> None:
    if _has_column(conn, "invoices", "payment_method"):
        return
    conn.execute("ALTER TABLE invoices ADD COLUMN payment_method TEXT")
    conn.commit()


def _require_sync_token(request: Request) -> None:
    token = (os.getenv("USB_SYNC_TOKEN") or os.getenv("USB_SYNC_SECRET") or "").strip()
    if not token:
        raise HTTPException(status_code=500, detail="Falta USB_SYNC_TOKEN/USB_SYNC_SECRET")
    header = (request.headers.get("Authorization") or "").strip()
    supplied = ""
    if header.lower().startswith("bearer "):
        supplied = header[7:].strip()
    if not supplied:
        supplied = (request.headers.get("X-Api-Key") or "").strip()
    if not supplied or not hmac.compare_digest(supplied, token):
        raise HTTPException(status_code=401, detail="No autorizado")


def _ensure_category_id(conn: DBConn, name: str) -> Optional[int]:
    if not name or not _has_table(conn, "categories"):
        return None
    row = conn.execute(
        "SELECT id FROM categories WHERE name = ?",
        (name,),
    ).fetchone()
    if row is not None:
        return int(row["id"] if isinstance(row, dict) else row[0])
    conn.execute("INSERT INTO categories (name) VALUES (?)", (name,))
    row = conn.execute(
        "SELECT id FROM categories WHERE name = ?",
        (name,),
    ).fetchone()
    return int(row["id"] if isinstance(row, dict) else row[0]) if row else None


def _ensure_web_order_tables(conn: DBConn) -> None:
    if DB_IS_POSTGRES:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS web_orders (
                id SERIAL PRIMARY KEY,
                customer_name TEXT,
                customer_phone TEXT,
                customer_email TEXT,
                notes TEXT,
                total REAL NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'PENDING',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                confirmed_at TIMESTAMP,
                confirmed_invoice_id INTEGER,
                external_ref TEXT
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS web_order_items (
                id SERIAL PRIMARY KEY,
                order_id INTEGER NOT NULL REFERENCES web_orders(id) ON DELETE CASCADE,
                product_id INTEGER NOT NULL,
                quantity INTEGER NOT NULL,
                unit_price REAL NOT NULL
            )
            """
        )
        if not _has_column(conn, "web_orders", "confirmed_at"):
            conn.execute("ALTER TABLE web_orders ADD COLUMN confirmed_at TIMESTAMP")
        if not _has_column(conn, "web_orders", "confirmed_invoice_id"):
            conn.execute("ALTER TABLE web_orders ADD COLUMN confirmed_invoice_id INTEGER")
        if not _has_column(conn, "web_orders", "external_ref"):
            conn.execute("ALTER TABLE web_orders ADD COLUMN external_ref TEXT")
        conn.commit()
        return
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS web_orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer_name TEXT,
            customer_phone TEXT,
            customer_email TEXT,
            notes TEXT,
            total REAL NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'PENDING',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            confirmed_at DATETIME,
            confirmed_invoice_id INTEGER,
            external_ref TEXT
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS web_order_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER NOT NULL,
            product_id INTEGER NOT NULL,
            quantity INTEGER NOT NULL,
            unit_price REAL NOT NULL,
            FOREIGN KEY (order_id) REFERENCES web_orders(id) ON DELETE CASCADE,
            FOREIGN KEY (product_id) REFERENCES products(id)
        )
        """
    )
    if not _has_column(conn, "web_orders", "confirmed_at"):
        conn.execute("ALTER TABLE web_orders ADD COLUMN confirmed_at DATETIME")
    if not _has_column(conn, "web_orders", "confirmed_invoice_id"):
        conn.execute("ALTER TABLE web_orders ADD COLUMN confirmed_invoice_id INTEGER")
    if not _has_column(conn, "web_orders", "external_ref"):
        conn.execute("ALTER TABLE web_orders ADD COLUMN external_ref TEXT")
    conn.commit()


def _product_images_column(conn: DBConn) -> Optional[str]:
    if not _has_table(conn, "product_images"):
        return None
    if _has_column(conn, "product_images", "image_path"):
        return "image_path"
    if _has_column(conn, "product_images", "image_url"):
        return "image_url"
    return None


def _ensure_product_images_table(conn: DBConn) -> None:
    if _has_table(conn, "product_images"):
        return
    if DB_IS_POSTGRES:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS product_images (
                id SERIAL PRIMARY KEY,
                product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
                image_url TEXT NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_product_images_product_id ON product_images(product_id)"
        )
        conn.commit()
        return
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS product_images (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id INTEGER NOT NULL,
            image_url TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_product_images_product_id ON product_images(product_id)")
    conn.commit()


def _fetch_product_images(conn: DBConn, product_ids: list[int]) -> dict[int, list[str]]:
    if not product_ids:
        return {}
    column = _product_images_column(conn)
    if not column:
        return {}
    placeholders = ", ".join(["?"] * len(product_ids))
    rows = conn.execute(
        f"""
        SELECT product_id, {column}
        FROM product_images
        WHERE product_id IN ({placeholders})
        ORDER BY sort_order ASC, id ASC
        """,
        product_ids,
    ).fetchall()
    images: dict[int, list[str]] = {}
    for row in rows:
        product_id = int(row["product_id"] if isinstance(row, dict) else row[0])
        path = row[column] if isinstance(row, dict) else row[1]
        if not path:
            continue
        raw = str(path).strip()
        if not raw:
            continue
        if raw.startswith("http://") or raw.startswith("https://"):
            images.setdefault(product_id, []).append(raw)
            continue
        if _as_existing_local_image_path(raw) is not None:
            proxy_url = _public_image_url(raw, product_id)
            if proxy_url:
                images.setdefault(product_id, []).append(proxy_url)
    return images


def _ensure_accounting_tables(conn: DBConn) -> None:
    if DB_IS_POSTGRES:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS account_customers (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                email TEXT,
                phone TEXT,
                tax_id TEXT,
                tax_condition TEXT,
                address TEXT,
                city TEXT,
                notes TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS account_movements (
                id SERIAL PRIMARY KEY,
                customer_id INTEGER NOT NULL REFERENCES account_customers(id) ON DELETE CASCADE,
                movement_type TEXT NOT NULL,
                amount NUMERIC(12, 2) NOT NULL,
                description TEXT,
                document_type TEXT,
                document_number TEXT,
                due_date DATE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS account_documents (
                id SERIAL PRIMARY KEY,
                customer_id INTEGER NOT NULL REFERENCES account_customers(id) ON DELETE CASCADE,
                document_kind TEXT NOT NULL,
                document_number TEXT NOT NULL,
                issue_date DATE NOT NULL,
                total NUMERIC(12, 2) NOT NULL,
                customer_name TEXT NOT NULL,
                customer_tax_id TEXT,
                customer_tax_condition TEXT,
                customer_address TEXT,
                notes TEXT,
                items_json TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_account_movements_customer_id ON account_movements(customer_id)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_account_documents_customer_id ON account_documents(customer_id)"
        )
        conn.commit()
        return

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS account_customers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            email TEXT,
            phone TEXT,
            tax_id TEXT,
            tax_condition TEXT,
            address TEXT,
            city TEXT,
            notes TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS account_movements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer_id INTEGER NOT NULL,
            movement_type TEXT NOT NULL,
            amount REAL NOT NULL,
            description TEXT,
            document_type TEXT,
            document_number TEXT,
            due_date TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (customer_id) REFERENCES account_customers(id) ON DELETE CASCADE
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS account_documents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer_id INTEGER NOT NULL,
            document_kind TEXT NOT NULL,
            document_number TEXT NOT NULL,
            issue_date TEXT NOT NULL,
            total REAL NOT NULL,
            customer_name TEXT NOT NULL,
            customer_tax_id TEXT,
            customer_tax_condition TEXT,
            customer_address TEXT,
            notes TEXT,
            items_json TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (customer_id) REFERENCES account_customers(id) ON DELETE CASCADE
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_account_movements_customer_id ON account_movements(customer_id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_account_documents_customer_id ON account_documents(customer_id)"
    )
    conn.commit()


def _movement_signed_amount(row: Any) -> float:
    movement_type = str(row["movement_type"] if isinstance(row, dict) else row[2]).upper()
    amount = float(row["amount"] if isinstance(row, dict) else row[3])
    return amount if movement_type == "DEBIT" else -amount


def _customer_balance(conn: DBConn, customer_id: int) -> float:
    rows = conn.execute(
        """
        SELECT movement_type, amount
        FROM account_movements
        WHERE customer_id = ?
        """,
        (customer_id,),
    ).fetchall()
    balance = 0.0
    for row in rows:
        movement_type = str(row["movement_type"] if isinstance(row, dict) else row[0]).upper()
        amount = float(row["amount"] if isinstance(row, dict) else row[1] or 0)
        balance += amount if movement_type == "DEBIT" else -amount
    return round(balance, 2)


def _next_document_number(conn: DBConn, document_kind: str) -> str:
    prefix = {
        "RECIBO_X": "RX",
        "PRESUPUESTO": "PR",
        "NOTA_DEBITO": "ND",
        "NOTA_CREDITO": "NC",
    }.get(document_kind, "CP")
    row = conn.execute(
        "SELECT COUNT(*) AS count FROM account_documents WHERE document_kind = ?",
        (document_kind,),
    ).fetchone()
    current = int(row["count"] if isinstance(row, dict) else row[0] or 0)
    return f"{prefix}-{current + 1:08d}"


def _account_customer_identity(row: Any) -> tuple[Optional[str], Optional[str], Optional[str]]:
    if isinstance(row, dict):
        email = str(row.get("customer_email") or "").strip().lower() or None
        phone = str(row.get("customer_phone") or "").strip() or None
        name = str(row.get("customer_name") or "").strip() or None
    else:
        email = str(row[0] or "").strip().lower() or None
        phone = str(row[1] or "").strip() or None
        name = str(row[2] or "").strip() or None
    return email, phone, name


def _safe_parse_datetime(value: Any) -> Optional[datetime]:
    if value in (None, ""):
        return None
    text = str(value).strip()
    if not text:
        return None
    normalized = text.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(normalized)
    except ValueError:
        try:
            return datetime.strptime(text[:19], "%Y-%m-%d %H:%M:%S")
        except ValueError:
            return None


def _customer_current_balance_from_rows(rows: list[Any]) -> float:
    balance = 0.0
    for row in rows:
        movement_type = str(row["movement_type"] if isinstance(row, dict) else row[0]).upper()
        amount = float(row["amount"] if isinstance(row, dict) else row[1] or 0)
        balance += amount if movement_type == "DEBIT" else -amount
    return round(balance, 2)


def _aging_from_movements(rows: list[Any], terms_days: int = 30) -> dict[str, Any]:
    debits: list[dict[str, Any]] = []
    credits: list[dict[str, Any]] = []
    for row in rows:
        movement_type = str(row["movement_type"] if isinstance(row, dict) else row["movement_type"]).upper()
        amount = float(row["amount"] if isinstance(row, dict) else row["amount"] or 0)
        created_at = _safe_parse_datetime(row["created_at"] if isinstance(row, dict) else row["created_at"])
        due_at_raw = row.get("due_date") if isinstance(row, dict) else None
        due_at = _safe_parse_datetime(due_at_raw) if due_at_raw else None
        payload = {
            "id": int(row["id"] if isinstance(row, dict) else row["id"]),
            "amount": amount,
            "remaining": amount,
            "created_at": created_at,
            "due_date": due_at or ((created_at or datetime.utcnow()) + timedelta(days=terms_days)),
            "reference": row["reference"] if isinstance(row, dict) else row.get("reference"),
            "invoice_id": row["invoice_id"] if isinstance(row, dict) else row.get("invoice_id"),
        }
        if movement_type == "DEBIT":
            debits.append(payload)
        else:
            credits.append(payload)

    debits.sort(key=lambda item: (item["due_date"] or datetime.utcnow(), item["id"]))
    for credit in credits:
        remaining_credit = float(credit["amount"] or 0)
        for debit in debits:
            if remaining_credit <= 0:
                break
            available = float(debit["remaining"] or 0)
            if available <= 0:
                continue
            consumed = min(available, remaining_credit)
            debit["remaining"] = round(available - consumed, 2)
            remaining_credit = round(remaining_credit - consumed, 2)

    today = datetime.utcnow().date()
    buckets = {"current": 0.0, "d1_30": 0.0, "d31_60": 0.0, "d61_90": 0.0, "d90_plus": 0.0}
    open_items: list[dict[str, Any]] = []
    for debit in debits:
        remaining = float(debit["remaining"] or 0)
        if remaining <= 0:
            continue
        due_date = debit["due_date"].date() if isinstance(debit["due_date"], datetime) else today
        overdue_days = (today - due_date).days
        if overdue_days <= 0:
            bucket = "current"
        elif overdue_days <= 30:
            bucket = "d1_30"
        elif overdue_days <= 60:
            bucket = "d31_60"
        elif overdue_days <= 90:
            bucket = "d61_90"
        else:
            bucket = "d90_plus"
        buckets[bucket] += remaining
        open_items.append(
            {
                "invoice_id": debit["invoice_id"],
                "reference": debit["reference"],
                "remaining": round(remaining, 2),
                "due_date": due_date.isoformat(),
                "bucket": bucket,
            }
        )
    return {
        **{key: round(value, 2) for key, value in buckets.items()},
        "open_items": open_items,
        "total": round(sum(buckets.values()), 2),
    }


def _normalize_image_entries(payload: dict) -> list[str]:
    entries: list[str] = []
    primary = str(payload.get("image_path") or payload.get("image_url") or "").strip()
    if primary:
        entries.append(primary)
    extra_images = payload.get("image_urls")
    if isinstance(extra_images, list):
        for raw in extra_images:
            value = str(raw or "").strip()
            if value:
                entries.append(value)
    normalized: list[str] = []
    seen: set[str] = set()
    for value in entries:
        if value not in seen:
            seen.add(value)
            normalized.append(value)
    return normalized


def _supabase_storage_settings() -> tuple[str, str, str]:
    base_url = (os.getenv("SUPABASE_URL") or "").strip().rstrip("/")
    api_key = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    bucket = (os.getenv("SUPABASE_BUCKET") or "usbshop-catalogo").strip()
    missing: list[str] = []
    if not base_url:
        missing.append("SUPABASE_URL")
    if not api_key:
        missing.append("SUPABASE_SERVICE_ROLE_KEY")
    if not bucket:
        missing.append("SUPABASE_BUCKET")
    if missing:
        raise HTTPException(
            status_code=503,
            detail=(
                "Faltan variables de Supabase en usbshop-api: "
                + ", ".join(missing)
            ),
        )
    return base_url, api_key, bucket


def _apply_supabase_auth_headers(request: UrlRequest, api_key: str) -> None:
    request.add_header("apikey", api_key)
    if api_key.startswith("sb_secret_") or api_key.startswith("sb_publishable_"):
        return
    request.add_header("Authorization", f"Bearer {api_key}")


def _slugify_filename(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", value)
    ascii_value = normalized.encode("ascii", "ignore").decode("ascii")
    cleaned = "".join(ch if ch.isalnum() else "-" for ch in ascii_value.lower())
    collapsed = "-".join(part for part in cleaned.split("-") if part)
    return collapsed or "producto"


def _build_uploaded_image_name(filename: str, product_name: str = "") -> str:
    source = Path(filename or "imagen.jpg")
    ext = source.suffix.lower()
    if not ext:
        guessed = mimetypes.guess_extension(mimetypes.guess_type(source.name)[0] or "") or ".jpg"
        ext = guessed.lower()
    if ext not in {".jpg", ".jpeg", ".png", ".webp", ".gif", ".jfif"}:
        ext = ".jpg"
    base_name = _slugify_filename(product_name or source.stem or "producto")
    stamp = datetime.utcnow().strftime("%Y%m%d%H%M%S")
    return f"productos/{base_name}-{stamp}{ext}"


def _public_storage_url(base_url: str, bucket: str, target_name: str) -> str:
    return f"{base_url}/storage/v1/object/public/{bucket}/{quote(target_name, safe='/')}"


def _upload_bytes_to_supabase(
    *,
    base_url: str,
    bucket: str,
    target_name: str,
    content: bytes,
    content_type: str,
    api_key: str,
) -> str:
    upload_url = f"{base_url}/storage/v1/object/{bucket}/{quote(target_name, safe='/')}"
    upload_request = UrlRequest(upload_url, data=content, method="PUT")
    _apply_supabase_auth_headers(upload_request, api_key)
    upload_request.add_header("Content-Type", content_type or "application/octet-stream")
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
        raise HTTPException(
            status_code=502,
            detail=f"Fallo subiendo imagen a Supabase: {detail[:300] or exc.reason}",
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"No se pudo subir la imagen: {exc.__class__.__name__}: {str(exc)[:300]}",
        ) from exc
    return _public_storage_url(base_url, bucket, target_name)


def _replace_product_images(conn: DBConn, product_id: int, image_values: list[str]) -> None:
    _ensure_product_images_table(conn)
    column = _product_images_column(conn)
    if not column:
        return
    conn.execute("DELETE FROM product_images WHERE product_id = ?", (product_id,))
    secondary_images = image_values[1:]
    if not secondary_images:
        return
    for index, image_value in enumerate(secondary_images):
        conn.execute(
            f"INSERT INTO product_images (product_id, {column}, sort_order) VALUES (?, ?, ?)",
            (product_id, image_value, index),
        )


def _sync_from_source() -> dict:
    if DB_IS_POSTGRES:
        raise RuntimeError("Sync no disponible en Postgres")
    source = SOURCE_DB_PATH.expanduser()
    dest = DB_PATH.expanduser()
    if source.resolve() == dest.resolve():
        return {"status": "ok", "skipped": True, "reason": "source=dest"}
    if not source.exists():
        raise FileNotFoundError(f"DB de origen no encontrada en {source}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(source) as src, sqlite3.connect(dest) as dst:
        src.backup(dst)
    return {"status": "ok", "source": str(source), "dest": str(dest)}


SYNC_TABLE_SCHEMAS: dict[str, list[tuple[str, str, str]]] = {
    "customers": [
        ("id", "INTEGER PRIMARY KEY", "INTEGER PRIMARY KEY"),
        ("name", "TEXT", "TEXT"),
        ("email", "TEXT", "TEXT"),
        ("phone", "TEXT", "TEXT"),
        ("created_at", "TEXT", "TIMESTAMP"),
        ("sale_mode", "TEXT", "TEXT"),
        ("locality", "TEXT", "TEXT"),
        ("address", "TEXT", "TEXT"),
        ("tax_condition", "TEXT", "TEXT"),
        ("cuit", "TEXT", "TEXT"),
        ("external_ref", "TEXT", "TEXT"),
        ("is_active", "INTEGER", "INTEGER"),
        ("deleted_at", "TEXT", "TIMESTAMP"),
    ],
    "invoices": [
        ("id", "INTEGER PRIMARY KEY", "INTEGER PRIMARY KEY"),
        ("customer_id", "INTEGER", "INTEGER"),
        ("total", "REAL", "NUMERIC(12, 2)"),
        ("created_at", "TEXT", "TIMESTAMP"),
        ("seller_id", "INTEGER", "INTEGER"),
        ("document_type", "TEXT", "TEXT"),
        ("commission_amount", "REAL", "NUMERIC(12, 2)"),
        ("sale_mode", "TEXT", "TEXT"),
        ("price_list", "INTEGER", "INTEGER"),
        ("external_ref", "TEXT", "TEXT"),
        ("due_date", "TEXT", "TIMESTAMP"),
        ("notes", "TEXT", "TEXT"),
        ("payment_method", "TEXT", "TEXT"),
    ],
    "invoice_items": [
        ("id", "INTEGER PRIMARY KEY", "INTEGER PRIMARY KEY"),
        ("invoice_id", "INTEGER", "INTEGER"),
        ("product_id", "INTEGER", "INTEGER"),
        ("quantity", "INTEGER", "INTEGER"),
        ("unit_price", "REAL", "NUMERIC(12, 2)"),
    ],
    "account_movements": [
        ("id", "INTEGER PRIMARY KEY", "INTEGER PRIMARY KEY"),
        ("customer_id", "INTEGER", "INTEGER"),
        ("invoice_id", "INTEGER", "INTEGER"),
        ("amount", "REAL", "NUMERIC(12, 2)"),
        ("movement_type", "TEXT", "TEXT"),
        ("reference", "TEXT", "TEXT"),
        ("created_at", "TEXT", "TIMESTAMP"),
        ("payment_method", "TEXT", "TEXT"),
    ],
}


def _ensure_syncable_tables(conn: DBConn) -> None:
    for table_name, columns in SYNC_TABLE_SCHEMAS.items():
        if not _has_table(conn, table_name):
            definitions = ", ".join(
                f"{name} {pg_type if DB_IS_POSTGRES else sqlite_type}"
                for name, sqlite_type, pg_type in columns
            )
            conn.execute(f"CREATE TABLE IF NOT EXISTS {table_name} ({definitions})")
            continue
        for name, sqlite_type, pg_type in columns:
            if _has_column(conn, table_name, name):
                continue
            conn.execute(
                f"ALTER TABLE {table_name} ADD COLUMN {name} {pg_type if DB_IS_POSTGRES else sqlite_type}"
            )
    conn.commit()


def _upsert_sync_rows(conn: DBConn, table_name: str, rows: list[dict]) -> int:
    columns = [name for name, _, _ in SYNC_TABLE_SCHEMAS[table_name]]
    placeholders = ", ".join(["?"] * len(columns))
    update_columns = [name for name in columns if name != "id"]
    updates = ", ".join(
        f"{name} = {'EXCLUDED' if DB_IS_POSTGRES else 'excluded'}.{name}"
        for name in update_columns
    )
    sql = (
        f"INSERT INTO {table_name} ({', '.join(columns)}) VALUES ({placeholders}) "
        f"ON CONFLICT(id) DO UPDATE SET {updates}"
    )
    processed = 0
    for row in rows:
        if not isinstance(row, dict):
            continue
        conn.execute(sql, [row.get(column) for column in columns])
        processed += 1
    return processed


def _reset_sync_sequence(conn: DBConn, table_name: str) -> None:
    if not DB_IS_POSTGRES:
        return
    row = conn.execute(
        "SELECT pg_get_serial_sequence(?, 'id') AS seq_name",
        (table_name,),
    ).fetchone()
    seq_name = row["seq_name"] if isinstance(row, dict) else row[0]
    if not seq_name:
        return
    conn.execute(
        """
        SELECT setval(
            ?::regclass,
            GREATEST(COALESCE((SELECT MAX(id) FROM """ + table_name + """), 0), 1),
            true
        )
        """,
        (seq_name,),
    )


class CartItemPayload(BaseModel):
    product_id: int = Field(..., ge=1)
    quantity: int = Field(..., ge=1)


class OrderPayload(BaseModel):
    items: List[CartItemPayload]
    customer_name: Optional[str] = None
    customer_phone: Optional[str] = None
    customer_email: Optional[str] = None
    notes: Optional[str] = None


class OrderStatusPayload(BaseModel):
    status: str
    confirmed_invoice_id: Optional[int] = None


@app.get("/health")
def health() -> dict:
    db_label = "postgres" if DB_IS_POSTGRES else str(DB_PATH)
    return {"status": "ok", "db": db_label}


@app.get("/")
def root() -> dict:
    # Simple landing response so the browser doesn't show "Not Found".
    return {"status": "ok", "service": "usbshop-api", "health": "/health"}


@app.post("/sync")
def sync_db(request: Request) -> dict:
    if DB_IS_POSTGRES:
        raise HTTPException(status_code=400, detail="Sync no disponible en Postgres")
    _require_local(request)
    try:
        return _sync_from_source()
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/admin/sync/products")
def sync_products(
    request: Request,
    payload: dict = Body(...),
) -> dict:
    _require_sync_token(request)
    products = payload.get("products") if isinstance(payload, dict) else None
    deleted_skus = payload.get("deleted_skus") if isinstance(payload, dict) else None
    if not isinstance(products, list):
        products = []

    conn = _connect()
    created = updated = skipped = 0
    try:
        has_deleted_at = _has_column(conn, "products", "deleted_at")
        has_is_active = _has_column(conn, "products", "is_active")
        has_price_list_1 = _has_column(conn, "products", "price_list_1")
        has_price_list_2 = _has_column(conn, "products", "price_list_2")
        has_cost = _has_column(conn, "products", "cost")
        has_margin = _has_column(conn, "products", "margin")
        has_image = _has_column(conn, "products", "image_path")
        has_category_id = _has_column(conn, "products", "category_id")
        has_updated_at = _has_column(conn, "products", "updated_at")
        has_is_featured = _has_column(conn, "products", "is_featured")
        has_is_offer = _has_column(conn, "products", "is_offer")
        has_is_recommended = _has_column(conn, "products", "is_recommended")
        has_is_active = _has_column(conn, "products", "is_active")

        for item in products:
            if not isinstance(item, dict):
                skipped += 1
                continue
            sku = str(item.get("sku") or "").strip()
            name = str(item.get("name") or "").strip()
            if not sku or not name:
                skipped += 1
                continue

            where = "sku = ?"
            if has_deleted_at:
                where = f"{where} AND deleted_at IS NULL"
            existing = conn.execute(
                f"SELECT id FROM products WHERE {where}",
                (sku,),
            ).fetchone()

            category_id = item.get("category_id")
            if category_id is None:
                category_name = str(item.get("category_name") or "").strip()
                if category_name:
                    category_id = _ensure_category_id(conn, category_name)

            columns = ["name", "sku", "price", "stock"]
            values: list = [
                name,
                sku,
                float(item.get("price") or 0.0),
                int(item.get("stock") or 0),
            ]
            if has_price_list_1:
                columns.append("price_list_1")
                values.append(float(item.get("price_list_1") or 0.0))
            if has_price_list_2:
                columns.append("price_list_2")
                values.append(float(item.get("price_list_2") or 0.0))
            if has_cost:
                columns.append("cost")
                values.append(float(item.get("cost") or 0.0))
            if has_margin:
                columns.append("margin")
                values.append(float(item.get("margin") or 0.0))
            if has_image:
                columns.append("image_path")
                values.append(item.get("image_path") or None)
            if has_category_id:
                columns.append("category_id")
                values.append(int(category_id) if category_id else None)
            if has_is_featured:
                columns.append("is_featured")
                values.append(1 if item.get("is_featured") else 0)
            if has_is_offer:
                columns.append("is_offer")
                values.append(1 if item.get("is_offer") else 0)
            if has_is_recommended:
                columns.append("is_recommended")
                values.append(1 if item.get("is_recommended") else 0)
            if has_is_active:
                columns.append("is_active")
                values.append(1 if item.get("is_active", True) else 0)
            if has_updated_at:
                columns.append("updated_at")
                values.append(datetime.utcnow().isoformat())

            if DB_IS_POSTGRES:
                if existing is None:
                    placeholders = ", ".join(["?"] * len(columns))
                    sql = f"INSERT INTO products ({', '.join(columns)}) VALUES ({placeholders})"
                    conn.execute(sql, values)
                    created += 1
                else:
                    update_cols = [col for col in columns if col != "sku"]
                    updates = ", ".join([f"{col} = ?" for col in update_cols])
                    update_values = [values[columns.index(col)] for col in update_cols]
                    update_values.append(sku)
                    sql = f"UPDATE products SET {updates} WHERE sku = ?"
                    conn.execute(sql, update_values)
                    updated += 1
            else:
                placeholders = ", ".join(["?"] * len(columns))
                update_cols = [col for col in columns if col != "sku"]
                updates = ", ".join([f"{col}=excluded.{col}" for col in update_cols])
                sql = (
                    f"INSERT INTO products ({', '.join(columns)}) "
                    f"VALUES ({placeholders}) "
                    f"ON CONFLICT(sku) DO UPDATE SET {updates}"
                )
                conn.execute(sql, values)
                if existing is None:
                    created += 1
                else:
                    updated += 1
        if isinstance(deleted_skus, list) and deleted_skus:
            clean_skus = [str(s).strip() for s in deleted_skus if str(s).strip()]
            if clean_skus:
                placeholders = ", ".join(["?"] * len(clean_skus))
                if has_deleted_at:
                    sql = f"UPDATE products SET deleted_at = ? WHERE sku IN ({placeholders})"
                    conn.execute(sql, [datetime.utcnow().isoformat(), *clean_skus])
                elif has_is_active:
                    sql = f"UPDATE products SET is_active = 0 WHERE sku IN ({placeholders})"
                    conn.execute(sql, clean_skus)
        conn.commit()
    finally:
        conn.close()

    return {
        "status": "ok",
        "created": created,
        "updated": updated,
        "skipped": skipped,
        "total": len(products),
    }


@app.post("/admin/sync/table")
def sync_backoffice_table(
    request: Request,
    payload: dict = Body(...),
) -> dict:
    _require_sync_token(request)
    table_name = str(payload.get("table") or "").strip()
    rows = payload.get("rows") if isinstance(payload.get("rows"), list) else []
    replace = bool(payload.get("replace"))
    finalize = bool(payload.get("finalize"))
    if table_name not in SYNC_TABLE_SCHEMAS:
        raise HTTPException(status_code=400, detail="Tabla no soportada")

    conn = _connect()
    try:
        _ensure_syncable_tables(conn)
        if replace:
            conn.execute(f"DELETE FROM {table_name}")
        processed = _upsert_sync_rows(conn, table_name, rows)
        if finalize:
            _reset_sync_sequence(conn, table_name)
        conn.commit()
        return {
            "status": "ok",
            "table": table_name,
            "processed": processed,
            "replace": replace,
            "finalize": finalize,
        }
    finally:
        conn.close()


@app.get("/products")
def list_products(limit: int = 50, q: Optional[str] = None) -> list[dict]:
    conn = _connect()
    try:
        _ensure_product_images_table(conn)
        _ensure_products_cost_column(conn)
        has_deleted_at = _has_column(conn, "products", "deleted_at")
        has_is_active = _has_column(conn, "products", "is_active")
        has_created_at = _has_column(conn, "products", "created_at")
        has_updated_at = _has_column(conn, "products", "updated_at")
        has_price_list_1 = _has_column(conn, "products", "price_list_1")
        has_description = _has_column(conn, "products", "description")
        featured_enabled = _has_column(conn, "products", "is_featured")
        offer_enabled = _has_column(conn, "products", "is_offer")
        recommended_enabled = _has_column(conn, "products", "is_recommended")
        select_fields = [
            "p.id",
            "p.name",
            "p.sku",
            "p.price",
            "p.stock",
            "p.image_path",
            "c.name AS category",
        ]
        select_fields.append("p.created_at" if has_created_at else "NULL AS created_at")
        select_fields.append("p.updated_at" if has_updated_at else "NULL AS updated_at")
        select_fields.append("p.price_list_1" if has_price_list_1 else "NULL AS price_list_1")
        select_fields.append("p.description" if has_description else "NULL AS description")
        select_fields.append("p.cost")
        select_fields.append("p.is_active" if has_is_active else "NULL AS is_active")
        select_fields.append("p.is_featured" if featured_enabled else "NULL AS is_featured")
        select_fields.append("p.is_offer" if offer_enabled else "NULL AS is_offer")
        select_fields.append("p.is_recommended" if recommended_enabled else "NULL AS is_recommended")
        conditions = []
        if has_deleted_at:
            conditions.append("p.deleted_at IS NULL")
        if has_is_active:
            conditions.append("p.is_active = 1")
        base_conditions = []
        if has_deleted_at:
            base_conditions.append("deleted_at IS NULL")
        if has_is_active:
            base_conditions.append("is_active = 1")
        dedupe_source = "products"
        if base_conditions:
            dedupe_source += f" WHERE {' AND '.join(base_conditions)}"
        query = f"""
            SELECT {", ".join(select_fields)}
            FROM products p
            INNER JOIN (
                SELECT MAX(id) AS id
                FROM {dedupe_source}
                GROUP BY LOWER(TRIM(name))
            ) latest ON latest.id = p.id
            LEFT JOIN categories c ON c.id = p.category_id
        """
        if conditions:
            query += f" WHERE {' AND '.join(conditions)}"
        params: list = []
        if q:
            query += " AND (p.name LIKE ? OR p.sku LIKE ?)" if conditions else " WHERE (p.name LIKE ? OR p.sku LIKE ?)"
            like = f"%{q}%"
            params.extend([like, like])
        order_by = "LOWER(p.name) ASC, p.id ASC"
        query += f" ORDER BY {order_by} LIMIT ?"
        params.append(limit)
        rows = conn.execute(query, params).fetchall()
        product_ids = [int(row["id"]) for row in rows]
        images_map = _fetch_product_images(conn, product_ids)
    finally:
        conn.close()

    return [
        {
            "id": row["id"],
            "name": row["name"],
            "sku": row["sku"],
            "price": _pick_price(row),
            "cost": float(row["cost"] or 0),
            "stock": int(row["stock"] or 0),
            "category": row["category"] or "General",
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "description": row["description"],
            "imageUrl": (
                images_map.get(int(row["id"])) or []
            )[0]
            if images_map.get(int(row["id"]))
            else _public_image_url(row["image_path"], int(row["id"])),
            "imageUrls": images_map.get(int(row["id"])) or [],
            "is_featured": bool(row["is_featured"]) if featured_enabled else False,
            "is_offer": bool(row["is_offer"]) if offer_enabled else False,
            "is_recommended": bool(row["is_recommended"]) if recommended_enabled else False,
        }
        for row in rows
    ]


@app.post("/orders")
def create_order(payload: OrderPayload) -> dict:
    if not payload.items:
        raise HTTPException(status_code=400, detail="El pedido no tiene productos")
    if not (payload.customer_name or "").strip():
        raise HTTPException(status_code=400, detail="Falta el nombre del cliente")
    if not (payload.customer_phone or "").strip():
        raise HTTPException(status_code=400, detail="Falta el telefono del cliente")
    if not DB_IS_POSTGRES and not _source_available():
        raise HTTPException(status_code=503, detail="DB principal no disponible")
    if DB_IS_POSTGRES:
        conn = _connect()
        target_db = None
    else:
        target_db = _write_db_path()
        raw = sqlite3.connect(target_db)
        raw.row_factory = sqlite3.Row
        conn = DBConn(raw, False)
    try:
        _ensure_web_order_tables(conn)
        total = 0.0
        items: list[tuple[int, int, float]] = []
        items_details: list[dict] = []
        for item in payload.items:
            row = conn.execute(
                "SELECT id, name, price, price_list_1, price_list_2, stock FROM products WHERE id = ? AND deleted_at IS NULL",
                (int(item.product_id),),
            ).fetchone()
            if row is None:
                raise HTTPException(status_code=404, detail=f"Producto {item.product_id} no encontrado")
            stock = row["stock"] or 0
            if int(stock) < int(item.quantity):
                raise HTTPException(
                    status_code=400,
                    detail=f"Sin stock suficiente para el producto {row['id']}",
                )
            unit_price = _pick_price(row)
            total += unit_price * int(item.quantity)
            items.append((int(row["id"]), int(item.quantity), float(unit_price)))
            items_details.append(
                {
                    "id": int(row["id"]),
                    "name": row.get("name") if isinstance(row, dict) else row["name"],
                    "qty": int(item.quantity),
                    "unit_price": float(unit_price),
                }
            )

        external_ref = DEFAULT_ORDER_EXTERNAL_REF
        customer_name = (payload.customer_name or "").strip() or None
        customer_phone = (payload.customer_phone or "").strip() or None
        customer_email = (payload.customer_email or "").strip() or None
        notes = (payload.notes or "").strip() or None
        if DB_IS_POSTGRES:
            if _has_column(conn, "web_orders", "external_ref"):
                row = conn.execute(
                    """
                    INSERT INTO web_orders (customer_name, customer_phone, customer_email, notes, total, status, external_ref)
                    VALUES (?, ?, ?, ?, ?, 'PENDING', ?)
                    RETURNING id
                    """,
                    (customer_name, customer_phone, customer_email, notes, total, external_ref),
                ).fetchone()
            else:
                row = conn.execute(
                    """
                    INSERT INTO web_orders (customer_name, customer_phone, customer_email, notes, total, status)
                    VALUES (?, ?, ?, ?, ?, 'PENDING')
                    RETURNING id
                    """,
                    (customer_name, customer_phone, customer_email, notes, total),
                ).fetchone()
            order_id = int(row["id"] if isinstance(row, dict) else row[0])
        else:
            if _has_column(conn, "web_orders", "external_ref"):
                conn.execute(
                    """
                    INSERT INTO web_orders (customer_name, customer_phone, customer_email, notes, total, status, external_ref)
                    VALUES (?, ?, ?, ?, ?, 'PENDING', ?)
                    """,
                    (customer_name, customer_phone, customer_email, notes, total, external_ref),
                )
            else:
                conn.execute(
                    """
                    INSERT INTO web_orders (customer_name, customer_phone, customer_email, notes, total, status)
                    VALUES (?, ?, ?, ?, ?, 'PENDING')
                    """,
                    (customer_name, customer_phone, customer_email, notes, total),
                )
            order_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]

        for product_id, quantity, unit_price in items:
            conn.execute(
                """
                INSERT INTO web_order_items (order_id, product_id, quantity, unit_price)
                VALUES (?, ?, ?, ?)
                """,
                (order_id, product_id, quantity, unit_price),
            )
        conn.commit()
    finally:
        conn.close()
    if not DB_IS_POSTGRES and target_db and target_db.resolve() != DB_PATH.resolve() and SOURCE_DB_PATH.exists():
        try:
            _sync_from_source()
        except Exception:
            pass
    _send_order_email_async(
        int(order_id),
        float(total),
        {
            "name": customer_name,
            "phone": customer_phone,
            "email": customer_email,
            "notes": notes,
        },
        items_details,
    )
    return {"id": int(order_id), "total": float(total)}


@app.get("/admin/orders")
def admin_list_orders(
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
    status: str = "PENDING",
    limit: int = 200,
    include_items: bool = True,
) -> list[dict]:
    _require_admin(session_token)
    status_value = (status or "PENDING").strip().upper()
    if status_value not in {"PENDING", "CONFIRMED", "CANCELLED"}:
        status_value = "PENDING"

    conn = _connect()
    try:
        _ensure_web_order_tables(conn)
        rows = conn.execute(
            """
            SELECT id, customer_name, customer_phone, customer_email, notes, total, status,
                   created_at, confirmed_at, confirmed_invoice_id
            FROM web_orders
            WHERE status = ?
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (status_value, int(limit)),
        ).fetchall()
        orders = [
            {
                "id": int(row["id"] if isinstance(row, dict) else row[0]),
                "customer_name": row["customer_name"] if isinstance(row, dict) else row[1],
                "customer_phone": row["customer_phone"] if isinstance(row, dict) else row[2],
                "customer_email": row["customer_email"] if isinstance(row, dict) else row[3],
                "notes": row["notes"] if isinstance(row, dict) else row[4],
                "total": float(row["total"] if isinstance(row, dict) else row[5]),
                "status": (row["status"] if isinstance(row, dict) else row[6]) or "PENDING",
                "created_at": row["created_at"] if isinstance(row, dict) else row[7],
                "confirmed_at": row["confirmed_at"] if isinstance(row, dict) else row[8],
                "confirmed_invoice_id": row["confirmed_invoice_id"] if isinstance(row, dict) else row[9],
                "items": [],
            }
            for row in rows
        ]

        if include_items and orders:
            order_ids = [order["id"] for order in orders]
            placeholders = ", ".join(["?"] * len(order_ids))
            items = conn.execute(
                f"""
                SELECT i.order_id, i.product_id, i.quantity, i.unit_price,
                       p.name AS product_name, p.sku AS sku
                FROM web_order_items i
                LEFT JOIN products p ON p.id = i.product_id
                WHERE i.order_id IN ({placeholders})
                ORDER BY i.id
                """,
                order_ids,
            ).fetchall()
            items_by_order: dict[int, list[dict]] = {order_id: [] for order_id in order_ids}
            for item in items:
                if isinstance(item, dict):
                    order_id = int(item.get("order_id") or 0)
                    items_by_order.setdefault(order_id, []).append(
                        {
                            "product_id": int(item.get("product_id") or 0),
                            "sku": item.get("sku"),
                            "name": item.get("product_name"),
                            "quantity": int(item.get("quantity") or 0),
                            "unit_price": float(item.get("unit_price") or 0.0),
                        }
                    )
                else:
                    order_id = int(item[0])
                    items_by_order.setdefault(order_id, []).append(
                        {
                            "product_id": int(item[1]),
                            "sku": item[5],
                            "name": item[4],
                            "quantity": int(item[2] or 0),
                            "unit_price": float(item[3] or 0.0),
                        }
                    )
            for order in orders:
                order["items"] = items_by_order.get(order["id"], [])
        else:
            for order in orders:
                order.pop("items", None)
        return orders
    finally:
        conn.close()


@app.get("/admin/orders/{order_id}")
def admin_order_detail(
    order_id: int,
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict:
    _require_admin(session_token)
    conn = _connect()
    try:
        _ensure_web_order_tables(conn)
        row = conn.execute(
            """
            SELECT id, customer_name, customer_phone, customer_email, notes, total, status,
                   created_at, confirmed_at, confirmed_invoice_id
            FROM web_orders
            WHERE id = ?
            """,
            (int(order_id),),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Pedido no encontrado")
        items = conn.execute(
            """
            SELECT i.order_id, i.product_id, i.quantity, i.unit_price,
                   p.name AS product_name, p.sku AS sku
            FROM web_order_items i
            LEFT JOIN products p ON p.id = i.product_id
            WHERE i.order_id = ?
            ORDER BY i.id ASC
            """,
            (int(order_id),),
        ).fetchall()
        return {
            "id": int(row["id"]),
            "customer_name": row["customer_name"],
            "customer_phone": row["customer_phone"],
            "customer_email": row["customer_email"],
            "notes": row["notes"],
            "total": float(row["total"] or 0),
            "status": row["status"] or "PENDING",
            "created_at": row["created_at"],
            "confirmed_at": row["confirmed_at"],
            "confirmed_invoice_id": row["confirmed_invoice_id"],
            "items": [
                {
                    "product_id": int(item["product_id"] or 0),
                    "sku": item["sku"],
                    "name": item["product_name"],
                    "quantity": int(item["quantity"] or 0),
                    "unit_price": float(item["unit_price"] or 0),
                }
                for item in items
            ],
        }
    finally:
        conn.close()


@app.post("/admin/orders/{order_id}/status")
def admin_update_order_status(
    order_id: int,
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
    payload: OrderStatusPayload = Body(...),
) -> dict:
    _require_admin(session_token)
    status_value = (payload.status or "").strip().upper()
    if status_value not in {"PENDING", "CONFIRMED", "CANCELLED", "DELETED"}:
        raise HTTPException(status_code=400, detail="Estado invalido")

    conn = _connect()
    try:
        row = conn.execute(
            "SELECT id FROM web_orders WHERE id = ?",
            (int(order_id),),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Pedido no encontrado")

        if status_value == "DELETED":
            conn.execute("DELETE FROM web_orders WHERE id = ?", (int(order_id),))
            conn.commit()
            return {"status": "ok", "id": int(order_id), "action": "deleted"}

        confirmed_invoice_id = payload.confirmed_invoice_id
        if status_value == "CONFIRMED":
            conn.execute(
                """
                UPDATE web_orders
                   SET status = ?, confirmed_at = ?, confirmed_invoice_id = ?
                 WHERE id = ?
                """,
                (status_value, datetime.utcnow().isoformat(), confirmed_invoice_id, int(order_id)),
            )
        else:
            conn.execute(
                """
                UPDATE web_orders
                   SET status = ?
                 WHERE id = ?
                """,
                (status_value, int(order_id)),
            )
        conn.commit()
        return {"status": "ok", "id": int(order_id), "state": status_value}
    finally:
        conn.close()


@app.get("/featured")
def featured_products(limit: int = 6) -> list[dict]:
    conn = _connect()
    try:
        _ensure_product_images_table(conn)
        has_deleted_at = _has_column(conn, "products", "deleted_at")
        has_is_active = _has_column(conn, "products", "is_active")
        has_created_at = _has_column(conn, "products", "created_at")
        has_updated_at = _has_column(conn, "products", "updated_at")
        has_price_list_1 = _has_column(conn, "products", "price_list_1")
        has_description = _has_column(conn, "products", "description")
        featured_enabled = _has_column(conn, "products", "is_featured")
        offer_enabled = _has_column(conn, "products", "is_offer")
        recommended_enabled = _has_column(conn, "products", "is_recommended")
        select_fields = [
            "p.id",
            "p.name",
            "p.sku",
            "p.price",
            "p.stock",
            "p.image_path",
            "c.name AS category",
        ]
        select_fields.append("p.created_at" if has_created_at else "NULL AS created_at")
        select_fields.append("p.updated_at" if has_updated_at else "NULL AS updated_at")
        select_fields.append("p.price_list_1" if has_price_list_1 else "NULL AS price_list_1")
        select_fields.append("p.description" if has_description else "NULL AS description")
        select_fields.append("p.is_active" if has_is_active else "NULL AS is_active")
        select_fields.append("p.is_featured" if featured_enabled else "NULL AS is_featured")
        select_fields.append("p.is_offer" if offer_enabled else "NULL AS is_offer")
        select_fields.append("p.is_recommended" if recommended_enabled else "NULL AS is_recommended")
        conditions = []
        if has_deleted_at:
            conditions.append("p.deleted_at IS NULL")
        if has_is_active:
            conditions.append("p.is_active = 1")
        if featured_enabled:
            conditions.append("p.is_featured = 1")
        else:
            conditions.append("p.stock > 0")
        base_conditions = []
        if has_deleted_at:
            base_conditions.append("deleted_at IS NULL")
        if has_is_active:
            base_conditions.append("is_active = 1")
        if featured_enabled:
            base_conditions.append("is_featured = 1")
        else:
            base_conditions.append("stock > 0")
        dedupe_source = "products"
        if base_conditions:
            dedupe_source += f" WHERE {' AND '.join(base_conditions)}"
        query = f"""
            SELECT {", ".join(select_fields)}
            FROM products p
            INNER JOIN (
                SELECT MAX(id) AS id
                FROM {dedupe_source}
                GROUP BY LOWER(TRIM(name))
            ) latest ON latest.id = p.id
            LEFT JOIN categories c ON c.id = p.category_id
            WHERE {' AND '.join(conditions)}
            ORDER BY {"p.updated_at DESC" if has_updated_at else "p.id DESC"}
            LIMIT ?
        """
        rows = conn.execute(query, (limit,)).fetchall()
        product_ids = [int(row["id"]) for row in rows]
        images_map = _fetch_product_images(conn, product_ids)
    finally:
        conn.close()

    return [
        {
            "id": row["id"],
            "name": row["name"],
            "sku": row["sku"],
            "price": _pick_price(row),
            "stock": int(row["stock"] or 0),
            "category": row["category"] or "General",
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "badge": "Destacado" if featured_enabled else "Stock",
            "description": row["description"],
            "imageUrl": (
                images_map.get(int(row["id"])) or []
            )[0]
            if images_map.get(int(row["id"]))
            else _public_image_url(row["image_path"], int(row["id"])),
            "imageUrls": images_map.get(int(row["id"])) or [],
            "is_featured": True if featured_enabled else False,
            "is_offer": bool(row["is_offer"]) if offer_enabled else False,
            "is_recommended": bool(row["is_recommended"]) if recommended_enabled else False,
        }
        for row in rows
    ]


@app.post("/products/{product_id}/featured")
def set_featured(
    product_id: int,
    request: Request,
    payload: dict = Body(...),
    session: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict:
    _require_local(request)
    _require_admin(session)
    is_featured = bool(payload.get("is_featured"))
    conn = _connect()
    try:
        if not _has_column(conn, "products", "is_featured"):
            raise HTTPException(status_code=400, detail="Columna is_featured no disponible")
        row = conn.execute(
            "SELECT id FROM products WHERE id = ? AND deleted_at IS NULL",
            (product_id,),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Producto no encontrado")
        conn.execute(
            "UPDATE products SET is_featured = ? WHERE id = ?",
            (1 if is_featured else 0, product_id),
        )
        conn.commit()
    finally:
        conn.close()
    return {"id": product_id, "is_featured": is_featured}


@app.post("/auth/login")
def auth_login(request: Request, response: Response, payload: dict = Body(...)) -> dict:
    username = str(payload.get("username") or "").strip()
    password = str(payload.get("password") or "")
    if not username or not password:
        raise HTTPException(status_code=400, detail="Credenciales incompletas")
    conn = _connect()
    try:
        _ensure_users_table(conn)
        _ensure_bootstrap_admin(conn)
        row = conn.execute(
            "SELECT id, username, password_hash, role, active FROM users WHERE username = ?",
            (username,),
        ).fetchone()
    finally:
        conn.close()
    if row is None or not int(row["active"] or 0):
        raise HTTPException(status_code=401, detail="Credenciales invalidas")
    if row["password_hash"] != _hash_password(password):
        raise HTTPException(status_code=401, detail="Credenciales invalidas")
    payload_data = {
        "username": row["username"],
        "role": row["role"],
        "exp": int(time.time() + SESSION_TTL_SECONDS),
    }
    token = _sign_session(payload_data)
    if response is not None:
        response.set_cookie(
            key=SESSION_COOKIE,
            value=token,
            max_age=SESSION_TTL_SECONDS,
            httponly=True,
            secure=True,
            samesite="none",
        )
    return {"username": row["username"], "role": row["role"]}


@app.post("/auth/logout")
def auth_logout(response: Response, request: Request) -> dict:
    if response is not None:
        response.delete_cookie(SESSION_COOKIE)
    return {"status": "ok"}


@app.get("/auth/me")
def auth_me(session: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE)) -> dict:
    payload = _verify_session(session or "")
    if not payload:
        raise HTTPException(status_code=401, detail="No autenticado")
    return {"username": payload.get("username"), "role": payload.get("role")}


@app.get("/products/{product_id}/image")
def product_image(
    product_id: int,
    i: Optional[int] = Query(default=0),
    w: Optional[int] = Query(default=None),
    h: Optional[int] = Query(default=None),
    q: Optional[int] = Query(default=72),
    format: Optional[str] = Query(default="webp"),
):
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT image_path FROM products WHERE id = ? AND deleted_at IS NULL",
            (product_id,),
        ).fetchone()
        primary_image = str(row["image_path"]).strip() if row and row["image_path"] else ""
        image_candidates = _product_image_candidates(conn, product_id, primary_image)
    finally:
        conn.close()

    if row is None:
        raise HTTPException(status_code=404, detail="Imagen no encontrada")

    image_index = max(0, int(i or 0))
    image_value = image_candidates[image_index] if image_index < len(image_candidates) else ""
    if not image_value:
        raise HTTPException(status_code=404, detail="Imagen no encontrada")
    if image_value.startswith("http://") or image_value.startswith("https://"):
        return Response(status_code=307, headers={"Location": image_value})

    image_path = _as_existing_local_image_path(image_value)
    if image_path is None:
        raise HTTPException(status_code=404, detail="Imagen no encontrada")

    width, height, quality, normalized_format = _normalize_thumbnail_params(w, h, q, format)
    should_resize = bool(width or height)
    if should_resize and Image is not None and ImageOps is not None:
        try:
            stat = image_path.stat()
            content, media_type = _render_thumbnail_bytes(
                str(image_path),
                int(stat.st_mtime_ns),
                width,
                height,
                quality,
                normalized_format,
            )
            return Response(
                content=content,
                media_type=media_type,
                headers={"Cache-Control": "public, max-age=86400, s-maxage=86400"},
            )
        except Exception:
            logging.exception("No se pudo generar thumbnail para %s", image_path)

    return FileResponse(image_path)


# ============================================================================
# ADMIN ENDPOINTS - PRODUCTOS
# ============================================================================

@app.get("/admin/products")
def admin_list_products(
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
    q: Optional[str] = None,
    category: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
) -> list[dict]:
    """Lista productos. Requiere sesión admin."""
    _require_admin(session_token)
    
    conn = _connect()
    try:
        _ensure_product_images_table(conn)
        _ensure_products_cost_column(conn)
        has_deleted_at = _has_column(conn, "products", "deleted_at")
        has_is_active = _has_column(conn, "products", "is_active")
        
        conditions = []
        params: list = []
        
        if has_deleted_at:
            conditions.append("deleted_at IS NULL")
        if has_is_active:
            conditions.append("is_active = 1")
        
        if q:
            conditions.append("(name LIKE ? OR sku LIKE ?)")
            like = f"%{q}%"
            params.extend([like, like])
        
        if category:
            conditions.append("category_id = (SELECT id FROM categories WHERE name = ?)")
            params.append(category)
        
        where_clause = f" WHERE {' AND '.join(conditions)}" if conditions else ""
        
        rows = conn.execute(
            f"""
            SELECT id, name, sku, price, price_list_1, price_list_2, cost, stock, 
                   image_path, category_id, is_active, is_featured, is_offer
            FROM products
            {where_clause}
            ORDER BY LOWER(TRIM(name)) ASC, id ASC
            LIMIT ? OFFSET ?
            """,
            params + [limit, offset],
        ).fetchall()
        
        total = conn.execute(
            f"SELECT COUNT(*) as count FROM products {where_clause}",
            params,
        ).fetchone()
        images_map = _fetch_product_images(conn, [int(row["id"]) for row in rows])
        
        return [
            {
                "id": int(row["id"]),
                "name": row["name"],
                "sku": row["sku"],
                "price": float(row["price"] or 0),
                "price_list_1": float(row["price_list_1"] or 0),
                "price_list_2": float(row["price_list_2"] or 0),
                "cost": float(row["cost"] or 0),
                "stock": int(row["stock"] or 0),
                "category_id": int(row["category_id"]) if row["category_id"] else None,
                "is_active": bool(row["is_active"]) if has_is_active else True,
                "is_featured": bool(row["is_featured"]),
                "is_offer": bool(row["is_offer"]),
                "image_path": row["image_path"],
                "imageUrl": (
                    images_map.get(int(row["id"])) or []
                )[0]
                if images_map.get(int(row["id"]))
                else _public_image_url(row["image_path"], int(row["id"])),
                "image_urls": images_map.get(int(row["id"])) or [],
            }
            for row in rows
        ]
    finally:
        conn.close()


@app.post("/admin/products")
def admin_create_product(
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
    payload: dict = Body(...),
) -> dict:
    """Crea nuevo producto. Requiere sesión admin."""
    _require_admin(session_token)
    
    name = str(payload.get("name") or "").strip()
    sku = str(payload.get("sku") or "").strip()
    price = float(payload.get("price") or 0)
    cost = float(payload.get("cost") or 0)
    stock = int(payload.get("stock") or 0)
    is_featured = 1 if bool(payload.get("is_featured")) else 0
    is_offer = 1 if bool(payload.get("is_offer")) else 0
    image_values = _normalize_image_entries(payload)
    primary_image = image_values[0] if image_values else None
    
    if not name:
        raise HTTPException(status_code=400, detail="Nombre requerido")
    if not sku:
        raise HTTPException(status_code=400, detail="SKU requerido")
    
    conn = _connect()
    try:
        _ensure_products_cost_column(conn)
        if conn.execute("SELECT id FROM products WHERE sku = ?", (sku,)).fetchone():
            raise HTTPException(status_code=400, detail="Ya existe un producto con ese SKU")

        columns = ["name", "sku", "price", "stock"]
        values: list[Any] = [name, sku, price, stock]

        if _has_column(conn, "products", "cost"):
            columns.append("cost")
            values.append(cost)
        if _has_column(conn, "products", "image_path"):
            columns.append("image_path")
            values.append(primary_image)
        if _has_column(conn, "products", "is_active"):
            columns.append("is_active")
            values.append(1)
        if _has_column(conn, "products", "is_featured"):
            columns.append("is_featured")
            values.append(is_featured)
        if _has_column(conn, "products", "is_offer"):
            columns.append("is_offer")
            values.append(is_offer)

        placeholders = ", ".join(["?"] * len(columns))
        insert_sql = f"INSERT INTO products ({', '.join(columns)}) VALUES ({placeholders})"
        if DB_IS_POSTGRES:
            row = conn.execute(f"{insert_sql} RETURNING id", values).fetchone()
            product_id = int(row["id"] if isinstance(row, dict) else row[0])
        else:
            conn.execute(insert_sql, values)
            row = conn.execute("SELECT last_insert_rowid() as id").fetchone()
            product_id = int(row["id"] if isinstance(row, dict) else row[0])

        conn.commit()
        _replace_product_images(conn, product_id, image_values)
        conn.commit()
        
        return {
            "id": product_id,
            "name": name,
            "sku": sku,
            "price": price,
            "cost": cost,
            "stock": stock,
            "image_path": primary_image,
            "is_featured": bool(is_featured),
            "is_offer": bool(is_offer),
            "image_urls": image_values[1:],
        }
    finally:
        conn.close()


@app.post("/admin/uploads/product-image")
async def admin_upload_product_image(
    request: Request,
    file: UploadFile = File(...),
    product_name: str = Form(default=""),
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict:
    _require_admin(session_token)

    if not file.filename:
        raise HTTPException(status_code=400, detail="Archivo requerido")

    content_type = (file.content_type or "").strip().lower()
    if not content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="El archivo debe ser una imagen")

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="La imagen esta vacia")
    if len(content) > 12 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="La imagen supera el maximo de 12 MB")

    base_url, api_key, bucket = _supabase_storage_settings()
    target_name = _build_uploaded_image_name(file.filename, product_name)
    public_url = _upload_bytes_to_supabase(
        base_url=base_url,
        bucket=bucket,
        target_name=target_name,
        content=content,
        content_type=content_type,
        api_key=api_key,
    )
    return {"url": public_url, "path": public_url, "bucket": bucket, "object": target_name}


@app.put("/admin/products/{product_id}")
def admin_update_product(
    product_id: int,
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
    payload: dict = Body(...),
) -> dict:
    """Actualiza producto. Requiere sesión admin."""
    _require_admin(session_token)
    
    conn = _connect()
    try:
        _ensure_products_cost_column(conn)
        row = conn.execute(
            "SELECT id FROM products WHERE id = ? AND deleted_at IS NULL",
            (product_id,),
        ).fetchone()
        
        if not row:
            raise HTTPException(status_code=404, detail="Producto no encontrado")
        
        updates = []
        params = []
        
        if "name" in payload:
            updates.append("name = ?")
            params.append(str(payload["name"]).strip())
        if "sku" in payload:
            updates.append("sku = ?")
            params.append(str(payload["sku"]).strip())
        if "price" in payload:
            updates.append("price = ?")
            params.append(float(payload["price"]))
        if "cost" in payload:
            updates.append("cost = ?")
            params.append(float(payload["cost"]))
        if "stock" in payload:
            updates.append("stock = ?")
            params.append(int(payload["stock"]))
        if "image_path" in payload or "image_url" in payload or "image_urls" in payload:
            image_values = _normalize_image_entries(payload)
            updates.append("image_path = ?")
            params.append(image_values[0] if image_values else None)
            _replace_product_images(conn, product_id, image_values)
        if "is_featured" in payload:
            updates.append("is_featured = ?")
            params.append(1 if payload["is_featured"] else 0)
        if "is_offer" in payload:
            updates.append("is_offer = ?")
            params.append(1 if payload["is_offer"] else 0)
        
        if updates:
            updates.append("updated_at = CURRENT_TIMESTAMP")
            params.append(product_id)
            query = f"UPDATE products SET {', '.join(updates)} WHERE id = ?"
            conn.execute(query, params)
            conn.commit()
        
        return {"id": product_id, "message": "Producto actualizado"}
    finally:
        conn.close()


@app.delete("/admin/products/{product_id}")
def admin_delete_product(
    product_id: int,
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict:
    """Elimina (soft delete) producto. Requiere sesión admin."""
    _require_admin(session_token)
    
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT id FROM products WHERE id = ? AND deleted_at IS NULL",
            (product_id,),
        ).fetchone()
        
        if not row:
            raise HTTPException(status_code=404, detail="Producto no encontrado")
        
        conn.execute(
            "UPDATE products SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?",
            (product_id,),
        )
        conn.commit()
        
        return {"id": product_id, "message": "Producto eliminado"}
    finally:
        conn.close()


# ============================================================================
# ADMIN ENDPOINTS - CLIENTES
# ============================================================================

@app.get("/admin/customers")
def admin_list_customers(
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
    q: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
) -> list[dict]:
    """Lista clientes únicos de pedidos web. Requiere sesión admin."""
    _require_admin(session_token)
    
    conn = _connect()
    try:
        conditions = []
        params: list = []
        
        if q:
            conditions.append(
                "(customer_name LIKE ? OR customer_email LIKE ? OR customer_phone LIKE ?)"
            )
            like = f"%{q}%"
            params.extend([like, like, like])
        
        where_clause = f" WHERE {' AND '.join(conditions)}" if conditions else ""
        
        rows = conn.execute(
            f"""
            SELECT DISTINCT 
                   customer_name, customer_email, customer_phone,
                   COUNT(*) as order_count,
                   MIN(created_at) as first_order,
                   MAX(created_at) as last_order
            FROM web_orders
            {where_clause}
            GROUP BY customer_email
            ORDER BY last_order DESC
            LIMIT ? OFFSET ?
            """,
            params + [limit, offset],
        ).fetchall()
        
        return [
            {
                "name": row["customer_name"] or "Sin nombre",
                "email": row["customer_email"],
                "phone": row["customer_phone"],
                "order_count": int(row["order_count"]),
                "first_order": row["first_order"],
                "last_order": row["last_order"],
            }
            for row in rows
        ]
    finally:
        conn.close()


@app.get("/admin/backoffice-customers")
def admin_backoffice_customers(
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
    q: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
) -> list[dict]:
    _require_admin(session_token)
    conn = _connect()
    try:
        params: list[Any] = []
        where_clause = """
        WHERE COALESCE(is_active, 1) = 1 AND deleted_at IS NULL
        """
        if q:
            like = f"%{q.strip()}%"
            where_clause += """
            AND (name LIKE ? OR email LIKE ? OR phone LIKE ? OR cuit LIKE ? OR address LIKE ? OR locality LIKE ?)
            """
            params.extend([like, like, like, like, like, like])
        rows = conn.execute(
            f"""
            SELECT id, name, email, phone, created_at, sale_mode, locality, address, tax_condition, cuit, external_ref
            FROM customers
            {where_clause}
            ORDER BY name COLLATE NOCASE ASC, id ASC
            LIMIT ? OFFSET ?
            """,
            params + [limit, offset],
        ).fetchall()
        movements = conn.execute(
            """
            SELECT customer_id, amount, movement_type
            FROM account_movements
            ORDER BY created_at ASC, id ASC
            """
        ).fetchall()
        balances: dict[int, float] = {}
        for row in movements:
            customer_id = int(row["customer_id"] or 0)
            if customer_id <= 0:
                continue
            amount = float(row["amount"] or 0)
            signed = amount if str(row["movement_type"] or "").upper() == "DEBIT" else -amount
            balances[customer_id] = round(balances.get(customer_id, 0.0) + signed, 2)
        invoice_counts = {
            int(row["customer_id"]): int(row["qty"])
            for row in conn.execute(
                """
                SELECT customer_id, COUNT(*) AS qty
                FROM invoices
                GROUP BY customer_id
                """
            ).fetchall()
            if row["customer_id"] is not None
        }
        return [
            {
                "id": int(row["id"]),
                "name": row["name"],
                "email": row["email"],
                "phone": row["phone"],
                "created_at": row["created_at"],
                "sale_mode": row["sale_mode"],
                "locality": row["locality"],
                "address": row["address"],
                "tax_condition": row["tax_condition"],
                "cuit": row["cuit"],
                "external_ref": row["external_ref"],
                "balance": balances.get(int(row["id"]), 0.0),
                "invoice_count": invoice_counts.get(int(row["id"]), 0),
            }
            for row in rows
        ]
    finally:
        conn.close()


@app.get("/admin/backoffice-customers/{customer_id}")
def admin_backoffice_customer_detail(
    customer_id: int,
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict:
    _require_admin(session_token)
    conn = _connect()
    try:
        customer = conn.execute(
            """
            SELECT id, name, email, phone, created_at, sale_mode, locality, address, tax_condition, cuit, external_ref
            FROM customers
            WHERE id = ? AND COALESCE(is_active, 1) = 1 AND deleted_at IS NULL
            """,
            (customer_id,),
        ).fetchone()
        if customer is None:
            raise HTTPException(status_code=404, detail="Cliente no encontrado")
        invoices = conn.execute(
            """
            SELECT id, total, created_at, document_type, sale_mode, due_date, notes
            FROM invoices
            WHERE customer_id = ?
            ORDER BY created_at DESC, id DESC
            LIMIT 20
            """,
            (customer_id,),
        ).fetchall()
        movements = conn.execute(
            """
            SELECT am.id, am.amount, am.movement_type, am.reference, am.invoice_id, am.created_at, am.payment_method,
                   i.document_type, i.total, i.due_date
            FROM account_movements am
            LEFT JOIN invoices i ON i.id = am.invoice_id
            WHERE am.customer_id = ?
            ORDER BY am.created_at ASC, am.id ASC
            """,
            (customer_id,),
        ).fetchall()
        running_balance = 0.0
        serialized_movements = []
        for row in movements:
            movement_type = str(row["movement_type"] or "").upper()
            amount = float(row["amount"] or 0)
            signed = amount if movement_type == "DEBIT" else -amount
            running_balance = round(running_balance + signed, 2)
            serialized_movements.append(
                {
                    "id": int(row["id"]),
                    "movement_type": movement_type,
                    "amount": amount,
                    "signed_amount": signed,
                    "reference": row["reference"],
                    "invoice_id": int(row["invoice_id"]) if row["invoice_id"] is not None else None,
                    "created_at": row["created_at"],
                    "payment_method": row["payment_method"],
                    "document_type": row["document_type"],
                    "invoice_total": float(row["total"] or 0) if row["total"] is not None else None,
                    "due_date": row["due_date"],
                    "running_balance": running_balance,
                }
            )
        return {
            "id": int(customer["id"]),
            "name": customer["name"],
            "email": customer["email"],
            "phone": customer["phone"],
            "sale_mode": customer["sale_mode"],
            "locality": customer["locality"],
            "address": customer["address"],
            "tax_condition": customer["tax_condition"],
            "cuit": customer["cuit"],
            "external_ref": customer["external_ref"],
            "created_at": customer["created_at"],
            "balance": _customer_current_balance_from_rows(movements),
            "documents": [
                {
                    "id": int(item["id"]),
                    "total": float(item["total"] or 0),
                    "created_at": item["created_at"],
                    "document_type": item["document_type"],
                    "sale_mode": item["sale_mode"],
                    "due_date": item["due_date"],
                    "notes": item["notes"],
                }
                for item in invoices
            ],
            "movements": list(reversed(serialized_movements[-20:])),
        }
    finally:
        conn.close()


@app.post("/admin/backoffice-customers")
def admin_create_backoffice_customer(
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
    payload: dict = Body(...),
) -> dict:
    _require_admin(session_token)
    name = str(payload.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Nombre requerido")
    conn = _connect()
    try:
        conn.execute(
            """
            INSERT INTO customers (
                name, email, phone, created_at, sale_mode, locality, address, tax_condition, cuit, is_active
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
            """,
            (
                name,
                str(payload.get("email") or "").strip() or None,
                str(payload.get("phone") or "").strip() or None,
                datetime.utcnow().isoformat(),
                str(payload.get("sale_mode") or "CONTADO").strip() or "CONTADO",
                str(payload.get("locality") or "").strip() or None,
                str(payload.get("address") or "").strip() or None,
                str(payload.get("tax_condition") or "").strip() or None,
                str(payload.get("cuit") or "").strip() or None,
            ),
        )
        conn.commit()
        row = conn.execute("SELECT last_insert_rowid() AS id").fetchone()
        return {"id": int(row["id"] if isinstance(row, dict) else row[0]), "message": "Cliente creado"}
    finally:
        conn.close()


@app.put("/admin/backoffice-customers/{customer_id}")
def admin_update_backoffice_customer(
    customer_id: int,
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
    payload: dict = Body(...),
) -> dict:
    _require_admin(session_token)
    name = str(payload.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Nombre requerido")
    conn = _connect()
    try:
        _ensure_web_order_tables(conn)
        row = conn.execute(
            """
            SELECT id
            FROM customers
            WHERE id = ? AND COALESCE(is_active, 1) = 1 AND deleted_at IS NULL
            """,
            (customer_id,),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Cliente no encontrado")
        conn.execute(
            """
            UPDATE customers
               SET name = ?, email = ?, phone = ?, sale_mode = ?, locality = ?, address = ?, tax_condition = ?, cuit = ?
             WHERE id = ?
            """,
            (
                name,
                str(payload.get("email") or "").strip() or None,
                str(payload.get("phone") or "").strip() or None,
                str(payload.get("sale_mode") or "CONTADO").strip() or "CONTADO",
                str(payload.get("locality") or "").strip() or None,
                str(payload.get("address") or "").strip() or None,
                str(payload.get("tax_condition") or "").strip() or None,
                str(payload.get("cuit") or "").strip() or None,
                customer_id,
            ),
        )
        conn.commit()
        return {"id": customer_id, "message": "Cliente actualizado"}
    finally:
        conn.close()


@app.post("/admin/backoffice-customers/sync-web-orders")
def admin_sync_backoffice_customers_from_orders(
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict:
    _require_admin(session_token)
    conn = _connect()
    try:
        if not _has_table(conn, "web_orders"):
            return {"created": 0, "updated": 0, "skipped": 0, "total": 0}
        rows = conn.execute(
            """
            SELECT customer_name, customer_email, customer_phone
            FROM web_orders
            ORDER BY created_at DESC, id DESC
            """
        ).fetchall()
        created = 0
        updated = 0
        skipped = 0
        for row in rows:
            next_name = str(row["customer_name"] or "").strip()
            next_email = str(row["customer_email"] or "").strip() or None
            next_phone = str(row["customer_phone"] or "").strip() or None
            if not next_name:
                skipped += 1
                continue
            existing = None
            if next_email:
                existing = conn.execute(
                    "SELECT id, name, email, phone FROM customers WHERE LOWER(COALESCE(email, '')) = ? AND deleted_at IS NULL LIMIT 1",
                    (next_email.lower(),),
                ).fetchone()
            if existing is None and next_phone:
                existing = conn.execute(
                    "SELECT id, name, email, phone FROM customers WHERE phone = ? AND deleted_at IS NULL LIMIT 1",
                    (next_phone,),
                ).fetchone()
            if existing is None:
                existing = conn.execute(
                    "SELECT id, name, email, phone FROM customers WHERE name = ? AND deleted_at IS NULL LIMIT 1",
                    (next_name,),
                ).fetchone()
            if existing is None:
                conn.execute(
                    """
                    INSERT INTO customers (name, email, phone, created_at, sale_mode, is_active)
                    VALUES (?, ?, ?, ?, 'CONTADO', 1)
                    """,
                    (next_name, next_email, next_phone, datetime.utcnow().isoformat()),
                )
                created += 1
                continue
            current_email = str(existing["email"] or "").strip() or None
            current_phone = str(existing["phone"] or "").strip() or None
            if current_email == next_email and current_phone == next_phone and str(existing["name"] or "").strip() == next_name:
                skipped += 1
                continue
            conn.execute(
                """
                UPDATE customers
                   SET name = ?, email = COALESCE(?, email), phone = COALESCE(?, phone)
                 WHERE id = ?
                """,
                (next_name, next_email, next_phone, int(existing["id"])),
            )
            updated += 1
        conn.commit()
        return {"created": created, "updated": updated, "skipped": skipped, "total": len(rows)}
    finally:
        conn.close()


# LEGACY: flujo interno previo al backoffice web. No usar para nuevos modulos.
@app.get("/admin/account-customers")
def admin_account_customers(
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
    q: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
) -> list[dict]:
    _require_admin(session_token)
    conn = _connect()
    try:
        _ensure_accounting_tables(conn)
        params: list = []
        where_clause = ""
        if q:
            like = f"%{q.strip()}%"
            where_clause = """
            WHERE name LIKE ? OR email LIKE ? OR phone LIKE ? OR tax_id LIKE ?
            """
            params.extend([like, like, like, like])
        rows = conn.execute(
            f"""
            SELECT id, name, email, phone, tax_id, tax_condition, address, city, notes, created_at, updated_at
            FROM account_customers
            {where_clause}
            ORDER BY updated_at DESC, id DESC
            LIMIT ? OFFSET ?
            """,
            params + [limit, offset],
        ).fetchall()
        return [
            {
                "id": int(row["id"]),
                "name": row["name"],
                "email": row["email"],
                "phone": row["phone"],
                "tax_id": row["tax_id"],
                "tax_condition": row["tax_condition"],
                "address": row["address"],
                "city": row["city"],
                "notes": row["notes"],
                "balance": _customer_balance(conn, int(row["id"])),
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
            }
            for row in rows
        ]
    finally:
        conn.close()


@app.post("/admin/account-customers")
def admin_create_account_customer(
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
    payload: dict = Body(...),
) -> dict:
    _require_admin(session_token)
    name = str(payload.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Nombre requerido")
    conn = _connect()
    try:
        _ensure_accounting_tables(conn)
        conn.execute(
            """
            INSERT INTO account_customers
                (name, email, phone, tax_id, tax_condition, address, city, notes, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            """,
            (
                name,
                str(payload.get("email") or "").strip() or None,
                str(payload.get("phone") or "").strip() or None,
                str(payload.get("tax_id") or "").strip() or None,
                str(payload.get("tax_condition") or "").strip() or None,
                str(payload.get("address") or "").strip() or None,
                str(payload.get("city") or "").strip() or None,
                str(payload.get("notes") or "").strip() or None,
            ),
        )
        conn.commit()
        row = conn.execute(
            """
            SELECT id
            FROM account_customers
            WHERE name = ?
            ORDER BY id DESC
            LIMIT 1
            """,
            (name,),
        ).fetchone()
        customer_id = int(row["id"] if isinstance(row, dict) else row[0])
        return {"id": customer_id, "name": name}
    finally:
        conn.close()


@app.post("/admin/account-customers/sync-web-orders")
def admin_sync_account_customers_from_orders(
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict:
    _require_admin(session_token)
    conn = _connect()
    created = 0
    updated = 0
    skipped = 0
    try:
        _ensure_accounting_tables(conn)
        if not _has_table(conn, "web_orders"):
            return {"created": 0, "updated": 0, "skipped": 0, "total": 0}
        rows = conn.execute(
            """
            SELECT customer_email, customer_phone, customer_name
            FROM web_orders
            WHERE COALESCE(TRIM(customer_name), '') <> ''
               OR COALESCE(TRIM(customer_email), '') <> ''
               OR COALESCE(TRIM(customer_phone), '') <> ''
            ORDER BY created_at DESC
            """
        ).fetchall()
        for row in rows:
            email, phone, name = _account_customer_identity(row)
            if not (email or phone or name):
                skipped += 1
                continue
            existing = None
            if email:
                existing = conn.execute(
                    "SELECT id, name, email, phone FROM account_customers WHERE LOWER(COALESCE(email, '')) = ? LIMIT 1",
                    (email,),
                ).fetchone()
            if existing is None and phone:
                existing = conn.execute(
                    "SELECT id, name, email, phone FROM account_customers WHERE phone = ? LIMIT 1",
                    (phone,),
                ).fetchone()
            if existing is None and name:
                existing = conn.execute(
                    "SELECT id, name, email, phone FROM account_customers WHERE name = ? LIMIT 1",
                    (name,),
                ).fetchone()

            if existing is None:
                conn.execute(
                    """
                    INSERT INTO account_customers (name, email, phone, tax_condition, updated_at)
                    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
                    """,
                    (name or phone or email or "Cliente web", email, phone, "Consumidor Final"),
                )
                created += 1
                continue

            next_name = name or (existing["name"] if isinstance(existing, dict) else existing[1])
            next_email = email or (existing["email"] if isinstance(existing, dict) else existing[2])
            next_phone = phone or (existing["phone"] if isinstance(existing, dict) else existing[3])
            conn.execute(
                """
                UPDATE account_customers
                   SET name = ?, email = ?, phone = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?
                """,
                (
                    next_name,
                    next_email,
                    next_phone,
                    int(existing["id"] if isinstance(existing, dict) else existing[0]),
                ),
            )
            updated += 1
        conn.commit()
        return {
            "created": created,
            "updated": updated,
            "skipped": skipped,
            "total": len(rows),
        }
    finally:
        conn.close()


@app.get("/admin/cc/overview")
def admin_cc_overview(
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict:
    _require_admin(session_token)
    conn = _connect()
    try:
        if not _has_table(conn, "customers") or not _has_table(conn, "account_movements"):
            return {"customers": [], "summary": {"customers": 0, "debit": 0, "credit": 0, "balance": 0}}
        customer_rows = conn.execute(
            """
            SELECT id, name, email, phone, sale_mode, locality, address, tax_condition, cuit
            FROM customers
            WHERE COALESCE(is_active, 1) = 1 AND deleted_at IS NULL
            ORDER BY name COLLATE NOCASE ASC
            """
        ).fetchall()
        movement_rows = conn.execute(
            """
            SELECT id, customer_id, amount, movement_type, reference, invoice_id, created_at, payment_method
            FROM account_movements
            ORDER BY created_at ASC, id ASC
            """
        ).fetchall()
        movements_by_customer: dict[int, list[Any]] = {}
        for row in movement_rows:
            customer_id = int(row["customer_id"] if isinstance(row, dict) else row[1])
            movements_by_customer.setdefault(customer_id, []).append(row)
        customers: list[dict[str, Any]] = []
        total_debit = 0.0
        total_credit = 0.0
        total_balance = 0.0
        for row in customer_rows:
            customer_id = int(row["id"])
            customer_movements = movements_by_customer.get(customer_id, [])
            if not customer_movements and str(row["sale_mode"] or "").strip().upper() != "CUENTA_CORRIENTE":
                continue
            debit = sum(
                float(item["amount"] or 0)
                for item in customer_movements
                if str(item["movement_type"] or "").upper() == "DEBIT"
            )
            credit = sum(
                float(item["amount"] or 0)
                for item in customer_movements
                if str(item["movement_type"] or "").upper() == "CREDIT"
            )
            balance = round(debit - credit, 2)
            aging = _aging_from_movements(customer_movements)
            total_debit += debit
            total_credit += credit
            total_balance += balance
            last_movement = customer_movements[-1]["created_at"] if customer_movements else None
            customers.append(
                {
                    "id": customer_id,
                    "name": row["name"],
                    "email": row["email"],
                    "phone": row["phone"],
                    "sale_mode": row["sale_mode"],
                    "locality": row["locality"],
                    "address": row["address"],
                    "tax_condition": row["tax_condition"],
                    "cuit": row["cuit"],
                    "debit": round(debit, 2),
                    "credit": round(credit, 2),
                    "balance": balance,
                    "aging": aging,
                    "last_movement": last_movement,
                }
            )
        customers.sort(key=lambda item: ((item["name"] or "").lower(), item["id"]))
        return {
            "customers": customers,
            "summary": {
                "customers": len(customers),
                "debit": round(total_debit, 2),
                "credit": round(total_credit, 2),
                "balance": round(total_balance, 2),
            },
        }
    finally:
        conn.close()


@app.get("/admin/cc/{customer_id}")
def admin_cc_customer_detail(
    customer_id: int,
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict:
    _require_admin(session_token)
    conn = _connect()
    try:
        customer = conn.execute(
            """
            SELECT id, name, email, phone, sale_mode, locality, address, tax_condition, cuit
            FROM customers
            WHERE id = ? AND COALESCE(is_active, 1) = 1 AND deleted_at IS NULL
            """,
            (customer_id,),
        ).fetchone()
        if customer is None:
            raise HTTPException(status_code=404, detail="Cliente no encontrado")
        movements = conn.execute(
            """
            SELECT am.id, am.customer_id, am.amount, am.movement_type, am.reference, am.invoice_id,
                   am.created_at, am.payment_method, i.document_type, i.total, i.due_date
            FROM account_movements am
            LEFT JOIN invoices i ON i.id = am.invoice_id
            WHERE am.customer_id = ?
            ORDER BY am.created_at ASC, am.id ASC
            """,
            (customer_id,),
        ).fetchall()
        serialized = []
        running_balance = 0.0
        for row in movements:
            movement_type = str(row["movement_type"] or "").upper()
            amount = float(row["amount"] or 0)
            signed = amount if movement_type == "DEBIT" else -amount
            running_balance = round(running_balance + signed, 2)
            serialized.append(
                {
                    "id": int(row["id"]),
                    "movement_type": movement_type,
                    "amount": amount,
                    "signed_amount": signed,
                    "reference": row["reference"],
                    "invoice_id": row["invoice_id"],
                    "created_at": row["created_at"],
                    "payment_method": row["payment_method"],
                    "document_type": row["document_type"],
                    "invoice_total": float(row["total"] or 0) if row["total"] is not None else None,
                    "due_date": row["due_date"],
                    "running_balance": running_balance,
                }
            )
        return {
            "customer": {
                "id": int(customer["id"]),
                "name": customer["name"],
                "email": customer["email"],
                "phone": customer["phone"],
                "sale_mode": customer["sale_mode"],
                "locality": customer["locality"],
                "address": customer["address"],
                "tax_condition": customer["tax_condition"],
                "cuit": customer["cuit"],
            },
            "balance": _customer_current_balance_from_rows(movements),
            "aging": _aging_from_movements(movements),
            "movements": serialized,
        }
    finally:
        conn.close()


@app.get("/admin/invoices")
def admin_list_invoices(
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
    limit: int = 200,
    customer_id: Optional[int] = None,
) -> list[dict]:
    _require_admin(session_token)
    conn = _connect()
    try:
        _ensure_invoice_payment_method_column(conn)
        params: list[Any] = []
        where = ""
        if customer_id:
            where = "WHERE i.customer_id = ?"
            params.append(int(customer_id))
        rows = conn.execute(
            f"""
            SELECT i.id, i.customer_id, i.total, i.created_at, i.document_type, i.sale_mode,
                   i.price_list, i.due_date, i.notes, i.payment_method, c.name AS customer_name
            FROM invoices i
            LEFT JOIN customers c ON c.id = i.customer_id
            {where}
            ORDER BY i.created_at DESC, i.id DESC
            LIMIT ?
            """,
            params + [limit],
        ).fetchall()
        return [
            {
                "id": int(row["id"]),
                "customer_id": int(row["customer_id"]) if row["customer_id"] is not None else None,
                "customer_name": row["customer_name"] or "Sin cliente",
                "total": float(row["total"] or 0),
                "created_at": row["created_at"],
                "document_type": row["document_type"],
                "sale_mode": row["sale_mode"],
                "price_list": int(row["price_list"]) if row["price_list"] is not None else 0,
                "due_date": row["due_date"],
                "notes": row["notes"],
                "payment_method": row["payment_method"],
            }
            for row in rows
        ]
    finally:
        conn.close()


@app.post("/admin/invoices")
def admin_create_invoice(
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
    payload: dict = Body(...),
) -> dict:
    _require_admin(session_token)
    customer_id = int(payload.get("customer_id") or 0)
    if customer_id <= 0:
        raise HTTPException(status_code=400, detail="Cliente requerido")
    items = payload.get("items")
    if not isinstance(items, list) or not items:
        raise HTTPException(status_code=400, detail="Agrega items al comprobante")

    document_type = str(payload.get("document_type") or "FACTURA").strip().upper() or "FACTURA"
    sale_mode_input = str(payload.get("sale_mode") or "").strip().upper() or None
    due_date = str(payload.get("due_date") or "").strip() or None
    notes = str(payload.get("notes") or "").strip() or None
    order_id = int(payload.get("order_id") or 0) or None
    created_at = str(payload.get("created_at") or "").strip() or datetime.utcnow().isoformat()

    conn = _connect()
    try:
        _ensure_invoice_payment_method_column(conn)
        customer = conn.execute(
            """
            SELECT id, sale_mode
            FROM customers
            WHERE id = ? AND COALESCE(is_active, 1) = 1 AND deleted_at IS NULL
            """,
            (customer_id,),
        ).fetchone()
        if customer is None:
            raise HTTPException(status_code=404, detail="Cliente no encontrado")

        normalized_items: list[dict[str, Any]] = []
        total = 0.0
        price_list = int(payload.get("price_list") or 0)
        if price_list not in {0, 1, 2}:
            price_list = 0
        payment_method = str(payload.get("payment_method") or "").strip() or None
        for raw in items:
            product_id = int((raw or {}).get("product_id") or 0)
            quantity = int((raw or {}).get("quantity") or 0)
            unit_price_payload = (raw or {}).get("unit_price")
            if product_id <= 0 or quantity <= 0:
                raise HTTPException(status_code=400, detail="Items invalidos")
            product = conn.execute(
                """
                SELECT id, name, price, stock
                FROM products
                WHERE id = ? AND deleted_at IS NULL AND COALESCE(is_active, 1) = 1
                """,
                (product_id,),
            ).fetchone()
            if product is None:
                raise HTTPException(status_code=404, detail=f"Producto {product_id} no encontrado")
            current_stock = int(product["stock"] or 0)
            if current_stock < quantity:
                raise HTTPException(
                    status_code=400,
                    detail=f"Sin stock suficiente para {product['name']}",
                )
            unit_price = round(
                float(
                    unit_price_payload
                    if unit_price_payload not in (None, "",)
                    else _pick_price_by_list(product, price_list)
                ),
                2,
            )
            if unit_price < 0:
                raise HTTPException(status_code=400, detail="Precio invalido")
            subtotal = round(quantity * unit_price, 2)
            total += subtotal
            normalized_items.append(
                {
                    "product_id": product_id,
                    "quantity": quantity,
                    "unit_price": unit_price,
                    "subtotal": subtotal,
                }
            )

        sale_mode = sale_mode_input or str(customer["sale_mode"] or "").strip().upper() or "CONTADO"
        external_ref_row = conn.execute(
            """
            SELECT external_ref
            FROM invoices
            WHERE external_ref IS NOT NULL AND TRIM(external_ref) <> ''
            ORDER BY id DESC
            LIMIT 1
            """
        ).fetchone()
        last_external = str(external_ref_row["external_ref"] or "").strip() if external_ref_row else ""
        next_external_number = int(last_external) + 1 if last_external.isdigit() else 1
        external_ref = f"{next_external_number:014d}"

        conn.execute(
            """
            INSERT INTO invoices (
                customer_id, total, created_at, seller_id, document_type, commission_amount,
                sale_mode, price_list, external_ref, due_date, notes, payment_method
            ) VALUES (?, ?, ?, NULL, ?, 0, ?, ?, ?, ?, ?, ?)
            """,
            (
                customer_id,
                round(total, 2),
                created_at,
                document_type,
                sale_mode,
                price_list,
                external_ref,
                due_date,
                notes,
                payment_method,
            ),
        )
        invoice_row = conn.execute("SELECT last_insert_rowid() AS id").fetchone()
        invoice_id = int(invoice_row["id"] if isinstance(invoice_row, dict) else invoice_row[0])

        for item in normalized_items:
            conn.execute(
                """
                INSERT INTO invoice_items (invoice_id, product_id, quantity, unit_price)
                VALUES (?, ?, ?, ?)
                """,
                (invoice_id, item["product_id"], item["quantity"], item["unit_price"]),
            )
            conn.execute(
                "UPDATE products SET stock = stock - ? WHERE id = ?",
                (item["quantity"], item["product_id"]),
            )

        if sale_mode == "CUENTA_CORRIENTE":
            conn.execute(
                """
                INSERT INTO account_movements (
                    customer_id, invoice_id, amount, movement_type, reference, created_at, payment_method
                ) VALUES (?, ?, ?, 'DEBIT', ?, ?, NULL)
                """,
                (customer_id, invoice_id, round(total, 2), f"{document_type} #{invoice_id}", created_at),
            )

        if order_id:
            conn.execute(
                """
                UPDATE web_orders
                   SET status = 'CONFIRMED', confirmed_at = ?, confirmed_invoice_id = ?
                 WHERE id = ?
                """,
                (datetime.utcnow().isoformat(), str(invoice_id), order_id),
            )

        conn.commit()
        return {
            "id": invoice_id,
            "customer_id": customer_id,
            "total": round(total, 2),
            "document_type": document_type,
            "sale_mode": sale_mode,
            "price_list": price_list,
            "external_ref": external_ref,
            "payment_method": payment_method,
            "message": "Comprobante creado",
        }
    finally:
        conn.close()


@app.get("/admin/invoices/{invoice_id}")
def admin_invoice_detail(
    invoice_id: int,
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict:
    _require_admin(session_token)
    conn = _connect()
    try:
        _ensure_invoice_payment_method_column(conn)
        invoice = conn.execute(
            """
            SELECT i.id, i.customer_id, i.total, i.created_at, i.seller_id, i.document_type,
                   i.commission_amount, i.sale_mode, i.price_list, i.external_ref, i.due_date,
                   i.notes, i.payment_method, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
                   c.sale_mode AS customer_sale_mode, c.locality, c.address, c.tax_condition, c.cuit
            FROM invoices i
            LEFT JOIN customers c ON c.id = i.customer_id
            WHERE i.id = ?
            """,
            (invoice_id,),
        ).fetchone()
        if invoice is None:
            raise HTTPException(status_code=404, detail="Comprobante no encontrado")
        items = conn.execute(
            """
            SELECT ii.id, ii.product_id, ii.quantity, ii.unit_price, p.name AS product_name, p.image_path
            FROM invoice_items ii
            LEFT JOIN products p ON p.id = ii.product_id
            WHERE ii.invoice_id = ?
            ORDER BY ii.id ASC
            """,
            (invoice_id,),
        ).fetchall()
        payments = conn.execute(
            """
            SELECT id, customer_id, invoice_id, amount, movement_type, reference, created_at, payment_method
            FROM account_movements
            WHERE invoice_id = ?
            ORDER BY created_at ASC, id ASC
            """,
            (invoice_id,),
        ).fetchall()
        serialized_items = []
        subtotal = 0.0
        for row in items:
            quantity = int(row["quantity"] or 0)
            unit_price = float(row["unit_price"] or 0)
            line_total = round(quantity * unit_price, 2)
            subtotal += line_total
            serialized_items.append(
                {
                    "id": int(row["id"]),
                    "product_id": int(row["product_id"]) if row["product_id"] is not None else None,
                    "product_name": row["product_name"] or f"Producto {row['product_id']}",
                    "quantity": quantity,
                    "unit_price": unit_price,
                    "line_total": line_total,
                    "image_path": row["image_path"],
                }
            )
        serialized_payments = []
        total_payments = 0.0
        for row in payments:
            movement_type = str(row["movement_type"] or "").upper()
            amount = float(row["amount"] or 0)
            signed_amount = amount if movement_type == "DEBIT" else -amount
            if movement_type == "CREDIT":
                total_payments += amount
            serialized_payments.append(
                {
                    "id": int(row["id"]),
                    "customer_id": int(row["customer_id"]) if row["customer_id"] is not None else None,
                    "invoice_id": int(row["invoice_id"]) if row["invoice_id"] is not None else None,
                    "amount": amount,
                    "signed_amount": signed_amount,
                    "movement_type": movement_type,
                    "reference": row["reference"],
                    "created_at": row["created_at"],
                    "payment_method": row["payment_method"],
                }
            )
        balance_due = round(float(invoice["total"] or 0) - total_payments, 2)
        return {
            "invoice": {
                "id": int(invoice["id"]),
                "customer_id": int(invoice["customer_id"]) if invoice["customer_id"] is not None else None,
                "customer_name": invoice["customer_name"] or "Sin cliente",
                "customer_email": invoice["customer_email"],
                "customer_phone": invoice["customer_phone"],
                "customer_sale_mode": invoice["customer_sale_mode"],
                "locality": invoice["locality"],
                "address": invoice["address"],
                "tax_condition": invoice["tax_condition"],
                "cuit": invoice["cuit"],
                "total": float(invoice["total"] or 0),
                "created_at": invoice["created_at"],
                "seller_id": int(invoice["seller_id"]) if invoice["seller_id"] is not None else None,
                "document_type": invoice["document_type"],
                "commission_amount": float(invoice["commission_amount"] or 0),
                "sale_mode": invoice["sale_mode"],
                "price_list": int(invoice["price_list"]) if invoice["price_list"] is not None else None,
                "external_ref": invoice["external_ref"],
                "due_date": invoice["due_date"],
                "notes": invoice["notes"],
                "payment_method": invoice["payment_method"],
            },
            "items": serialized_items,
            "payments": serialized_payments,
            "summary": {
                "items": len(serialized_items),
                "subtotal": round(subtotal, 2),
                "payments_total": round(total_payments, 2),
                "balance_due": balance_due,
            },
        }
    finally:
        conn.close()


@app.post("/admin/cc/{customer_id}/movements")
def admin_cc_create_movement(
    customer_id: int,
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
    payload: dict = Body(...),
) -> dict:
    _require_admin(session_token)
    movement_type = str(payload.get("movement_type") or "").strip().upper()
    if movement_type not in {"DEBIT", "CREDIT"}:
        raise HTTPException(status_code=400, detail="Tipo de movimiento invalido")
    amount = round(float(payload.get("amount") or 0), 2)
    if amount <= 0:
        raise HTTPException(status_code=400, detail="Importe invalido")
    invoice_id = payload.get("invoice_id")
    parsed_invoice_id = int(invoice_id) if invoice_id not in (None, "", 0, "0") else None
    created_at = str(payload.get("created_at") or "").strip() or datetime.utcnow().isoformat()
    reference = str(payload.get("reference") or "").strip() or None
    payment_method = str(payload.get("payment_method") or "").strip() or None

    conn = _connect()
    try:
        customer = conn.execute(
            """
            SELECT id
            FROM customers
            WHERE id = ? AND COALESCE(is_active, 1) = 1 AND deleted_at IS NULL
            """,
            (customer_id,),
        ).fetchone()
        if customer is None:
            raise HTTPException(status_code=404, detail="Cliente no encontrado")
        if parsed_invoice_id is not None:
            invoice = conn.execute(
                """
                SELECT id, customer_id
                FROM invoices
                WHERE id = ?
                """,
                (parsed_invoice_id,),
            ).fetchone()
            if invoice is None:
                raise HTTPException(status_code=404, detail="Comprobante no encontrado")
            if int(invoice["customer_id"] or 0) != customer_id:
                raise HTTPException(status_code=400, detail="El comprobante no pertenece al cliente")
        conn.execute(
            """
            INSERT INTO account_movements (customer_id, invoice_id, amount, movement_type, reference, created_at, payment_method)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (customer_id, parsed_invoice_id, amount, movement_type, reference, created_at, payment_method),
        )
        conn.commit()
        balance_row = conn.execute(
            """
            SELECT amount, movement_type
            FROM account_movements
            WHERE customer_id = ?
            ORDER BY created_at ASC, id ASC
            """,
            (customer_id,),
        ).fetchall()
        return {
            "customer_id": customer_id,
            "invoice_id": parsed_invoice_id,
            "balance": _customer_current_balance_from_rows(balance_row),
            "message": "Movimiento registrado",
        }
    finally:
        conn.close()


@app.get("/admin/reports/overview")
def admin_reports_overview(
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict:
    _require_admin(session_token)
    conn = _connect()
    try:
        products = conn.execute(
            """
            SELECT id, name, stock, price, cost, reorder_point, category_id
            FROM products
            WHERE deleted_at IS NULL AND COALESCE(is_active, 1) = 1
            """
        ).fetchall()
        categories = conn.execute(
            """
            SELECT id, name
            FROM categories
            """
        ).fetchall()
        invoices = conn.execute(
            """
            SELECT id, customer_id, total, created_at, document_type, sale_mode
            FROM invoices
            ORDER BY created_at ASC, id ASC
            """
        ).fetchall()
        invoice_items = conn.execute(
            """
            SELECT ii.product_id, ii.quantity, ii.unit_price, i.customer_id, i.created_at
            FROM invoice_items ii
            LEFT JOIN invoices i ON i.id = ii.invoice_id
            """
        ).fetchall()
        cc_rows = conn.execute(
            """
            SELECT customer_id, amount, movement_type, created_at
            FROM account_movements
            ORDER BY created_at ASC, id ASC
            """
        ).fetchall()

        total_stock_units = sum(int(row["stock"] or 0) for row in products)
        cost_by_product = {int(row["id"]): float(row["cost"] or 0) for row in products}
        category_by_product = {int(row["id"]): int(row["category_id"] or 0) for row in products}
        category_names = {int(row["id"]): row["name"] for row in categories if row["id"] is not None}
        stock_value_cost = round(sum(float(row["cost"] or 0) * int(row["stock"] or 0) for row in products), 2)
        stock_value_sale = round(sum(float(row["price"] or 0) * int(row["stock"] or 0) for row in products), 2)
        low_stock = [
            {
                "id": int(row["id"]),
                "name": row["name"],
                "stock": int(row["stock"] or 0),
                "reorder_point": int(row["reorder_point"] or 0),
            }
            for row in products
            if int(row["stock"] or 0) <= max(0, int(row["reorder_point"] or 0))
        ][:20]

        monthly_map: dict[str, dict[str, Any]] = {}
        for row in invoices:
            created = _safe_parse_datetime(row["created_at"])
            if created is None:
                continue
            bucket = created.strftime("%Y-%m")
            entry = monthly_map.setdefault(bucket, {"month": bucket, "sales": 0.0, "count": 0, "margin": 0.0})
            entry["sales"] += float(row["total"] or 0)
            entry["count"] += 1

        top_products_map: dict[int, dict[str, Any]] = {}
        category_sales_map: dict[str, float] = {}
        customer_sales_map: dict[int, dict[str, Any]] = {}
        for row in invoice_items:
            product_id = int(row["product_id"] or 0)
            if product_id <= 0:
                continue
            entry = top_products_map.setdefault(
                product_id,
                {"product_id": product_id, "quantity": 0, "revenue": 0.0},
            )
            quantity = int(row["quantity"] or 0)
            unit_price = float(row["unit_price"] or 0)
            revenue = quantity * unit_price
            margin_value = quantity * max(0.0, unit_price - cost_by_product.get(product_id, 0.0))
            entry["quantity"] += quantity
            entry["revenue"] += revenue
            created = _safe_parse_datetime(row["created_at"])
            if created is not None:
                bucket = created.strftime("%Y-%m")
                monthly_entry = monthly_map.setdefault(bucket, {"month": bucket, "sales": 0.0, "count": 0, "margin": 0.0})
                monthly_entry["margin"] += margin_value
            category_name = category_names.get(category_by_product.get(product_id, 0), "Sin rubro")
            category_sales_map[category_name] = round(category_sales_map.get(category_name, 0.0) + revenue, 2)
            customer_id = int(row["customer_id"] or 0)
            if customer_id > 0:
                customer_entry = customer_sales_map.setdefault(
                    customer_id,
                    {"customer_id": customer_id, "quantity": 0, "revenue": 0.0},
                )
                customer_entry["quantity"] += quantity
                customer_entry["revenue"] += revenue
        monthly_sales = [monthly_map[key] for key in sorted(monthly_map.keys())][-12:]
        product_names = {int(row["id"]): row["name"] for row in products}
        top_products = sorted(
            [
                {
                    **payload,
                    "name": product_names.get(product_id, f"Producto {product_id}"),
                    "revenue": round(payload["revenue"], 2),
                }
                for product_id, payload in top_products_map.items()
            ],
            key=lambda item: (-item["quantity"], item["name"].lower()),
        )[:10]

        customer_balance_map: dict[int, float] = {}
        for row in cc_rows:
            customer_id = int(row["customer_id"] or 0)
            if customer_id <= 0:
                continue
            amount = float(row["amount"] or 0)
            signed = amount if str(row["movement_type"] or "").upper() == "DEBIT" else -amount
            customer_balance_map[customer_id] = round(customer_balance_map.get(customer_id, 0.0) + signed, 2)
        customer_names = {
            int(row["id"]): row["name"]
            for row in conn.execute("SELECT id, name FROM customers WHERE deleted_at IS NULL").fetchall()
        }
        customer_invoice_counts: dict[int, int] = {}
        for row in invoices:
            customer_id = int(row["customer_id"] or 0)
            if customer_id <= 0:
                continue
            customer_invoice_counts[customer_id] = customer_invoice_counts.get(customer_id, 0) + 1
        top_debtors = sorted(
            [
                {"customer_id": customer_id, "name": customer_names.get(customer_id, f"Cliente {customer_id}"), "balance": balance}
                for customer_id, balance in customer_balance_map.items()
                if balance > 0
            ],
            key=lambda item: (-item["balance"], item["name"].lower()),
        )[:10]
        top_customers = sorted(
            [
                {
                    **payload,
                    "name": customer_names.get(customer_id, f"Cliente {customer_id}"),
                    "invoice_count": customer_invoice_counts.get(customer_id, 0),
                    "revenue": round(float(payload["revenue"] or 0), 2),
                }
                for customer_id, payload in customer_sales_map.items()
            ],
            key=lambda item: (-item["revenue"], item["name"].lower()),
        )[:10]
        sales_by_category = sorted(
            [
                {"category": category, "revenue": round(value, 2)}
                for category, value in category_sales_map.items()
            ],
            key=lambda item: (-item["revenue"], item["category"].lower()),
        )[:8]

        total_sales = round(sum(float(row["total"] or 0) for row in invoices), 2)
        total_margin = round(
            sum(
                int(row["quantity"] or 0)
                * max(0.0, float(row["unit_price"] or 0) - cost_by_product.get(int(row["product_id"] or 0), 0.0))
                for row in invoice_items
            ),
            2,
        )
        now_dt = datetime.utcnow()
        current_year = now_dt.year
        current_month = now_dt.month
        current_year_months = [item for item in monthly_sales if str(item["month"]).startswith(f"{current_year}-")]
        previous_year_months = [item for item in monthly_sales if str(item["month"]).startswith(f"{current_year - 1}-")]
        current_ytd_sales = round(sum(float(item["sales"] or 0) for item in current_year_months), 2)
        previous_ytd_sales = round(
            sum(
                float(item["sales"] or 0)
                for item in previous_year_months
                if 1 <= int(str(item["month"]).split("-")[1]) <= current_month
            ),
            2,
        )
        previous_full_year_sales = round(sum(float(item["sales"] or 0) for item in previous_year_months), 2)
        if previous_ytd_sales > 0:
            growth_projection = round(previous_full_year_sales * (current_ytd_sales / previous_ytd_sales), 2)
        else:
            growth_projection = round(current_ytd_sales, 2)
        recent_complete_months = [
            item
            for item in current_year_months
            if int(str(item["month"]).split("-")[1]) < current_month
        ][-3:]
        if recent_complete_months:
            trend_projection = round(
                (sum(float(item["sales"] or 0) for item in recent_complete_months) / len(recent_complete_months)) * 12,
                2,
            )
        else:
            trend_projection = round((current_ytd_sales / max(current_month, 1)) * 12, 2)
        return {
            "summary": {
                "products": len(products),
                "active_customers": len(customer_names),
                "stock_units": total_stock_units,
                "stock_value_cost": stock_value_cost,
                "stock_value_sale": stock_value_sale,
                "sales_count": len(invoices),
                "sales_total": total_sales,
                "estimated_margin": total_margin,
                "cc_open_balance": round(sum(customer_balance_map.values()), 2),
                "account_movements": len(cc_rows),
                "debtors": len([balance for balance in customer_balance_map.values() if balance > 0]),
                "latest_invoice_at": invoices[-1]["created_at"] if invoices else None,
            },
            "monthly_sales": monthly_sales,
            "top_products": top_products,
            "top_customers": top_customers,
            "sales_by_category": sales_by_category,
            "top_debtors": top_debtors,
            "low_stock": low_stock,
            "year_projection": {
                "year": current_year,
                "current_ytd_sales": current_ytd_sales,
                "previous_ytd_sales": previous_ytd_sales,
                "previous_full_year_sales": previous_full_year_sales,
                "growth_projection": growth_projection,
                "trend_projection": trend_projection,
                "recent_window_months": len(recent_complete_months) if recent_complete_months else max(current_month - 1, 0),
            },
        }
    finally:
        conn.close()


# LEGACY: flujo interno previo al backoffice web. No usar para nuevos modulos.
@app.get("/admin/account-customers/{customer_id}")
def admin_account_customer_detail(
    customer_id: int,
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict:
    _require_admin(session_token)
    conn = _connect()
    try:
        _ensure_accounting_tables(conn)
        row = conn.execute(
            """
            SELECT id, name, email, phone, tax_id, tax_condition, address, city, notes, created_at, updated_at
            FROM account_customers
            WHERE id = ?
            """,
            (customer_id,),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Cliente no encontrado")
        documents = conn.execute(
            """
            SELECT id, document_kind, document_number, issue_date, total, created_at
            FROM account_documents
            WHERE customer_id = ?
            ORDER BY issue_date DESC, id DESC
            LIMIT 20
            """,
            (customer_id,),
        ).fetchall()
        return {
            "id": int(row["id"]),
            "name": row["name"],
            "email": row["email"],
            "phone": row["phone"],
            "tax_id": row["tax_id"],
            "tax_condition": row["tax_condition"],
            "address": row["address"],
            "city": row["city"],
            "notes": row["notes"],
            "balance": _customer_balance(conn, customer_id),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "documents": [
                {
                    "id": int(item["id"]),
                    "document_kind": item["document_kind"],
                    "document_number": item["document_number"],
                    "issue_date": item["issue_date"],
                    "total": float(item["total"] or 0),
                    "created_at": item["created_at"],
                }
                for item in documents
            ],
        }
    finally:
        conn.close()


# LEGACY: flujo interno previo al backoffice web. No usar para nuevos modulos.
@app.put("/admin/account-customers/{customer_id}")
def admin_update_account_customer(
    customer_id: int,
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
    payload: dict = Body(...),
) -> dict:
    _require_admin(session_token)
    conn = _connect()
    try:
        _ensure_accounting_tables(conn)
        row = conn.execute("SELECT id FROM account_customers WHERE id = ?", (customer_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Cliente no encontrado")
        name = str(payload.get("name") or "").strip()
        if not name:
            raise HTTPException(status_code=400, detail="Nombre requerido")
        conn.execute(
            """
            UPDATE account_customers
               SET name = ?, email = ?, phone = ?, tax_id = ?, tax_condition = ?,
                   address = ?, city = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?
            """,
            (
                name,
                str(payload.get("email") or "").strip() or None,
                str(payload.get("phone") or "").strip() or None,
                str(payload.get("tax_id") or "").strip() or None,
                str(payload.get("tax_condition") or "").strip() or None,
                str(payload.get("address") or "").strip() or None,
                str(payload.get("city") or "").strip() or None,
                str(payload.get("notes") or "").strip() or None,
                customer_id,
            ),
        )
        conn.commit()
        return {"id": customer_id, "message": "Cliente actualizado"}
    finally:
        conn.close()


# LEGACY: flujo interno previo al backoffice web. No usar para nuevos modulos.
@app.get("/admin/account-customers/{customer_id}/movements")
def admin_account_customer_movements(
    customer_id: int,
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict:
    _require_admin(session_token)
    conn = _connect()
    try:
        _ensure_accounting_tables(conn)
        rows = conn.execute(
            """
            SELECT id, customer_id, movement_type, amount, description, document_type, document_number, due_date, created_at
            FROM account_movements
            WHERE customer_id = ?
            ORDER BY created_at DESC, id DESC
            """,
            (customer_id,),
        ).fetchall()
        running_balance = _customer_balance(conn, customer_id)
        return {
            "balance": running_balance,
            "items": [
                {
                    "id": int(row["id"]),
                    "movement_type": row["movement_type"],
                    "amount": float(row["amount"] or 0),
                    "signed_amount": _movement_signed_amount(row),
                    "description": row["description"],
                    "document_type": row["document_type"],
                    "document_number": row["document_number"],
                    "due_date": row["due_date"],
                    "created_at": row["created_at"],
                }
                for row in rows
            ],
        }
    finally:
        conn.close()


# LEGACY: flujo interno previo al backoffice web. No usar para nuevos modulos.
@app.post("/admin/account-customers/{customer_id}/movements")
def admin_create_account_movement(
    customer_id: int,
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
    payload: dict = Body(...),
) -> dict:
    _require_admin(session_token)
    movement_type = str(payload.get("movement_type") or "").strip().upper()
    if movement_type not in {"DEBIT", "CREDIT"}:
        raise HTTPException(status_code=400, detail="Tipo de movimiento invalido")
    amount = float(payload.get("amount") or 0)
    if amount <= 0:
        raise HTTPException(status_code=400, detail="Importe invalido")
    conn = _connect()
    try:
        _ensure_accounting_tables(conn)
        row = conn.execute("SELECT id FROM account_customers WHERE id = ?", (customer_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Cliente no encontrado")
        conn.execute(
            """
            INSERT INTO account_movements
                (customer_id, movement_type, amount, description, document_type, document_number, due_date)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                customer_id,
                movement_type,
                amount,
                str(payload.get("description") or "").strip() or None,
                str(payload.get("document_type") or "").strip() or None,
                str(payload.get("document_number") or "").strip() or None,
                str(payload.get("due_date") or "").strip() or None,
            ),
        )
        conn.execute(
            "UPDATE account_customers SET updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (customer_id,),
        )
        conn.commit()
        return {"customer_id": customer_id, "balance": _customer_balance(conn, customer_id)}
    finally:
        conn.close()


# LEGACY: flujo interno previo al backoffice web. No usar para nuevos modulos.
@app.post("/admin/account-documents")
def admin_create_account_document(
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
    payload: dict = Body(...),
) -> dict:
    _require_admin(session_token)
    customer_id = int(payload.get("customer_id") or 0)
    document_kind = str(payload.get("document_kind") or "RECIBO_X").strip().upper()
    if document_kind not in {"RECIBO_X", "PRESUPUESTO", "NOTA_DEBITO", "NOTA_CREDITO"}:
        document_kind = "RECIBO_X"
    items = payload.get("items")
    if not isinstance(items, list) or not items:
        raise HTTPException(status_code=400, detail="Agrega items al comprobante")
    normalized_items = []
    total = 0.0
    for raw in items:
        description = str((raw or {}).get("description") or "").strip()
        quantity = float((raw or {}).get("quantity") or 0)
        unit_price = float((raw or {}).get("unit_price") or 0)
        if not description or quantity <= 0 or unit_price < 0:
            raise HTTPException(status_code=400, detail="Items invalidos")
        subtotal = round(quantity * unit_price, 2)
        total += subtotal
        normalized_items.append(
            {
                "description": description,
                "quantity": quantity,
                "unit_price": unit_price,
                "subtotal": subtotal,
            }
        )
    issue_date = str(payload.get("issue_date") or datetime.utcnow().date().isoformat()).strip()
    notes = str(payload.get("notes") or "").strip() or None
    conn = _connect()
    try:
        _ensure_accounting_tables(conn)
        row = conn.execute(
            """
            SELECT id, name, tax_id, tax_condition, address, city
            FROM account_customers
            WHERE id = ?
            """,
            (customer_id,),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Cliente no encontrado")
        document_number = _next_document_number(conn, document_kind)
        customer_address = " - ".join(
            [part for part in [row["address"], row["city"]] if part]
        ) or None
        conn.execute(
            """
            INSERT INTO account_documents
                (customer_id, document_kind, document_number, issue_date, total, customer_name,
                 customer_tax_id, customer_tax_condition, customer_address, notes, items_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                customer_id,
                document_kind,
                document_number,
                issue_date,
                round(total, 2),
                row["name"],
                row["tax_id"],
                row["tax_condition"],
                customer_address,
                notes,
                json.dumps(normalized_items, ensure_ascii=True),
            ),
        )
        conn.execute(
            """
            INSERT INTO account_movements
                (customer_id, movement_type, amount, description, document_type, document_number, due_date)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                customer_id,
                "DEBIT" if document_kind != "NOTA_CREDITO" else "CREDIT",
                round(total, 2),
                notes or f"Comprobante {document_number}",
                document_kind,
                document_number,
                issue_date,
            ),
        )
        conn.execute(
            "UPDATE account_customers SET updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (customer_id,),
        )
        conn.commit()
        row = conn.execute(
            """
            SELECT id
            FROM account_documents
            WHERE document_number = ?
            ORDER BY id DESC
            LIMIT 1
            """,
            (document_number,),
        ).fetchone()
        document_id = int(row["id"] if isinstance(row, dict) else row[0])
        return {
            "id": document_id,
            "document_number": document_number,
            "document_kind": document_kind,
            "total": round(total, 2),
        }
    finally:
        conn.close()


# LEGACY: flujo interno previo al backoffice web. No usar para nuevos modulos.
@app.get("/admin/account-documents/{document_id}")
def admin_account_document_detail(
    document_id: int,
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict:
    _require_admin(session_token)
    conn = _connect()
    try:
        _ensure_accounting_tables(conn)
        row = conn.execute(
            """
            SELECT id, customer_id, document_kind, document_number, issue_date, total, customer_name,
                   customer_tax_id, customer_tax_condition, customer_address, notes, items_json, created_at
            FROM account_documents
            WHERE id = ?
            """,
            (document_id,),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Comprobante no encontrado")
        items = json.loads(row["items_json"] or "[]")
        return {
            "id": int(row["id"]),
            "customer_id": int(row["customer_id"]),
            "document_kind": row["document_kind"],
            "document_number": row["document_number"],
            "issue_date": row["issue_date"],
            "total": float(row["total"] or 0),
            "customer_name": row["customer_name"],
            "customer_tax_id": row["customer_tax_id"],
            "customer_tax_condition": row["customer_tax_condition"],
            "customer_address": row["customer_address"],
            "notes": row["notes"],
            "items": items,
            "created_at": row["created_at"],
        }
    finally:
        conn.close()


# ============================================================================
# ADMIN ENDPOINTS - ÓRDENES (mejoras)
# ============================================================================

@app.get("/admin/orders-with-items")
def admin_list_orders_detailed(
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
    status: str = "PENDING",
    limit: int = 50,
) -> list[dict]:
    """Lista pedidos con detalles de items. Requiere sesión admin."""
    _require_admin(session_token)
    
    status_value = (status or "PENDING").strip().upper()
    if status_value not in {"PENDING", "CONFIRMED", "CANCELLED"}:
        status_value = "PENDING"
    
    conn = _connect()
    try:
        _ensure_web_order_tables(conn)
        rows = conn.execute(
            """
            SELECT id, customer_name, customer_phone, customer_email, notes, total, status,
                   created_at, confirmed_at, confirmed_invoice_id
            FROM web_orders
            WHERE status = ?
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (status_value, limit),
        ).fetchall()
        
        orders = []
        for row in rows:
            order_id = int(row["id"] if isinstance(row, dict) else row[0])
            
            items = conn.execute(
                """
                SELECT product_id, quantity, unit_price
                FROM web_order_items
                WHERE order_id = ?
                """,
                (order_id,),
            ).fetchall()
            
            orders.append({
                "id": order_id,
                "customer_name": row["customer_name"] if isinstance(row, dict) else row[1],
                "customer_phone": row["customer_phone"] if isinstance(row, dict) else row[2],
                "customer_email": row["customer_email"] if isinstance(row, dict) else row[3],
                "notes": row["notes"] if isinstance(row, dict) else row[4],
                "total": float(row["total"] if isinstance(row, dict) else row[5]),
                "status": (row["status"] if isinstance(row, dict) else row[6]) or "PENDING",
                "created_at": row["created_at"] if isinstance(row, dict) else row[7],
                "confirmed_at": row["confirmed_at"] if isinstance(row, dict) else row[8],
                "confirmed_invoice_id": row["confirmed_invoice_id"] if isinstance(row, dict) else row[9],
                "items": [
                    {
                        "product_id": int(item["product_id"] if isinstance(item, dict) else item[0]),
                        "quantity": int(item["quantity"] if isinstance(item, dict) else item[1]),
                        "unit_price": float(item["unit_price"] if isinstance(item, dict) else item[2]),
                    }
                    for item in items
                ],
            })
        
        return orders
    finally:
        conn.close()


# ============================================================================
# ADMIN ENDPOINTS - VENTAS
# ============================================================================

@app.get("/admin/sales")
def admin_list_sales(
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
) -> list[dict]:
    """Lista ventas registradas. Requiere sesión admin."""
    _require_admin(session_token)
    
    conn = _connect()
    try:
        has_sales_table = _has_table(conn, "sales")
        
        if not has_sales_table:
            return []
        
        conditions = []
        params: list = []
        
        if start_date:
            conditions.append("DATE(created_at) >= ?")
            params.append(start_date)
        if end_date:
            conditions.append("DATE(created_at) <= ?")
            params.append(end_date)
        
        where_clause = f" WHERE {' AND '.join(conditions)}" if conditions else ""
        
        rows = conn.execute(
            f"""
            SELECT id, total, notes, created_at
            FROM sales
            {where_clause}
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
            """,
            params + [limit, offset],
        ).fetchall()
        
        return [
            {
                "id": int(row["id"]),
                "total": float(row["total"] or 0),
                "notes": row["notes"],
                "created_at": row["created_at"],
            }
            for row in rows
        ]
    finally:
        conn.close()


@app.post("/admin/sales")
def admin_create_sale(
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
    payload: dict = Body(...),
) -> dict:
    """Registra nueva venta. Requiere sesión admin."""
    _require_admin(session_token)
    
    total = float(payload.get("total") or 0)
    notes = str(payload.get("notes") or "").strip()
    items = payload.get("items") or []
    
    if total <= 0:
        raise HTTPException(status_code=400, detail="Total debe ser mayor a 0")
    
    conn = _connect()
    try:
        # Crear tabla si no existe
        if not _has_table(conn, "sales"):
            conn.execute(
                """
                CREATE TABLE sales (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    total REAL NOT NULL,
                    notes TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            conn.commit()
        
        conn.execute(
            "INSERT INTO sales (total, notes) VALUES (?, ?)",
            (total, notes),
        )
        conn.commit()
        
        row = conn.execute("SELECT last_insert_rowid() as id").fetchone()
        sale_id = int(row["id"] if isinstance(row, dict) else row[0])
        
        return {
            "id": sale_id,
            "total": total,
            "notes": notes,
            "items_count": len(items),
        }
    finally:
        conn.close()


# ============================================================================
# ADMIN ENDPOINTS - COMPRAS
# ============================================================================

@app.get("/admin/purchases")
def admin_list_purchases(
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
) -> list[dict]:
    """Lista compras registradas. Requiere sesión admin."""
    _require_admin(session_token)
    
    conn = _connect()
    try:
        has_purchases_table = _has_table(conn, "purchases")
        
        if not has_purchases_table:
            return []
        
        conditions = []
        params: list = []
        
        if start_date:
            conditions.append("DATE(created_at) >= ?")
            params.append(start_date)
        if end_date:
            conditions.append("DATE(created_at) <= ?")
            params.append(end_date)
        
        where_clause = f" WHERE {' AND '.join(conditions)}" if conditions else ""
        
        rows = conn.execute(
            f"""
            SELECT id, supplier, total, notes, created_at
            FROM purchases
            {where_clause}
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
            """,
            params + [limit, offset],
        ).fetchall()
        
        return [
            {
                "id": int(row["id"]),
                "supplier": row.get("supplier", row["supplier"] if isinstance(row, dict) else None),
                "total": float(row["total"] or 0),
                "notes": row["notes"],
                "created_at": row["created_at"],
            }
            for row in rows
        ]
    finally:
        conn.close()


@app.post("/admin/purchases")
def admin_create_purchase(
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
    payload: dict = Body(...),
) -> dict:
    """Registra nueva compra. Requiere sesión admin."""
    _require_admin(session_token)
    
    supplier = str(payload.get("supplier") or "").strip()
    total = float(payload.get("total") or 0)
    notes = str(payload.get("notes") or "").strip()
    items = payload.get("items") or []
    
    if not supplier:
        raise HTTPException(status_code=400, detail="Proveedor requerido")
    if total <= 0:
        raise HTTPException(status_code=400, detail="Total debe ser mayor a 0")
    
    conn = _connect()
    try:
        # Crear tabla si no existe
        if not _has_table(conn, "purchases"):
            conn.execute(
                """
                CREATE TABLE purchases (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    supplier TEXT NOT NULL,
                    total REAL NOT NULL,
                    notes TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            conn.commit()
        
        conn.execute(
            "INSERT INTO purchases (supplier, total, notes) VALUES (?, ?, ?)",
            (supplier, total, notes),
        )
        conn.commit()
        
        row = conn.execute("SELECT last_insert_rowid() as id").fetchone()
        purchase_id = int(row["id"] if isinstance(row, dict) else row[0])
        
        return {
            "id": purchase_id,
            "supplier": supplier,
            "total": total,
            "notes": notes,
            "items_count": len(items),
        }
    finally:
        conn.close()


# ============================================================================
# ADMIN ENDPOINTS - CATEGORÍAS
# ============================================================================

@app.get("/admin/categories")
def admin_list_categories(
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
) -> list[dict]:
    """Lista categorías. Requiere sesión admin."""
    _require_admin(session_token)
    
    conn = _connect()
    try:
        has_categories_table = _has_table(conn, "categories")
        
        if not has_categories_table:
            return []
        
        rows = conn.execute(
            """
            SELECT id, name
            FROM categories
            ORDER BY name ASC
            """
        ).fetchall()
        
        return [
            {
                "id": int(row["id"]),
                "name": row["name"],
            }
            for row in rows
        ]
    finally:
        conn.close()


@app.post("/admin/categories")
def admin_create_category(
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
    payload: dict = Body(...),
) -> dict:
    """Crea nueva categoría. Requiere sesión admin."""
    _require_admin(session_token)
    
    name = str(payload.get("name") or "").strip()
    
    if not name:
        raise HTTPException(status_code=400, detail="Nombre requerido")
    
    conn = _connect()
    try:
        # Asegurarse que la tabla existe
        if not _has_table(conn, "categories"):
            conn.execute(
                """
                CREATE TABLE categories (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            conn.commit()
        
        # Verificar si ya existe
        row = conn.execute(
            "SELECT id FROM categories WHERE name = ?",
            (name,),
        ).fetchone()
        
        if row:
            raise HTTPException(status_code=409, detail="Categoría ya existe")
        
        conn.execute(
            "INSERT INTO categories (name) VALUES (?)",
            (name,),
        )
        conn.commit()
        
        row = conn.execute("SELECT last_insert_rowid() as id").fetchone()
        category_id = int(row["id"] if isinstance(row, dict) else row[0])
        
        return {
            "id": category_id,
            "name": name,
        }
    finally:
        conn.close()


@app.put("/admin/categories/{category_id}")
def admin_update_category(
    category_id: int,
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
    payload: dict = Body(...),
) -> dict:
    """Actualiza categoría. Requiere sesión admin."""
    _require_admin(session_token)
    
    name = str(payload.get("name") or "").strip()
    
    if not name:
        raise HTTPException(status_code=400, detail="Nombre requerido")
    
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT id FROM categories WHERE id = ?",
            (category_id,),
        ).fetchone()
        
        if not row:
            raise HTTPException(status_code=404, detail="Categoría no encontrada")
        
        # Verificar unicidad
        existing = conn.execute(
            "SELECT id FROM categories WHERE name = ? AND id != ?",
            (name, category_id),
        ).fetchone()
        
        if existing:
            raise HTTPException(status_code=409, detail="El nombre ya existe")
        
        conn.execute(
            "UPDATE categories SET name = ? WHERE id = ?",
            (name, category_id),
        )
        conn.commit()
        
        return {"id": category_id, "name": name}
    finally:
        conn.close()


@app.delete("/admin/categories/{category_id}")
def admin_delete_category(
    category_id: int,
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict:
    """Elimina categoría. Requiere sesión admin."""
    _require_admin(session_token)
    
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT id FROM categories WHERE id = ?",
            (category_id,),
        ).fetchone()
        
        if not row:
            raise HTTPException(status_code=404, detail="Categoría no encontrada")
        
        # Verificar que no tenga productos
        product_count = conn.execute(
            "SELECT COUNT(*) as count FROM products WHERE category_id = ? AND deleted_at IS NULL",
            (category_id,),
        ).fetchone()
        
        count = product_count["count"] if isinstance(product_count, dict) else product_count[0]
        if count > 0:
            raise HTTPException(
                status_code=409,
                detail=f"No se puede eliminar: hay {count} productos en esta categoría",
            )
        
        conn.execute("DELETE FROM categories WHERE id = ?", (category_id,))
        conn.commit()
        
        return {"id": category_id, "message": "Categoría eliminada"}
    finally:
        conn.close()


# ============================================================================
# ADMIN ENDPOINTS - GASTOS
# ============================================================================

@app.get("/admin/expenses")
def admin_list_expenses(
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
) -> list[dict]:
    """Lista gastos. Requiere sesión admin."""
    _require_admin(session_token)
    
    conn = _connect()
    try:
        has_expenses_table = _has_table(conn, "expenses")
        
        if not has_expenses_table:
            return []
        
        conditions = []
        params: list = []
        
        if start_date:
            conditions.append("DATE(created_at) >= ?")
            params.append(start_date)
        if end_date:
            conditions.append("DATE(created_at) <= ?")
            params.append(end_date)
        
        where_clause = f" WHERE {' AND '.join(conditions)}" if conditions else ""
        
        rows = conn.execute(
            f"""
            SELECT id, category, amount, description, created_at
            FROM expenses
            {where_clause}
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
            """,
            params + [limit, offset],
        ).fetchall()
        
        return [
            {
                "id": int(row["id"]),
                "category": row.get("category", row["category"] if isinstance(row, dict) else None),
                "amount": float(row["amount"] or 0),
                "description": row.get("description", row["description"] if isinstance(row, dict) else None),
                "created_at": row["created_at"],
            }
            for row in rows
        ]
    finally:
        conn.close()


@app.post("/admin/expenses")
def admin_create_expense(
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
    payload: dict = Body(...),
) -> dict:
    """Registra nuevo gasto. Requiere sesión admin."""
    _require_admin(session_token)
    
    category = str(payload.get("category") or "").strip()
    amount = float(payload.get("amount") or 0)
    description = str(payload.get("description") or "").strip()
    
    if not category:
        raise HTTPException(status_code=400, detail="Categoría requerida")
    if amount <= 0:
        raise HTTPException(status_code=400, detail="Monto debe ser mayor a 0")
    
    conn = _connect()
    try:
        # Crear tabla si no existe
        if not _has_table(conn, "expenses"):
            conn.execute(
                """
                CREATE TABLE expenses (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    category TEXT NOT NULL,
                    amount REAL NOT NULL,
                    description TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            conn.commit()
        
        conn.execute(
            "INSERT INTO expenses (category, amount, description) VALUES (?, ?, ?)",
            (category, amount, description),
        )
        conn.commit()
        
        row = conn.execute("SELECT last_insert_rowid() as id").fetchone()
        expense_id = int(row["id"] if isinstance(row, dict) else row[0])
        
        return {
            "id": expense_id,
            "category": category,
            "amount": amount,
            "description": description,
        }
    finally:
        conn.close()
