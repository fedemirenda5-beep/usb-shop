"""Buyer accounts are separate from staff credentials and commercial customer records."""
import hashlib
import re
import secrets
import time
import unicodedata
from datetime import datetime, timezone

from fastapi import Body, Cookie, HTTPException, Request, Response

COOKIE = 'usbshop_buyer'
TTL = 30 * 24 * 60 * 60


def name_key(value):
    text = ''.join(char for char in unicodedata.normalize('NFKD', str(value or '').casefold())
                   if not unicodedata.combining(char))
    words = re.findall(r'[^\W_]+', text)
    return tuple(sorted(words)) if len(words) >= 2 else ()


def phone_keys(value):
    digits = re.sub(r'\D', '', str(value or ''))
    if digits.startswith('00'):
        digits = digits[2:]
    if digits.startswith('54') and len(digits) in (12, 13):
        digits = digits[2:]
    if digits.startswith('9') and len(digits) == 11:
        digits = digits[1:]
    if digits.startswith('0'):
        digits = digits[1:]
    keys = {digits} if len(digits) >= 8 else set()
    if len(digits) == 12:
        keys.update(digits[:i] + digits[i + 2:] for i in (2, 3, 4) if digits[i:i + 2] == '15')
    return keys


def customer_match_index(conn):
    index = {'email': {}, 'phone': {}, 'name': {}}
    rows = conn.execute('''SELECT c.id, c.name, c.email, c.phone, c.is_active,
        a.id AS linked_account_id FROM customers c LEFT JOIN buyer_accounts a ON a.customer_id = c.id
        WHERE c.deleted_at IS NULL ORDER BY c.id''').fetchall()
    for row in rows:
        customer = dict(row)
        customer['is_active'] = row['is_active'] != 0
        keys = {'email': [str(row['email'] or '').strip().casefold()],
                'phone': phone_keys(row['phone']), 'name': [name_key(row['name'])]}
        for kind, values in keys.items():
            for key in values:
                if key:
                    index[kind].setdefault(key, []).append(customer)
    return index


def customer_matches(index, account):
    found = {}
    keys = {'email': [str(account['email'] or '').strip().casefold()],
            'phone': phone_keys(account['phone']), 'name': [name_key(account['name'])]}
    for kind, values in keys.items():
        for key in values:
            for customer in index[kind].get(key, []):
                match = found.setdefault(customer['id'], {**customer, 'match_reasons': []})
                if kind not in match['match_reasons']:
                    match['match_reasons'].append(kind)
    return sorted(found.values(), key=lambda item: (-len(item['match_reasons']), item['id']))


def ensure_schema(conn, postgres):
    identity = 'BIGSERIAL PRIMARY KEY' if postgres else 'INTEGER PRIMARY KEY AUTOINCREMENT'
    conn.execute(f'''CREATE TABLE IF NOT EXISTS buyer_accounts (
        id {identity}, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, phone TEXT NOT NULL,
        password_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        customer_id INTEGER UNIQUE, session_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL)''')
    conn.execute('''CREATE TABLE IF NOT EXISTS buyer_tokens (
        token_hash TEXT PRIMARY KEY, purpose TEXT NOT NULL, customer_id INTEGER,
        account_id INTEGER, email TEXT NOT NULL, expires_at BIGINT NOT NULL)''')


