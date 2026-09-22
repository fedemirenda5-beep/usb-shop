"""IMEI lifecycle against a disposable database, never the shop database."""
from datetime import datetime, timedelta, timezone
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from fastapi.testclient import TestClient
import main
import test_consignments as fixtures


class ImeiTrackingTests(unittest.TestCase):
    def setUp(self):
        fixtures.ConsignmentTests.setUp(self)
        self.imeis = ['356789012345678', '356789012345679', '356789012345680']
        self.sql("UPDATE categories SET name='Celulares' WHERE id=1")
        self.sql("UPDATE products SET name='Samsung A16', stock=3 WHERE id=1")
        self.sql("UPDATE customers SET phone='1122334455' WHERE id=1")
        for imei in self.imeis:
            self.sql('INSERT INTO product_imeis (product_id, imei) VALUES (1, ?)', (imei,))

    def sql(self, query, params=()):
        conn = main._connect()
        try:
            cursor = conn.execute(query, params)
            rows = [dict(row) for row in cursor.fetchall()] if query.startswith('SELECT') else []
            conn.commit()
            return rows
        finally:
            conn.close()

    def sell(self, imeis=None, quantity=1, customer=1, kind='FACTURA', **extra):
        return main.admin_create_invoice(None, None, {
            'customer_id': customer, 'seller_id': 1, 'document_type': kind,
            'items': [{'product_id': 1, 'quantity': quantity, 'unit_price': 1000,
                       'imeis': self.imeis[:1] if imeis is None else imeis}], **extra,
        })

    def lookup(self, imei=None):
        return main.admin_imei_lookup(None, None, imei or self.imeis[0])

    def test_sale_is_linked_to_customer_receipt_date_and_warranty(self):
        sold_at = (datetime.now(timezone.utc) - timedelta(days=2)).isoformat()
        sale = self.sell(created_at=sold_at)
        lookup = self.lookup()
        self.assertEqual(lookup['status'], 'sold')
        self.assertEqual(lookup['sale']['invoice_id'], sale['id'])
        self.assertEqual(lookup['sale']['customer_name'], 'Cliente Uno')
        self.assertEqual(lookup['sale']['customer_phone'], '1122334455')
        self.assertEqual(lookup['sale']['sold_at'], sold_at)
        self.assertEqual(lookup['warranty']['status'], 'active')
        self.assertEqual(lookup['warranty']['expires_at'], (datetime.fromisoformat(sold_at) + timedelta(days=30)).isoformat())
        detail = main.admin_invoice_detail(sale['id'], None, None)
        self.assertEqual(detail['items'][0]['imeis'], self.imeis[:1])
        self.assertEqual(detail['invoice']['warranty'], lookup['warranty'])
        self.assertEqual(self.sql('SELECT stock FROM products WHERE id=1')[0]['stock'], 2)

    def test_customer_snapshot_survives_customer_edit(self):
        sale = self.sell()
        self.sql("UPDATE customers SET name='Otro nombre', phone='999' WHERE id=1")
        self.assertEqual(self.lookup()['sale']['customer_name'], 'Cliente Uno')
        detail = main.admin_invoice_detail(sale['id'], None, None)
        self.assertEqual(detail['invoice']['customer_phone'], '1122334455')

    def test_older_sync_preserves_sale_snapshot_and_warranty(self):
        sale = self.sell()
        row = self.sql('SELECT * FROM invoices WHERE id=?', (sale['id'],))[0]
        for name in ('warranty_days', 'customer_name_snapshot', 'customer_phone_snapshot'):
            row.pop(name)
        conn = main._connect()
        try:
            main._upsert_sync_rows(conn, 'invoices', [row])
            conn.commit()
        finally:
            conn.close()
        self.assertEqual(self.lookup()['warranty']['days'], 30)
        self.assertEqual(self.lookup()['sale']['customer_name'], 'Cliente Uno')

    def test_missing_duplicate_and_wrong_product_imeis_do_not_create_sale(self):
        for imeis, quantity in [([], 1), (self.imeis[:1], 2), ([self.imeis[0]] * 2, 2), (['111111111111111'], 1)]:
            with self.subTest(imeis=imeis, quantity=quantity), self.assertRaises(HTTPException):
                self.sell(imeis=imeis, quantity=quantity)
        self.assertEqual(self.sql('SELECT id FROM invoices'), [])
        self.assertEqual(self.sql('SELECT stock FROM products WHERE id=1')[0]['stock'], 3)

    def test_sold_imei_cannot_be_sold_twice(self):
        first = self.sell()
        with self.assertRaises(HTTPException):
            self.sell()
        self.assertEqual(self.sql('SELECT id FROM invoices'), [{'id': first['id']}])
        self.assertEqual(self.sql('SELECT stock FROM products WHERE id=1')[0]['stock'], 2)

    def test_imei_write_failure_rolls_back_invoice(self):
        execute = main.DBConn.execute
        def fail_write(conn, query, params=None):
            if 'INSERT INTO invoice_item_imeis' in query:
                raise RuntimeError('Simulated IMEI storage failure')
            return execute(conn, query, params)
        with patch.object(main.DBConn, 'execute', fail_write), self.assertRaises(RuntimeError):
            self.sell()
        self.assertEqual(self.sql('SELECT id FROM invoices'), [])
        self.assertEqual(self.sql('SELECT id FROM invoice_items'), [])
        self.assertEqual(self.lookup()['status'], 'available')

    def test_return_and_resale_preserve_history(self):
        first = self.sell()
        self.sell(kind='NOTA_CREDITO')
        self.assertEqual(self.lookup()['status'], 'available')
        self.assertIsNone(self.lookup()['warranty'])
        second = self.sell(customer=2)
        lookup = self.lookup()
        self.assertEqual(lookup['sale']['customer_name'], 'Cliente Dos')
        self.assertEqual(len(lookup['history']), 3)
        self.assertEqual(lookup['sale']['invoice_id'], second['id'])
        self.assertIn(first['id'], [event['id'] for event in lookup['history']])
        self.assertEqual(main.admin_invoice_detail(first['id'], None, None)['items'][0]['imeis'], self.imeis[:1])

    def test_return_requires_original_customer_and_cannot_repeat(self):
        self.sell()
        with self.assertRaises(HTTPException):
            self.sell(kind='NOTA_CREDITO', customer=2)
        self.assertEqual(self.lookup()['status'], 'sold')
        self.sell(kind='NOTA_CREDITO')
        with self.assertRaises(HTTPException):
            self.sell(kind='NOTA_CREDITO')
        self.assertEqual(self.sql('SELECT stock FROM products WHERE id=1')[0]['stock'], 3)

    def test_inventory_edit_cannot_count_sold_imei_as_available(self):
        self.sell()
        with self.assertRaises(HTTPException):
            main.admin_update_product(1, None, None, {'stock': 3})
        with self.assertRaises(HTTPException):
            main.admin_update_product(1, None, None, {'stock': 3, 'imeis': self.imeis})
        self.assertEqual(self.sql('SELECT stock FROM products WHERE id=1')[0]['stock'], 2)

    def test_receiving_rejects_invalid_and_other_product_imei_atomically(self):
        for imeis in ([*self.imeis[:2], '123'],):
            with self.assertRaises(HTTPException):
                main.admin_update_product(1, None, None, {'stock': 3, 'imeis': imeis, 'name': 'Invalid edit'})
        self.assertEqual(self.sql('SELECT name FROM products WHERE id=1')[0]['name'], 'Samsung A16')
        self.sql('INSERT INTO product_imeis (product_id, imei) VALUES (2, ?)', ('111111111111111',))
        with self.assertRaises(HTTPException):
            main.admin_update_product(1, None, None, {'stock': 4, 'imeis': [*self.imeis, '111111111111111']})
        self.assertEqual(self.sql('SELECT stock FROM products WHERE id=1')[0]['stock'], 3)

    def test_editing_available_devices_preserves_sold_history(self):
        self.sell()
        main.admin_update_product(1, None, None, {'stock': 2, 'imeis': self.imeis[1:]})
        self.assertEqual(self.lookup()['status'], 'sold')
        self.assertEqual(len(self.lookup()['history']), 1)

    def test_cannot_delete_a_tracked_sale(self):
        sale = self.sell()
        with self.assertRaises(HTTPException):
            main.admin_delete_invoice(sale['id'], None, None)
        self.assertEqual(self.lookup()['status'], 'sold')

    def test_budget_does_not_sell_device_and_requires_scan_to_confirm(self):
        budget = self.sell(imeis=[], kind='PRESUPUESTO')
        self.assertEqual(self.lookup()['status'], 'available')
        with self.assertRaises(HTTPException):
            main.admin_confirm_invoice(budget['id'], None, None)
        self.assertEqual(self.sql('SELECT stock FROM products WHERE id=1')[0]['stock'], 3)

    def test_warranty_expired_and_legacy_unknown(self):
        sale = self.sell(created_at=(datetime.now(timezone.utc) - timedelta(days=31)).isoformat())
        self.assertEqual(self.lookup()['warranty']['status'], 'expired')
        self.sql('UPDATE invoices SET warranty_days=NULL WHERE id=?', (sale['id'],))
        self.assertEqual(self.lookup()['warranty']['status'], 'unknown')

    def test_unknown_imei_is_not_a_sale(self):
        self.assertFalse(self.lookup('111111111111111')['found'])

    def test_http_scan_sale_and_receipt(self):
        client = TestClient(main.app)
        self.addCleanup(client.close)
        lookup = client.get('/admin/imei-lookup', params={'q': self.imeis[0]})
        self.assertEqual(lookup.status_code, 200, lookup.text)
        self.assertEqual(lookup.json()['status'], 'available')
        response = client.post('/admin/invoices', json={
            'customer_id': 1, 'seller_id': 1, 'document_type': 'FACTURA',
            'items': [{'product_id': 1, 'quantity': 1, 'unit_price': 1000, 'imeis': self.imeis[:1]}],
        })
        self.assertEqual(response.status_code, 200, response.text)
        invoice_id = response.json()['id']
        receipt = client.get(f'/admin/invoices/{invoice_id}')
        self.assertEqual(receipt.status_code, 200, receipt.text)
        self.assertEqual(receipt.json()['items'][0]['imeis'], self.imeis[:1])
        sold = client.get('/admin/imei-lookup', params={'q': self.imeis[0]})
        self.assertEqual(sold.status_code, 200, sold.text)
        self.assertEqual(sold.json()['sale']['customer_name'], 'Cliente Uno')
        self.assertEqual(sold.json()['warranty']['status'], 'active')

    def test_concurrent_sales_cannot_assign_same_imei(self):
        # Initialize the auxiliary table before launching concurrent requests.
        self.lookup()
        def attempt(_):
            try:
                return self.sell()['id']
            except HTTPException:
                return None
        with ThreadPoolExecutor(max_workers=2) as pool:
            sales = list(pool.map(attempt, range(2)))
        self.assertEqual(sum(value is not None for value in sales), 1)
        self.assertEqual(self.sql('SELECT stock FROM products WHERE id=1')[0]['stock'], 2)


