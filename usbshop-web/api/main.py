from __future__ import annotations

import base64
import hashlib
import hmac
import io
import json
import logging
import math
import mimetypes
import os
import re
import sqlite3
import ssl
import time
import smtplib
import threading
import unicodedata
from email.message import EmailMessage
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path
from typing import Optional, List, Any
from urllib.error import HTTPError
from urllib.parse import urlencode, quote
from urllib.request import Request as UrlRequest, urlopen
from zoneinfo import ZoneInfo

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
ROLE_ADMIN = "admin"
ROLE_STAFF = "staff"
ARGENTINA_TZ = ZoneInfo("America/Argentina/Buenos_Aires")
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


def _scalar_number(row: Any, key: str = "total") -> float:
    if row is None:
        return 0.0
    if isinstance(row, dict):
        return float(row.get(key) or 0)
    return float(row[0] or 0)


def _normalize_search_text(value: Any) -> str:
    text = str(value or "").strip().lower()
    if not text:
        return ""
    normalized = unicodedata.normalize("NFD", text)
    return "".join(char for char in normalized if unicodedata.category(char) != "Mn")


def _product_document_stock_effect(document_type: Any) -> int:
    normalized = str(document_type or "").strip().upper()
    if normalized in {"FACTURA", "FACTURA_C"}:
        return -1
    if normalized == "NOTA_CREDITO":
        return 1
    return 0


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
            "http://localhost:8080",
            "http://127.0.0.1:8080",
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
    return r"^https://([a-z0-9-]+\.)*usbshop\.com\.ar$|^http://(localhost|127\.0\.0\.1)(:\d+)?$|^http://192\.168\.\d{1,3}\.\d{1,3}(:\d+)?$|^http://10\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?$|^http://172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}(:\d+)?$"


_load_env_file()
DB_URL = (os.getenv("CONTROLSTOCK_DATABASE_URL") or os.getenv("DATABASE_URL") or "").strip()
DB_IS_POSTGRES = DB_URL.lower().startswith("postgres")
LOGGER = _setup_logging()
_TABLE_EXISTS_CACHE: dict[tuple[bool, str], bool] = {}
_COLUMN_EXISTS_CACHE: dict[tuple[bool, str, str], bool] = {}
_ADMIN_OVERVIEW_CACHE_TTL_SECONDS = max(5, int(os.getenv("USB_ADMIN_OVERVIEW_CACHE_TTL", "30") or "30"))
_ADMIN_OVERVIEW_CACHE_LOCK = threading.Lock()
_ADMIN_OVERVIEW_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}

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


def _session_cookie_options(request: Optional[Request]) -> dict[str, Any]:
    host = str((request.headers.get("host") if request else "") or "").lower()
    host_without_port = host.split(":", 1)[0]
    forwarded_proto = str((request.headers.get("x-forwarded-proto") if request else "") or "").lower()
    scheme = str((request.url.scheme if request else "") or "").lower()
    is_local_host = host_without_port.startswith("localhost") or host_without_port.startswith("127.0.0.1")
    secure = not is_local_host and (forwarded_proto == "https" or scheme == "https")
    domain = None
    if host_without_port == "api.usbshop.com.ar" or host_without_port.endswith(".usbshop.com.ar"):
        domain = "usbshop.com.ar"
    return {
        "secure": secure,
        "samesite": "none" if secure else "lax",
        "domain": domain,
        "path": "/",
    }


def _require_roles(session_token: Optional[str], allowed_roles: set[str]) -> dict:
    payload = _verify_session(session_token or "")
    if not payload or str(payload.get("role") or "").strip().lower() not in allowed_roles:
        raise HTTPException(status_code=401, detail="No autorizado")
    return payload


def _require_admin(session_token: Optional[str]) -> dict:
    return _require_roles(session_token, {ROLE_ADMIN, ROLE_STAFF})


def _require_full_admin(session_token: Optional[str]) -> dict:
    return _require_roles(session_token, {ROLE_ADMIN})


def _get_admin_cached_payload(key: str) -> Optional[dict[str, Any]]:
    now = time.time()
    with _ADMIN_OVERVIEW_CACHE_LOCK:
        cached = _ADMIN_OVERVIEW_CACHE.get(key)
        if not cached:
            return None
        expires_at, payload = cached
        if expires_at <= now:
            _ADMIN_OVERVIEW_CACHE.pop(key, None)
            return None
        return payload


def _set_admin_cached_payload(key: str, payload: dict[str, Any]) -> dict[str, Any]:
    with _ADMIN_OVERVIEW_CACHE_LOCK:
        _ADMIN_OVERVIEW_CACHE[key] = (time.time() + _ADMIN_OVERVIEW_CACHE_TTL_SECONDS, payload)
    return payload


def _get_admin_overview_cache(role: str) -> Optional[dict[str, Any]]:
    return _get_admin_cached_payload(f"overview:{role}")


def _set_admin_overview_cache(role: str, payload: dict[str, Any]) -> dict[str, Any]:
    return _set_admin_cached_payload(f"overview:{role}", payload)


def _get_admin_cc_overview_cache(role: str) -> Optional[dict[str, Any]]:
    return _get_admin_cached_payload(f"cc-overview:{role}")


def _set_admin_cc_overview_cache(role: str, payload: dict[str, Any]) -> dict[str, Any]:
    return _set_admin_cached_payload(f"cc-overview:{role}", payload)


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


def _ensure_bootstrap_user(conn: DBConn, username_env: str, password_env: str, role: str) -> None:
    username = (os.getenv(username_env) or "").strip()
    password = os.getenv(password_env) or ""
    if not username or not password:
        return
    username = _normalize_username(username)
    username_key = username.lower()
    password_hash = _hash_password(password)
    rows = conn.execute(
        "SELECT id, username FROM users WHERE LOWER(TRIM(username)) = ? ORDER BY id ASC",
        (username_key,),
    ).fetchall()
    row = rows[0] if rows else None
    if row is None:
        conn.execute(
            """
            INSERT INTO users (username, password_hash, role, active)
            VALUES (?, ?, ?, 1)
            """,
            (username, password_hash, role),
        )
    else:
        conn.execute(
            """
            UPDATE users
            SET password_hash = ?, role = ?, active = 1
            WHERE id = ?
            """,
            (password_hash, role, int(row["id"])),
        )
    conn.commit()


def _cleanup_duplicate_users(conn: DBConn) -> None:
    rows = conn.execute(
        """
        SELECT id, username
        FROM users
        ORDER BY LOWER(TRIM(username)) ASC, id ASC
        """
    ).fetchall()
    seen: set[str] = set()
    duplicate_ids: list[int] = []
    for row in rows:
        username_key = str(row["username"] or "").strip().lower()
        if not username_key:
            continue
        if username_key in seen:
            duplicate_ids.append(int(row["id"]))
            continue
        seen.add(username_key)
    if not duplicate_ids:
        return
    placeholders = ", ".join(["?"] * len(duplicate_ids))
    conn.execute(f"DELETE FROM users WHERE id IN ({placeholders})", tuple(duplicate_ids))
    conn.commit()


def _ensure_bootstrap_admin(conn: DBConn) -> None:
    _cleanup_duplicate_users(conn)
    _ensure_bootstrap_user(conn, "USB_ADMIN_USERNAME", "USB_ADMIN_PASSWORD", ROLE_ADMIN)
    _ensure_bootstrap_user(conn, "USB_STAFF_USERNAME", "USB_STAFF_PASSWORD", ROLE_STAFF)


def _normalize_user_role(value: Any) -> str:
    role = str(value or "").strip().lower()
    if role not in {ROLE_ADMIN, ROLE_STAFF}:
        raise HTTPException(status_code=400, detail="Rol invalido")
    return role


def _normalize_username(value: Any) -> str:
    username = str(value or "").strip()
    if not username:
        raise HTTPException(status_code=400, detail="El usuario es obligatorio")
    return username


def _normalize_password(value: Any, *, required: bool) -> Optional[str]:
    password = str(value or "")
    if not password.strip():
        if required:
            raise HTTPException(status_code=400, detail="La clave es obligatoria")
        return None
    return password


def _serialize_admin_user(row: Any) -> dict[str, Any]:
    return {
        "id": int(_row_get(row, "id") or 0),
        "username": str(_row_get(row, "username") or "").strip(),
        "role": str(_row_get(row, "role") or "").strip().lower(),
        "active": bool(int(_row_get(row, "active", 1) or 0)),
        "created_at": _row_get(row, "created_at"),
    }


def _pick_price(row: Any) -> float:
    price_list_1 = row["price_list_1"] or 0
    price = row["price"] or 0
    return float(price_list_1) if price_list_1 > 0 else float(price)


def _base_price(row: Any) -> float:
    return float(row["price"] or 0)


def _pick_price_by_list(row: Any, price_list: int) -> float:
    base_price = _base_price(row)
    if price_list == 1:
        price_list_1 = float(row["price_list_1"] or 0)
        return price_list_1 if price_list_1 > 0 else base_price
    if price_list == 2:
        price_list_2 = float(row["price_list_2"] or 0)
        return price_list_2 if price_list_2 > 0 else base_price
    return base_price


def _parse_optional_datetime(value: Any) -> Optional[datetime]:
    if not value:
        return None
    if isinstance(value, datetime):
        parsed = value
    else:
        raw = str(value).strip()
        if not raw:
            return None
        try:
            parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            try:
                parsed = datetime.strptime(raw[:19], "%Y-%m-%dT%H:%M:%S")
            except ValueError:
                return None
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
    return parsed


def _flash_offer_is_active(row: Any) -> bool:
    try:
        price = float(row["flash_offer_price"] or 0)
        ends_at = _parse_optional_datetime(row["flash_offer_ends_at"])
    except Exception:
        return False
    return price > 0 and ends_at is not None and ends_at > datetime.utcnow()


def _storefront_price(row: Any) -> float:
    if _flash_offer_is_active(row):
        return float(row["flash_offer_price"] or 0)
    return _pick_price(row)


def _flash_offer_payload(row: Any) -> Optional[dict[str, Any]]:
    if not _flash_offer_is_active(row):
        return None
    return {
        "price": float(row["flash_offer_price"] or 0),
        "endsAt": str(row["flash_offer_ends_at"]),
    }


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
    cache_key = (conn.is_postgres, table, column)
    cached = _COLUMN_EXISTS_CACHE.get(cache_key)
    if cached is not None:
        return cached
    if DB_IS_POSTGRES:
        row = conn.execute(
            "SELECT 1 FROM information_schema.columns WHERE table_name = ? AND column_name = ?",
            (table, column),
        ).fetchone()
        exists = row is not None
        _COLUMN_EXISTS_CACHE[cache_key] = exists
        return exists
    info = conn.execute(f"PRAGMA table_info({table})").fetchall()
    exists = any(row[1] == column for row in info)
    _COLUMN_EXISTS_CACHE[cache_key] = exists
    return exists


def _has_table(conn: DBConn, table: str) -> bool:
    cache_key = (conn.is_postgres, table)
    cached = _TABLE_EXISTS_CACHE.get(cache_key)
    if cached is not None:
        return cached
    if DB_IS_POSTGRES:
        row = conn.execute(
            "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ?",
            (table,),
        ).fetchone()
        exists = row is not None
        _TABLE_EXISTS_CACHE[cache_key] = exists
        return exists
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
        (table,),
    ).fetchone()
    exists = row is not None
    _TABLE_EXISTS_CACHE[cache_key] = exists
    return exists


def _invalidate_table_cache(table: str) -> None:
    for key in list(_TABLE_EXISTS_CACHE.keys()):
        if key[1] == table:
            _TABLE_EXISTS_CACHE.pop(key, None)
    for key in list(_COLUMN_EXISTS_CACHE.keys()):
        if key[1] == table:
            _COLUMN_EXISTS_CACHE.pop(key, None)


def _ensure_products_cost_column(conn: DBConn) -> None:
    if _has_column(conn, "products", "cost"):
        return
    if DB_IS_POSTGRES:
        conn.execute("ALTER TABLE products ADD COLUMN IF NOT EXISTS cost NUMERIC(12, 2) DEFAULT 0")
    else:
        conn.execute("ALTER TABLE products ADD COLUMN cost REAL DEFAULT 0")
    conn.commit()
    _invalidate_table_cache("products")


def _ensure_products_barcode_column(conn: DBConn) -> None:
    if _has_column(conn, "products", "barcode"):
        return
    if DB_IS_POSTGRES:
        conn.execute("ALTER TABLE products ADD COLUMN IF NOT EXISTS barcode TEXT")
    else:
        conn.execute("ALTER TABLE products ADD COLUMN barcode TEXT")
    conn.commit()
    _invalidate_table_cache("products")


def _ensure_products_highlight_new_arrivals_column(conn: DBConn) -> None:
    if _has_column(conn, "products", "highlight_new_arrivals"):
        return
    if DB_IS_POSTGRES:
        conn.execute(
            "ALTER TABLE products ADD COLUMN IF NOT EXISTS highlight_new_arrivals INTEGER DEFAULT 0"
        )
    else:
        conn.execute("ALTER TABLE products ADD COLUMN highlight_new_arrivals INTEGER DEFAULT 0")
    conn.commit()
    _invalidate_table_cache("products")


def _ensure_products_flash_offer_columns(conn: DBConn) -> None:
    changed = False
    if not _has_column(conn, "products", "flash_offer_price"):
        if DB_IS_POSTGRES:
            conn.execute("ALTER TABLE products ADD COLUMN IF NOT EXISTS flash_offer_price NUMERIC(12, 2) DEFAULT 0")
        else:
            conn.execute("ALTER TABLE products ADD COLUMN flash_offer_price REAL DEFAULT 0")
        changed = True
    if not _has_column(conn, "products", "flash_offer_ends_at"):
        if DB_IS_POSTGRES:
            conn.execute("ALTER TABLE products ADD COLUMN IF NOT EXISTS flash_offer_ends_at TIMESTAMP")
        else:
            conn.execute("ALTER TABLE products ADD COLUMN flash_offer_ends_at TEXT")
        changed = True
    if changed:
        conn.commit()
        _invalidate_table_cache("products")


def _ensure_invoice_payment_method_column(conn: DBConn) -> None:
    if _has_column(conn, "invoices", "payment_method"):
        return
    conn.execute("ALTER TABLE invoices ADD COLUMN payment_method TEXT")
    conn.commit()
    _invalidate_table_cache("invoices")


def _ensure_invoice_special_discount_column(conn: DBConn) -> None:
    if _has_column(conn, "invoices", "special_discount"):
        return
    conn.execute("ALTER TABLE invoices ADD COLUMN special_discount REAL NOT NULL DEFAULT 0")
    conn.commit()
    _invalidate_table_cache("invoices")


def _ensure_invoice_items_cost_snapshot_column(conn: DBConn) -> None:
    if _has_column(conn, "invoice_items", "cost_snapshot"):
        return
    if DB_IS_POSTGRES:
        conn.execute("ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS cost_snapshot NUMERIC(12, 2)")
    else:
        conn.execute("ALTER TABLE invoice_items ADD COLUMN cost_snapshot REAL")
    conn.commit()
    _invalidate_table_cache("invoice_items")


def _normalize_category_label(value: str) -> str:
    return _normalize_search_text(value or "")


def _is_celulares_category_name(value: str) -> bool:
    return _normalize_category_label(value) == "celulares"


def _normalize_imei_value(value: Any) -> str:
    digits = "".join(char for char in str(value or "") if char.isdigit())
    return digits.strip()


def _normalize_imei_list(values: Any) -> list[str]:
    if isinstance(values, str):
        raw_values = re.split(r"[\s,;]+", values)
    elif isinstance(values, (list, tuple, set)):
        raw_values = list(values)
    else:
        raw_values = []
    normalized: list[str] = []
    seen: set[str] = set()
    for raw in raw_values:
        imei = _normalize_imei_value(raw)
        if not imei or imei in seen:
            continue
        seen.add(imei)
        normalized.append(imei)
    return normalized