def install(app, m):
    def connect():
        m._ensure_runtime_schema()
        return m._connect()

    def lock_accounts(conn):
        # Serialize account/link changes, including concurrent first registrations.
        if m.DB_IS_POSTGRES:
            conn.execute('SELECT pg_advisory_xact_lock(218910)')
        else:
            conn.execute('BEGIN IMMEDIATE')

    def email(value):
        value = str(value or '').strip().lower()
        if len(value) > 254 or not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', value):
            raise HTTPException(400, 'Ingresá un email válido')
        return value

    def password(value):
        value = str(value or '')
        if not 8 <= len(value) <= 128:
            raise HTTPException(400, 'La contraseña debe tener entre 8 y 128 caracteres')
        return value

    def public(row):
        return {k: row[k] for k in ('id', 'name', 'email', 'phone', 'status', 'customer_id')}

    def account(token):
        data = m._verify_session(token or '')
        if not data or data.get('role') != 'buyer':
            return None
        conn = connect()
        try:
            row = conn.execute('''SELECT a.*, c.id AS verified_customer_id, c.is_active AS customer_active, c.deleted_at,
                c.name AS commercial_name, c.phone AS commercial_phone
                FROM buyer_accounts a LEFT JOIN customers c ON c.id = a.customer_id
                WHERE a.id = ?''', (data.get('id'),)).fetchone()
            if not row or row['session_version'] != data.get('version'):
                return None
            if row['customer_id'] and (not row['verified_customer_id'] or row['customer_active'] == 0 or row['deleted_at']):
                return None
            result = dict(row)
            if row['customer_id']:
                result['name'] = row['commercial_name'] or row['name']
                result['phone'] = row['commercial_phone'] or row['phone']
            return result
        finally:
            conn.close()

    def require(token):
        row = account(token)
        if not row:
            raise HTTPException(401, 'Ingresá para ver precios y comprar')
        if row['status'] != 'approved' or not row['customer_id']:
            raise HTTPException(403, 'Tu acceso todavía no está habilitado')
        return row

    m._require_buyer = require
    m._buyer_can_view_prices = lambda token: bool((row := account(token)) and row['status'] == 'approved' and row['customer_id'])

    def session(request, response, row):
        token = m._sign_session({'id': row['id'], 'role': 'buyer',
                                 'version': row['session_version'], 'exp': int(time.time()) + TTL})
        response.set_cookie(COOKIE, token, max_age=TTL, httponly=True, **m._session_cookie_options(request))
        response.headers['Cache-Control'] = 'no-store'
        return public(row)

    def notify(to, subject, body):
        # Delivery failure must never roll back a saved approval or account.
        def send():
            try:
                m._send_via_mail_provider(m._mail_settings(), to_email=to, subject=subject, text_body=body)
            except Exception:
                m.LOGGER.warning('No se pudo enviar una notificación de acceso de cliente')
        m.threading.Thread(target=send, daemon=True).start()

    def new_token(conn, purpose, address, customer_id=None, account_id=None):
        token = secrets.token_urlsafe(32)
        # Generating a new invitation/reset invalidates earlier links for that target.
        conn.execute('DELETE FROM buyer_tokens WHERE purpose = ? AND email = ?', (purpose, address))
        if customer_id:
            conn.execute('DELETE FROM buyer_tokens WHERE purpose = ? AND customer_id = ?', (purpose, customer_id))
        conn.execute('''INSERT INTO buyer_tokens
            (token_hash, purpose, customer_id, account_id, email, expires_at) VALUES (?, ?, ?, ?, ?, ?)''',
            (hashlib.sha256(token.encode()).hexdigest(), purpose, customer_id, account_id, address,
             int(time.time()) + (7 * 86400 if purpose == 'invite' else 3600)))
        return 'https://www.usbshop.com.ar/mi-cuenta/#token=' + token

    @app.post('/buyer/register')
    def register(request: Request, response: Response, payload: dict = Body(...)):
        address = email(payload.get('email'))
        pwd = password(payload.get('password'))
        name, phone = (str(payload.get(k) or '').strip() for k in ('name', 'phone'))
        if not name or len(name) > 160 or not 6 <= len(phone) <= 40:
            raise HTTPException(400, 'Completá nombre o comercio y WhatsApp')
        key = 'buyer-register:' + str(request.client.host if request.client else '')
        m._assert_login_not_locked(key)
        m._record_login_failure(key)
        conn = connect()
        try:
            lock_accounts(conn)
            if conn.execute('SELECT id FROM buyer_accounts WHERE email = ?', (address,)).fetchone():
                raise HTTPException(409, 'Ya existe una cuenta con ese email. Ingresá o recuperá tu contraseña.')
            conn.execute('''INSERT INTO buyer_accounts (email, name, phone, password_hash, created_at)
                VALUES (?, ?, ?, ?, ?)''', (address, name, phone, m._hash_password(pwd), datetime.now(timezone.utc).isoformat()))
            row = conn.execute('SELECT * FROM buyer_accounts WHERE email = ?', (address,)).fetchone()
            conn.commit()
        finally:
            conn.close()
        notify(m._mail_settings()['order_notify_email'], 'Nueva solicitud de acceso · USB Shop',
               f'{name} solicita acceso.\nWhatsApp: {phone}\nEmail: {address}\nAprobar desde https://www.usbshop.com.ar/admin/clientes/')
        return session(request, response, row)

    @app.post('/buyer/login')
    def login(request: Request, response: Response, payload: dict = Body(...)):
        address = email(payload.get('email'))
        key = 'buyer:' + address
        m._assert_login_not_locked(key)
        conn = connect()
        try:
            row = conn.execute('SELECT * FROM buyer_accounts WHERE email = ?', (address,)).fetchone()
        finally:
            conn.close()
        if not row or not m._verify_password(str(payload.get('password') or '')[:129], row['password_hash'])[0]:
            m._record_login_failure(key)
            raise HTTPException(401, 'Email o contraseña incorrectos')
        if row['status'] in ('blocked', 'rejected'):
            raise HTTPException(403, 'Tu acceso está suspendido. Contactanos por WhatsApp.')
        m._clear_login_failures(key)
        return session(request, response, row)

    @app.get('/buyer/me')
    def me(response: Response, buyer_token: str = Cookie(None, alias=COOKIE)):
        response.headers['Cache-Control'] = 'no-store'
        row = account(buyer_token)
        return public(row) if row else None

    @app.post('/buyer/logout')
    def logout(request: Request, response: Response, buyer_token: str = Cookie(None, alias=COOKIE)):
        row = account(buyer_token)
        if row:
            conn = connect()
            try:
                conn.execute('UPDATE buyer_accounts SET session_version = session_version + 1 WHERE id = ?', (row['id'],))
                conn.commit()
            finally:
                conn.close()
        response.delete_cookie(COOKIE, **m._session_cookie_options(request))
        return {'ok': True}

    @app.post('/buyer/recover')
    def recover(request: Request, payload: dict = Body(...)):
        address = email(payload.get('email'))
        key = 'buyer-recover:' + str(request.client.host if request.client else '')
        m._assert_login_not_locked(key)
        m._record_login_failure(key)
        conn = connect()
        link = None
        try:
            lock_accounts(conn)
            row = conn.execute('SELECT id FROM buyer_accounts WHERE email = ?', (address,)).fetchone()
            if row:
                link = new_token(conn, 'reset', address, account_id=row['id'])
                conn.commit()
        finally:
            conn.close()
        if link:
            notify(address, 'Elegí una nueva contraseña · USB Shop', f'Usá este enlace dentro de una hora:\n{link}')
        return {'message': 'Si el email tiene una cuenta, te enviamos un enlace para recuperar el acceso.'}

    @app.post('/buyer/activate')
    def activate(request: Request, response: Response, payload: dict = Body(...)):
        pwd = password(payload.get('password'))
        digest = hashlib.sha256(str(payload.get('token') or '').encode()).hexdigest()
        conn = connect()
        try:
            lock_accounts(conn)
            # DELETE RETURNING atomically consumes the link across concurrent requests.
            token = conn.execute('DELETE FROM buyer_tokens WHERE token_hash = ? AND expires_at > ? RETURNING *',
                                 (digest, int(time.time()))).fetchone()
            if not token:
                raise HTTPException(400, 'El enlace venció o ya fue utilizado. Pedinos uno nuevo.')
            if token['purpose'] == 'reset':
                conn.execute('UPDATE buyer_accounts SET password_hash = ?, session_version = session_version + 1 WHERE id = ?',
                             (m._hash_password(pwd), token['account_id']))
                row = conn.execute('SELECT * FROM buyer_accounts WHERE id = ?', (token['account_id'],)).fetchone()
            else:
                customer = conn.execute('SELECT * FROM customers WHERE id = ? AND deleted_at IS NULL AND COALESCE(is_active, 1) = 1',
                                        (token['customer_id'],)).fetchone()
                if not customer:
                    raise HTTPException(400, 'El cliente ya no está habilitado. Contactanos.')
                existing = conn.execute('SELECT * FROM buyer_accounts WHERE email = ? OR customer_id = ?',
                                        (token['email'], customer['id'])).fetchall()
                if len(existing) > 1 or (existing and existing[0]['customer_id'] not in (None, customer['id'])):
                    raise HTTPException(409, 'Ese email ya está vinculado a otro cliente')
                if existing:
                    conn.execute('''UPDATE buyer_accounts SET email = ?, customer_id = ?, name = ?, phone = ?, status = 'approved',
                        password_hash = ?, session_version = session_version + 1 WHERE id = ?''',
                        (token['email'], customer['id'], customer['name'], customer['phone'] or existing[0]['phone'],
                         m._hash_password(pwd), existing[0]['id']))
                else:
                    conn.execute('''INSERT INTO buyer_accounts
                        (email, name, phone, password_hash, status, customer_id, created_at)
                        VALUES (?, ?, ?, ?, 'approved', ?, ?)''',
                        (token['email'], customer['name'], customer['phone'] or '', m._hash_password(pwd),
                         customer['id'], datetime.now(timezone.utc).isoformat()))
                row = conn.execute('SELECT * FROM buyer_accounts WHERE email = ?', (token['email'],)).fetchone()
            if not row:
                raise HTTPException(400, 'La cuenta ya no está disponible')
            conn.execute('DELETE FROM buyer_tokens WHERE account_id = ? OR customer_id = ? OR email = ?',
                         (row['id'], row['customer_id'], row['email']))
            conn.commit()
        finally:
            conn.close()
        return session(request, response, row)

    @app.get('/admin/buyer-accounts')
    def accounts(session_token: str = Cookie(None, alias=m.SESSION_COOKIE)):
        m._require_admin(session_token)
        conn = connect()
        try:
            rows = [dict(row) for row in conn.execute('''SELECT a.id, a.email, a.name, a.phone,
                a.status, a.customer_id, a.created_at, c.name AS customer_name FROM buyer_accounts a
                LEFT JOIN customers c ON c.id = a.customer_id ORDER BY a.created_at DESC''').fetchall()]
            index = customer_match_index(conn) if any(not row['customer_id'] for row in rows) else None
            for row in rows:
                row['matches'] = customer_matches(index, row) if not row['customer_id'] else []
            return rows
        finally:
            conn.close()

    @app.post('/admin/buyer-invitations/{customer_id}')
    def invite(customer_id: int, payload: dict = Body(...), session_token: str = Cookie(None, alias=m.SESSION_COOKIE)):
        m._require_admin(session_token)
        conn = connect()
        try:
            lock_accounts(conn)
            customer = conn.execute('SELECT * FROM customers WHERE id = ? AND deleted_at IS NULL AND COALESCE(is_active, 1) = 1',
                                    (customer_id,)).fetchone()
            if not customer:
                raise HTTPException(404, 'Cliente activo no encontrado')
            address = email(payload.get('email') or customer['email'])
            existing = conn.execute('SELECT customer_id, status FROM buyer_accounts WHERE email = ? OR customer_id = ?',
                                    (address, customer_id)).fetchall()
            if any(r['status'] in ('blocked', 'rejected') or r['customer_id'] not in (None, customer_id) for r in existing) or len(existing) > 1:
                raise HTTPException(409, 'Revisá la cuenta vinculada antes de generar una invitación')
            link = new_token(conn, 'invite', address, customer_id=customer_id)
            conn.commit()
            return {'url': link, 'email': address, 'expires_in_days': 7}
        finally:
            conn.close()

    @app.post('/admin/buyer-accounts/{account_id}')
    def update(account_id: int, payload: dict = Body(...), session_token: str = Cookie(None, alias=m.SESSION_COOKIE)):
        m._require_admin(session_token)
        status = payload.get('status')
        if status not in ('approved', 'blocked', 'rejected'):
            raise HTTPException(400, 'Estado inválido')
        conn = connect()
        try:
            lock_accounts(conn)
            row = conn.execute('SELECT * FROM buyer_accounts WHERE id = ?', (account_id,)).fetchone()
            if not row:
                raise HTTPException(404, 'Cuenta no encontrada')
            customer_id = row['customer_id']
            if status == 'approved':
                customer_id = payload.get('customer_id') or customer_id
                create_customer = payload.get('create_customer') is True
                if not customer_id and not create_customer:
                    matches = customer_matches(customer_match_index(conn), row)
                    if len(matches) > 1:
                        raise HTTPException(409, 'Hay varias coincidencias. Elegí la ficha correcta antes de aceptar.')
                    if matches:
                        match = matches[0]
                        if not match['is_active'] or match['linked_account_id']:
                            raise HTTPException(409, 'La ficha coincidente está inactiva o ya tiene una cuenta. Revisala antes de aceptar.')
                        customer_id = match['id']
                    else:
                        create_customer = True
                if customer_id:
                    customer = conn.execute('SELECT * FROM customers WHERE id = ? AND deleted_at IS NULL AND COALESCE(is_active, 1) = 1',
                                            (int(customer_id),)).fetchone()
                    if not customer:
                        raise HTTPException(400, 'Cliente activo no encontrado')
                    if conn.execute('SELECT id FROM buyer_accounts WHERE customer_id = ? AND id <> ?', (int(customer_id), account_id)).fetchone():
                        raise HTTPException(409, 'El cliente ya tiene otra cuenta vinculada')
                    conn.execute('UPDATE buyer_accounts SET name = ?, phone = ? WHERE id = ?',
                                 (customer['name'], customer['phone'] or row['phone'], account_id))
                else:
                    if customer_matches(customer_match_index(conn), row) and payload.get('confirm_distinct_customer') is not True:
                        raise HTTPException(409, 'Hay coincidencias con clientes existentes. Vinculá su ficha para conservar los datos o confirmá que es otra persona.')
                    inserted = conn.execute('''INSERT INTO customers (name, email, phone, created_at, sale_mode, is_active)
                        VALUES (?, ?, ?, ?, 'CONTADO', 1) RETURNING id''',
                        (row['name'], row['email'], row['phone'], datetime.now(timezone.utc).isoformat())).fetchone()
                    customer_id = inserted['id']
            conn.execute('''UPDATE buyer_accounts SET status = ?, customer_id = ?,
                session_version = session_version + 1 WHERE id = ?''', (status, customer_id, account_id))
            # Blocking also revokes outstanding invitations and password links.
            conn.execute('DELETE FROM buyer_tokens WHERE email = ? OR account_id = ? OR customer_id = ?',
                         (row['email'], account_id, customer_id))
            conn.commit()
        finally:
            conn.close()
        if status == 'approved':
            notify(row['email'], 'Tu acceso ya está habilitado · USB Shop',
                   'Ya podés ingresar con tu email y contraseña para ver precios y comprar:\nhttps://www.usbshop.com.ar/mi-cuenta/')
        return {'ok': True}
