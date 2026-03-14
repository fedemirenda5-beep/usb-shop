from __future__ import annotations

import base64
import hashlib
import hmac
import io
import json
import logging
import os
import sqlite3
import time
import smtplib
import threading
from email.message import EmailMessage
from datetime import datetime
from functools import lru_cache
from pathlib import Path
from typing import Optional, List, Any
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from fastapi import Body, Cookie, FastAPI, HTTPException, Query, Request, Response
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
    pass



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
        return ["http://localhost:3000", "http://127.0.0.1:3000"]
    return [origin.strip() for origin in raw.split(",") if origin.strip()]


_load_env_file()
DB_URL = (os.getenv("CONTROLSTOCK_DATABASE_URL") or os.getenv("DATABASE_URL") or "").strip()
DB_IS_POSTGRES = DB_URL.lower().startswith("postgres")
LOGGER = _setup_logging()

app = FastAPI(title="USB Shop API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins(),
    allow_origin_regex=".*",
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


def _pick_price(row: Any) -> float:
    price_list_1 = row["price_list_1"] or 0
    price = row["price"] or 0
    return float(price_list_1) if price_list_1 > 0 else float(price)


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
    try:
        path = Path(raw).expanduser()
    except Exception:
        return None
    try:
        if path.exists() and path.is_file():
            return path
    except OSError:
        return None
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


def _require_sync_token(request: Request) -> None:
    token = (os.getenv("USB_SYNC_TOKEN") or "").strip()
    if not token:
        raise HTTPException(status_code=500, detail="Falta USB_SYNC_TOKEN")
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


@app.get("/products")
def list_products(limit: int = 50, q: Optional[str] = None) -> list[dict]:
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
        query = f"""
            SELECT {", ".join(select_fields)}
            FROM products p
            LEFT JOIN categories c ON c.id = p.category_id
        """
        if conditions:
            query += f" WHERE {' AND '.join(conditions)}"
        params: list = []
        if q:
            query += " AND (p.name LIKE ? OR p.sku LIKE ?)" if conditions else " WHERE (p.name LIKE ? OR p.sku LIKE ?)"
            like = f"%{q}%"
            params.extend([like, like])
        if has_created_at and has_updated_at:
            order_by = "COALESCE(p.created_at, p.updated_at) DESC, p.id DESC"
        elif has_created_at:
            order_by = "p.created_at DESC, p.id DESC"
        elif has_updated_at:
            order_by = "p.updated_at DESC, p.id DESC"
        else:
            order_by = "p.id DESC"
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
            "stock": int(row["stock"] or 0),
            "category": row["category"] or "General",
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
    status: str = "PENDING",
    limit: int = 200,
    include_items: bool = True,
) -> list[dict]:
    _require_sync_token(request)
    status_value = (status or "PENDING").strip().upper()
    if status_value not in {"PENDING", "CONFIRMED", "CANCELLED"}:
        status_value = "PENDING"

    conn = _connect()
    try:
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