class ImeiPostgresMigrationTests(unittest.TestCase):
    def test_imported_integer_id_gets_default_starting_after_existing_ids(self):
        statements = []
        def execute(query, params=None):
            statements.append(query)
            return SimpleNamespace(fetchone=lambda: {'column_default': None, 'is_identity': 'NO'})
        with patch.object(main, 'DB_IS_POSTGRES', True):
            main._ensure_imei_id_default(SimpleNamespace(execute=execute), 'invoice_item_imeis')
        self.assertTrue(any('ALTER COLUMN id SET DEFAULT' in sql for sql in statements))
        self.assertTrue(any('COALESCE(MAX(id), 0) + 1, false' in sql for sql in statements))

    def test_existing_serial_and_identity_sequences_are_never_reset(self):
        for column in ({'column_default': "nextval('product_imeis_id_seq')", 'is_identity': 'NO'},
                       {'column_default': None, 'is_identity': 'YES'}):
            statements = []
            def execute(query, params=None):
                statements.append(query)
                return SimpleNamespace(fetchone=lambda: column)
            with patch.object(main, 'DB_IS_POSTGRES', True):
                main._ensure_imei_id_default(SimpleNamespace(execute=execute), 'product_imeis')
            self.assertEqual(len(statements), 1)


class WarrantyBoundaryTests(unittest.TestCase):
    def test_expiration_and_timezone_boundary(self):
        start = datetime(2026, 1, 1, 12, tzinfo=timezone(timedelta(hours=-3)))
        expiry = start + timedelta(days=30)
        with patch.object(main, 'datetime', wraps=datetime) as clock:
            clock.now.return_value = expiry
            self.assertEqual(main._imei_warranty(start.isoformat(), 30)['status'], 'active')
            clock.now.return_value = expiry + timedelta(microseconds=1)
            self.assertEqual(main._imei_warranty(start.isoformat(), 30)['status'], 'expired')
            self.assertEqual(main._imei_warranty('invalid', 30)['status'], 'unknown')


if __name__ == '__main__':
    unittest.main()
