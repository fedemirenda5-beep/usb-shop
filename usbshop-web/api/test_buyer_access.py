"""Exercise actual HTTP cookies, invitation consumption and catalog authorization."""
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
import main
import customer_access
import test_consignments as fixtures

REAL_REQUIRE_BUYER = main._require_buyer
REAL_REQUIRE_ADMIN = main._require_admin


class BuyerAccessTests(unittest.TestCase):
    def setUp(self):
        fixtures.ConsignmentTests.setUp(self)
        actual_auth = patch.object(main, '_require_buyer', REAL_REQUIRE_BUYER)
        actual_auth.start()
        self.addCleanup(actual_auth.stop)
        self.notify = patch.object(main, '_send_via_mail_provider')
        self.notify.start()
        self.addCleanup(self.notify.stop)
        main._AUTH_LOGIN_FAILURES.clear()
        self.client = TestClient(main.app)
        self.addCleanup(self.client.close)

    def register(self, address='buyer@example.com', **changes):
        result = self.client.post('/buyer/register', json={
            'email': address, 'name': 'Comercio', 'phone': '2364574765', 'password': 'a-secret-123', **changes})
        self.assertEqual(result.status_code, 200, result.text)
        return result.json()

    def invite(self, customer=1, address='existing@example.com'):
        response = self.client.post(f'/admin/buyer-invitations/{customer}', json={'email': address})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()['url'].split('token=')[1]

    def activate(self, token):
        return self.client.post('/buyer/activate', json={'token': token, 'password': 'new-secret-123'})

    def test_public_and_pending_cannot_see_prices_or_place_orders(self):
        def hidden():
            for url in ['/products', '/featured', '/storefront/collections']:
                response = self.client.get(url)
                self.assertEqual(response.status_code, 200, response.text)
                self.assertIn('no-store', response.headers['cache-control'])
                data = response.json()
                products = data if isinstance(data, list) else [p for group in data.values() for p in group]
                for product in products:
                    self.assertIsNone(product['price'])
                    self.assertIsNone(product.get('originalPrice'))
                    self.assertIsNone(product.get('flashOffer'))
                    self.assertNotIn('cost', product)
            result = self.client.post('/orders', json={'items': [{'product_id': 1, 'quantity': 1}], 'idempotency_key': 'buyer-denied-1234567890'})
            self.assertIn(result.status_code, (401, 403), result.text)
        hidden()
        self.register()
        hidden()

    def test_existing_customer_invitation_is_single_use_and_keeps_customer(self):
        token = self.invite()
        result = self.activate(token)
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()['customer_id'], 1)
        self.assertEqual(result.json()['status'], 'approved')
        cookie = self.client.cookies.get(customer_access.COOKIE)
        self.assertTrue(cookie)
        products = self.client.get('/products').json()
        self.assertTrue(all(isinstance(p['price'], (int, float)) for p in products))
        self.assertTrue(all('cost' not in p for p in products))
        order = self.client.post('/orders', json={'items': [{'product_id': 1, 'quantity': 1}], 'customer_name': 'Impostor', 'customer_phone': '123', 'customer_email': 'wrong@example.com', 'idempotency_key': 'buyer-valid-1234567890'})
        self.assertEqual(order.status_code, 200, order.text)
        conn = main._connect()
        try:
            row = conn.execute('SELECT * FROM web_orders WHERE id = ?', (order.json()['id'],)).fetchone()
            self.assertEqual(row['buyer_customer_id'], 1)
            self.assertEqual(row['customer_email'], 'existing@example.com')
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM customers').fetchone()[0], 2)
        finally:
            conn.close()
        sync = self.client.post('/admin/backoffice-customers/sync-web-orders')
        self.assertEqual(sync.status_code, 200, sync.text)
        self.assertEqual(sync.json()['created'], 0)
        self.assertEqual(sync.json()['updated'], 0)
        self.assertEqual(self.activate(token).status_code, 400)

    def test_pending_can_be_linked_and_block_revokes_session_and_links(self):
        account = self.register()
        response = self.client.post(f"/admin/buyer-accounts/{account['id']}", json={'status': 'approved', 'customer_id': 1})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.client.post('/buyer/login', json={'email': account['email'], 'password': 'a-secret-123'}).status_code, 200)
        self.assertIsNotNone(self.client.get('/products').json()[0]['price'])
        token = self.invite(address=account['email'])
        self.assertEqual(self.client.post(f"/admin/buyer-accounts/{account['id']}", json={'status': 'blocked'}).status_code, 200)
        self.assertIsNone(self.client.get('/products').json()[0]['price'])
        self.assertEqual(self.activate(token).status_code, 400)

    def test_accept_creates_new_customer_keeps_chosen_password_and_does_not_duplicate_on_reapproval(self):
        account = self.register()
        conn = main._connect()
        try:
            password_hash = conn.execute('SELECT password_hash FROM buyer_accounts WHERE id = ?', (account['id'],)).fetchone()['password_hash']
            self.assertNotEqual(password_hash, 'a-secret-123')
        finally:
            conn.close()
        path = f"/admin/buyer-accounts/{account['id']}"
        self.assertEqual(self.client.post(path, json={'status': 'approved'}).status_code, 200)
        self.assertEqual(self.client.post(path, json={'status': 'approved', 'create_customer': True}).status_code, 200)
        self.assertEqual(self.client.post(path, json={'status': 'approved', 'create_customer': True}).status_code, 200)
        conn = main._connect()
        try:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM customers').fetchone()[0], 3)
            self.assertEqual(conn.execute('SELECT password_hash FROM buyer_accounts WHERE id = ?', (account['id'],)).fetchone()['password_hash'], password_hash)
        finally:
            conn.close()
        login = self.client.post('/buyer/login', json={'email': account['email'], 'password': 'a-secret-123'})
        self.assertEqual(login.status_code, 200)
        self.assertEqual(login.json()['status'], 'approved')
        listed = next(item for item in self.client.get('/admin/buyer-accounts').json() if item['id'] == account['id'])
        self.assertNotIn('password', listed)
        self.assertNotIn('password_hash', listed)

    def test_password_reset_invalidates_old_session_and_cannot_be_reused(self):
        self.activate(self.invite())
        old_cookie = self.client.cookies.get(customer_access.COOKIE)
        with patch.object(main, '_send_via_mail_provider') as delivery:
            self.assertEqual(self.client.post('/buyer/recover', json={'email': 'existing@example.com'}).status_code, 200)
            # Read the opaque token from the delivered notification, never the database hash.
            import time
            for _ in range(100):
                if delivery.called:
                    break
                time.sleep(.01)
            token = delivery.call_args.kwargs['text_body'].split('token=')[1]
        self.assertEqual(self.activate(token).status_code, 200)
        self.assertEqual(self.activate(token).status_code, 400)
        other = TestClient(main.app)
        self.addCleanup(other.close)
        other.cookies.set(customer_access.COOKIE, old_cookie)
        self.assertIsNone(other.get('/buyer/me').json())

    def test_expired_and_replaced_invitations_cannot_activate(self):
        old = self.invite()
        current = self.invite()
        self.assertEqual(self.activate(old).status_code, 400)
        conn = main._connect()
        try:
            conn.execute('UPDATE buyer_tokens SET expires_at = 0')
            conn.commit()
        finally:
            conn.close()
        self.assertEqual(self.activate(current).status_code, 400)

    def test_buyer_cannot_administer_accounts_and_staff_cookie_cannot_unlock_catalog(self):
        self.activate(self.invite())
        buyer_cookie = self.client.cookies.get(customer_access.COOKIE)
        self.assertEqual(self.client.get('/auth/me').status_code, 401)
        self.client.cookies.set(main.SESSION_COOKIE, buyer_cookie)
        self.assertEqual(self.client.get('/auth/me').status_code, 401)
        with patch.object(main, '_require_admin', REAL_REQUIRE_ADMIN):
            self.assertEqual(self.client.get('/admin/buyer-accounts').status_code, 401)
            self.assertEqual(self.client.post('/admin/buyer-accounts/1', json={'status': 'approved'}).status_code, 401)
        self.client.cookies.clear()
        import time
        self.client.cookies.set(main.SESSION_COOKIE, main._sign_session({'id': 1, 'role': 'admin', 'exp': int(time.time()) + 3600}))
        self.assertEqual(self.client.get('/auth/me').status_code, 200)
        self.assertIsNone(self.client.get('/products').json()[0]['price'])

    def test_reordered_name_suggests_existing_customer_and_keeps_every_commercial_field(self):
        conn = main._connect()
        try:
            conn.execute('''UPDATE customers SET name = ?, email = ?, phone = ?, address = ?, cuit = ? WHERE id = 1''',
                         ('Pérez, Juan José', 'comercial@example.com', '2364000000', 'Dirección original 123', '20301234567'))
            conn.commit()
            original = dict(conn.execute('SELECT * FROM customers WHERE id = 1').fetchone())
        finally:
            conn.close()
        account = self.register(name='  JUAN jose PEREZ ', phone='2364999999')
        listed = self.client.get('/admin/buyer-accounts').json()[0]
        self.assertIsNone(listed['customer_id'])
        self.assertEqual([(match['id'], match['match_reasons']) for match in listed['matches']], [(1, ['name'])])
        path = f"/admin/buyer-accounts/{account['id']}"
        self.assertEqual(self.client.post(path, json={'status': 'approved', 'create_customer': True}).status_code, 409)
        self.assertEqual(self.client.post(path, json={'status': 'approved'}).status_code, 200)
        login = self.client.post('/buyer/login', json={'email': account['email'], 'password': 'a-secret-123'})
        self.assertEqual(login.json()['name'], original['name'])
        self.assertEqual(login.json()['phone'], original['phone'])
        self.assertEqual(login.json()['email'], account['email'])
        conn = main._connect()
        try:
            self.assertEqual(dict(conn.execute('SELECT * FROM customers WHERE id = 1').fetchone()), original)
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM customers').fetchone()[0], 2)
            conn.execute("UPDATE customers SET name = 'Nombre actualizado en administración' WHERE id = 1")
            conn.commit()
        finally:
            conn.close()
        self.assertEqual(self.client.get('/buyer/me').json()['name'], 'Nombre actualizado en administración')

    def test_email_and_argentina_phone_formats_match_without_approving_automatically(self):
        conn = main._connect()
        try:
            conn.execute("UPDATE customers SET email = ' BUYER@example.com ', phone = '0236 15 457-4765' WHERE id = 1")
            conn.commit()
        finally:
            conn.close()
        account = self.register(phone='+54 9 236 457 4765')
        match = self.client.get('/admin/buyer-accounts').json()[0]['matches'][0]
        self.assertEqual(match['id'], 1)
        self.assertEqual(set(match['match_reasons']), {'email', 'phone'})
        self.assertEqual(self.client.get('/buyer/me').json()['status'], 'pending')
        self.assertIsNone(self.client.get('/products').json()[0]['price'])

    def test_ambiguous_names_require_admin_choice_and_namesakes_need_explicit_confirmation(self):
        conn = main._connect()
        try:
            conn.execute("UPDATE customers SET name = 'Juan Perez' WHERE id = 1")
            conn.execute("UPDATE customers SET name = 'Perez Juan' WHERE id = 2")
            conn.commit()
        finally:
            conn.close()
        account = self.register(name='Pérez, Juan')
        listed = self.client.get('/admin/buyer-accounts').json()[0]
        self.assertEqual({match['id'] for match in listed['matches']}, {1, 2})
        self.assertIsNone(listed['customer_id'])
        path = f"/admin/buyer-accounts/{account['id']}"
        self.assertEqual(self.client.post(path, json={'status': 'approved'}).status_code, 409)
        self.assertEqual(self.client.post(path, json={'status': 'approved', 'create_customer': True}).status_code, 409)
        self.assertEqual(self.client.post(path, json={'status': 'approved', 'create_customer': True, 'confirm_distinct_customer': True}).status_code, 200)

    def test_matching_name_preserves_repeated_words_and_does_not_match_partial_names(self):
        self.assertEqual(customer_access.name_key('Pérez, JUAN José'), customer_access.name_key('José Juan Perez'))
        self.assertNotEqual(customer_access.name_key('Juan Perez'), customer_access.name_key('Juan Jose Perez'))
        self.assertNotEqual(customer_access.name_key('Ana Ana Perez'), customer_access.name_key('Ana Perez'))

    def test_invitation_linking_existing_pending_account_uses_commercial_name(self):
        account = self.register(name='Uno Cliente')
        result = self.activate(self.invite(address=account['email']))
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()['name'], 'Cliente Uno')


if __name__ == '__main__':
    unittest.main()