@app.post("/admin/orders/{order_id}/status")
def admin_update_order_status(
    order_id: int,
    request: Request,
    payload: OrderStatusPayload = Body(...),
) -> dict:
    _require_sync_token(request)
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
        query = f"""
            SELECT {", ".join(select_fields)}
            FROM products p
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
            samesite="none",
            secure=True,
        )
    return {"username": row["username"], "role": row["role"]}


@app.post("/auth/logout")
def auth_logout(response: Response, request: Request) -> dict:
    if response is not None:
        response.delete_cookie(SESSION_COOKIE, samesite="none", secure=True)
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
        fallback_image = _first_product_image_candidate(conn, product_id)
    finally:
        conn.close()

    if row is None:
        raise HTTPException(status_code=404, detail="Imagen no encontrada")

    primary_image = str(row["image_path"]).strip() if row["image_path"] else ""
    image_value = primary_image or (fallback_image or "").strip()
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
    session_token: Optional[str] = Cookie(default=None),
    q: Optional[str] = None,
    category: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
) -> list[dict]:
    """Lista productos. Requiere sesión admin."""
    _require_admin(session_token)
    
    conn = _connect()
    try:
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
            SELECT id, name, sku, price, price_list_1, stock, 
                   image_path, category_id, is_active, is_featured, is_offer
            FROM products
            {where_clause}
            ORDER BY id DESC
            LIMIT ? OFFSET ?
            """,
            params + [limit, offset],
        ).fetchall()
        
        total = conn.execute(
            f"SELECT COUNT(*) as count FROM products {where_clause}",
            params,
        ).fetchone()
        
        return [
            {
                "id": int(row["id"]),
                "name": row["name"],
                "sku": row["sku"],
                "price": float(row["price_list_1"] or row["price"] or 0),
                "stock": int(row["stock"] or 0),
                "category_id": int(row["category_id"]) if row["category_id"] else None,
                "is_active": bool(row["is_active"]) if has_is_active else True,
                "is_featured": bool(row["is_featured"]),
                "is_offer": bool(row["is_offer"]),
                "image_path": row["image_path"],
            }
            for row in rows
        ]
    finally:
        conn.close()


@app.post("/admin/products")
def admin_create_product(
    request: Request,
    session_token: Optional[str] = Cookie(default=None),
    payload: dict = Body(...),
) -> dict:
    """Crea nuevo producto. Requiere sesión admin."""
    _require_admin(session_token)
    
    name = str(payload.get("name") or "").strip()
    sku = str(payload.get("sku") or "").strip()
    price = float(payload.get("price") or 0)
    stock = int(payload.get("stock") or 0)
    
    if not name:
        raise HTTPException(status_code=400, detail="Nombre requerido")
    if not sku:
        raise HTTPException(status_code=400, detail="SKU requerido")
    
    conn = _connect()
    try:
        conn.execute(
            """
            INSERT INTO products (name, sku, price, stock, is_active)
            VALUES (?, ?, ?, ?, 1)
            """,
            (name, sku, price, stock),
        )
        conn.commit()
        
        row = conn.execute("SELECT last_insert_rowid() as id").fetchone()
        product_id = int(row["id"] if isinstance(row, dict) else row[0])
        
        return {
            "id": product_id,
            "name": name,
            "sku": sku,
            "price": price,
            "stock": stock,
        }
    finally:
        conn.close()


@app.put("/admin/products/{product_id}")
def admin_update_product(
    product_id: int,
    request: Request,
    session_token: Optional[str] = Cookie(default=None),
    payload: dict = Body(...),
) -> dict:
    """Actualiza producto. Requiere sesión admin."""
    _require_admin(session_token)
    
    conn = _connect()
    try:
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
        if "stock" in payload:
            updates.append("stock = ?")
            params.append(int(payload["stock"]))
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
    session_token: Optional[str] = Cookie(default=None),
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
    session_token: Optional[str] = Cookie(default=None),
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


# ============================================================================
# ADMIN ENDPOINTS - ÓRDENES (mejoras)
# ============================================================================

@app.get("/admin/orders-with-items")
def admin_list_orders_detailed(
    request: Request,
    session_token: Optional[str] = Cookie(default=None),
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
    session_token: Optional[str] = Cookie(default=None),
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
    session_token: Optional[str] = Cookie(default=None),
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
    session_token: Optional[str] = Cookie(default=None),
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
    session_token: Optional[str] = Cookie(default=None),
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
    session_token: Optional[str] = Cookie(default=None),
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
    session_token: Optional[str] = Cookie(default=None),
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
    session_token: Optional[str] = Cookie(default=None),
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
    session_token: Optional[str] = Cookie(default=None),
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
    session_token: Optional[str] = Cookie(default=None),
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
    session_token: Optional[str] = Cookie(default=None),
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