def _ensure_product_imeis_table(conn: DBConn) -> None:
    if DB_IS_POSTGRES:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS product_imeis (
                id SERIAL PRIMARY KEY,
                product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
                imei TEXT NOT NULL UNIQUE,
                sold_invoice_id INTEGER,
                sold_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_product_imeis_product_id ON product_imeis(product_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_product_imeis_sold_invoice_id ON product_imeis(sold_invoice_id)")
    else:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS product_imeis (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                product_id INTEGER NOT NULL,
                imei TEXT NOT NULL UNIQUE,
                sold_invoice_id INTEGER,
                sold_at DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_product_imeis_product_id ON product_imeis(product_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_product_imeis_sold_invoice_id ON product_imeis(sold_invoice_id)")
    conn.commit()
    _invalidate_table_cache("product_imeis")


def _fetch_product_imeis(
    conn: DBConn,
    product_ids: list[int],
    *,
    only_available: bool = False,
) -> dict[int, list[str]]:
    if not product_ids:
        return {}
    _ensure_product_imeis_table(conn)
    placeholders = ", ".join(["?"] * len(product_ids))
    filters = [f"product_id IN ({placeholders})"]
    params: list[Any] = list(product_ids)
    if only_available:
        filters.append("sold_invoice_id IS NULL")
    rows = conn.execute(
        f"""
        SELECT product_id, imei
        FROM product_imeis
        WHERE {' AND '.join(filters)}
        ORDER BY product_id ASC, imei ASC
        """,
        params,
    ).fetchall()
    imeis_by_product: dict[int, list[str]] = {product_id: [] for product_id in product_ids}
    for row in rows:
        product_id = int(row["product_id"] or 0)
        imei = str(row["imei"] or "").strip()
        if product_id <= 0 or not imei:
            continue
        imeis_by_product.setdefault(product_id, []).append(imei)
    return imeis_by_product


def _replace_product_imeis(conn: DBConn, product_id: int, imeis: list[str]) -> None:
    _ensure_product_imeis_table(conn)
    normalized_imeis = _normalize_imei_list(imeis)
    if not normalized_imeis:
        existing_rows = conn.execute(
            "SELECT id, sold_invoice_id FROM product_imeis WHERE product_id = ?",
            (product_id,),
        ).fetchall()
        removable_ids = [
            int(row["id"] if isinstance(row, dict) else row[0])
            for row in existing_rows
            if not (row["sold_invoice_id"] if isinstance(row, dict) else row[1])
        ]
        for imei_id in removable_ids:
            conn.execute("DELETE FROM product_imeis WHERE id = ?", (imei_id,))
        return

    duplicated = conn.execute(
        f"""
        SELECT imei, product_id
        FROM product_imeis
        WHERE imei IN ({", ".join(["?"] * len(normalized_imeis))})
          AND product_id <> ?
        """,
        [*normalized_imeis, product_id],
    ).fetchall()
    if duplicated:
        duplicated_imei = str(duplicated[0]["imei"] if isinstance(duplicated[0], dict) else duplicated[0][0])
        raise HTTPException(status_code=400, detail=f"El IMEI {duplicated_imei} ya pertenece a otro producto")

    existing_rows = conn.execute(
        "SELECT id, imei, sold_invoice_id FROM product_imeis WHERE product_id = ?",
        (product_id,),
    ).fetchall()
    existing_by_imei = {
        str(row["imei"] if isinstance(row, dict) else row[1]): row for row in existing_rows
    }

    for imei in normalized_imeis:
        if imei in existing_by_imei:
            continue
        conn.execute(
            "INSERT INTO product_imeis (product_id, imei) VALUES (?, ?)",
            (product_id, imei),
        )

    for row in existing_rows:
        current_imei = str(row["imei"] if isinstance(row, dict) else row[1])
        sold_invoice_id = row["sold_invoice_id"] if isinstance(row, dict) else row[2]
        imei_id = int(row["id"] if isinstance(row, dict) else row[0])
        if current_imei in normalized_imeis:
            continue
        if sold_invoice_id:
            continue
        conn.execute("DELETE FROM product_imeis WHERE id = ?", (imei_id,))


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
        _invalidate_table_cache("web_orders")
        _invalidate_table_cache("web_order_items")
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
    _invalidate_table_cache("web_orders")
    _invalidate_table_cache("web_order_items")


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
        _invalidate_table_cache("product_images")
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
    _invalidate_table_cache("product_images")


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
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                deleted_at TIMESTAMP DEFAULT NULL
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
                invoice_id INTEGER,
                reference TEXT,
                entry_kind TEXT,
                payment_method TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                deleted_at TIMESTAMP DEFAULT NULL,
                is_deleted INTEGER DEFAULT 0
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
            """
            CREATE TABLE IF NOT EXISTS account_movements_audit (
                id SERIAL PRIMARY KEY,
                movement_id INTEGER NOT NULL,
                customer_id INTEGER NOT NULL REFERENCES account_customers(id),
                action TEXT NOT NULL,
                old_values TEXT,
                new_values TEXT,
                edited_by TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS account_movements_backup (
                id SERIAL PRIMARY KEY,
                original_movement_id INTEGER,
                customer_id INTEGER NOT NULL REFERENCES account_customers(id),
                movement_type TEXT NOT NULL,
                amount NUMERIC(12, 2) NOT NULL,
                description TEXT,
                document_type TEXT,
                document_number TEXT,
                due_date DATE,
                invoice_id INTEGER,
                reference TEXT,
                entry_kind TEXT,
                payment_method TEXT,
                created_at TIMESTAMP,
                deleted_at TIMESTAMP,
                backup_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS account_customers_audit (
                id SERIAL PRIMARY KEY,
                customer_id INTEGER NOT NULL REFERENCES account_customers(id),
                action TEXT NOT NULL,
                old_balance NUMERIC(12, 2),
                new_balance NUMERIC(12, 2),
                description TEXT,
                edited_by TEXT,
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
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_audit_movement_id ON account_movements_audit(movement_id)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_audit_customer_id ON account_movements_audit(customer_id)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_backup_customer_id ON account_movements_backup(customer_id)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_customer_audit ON account_customers_audit(customer_id)"
        )
        required_columns = {
            "account_customers": (
                ("tax_id", "TEXT"),
                ("tax_condition", "TEXT"),
                ("address", "TEXT"),
                ("city", "TEXT"),
                ("notes", "TEXT"),
                ("created_at", "TIMESTAMP"),
                ("updated_at", "TIMESTAMP"),
                ("deleted_at", "TIMESTAMP DEFAULT NULL"),
            ),
            "account_movements": (
                ("invoice_id", "INTEGER"),
                ("reference", "TEXT"),
                ("entry_kind", "TEXT"),
                ("payment_method", "TEXT"),
                ("created_at", "TIMESTAMP"),
                ("deleted_at", "TIMESTAMP DEFAULT NULL"),
                ("is_deleted", "INTEGER DEFAULT 0"),
            ),
            "account_movements_audit": (
                ("edited_by", "TEXT"),
                ("created_at", "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"),
            ),
            "account_movements_backup": (
                ("invoice_id", "INTEGER"),
                ("reference", "TEXT"),
                ("entry_kind", "TEXT"),
                ("payment_method", "TEXT"),
                ("created_at", "TIMESTAMP"),
                ("deleted_at", "TIMESTAMP"),
                ("backup_date", "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"),
            ),
            "account_customers_audit": (
                ("old_balance", "NUMERIC(12, 2)"),
                ("new_balance", "NUMERIC(12, 2)"),
                ("description", "TEXT"),
                ("edited_by", "TEXT"),
                ("created_at", "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"),
            ),
        }
        for table_name, columns in required_columns.items():
            for column_name, column_type in columns:
                if _has_column(conn, table_name, column_name):
                    continue
                conn.execute(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {column_type}")
            _invalidate_table_cache(table_name)
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
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            deleted_at DATETIME DEFAULT NULL
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
            invoice_id INTEGER,
            reference TEXT,
            entry_kind TEXT,
            payment_method TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            deleted_at DATETIME DEFAULT NULL,
            is_deleted INTEGER DEFAULT 0,
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
        """
        CREATE TABLE IF NOT EXISTS account_movements_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            movement_id INTEGER NOT NULL,
            customer_id INTEGER NOT NULL,
            action TEXT NOT NULL CHECK (action IN ('CREATE', 'UPDATE', 'DELETE', 'RESTORE')),
            old_values TEXT,
            new_values TEXT,
            edited_by TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (customer_id) REFERENCES account_customers(id)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS account_movements_backup (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            original_movement_id INTEGER,
            customer_id INTEGER NOT NULL,
            movement_type TEXT NOT NULL,
            amount REAL NOT NULL,
            description TEXT,
            document_type TEXT,
            document_number TEXT,
            due_date TEXT,
            invoice_id INTEGER,
            reference TEXT,
            entry_kind TEXT,
            payment_method TEXT,
            created_at DATETIME,
            deleted_at DATETIME,
            backup_date DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (customer_id) REFERENCES account_customers(id)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS account_customers_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer_id INTEGER NOT NULL,
            action TEXT NOT NULL,
            old_balance REAL,
            new_balance REAL,
            description TEXT,
            edited_by TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (customer_id) REFERENCES account_customers(id)
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_account_movements_customer_id ON account_movements(customer_id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_account_documents_customer_id ON account_documents(customer_id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_audit_movement_id ON account_movements_audit(movement_id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_audit_customer_id ON account_movements_audit(customer_id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_backup_customer_id ON account_movements_backup(customer_id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_customer_audit ON account_customers_audit(customer_id)"
    )
    required_columns = {
        "account_customers": (
            ("tax_id", "TEXT"),
            ("tax_condition", "TEXT"),
            ("address", "TEXT"),
            ("city", "TEXT"),
            ("notes", "TEXT"),
            ("created_at", "DATETIME"),
            ("updated_at", "DATETIME"),
            ("deleted_at", "DATETIME DEFAULT NULL"),
        ),
        "account_movements": (
            ("invoice_id", "INTEGER"),
            ("reference", "TEXT"),
            ("entry_kind", "TEXT"),
            ("payment_method", "TEXT"),
            ("created_at", "DATETIME"),
            ("deleted_at", "DATETIME DEFAULT NULL"),
            ("is_deleted", "INTEGER DEFAULT 0"),
        ),
        "account_movements_audit": (
            ("edited_by", "TEXT"),
            ("created_at", "DATETIME DEFAULT CURRENT_TIMESTAMP"),
        ),
        "account_movements_backup": (
            ("invoice_id", "INTEGER"),
            ("reference", "TEXT"),
            ("entry_kind", "TEXT"),
            ("payment_method", "TEXT"),
            ("created_at", "DATETIME"),
            ("deleted_at", "DATETIME"),
            ("backup_date", "DATETIME DEFAULT CURRENT_TIMESTAMP"),
        ),
        "account_customers_audit": (
            ("old_balance", "REAL"),
            ("new_balance", "REAL"),
            ("description", "TEXT"),
            ("edited_by", "TEXT"),
            ("created_at", "DATETIME DEFAULT CURRENT_TIMESTAMP"),
        ),
    }
    for table_name, columns in required_columns.items():
        for column_name, column_type in columns:
            if _has_column(conn, table_name, column_name):
                continue
            conn.execute(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {column_type}")
        _invalidate_table_cache(table_name)
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
        """
        + _active_account_movements_clause(conn)
        ,
        (customer_id,),
    ).fetchall()
    balance = 0.0
    for row in rows:
        movement_type = str(row["movement_type"] if isinstance(row, dict) else row[0]).upper()
        amount = float(row["amount"] if isinstance(row, dict) else row[1] or 0)
        balance += amount if movement_type == "DEBIT" else -amount
    return round(balance, 2)


def _balance_is_zero(balance: float, tolerance: float = 0.009) -> bool:
    return abs(float(balance)) <= tolerance


def _safe_finite_float(value: Any, default: float = 0.0) -> float:
    try:
        parsed = float(value or 0)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(parsed):
        return default
    return parsed


def _safe_text(value: Any) -> Optional[str]:
    if value is None:
        return None
    try:
        text = str(value)
    except Exception:
        return None
    if not text:
        return text
    return text.encode("utf-8", errors="replace").decode("utf-8", errors="replace")


def _can_view_profit_metrics(role: Any) -> bool:
    return str(role or "").strip().lower() != ROLE_STAFF


def _line_margin_value(quantity: float, unit_price: float, cost: float) -> float:
    return float(quantity or 0) * max(0.0, float(unit_price or 0) - float(cost or 0))


def _log_movement_audit(
    conn: DBConn,
    movement_id: int,
    customer_id: int,
    action: str,
    old_values: Optional[dict] = None,
    new_values: Optional[dict] = None,
    edited_by: str = "SYSTEM"
) -> None:
    """Registrar auditoría de cambios en movimientos"""
    conn.execute(
        """
        INSERT INTO account_movements_audit
        (movement_id, customer_id, action, old_values, new_values, edited_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        """,
        (
            movement_id,
            customer_id,
            action,
            json.dumps(old_values, default=str) if old_values else None,
            json.dumps(new_values, default=str) if new_values else None,
            edited_by,
        ),
    )


def _can_use_accounting_audit(conn: DBConn, customer_id: int) -> bool:
    if not _has_table(conn, "account_customers"):
        return False
    row = conn.execute(
        "SELECT id FROM account_customers WHERE id = ?",
        (customer_id,),
    ).fetchone()
    return row is not None


def _soft_delete_movement(
    conn: DBConn,
    movement_id: int,
    customer_id: int,
    edited_by: str = "SYSTEM"
) -> bool:
    """Hacer soft delete de un movimiento (marcarlo como eliminado, sin borrar datos)"""
    # Obtener datos del movimiento
    movement = conn.execute(
        "SELECT * FROM account_movements WHERE id = ? AND customer_id = ?",
        (movement_id, customer_id),
    ).fetchone()
    
    if movement is None:
        return False

    can_audit = _can_use_accounting_audit(conn, customer_id)
    
    # Guardar en backup
    mov_dict = dict(movement) if hasattr(movement, 'keys') else {}
    if not mov_dict:
        cursor = conn.execute(
            "PRAGMA table_info(account_movements)"
        )
        cols = [row[1] for row in cursor.fetchall()]
        mov_dict = {col: movement[i] for i, col in enumerate(cols)}
    
    if can_audit and _has_table(conn, "account_movements_backup"):
        conn.execute(
            """
            INSERT INTO account_movements_backup
            (original_movement_id, customer_id, movement_type, amount, description, 
             document_type, document_number, due_date, invoice_id, reference, entry_kind,
             payment_method, created_at, deleted_at)
            SELECT id, customer_id, movement_type, amount, description,
                   document_type, document_number, due_date, invoice_id, reference, entry_kind,
                   payment_method, created_at, CURRENT_TIMESTAMP
            FROM account_movements
            WHERE id = ? AND customer_id = ?
            """,
            (movement_id, customer_id),
        )
    
    # Marcar como eliminado (soft delete)
    conn.execute(
        """
        UPDATE account_movements
        SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP
        WHERE id = ? AND customer_id = ?
        """,
        (movement_id, customer_id),
    )
    
    # Registrar auditoría
    if can_audit and _has_table(conn, "account_movements_audit"):
        _log_movement_audit(
            conn,
            movement_id,
            customer_id,
            "DELETE",
            old_values=mov_dict,
            edited_by=edited_by,
        )
    
    return True


def _restore_movement(
    conn: DBConn,
    movement_id: int,
    customer_id: int,
    edited_by: str = "SYSTEM"
) -> bool:
    """Restaurar un movimiento eliminado"""
    # Verificar que existe en backup
    backup = conn.execute(
        "SELECT * FROM account_movements_backup WHERE original_movement_id = ? AND customer_id = ? ORDER BY backup_date DESC LIMIT 1",
        (movement_id, customer_id),
    ).fetchone()
    
    if backup is None:
        return False
    
    # Restaurar
    conn.execute(
        """
        UPDATE account_movements
        SET is_deleted = 0, deleted_at = NULL
        WHERE id = ? AND customer_id = ?
        """,
        (movement_id, customer_id),
    )
    
    # Registrar auditoría
    _log_movement_audit(
        conn,
        movement_id,
        customer_id,
        "RESTORE",
        edited_by=edited_by,
    )
    
    return True


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


def _argentina_now() -> datetime:
    return datetime.now(ARGENTINA_TZ)


def _is_date_only_value(value: Any) -> bool:
    return isinstance(value, str) and bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}", value.strip()))


def _argentina_date_for_filter(value: Any) -> Optional[datetime.date]:
    parsed = _safe_parse_datetime(value)
    if parsed is None:
        return None
    if _is_date_only_value(value):
        return parsed.date()
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc).astimezone(ARGENTINA_TZ).date()
    return parsed.astimezone(ARGENTINA_TZ).date()


def _argentina_datetime(value: Any) -> Optional[datetime]:
    parsed = _safe_parse_datetime(value)
    if parsed is None:
        return None
    if _is_date_only_value(value):
        return parsed
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc).astimezone(ARGENTINA_TZ)
    return parsed.astimezone(ARGENTINA_TZ)


def _argentina_month_bucket(value: Any) -> Optional[str]:
    parsed = _argentina_datetime(value)
    if parsed is None:
        return None
    return parsed.strftime("%Y-%m")


def _matches_argentina_date_range(value: Any, start_date: Optional[str], end_date: Optional[str]) -> bool:
    created_date = _argentina_date_for_filter(value)
    if created_date is None:
        return False
    if start_date:
        try:
            if created_date < datetime.strptime(start_date, "%Y-%m-%d").date():
                return False
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Fecha inicial invalida. Usa YYYY-MM-DD.") from exc
    if end_date:
        try:
            if created_date > datetime.strptime(end_date, "%Y-%m-%d").date():
                return False
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Fecha final invalida. Usa YYYY-MM-DD.") from exc
    return True


def _customer_current_balance_from_rows(rows: list[Any]) -> float:
    balance = 0.0
    for row in rows:
        movement_type = str(row["movement_type"] if isinstance(row, dict) else row[0]).upper()
        amount = float(row["amount"] if isinstance(row, dict) else row[1] or 0)
        balance += amount if movement_type == "DEBIT" else -amount
    return round(balance, 2)


def _row_get(row: Any, key: str, default: Any = None) -> Any:
    if isinstance(row, dict):
        return row.get(key, default)
    try:
        return row[key]
    except Exception:
        return default


def _movement_entry_kind(row: Any) -> str:
    raw_kind = str(_row_get(row, "entry_kind") or "").strip().upper()
    if raw_kind in {"SALE", "PAYMENT", "CREDIT_NOTE", "ADJUSTMENT", "OPENING_BALANCE", "WRITEOFF"}:
        return raw_kind
    movement_type = str(_row_get(row, "movement_type") or "").strip().upper()
    invoice_id = _row_get(row, "invoice_id")
    reference = str(_row_get(row, "reference") or _row_get(row, "description") or "").strip().lower()
    document_type = str(_row_get(row, "document_type") or "").strip().upper()
    payment_method = str(_row_get(row, "payment_method") or "").strip().lower()
    if movement_type == "DEBIT":
        if invoice_id not in (None, "", 0, "0"):
            return "SALE"
        if any(token in reference for token in ("saldo inicial", "saldo previo", "deuda previa", "historica")):
            return "OPENING_BALANCE"
        return "ADJUSTMENT"
    if document_type == "NOTA_CREDITO" or "nota de credito" in reference or "nota credito" in reference:
        return "CREDIT_NOTE"
    if any(token in reference for token in ("incobrable", "castigo", "writeoff")):
        return "WRITEOFF"
    if "ajuste" in reference or "ajuste" in payment_method:
        return "ADJUSTMENT"
    return "PAYMENT"


def _movement_entry_label(entry_kind: str) -> str:
    return {
        "SALE": "Venta",
        "PAYMENT": "Cobranza",
        "CREDIT_NOTE": "Nota de credito",
        "ADJUSTMENT": "Ajuste",
        "OPENING_BALANCE": "Saldo inicial",
        "WRITEOFF": "Incobrable",
    }.get(entry_kind, "Movimiento")


def _normalize_cc_entry_kind(movement_type: str, raw_entry_kind: Any) -> tuple[str, set[str]]:
    entry_kind = str(raw_entry_kind or "").strip().upper()
    if movement_type == "DEBIT":
        allowed_entry_kinds = {"ADJUSTMENT", "OPENING_BALANCE"}
        if not entry_kind:
            entry_kind = "ADJUSTMENT"
    else:
        allowed_entry_kinds = {"PAYMENT", "CREDIT_NOTE", "WRITEOFF", "ADJUSTMENT"}
        if not entry_kind:
            entry_kind = "PAYMENT"
    return entry_kind, allowed_entry_kinds


def _aging_from_movements(rows: list[Any], terms_days: int = 30) -> dict[str, Any]:
    debits: list[dict[str, Any]] = []
    credits: list[dict[str, Any]] = []
    for row in rows:
        movement_type = str(row["movement_type"] if isinstance(row, dict) else row["movement_type"]).upper()
        amount = _safe_finite_float(row["amount"] if isinstance(row, dict) else row["amount"])
        if amount <= 0:
            continue
        created_at = _safe_parse_datetime(row["created_at"] if isinstance(row, dict) else row["created_at"])
        due_at_raw = _row_get(row, "due_date")
        due_at = _safe_parse_datetime(due_at_raw) if due_at_raw else None
        entry_kind = _movement_entry_kind(row)
        payload = {
            "id": int(row["id"] if isinstance(row, dict) else row["id"]),
            "amount": amount,
            "remaining": amount,
            "applied": 0.0,
            "created_at": created_at,
            "due_date": due_at or ((_argentina_datetime(row["created_at"] if isinstance(row, dict) else row["created_at"]) or _argentina_now()) + timedelta(days=terms_days)),
            "reference": row["reference"] if isinstance(row, dict) else row["reference"],
            "invoice_id": row["invoice_id"] if isinstance(row, dict) else row["invoice_id"],
            "entry_kind": entry_kind,
        }
        if movement_type == "DEBIT":
            debits.append(payload)
        else:
            credits.append({**payload, "entry_kind": entry_kind})

    debits.sort(key=lambda item: (item["due_date"] or _argentina_now(), item["id"]))
    for credit in credits:
        remaining_credit = _safe_finite_float(credit["amount"])
        for debit in debits:
            if remaining_credit <= 0:
                break
            available = _safe_finite_float(debit["remaining"])
            if available <= 0:
                continue
            consumed = min(available, remaining_credit)
            debit["remaining"] = round(available - consumed, 2)
            debit["applied"] = round(float(debit["applied"] or 0) + consumed, 2)
            remaining_credit = round(remaining_credit - consumed, 2)

    today = _argentina_now().date()
    buckets = {"current": 0.0, "d1_30": 0.0, "d31_60": 0.0, "d61_90": 0.0, "d90_plus": 0.0}
    classification = {
        "pending": 0.0,
        "overdue": 0.0,
        "collected": 0.0,
        "payments": 0.0,
        "credit_notes": 0.0,
        "writeoffs": 0.0,
        "adjustments": 0.0,
        "opening_balance": 0.0,
    }
    open_items: list[dict[str, Any]] = []
    for debit in debits:
        if debit["entry_kind"] == "OPENING_BALANCE":
            classification["opening_balance"] += _safe_finite_float(debit["amount"])
        elif debit["entry_kind"] == "ADJUSTMENT":
            classification["adjustments"] += _safe_finite_float(debit["amount"])
        remaining = _safe_finite_float(debit["remaining"])
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
        classification["pending"] += remaining
        if overdue_days > 0:
            classification["overdue"] += remaining
        open_items.append(
            {
                "id": debit["id"],
                "invoice_id": debit["invoice_id"],
                "reference": debit["reference"],
                "remaining": round(remaining, 2),
                "due_date": due_date.isoformat(),
                "bucket": bucket,
                "entry_kind": debit["entry_kind"],
                "entry_label": _movement_entry_label(debit["entry_kind"]),
                "status_label": "Vencido" if overdue_days > 0 else "Pendiente",
            }
        )
    for credit in credits:
        if credit["entry_kind"] == "PAYMENT":
            classification["payments"] += _safe_finite_float(credit["amount"])
            classification["collected"] += _safe_finite_float(credit["amount"])
        elif credit["entry_kind"] == "CREDIT_NOTE":
            classification["credit_notes"] += _safe_finite_float(credit["amount"])
        elif credit["entry_kind"] == "WRITEOFF":
            classification["writeoffs"] += _safe_finite_float(credit["amount"])
        elif credit["entry_kind"] == "ADJUSTMENT":
            classification["adjustments"] -= _safe_finite_float(credit["amount"])
    return {
        **{key: round(value, 2) for key, value in buckets.items()},
        "classification": {key: round(value, 2) for key, value in classification.items()},
        "open_items": open_items,
        "total": round(sum(buckets.values()), 2),
    }


MAX_PRODUCT_IMAGES = 3


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
    return normalized[:MAX_PRODUCT_IMAGES]


def _build_product_image_fields(
    primary_image: Optional[str],
    extra_images: Optional[list[str]],
    product_id: Optional[int] = None,
) -> dict[str, Any]:
    merged: list[str] = []
    seen: set[str] = set()

    def add_candidate(raw_value: Optional[str]) -> None:
        raw = str(raw_value or "").strip()
        if not raw:
            return
        normalized = _public_image_url(raw, product_id) if _as_existing_local_image_path(raw) is not None else raw
        if not normalized or normalized in seen:
            return
        seen.add(normalized)
        merged.append(normalized)

    add_candidate(primary_image)
    for image_value in extra_images or []:
        add_candidate(image_value)
        if len(merged) >= MAX_PRODUCT_IMAGES:
            break

    return {
        "imageUrl": merged[0] if merged else None,
        "imageUrls": merged,
    }


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
    secondary_images = image_values[1:MAX_PRODUCT_IMAGES]
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
        ("seller_id", "INTEGER", "INTEGER"),
        ("zone", "TEXT", "TEXT"),
        ("is_active", "INTEGER", "INTEGER"),
        ("deleted_at", "TEXT", "TIMESTAMP"),
    ],
    "invoices": [
        ("id", "INTEGER PRIMARY KEY", "INTEGER PRIMARY KEY"),
        ("customer_id", "INTEGER", "INTEGER"),
        ("total", "REAL", "NUMERIC(12, 2)"),
        ("special_discount", "REAL", "NUMERIC(12, 2)"),
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
        ("entry_kind", "TEXT", "TEXT"),
        ("reference", "TEXT", "TEXT"),
        ("created_at", "TEXT", "TIMESTAMP"),
        ("payment_method", "TEXT", "TEXT"),
    ],
    "annual_balances": [
        ("year", "INTEGER PRIMARY KEY", "INTEGER PRIMARY KEY"),
        ("total_sales", "REAL", "NUMERIC(12, 2)"),
        ("capital_ars", "REAL", "NUMERIC(12, 2)"),
        ("exchange_rate", "REAL", "NUMERIC(12, 2)"),
        ("capital_usd", "REAL", "NUMERIC(12, 2)"),
        ("notes", "TEXT", "TEXT"),
        ("created_at", "TEXT", "TIMESTAMP"),
        ("updated_at", "TEXT", "TIMESTAMP"),
        ("january_sales", "REAL", "NUMERIC(12, 2)"),
        ("february_sales", "REAL", "NUMERIC(12, 2)"),
        ("march_sales", "REAL", "NUMERIC(12, 2)"),
        ("april_sales", "REAL", "NUMERIC(12, 2)"),
        ("may_sales", "REAL", "NUMERIC(12, 2)"),
        ("june_sales", "REAL", "NUMERIC(12, 2)"),
        ("july_sales", "REAL", "NUMERIC(12, 2)"),
        ("august_sales", "REAL", "NUMERIC(12, 2)"),
        ("september_sales", "REAL", "NUMERIC(12, 2)"),
        ("october_sales", "REAL", "NUMERIC(12, 2)"),
        ("november_sales", "REAL", "NUMERIC(12, 2)"),
        ("december_sales", "REAL", "NUMERIC(12, 2)"),
        ("total_profit", "REAL", "NUMERIC(12, 2)"),
        ("cash_closure", "REAL", "NUMERIC(12, 2)"),
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


def _active_account_movements_clause(conn: DBConn, alias: str = "account_movements") -> str:
    clauses: list[str] = []
    if _has_column(conn, "account_movements", "is_deleted"):
        clauses.append(f"COALESCE({alias}.is_deleted, 0) = 0")
    if _has_column(conn, "account_movements", "deleted_at"):
        clauses.append(f"{alias}.deleted_at IS NULL")
    if not clauses:
        return ""
    return " AND " + " AND ".join(clauses)


def _customer_select_fields(conn: DBConn, alias: str = "") -> str:
    prefix = f"{alias}." if alias else ""
    fields: list[str] = [
        f"{prefix}id",
        f"{prefix}name",
        f"{prefix}email",
        f"{prefix}phone",
    ]
    optional_fields = [
        "created_at",
        "is_active",
        "sale_mode",
        "locality",
        "address",
        "tax_condition",
        "cuit",
        "external_ref",
        "seller_id",
        "zone",
    ]
    for field_name in optional_fields:
        if _has_column(conn, "customers", field_name):
            fields.append(f"{prefix}{field_name}")
        else:
            fields.append(f"NULL AS {field_name}")
    return ", ".join(fields)


def _invoice_select_fields(conn: DBConn, alias: str = "") -> str:
    prefix = f"{alias}." if alias else ""
    fields: list[str] = [f"{prefix}id"]
    optional_fields = [
        "customer_id",
        "total",
        "created_at",
        "document_type",
        "sale_mode",
        "price_list",
        "due_date",
        "notes",
        "payment_method",
        "seller_id",
        "commission_amount",
        "special_discount",
    ]
    for field_name in optional_fields:
        if _has_column(conn, "invoices", field_name):
            fields.append(f"{prefix}{field_name}")
        else:
            fields.append(f"NULL AS {field_name}")
    return ", ".join(fields)


def _ensure_sellers_table(conn: DBConn) -> None:
    if not _has_table(conn, "sellers"):
        if DB_IS_POSTGRES:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS sellers (
                    id SERIAL PRIMARY KEY,
                    name TEXT NOT NULL,
                    commission_percent NUMERIC(6, 2) NOT NULL DEFAULT 0,
                    is_active INTEGER NOT NULL DEFAULT 1,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
        else:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS sellers (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    commission_percent REAL NOT NULL DEFAULT 0,
                    is_active INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
        _invalidate_table_cache("sellers")
    required_columns = (
        ("name", "TEXT", "TEXT"),
        ("commission_percent", "REAL NOT NULL DEFAULT 0", "NUMERIC(6, 2) NOT NULL DEFAULT 0"),
        ("is_active", "INTEGER NOT NULL DEFAULT 1", "INTEGER NOT NULL DEFAULT 1"),
        ("created_at", "TEXT", "TIMESTAMP"),
        ("updated_at", "TEXT", "TIMESTAMP"),
    )
    for name, sqlite_type, pg_type in required_columns:
        if _has_column(conn, "sellers", name):
            continue
        conn.execute(f"ALTER TABLE sellers ADD COLUMN {name} {pg_type if DB_IS_POSTGRES else sqlite_type}")
    conn.commit()


def _upsert_sync_rows(conn: DBConn, table_name: str, rows: list[dict]) -> int:
    columns = [name for name, _, _ in SYNC_TABLE_SCHEMAS[table_name]]
    primary_key = columns[0]
    placeholders = ", ".join(["?"] * len(columns))
    update_columns = [name for name in columns if name != primary_key]
    updates = ", ".join(
        f"{name} = {'EXCLUDED' if DB_IS_POSTGRES else 'excluded'}.{name}"
        for name in update_columns
    )
    sql = (
        f"INSERT INTO {table_name} ({', '.join(columns)}) VALUES ({placeholders}) "
        f"ON CONFLICT({primary_key}) DO UPDATE SET {updates}"
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
    columns = [name for name, _, _ in SYNC_TABLE_SCHEMAS[table_name]]
    primary_key = columns[0]
    if primary_key != "id":
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
    unit_price: Optional[float] = None


class OrderPayload(BaseModel):
    items: List[CartItemPayload]
    customer_name: Optional[str] = None
    customer_phone: Optional[str] = None
    customer_email: Optional[str] = None
    notes: Optional[str] = None


class OrderStatusPayload(BaseModel):
    status: str
    confirmed_invoice_id: Optional[int] = None


class SellerPayload(BaseModel):
    name: str
    commission_percent: float = 0
    is_active: bool = True


class InvoiceSellerAssignmentPayload(BaseModel):
    seller_id: int = Field(..., ge=1)


class AdminUserCreatePayload(BaseModel):
    username: str = Field(min_length=1, max_length=120)
    password: str = Field(min_length=1, max_length=240)
    role: str = Field(min_length=1, max_length=32)
    active: bool = True


class AdminUserUpdatePayload(BaseModel):
    username: Optional[str] = Field(default=None, min_length=1, max_length=120)
    password: Optional[str] = Field(default=None, min_length=1, max_length=240)
    role: Optional[str] = Field(default=None, min_length=1, max_length=32)
    active: Optional[bool] = None


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
def list_products(
    limit: int = 50,
    offset: int = 0,
    q: Optional[str] = None,
    sort: Optional[str] = None,
) -> list[dict]:
    conn = _connect()
    try:
        _ensure_product_images_table(conn)
        _ensure_products_cost_column(conn)
        _ensure_products_highlight_new_arrivals_column(conn)
        _ensure_products_flash_offer_columns(conn)
        has_deleted_at = _has_column(conn, "products", "deleted_at")
        has_is_active = _has_column(conn, "products", "is_active")
        has_created_at = _has_column(conn, "products", "created_at")
        has_updated_at = _has_column(conn, "products", "updated_at")
        has_price_list_1 = _has_column(conn, "products", "price_list_1")
        has_description = _has_column(conn, "products", "description")
        featured_enabled = _has_column(conn, "products", "is_featured")
        offer_enabled = _has_column(conn, "products", "is_offer")
        recommended_enabled = _has_column(conn, "products", "is_recommended")
        highlight_new_arrivals_enabled = _has_column(conn, "products", "highlight_new_arrivals")
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
        select_fields.append("p.flash_offer_price")
        select_fields.append("p.flash_offer_ends_at")
        select_fields.append("p.description" if has_description else "NULL AS description")
        select_fields.append("p.cost")
        select_fields.append("p.is_active" if has_is_active else "NULL AS is_active")
        select_fields.append("p.is_featured" if featured_enabled else "NULL AS is_featured")
        select_fields.append("p.is_offer" if offer_enabled else "NULL AS is_offer")
        select_fields.append("p.is_recommended" if recommended_enabled else "NULL AS is_recommended")
        select_fields.append(
            "p.highlight_new_arrivals"
            if highlight_new_arrivals_enabled
            else "NULL AS highlight_new_arrivals"
        )
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
        sort_key = str(sort or "").strip().lower()
        if sort_key in {"", "newest"}:
            if has_created_at and has_updated_at:
                order_by = "COALESCE(p.created_at, p.updated_at) DESC, p.id DESC"
            elif has_created_at:
                order_by = "p.created_at DESC, p.id DESC"
            elif has_updated_at:
                order_by = "p.updated_at DESC, p.id DESC"
            else:
                order_by = "p.id DESC"
        else:
            order_by = "LOWER(p.name) ASC, p.id ASC"
        query += f" ORDER BY {order_by} LIMIT ? OFFSET ?"
        params.extend([max(1, int(limit)), max(0, int(offset))])
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
            "price": _storefront_price(row),
            "originalPrice": _base_price(row),
            "flashOffer": _flash_offer_payload(row),
            "cost": float(row["cost"] or 0),
            "stock": int(row["stock"] or 0),
            "category": row["category"] or "General",
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "description": row["description"],
            **_build_product_image_fields(
                row["image_path"],
                images_map.get(int(row["id"])) or [],
                int(row["id"]),
            ),
            "is_featured": bool(row["is_featured"]) if featured_enabled else False,
            "is_offer": bool(row["is_offer"]) if offer_enabled else False,
            "is_recommended": bool(row["is_recommended"]) if recommended_enabled else False,
            "highlight_new_arrivals": bool(row["highlight_new_arrivals"])
            if highlight_new_arrivals_enabled
            else False,
        }
        for row in rows
    ]


@app.get("/categories")
def list_categories() -> list[dict]:
    conn = _connect()
    try:
        if not _has_table(conn, "categories"):
            return []
        has_deleted_at = _has_column(conn, "products", "deleted_at")
        has_is_active = _has_column(conn, "products", "is_active")
        join_conditions = ["p.category_id = c.id"]
        if has_deleted_at:
            join_conditions.append("p.deleted_at IS NULL")
        if has_is_active:
            join_conditions.append("p.is_active = 1")
        rows = conn.execute(
            f"""
            SELECT c.id, c.name, COUNT(p.id) AS product_count
            FROM categories c
            LEFT JOIN products p ON {" AND ".join(join_conditions)}
            GROUP BY c.id, c.name
            HAVING COUNT(p.id) > 0
            ORDER BY LOWER(c.name) ASC, c.id ASC
            """
        ).fetchall()
    finally:
        conn.close()

    return [
        {
            "id": int(row["id"]),
            "name": row["name"],
            "product_count": int(row["product_count"] or 0),
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
        _ensure_products_flash_offer_columns(conn)
        total = 0.0
        items: list[tuple[int, int, float]] = []
        items_details: list[dict] = []
        for item in payload.items:
            row = conn.execute(
                """
                SELECT id, name, price, price_list_1, price_list_2, stock,
                       flash_offer_price, flash_offer_ends_at
                FROM products
                WHERE id = ? AND deleted_at IS NULL
                """,
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
            submitted_price = float(item.unit_price or 0)
            unit_price = submitted_price if submitted_price > 0 else _storefront_price(row)
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
    if status_value not in {"PENDING", "CONFIRMED", "CANCELLED", "BUDGETED", "ALL"}:
        status_value = "PENDING"

    conn = _connect()
    try:
        _ensure_web_order_tables(conn)
        where_clause = "" if status_value == "ALL" else "WHERE status = ?"
        params: list[Any] = [] if status_value == "ALL" else [status_value]
        rows = conn.execute(
            f"""
            SELECT id, customer_name, customer_phone, customer_email, notes, total, status,
                   created_at, confirmed_at, confirmed_invoice_id
            FROM web_orders
            {where_clause}
            ORDER BY created_at DESC
            LIMIT ?
            """,
            params + [int(limit)],
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
            "SELECT id, status, confirmed_invoice_id FROM web_orders WHERE id = ?",
            (int(order_id),),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Pedido no encontrado")

        if status_value == "DELETED":
            confirmed_invoice_id = row["confirmed_invoice_id"] if isinstance(row, dict) else row[2]
            current_status = (row["status"] if isinstance(row, dict) else row[1]) or "PENDING"
            if confirmed_invoice_id not in (None, "", 0, "0") or str(current_status).upper() == "CONFIRMED":
                raise HTTPException(
                    status_code=400,
                    detail="No se puede eliminar un pedido web que ya fue procesado y tiene comprobante asociado",
                )
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
        _ensure_products_highlight_new_arrivals_column(conn)
        _ensure_products_flash_offer_columns(conn)
        has_deleted_at = _has_column(conn, "products", "deleted_at")
        has_is_active = _has_column(conn, "products", "is_active")
        has_created_at = _has_column(conn, "products", "created_at")
        has_updated_at = _has_column(conn, "products", "updated_at")
        has_price_list_1 = _has_column(conn, "products", "price_list_1")
        has_description = _has_column(conn, "products", "description")
        featured_enabled = _has_column(conn, "products", "is_featured")
        offer_enabled = _has_column(conn, "products", "is_offer")
        recommended_enabled = _has_column(conn, "products", "is_recommended")
        highlight_new_arrivals_enabled = _has_column(conn, "products", "highlight_new_arrivals")
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
        select_fields.append("p.flash_offer_price")
        select_fields.append("p.flash_offer_ends_at")
        select_fields.append("p.description" if has_description else "NULL AS description")
        select_fields.append("p.is_active" if has_is_active else "NULL AS is_active")
        select_fields.append("p.is_featured" if featured_enabled else "NULL AS is_featured")
        select_fields.append("p.is_offer" if offer_enabled else "NULL AS is_offer")
        select_fields.append("p.is_recommended" if recommended_enabled else "NULL AS is_recommended")
        select_fields.append(
            "p.highlight_new_arrivals"
            if highlight_new_arrivals_enabled
            else "NULL AS highlight_new_arrivals"
        )
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
            "price": _storefront_price(row),
            "originalPrice": _base_price(row),
            "flashOffer": _flash_offer_payload(row),
            "stock": int(row["stock"] or 0),
            "category": row["category"] or "General",
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "badge": "Destacado" if featured_enabled else "Stock",
            "description": row["description"],
            **_build_product_image_fields(
                row["image_path"],
                images_map.get(int(row["id"])) or [],
                int(row["id"]),
            ),
            "is_featured": True if featured_enabled else False,
            "is_offer": bool(row["is_offer"]) if offer_enabled else False,
            "is_recommended": bool(row["is_recommended"]) if recommended_enabled else False,
            "highlight_new_arrivals": bool(row["highlight_new_arrivals"])
            if highlight_new_arrivals_enabled
            else False,
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
    username = _normalize_username(payload.get("username"))
    username_key = username.lower()
    password = str(payload.get("password") or "")
    if not username or not password:
        raise HTTPException(status_code=400, detail="Credenciales incompletas")
    conn = _connect()
    try:
        _ensure_users_table(conn)
        _ensure_bootstrap_admin(conn)
        rows = conn.execute(
            """
            SELECT id, username, password_hash, role, active
            FROM users
            WHERE LOWER(TRIM(username)) = ?
            ORDER BY CASE WHEN TRIM(username) = ? THEN 0 ELSE 1 END, id ASC
            """,
            (username_key, username),
        ).fetchall()
    finally:
        conn.close()
    password_hash = _hash_password(password)
    row = next(
        (
            item
            for item in rows
            if int(item["active"] or 0) and str(item["password_hash"] or "") == password_hash
        ),
        None,
    )
    if row is None:
        raise HTTPException(status_code=401, detail="Credenciales invalidas")
    payload_data = {
        "id": int(row["id"]),
        "username": row["username"],
        "role": row["role"],
        "exp": int(time.time() + SESSION_TTL_SECONDS),
    }
    token = _sign_session(payload_data)
    if response is not None:
        cookie_options = _session_cookie_options(request)
        response.set_cookie(
            key=SESSION_COOKIE,
            value=token,
            max_age=SESSION_TTL_SECONDS,
            httponly=True,
            secure=bool(cookie_options["secure"]),
            samesite=str(cookie_options["samesite"]),
            domain=cookie_options["domain"],
            path=str(cookie_options["path"]),
        )
    return {"id": int(row["id"]), "username": row["username"], "role": row["role"]}


@app.get("/auth/users")
def auth_users() -> list[dict[str, str]]:
    conn = _connect()
    try:
        _ensure_users_table(conn)
        _ensure_bootstrap_admin(conn)
        rows = conn.execute(
            """
            SELECT username, role
            FROM users
            WHERE COALESCE(active, 1) = 1
            ORDER BY LOWER(TRIM(username)) ASC
            """
        ).fetchall()
    finally:
        conn.close()
    seen: set[str] = set()
    payload: list[dict[str, str]] = []
    for row in rows:
        normalized_username = str(row["username"] or "").strip()
        normalized_key = normalized_username.lower()
        if not normalized_username or normalized_key in seen:
            continue
        seen.add(normalized_key)
        payload.append(
            {
                "username": normalized_username,
                "role": str(row["role"] or "").strip(),
            }
        )
    return payload


@app.get("/admin/users")
def admin_users(session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE)) -> list[dict[str, Any]]:
    _require_full_admin(session_token)
    conn = _connect()
    try:
        _ensure_users_table(conn)
        _ensure_bootstrap_admin(conn)
        rows = conn.execute(
            """
            SELECT id, username, role, active, created_at
            FROM users
            ORDER BY LOWER(TRIM(username)) ASC, id ASC
            """
        ).fetchall()
        return [_serialize_admin_user(row) for row in rows]
    finally:
        conn.close()


@app.post("/admin/users")
def admin_create_user(
    payload: AdminUserCreatePayload,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict[str, Any]:
    _require_full_admin(session_token)
    username = _normalize_username(payload.username)
    password = _normalize_password(payload.password, required=True)
    role = _normalize_user_role(payload.role)
    active = 1 if payload.active else 0
    username_key = username.lower()
    conn = _connect()
    try:
        _ensure_users_table(conn)
        existing = conn.execute(
            "SELECT id FROM users WHERE LOWER(TRIM(username)) = ?",
            (username_key,),
        ).fetchone()
        if existing is not None:
            raise HTTPException(status_code=409, detail="Ya existe un usuario con ese nombre")
        conn.execute(
            """
            INSERT INTO users (username, password_hash, role, active)
            VALUES (?, ?, ?, ?)
            """,
            (username, _hash_password(password or ""), role, active),
        )
        conn.commit()
        row = conn.execute(
            "SELECT id, username, role, active, created_at FROM users WHERE LOWER(TRIM(username)) = ?",
            (username_key,),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=500, detail="No se pudo crear el usuario")
        return _serialize_admin_user(row)
    finally:
        conn.close()


@app.put("/admin/users/{user_id}")
def admin_update_user(
    user_id: int,
    payload: AdminUserUpdatePayload,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict[str, Any]:
    session_payload = _require_full_admin(session_token)
    current_user_id = session_payload.get("id")
    current_username = str(session_payload.get("username") or "").strip()
    conn = _connect()
    try:
        _ensure_users_table(conn)
        existing = conn.execute(
            "SELECT id, username, role, active, created_at FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
        if existing is None:
            raise HTTPException(status_code=404, detail="Usuario no encontrado")

        next_username = _normalize_username(payload.username) if payload.username is not None else str(existing["username"] or "").strip()
        next_role = _normalize_user_role(payload.role) if payload.role is not None else str(existing["role"] or "").strip().lower()
        next_active = int(payload.active) if payload.active is not None else int(existing["active"] or 0)
        next_password = _normalize_password(payload.password, required=False)

        existing_username = str(existing["username"] or "").strip()
        existing_username_key = existing_username.lower()
        next_username_key = next_username.lower()

        if next_username_key != existing_username_key:
            duplicate = conn.execute(
                "SELECT id FROM users WHERE LOWER(TRIM(username)) = ? AND id <> ?",
                (next_username_key, user_id),
            ).fetchone()
            if duplicate is not None:
                raise HTTPException(status_code=409, detail="Ya existe un usuario con ese nombre")

        is_current_user = False
        try:
            is_current_user = current_user_id is not None and int(current_user_id) == int(user_id)
        except (TypeError, ValueError):
            is_current_user = False
        if not is_current_user and current_username:
            is_current_user = existing_username == current_username

        if is_current_user:
            if next_active != 1:
                raise HTTPException(status_code=400, detail="No puedes desactivar tu propio usuario")
            if next_role != ROLE_ADMIN:
                raise HTTPException(status_code=400, detail="No puedes quitarte el rol admin")

        updates: list[str] = ["username = ?", "role = ?", "active = ?"]
        params: list[Any] = [next_username, next_role, next_active]
        if next_password is not None:
            updates.append("password_hash = ?")
            params.append(_hash_password(next_password))
        params.append(user_id)
        conn.execute(
            f"UPDATE users SET {', '.join(updates)} WHERE id = ?",
            tuple(params),
        )
        conn.commit()
        row = conn.execute(
            "SELECT id, username, role, active, created_at FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=500, detail="No se pudo actualizar el usuario")
        return _serialize_admin_user(row)
    finally:
        conn.close()


@app.delete("/admin/users/{user_id}")
def admin_delete_user(
    user_id: int,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict[str, Any]:
    session_payload = _require_full_admin(session_token)
    current_user_id = session_payload.get("id")
    current_username = str(session_payload.get("username") or "").strip()
    conn = _connect()
    try:
        _ensure_users_table(conn)
        existing = conn.execute(
            "SELECT id, username FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
        if existing is None:
            raise HTTPException(status_code=404, detail="Usuario no encontrado")

        existing_username = str(existing["username"] or "").strip()
        is_current_user = False
        try:
            is_current_user = current_user_id is not None and int(current_user_id) == int(user_id)
        except (TypeError, ValueError):
            is_current_user = False
        if not is_current_user and current_username:
            is_current_user = existing_username == current_username

        if is_current_user:
            raise HTTPException(status_code=400, detail="No puedes eliminar tu propio usuario")

        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
        conn.commit()
        return {"status": "ok"}
    finally:
        conn.close()


@app.post("/auth/logout")
def auth_logout(response: Response, request: Request) -> dict:
    if response is not None:
        cookie_options = _session_cookie_options(request)
        response.delete_cookie(
            SESSION_COOKIE,
            secure=bool(cookie_options["secure"]),
            samesite=str(cookie_options["samesite"]),
            domain=cookie_options["domain"],
            path=str(cookie_options["path"]),
        )
    return {"status": "ok"}


@app.get("/auth/me")
def auth_me(session: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE)) -> dict:
    payload = _verify_session(session or "")
    if not payload:
        raise HTTPException(status_code=401, detail="No autenticado")
    user_id = payload.get("id")
    normalized_id = None
    try:
        normalized_id = int(user_id) if user_id is not None else None
    except (TypeError, ValueError):
        normalized_id = None
    return {"id": normalized_id, "username": payload.get("username"), "role": payload.get("role")}


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
        _ensure_products_barcode_column(conn)
        _ensure_products_cost_column(conn)
        _ensure_products_highlight_new_arrivals_column(conn)
        _ensure_products_flash_offer_columns(conn)
        _ensure_product_imeis_table(conn)
        has_deleted_at = _has_column(conn, "products", "deleted_at")
        has_is_active = _has_column(conn, "products", "is_active")
        has_highlight_new_arrivals = _has_column(conn, "products", "highlight_new_arrivals")
        
        conditions = []
        params: list = []
        
        if has_deleted_at:
            conditions.append("deleted_at IS NULL")
        if has_is_active:
            conditions.append("is_active = 1")
        
        if q:
            conditions.append("(name LIKE ? OR sku LIKE ? OR COALESCE(barcode, '') LIKE ? OR CAST(id AS TEXT) = ?)")
            like = f"%{q}%"
            params.extend([like, like, like, str(q).strip()])
        
        if category:
            conditions.append("category_id = (SELECT id FROM categories WHERE name = ?)")
            params.append(category)
        
        where_clause = f" WHERE {' AND '.join(conditions)}" if conditions else ""
        
        rows = conn.execute(
            f"""
            SELECT id, name, sku, barcode, price, price_list_1, price_list_2, cost, stock, 
                   image_path, category_id, is_active, is_featured, is_offer,
                   flash_offer_price, flash_offer_ends_at,
                   {"highlight_new_arrivals" if has_highlight_new_arrivals else "NULL AS highlight_new_arrivals"}
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
        product_ids = [int(row["id"]) for row in rows]
        images_map = _fetch_product_images(conn, product_ids)
        imeis_map = _fetch_product_imeis(conn, product_ids, only_available=True)
        
        return [
            {
                "id": int(row["id"]),
                "name": row["name"],
                "sku": row["sku"],
                "barcode": row["barcode"],
                "price": float(row["price"] or 0),
                "price_list_1": float(row["price_list_1"] or 0),
                "price_list_2": float(row["price_list_2"] or 0),
                "storefront_price": _storefront_price(row),
                "storefront_original_price": _pick_price(row),
                "storefront_price_source": (
                    "flash_offer"
                    if _flash_offer_is_active(row)
                    else "price_list_1"
                    if float(row["price_list_1"] or 0) > 0 and float(row["price_list_1"] or 0) != float(row["price"] or 0)
                    else "price"
                ),
                "cost": float(row["cost"] or 0),
                "stock": int(row["stock"] or 0),
                "category_id": int(row["category_id"]) if row["category_id"] else None,
                "is_active": bool(row["is_active"]) if has_is_active else True,
                "is_featured": bool(row["is_featured"]),
                "is_offer": bool(row["is_offer"]),
                "flash_offer_price": float(row["flash_offer_price"] or 0),
                "flash_offer_ends_at": row["flash_offer_ends_at"],
                "flash_offer_active": _flash_offer_is_active(row),
                "highlight_new_arrivals": bool(row["highlight_new_arrivals"])
                if has_highlight_new_arrivals
                else False,
                "image_path": row["image_path"],
                "imeis": imeis_map.get(int(row["id"])) or [],
                **_build_product_image_fields(
                    row["image_path"],
                    images_map.get(int(row["id"])) or [],
                    int(row["id"]),
                ),
                "image_urls": _build_product_image_fields(
                    row["image_path"],
                    images_map.get(int(row["id"])) or [],
                    int(row["id"]),
                )["imageUrls"],
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
    barcode = str(payload.get("barcode") or "").strip() or None
    price = float(payload.get("price") or 0)
    cost = float(payload.get("cost") or 0)
    stock = int(payload.get("stock") or 0)
    category_id = int(payload.get("category_id") or 0) or None
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
        _ensure_products_barcode_column(conn)
        _ensure_products_cost_column(conn)
        _ensure_products_highlight_new_arrivals_column(conn)
        _ensure_products_flash_offer_columns(conn)
        _ensure_product_imeis_table(conn)
        imeis = _normalize_imei_list(payload.get("imeis") or [])
        if conn.execute("SELECT id FROM products WHERE sku = ?", (sku,)).fetchone():
            raise HTTPException(status_code=400, detail="Ya existe un producto con ese SKU")
        if barcode and conn.execute("SELECT id FROM products WHERE barcode = ?", (barcode,)).fetchone():
            raise HTTPException(status_code=400, detail="Ya existe un producto con ese codigo de barras")

        columns = ["name", "sku", "price", "stock"]
        values: list[Any] = [name, sku, price, stock]
        if _has_column(conn, "products", "barcode"):
            columns.append("barcode")
            values.append(barcode)

        if _has_column(conn, "products", "cost"):
            columns.append("cost")
            values.append(cost)
        if _has_column(conn, "products", "price_list_1"):
            columns.append("price_list_1")
            values.append(float(payload.get("price_list_1") or 0))
        if _has_column(conn, "products", "price_list_2"):
            columns.append("price_list_2")
            values.append(float(payload.get("price_list_2") or 0))
        if _has_column(conn, "products", "image_path"):
            columns.append("image_path")
            values.append(primary_image)
        if _has_column(conn, "products", "category_id"):
            columns.append("category_id")
            values.append(category_id)
        if _has_column(conn, "products", "is_active"):
            columns.append("is_active")
            values.append(1)
        if _has_column(conn, "products", "is_featured"):
            columns.append("is_featured")
            values.append(is_featured)
        if _has_column(conn, "products", "is_offer"):
            columns.append("is_offer")
            values.append(is_offer)
        if _has_column(conn, "products", "highlight_new_arrivals"):
            columns.append("highlight_new_arrivals")
            values.append(1 if bool(payload.get("highlight_new_arrivals")) else 0)
        if _has_column(conn, "products", "flash_offer_price"):
            columns.append("flash_offer_price")
            values.append(float(payload.get("flash_offer_price") or 0))
        if _has_column(conn, "products", "flash_offer_ends_at"):
            columns.append("flash_offer_ends_at")
            raw_ends_at = str(payload.get("flash_offer_ends_at") or "").strip()
            values.append(raw_ends_at or None)

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
        _replace_product_imeis(conn, product_id, imeis)
        conn.commit()
        
        return {
            "id": product_id,
            "name": name,
            "sku": sku,
            "barcode": barcode,
            "price": price,
            "price_list_1": float(payload.get("price_list_1") or 0),
            "price_list_2": float(payload.get("price_list_2") or 0),
            "cost": cost,
            "stock": stock,
            "category_id": category_id,
            "image_path": primary_image,
            "is_featured": bool(is_featured),
            "is_offer": bool(is_offer),
            "highlight_new_arrivals": bool(payload.get("highlight_new_arrivals")),
            "flash_offer_price": float(payload.get("flash_offer_price") or 0),
            "flash_offer_ends_at": str(payload.get("flash_offer_ends_at") or "").strip() or None,
            "image_urls": image_values,
            "imeis": imeis,
        }
    finally:
        conn.close()


@app.get("/admin/imei-lookup")
def admin_imei_lookup(
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
    q: Optional[str] = None,
) -> dict:
    _require_admin(session_token)
    imei = _normalize_imei_value(q or "")
    if not imei:
        raise HTTPException(status_code=400, detail="IMEI requerido")

    conn = _connect()
    try:
        _ensure_product_imeis_table(conn)
        row = conn.execute(
            """
            SELECT pi.imei, pi.product_id, pi.sold_invoice_id, pi.sold_at,
                   p.name AS product_name, p.sku, p.category_id,
                   c.name AS category_name,
                   i.created_at AS invoice_created_at,
                   i.document_type AS invoice_document_type
            FROM product_imeis pi
            LEFT JOIN products p ON p.id = pi.product_id
            LEFT JOIN categories c ON c.id = p.category_id
            LEFT JOIN invoices i ON i.id = pi.sold_invoice_id
            WHERE pi.imei = ?
            LIMIT 1
            """,
            (imei,),
        ).fetchone()
        if row is None:
            return {
                "found": False,
                "imei": imei,
                "is_own": False,
                "status": "unknown",
            }
        sold_invoice_id = int(row["sold_invoice_id"]) if row["sold_invoice_id"] is not None else None
        sold_at = row["sold_at"] or row["invoice_created_at"]
        return {
            "found": True,
            "imei": imei,
            "is_own": True,
            "status": "sold" if sold_invoice_id else "available",
            "product": {
                "id": int(row["product_id"]) if row["product_id"] is not None else None,
                "name": row["product_name"] or "Producto",
                "sku": row["sku"],
                "category_id": int(row["category_id"]) if row["category_id"] is not None else None,
                "category_name": row["category_name"],
            },
            "sale": {
                "invoice_id": sold_invoice_id,
                "sold_at": sold_at,
                "document_type": row["invoice_document_type"],
            },
        }
    finally:
        conn.close()


@app.get("/admin/products/{product_id}/tracking")
def admin_product_tracking(
    product_id: int,
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict[str, Any]:
    _require_admin(session_token)

    conn = _connect()
    try:
        product = conn.execute(
            """
            SELECT p.id, p.name, p.sku, p.barcode, p.stock, p.price, p.cost, p.category_id,
                   c.name AS category_name
            FROM products p
            LEFT JOIN categories c ON c.id = p.category_id
            WHERE p.id = ? AND p.deleted_at IS NULL
            """,
            (product_id,),
        ).fetchone()
        if product is None:
            raise HTTPException(status_code=404, detail="Producto no encontrado")

        history_rows = conn.execute(
            """
            SELECT ii.invoice_id, ii.quantity, ii.unit_price,
                   i.created_at, i.document_type, i.customer_id,
                   c.name AS customer_name
            FROM invoice_items ii
            LEFT JOIN invoices i ON i.id = ii.invoice_id
            LEFT JOIN customers c ON c.id = i.customer_id
            WHERE ii.product_id = ?
            ORDER BY i.created_at DESC, ii.id DESC
            """,
            (product_id,),
        ).fetchall()

        sold_units = 0
        credited_units = 0
        invoice_count = 0
        last_stock_output: Optional[dict[str, Any]] = None
        history: list[dict[str, Any]] = []
        for row in history_rows:
            quantity = int(row["quantity"] or 0)
            stock_effect = _product_document_stock_effect(row["document_type"]) * quantity
            if stock_effect < 0:
                sold_units += abs(stock_effect)
                if last_stock_output is None:
                    last_stock_output = {
                        "invoice_id": int(row["invoice_id"]) if row["invoice_id"] is not None else None,
                        "created_at": row["created_at"],
                        "document_type": row["document_type"],
                        "customer_id": int(row["customer_id"]) if row["customer_id"] is not None else None,
                        "customer_name": row["customer_name"],
                        "quantity": quantity,
                    }
            elif stock_effect > 0:
                credited_units += stock_effect
            if row["invoice_id"] is not None:
                invoice_count += 1
            history.append(
                {
                    "invoice_id": int(row["invoice_id"]) if row["invoice_id"] is not None else None,
                    "created_at": row["created_at"],
                    "document_type": row["document_type"],
                    "customer_id": int(row["customer_id"]) if row["customer_id"] is not None else None,
                    "customer_name": row["customer_name"] or "Sin cliente",
                    "quantity": quantity,
                    "unit_price": round(float(row["unit_price"] or 0), 2),
                    "line_total": round(quantity * float(row["unit_price"] or 0), 2),
                    "stock_effect": stock_effect,
                }
            )

        has_imei_table = _has_table(conn, "product_imeis")
        available_imeis = 0
        sold_imeis = 0
        imei_rows: list[dict[str, Any]] = []
        if has_imei_table:
            raw_imei_rows = conn.execute(
                """
                SELECT imei, sold_invoice_id, sold_at
                FROM product_imeis
                WHERE product_id = ?
                ORDER BY imei ASC
                """,
                (product_id,),
            ).fetchall()
            for row in raw_imei_rows:
                sold_invoice_id = int(row["sold_invoice_id"]) if row["sold_invoice_id"] is not None else None
                if sold_invoice_id is None:
                    available_imeis += 1
                else:
                    sold_imeis += 1
                imei_rows.append(
                    {
                        "imei": str(row["imei"] or "").strip(),
                        "sold_invoice_id": sold_invoice_id,
                        "sold_at": row["sold_at"],
                        "status": "sold" if sold_invoice_id is not None else "available",
                    }
                )

        current_stock = int(product["stock"] or 0)
        summary_note = (
            "El seguimiento se basa en comprobantes e IMEIs registrados en esta base."
            if has_imei_table
            else "El seguimiento se basa en comprobantes registrados. Esta base todavia no tiene tabla de IMEIs."
        )
        if last_stock_output is not None and current_stock <= 0:
            summary_note += " Si el cliente informo una venta reciente, conviene revisar primero el ultimo comprobante listado."

        return {
            "product": {
                "id": int(product["id"]),
                "name": product["name"],
                "sku": product["sku"],
                "barcode": product["barcode"],
                "stock": current_stock,
                "price": round(float(product["price"] or 0), 2),
                "cost": round(float(product["cost"] or 0), 2),
                "category_id": int(product["category_id"]) if product["category_id"] is not None else None,
                "category_name": product["category_name"],
            },
            "summary": {
                "invoice_count": invoice_count,
                "sold_units": sold_units,
                "credited_units": credited_units,
                "net_units_out": sold_units - credited_units,
                "available_imeis": available_imeis,
                "sold_imeis": sold_imeis,
                "has_imei_tracking": has_imei_table,
                "last_stock_output": last_stock_output,
                "note": summary_note,
            },
            "history": history,
            "imeis": imei_rows,
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
        _ensure_products_barcode_column(conn)
        _ensure_products_cost_column(conn)
        _ensure_products_highlight_new_arrivals_column(conn)
        _ensure_products_flash_offer_columns(conn)
        _ensure_product_imeis_table(conn)
        row = conn.execute(
            "SELECT id, category_id FROM products WHERE id = ? AND deleted_at IS NULL",
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
        if "barcode" in payload and _has_column(conn, "products", "barcode"):
            raw_barcode = str(payload.get("barcode") or "").strip() or None
            if raw_barcode:
                duplicated_barcode = conn.execute(
                    "SELECT id FROM products WHERE barcode = ? AND id <> ?",
                    (raw_barcode, product_id),
                ).fetchone()
                if duplicated_barcode:
                    raise HTTPException(status_code=400, detail="Ya existe un producto con ese codigo de barras")
            updates.append("barcode = ?")
            params.append(raw_barcode)
        if "price" in payload:
            updates.append("price = ?")
            params.append(float(payload["price"]))
        if "price_list_1" in payload and _has_column(conn, "products", "price_list_1"):
            updates.append("price_list_1 = ?")
            params.append(float(payload.get("price_list_1") or 0))
        if "price_list_2" in payload and _has_column(conn, "products", "price_list_2"):
            updates.append("price_list_2 = ?")
            params.append(float(payload.get("price_list_2") or 0))
        if "cost" in payload:
            updates.append("cost = ?")
            params.append(float(payload["cost"]))
        if "stock" in payload:
            updates.append("stock = ?")
            params.append(int(payload["stock"]))
        if "category_id" in payload and _has_column(conn, "products", "category_id"):
            raw_category_id = payload.get("category_id")
            parsed_category_id = int(raw_category_id or 0) if raw_category_id not in (None, "", 0, "0") else None
            updates.append("category_id = ?")
            params.append(parsed_category_id)
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
        if "highlight_new_arrivals" in payload and _has_column(conn, "products", "highlight_new_arrivals"):
            updates.append("highlight_new_arrivals = ?")
            params.append(1 if payload["highlight_new_arrivals"] else 0)
        if "flash_offer_price" in payload and _has_column(conn, "products", "flash_offer_price"):
            updates.append("flash_offer_price = ?")
            params.append(float(payload.get("flash_offer_price") or 0))
        if "flash_offer_ends_at" in payload and _has_column(conn, "products", "flash_offer_ends_at"):
            raw_ends_at = str(payload.get("flash_offer_ends_at") or "").strip()
            updates.append("flash_offer_ends_at = ?")
            params.append(raw_ends_at or None)

        if updates:
            updates.append("updated_at = CURRENT_TIMESTAMP")
            params.append(product_id)
            query = f"UPDATE products SET {', '.join(updates)} WHERE id = ?"
            conn.execute(query, params)
        if "imeis" in payload:
            _replace_product_imeis(conn, product_id, _normalize_imei_list(payload.get("imeis") or []))
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
        _ensure_syncable_tables(conn)
        customer_fields = _customer_select_fields(conn)
        rows = conn.execute(
            f"""
            SELECT {customer_fields}
            FROM customers
            WHERE deleted_at IS NULL
            ORDER BY LOWER(TRIM(name)) ASC, id ASC
            """,
        ).fetchall()
        query_text = _normalize_search_text(q)
        if query_text:
            query_tokens = [token for token in query_text.split() if token]
            filtered_rows = []
            for row in rows:
                haystack = _normalize_search_text(
                    " ".join(
                        [
                            row["name"] or "",
                            row["email"] or "",
                            row["phone"] or "",
                            row["cuit"] or "",
                            row["address"] or "",
                            row["locality"] or "",
                        ]
                    )
                )
                if query_text in haystack or all(token in haystack for token in query_tokens):
                    filtered_rows.append(row)
            rows = filtered_rows
        rows = rows[offset : offset + limit]
        movements = conn.execute(
            """
            SELECT customer_id, amount, movement_type
            FROM account_movements
            WHERE customer_id IS NOT NULL
            """
            + _active_account_movements_clause(conn)
            + """
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
                "is_active": bool(int(row["is_active"] or 0)) if row["is_active"] is not None else True,
                "sale_mode": row["sale_mode"],
                "locality": row["locality"],
                "address": row["address"],
                "tax_condition": row["tax_condition"],
                "cuit": row["cuit"],
                "external_ref": row["external_ref"],
                "seller_id": int(row["seller_id"]) if row["seller_id"] is not None else None,
                "zone": row["zone"],
                "balance": balances.get(int(row["id"]), 0.0),
                "invoice_count": invoice_counts.get(int(row["id"]), 0),
            }
            for row in rows
        ]
    finally:
        conn.close()


@app.get("/admin/sellers")
def admin_sellers(
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
    q: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
) -> list[dict]:
    _require_admin(session_token)
    conn = _connect()
    try:
        _ensure_sellers_table(conn)
        params: list[Any] = []
        where_parts = ["1 = 1"]
        if q:
            like = f"%{q.strip()}%"
            where_parts.append("name LIKE ?")
            params.append(like)
        rows = conn.execute(
            f"""
            SELECT id, name, commission_percent, is_active, created_at, updated_at
            FROM sellers
            WHERE {' AND '.join(where_parts)}
            ORDER BY LOWER(TRIM(name)) ASC, id ASC
            LIMIT ? OFFSET ?
            """,
            params + [limit, offset],
        ).fetchall()
        return [
            {
                "id": int(row["id"]),
                "name": row["name"],
                "commission_percent": float(row["commission_percent"] or 0),
                "is_active": bool(row["is_active"]),
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
            }
            for row in rows
        ]
    finally:
        conn.close()


@app.get("/admin/sellers/monthly-summary")
def admin_sellers_monthly_summary(
    request: Request,
    period: Optional[str] = None,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict:
    session_payload = _require_admin(session_token)
    conn = _connect()
    try:
        _ensure_syncable_tables(conn)
        _ensure_invoice_special_discount_column(conn)
        _ensure_invoice_items_cost_snapshot_column(conn)
        _ensure_products_cost_column(conn)
        _ensure_sellers_table(conn)
        period_key = (period or _argentina_now().strftime("%Y-%m")).strip()
        if not re.fullmatch(r"\d{4}-\d{2}", period_key):
            raise HTTPException(status_code=400, detail="Periodo invalido. Usa YYYY-MM")
        active_sellers = conn.execute(
            """
            SELECT id, name, commission_percent
            FROM sellers
            WHERE COALESCE(is_active, 1) = 1
            ORDER BY LOWER(TRIM(name)) ASC, id ASC
            """
        ).fetchall()
        summary_map: dict[int, dict[str, Any]] = {
            int(row["id"]): {
                "seller_id": int(row["id"]),
                "name": row["name"],
                "commission_percent": float(row["commission_percent"] or 0),
                "sales": 0.0,
                "profit": 0.0,
                "commission": 0.0,
                "invoice_count": 0,
            }
            for row in active_sellers
        }

        invoices = conn.execute(
            """
            SELECT id, seller_id, total, special_discount, commission_amount, created_at, document_type
            FROM invoices
            WHERE seller_id IS NOT NULL
            """
        ).fetchall()
        invoice_ids: list[int] = []
        invoice_seller_map: dict[int, int] = {}
        invoice_sign_map: dict[int, float] = {}
        invoice_discount_map: dict[int, float] = {}
        for row in invoices:
            created_bucket = _argentina_month_bucket(row["created_at"])
            if created_bucket != period_key:
                continue
            seller_id = int(row["seller_id"] or 0)
            if seller_id <= 0 or seller_id not in summary_map:
                continue
            document_type = str(row["document_type"] or "").strip().upper()
            if document_type == "PRESUPUESTO":
                continue
            sign = -1.0 if document_type == "NOTA_CREDITO" else 1.0
            invoice_id = int(row["id"] or 0)
            invoice_ids.append(invoice_id)
            invoice_seller_map[invoice_id] = seller_id
            invoice_sign_map[invoice_id] = sign
            invoice_discount_map[invoice_id] = float(row["special_discount"] or 0)
            summary_map[seller_id]["sales"] = round(summary_map[seller_id]["sales"] + (float(row["total"] or 0) * sign), 2)
            summary_map[seller_id]["commission"] = round(
                summary_map[seller_id]["commission"] + (float(row["commission_amount"] or 0) * sign), 2
            )
            summary_map[seller_id]["invoice_count"] += 1

        if invoice_ids:
            placeholders = ",".join(["?"] * len(invoice_ids))
            invoice_items = conn.execute(
                f"""
                SELECT ii.invoice_id, ii.quantity, ii.unit_price, ii.cost_snapshot, p.cost
                FROM invoice_items ii
                LEFT JOIN products p ON p.id = ii.product_id
                WHERE ii.invoice_id IN ({placeholders})
                """,
                tuple(invoice_ids),
            ).fetchall()
            for row in invoice_items:
                invoice_id = int(row["invoice_id"] or 0)
                seller_id = invoice_seller_map.get(invoice_id)
                if seller_id is None:
                    continue
                sign = invoice_sign_map.get(invoice_id, 1.0)
                quantity = float(row["quantity"] or 0)
                unit_cost = float(row["cost_snapshot"] if row["cost_snapshot"] is not None else row["cost"] or 0)
                margin_value = _line_margin_value(quantity, float(row["unit_price"] or 0), unit_cost)
                summary_map[seller_id]["profit"] = round(
                    summary_map[seller_id]["profit"] + (margin_value * sign), 2
                )
            for invoice_id, discount in invoice_discount_map.items():
                if discount <= 0:
                    continue
                seller_id = invoice_seller_map.get(invoice_id)
                if seller_id is None:
                    continue
                sign = invoice_sign_map.get(invoice_id, 1.0)
                summary_map[seller_id]["profit"] = round(
                    summary_map[seller_id]["profit"] - (discount * sign), 2
                )

        return {
            "period": period_key,
            "items": sorted(
                [
                    {
                        "seller_id": seller_id,
                        "name": payload["name"],
                        "commission_percent": round(float(payload["commission_percent"] or 0), 2),
                        "sales": round(float(payload["sales"] or 0), 2),
                        "profit": (
                            round(float(payload["profit"] or 0), 2)
                            if _can_view_profit_metrics(session_payload.get("role"))
                            else None
                        ),
                        "commission": round(float(payload["commission"] or 0), 2),
                        "invoice_count": int(payload["invoice_count"] or 0),
                    }
                    for seller_id, payload in summary_map.items()
                ],
                key=lambda item: item["name"].lower(),
            ),
        }
    finally:
        conn.close()


@app.get("/admin/sellers/{seller_id}/monthly-detail")
def admin_seller_monthly_detail(
    seller_id: int,
    request: Request,
    period: Optional[str] = None,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict:
    session_payload = _require_admin(session_token)
    conn = _connect()
    try:
        _ensure_syncable_tables(conn)
        _ensure_invoice_special_discount_column(conn)
        _ensure_invoice_items_cost_snapshot_column(conn)
        _ensure_products_cost_column(conn)
        _ensure_sellers_table(conn)
        seller = conn.execute(
            """
            SELECT id, name, commission_percent, is_active, created_at, updated_at
            FROM sellers
            WHERE id = ?
            """,
            (seller_id,),
        ).fetchone()
        if seller is None:
            raise HTTPException(status_code=404, detail="Vendedor no encontrado")

        period_key = (period or _argentina_now().strftime("%Y-%m")).strip()
        if not re.fullmatch(r"\d{4}-\d{2}", period_key):
            raise HTTPException(status_code=400, detail="Periodo invalido. Usa YYYY-MM")

        invoices = conn.execute(
            """
            SELECT i.id, i.total, i.special_discount, i.commission_amount, i.created_at, i.document_type,
                   i.sale_mode, i.payment_method, i.notes, i.customer_id, c.name AS customer_name
            FROM invoices i
            LEFT JOIN customers c ON c.id = i.customer_id
            WHERE i.seller_id = ?
            ORDER BY i.created_at DESC, i.id DESC
            """,
            (seller_id,),
        ).fetchall()

        invoice_ids: list[int] = []
        invoice_sign_map: dict[int, float] = {}
        items_by_invoice: dict[int, list[dict[str, Any]]] = {}
        payments_by_invoice: dict[int, float] = {}
        detail_items: list[dict[str, Any]] = []
        totals = {
            "sales": 0.0,
            "commission": 0.0,
            "profit": 0.0,
            "invoice_count": 0,
        }

        for row in invoices:
            created_bucket = _argentina_month_bucket(row["created_at"])
            if created_bucket != period_key:
                continue
            document_type = str(row["document_type"] or "").strip().upper()
            if document_type == "PRESUPUESTO":
                continue
            sign = -1.0 if document_type == "NOTA_CREDITO" else 1.0
            invoice_id = int(row["id"] or 0)
            invoice_ids.append(invoice_id)
            invoice_sign_map[invoice_id] = sign
            items_by_invoice[invoice_id] = []

            total_value = round(float(row["total"] or 0) * sign, 2)
            commission_value = round(float(row["commission_amount"] or 0) * sign, 2)
            totals["sales"] = round(totals["sales"] + total_value, 2)
            totals["commission"] = round(totals["commission"] + commission_value, 2)
            totals["invoice_count"] += 1
            detail_items.append(
                {
                    "invoice_id": invoice_id,
                    "created_at": row["created_at"],
                    "document_type": row["document_type"],
                    "sale_mode": row["sale_mode"],
                    "payment_method": row["payment_method"],
                    "notes": row["notes"],
                    "customer_id": int(row["customer_id"]) if row["customer_id"] is not None else None,
                    "customer_name": row["customer_name"] or "Sin cliente",
                    "total": total_value,
                    "special_discount": round(float(row["special_discount"] or 0) * sign, 2),
                    "commission": commission_value,
                    "balance_due": total_value,
                    "profit": 0.0,
                    "items": items_by_invoice[invoice_id],
                }
            )

        if invoice_ids:
            placeholders = ",".join(["?"] * len(invoice_ids))
            payment_rows = conn.execute(
                f"""
                SELECT invoice_id, movement_type, amount
                FROM account_movements
                WHERE invoice_id IN ({placeholders})
                """,
                tuple(invoice_ids),
            ).fetchall()
            for row in payment_rows:
                invoice_id = int(row["invoice_id"] or 0)
                movement_type = str(row["movement_type"] or "").strip().upper()
                amount = float(row["amount"] or 0)
                signed_amount = amount if movement_type == "DEBIT" else -amount
                payments_by_invoice[invoice_id] = round(payments_by_invoice.get(invoice_id, 0.0) + signed_amount, 2)

            invoice_items = conn.execute(
                f"""
                SELECT ii.invoice_id, ii.product_id, ii.quantity, ii.unit_price, ii.cost_snapshot, p.name AS product_name, p.cost
                FROM invoice_items ii
                LEFT JOIN products p ON p.id = ii.product_id
                WHERE ii.invoice_id IN ({placeholders})
                ORDER BY ii.invoice_id ASC, ii.id ASC
                """,
                tuple(invoice_ids),
            ).fetchall()
            detail_map = {int(item["invoice_id"]): item for item in detail_items}
            for row in invoice_items:
                invoice_id = int(row["invoice_id"] or 0)
                detail = detail_map.get(invoice_id)
                if detail is None:
                    continue
                sign = invoice_sign_map.get(invoice_id, 1.0)
                quantity = float(row["quantity"] or 0)
                unit_price = float(row["unit_price"] or 0)
                cost = float(row["cost_snapshot"] if row["cost_snapshot"] is not None else row["cost"] or 0)
                revenue = quantity * unit_price
                cost_total = quantity * cost
                margin = round(_line_margin_value(quantity, unit_price, cost) * sign, 2)
                detail["profit"] = round(float(detail["profit"] or 0) + margin, 2)
                detail["items"].append(
                    {
                        "product_id": int(row["product_id"]) if row["product_id"] is not None else None,
                        "product_name": row["product_name"] or "Producto",
                        "quantity": quantity,
                        "unit_price": round(unit_price * sign, 2),
                        "line_total": round(revenue * sign, 2),
                        "cost_total": round(cost_total * sign, 2),
                    }
                )

            for item in detail_items:
                discount = float(item["special_discount"] or 0)
                item["profit"] = round(float(item["profit"] or 0) - discount, 2)
                item["balance_due"] = round(float(payments_by_invoice.get(int(item["invoice_id"]), float(item["total"] or 0)) or 0), 2)
                totals["profit"] = round(totals["profit"] + float(item["profit"] or 0), 2)

        return {
            "period": period_key,
            "seller": {
                "id": int(seller["id"]),
                "name": seller["name"],
                "commission_percent": round(float(seller["commission_percent"] or 0), 2),
                "is_active": bool(seller["is_active"]),
                "created_at": seller["created_at"],
                "updated_at": seller["updated_at"],
            },
            "summary": {
                "sales": round(float(totals["sales"] or 0), 2),
                "commission": round(float(totals["commission"] or 0), 2),
                "profit": (
                    round(float(totals["profit"] or 0), 2)
                    if _can_view_profit_metrics(session_payload.get("role"))
                    else None
                ),
                "invoice_count": int(totals["invoice_count"] or 0),
            },
            "items": [
                {
                    **item,
                    "profit": (
                        round(float(item["profit"] or 0), 2)
                        if _can_view_profit_metrics(session_payload.get("role"))
                        else None
                    ),
                }
                for item in detail_items
            ],
        }
    finally:
        conn.close()


@app.post("/admin/sellers")
def admin_create_seller(
    payload: SellerPayload,
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict:
    _require_admin(session_token)
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Nombre requerido")
    if payload.commission_percent < 0:
        raise HTTPException(status_code=400, detail="La comision no puede ser negativa")
    conn = _connect()
    try:
        _ensure_sellers_table(conn)
        existing = conn.execute(
            "SELECT id FROM sellers WHERE LOWER(TRIM(name)) = ? LIMIT 1",
            (name.lower(),),
        ).fetchone()
        if existing is not None:
            raise HTTPException(status_code=400, detail="Ya existe un vendedor con ese nombre")
        now = datetime.utcnow().isoformat()
        if DB_IS_POSTGRES:
            row = conn.execute(
                """
                INSERT INTO sellers (name, commission_percent, is_active, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
                RETURNING id
                """,
                (name, float(payload.commission_percent), 1 if payload.is_active else 0, now, now),
            ).fetchone()
            seller_id = int(row["id"])
        else:
            conn.execute(
                """
                INSERT INTO sellers (name, commission_percent, is_active, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (name, float(payload.commission_percent), 1 if payload.is_active else 0, now, now),
            )
            row = conn.execute("SELECT last_insert_rowid() AS id").fetchone()
            seller_id = int(row["id"] if isinstance(row, dict) else row[0])
        conn.commit()
        return {"id": seller_id, "message": "Vendedor creado"}
    finally:
        conn.close()


@app.put("/admin/sellers/{seller_id}")
def admin_update_seller(
    seller_id: int,
    payload: SellerPayload,
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict:
    _require_admin(session_token)
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Nombre requerido")
    if payload.commission_percent < 0:
        raise HTTPException(status_code=400, detail="La comision no puede ser negativa")
    conn = _connect()
    try:
        _ensure_sellers_table(conn)
        existing = conn.execute(
            "SELECT id FROM sellers WHERE id = ?",
            (seller_id,),
        ).fetchone()
        if existing is None:
            raise HTTPException(status_code=404, detail="Vendedor no encontrado")
        duplicate = conn.execute(
            "SELECT id FROM sellers WHERE LOWER(TRIM(name)) = ? AND id <> ? LIMIT 1",
            (name.lower(), seller_id),
        ).fetchone()
        if duplicate is not None:
            raise HTTPException(status_code=400, detail="Ya existe un vendedor con ese nombre")
        conn.execute(
            """
            UPDATE sellers
               SET name = ?, commission_percent = ?, is_active = ?, updated_at = ?
             WHERE id = ?
            """,
            (name, float(payload.commission_percent), 1 if payload.is_active else 0, datetime.utcnow().isoformat(), seller_id),
        )
        conn.commit()
        return {"id": seller_id, "message": "Vendedor actualizado"}
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
        _ensure_syncable_tables(conn)
        customer_fields = _customer_select_fields(conn)
        customer = conn.execute(
            f"""
            SELECT {customer_fields}
            FROM customers
            WHERE id = ? AND deleted_at IS NULL
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
            "seller_id": int(customer["seller_id"]) if customer["seller_id"] is not None else None,
            "zone": customer["zone"],
            "created_at": customer["created_at"],
            "is_active": bool(int(customer["is_active"] or 0)) if customer["is_active"] is not None else True,
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
    raw_seller_id = payload.get("seller_id")
    seller_id = int(raw_seller_id) if raw_seller_id not in (None, "", 0, "0") else None
    conn = _connect()
    try:
        _ensure_syncable_tables(conn)
        if seller_id is not None:
            _ensure_sellers_table(conn)
            seller = conn.execute(
                "SELECT id, is_active FROM sellers WHERE id = ?",
                (seller_id,),
            ).fetchone()
            if seller is None or not bool(seller["is_active"]):
                raise HTTPException(status_code=400, detail="Vendedor invalido")
        params = (
            name,
            str(payload.get("email") or "").strip() or None,
            str(payload.get("phone") or "").strip() or None,
            datetime.utcnow().isoformat(),
            str(payload.get("sale_mode") or "CONTADO").strip() or "CONTADO",
            str(payload.get("locality") or "").strip() or None,
            str(payload.get("address") or "").strip() or None,
            str(payload.get("tax_condition") or "").strip() or None,
            str(payload.get("cuit") or "").strip() or None,
            seller_id,
            str(payload.get("zone") or "").strip() or None,
            1 if bool(payload.get("is_active", True)) else 0,
        )
        if DB_IS_POSTGRES:
            row = conn.execute(
                """
                INSERT INTO customers (
                    name, email, phone, created_at, sale_mode, locality, address, tax_condition, cuit, seller_id, zone, is_active
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                RETURNING id
                """,
                params,
            ).fetchone()
            customer_id = int(row["id"] if isinstance(row, dict) else row[0])
        else:
            conn.execute(
                """
                INSERT INTO customers (
                    name, email, phone, created_at, sale_mode, locality, address, tax_condition, cuit, seller_id, zone, is_active
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                params,
            )
            row = conn.execute("SELECT last_insert_rowid() AS id").fetchone()
            customer_id = int(row["id"] if isinstance(row, dict) else row[0])
        conn.commit()
        return {"id": customer_id, "message": "Cliente creado"}
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
    raw_seller_id = payload.get("seller_id")
    seller_id = int(raw_seller_id) if raw_seller_id not in (None, "", 0, "0") else None
    conn = _connect()
    try:
        _ensure_syncable_tables(conn)
        if seller_id is not None:
            _ensure_sellers_table(conn)
            seller = conn.execute(
                "SELECT id, is_active FROM sellers WHERE id = ?",
                (seller_id,),
            ).fetchone()
            if seller is None or not bool(seller["is_active"]):
                raise HTTPException(status_code=400, detail="Vendedor invalido")
        row = conn.execute(
            """
            SELECT id
            FROM customers
            WHERE id = ? AND deleted_at IS NULL
            """,
            (customer_id,),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Cliente no encontrado")
        conn.execute(
            """
            UPDATE customers
               SET name = ?, email = ?, phone = ?, sale_mode = ?, locality = ?, address = ?, tax_condition = ?, cuit = ?, seller_id = ?, zone = ?, is_active = ?
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
                seller_id,
                str(payload.get("zone") or "").strip() or None,
                1 if bool(payload.get("is_active", True)) else 0,
                customer_id,
            ),
        )
        conn.commit()
        return {"id": customer_id, "message": "Cliente actualizado"}
    finally:
        conn.close()


@app.delete("/admin/backoffice-customers/{customer_id}")
def admin_delete_backoffice_customer(
    customer_id: int,
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict:
    _require_admin(session_token)
    conn = _connect()
    try:
        _ensure_syncable_tables(conn)
        customer = conn.execute(
            """
            SELECT id, name, COALESCE(is_active, 1) AS is_active
            FROM customers
            WHERE id = ? AND deleted_at IS NULL
            """,
            (customer_id,),
        ).fetchone()
        if customer is None:
            raise HTTPException(status_code=404, detail="Cliente no encontrado")
        conn.execute(
            "UPDATE customers SET deleted_at = ?, is_active = 0 WHERE id = ?",
            (datetime.utcnow().isoformat(), customer_id),
        )
        conn.commit()
        return {"id": customer_id, "message": "Cliente eliminado con historial conservado"}
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
            customer
            for row in rows
            for customer in [
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
            ]
            if not _balance_is_zero(customer["balance"])
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


def _build_admin_cc_overview(conn: DBConn) -> dict[str, Any]:
    _ensure_syncable_tables(conn)
    if not _has_table(conn, "customers") or not _has_table(conn, "account_movements"):
        return {"customers": [], "summary": {"customers": 0, "debit": 0, "credit": 0, "balance": 0}}
    customer_fields = _customer_select_fields(conn)
    customer_rows = conn.execute(
        f"""
        SELECT {customer_fields}
        FROM customers
        WHERE COALESCE(is_active, 1) = 1 AND deleted_at IS NULL
        ORDER BY LOWER(TRIM(name)) ASC
        """
    ).fetchall()
    aggregate_rows = conn.execute(
        """
        SELECT
            am.customer_id,
            SUM(CASE WHEN UPPER(COALESCE(am.movement_type, '')) = 'DEBIT' THEN COALESCE(am.amount, 0) ELSE 0 END) AS debit,
            SUM(CASE WHEN UPPER(COALESCE(am.movement_type, '')) = 'CREDIT' THEN COALESCE(am.amount, 0) ELSE 0 END) AS credit,
            SUM(CASE WHEN UPPER(COALESCE(am.movement_type, '')) = 'CREDIT' AND UPPER(COALESCE(am.entry_kind, '')) = 'PAYMENT' THEN COALESCE(am.amount, 0) ELSE 0 END) AS payments,
            SUM(CASE WHEN UPPER(COALESCE(am.movement_type, '')) = 'CREDIT' AND UPPER(COALESCE(am.entry_kind, '')) = 'CREDIT_NOTE' THEN COALESCE(am.amount, 0) ELSE 0 END) AS credit_notes,
            SUM(CASE WHEN UPPER(COALESCE(am.movement_type, '')) = 'CREDIT' AND UPPER(COALESCE(am.entry_kind, '')) = 'WRITEOFF' THEN COALESCE(am.amount, 0) ELSE 0 END) AS writeoffs,
            SUM(CASE WHEN UPPER(COALESCE(am.entry_kind, '')) = 'ADJUSTMENT' THEN
                CASE WHEN UPPER(COALESCE(am.movement_type, '')) = 'DEBIT' THEN COALESCE(am.amount, 0) ELSE -COALESCE(am.amount, 0) END
            ELSE 0 END) AS adjustments,
            SUM(CASE WHEN UPPER(COALESCE(am.entry_kind, '')) = 'OPENING_BALANCE' THEN COALESCE(am.amount, 0) ELSE 0 END) AS opening_balance,
            MAX(am.created_at) AS last_movement
        FROM account_movements am
        WHERE am.customer_id IS NOT NULL
        """
        + _active_account_movements_clause(conn, "am")
        + """
        GROUP BY am.customer_id
        """
    ).fetchall()
    aggregates_by_customer: dict[int, dict[str, Any]] = {}
    for row in aggregate_rows:
        raw_customer_id = row["customer_id"] if isinstance(row, dict) else row[1]
        try:
            customer_id = int(raw_customer_id)
        except (TypeError, ValueError):
            continue
        aggregates_by_customer[customer_id] = {
            "debit": _safe_finite_float(row["debit"]),
            "credit": _safe_finite_float(row["credit"]),
            "payments": _safe_finite_float(row["payments"]),
            "credit_notes": _safe_finite_float(row["credit_notes"]),
            "writeoffs": _safe_finite_float(row["writeoffs"]),
            "adjustments": _safe_finite_float(row["adjustments"]),
            "opening_balance": _safe_finite_float(row["opening_balance"]),
            "last_movement": _safe_text(row["last_movement"]),
        }
    customers: list[dict[str, Any]] = []
    total_debit = 0.0
    total_credit = 0.0
    total_balance = 0.0
    total_pending = 0.0
    total_overdue = 0.0
    total_collected = 0.0
    total_credit_notes = 0.0
    total_writeoffs = 0.0
    total_adjustments = 0.0
    for row in customer_rows:
        customer_id = int(row["id"])
        aggregate = aggregates_by_customer.get(customer_id)
        if aggregate is None and str(row["sale_mode"] or "").strip().upper() != "CUENTA_CORRIENTE":
            continue
        debit = _safe_finite_float(aggregate["debit"] if aggregate else 0)
        credit = _safe_finite_float(aggregate["credit"] if aggregate else 0)
        balance = round(debit - credit, 2)
        if not math.isfinite(balance):
            continue
        if _balance_is_zero(balance):
            continue
        pending = max(balance, 0.0)
        classification = {
            "pending": round(pending, 2),
            "overdue": 0.0,
            "collected": round(_safe_finite_float(aggregate["payments"] if aggregate else 0), 2),
            "payments": round(_safe_finite_float(aggregate["payments"] if aggregate else 0), 2),
            "credit_notes": round(_safe_finite_float(aggregate["credit_notes"] if aggregate else 0), 2),
            "writeoffs": round(_safe_finite_float(aggregate["writeoffs"] if aggregate else 0), 2),
            "adjustments": round(_safe_finite_float(aggregate["adjustments"] if aggregate else 0), 2),
            "opening_balance": round(_safe_finite_float(aggregate["opening_balance"] if aggregate else 0), 2),
        }
        aging = {
            "current": round(pending, 2),
            "d1_30": 0.0,
            "d31_60": 0.0,
            "d61_90": 0.0,
            "d90_plus": 0.0,
            "total": round(pending, 2),
            "classification": classification,
            "open_items": [],
        }
        total_debit += debit
        total_credit += credit
        total_balance += balance
        total_pending += _safe_finite_float(classification.get("pending"))
        total_overdue += _safe_finite_float(classification.get("overdue"))
        total_collected += _safe_finite_float(classification.get("collected"))
        total_credit_notes += _safe_finite_float(classification.get("credit_notes"))
        total_writeoffs += _safe_finite_float(classification.get("writeoffs"))
        total_adjustments += _safe_finite_float(classification.get("adjustments"))
        customers.append(
            {
                "id": customer_id,
                "name": _safe_text(row["name"]) or "Sin nombre",
                "email": _safe_text(row["email"]),
                "phone": _safe_text(row["phone"]),
                "sale_mode": _safe_text(row["sale_mode"]),
                "locality": _safe_text(row["locality"]),
                "address": _safe_text(row["address"]),
                "tax_condition": _safe_text(row["tax_condition"]),
                "cuit": _safe_text(row["cuit"]),
                "debit": round(debit, 2),
                "credit": round(credit, 2),
                "balance": balance,
                "aging": aging,
                "classification": classification,
                "last_movement": aggregate["last_movement"] if aggregate else None,
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
            "pending": round(total_pending, 2),
            "overdue": round(total_overdue, 2),
            "collected": round(total_collected, 2),
            "credit_notes": round(total_credit_notes, 2),
            "writeoffs": round(total_writeoffs, 2),
            "adjustments": round(total_adjustments, 2),
        },
    }


@app.get("/admin/cc/overview")
def admin_cc_overview(
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
) -> Any:
    session_payload = _require_admin(session_token)
    session_role = str(session_payload.get("role") or "").strip().lower() or ROLE_STAFF
    cached_response = _get_admin_cc_overview_cache(session_role)
    if cached_response is not None:
        return cached_response
    conn = _connect()
    try:
        return _set_admin_cc_overview_cache(session_role, _build_admin_cc_overview(conn))
    except Exception as exc:
        logger.exception("admin_cc_overview failed")
        return JSONResponse(
            status_code=500,
            content={"detail": f"admin_cc_overview_failed: {exc.__class__.__name__}: {str(exc)[:300]}"},
        )
    finally:
        conn.close()


@app.get("/admin/cc/overview-debug")
def admin_cc_overview_debug(
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
) -> Any:
    _require_admin(session_token)
    conn = _connect()
    try:
        payload = _build_admin_cc_overview(conn)
        return {
            "ok": True,
            "customers": len(payload.get("customers") or []),
            "summary": payload.get("summary") or {},
        }
    except Exception as exc:
        logger.exception("admin_cc_overview_debug failed")
        return JSONResponse(
            status_code=500,
            content={"ok": False, "detail": f"{exc.__class__.__name__}: {str(exc)[:500]}"},
        )
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
        _ensure_syncable_tables(conn)
        customer_fields = _customer_select_fields(conn)
        customer = conn.execute(
            f"""
            SELECT {customer_fields}
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
                   am.entry_kind, am.created_at, am.payment_method,
                   NULL AS document_type, NULL AS total, NULL AS due_date
            FROM account_movements am
            WHERE am.customer_id = ?
            """
            + _active_account_movements_clause(conn, "am")
            + """
            ORDER BY am.created_at ASC, am.id ASC
            """,
            (customer_id,),
        ).fetchall()
        serialized = []
        running_balance = 0.0
        balance = 0.0
        classification = {
            "pending": 0.0,
            "overdue": 0.0,
            "collected": 0.0,
            "payments": 0.0,
            "credit_notes": 0.0,
            "writeoffs": 0.0,
            "adjustments": 0.0,
            "opening_balance": 0.0,
        }
        for row in movements:
            movement_type = str(row["movement_type"] or "").upper()
            amount = _safe_finite_float(row["amount"])
            if amount <= 0:
                continue
            signed = amount if movement_type == "DEBIT" else -amount
            running_balance = round(running_balance + signed, 2)
            balance = running_balance
            entry_kind = _movement_entry_kind(row)
            remaining = amount if movement_type == "DEBIT" else None
            if movement_type == "DEBIT":
                if entry_kind == "OPENING_BALANCE":
                    classification["opening_balance"] += amount
                elif entry_kind == "ADJUSTMENT":
                    classification["adjustments"] += amount
                status_label = "Pendiente"
            else:
                status_label = _movement_entry_label(entry_kind)
                if entry_kind == "PAYMENT":
                    classification["payments"] += amount
                    classification["collected"] += amount
                elif entry_kind == "CREDIT_NOTE":
                    classification["credit_notes"] += amount
                elif entry_kind == "WRITEOFF":
                    classification["writeoffs"] += amount
                elif entry_kind == "ADJUSTMENT":
                    classification["adjustments"] -= amount
            serialized.append(
                {
                    "id": int(row["id"]),
                    "movement_type": movement_type,
                    "entry_kind": entry_kind,
                    "entry_label": _movement_entry_label(entry_kind),
                    "amount": amount,
                    "signed_amount": signed,
                    "reference": _safe_text(row["reference"]),
                    "invoice_id": row["invoice_id"],
                    "created_at": _safe_text(row["created_at"]),
                    "payment_method": _safe_text(row["payment_method"]),
                    "document_type": _safe_text(row["document_type"]),
                    "invoice_total": _safe_finite_float(row["total"]) if row["total"] is not None else None,
                    "due_date": _safe_text(row["due_date"]),
                    "remaining_amount": remaining,
                    "status_label": _safe_text(status_label),
                    "running_balance": running_balance,
                    "editable": not (int(row["invoice_id"] or 0) > 0 and (movement_type == "DEBIT" or entry_kind == "SALE")),
                }
            )
        classification["pending"] = round(max(balance, 0.0), 2)
        aging = {
            "current": round(max(balance, 0.0), 2),
            "d1_30": 0.0,
            "d31_60": 0.0,
            "d61_90": 0.0,
            "d90_plus": 0.0,
            "total": round(max(balance, 0.0), 2),
            "classification": {key: round(value, 2) for key, value in classification.items()},
            "open_items": [],
        }
        return {
            "customer": {
                "id": int(customer["id"]),
                "name": _safe_text(customer["name"]) or "Sin nombre",
                "email": _safe_text(customer["email"]),
                "phone": _safe_text(customer["phone"]),
                "sale_mode": _safe_text(customer["sale_mode"]),
                "locality": _safe_text(customer["locality"]),
                "address": _safe_text(customer["address"]),
                "tax_condition": _safe_text(customer["tax_condition"]),
                "cuit": _safe_text(customer["cuit"]),
            },
            "balance": round(balance, 2),
            "aging": aging,
            "classification": aging.get("classification", {}),
            "movements": serialized,
        }
    finally:
        conn.close()


@app.delete("/admin/cc/{customer_id}")
def admin_cc_delete_customer(
    customer_id: int,
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict:
    _require_admin(session_token)
    conn = _connect()
    try:
        _ensure_syncable_tables(conn)
        customer = conn.execute(
            """
            SELECT id, name
            FROM customers
            WHERE id = ? AND COALESCE(is_active, 1) = 1 AND deleted_at IS NULL
            """,
            (customer_id,),
        ).fetchone()
        if customer is None:
            raise HTTPException(status_code=404, detail="Cliente no encontrado")

        # En lugar de DELETE, hacer soft delete y backup
        if _has_table(conn, "account_movements"):
            # Obtener movimientos
            movements = conn.execute(
                "SELECT * FROM account_movements WHERE customer_id = ? AND is_deleted = 0",
                (customer_id,),
            ).fetchall()
            
            # Guardar backup de cada movimiento
            for movement in movements:
                conn.execute(
                    """
                    INSERT INTO account_movements_backup
                    (original_movement_id, customer_id, movement_type, amount, description,
                     document_type, document_number, due_date, invoice_id, reference, entry_kind,
                     payment_method, created_at, deleted_at)
                    SELECT id, customer_id, movement_type, amount, description,
                           document_type, document_number, due_date, invoice_id, reference, entry_kind,
                           payment_method, created_at, CURRENT_TIMESTAMP
                    FROM account_movements
                    WHERE id = ? AND customer_id = ?
                    """,
                    (movement["id"], customer_id),
                )
            
            # Marcar como eliminados (soft delete)
            conn.execute(
                "UPDATE account_movements SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP WHERE customer_id = ?",
                (customer_id,),
            )
            
            # Registrar auditoría
            for movement in movements:
                _log_movement_audit(
                    conn,
                    movement["id"],
                    customer_id,
                    "DELETE",
                    old_values=dict(movement) if hasattr(movement, 'keys') else {},
                    edited_by="ADMIN_MODE_CHANGE_TO_CONTADO",
                )

        conn.execute(
            """
            UPDATE customers
               SET sale_mode = ?,
                   is_active = 1,
                   deleted_at = NULL
             WHERE id = ?
            """,
            ("CONTADO", customer_id),
        )
        conn.commit()
        return {
            "id": int(customer["id"]),
            "name": customer["name"],
            "message": "Cuenta corriente eliminada (movimientos preservados en backup)",
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
        _ensure_syncable_tables(conn)
        _ensure_invoice_payment_method_column(conn)
        _ensure_invoice_special_discount_column(conn)
        _ensure_invoice_items_cost_snapshot_column(conn)
        _ensure_products_cost_column(conn)
        _ensure_sellers_table(conn)
        params: list[Any] = []
        where = ""
        if customer_id:
            where = "WHERE i.customer_id = ?"
            params.append(int(customer_id))
        rows = conn.execute(
            f"""
            SELECT i.id, i.customer_id, i.total, i.special_discount, i.created_at, i.document_type, i.sale_mode,
                   i.price_list, i.due_date, i.notes, i.payment_method,
                   i.seller_id, i.commission_amount,
                   c.name AS customer_name, s.name AS seller_name,
                   wo.id AS web_order_id
            FROM invoices i
            LEFT JOIN customers c ON c.id = i.customer_id
            LEFT JOIN sellers s ON s.id = i.seller_id
            LEFT JOIN web_orders wo ON wo.confirmed_invoice_id = i.id
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
                "special_discount": float(row["special_discount"] or 0),
                "created_at": row["created_at"],
                "document_type": row["document_type"],
                "sale_mode": row["sale_mode"],
                "price_list": int(row["price_list"]) if row["price_list"] is not None else 0,
                "due_date": row["due_date"],
                "notes": row["notes"],
                "payment_method": row["payment_method"],
                "seller_id": int(row["seller_id"]) if row["seller_id"] is not None else None,
                "seller_name": row["seller_name"],
                "commission_amount": float(row["commission_amount"] or 0),
                "web_order_id": int(row["web_order_id"]) if row["web_order_id"] is not None else None,
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
    items = payload.get("items")
    if not isinstance(items, list) or not items:
        raise HTTPException(status_code=400, detail="Agrega items al comprobante")

    document_type = str(payload.get("document_type") or "FACTURA").strip().upper() or "FACTURA"
    if document_type not in {"FACTURA", "NOTA_CREDITO", "PRESUPUESTO"}:
        raise HTTPException(status_code=400, detail="Tipo de comprobante invalido")
    sale_mode_input = str(payload.get("sale_mode") or "").strip().upper() or None
    due_date = str(payload.get("due_date") or "").strip() or None
    notes = str(payload.get("notes") or "").strip() or None
    order_id = int(payload.get("order_id") or 0) or None
    created_at = str(payload.get("created_at") or "").strip() or datetime.utcnow().isoformat()
    seller_id = int(payload.get("seller_id") or 0) or None
    if seller_id is None and document_type != "PRESUPUESTO":
        raise HTTPException(status_code=400, detail="Vendedor requerido")

    conn = _connect()
    try:
        _ensure_syncable_tables(conn)
        _ensure_invoice_payment_method_column(conn)
        _ensure_invoice_special_discount_column(conn)
        _ensure_products_barcode_column(conn)
        _ensure_product_imeis_table(conn)
        _ensure_sellers_table(conn)
        if customer_id <= 0 and document_type == "PRESUPUESTO" and order_id:
            web_order = conn.execute(
                """
                SELECT customer_name, customer_phone, customer_email
                FROM web_orders
                WHERE id = ?
                """,
                (order_id,),
            ).fetchone()
            if web_order is None:
                raise HTTPException(status_code=404, detail="Pedido web no encontrado para generar el presupuesto")
            customer_name = str(web_order["customer_name"] or "").strip()
            if not customer_name:
                raise HTTPException(status_code=400, detail="El pedido web no tiene nombre de cliente")
            existing_customer = conn.execute(
                """
                SELECT id
                FROM customers
                WHERE deleted_at IS NULL
                  AND COALESCE(is_active, 1) = 1
                  AND (
                    (? <> '' AND LOWER(TRIM(email)) = LOWER(TRIM(?)))
                    OR (? <> '' AND REPLACE(REPLACE(REPLACE(REPLACE(TRIM(phone), ' ', ''), '-', ''), '(', ''), ')', '') =
                                   REPLACE(REPLACE(REPLACE(REPLACE(TRIM(?), ' ', ''), '-', ''), '(', ''), ')', ''))
                    OR LOWER(TRIM(name)) = LOWER(TRIM(?))
                  )
                ORDER BY id ASC
                LIMIT 1
                """,
                (
                    str(web_order["customer_email"] or "").strip(),
                    str(web_order["customer_email"] or "").strip(),
                    str(web_order["customer_phone"] or "").strip(),
                    str(web_order["customer_phone"] or "").strip(),
                    customer_name,
                ),
            ).fetchone()
            if existing_customer is not None:
                customer_id = int(existing_customer["id"] if isinstance(existing_customer, dict) else existing_customer[0])
            else:
                created_customer_at = created_at
                insert_customer_sql = """
                    INSERT INTO customers (name, email, phone, created_at, sale_mode, is_active)
                    VALUES (?, ?, ?, ?, ?, 1)
                """
                insert_customer_params = (
                    customer_name,
                    str(web_order["customer_email"] or "").strip() or None,
                    str(web_order["customer_phone"] or "").strip() or None,
                    created_customer_at,
                    sale_mode_input or "CONTADO",
                )
                if DB_IS_POSTGRES:
                    created_customer = conn.execute(f"{insert_customer_sql} RETURNING id", insert_customer_params).fetchone()
                    customer_id = int(created_customer["id"] if isinstance(created_customer, dict) else created_customer[0])
                else:
                    conn.execute(insert_customer_sql, insert_customer_params)
                    created_customer = conn.execute("SELECT last_insert_rowid() AS id").fetchone()
                    customer_id = int(created_customer["id"] if isinstance(created_customer, dict) else created_customer[0])
        if customer_id <= 0:
            raise HTTPException(status_code=400, detail="Cliente requerido")
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

        seller = None
        commission_amount = 0.0
        if seller_id is not None:
            seller = conn.execute(
                """
                SELECT id, name, commission_percent, is_active
                FROM sellers
                WHERE id = ?
                """,
                (seller_id,),
            ).fetchone()
            if seller is None:
                raise HTTPException(status_code=404, detail="Vendedor no encontrado")
            if not bool(seller["is_active"]):
                raise HTTPException(status_code=400, detail="El vendedor seleccionado esta inactivo")

        affects_stock = document_type in {"FACTURA", "NOTA_CREDITO"}
        creates_cc_movement = document_type in {"FACTURA", "NOTA_CREDITO"}
        stock_delta = -1 if document_type == "FACTURA" else 1 if document_type == "NOTA_CREDITO" else 0
        cc_movement_type = "DEBIT" if document_type == "FACTURA" else "CREDIT"
        cc_entry_kind = "SALE" if document_type == "FACTURA" else "CREDIT_NOTE"

        normalized_items: list[dict[str, Any]] = []
        seen_imeis: set[str] = set()
        subtotal_total = 0.0
        price_list = int(payload.get("price_list") or 0)
        if price_list not in {0, 1, 2}:
            price_list = 0
        payment_method = str(payload.get("payment_method") or "").strip() or None
        special_discount = round(float(payload.get("special_discount") or 0), 2)
        if special_discount < 0:
            raise HTTPException(status_code=400, detail="Descuento especial invalido")
        for raw in items:
            product_id = int((raw or {}).get("product_id") or 0)
            quantity = int((raw or {}).get("quantity") or 0)
            unit_price_payload = (raw or {}).get("unit_price")
            if product_id <= 0 or quantity <= 0:
                raise HTTPException(status_code=400, detail="Items invalidos")
            product = conn.execute(
                """
                SELECT id, name, price, price_list_1, price_list_2, stock, cost, category_id
                FROM products
                WHERE id = ? AND deleted_at IS NULL AND COALESCE(is_active, 1) = 1
                """,
                (product_id,),
            ).fetchone()
            if product is None:
                raise HTTPException(status_code=404, detail=f"Producto {product_id} no encontrado")
            current_stock = int(product["stock"] or 0)
            if document_type == "FACTURA" and current_stock < quantity:
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
            item_imeis = _normalize_imei_list((raw or {}).get("imeis") or [])
            if len(item_imeis) > quantity:
                raise HTTPException(
                    status_code=400,
                    detail=f"El producto {product['name']} tiene mas IMEIs cargados que unidades",
                )
            duplicated_imei = next((imei for imei in item_imeis if imei in seen_imeis), None)
            if duplicated_imei:
                raise HTTPException(status_code=400, detail=f"El IMEI {duplicated_imei} esta repetido en el comprobante")
            seen_imeis.update(item_imeis)
            subtotal = round(quantity * unit_price, 2)
            subtotal_total += subtotal
            normalized_items.append(
                {
                    "product_id": product_id,
                    "quantity": quantity,
                    "unit_price": unit_price,
                    "cost_snapshot": round(float(product["cost"] or 0), 2),
                    "subtotal": subtotal,
                    "imeis": item_imeis,
                }
            )

        if special_discount > round(subtotal_total, 2):
            raise HTTPException(status_code=400, detail="El descuento especial no puede superar el subtotal")
        total = round(subtotal_total - special_discount, 2)
        sale_mode = sale_mode_input or str(customer["sale_mode"] or "").strip().upper() or "CONTADO"
        commission_percent = float(seller["commission_percent"] or 0) if seller is not None else 0.0
        commission_amount = round((round(total, 2) * commission_percent) / 100, 2)
        if DB_IS_POSTGRES:
            # Serialize manual external_ref generation to avoid duplicate values
            # when multiple invoice creations hit the API at the same time.
            conn.execute("LOCK TABLE invoices IN EXCLUSIVE MODE")
        external_ref_row = conn.execute(
            """
            SELECT external_ref
            FROM invoices
            WHERE external_ref IS NOT NULL AND TRIM(external_ref) <> ''
            ORDER BY
                CASE
                    WHEN TRIM(external_ref) ~ '^[0-9]+$' THEN CAST(TRIM(external_ref) AS BIGINT)
                    ELSE 0
                END DESC,
                id DESC
            LIMIT 1
            """
            if DB_IS_POSTGRES
            else
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

        insert_invoice_sql = """
            INSERT INTO invoices (
                customer_id, total, special_discount, created_at, seller_id, document_type, commission_amount,
                sale_mode, price_list, external_ref, due_date, notes, payment_method
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """
        insert_invoice_params = (
            customer_id,
            round(total, 2),
            special_discount,
            created_at,
            seller_id,
            document_type,
            commission_amount,
            sale_mode,
            price_list,
            external_ref,
            due_date,
            notes,
            payment_method,
        )
        if DB_IS_POSTGRES:
            invoice_row = conn.execute(f"{insert_invoice_sql} RETURNING id", insert_invoice_params).fetchone()
            invoice_id = int(invoice_row["id"] if isinstance(invoice_row, dict) else invoice_row[0])
        else:
            conn.execute(insert_invoice_sql, insert_invoice_params)
            invoice_row = conn.execute("SELECT last_insert_rowid() AS id").fetchone()
            invoice_id = int(invoice_row["id"] if isinstance(invoice_row, dict) else invoice_row[0])

        for item in normalized_items:
            conn.execute(
                """
                INSERT INTO invoice_items (invoice_id, product_id, quantity, unit_price, cost_snapshot)
                VALUES (?, ?, ?, ?, ?)
                """,
                (invoice_id, item["product_id"], item["quantity"], item["unit_price"], item["cost_snapshot"]),
            )
            if affects_stock and stock_delta != 0:
                conn.execute(
                    "UPDATE products SET stock = stock + ? WHERE id = ?",
                    (stock_delta * item["quantity"], item["product_id"]),
                )
            if document_type == "FACTURA" and item["imeis"]:
                imei_rows = conn.execute(
                    f"""
                    SELECT imei, sold_invoice_id
                    FROM product_imeis
                    WHERE product_id = ?
                      AND imei IN ({", ".join(["?"] * len(item["imeis"]))})
                    """,
                    [item["product_id"], *item["imeis"]],
                ).fetchall()
                imei_map = {
                    str(row["imei"] if isinstance(row, dict) else row[0]): row
                    for row in imei_rows
                }
                missing_imei = next((imei for imei in item["imeis"] if imei not in imei_map), None)
                if missing_imei:
                    raise HTTPException(status_code=400, detail=f"El IMEI {missing_imei} no pertenece al producto")
                already_sold = next(
                    (
                        imei
                        for imei in item["imeis"]
                        if (imei_map[imei]["sold_invoice_id"] if isinstance(imei_map[imei], dict) else imei_map[imei][1]) is not None
                    ),
                    None,
                )
                if already_sold:
                    sold_invoice_id = imei_map[already_sold]["sold_invoice_id"] if isinstance(imei_map[already_sold], dict) else imei_map[already_sold][1]
                    raise HTTPException(status_code=400, detail=f"El IMEI {already_sold} ya fue vendido en el comprobante #{sold_invoice_id}")
                conn.execute(
                    f"""
                    UPDATE product_imeis
                       SET sold_invoice_id = ?, sold_at = ?
                     WHERE product_id = ?
                       AND imei IN ({", ".join(["?"] * len(item["imeis"]))})
                    """,
                    [invoice_id, created_at, item["product_id"], *item["imeis"]],
                )
            if document_type == "NOTA_CREDITO" and item["imeis"]:
                conn.execute(
                    f"""
                    UPDATE product_imeis
                       SET sold_invoice_id = NULL, sold_at = NULL
                     WHERE product_id = ?
                       AND imei IN ({", ".join(["?"] * len(item["imeis"]))})
                    """,
                    [item["product_id"], *item["imeis"]],
                )

        if creates_cc_movement and sale_mode == "CUENTA_CORRIENTE":
            conn.execute(
                """
                INSERT INTO account_movements (
                    customer_id, invoice_id, amount, movement_type, entry_kind, reference, created_at, payment_method
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    customer_id,
                    invoice_id,
                    round(total, 2),
                    cc_movement_type,
                    cc_entry_kind,
                    f"{document_type} #{invoice_id}",
                    created_at,
                    payment_method,
                ),
            )

        if order_id and document_type in {"FACTURA", "PRESUPUESTO"}:
            next_order_status = "CONFIRMED" if document_type == "FACTURA" else "BUDGETED"
            conn.execute(
                """
                UPDATE web_orders
                   SET status = ?, confirmed_at = ?, confirmed_invoice_id = ?
                 WHERE id = ?
                """,
                (next_order_status, datetime.utcnow().isoformat(), str(invoice_id), order_id),
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
            "seller_id": seller_id,
            "commission_amount": commission_amount,
            "special_discount": special_discount,
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
        _ensure_syncable_tables(conn)
        _ensure_invoice_payment_method_column(conn)
        _ensure_invoice_special_discount_column(conn)
        _ensure_product_imeis_table(conn)
        _ensure_sellers_table(conn)
        invoice = conn.execute(
            """
            SELECT i.id, i.customer_id, i.total, i.special_discount, i.created_at, i.seller_id, i.document_type,
                   i.commission_amount, i.sale_mode, i.price_list, i.external_ref, i.due_date,
                   i.notes, i.payment_method, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
                   c.sale_mode AS customer_sale_mode, c.locality, c.address, c.tax_condition, c.cuit,
                   s.name AS seller_name, s.commission_percent AS seller_commission_percent
            FROM invoices i
            LEFT JOIN customers c ON c.id = i.customer_id
            LEFT JOIN sellers s ON s.id = i.seller_id
            WHERE i.id = ?
            """,
            (invoice_id,),
        ).fetchone()
        if invoice is None:
            raise HTTPException(status_code=404, detail="Comprobante no encontrado")
        items = conn.execute(
            """
            SELECT ii.id, ii.product_id, ii.quantity, ii.unit_price, p.name AS product_name, p.image_path, p.cost
            FROM invoice_items ii
            LEFT JOIN products p ON p.id = ii.product_id
            WHERE ii.invoice_id = ?
            ORDER BY ii.id ASC
            """,
            (invoice_id,),
        ).fetchall()
        sold_imei_rows = conn.execute(
            """
            SELECT product_id, imei
            FROM product_imeis
            WHERE sold_invoice_id = ?
            ORDER BY product_id ASC, imei ASC
            """,
            (invoice_id,),
        ).fetchall()
        sold_imeis_by_product: dict[int, list[str]] = {}
        for row in sold_imei_rows:
            product_id = int(row["product_id"] or 0)
            imei = str(row["imei"] or "").strip()
            if product_id <= 0 or not imei:
                continue
            sold_imeis_by_product.setdefault(product_id, []).append(imei)
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
                    "cost_total": round(quantity * float(row["cost"] or 0), 2),
                    "image_path": row["image_path"],
                    "imeis": sold_imeis_by_product.get(int(row["product_id"]) if row["product_id"] is not None else 0, []),
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
                "special_discount": float(invoice["special_discount"] or 0),
                "created_at": invoice["created_at"],
                "seller_id": int(invoice["seller_id"]) if invoice["seller_id"] is not None else None,
                "seller_name": invoice["seller_name"],
                "seller_commission_percent": float(invoice["seller_commission_percent"] or 0),
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
                "special_discount": float(invoice["special_discount"] or 0),
                "total": float(invoice["total"] or 0),
                "payments_total": round(total_payments, 2),
                "balance_due": balance_due,
            },
        }
    finally:
        conn.close()


@app.put("/admin/invoices/{invoice_id}/seller")
def admin_update_invoice_seller(
    invoice_id: int,
    payload: InvoiceSellerAssignmentPayload,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict[str, Any]:
    _require_admin(session_token)
    conn = _connect()
    try:
        _ensure_syncable_tables(conn)
        _ensure_invoice_special_discount_column(conn)
        _ensure_sellers_table(conn)
        invoice = conn.execute(
            """
            SELECT id, total, document_type, seller_id
            FROM invoices
            WHERE id = ?
            """,
            (invoice_id,),
        ).fetchone()
        if invoice is None:
            raise HTTPException(status_code=404, detail="Comprobante no encontrado")

        seller = conn.execute(
            """
            SELECT id, name, commission_percent, is_active
            FROM sellers
            WHERE id = ?
            """,
            (int(payload.seller_id),),
        ).fetchone()
        if seller is None:
            raise HTTPException(status_code=404, detail="Vendedor no encontrado")
        if not bool(seller["is_active"]):
            raise HTTPException(status_code=400, detail="El vendedor seleccionado esta inactivo")

        current_seller_id = int(invoice["seller_id"] or 0)
        next_seller_id = int(seller["id"] or 0)
        commission_percent = float(seller["commission_percent"] or 0)
        commission_amount = round((float(invoice["total"] or 0) * commission_percent) / 100, 2)

        conn.execute(
            """
            UPDATE invoices
               SET seller_id = ?, commission_amount = ?
             WHERE id = ?
            """,
            (next_seller_id, commission_amount, invoice_id),
        )
        conn.commit()
        return {
            "status": "ok",
            "invoice_id": int(invoice["id"]),
            "document_type": str(invoice["document_type"] or "").strip(),
            "previous_seller_id": current_seller_id if current_seller_id > 0 else None,
            "seller_id": next_seller_id,
            "seller_name": str(seller["name"] or "").strip(),
            "seller_commission_percent": round(commission_percent, 2),
            "commission_amount": commission_amount,
        }
    finally:
        conn.close()


@app.post("/admin/invoices/{invoice_id}/confirm")
def admin_confirm_invoice(
    invoice_id: int,
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict:
    _require_admin(session_token)
    conn = _connect()
    try:
        _ensure_syncable_tables(conn)
        _ensure_invoice_payment_method_column(conn)
        invoice = conn.execute(
            """
            SELECT id, customer_id, total, created_at, document_type, sale_mode, payment_method, seller_id
            FROM invoices
            WHERE id = ?
            """,
            (invoice_id,),
        ).fetchone()
        if invoice is None:
            raise HTTPException(status_code=404, detail="Comprobante no encontrado")

        document_type = str(invoice["document_type"] or "").strip().upper()
        if document_type != "PRESUPUESTO":
            raise HTTPException(status_code=400, detail="Solo se pueden confirmar presupuestos")

        items = conn.execute(
            """
            SELECT ii.product_id, ii.quantity, p.name AS product_name, p.stock
            FROM invoice_items ii
            LEFT JOIN products p ON p.id = ii.product_id
            WHERE ii.invoice_id = ?
            ORDER BY ii.id ASC
            """,
            (invoice_id,),
        ).fetchall()
        if not items:
            raise HTTPException(status_code=400, detail="El presupuesto no tiene items")

        for item in items:
            product_id = int(item["product_id"] or 0)
            quantity = int(item["quantity"] or 0)
            current_stock = int(item["stock"] or 0)
            product_name = item["product_name"] or f"Producto {product_id}"
            if product_id <= 0 or quantity <= 0:
                raise HTTPException(status_code=400, detail="El presupuesto tiene items invalidos")
            if current_stock < quantity:
                raise HTTPException(status_code=400, detail=f"Sin stock suficiente para {product_name}")

        confirmation_created_at = datetime.utcnow().isoformat()
        sale_mode = str(invoice["sale_mode"] or "").strip().upper() or "CONTADO"
        payment_method = str(invoice["payment_method"] or "").strip() or None
        customer_id = int(invoice["customer_id"] or 0)
        seller_id = int(invoice["seller_id"] or 0)
        total = round(float(invoice["total"] or 0), 2)
        if seller_id <= 0:
            raise HTTPException(status_code=400, detail="El presupuesto no tiene vendedor asignado")

        for item in items:
            conn.execute(
                "UPDATE products SET stock = stock - ? WHERE id = ?",
                (int(item["quantity"] or 0), int(item["product_id"] or 0)),
            )

        if sale_mode == "CUENTA_CORRIENTE":
            existing_debit = conn.execute(
                """
                SELECT id
                FROM account_movements
                WHERE invoice_id = ? AND movement_type = 'DEBIT'
                """
                + _active_account_movements_clause(conn)
                + """
                LIMIT 1
                """,
                (invoice_id,),
            ).fetchone()
            if existing_debit is None:
                conn.execute(
                    """
                    INSERT INTO account_movements (
                        customer_id, invoice_id, amount, movement_type, entry_kind, reference, created_at, payment_method
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        customer_id,
                        invoice_id,
                        total,
                        "DEBIT",
                        "SALE",
                        f"FACTURA #{invoice_id}",
                        confirmation_created_at,
                        payment_method,
                    ),
                )

        conn.execute(
            """
            UPDATE invoices
               SET document_type = 'FACTURA', created_at = ?
             WHERE id = ?
            """,
            (confirmation_created_at, invoice_id),
        )
        if _has_table(conn, "web_orders") and _has_column(conn, "web_orders", "confirmed_invoice_id"):
            conn.execute(
                """
                UPDATE web_orders
                   SET status = 'CONFIRMED', confirmed_at = ?
                 WHERE confirmed_invoice_id = ?
                """,
                (confirmation_created_at, invoice_id),
            )
        conn.commit()
        return {
            "id": int(invoice["id"]),
            "customer_id": customer_id if customer_id > 0 else None,
            "document_type": "FACTURA",
            "previous_document_type": "PRESUPUESTO",
            "sale_mode": sale_mode,
            "total": total,
            "created_at": confirmation_created_at,
            "message": "Presupuesto confirmado",
        }
    finally:
        conn.close()


@app.delete("/admin/invoices/{invoice_id}")
def admin_delete_invoice(
    invoice_id: int,
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict:
    _require_admin(session_token)
    conn = _connect()
    try:
        _ensure_syncable_tables(conn)
        _ensure_accounting_tables(conn)
        _ensure_invoice_payment_method_column(conn)
        _ensure_product_imeis_table(conn)
        invoice = conn.execute(
            """
            SELECT id, customer_id, total, document_type, sale_mode
            FROM invoices
            WHERE id = ?
            """,
            (invoice_id,),
        ).fetchone()
        if invoice is None:
            raise HTTPException(status_code=404, detail="Comprobante no encontrado")

        cc_movements = conn.execute(
            """
            SELECT id, amount, movement_type, entry_kind
            FROM account_movements
            WHERE invoice_id = ?
            """
            + _active_account_movements_clause(conn)
            + """
            ORDER BY created_at ASC, id ASC
            """,
            (invoice_id,),
        ).fetchall()
        deleted_document_type = str(invoice["document_type"] or "").strip().upper()
        blocking_movements = []
        for row in cc_movements:
            movement_type = str(row["movement_type"] or "").strip().upper()
            # En notas de credito duplicadas permitimos revertir todos los creditos
            # asociados al mismo comprobante.
            if deleted_document_type == "NOTA_CREDITO" and movement_type == "CREDIT":
                continue
            if movement_type == "CREDIT":
                blocking_movements.append(row)
        if blocking_movements:
            raise HTTPException(
                status_code=400,
                detail="No se puede cancelar un comprobante con pagos o creditos aplicados",
            )

        items = conn.execute(
            """
            SELECT product_id, quantity
            FROM invoice_items
            WHERE invoice_id = ?
            """,
            (invoice_id,),
        ).fetchall()

        restocked_items = 0
        stock_restore_delta = 1 if deleted_document_type == "FACTURA" else -1 if deleted_document_type == "NOTA_CREDITO" else 0
        if stock_restore_delta != 0:
            for item in items:
                product_id = int(item["product_id"] or 0)
                quantity = int(item["quantity"] or 0)
                if product_id <= 0 or quantity <= 0:
                    continue
                conn.execute(
                    "UPDATE products SET stock = stock + ? WHERE id = ?",
                    (stock_restore_delta * quantity, product_id),
                )
                restocked_items += 1
        conn.execute(
            """
            UPDATE product_imeis
               SET sold_invoice_id = NULL, sold_at = NULL
             WHERE sold_invoice_id = ?
            """,
            (invoice_id,),
        )

        # En lugar de DELETE, hacer soft delete y backup de movimientos
        if _has_table(conn, "account_movements"):
            # Guardar backup de todos los movimientos de esta factura
            invoice_movements = conn.execute(
                "SELECT * FROM account_movements WHERE invoice_id = ? AND is_deleted = 0",
                (invoice_id,),
            ).fetchall()
            
            for movement in invoice_movements:
                movement_customer_id = int(movement["customer_id"] or 0)
                if (
                    movement_customer_id > 0
                    and _can_use_accounting_audit(conn, movement_customer_id)
                    and _has_table(conn, "account_movements_backup")
                ):
                    conn.execute(
                        """
                        INSERT INTO account_movements_backup
                        (original_movement_id, customer_id, movement_type, amount, description,
                         document_type, document_number, due_date, invoice_id, reference, entry_kind,
                         payment_method, created_at, deleted_at)
                        SELECT id, customer_id, movement_type, amount, description,
                               document_type, document_number, due_date, invoice_id, reference, entry_kind,
                               payment_method, created_at, CURRENT_TIMESTAMP
                        FROM account_movements
                        WHERE id = ? AND invoice_id = ?
                        """,
                        (movement["id"], invoice_id),
                    )
            
            # Marcar movimientos como eliminados en lugar de borrar
            conn.execute(
                "UPDATE account_movements SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP WHERE invoice_id = ?",
                (invoice_id,),
            )
            
            # Registrar auditoría
            for movement in invoice_movements:
                movement_customer_id = int(movement["customer_id"] or 0)
                if (
                    movement_customer_id > 0
                    and _can_use_accounting_audit(conn, movement_customer_id)
                    and _has_table(conn, "account_movements_audit")
                ):
                    _log_movement_audit(
                        conn,
                        movement["id"],
                        movement_customer_id,
                        "DELETE",
                        old_values=dict(movement) if hasattr(movement, 'keys') else {},
                        edited_by="ADMIN_DELETE_INVOICE",
                    )
        
        conn.execute("DELETE FROM invoice_items WHERE invoice_id = ?", (invoice_id,))
        conn.execute("DELETE FROM invoices WHERE id = ?", (invoice_id,))

        if _has_table(conn, "web_orders") and _has_column(conn, "web_orders", "confirmed_invoice_id"):
            conn.execute(
                """
                UPDATE web_orders
                   SET status = 'PENDING', confirmed_at = NULL, confirmed_invoice_id = NULL
                 WHERE confirmed_invoice_id = ?
                """,
                (invoice_id,),
            )

        conn.commit()
        return {
            "id": int(invoice["id"]),
            "customer_id": int(invoice["customer_id"]) if invoice["customer_id"] is not None else None,
            "document_type": invoice["document_type"],
            "sale_mode": invoice["sale_mode"],
            "total": round(float(invoice["total"] or 0), 2),
            "restocked_items": restocked_items,
            "deleted_account_movements": len(cc_movements),
            "message": "Comprobante cancelado (movimientos preservados en backup)",
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
    entry_kind = str(payload.get("entry_kind") or "").strip().upper()
    invoice_id = payload.get("invoice_id")
    parsed_invoice_id = int(invoice_id) if invoice_id not in (None, "", 0, "0") else None
    created_at = str(payload.get("created_at") or "").strip() or datetime.utcnow().isoformat()
    reference = str(payload.get("reference") or "").strip() or None
    payment_method = str(payload.get("payment_method") or "").strip() or None
    entry_kind, allowed_entry_kinds = _normalize_cc_entry_kind(movement_type, entry_kind)
    if entry_kind not in allowed_entry_kinds:
        raise HTTPException(status_code=400, detail="Concepto de movimiento invalido")

    conn = _connect()
    try:
        _ensure_syncable_tables(conn)
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
            INSERT INTO account_movements (customer_id, invoice_id, amount, movement_type, entry_kind, reference, created_at, payment_method)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (customer_id, parsed_invoice_id, amount, movement_type, entry_kind, reference, created_at, payment_method),
        )
        conn.commit()
        balance_row = conn.execute(
            """
            SELECT amount, movement_type
            FROM account_movements
            WHERE customer_id = ?
            """
            + _active_account_movements_clause(conn)
            + """
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


@app.put("/admin/cc/{customer_id}/movements/{movement_id}")
def admin_cc_update_movement(
    customer_id: int,
    movement_id: int,
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
    entry_kind, allowed_entry_kinds = _normalize_cc_entry_kind(movement_type, payload.get("entry_kind"))
    if entry_kind not in allowed_entry_kinds:
        raise HTTPException(status_code=400, detail="Concepto de movimiento invalido")
    invoice_id = payload.get("invoice_id")
    parsed_invoice_id = int(invoice_id) if invoice_id not in (None, "", 0, "0") else None
    reference = str(payload.get("reference") or "").strip() or None
    payment_method = str(payload.get("payment_method") or "").strip() or None

    conn = _connect()
    try:
        _ensure_syncable_tables(conn)
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
        movement = conn.execute(
            """
            SELECT id, customer_id, invoice_id, movement_type, entry_kind
            FROM account_movements
            WHERE id = ? AND customer_id = ?
            """
            + _active_account_movements_clause(conn)
            ,
            (movement_id, customer_id),
        ).fetchone()
        if movement is None:
            raise HTTPException(status_code=404, detail="Movimiento no encontrado")
        current_entry_kind = str(movement["entry_kind"] or "").strip().upper()
        if int(movement["invoice_id"] or 0) > 0 and (
            str(movement["movement_type"] or "").strip().upper() == "DEBIT" or current_entry_kind == "SALE"
        ):
            raise HTTPException(
                status_code=400,
                detail="No se puede editar un movimiento generado por un comprobante de venta",
            )
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
            UPDATE account_movements
               SET invoice_id = ?, amount = ?, movement_type = ?, entry_kind = ?, reference = ?, payment_method = ?
             WHERE id = ? AND customer_id = ?
            """,
            (parsed_invoice_id, amount, movement_type, entry_kind, reference, payment_method, movement_id, customer_id),
        )
        conn.commit()
        balance_row = conn.execute(
            """
            SELECT amount, movement_type
            FROM account_movements
            WHERE customer_id = ?
            """
            + _active_account_movements_clause(conn)
            + """
            ORDER BY created_at ASC, id ASC
            """,
            (customer_id,),
        ).fetchall()
        return {
            "customer_id": customer_id,
            "movement_id": movement_id,
            "invoice_id": parsed_invoice_id,
            "balance": _customer_current_balance_from_rows(balance_row),
            "message": "Movimiento actualizado",
        }
    finally:
        conn.close()


@app.delete("/admin/cc/{customer_id}/movements/{movement_id}")
def admin_cc_delete_movement(
    customer_id: int,
    movement_id: int,
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict:
    _require_admin(session_token)
    conn = _connect()
    try:
        _ensure_syncable_tables(conn)
        _ensure_accounting_tables(conn)
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
        movement = conn.execute(
            """
            SELECT id, customer_id, invoice_id, movement_type, entry_kind
            FROM account_movements
            WHERE id = ? AND customer_id = ?
            """
            + _active_account_movements_clause(conn)
            ,
            (movement_id, customer_id),
        ).fetchone()
        if movement is None:
            raise HTTPException(status_code=404, detail="Movimiento no encontrado")
        current_entry_kind = str(movement["entry_kind"] or "").strip().upper()
        if int(movement["invoice_id"] or 0) > 0 and (
            str(movement["movement_type"] or "").strip().upper() == "DEBIT" or current_entry_kind == "SALE"
        ):
            raise HTTPException(
                status_code=400,
                detail="No se puede eliminar un movimiento generado por un comprobante de venta",
            )
        success = _soft_delete_movement(conn, movement_id, customer_id, edited_by="ADMIN_DELETE_CC_MOVEMENT")
        if not success:
            raise HTTPException(status_code=400, detail="No se pudo eliminar el movimiento")
        conn.commit()
        balance_row = conn.execute(
            """
            SELECT amount, movement_type
            FROM account_movements
            WHERE customer_id = ?
            """
            + _active_account_movements_clause(conn)
            + """
            ORDER BY created_at ASC, id ASC
            """,
            (customer_id,),
        ).fetchall()
        return {
            "customer_id": customer_id,
            "movement_id": movement_id,
            "balance": _customer_current_balance_from_rows(balance_row),
            "message": "Movimiento eliminado",
        }
    finally:
        conn.close()


@app.get("/admin/reports/overview")
def admin_reports_overview(
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict:
    session_payload = _require_admin(session_token)
    session_role = str(session_payload.get("role") or "").strip().lower() or ROLE_STAFF
    cached_response = _get_admin_overview_cache(session_role)
    if cached_response is not None:
        return cached_response
    conn = _connect()
    try:
        _ensure_syncable_tables(conn)
        _ensure_invoice_special_discount_column(conn)
        _ensure_invoice_items_cost_snapshot_column(conn)
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
        invoice_rows = conn.execute(
            """
            SELECT id, customer_id, total, special_discount, created_at, document_type, sale_mode, seller_id, commission_amount
            FROM invoices
            ORDER BY created_at ASC, id ASC
            """
        ).fetchall()
        invoice_items_rows = conn.execute(
            """
            SELECT ii.invoice_id, ii.product_id, ii.quantity, ii.unit_price, ii.cost_snapshot, i.customer_id, i.created_at, i.seller_id, i.document_type
            FROM invoice_items ii
            LEFT JOIN invoices i ON i.id = ii.invoice_id
            """
        ).fetchall()
        cc_rows = conn.execute(
            """
            SELECT customer_id, amount, movement_type, created_at
            FROM account_movements
            WHERE 1 = 1
            """
            + _active_account_movements_clause(conn)
            + """
            ORDER BY created_at ASC, id ASC
            """
        ).fetchall()
        purchase_rows = (
            conn.execute(
                """
                SELECT total, created_at
                FROM purchases
                ORDER BY created_at ASC, id ASC
                """
            ).fetchall()
            if _has_table(conn, "purchases")
            else []
        )
        expense_rows = (
            conn.execute(
                """
                SELECT amount, created_at
                FROM expenses
                ORDER BY created_at ASC, id ASC
                """
            ).fetchall()
            if _has_table(conn, "expenses")
            else []
        )

        invoices = []
        invoice_sign_map: dict[int, float] = {}
        for row in invoice_rows:
            document_type = str(row["document_type"] or "").strip().upper()
            if document_type == "PRESUPUESTO":
                continue
            sign = -1.0 if document_type == "NOTA_CREDITO" else 1.0
            invoice_sign_map[int(row["id"] or 0)] = sign
            invoices.append(row)

        invoice_items = []
        for row in invoice_items_rows:
            document_type = str(row["document_type"] or "").strip().upper()
            if document_type == "PRESUPUESTO":
                continue
            invoice_items.append(row)

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
        snapshot_stats_by_year: dict[int, dict[str, int]] = {}
        for row in invoices:
            bucket = _argentina_month_bucket(row["created_at"])
            if bucket is None:
                continue
            entry = monthly_map.setdefault(
                bucket,
                {"month": bucket, "sales": 0.0, "count": 0, "margin": 0.0, "expenses": 0.0, "commissions": 0.0},
            )
            sign = -1.0 if str(row["document_type"] or "").strip().upper() == "NOTA_CREDITO" else 1.0
            entry["sales"] += float(row["total"] or 0) * sign
            entry["count"] += 1

        top_products_map: dict[int, dict[str, Any]] = {}
        category_sales_map: dict[str, float] = {}
        customer_sales_map: dict[int, dict[str, Any]] = {}
        seller_margin_map: dict[int, float] = {}
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
            unit_cost = float(row["cost_snapshot"] if row["cost_snapshot"] is not None else cost_by_product.get(product_id, 0.0))
            sign = -1.0 if str(row["document_type"] or "").strip().upper() == "NOTA_CREDITO" else 1.0
            revenue = quantity * unit_price * sign
            margin_value = quantity * max(0.0, unit_price - unit_cost) * sign
            entry["quantity"] += quantity
            entry["revenue"] += revenue
            bucket = _argentina_month_bucket(row["created_at"])
            if bucket is not None:
                try:
                    bucket_year = int(str(bucket).split("-")[0])
                except Exception:
                    bucket_year = 0
                if bucket_year > 0:
                    snapshot_entry = snapshot_stats_by_year.setdefault(bucket_year, {"line_count": 0, "snapshot_count": 0})
                    snapshot_entry["line_count"] += 1
                    if row["cost_snapshot"] is not None:
                        snapshot_entry["snapshot_count"] += 1
                monthly_entry = monthly_map.setdefault(
                    bucket,
                    {"month": bucket, "sales": 0.0, "count": 0, "margin": 0.0, "expenses": 0.0, "commissions": 0.0},
                )
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
            seller_id = int(row["seller_id"] or 0)
            if seller_id > 0:
                seller_margin_map[seller_id] = round(seller_margin_map.get(seller_id, 0.0) + margin_value, 2)
        for row in invoices:
            discount = float(row["special_discount"] or 0)
            if discount <= 0:
                continue
            sign = -1.0 if str(row["document_type"] or "").strip().upper() == "NOTA_CREDITO" else 1.0
            bucket = _argentina_month_bucket(row["created_at"])
            if bucket is not None:
                monthly_entry = monthly_map.setdefault(
                    bucket,
                    {"month": bucket, "sales": 0.0, "count": 0, "margin": 0.0, "expenses": 0.0, "commissions": 0.0},
                )
                monthly_entry["margin"] = round(float(monthly_entry["margin"] or 0) - (discount * sign), 2)
            seller_id = int(row["seller_id"] or 0)
            if seller_id > 0:
                seller_margin_map[seller_id] = round(seller_margin_map.get(seller_id, 0.0) - (discount * sign), 2)
        for row in invoices:
            bucket = _argentina_month_bucket(row["created_at"])
            if bucket is None:
                continue
            monthly_entry = monthly_map.setdefault(
                bucket,
                {"month": bucket, "sales": 0.0, "count": 0, "margin": 0.0, "expenses": 0.0, "commissions": 0.0},
            )
            sign = -1.0 if str(row["document_type"] or "").strip().upper() == "NOTA_CREDITO" else 1.0
            monthly_entry["commissions"] = round(
                float(monthly_entry["commissions"] or 0) + (float(row["commission_amount"] or 0) * sign),
                2,
            )
        for row in expense_rows:
            bucket = _argentina_month_bucket(row["created_at"])
            if bucket is None:
                continue
            monthly_entry = monthly_map.setdefault(
                bucket,
                {"month": bucket, "sales": 0.0, "count": 0, "margin": 0.0, "expenses": 0.0, "commissions": 0.0},
            )
            monthly_entry["expenses"] = round(float(monthly_entry["expenses"] or 0) + float(row["amount"] or 0), 2)
        monthly_sales_all = [
            {
                **monthly_map[key],
                "sales": round(float(monthly_map[key]["sales"] or 0), 2),
                "margin": round(float(monthly_map[key]["margin"] or 0), 2),
                "expenses": round(float(monthly_map[key]["expenses"] or 0), 2),
                "commissions": round(float(monthly_map[key]["commissions"] or 0), 2),
                "operating_result": round(
                    float(monthly_map[key]["margin"] or 0)
                    - float(monthly_map[key]["expenses"] or 0)
                    - float(monthly_map[key]["commissions"] or 0),
                    2,
                ),
            }
            for key in sorted(monthly_map.keys())
        ]
        annual_profit_map: dict[int, dict[str, float]] = {}
        if _has_table(conn, "annual_balances"):
            annual_balance_rows = conn.execute(
                """
                SELECT year, total_sales, total_profit
                FROM annual_balances
                WHERE COALESCE(total_sales, 0) > 0 AND COALESCE(total_profit, 0) > 0
                ORDER BY year ASC
                """
            ).fetchall()
            annual_profit_map = {
                int(row["year"]): {
                    "total_sales": round(float(row["total_sales"] or 0), 2),
                    "total_profit": round(float(row["total_profit"] or 0), 2),
                }
                for row in annual_balance_rows
                if row["year"] is not None
            }
        monthly_items_by_year: dict[int, list[dict[str, Any]]] = {}
        for item in monthly_sales_all:
            try:
                item_year = int(str(item["month"]).split("-")[0])
            except Exception:
                continue
            monthly_items_by_year.setdefault(item_year, []).append(item)
        for year, items in monthly_items_by_year.items():
            annual_profit_payload = annual_profit_map.get(year)
            snapshot_stats = snapshot_stats_by_year.get(year, {"line_count": 0, "snapshot_count": 0})
            line_count = int(snapshot_stats.get("line_count", 0) or 0)
            snapshot_count = int(snapshot_stats.get("snapshot_count", 0) or 0)
            snapshot_coverage = (snapshot_count / line_count) if line_count > 0 else 1.0
            if annual_profit_payload is None or snapshot_coverage >= 0.95:
                continue
            annual_sales_value = float(annual_profit_payload.get("total_sales", 0.0) or 0.0)
            annual_profit_value = float(annual_profit_payload.get("total_profit", 0.0) or 0.0)
            if annual_sales_value <= 0 or annual_profit_value <= 0:
                continue
            annual_profit_ratio = annual_profit_value / annual_sales_value
            stable_ratios = [
                float(item["margin"] or 0) / float(item["sales"] or 0)
                for item in items
                if float(item["sales"] or 0) > 0
                and abs((float(item["margin"] or 0) / float(item["sales"] or 0)) - annual_profit_ratio) <= 0.06
            ]
            baseline_ratio = (
                sum(stable_ratios) / len(stable_ratios)
                if len(stable_ratios) >= 4
                else annual_profit_ratio
            )
            for item in items:
                sales_value = float(item["sales"] or 0)
                current_margin_value = float(item["margin"] or 0)
                current_ratio = (current_margin_value / sales_value) if sales_value > 0 else None
                should_adjust = current_ratio is not None and abs(current_ratio - baseline_ratio) >= 0.06
                item["adjusted_margin"] = round(sales_value * baseline_ratio, 2) if should_adjust else None
                item["adjusted_operating_result"] = (
                    round(
                        (sales_value * baseline_ratio)
                        - float(item["expenses"] or 0)
                        - float(item["commissions"] or 0),
                        2,
                    )
                    if should_adjust
                    else None
                )
                item["margin_adjustment_applied"] = bool(should_adjust)
                item["margin_adjustment_label"] = (
                    "Ajustado con rentabilidad historica anual"
                    if should_adjust
                    else None
                )
                item["annual_profit_ratio"] = round(annual_profit_ratio * 100, 2)
                item["adjusted_margin_ratio"] = round(baseline_ratio * 100, 2) if should_adjust else None
        monthly_sales = monthly_sales_all[-12:]
        product_names = {int(row["id"]): row["name"] for row in products}
        seller_names = {
            int(row["id"]): row["name"]
            for row in conn.execute("SELECT id, name FROM sellers WHERE COALESCE(is_active, 1) = 1").fetchall()
            if row["id"] is not None
        }
        seller_sales_map: dict[int, dict[str, Any]] = {}
        for row in invoices:
            seller_id = int(row["seller_id"] or 0)
            if seller_id <= 0:
                continue
            seller_entry = seller_sales_map.setdefault(
                seller_id,
                {
                    "seller_id": seller_id,
                    "sales": 0.0,
                    "commission": 0.0,
                    "invoice_count": 0,
                },
            )
            sign = -1.0 if str(row["document_type"] or "").strip().upper() == "NOTA_CREDITO" else 1.0
            seller_entry["sales"] += float(row["total"] or 0) * sign
            seller_entry["commission"] += float(row["commission_amount"] or 0) * sign
            seller_entry["invoice_count"] += 1
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

        cash_events: list[tuple[datetime, float]] = []
        for row in invoices:
            created = _argentina_datetime(row["created_at"])
            if created is None:
                continue
            sale_mode = str(row["sale_mode"] or "").strip().upper()
            if sale_mode != "CUENTA_CORRIENTE":
                sign = -1.0 if str(row["document_type"] or "").strip().upper() == "NOTA_CREDITO" else 1.0
                cash_events.append((created, round(float(row["total"] or 0) * sign, 2)))
        for row in cc_rows:
            created = _argentina_datetime(row["created_at"])
            if created is None:
                continue
            if str(row["movement_type"] or "").strip().upper() == "CREDIT":
                cash_events.append((created, round(float(row["amount"] or 0), 2)))
        for row in purchase_rows:
            created = _argentina_datetime(row["created_at"])
            if created is None:
                continue
            cash_events.append((created, -round(float(row["total"] or 0), 2)))
        for row in expense_rows:
            created = _argentina_datetime(row["created_at"])
            if created is None:
                continue
            cash_events.append((created, -round(float(row["amount"] or 0), 2)))
        cash_events.sort(key=lambda item: item[0])
        cash_on_hand = 0.0
        cash_balance_end_by_year: dict[int, float] = {}
        for created, amount in cash_events:
            cash_on_hand = round(cash_on_hand + amount, 2)
            cash_balance_end_by_year[created.year] = cash_on_hand
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
        sales_by_seller = sorted(
            [
                {
                    **payload,
                    "name": seller_names.get(seller_id, f"Vendedor {seller_id}"),
                    "sales": round(float(payload["sales"] or 0), 2),
                    "commission": round(float(payload["commission"] or 0), 2),
                    "margin": round(float(seller_margin_map.get(seller_id, 0.0) or 0), 2),
                }
                for seller_id, payload in seller_sales_map.items()
            ],
            key=lambda item: (-item["sales"], item["name"].lower()),
        )[:12]

        total_sales = round(
            sum(
                float(row["total"] or 0) * (-1.0 if str(row["document_type"] or "").strip().upper() == "NOTA_CREDITO" else 1.0)
                for row in invoices
            ),
            2,
        )
        total_margin = round(
            sum(
                int(row["quantity"] or 0)
                * max(
                    0.0,
                    float(row["unit_price"] or 0)
                    - float(
                        row["cost_snapshot"]
                        if row["cost_snapshot"] is not None
                        else cost_by_product.get(int(row["product_id"] or 0), 0.0)
                    )
                )
                * (-1.0 if str(row["document_type"] or "").strip().upper() == "NOTA_CREDITO" else 1.0)
                for row in invoice_items
            )
            - sum(
                float(row["special_discount"] or 0)
                * (-1.0 if str(row["document_type"] or "").strip().upper() == "NOTA_CREDITO" else 1.0)
                for row in invoices
            ),
            2,
        )
        total_purchases = round(sum(float(row["total"] or 0) for row in purchase_rows), 2)
        total_expenses = round(sum(float(row["amount"] or 0) for row in expense_rows), 2)
        total_commissions = round(
            sum(
                float(row["commission_amount"] or 0) * (-1.0 if str(row["document_type"] or "").strip().upper() == "NOTA_CREDITO" else 1.0)
                for row in invoices
            ),
            2,
        )
        operating_result = round(total_margin - total_expenses - total_commissions, 2)
        yearly_map: dict[int, dict[str, Any]] = {}
        for item in monthly_sales_all:
            try:
                year = int(str(item["month"]).split("-")[0])
            except Exception:
                continue
            entry = yearly_map.setdefault(
                year,
                {
                    "year": year,
                    "sales": 0.0,
                    "margin": 0.0,
                    "count": 0,
                    "purchases": 0.0,
                    "expenses": 0.0,
                    "commissions": 0.0,
                },
            )
            entry["sales"] += float(item["sales"] or 0)
            entry["margin"] += float(item["margin"] or 0)
            entry["count"] += int(item["count"] or 0)
        for row in purchase_rows:
            created = _argentina_datetime(row["created_at"])
            if created is None:
                continue
            entry = yearly_map.setdefault(
                created.year,
                {"year": created.year, "sales": 0.0, "margin": 0.0, "count": 0, "purchases": 0.0, "expenses": 0.0, "commissions": 0.0},
            )
            entry["purchases"] += float(row["total"] or 0)
        for row in expense_rows:
            created = _argentina_datetime(row["created_at"])
            if created is None:
                continue
            entry = yearly_map.setdefault(
                created.year,
                {"year": created.year, "sales": 0.0, "margin": 0.0, "count": 0, "purchases": 0.0, "expenses": 0.0, "commissions": 0.0},
            )
            entry["expenses"] += float(row["amount"] or 0)
        for row in invoices:
            created = _argentina_datetime(row["created_at"])
            if created is None:
                continue
            entry = yearly_map.setdefault(
                created.year,
                {"year": created.year, "sales": 0.0, "margin": 0.0, "count": 0, "purchases": 0.0, "expenses": 0.0, "commissions": 0.0},
            )
            sign = -1.0 if str(row["document_type"] or "").strip().upper() == "NOTA_CREDITO" else 1.0
            entry["commissions"] += float(row["commission_amount"] or 0) * sign

        now_dt = _argentina_now()
        current_year = now_dt.year
        current_month = now_dt.month
        current_year_months = [item for item in monthly_sales_all if str(item["month"]).startswith(f"{current_year}-")]
        previous_year_months = [item for item in monthly_sales_all if str(item["month"]).startswith(f"{current_year - 1}-")]
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

        year_end_cc_balance: dict[int, float] = {}
        running_cc_balance = 0.0
        for row in cc_rows:
            created = _argentina_datetime(row["created_at"])
            if created is None:
                continue
            amount = float(row["amount"] or 0)
            signed = amount if str(row["movement_type"] or "").upper() == "DEBIT" else -amount
            running_cc_balance = round(running_cc_balance + signed, 2)
            year_end_cc_balance[created.year] = running_cc_balance

        annual_history: list[dict[str, Any]] = []
        previous_year_sales_value = 0.0
        previous_year_capital_value = 0.0
        for year in sorted(yearly_map.keys()):
            payload = yearly_map[year]
            annual_profit_payload = annual_profit_map.get(year)
            cc_balance_end = round(float(year_end_cc_balance.get(year, 0.0)), 2)
            cash_balance_end = round(float(cash_balance_end_by_year.get(year, 0.0)), 2)
            capital_total = round(stock_value_sale + cc_balance_end, 2)
            sales_value = round(float(payload["sales"] or 0), 2)
            expenses_value = round(float(payload["expenses"] or 0), 2)
            purchases_value = round(float(payload["purchases"] or 0), 2)
            commissions_value = round(float(payload["commissions"] or 0), 2)
            margin_value = round(
                float(annual_profit_payload["total_profit"])
                if annual_profit_payload is not None
                else float(payload["margin"] or 0),
                2,
            )
            operating_result_value = round(margin_value - expenses_value - commissions_value, 2)
            sales_growth_pct = (
                round(((sales_value - previous_year_sales_value) / previous_year_sales_value) * 100, 2)
                if previous_year_sales_value > 0
                else None
            )
            capital_growth_pct = (
                round(((capital_total - previous_year_capital_value) / previous_year_capital_value) * 100, 2)
                if previous_year_capital_value > 0
                else None
            )
            annual_history.append(
                {
                    "year": year,
                    "sales": sales_value,
                    "margin": margin_value,
                    "purchases": purchases_value,
                    "expenses": expenses_value,
                    "commissions": commissions_value,
                    "operating_result": operating_result_value,
                    "invoice_count": int(payload["count"] or 0),
                    "cc_balance_end": cc_balance_end,
                    "cash_balance_end": cash_balance_end,
                    "capital_total": capital_total,
                    "sales_growth_pct": sales_growth_pct,
                    "capital_growth_pct": capital_growth_pct,
                }
            )
            previous_year_sales_value = sales_value
            previous_year_capital_value = capital_total

        current_year_comparison: list[dict[str, Any]] = []
        previous_month_map = {str(item["month"]): item for item in previous_year_months}
        for item in current_year_months:
            month_key = str(item["month"])
            month_number = month_key.split("-")[1]
            previous_key = f"{current_year - 1}-{month_number}"
            previous_item = previous_month_map.get(previous_key, {})
            sales_value = round(float(item["sales"] or 0), 2)
            margin_value = round(float(item["margin"] or 0), 2)
            adjusted_margin_value = (
                round(float(item["adjusted_margin"] or 0), 2)
                if item.get("adjusted_margin") is not None
                else None
            )
            margin_display_value = adjusted_margin_value if adjusted_margin_value is not None else margin_value
            expenses_value = round(float(item["expenses"] or 0), 2)
            operating_result_value = round(
                float(
                    item["adjusted_operating_result"]
                    if item.get("adjusted_operating_result") is not None
                    else item["operating_result"] or 0
                ),
                2,
            )
            previous_sales = round(float(previous_item.get("sales") or 0), 2)
            previous_margin = round(float(previous_item.get("margin") or 0), 2)
            previous_adjusted_margin = (
                round(float(previous_item.get("adjusted_margin") or 0), 2)
                if previous_item.get("adjusted_margin") is not None
                else None
            )
            previous_margin_display = (
                previous_adjusted_margin if previous_adjusted_margin is not None else previous_margin
            )
            previous_expenses = round(float(previous_item.get("expenses") or 0), 2)
            previous_operating_result = round(float(previous_item.get("operating_result") or 0), 2)
            sales_growth_pct = (
                round(((sales_value - previous_sales) / previous_sales) * 100, 2)
                if previous_sales > 0
                else None
            )
            margin_growth_pct = (
                round(((margin_display_value - previous_margin_display) / previous_margin_display) * 100, 2)
                if previous_margin_display > 0
                else None
            )
            operating_result_growth_pct = (
                round(((operating_result_value - previous_operating_result) / previous_operating_result) * 100, 2)
                if previous_operating_result > 0
                else None
            )
            current_year_comparison.append(
                {
                    "month": month_key,
                    "sales": sales_value,
                    "margin": margin_value,
                    "adjusted_margin": adjusted_margin_value,
                    "margin_display": adjusted_margin_value if adjusted_margin_value is not None else margin_value,
                    "margin_adjustment_applied": bool(item.get("margin_adjustment_applied")),
                    "margin_adjustment_label": item.get("margin_adjustment_label"),
                    "expenses": expenses_value,
                    "operating_result": operating_result_value,
                    "count": int(item["count"] or 0),
                    "previous_year_sales": previous_sales,
                    "previous_year_margin": previous_margin,
                    "previous_year_adjusted_margin": previous_adjusted_margin,
                    "previous_year_margin_display": previous_margin_display,
                    "previous_year_margin_adjustment_applied": bool(previous_item.get("margin_adjustment_applied")),
                    "previous_year_margin_adjustment_label": previous_item.get("margin_adjustment_label"),
                    "previous_year_expenses": previous_expenses,
                    "previous_year_operating_result": previous_operating_result,
                    "sales_growth_pct": sales_growth_pct,
                    "margin_growth_pct": margin_growth_pct,
                    "operating_result_growth_pct": operating_result_growth_pct,
                }
            )

        response = {
            "summary": {
                "products": len(products),
                "active_customers": len(customer_names),
                "stock_units": total_stock_units,
                "stock_value_cost": stock_value_cost,
                "stock_value_sale": stock_value_sale,
                "sales_count": len(invoices),
                "sales_total": total_sales,
                "estimated_margin": total_margin,
                "purchases_total": total_purchases,
                "expenses_total": total_expenses,
                "commissions_total": total_commissions,
                "operating_result": operating_result,
                "cc_open_balance": round(sum(customer_balance_map.values()), 2),
                "cash_on_hand": cash_on_hand,
                "account_movements": len(cc_rows),
                "debtors": len([balance for balance in customer_balance_map.values() if balance > 0]),
                "latest_invoice_at": invoices[-1]["created_at"] if invoices else None,
            },
            "monthly_sales": monthly_sales,
            "monthly_sales_all": monthly_sales_all,
            "top_products": top_products,
            "top_customers": top_customers,
            "sales_by_category": sales_by_category,
            "sales_by_seller": sales_by_seller,
            "top_debtors": top_debtors,
            "low_stock": low_stock,
            "current_year_detail": {
                "year": current_year,
                "capital_total": round(stock_value_sale + round(sum(customer_balance_map.values()), 2), 2),
                "sales_total": current_ytd_sales,
                "margin_total": round(sum(float(item["margin"] or 0) for item in current_year_months), 2),
                "purchases_total": round(
                    sum(float(row["total"] or 0) for row in purchase_rows if (_safe_parse_datetime(row["created_at"]) or now_dt).year == current_year),
                    2,
                ),
                "expenses_total": round(
                    sum(float(row["amount"] or 0) for row in expense_rows if (_safe_parse_datetime(row["created_at"]) or now_dt).year == current_year),
                    2,
                ),
                "commissions_total": round(
                    sum(float(row["commission_amount"] or 0) for row in invoices if (_safe_parse_datetime(row["created_at"]) or now_dt).year == current_year),
                    2,
                ),
                "operating_result_total": round(
                    sum(float(item["margin"] or 0) for item in current_year_months)
                    - sum(float(row["amount"] or 0) for row in expense_rows if (_safe_parse_datetime(row["created_at"]) or now_dt).year == current_year)
                    - sum(float(row["commission_amount"] or 0) for row in invoices if (_safe_parse_datetime(row["created_at"]) or now_dt).year == current_year),
                    2,
                ),
                "cash_on_hand": cash_on_hand,
                "months": current_year_comparison,
            },
            "annual_history": annual_history,
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
        if str(session_payload.get("role") or "").strip().lower() == ROLE_STAFF:
            return _set_admin_overview_cache(session_role, {
                "summary": {
                    "products": len(products),
                    "active_customers": len(customer_names),
                    "stock_units": total_stock_units,
                    "stock_value_cost": stock_value_cost,
                    "stock_value_sale": stock_value_sale,
                    "sales_count": len(invoices),
                    "sales_total": total_sales,
                    "estimated_margin": None,
                    "operating_result": None,
                    "cc_open_balance": round(sum(customer_balance_map.values()), 2),
                    "cash_on_hand": cash_on_hand,
                    "account_movements": len(cc_rows),
                    "debtors": len([balance for balance in customer_balance_map.values() if balance > 0]),
                    "latest_invoice_at": invoices[-1]["created_at"] if invoices else None,
                },
                "monthly_sales": [],
                "monthly_sales_all": [],
                "top_products": [],
                "top_customers": [],
                "sales_by_category": [],
                "sales_by_seller": [],
                "top_debtors": top_debtors,
                "low_stock": low_stock,
                "current_year_detail": None,
                "annual_history": [],
                "year_projection": None,
            })
        return _set_admin_overview_cache(session_role, response)
    finally:
        conn.close()


@app.get("/admin/reports/daily")
def admin_reports_daily(
    report_date: Optional[str] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict:
    _require_full_admin(session_token)
    target_date = _argentina_now().date()
    range_start = None
    range_end = None
    if report_date:
        try:
            target_date = datetime.strptime(report_date, "%Y-%m-%d").date()
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Fecha invalida. Usa YYYY-MM-DD.") from exc
    if start_date:
        try:
            range_start = datetime.strptime(start_date, "%Y-%m-%d").date()
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Fecha inicial invalida. Usa YYYY-MM-DD.") from exc
    if end_date:
        try:
            range_end = datetime.strptime(end_date, "%Y-%m-%d").date()
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Fecha final invalida. Usa YYYY-MM-DD.") from exc
    if range_start and range_end and range_start > range_end:
        raise HTTPException(status_code=400, detail="La fecha inicial no puede ser mayor a la final")
    effective_start = range_start or target_date
    effective_end = range_end or target_date
    conn = _connect()
    try:
        _ensure_syncable_tables(conn)
        _ensure_invoice_special_discount_column(conn)
        _ensure_sellers_table(conn)
        invoices = conn.execute(
            """
            SELECT i.id, i.customer_id, i.total, i.special_discount, i.created_at, i.document_type,
                   i.seller_id, i.commission_amount, c.name AS customer_name, s.name AS seller_name
            FROM invoices i
            LEFT JOIN customers c ON c.id = i.customer_id
            LEFT JOIN sellers s ON s.id = i.seller_id
            ORDER BY i.created_at ASC, i.id ASC
            """
        ).fetchall()
        selected_invoices: list[dict[str, Any]] = []
        invoice_ids: list[int] = []
        customer_summary: dict[int, dict[str, Any]] = {}
        seller_summary: dict[int, dict[str, Any]] = {}
        for row in invoices:
            created_date = _argentina_date_for_filter(row["created_at"])
            if created_date is None or created_date < effective_start or created_date > effective_end:
                continue
            document_type = str(row["document_type"] or "").strip().upper()
            if document_type == "PRESUPUESTO":
                continue
            invoice_id = int(row["id"] or 0)
            sign = -1.0 if document_type == "NOTA_CREDITO" else 1.0
            total = round(float(row["total"] or 0) * sign, 2)
            customer_id = int(row["customer_id"] or 0)
            selected_invoices.append(
                {
                    "id": invoice_id,
                    "customer_id": customer_id,
                    "customer_name": row["customer_name"] or (f"Cliente {customer_id}" if customer_id > 0 else "Cliente"),
                    "total": total,
                    "special_discount": float(row["special_discount"] or 0),
                    "created_at": row["created_at"],
                    "document_type": row["document_type"],
                }
            )
            invoice_ids.append(invoice_id)
            customer_entry = customer_summary.setdefault(
                customer_id,
                {
                    "customer_id": customer_id,
                    "name": row["customer_name"] or (f"Cliente {customer_id}" if customer_id > 0 else "Cliente"),
                    "invoice_count": 0,
                    "sales": 0.0,
                },
            )
            customer_entry["invoice_count"] += 1
            customer_entry["sales"] = round(float(customer_entry["sales"]) + total, 2)

            seller_id = int(row["seller_id"] or 0)
            if seller_id > 0:
                seller_entry = seller_summary.setdefault(
                    seller_id,
                    {
                        "seller_id": seller_id,
                        "name": row["seller_name"] or f"Vendedor {seller_id}",
                        "sales": 0.0,
                        "commission": 0.0,
                        "invoice_count": 0,
                    },
                )
                seller_entry["invoice_count"] += 1
                seller_entry["sales"] = round(float(seller_entry["sales"]) + total, 2)
                seller_entry["commission"] = round(
                    float(seller_entry["commission"]) + (float(row["commission_amount"] or 0) * sign),
                    2,
                )

        product_rows: list[dict[str, Any]] = []
        if invoice_ids:
            placeholders = ",".join(["?"] * len(invoice_ids))
            product_rows = [
                dict(row)
                for row in conn.execute(
                    f"""
                    SELECT ii.invoice_id, ii.product_id, ii.quantity, ii.unit_price, p.name AS product_name, p.cost
                    FROM invoice_items ii
                    LEFT JOIN products p ON p.id = ii.product_id
                    WHERE ii.invoice_id IN ({placeholders})
                    """,
                    tuple(invoice_ids),
                ).fetchall()
            ]

        product_summary: dict[int, dict[str, Any]] = {}
        total_margin = 0.0
        for row in product_rows:
            product_id = int(row.get("product_id") or 0)
            quantity = int(row.get("quantity") or 0)
            unit_price = float(row.get("unit_price") or 0)
            invoice_id = int(row.get("invoice_id") or 0)
            related_invoice = next((item for item in selected_invoices if int(item["id"]) == invoice_id), None)
            sign = -1.0 if related_invoice and str(related_invoice.get("document_type") or "").strip().upper() == "NOTA_CREDITO" else 1.0
            revenue = round(quantity * unit_price * sign, 2)
            cost = float(row.get("cost") or 0)
            total_margin += quantity * max(0.0, unit_price - cost) * sign
            product_entry = product_summary.setdefault(
                product_id,
                {
                    "product_id": product_id,
                    "name": row.get("product_name") or (f"Producto {product_id}" if product_id > 0 else "Producto"),
                    "quantity": 0,
                    "sales": 0.0,
                },
            )
            product_entry["quantity"] += quantity
            product_entry["sales"] = round(float(product_entry["sales"]) + revenue, 2)

        total_margin = round(
            total_margin
            - sum(
                float(item.get("special_discount") or 0)
                * (-1.0 if str(item.get("document_type") or "").strip().upper() == "NOTA_CREDITO" else 1.0)
                for item in selected_invoices
            ),
            2,
        )

        products = sorted(
            [
                {
                    **payload,
                    "avg_price": round(float(payload["sales"]) / max(int(payload["quantity"]), 1), 2),
                }
                for payload in product_summary.values()
            ],
            key=lambda item: (-item["sales"], item["name"].lower()),
        )[:20]

        customers = sorted(
            [
                {
                    **payload,
                    "avg_ticket": round(float(payload["sales"]) / max(int(payload["invoice_count"]), 1), 2),
                }
                for payload in customer_summary.values()
            ],
            key=lambda item: (-item["sales"], item["name"].lower()),
        )[:20]
        sellers = sorted(
            [
                {
                    **payload,
                    "sales": round(float(payload["sales"]), 2),
                    "commission": round(float(payload["commission"]), 2),
                }
                for payload in seller_summary.values()
            ],
            key=lambda item: (-item["commission"], item["name"].lower()),
        )[:20]

        total_sales = round(sum(float(item["total"]) for item in selected_invoices), 2)
        total_commissions = round(sum(float(item["commission"]) for item in sellers), 2)
        invoice_count = len(selected_invoices)
        return {
            "date": target_date.isoformat(),
            "start_date": effective_start.isoformat(),
            "end_date": effective_end.isoformat(),
            "is_range": effective_start != effective_end,
            "label": effective_start.isoformat() if effective_start == effective_end else f"{effective_start.isoformat()} al {effective_end.isoformat()}",
            "summary": {
                "sales": total_sales,
                "margin": round(total_margin, 2),
                "commissions": total_commissions,
                "invoice_count": invoice_count,
                "avg_ticket": round(total_sales / invoice_count, 2) if invoice_count else 0.0,
            },
            "products": products,
            "customers": customers,
            "sellers": sellers,
            "invoices": selected_invoices,
        }
    finally:
        conn.close()


@app.get("/admin/reports/customer-ranking")
def admin_reports_customer_ranking(
    limit: int = 20,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict:
    session_payload = _require_admin(session_token)
    session_role = str(session_payload.get("role") or "").strip().lower() or ROLE_STAFF
    safe_limit = max(1, min(int(limit or 20), 50))
    current_year = _argentina_now().year
    conn = _connect()
    try:
        _ensure_syncable_tables(conn)
        _ensure_invoice_special_discount_column(conn)
        _ensure_invoice_items_cost_snapshot_column(conn)
        invoice_rows = conn.execute(
            """
            SELECT i.id, i.customer_id, i.total, i.special_discount, i.created_at, i.document_type, c.name AS customer_name
            FROM invoices i
            LEFT JOIN customers c ON c.id = i.customer_id
            ORDER BY i.created_at ASC, i.id ASC
            """
        ).fetchall()
        selected_invoices: list[dict[str, Any]] = []
        invoice_ids: list[int] = []
        customer_summary: dict[int, dict[str, Any]] = {}
        for row in invoice_rows:
            created = _argentina_datetime(row["created_at"])
            if created is None or created.year != current_year:
                continue
            document_type = str(row["document_type"] or "").strip().upper()
            if document_type == "PRESUPUESTO":
                continue
            invoice_id = int(row["id"] or 0)
            customer_id = int(row["customer_id"] or 0)
            sign = -1.0 if document_type == "NOTA_CREDITO" else 1.0
            total = round(float(row["total"] or 0) * sign, 2)
            discount = round(float(row["special_discount"] or 0) * sign, 2)
            invoice_payload = {
                "id": invoice_id,
                "customer_id": customer_id,
                "document_type": document_type,
                "discount": discount,
            }
            selected_invoices.append(invoice_payload)
            invoice_ids.append(invoice_id)
            customer_entry = customer_summary.setdefault(
                customer_id,
                {
                    "customer_id": customer_id,
                    "name": row["customer_name"] or (f"Cliente {customer_id}" if customer_id > 0 else "Cliente"),
                    "invoice_count": 0,
                    "sales_total": 0.0,
                    "profit_total": 0.0,
                },
            )
            customer_entry["invoice_count"] += 1
            customer_entry["sales_total"] = round(float(customer_entry["sales_total"]) + total, 2)

        if invoice_ids:
            placeholders = ",".join(["?"] * len(invoice_ids))
            invoice_item_rows = conn.execute(
                f"""
                SELECT ii.invoice_id, ii.product_id, ii.quantity, ii.unit_price, ii.cost_snapshot, p.cost
                FROM invoice_items ii
                LEFT JOIN products p ON p.id = ii.product_id
                WHERE ii.invoice_id IN ({placeholders})
                """,
                tuple(invoice_ids),
            ).fetchall()
            invoice_map = {int(item["id"]): item for item in selected_invoices}
            for row in invoice_item_rows:
                invoice_id = int(row["invoice_id"] or 0)
                invoice_payload = invoice_map.get(invoice_id)
                if invoice_payload is None:
                    continue
                customer_id = int(invoice_payload["customer_id"] or 0)
                customer_entry = customer_summary.get(customer_id)
                if customer_entry is None:
                    continue
                sign = -1.0 if str(invoice_payload["document_type"] or "").strip().upper() == "NOTA_CREDITO" else 1.0
                quantity = int(row["quantity"] or 0)
                unit_price = float(row["unit_price"] or 0)
                cost = float(row["cost_snapshot"] if row["cost_snapshot"] is not None else row["cost"] or 0)
                margin = quantity * max(0.0, unit_price - cost) * sign
                customer_entry["profit_total"] = round(float(customer_entry["profit_total"]) + margin, 2)
            for invoice_payload in selected_invoices:
                customer_id = int(invoice_payload["customer_id"] or 0)
                customer_entry = customer_summary.get(customer_id)
                if customer_entry is None:
                    continue
                customer_entry["profit_total"] = round(
                    float(customer_entry["profit_total"]) - float(invoice_payload["discount"] or 0),
                    2,
                )

        ranking = sorted(
            [
                {
                    "customer_id": int(payload["customer_id"] or 0),
                    "name": payload["name"],
                    "invoice_count": int(payload["invoice_count"] or 0),
                    "sales_total": round(float(payload["sales_total"] or 0), 2),
                    "profit_total": round(float(payload["profit_total"] or 0), 2),
                }
                for payload in customer_summary.values()
                if abs(float(payload["sales_total"] or 0)) > 0
            ],
            key=lambda item: (-item["sales_total"], item["name"].lower()),
        )[:safe_limit]

        response = {
            "year": current_year,
            "limit": safe_limit,
            "customers": ranking,
            "summary": {
                "sales_total": round(sum(float(item["sales_total"] or 0) for item in ranking), 2),
                "profit_total": round(sum(float(item["profit_total"] or 0) for item in ranking), 2),
            },
        }
        if session_role == ROLE_STAFF:
            return {
                **response,
                "customers": [{**item, "profit_total": None} for item in ranking],
                "summary": {
                    "sales_total": response["summary"]["sales_total"],
                    "profit_total": None,
                },
            }
        return response
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


@app.delete("/admin/account-customers/{customer_id}")
def admin_delete_account_customer(
    customer_id: int,
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict:
    _require_admin(session_token)
    conn = _connect()
    try:
        _ensure_accounting_tables(conn)
        customer = conn.execute(
            "SELECT id, name FROM account_customers WHERE id = ?",
            (customer_id,),
        ).fetchone()
        if customer is None:
            raise HTTPException(status_code=404, detail="Cliente no encontrado")

        # En lugar de DELETE, hacer soft delete y backup
        # 1. Guardar backup de todos los movimientos
        movements = conn.execute(
            "SELECT * FROM account_movements WHERE customer_id = ? AND is_deleted = 0",
            (customer_id,),
        ).fetchall()
        
        for movement in movements:
            conn.execute(
                """
                INSERT INTO account_movements_backup
                (original_movement_id, customer_id, movement_type, amount, description,
                 document_type, document_number, due_date, invoice_id, reference, entry_kind,
                 payment_method, created_at, deleted_at)
                SELECT id, customer_id, movement_type, amount, description,
                       document_type, document_number, due_date, invoice_id, reference, entry_kind,
                       payment_method, created_at, CURRENT_TIMESTAMP
                FROM account_movements
                WHERE id = ? AND customer_id = ?
                """,
                (movement["id"], customer_id),
            )
        
        # 2. Marcar todos los movimientos como eliminados (soft delete)
        conn.execute(
            "UPDATE account_movements SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP WHERE customer_id = ?",
            (customer_id,),
        )
        
        # 3. Registrar auditoría para cada movimiento eliminado
        for movement in movements:
            _log_movement_audit(
                conn,
                movement["id"],
                customer_id,
                "DELETE",
                old_values=dict(movement) if hasattr(movement, 'keys') else {},
                edited_by="ADMIN_DELETE_CUSTOMER",
            )
        
        # 4. Hacer soft delete del cliente (marcar como eliminado en lugar de borrar)
        conn.execute(
            "UPDATE account_customers SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?",
            (customer_id,),
        )
        
        # 5. Registrar auditoría del cliente
        conn.execute(
            """
            INSERT INTO account_customers_audit
            (customer_id, action, description, edited_by, created_at)
            VALUES (?, 'DELETE', 'Cliente eliminado con soft delete', 'ADMIN', CURRENT_TIMESTAMP)
            """,
            (customer_id,),
        )
        
        conn.commit()
        return {
            "id": int(customer["id"]),
            "name": customer["name"],
            "message": "Cuenta eliminada (soft delete - datos recuperables)",
            "movements_deleted": len(movements),
        }
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


@app.put("/admin/account-customers/{customer_id}/movements/{movement_id}")
def admin_update_account_movement(
    customer_id: int,
    movement_id: int,
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
        customer = conn.execute("SELECT id FROM account_customers WHERE id = ?", (customer_id,)).fetchone()
        if customer is None:
            raise HTTPException(status_code=404, detail="Cliente no encontrado")
        movement = conn.execute(
            "SELECT * FROM account_movements WHERE id = ? AND customer_id = ?",
            (movement_id, customer_id),
        ).fetchone()
        if movement is None:
            raise HTTPException(status_code=404, detail="Movimiento no encontrado")
        
        # Guardar valores anteriores para auditoría
        old_values = dict(movement) if hasattr(movement, 'keys') else {}
        
        new_values = {
            "movement_type": movement_type,
            "amount": amount,
            "description": str(payload.get("description") or "").strip() or None,
            "document_type": str(payload.get("document_type") or "").strip() or None,
            "document_number": str(payload.get("document_number") or "").strip() or None,
            "due_date": str(payload.get("due_date") or "").strip() or None,
        }
        
        conn.execute(
            """
            UPDATE account_movements
               SET movement_type = ?, amount = ?, description = ?, document_type = ?, document_number = ?, due_date = ?
             WHERE id = ? AND customer_id = ?
            """,
            (
                movement_type,
                amount,
                new_values["description"],
                new_values["document_type"],
                new_values["document_number"],
                new_values["due_date"],
                movement_id,
                customer_id,
            ),
        )
        
        # Registrar auditoría
        _log_movement_audit(
            conn,
            movement_id,
            customer_id,
            "UPDATE",
            old_values=old_values,
            new_values=new_values,
        )
        
        conn.execute(
            "UPDATE account_customers SET updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (customer_id,),
        )
        conn.commit()
        return {"customer_id": customer_id, "movement_id": movement_id, "balance": _customer_balance(conn, customer_id)}
    finally:
        conn.close()


@app.delete("/admin/account-customers/{customer_id}/movements/{movement_id}")
def admin_delete_account_movement(
    customer_id: int,
    movement_id: int,
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict:
    """Soft delete de un movimiento individual (seguro, sin perder datos)"""
    _require_admin(session_token)
    conn = _connect()
    try:
        _ensure_accounting_tables(conn)
        customer = conn.execute("SELECT id FROM account_customers WHERE id = ?", (customer_id,)).fetchone()
        if customer is None:
            raise HTTPException(status_code=404, detail="Cliente no encontrado")
        
        # Verificar que el movimiento existe
        movement = conn.execute(
            "SELECT id FROM account_movements WHERE id = ? AND customer_id = ? AND is_deleted = 0",
            (movement_id, customer_id),
        ).fetchone()
        if movement is None:
            raise HTTPException(status_code=404, detail="Movimiento no encontrado o ya fue eliminado")
        
        # Hacer soft delete
        success = _soft_delete_movement(conn, movement_id, customer_id)
        
        if not success:
            raise HTTPException(status_code=400, detail="No se pudo eliminar el movimiento")
        
        # Actualizar timestamp del cliente
        conn.execute(
            "UPDATE account_customers SET updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (customer_id,),
        )
        
        conn.commit()
        return {
            "customer_id": customer_id,
            "movement_id": movement_id,
            "message": "Movimiento eliminado exitosamente (soft delete)",
            "balance": _customer_balance(conn, customer_id)
        }
    finally:
        conn.close()


@app.post("/admin/account-customers/{customer_id}/movements/{movement_id}/restore")
def admin_restore_account_movement(
    customer_id: int,
    movement_id: int,
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict:
    """Restaurar un movimiento eliminado"""
    _require_admin(session_token)
    conn = _connect()
    try:
        _ensure_accounting_tables(conn)
        customer = conn.execute("SELECT id FROM account_customers WHERE id = ?", (customer_id,)).fetchone()
        if customer is None:
            raise HTTPException(status_code=404, detail="Cliente no encontrado")
        
        # Verificar que el movimiento existe y está eliminado
        movement = conn.execute(
            "SELECT id FROM account_movements WHERE id = ? AND customer_id = ? AND is_deleted = 1",
            (movement_id, customer_id),
        ).fetchone()
        if movement is None:
            raise HTTPException(status_code=404, detail="Movimiento no encontrado o no está eliminado")
        
        # Restaurar
        success = _restore_movement(conn, movement_id, customer_id)
        
        if not success:
            raise HTTPException(status_code=400, detail="No se pudo restaurar el movimiento")
        
        # Actualizar timestamp del cliente
        conn.execute(
            "UPDATE account_customers SET updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (customer_id,),
        )
        
        conn.commit()
        return {
            "customer_id": customer_id,
            "movement_id": movement_id,
            "message": "Movimiento restaurado exitosamente",
            "balance": _customer_balance(conn, customer_id)
        }
    finally:
        conn.close()


@app.get("/admin/account-customers/{customer_id}/movements/deleted")
def admin_get_deleted_movements(
    customer_id: int,
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict:
    """Obtener movimientos eliminados (para recuperación)"""
    _require_admin(session_token)
    conn = _connect()
    try:
        _ensure_accounting_tables(conn)
        customer = conn.execute("SELECT id FROM account_customers WHERE id = ?", (customer_id,)).fetchone()
        if customer is None:
            raise HTTPException(status_code=404, detail="Cliente no encontrado")
        
        # Obtener movimientos eliminados
        deleted = conn.execute(
            """
            SELECT * FROM account_movements
            WHERE customer_id = ? AND is_deleted = 1
            ORDER BY deleted_at DESC
            """,
            (customer_id,),
        ).fetchall()
        
        return {
            "customer_id": customer_id,
            "deleted_movements": [
                {
                    "id": int(mov["id"]),
                    "movement_type": mov["movement_type"],
                    "amount": float(mov["amount"]),
                    "description": mov["description"],
                    "document_type": mov["document_type"],
                    "document_number": mov["document_number"],
                    "created_at": mov["created_at"],
                    "deleted_at": mov["deleted_at"],
                }
                for mov in deleted
            ]
        }
    finally:
        conn.close()


@app.get("/admin/account-customers/{customer_id}/movements/{movement_id}/audit")
def admin_get_movement_audit(
    customer_id: int,
    movement_id: int,
    request: Request,
    session_token: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
) -> dict:
    """Obtener historial de cambios de un movimiento"""
    _require_admin(session_token)
    conn = _connect()
    try:
        _ensure_accounting_tables(conn)
        customer = conn.execute("SELECT id FROM account_customers WHERE id = ?", (customer_id,)).fetchone()
        if customer is None:
            raise HTTPException(status_code=404, detail="Cliente no encontrado")
        
        # Obtener auditoría
        audit_records = conn.execute(
            """
            SELECT * FROM account_movements_audit
            WHERE movement_id = ? AND customer_id = ?
            ORDER BY created_at DESC
            """,
            (movement_id, customer_id),
        ).fetchall()
        
        return {
            "customer_id": customer_id,
            "movement_id": movement_id,
            "audit_history": [
                {
                    "id": int(record["id"]),
                    "action": record["action"],
                    "old_values": json.loads(record["old_values"]) if record["old_values"] else None,
                    "new_values": json.loads(record["new_values"]) if record["new_values"] else None,
                    "edited_by": record["edited_by"],
                    "created_at": record["created_at"],
                }
                for record in audit_records
            ]
        }
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
    if status_value not in {"PENDING", "CONFIRMED", "CANCELLED", "BUDGETED"}:
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
        
        rows = conn.execute(
            """
            SELECT id, total, notes, created_at
            FROM sales
            ORDER BY created_at DESC
            """,
        ).fetchall()
        filtered_rows = [row for row in rows if _matches_argentina_date_range(row["created_at"], start_date, end_date)]

        return [
            {
                "id": int(row["id"]),
                "total": float(row["total"] or 0),
                "notes": row["notes"],
                "created_at": row["created_at"],
            }
            for row in filtered_rows[offset : offset + limit]
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
        
        rows = conn.execute(
            """
            SELECT id, supplier, total, notes, created_at
            FROM purchases
            ORDER BY created_at DESC
            """,
        ).fetchall()
        filtered_rows = [row for row in rows if _matches_argentina_date_range(row["created_at"], start_date, end_date)]

        return [
            {
                "id": int(row["id"]),
                "supplier": row.get("supplier", row["supplier"] if isinstance(row, dict) else None),
                "total": float(row["total"] or 0),
                "notes": row["notes"],
                "created_at": row["created_at"],
            }
            for row in filtered_rows[offset : offset + limit]
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
        
        # Verificar si ya existe, ignorando mayusculas y acentos.
        normalized_name = _normalize_search_text(name)
        existing = next(
            (
                category
                for category in conn.execute("SELECT id, name FROM categories").fetchall()
                if _normalize_search_text(category["name"] if isinstance(category, dict) else category[1]) == normalized_name
            ),
            None,
        )
        
        if existing:
            raise HTTPException(status_code=409, detail="Categoría ya existe")
        
        try:
            conn.execute(
                "INSERT INTO categories (name) VALUES (?)",
                (name,),
            )
            conn.commit()
        except sqlite3.IntegrityError:
            raise HTTPException(status_code=409, detail="Categoría ya existe")
        
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
        
        # Verificar unicidad, ignorando mayusculas y acentos.
        normalized_name = _normalize_search_text(name)
        existing = next(
            (
                category
                for category in conn.execute("SELECT id, name FROM categories").fetchall()
                if int(category["id"] if isinstance(category, dict) else category[0]) != category_id
                and _normalize_search_text(category["name"] if isinstance(category, dict) else category[1]) == normalized_name
            ),
            None,
        )
        
        if existing:
            raise HTTPException(status_code=409, detail="El nombre ya existe")
        
        try:
            conn.execute(
                "UPDATE categories SET name = ? WHERE id = ?",
                (name, category_id),
            )
            conn.commit()
        except sqlite3.IntegrityError:
            raise HTTPException(status_code=409, detail="El nombre ya existe")
        
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
        
        rows = conn.execute(
            """
            SELECT id, category, amount, description, created_at
            FROM expenses
            ORDER BY created_at DESC
            """,
        ).fetchall()
        filtered_rows = [row for row in rows if _matches_argentina_date_range(row["created_at"], start_date, end_date)]

        return [
            {
                "id": int(row["id"]),
                "category": row["category"],
                "amount": float(row["amount"] or 0),
                "description": row["description"],
                "created_at": row["created_at"],
            }
            for row in filtered_rows[offset : offset + limit]
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
            if DB_IS_POSTGRES:
                conn.execute(
                    """
                    CREATE TABLE expenses (
                        id SERIAL PRIMARY KEY,
                        category TEXT NOT NULL,
                        amount DOUBLE PRECISION NOT NULL,
                        description TEXT,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                    """
                )
            else:
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

        if DB_IS_POSTGRES:
            row = conn.execute(
                "INSERT INTO expenses (category, amount, description) VALUES (?, ?, ?) RETURNING id",
                (category, amount, description),
            ).fetchone()
            expense_id = int(row["id"] if isinstance(row, dict) else row[0])
        else:
            conn.execute(
                "INSERT INTO expenses (category, amount, description) VALUES (?, ?, ?)",
                (category, amount, description),
            )
            row = conn.execute("SELECT last_insert_rowid() as id").fetchone()
            expense_id = int(row["id"] if isinstance(row, dict) else row[0])
        conn.commit()
        
        return {
            "id": expense_id,
            "category": category,
            "amount": amount,
            "description": description,
        }
    finally:
        conn.close()
