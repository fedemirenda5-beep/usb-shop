"""Integration tests using a new, disposable SQLite database for each case."""
import tempfile
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
import main
import consignments


class ConsignmentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        path = Path(self.temp.name) / 'inventory.db'
        path.touch()
        for name, value in {'DB_PATH': path, 'SOURCE_DB_PATH': path, 'DB_IS_POSTGRES': False,
                            '_require_admin': lambda token: None,
                            '_send_order_email_async': lambda *args: None}.items():
            patcher = patch.object(main, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        main._TABLE_EXISTS_CACHE.clear()
        main._COLUMN_EXISTS_CACHE.clear()
        main._ensure_runtime_schema(force=True)
        conn = main._connect()
        try:
            main._ensure_product_bundle_support(conn)
            conn.execute("INSERT INTO categories (id, name) VALUES (1, 'Cables')")
            conn.execute("INSERT INTO customers (id, name, sale_mode, is_active) VALUES (1, 'Cliente Uno', 'CONTADO', 1), (2, 'Cliente Dos', 'CONTADO', 1)")
            conn.execute("INSERT INTO sellers (id, name, commission_percent, is_active) VALUES (1, 'Vendedor', 0, 1)")
            conn.execute("""INSERT INTO products (id, name, sku, price, stock, cost, category_id, is_active, is_featured)
                VALUES (1, 'Cable USB', 'USB-1', 1000, 10, 500, 1, 1, 1), (2, 'Cargador', 'CAR-2', 2000, 5, 1000, 1, 1, 0)""")
            conn.commit()
        finally:
            conn.close()

    def delivery(self, quantity=6, customer=1, key=None, items=None):
        return main.admin_create_consignment(payload={'customer_id': customer, 'idempotency_key': key or str(uuid.uuid4()),
            'items': items or [{'product_id': 1, 'quantity': quantity}]}, session_token=None)

    def invoice(self, quantity=2, consignment_id=None, kind='FACTURA', customer=1, **extra):
        payload = {'customer_id': customer, 'seller_id': 1, 'document_type': kind, 'consignment_id': consignment_id,
                   'idempotency_key': str(uuid.uuid4()), 'items': [{'product_id': 1, 'quantity': quantity, 'unit_price': 1000}]}
        payload.update(extra)
        return main.admin_create_invoice(None, None, payload)

    def stock(self):
        conn = main._connect()
        try:
            return conn.execute('SELECT stock FROM products WHERE id = 1').fetchone()['stock'], consignments.reserved_stock(conn).get(1, 0)
        finally:
            conn.close()

    def test_delivery_sale_return_and_cancellation(self):
        delivery = self.delivery()
        self.assertEqual(self.stock(), (10, 6))
        self.assertEqual(main.list_products(ids='1')[0]['stock'], 4)
        sale = self.invoice(consignment_id=delivery['id'])
        self.assertEqual(self.stock(), (8, 4))
        main.admin_return_consignment(delivery['id'], {'idempotency_key': str(uuid.uuid4()), 'items': [{'product_id': 1, 'quantity': 1}]}, None)
        self.assertEqual(self.stock(), (8, 3))
        main.admin_delete_invoice(sale['id'], None, None)
        self.assertEqual(self.stock(), (10, 5))
        self.assertEqual(main.list_products(ids='1')[0]['stock'], 5)

    def test_web_and_normal_sales_cannot_use_consignment(self):
        self.delivery()
        with self.assertRaises(HTTPException):
            self.invoice(quantity=5)
        with self.assertRaises(HTTPException):
            main.create_order(main.OrderPayload(items=[{'product_id': 1, 'quantity': 5}], customer_name='Web', customer_phone='123', idempotency_key=str(uuid.uuid4())))
        self.assertEqual(self.stock(), (10, 6))
        self.invoice(quantity=4)
        self.assertEqual(self.stock(), (6, 6))

    def test_pending_web_order_also_reserves_and_can_be_invoiced(self):
        self.delivery(quantity=4)
        order = main.create_order(main.OrderPayload(items=[{'product_id': 1, 'quantity': 3}], customer_name='Web', customer_phone='123', idempotency_key=str(uuid.uuid4())))
        self.assertEqual(main.list_products(ids='1')[0]['stock'], 3)
        with self.assertRaises(HTTPException):
            self.delivery(quantity=4)
        self.invoice(quantity=3, order_id=order['id'])
        self.assertEqual(self.stock(), (7, 4))
        self.assertEqual(main.list_products(ids='1')[0]['stock'], 3)

    def test_budget_preserves_stock_but_confirmation_checks_available(self):
        self.delivery()
        budget = self.invoice(quantity=5, kind='PRESUPUESTO')
        self.assertEqual(self.stock(), (10, 6))
        with self.assertRaises(HTTPException):
            main.admin_confirm_invoice(budget['id'], None, None)
        self.assertEqual(self.stock(), (10, 6))
        budget = self.invoice(quantity=4, kind='PRESUPUESTO')
        main.admin_confirm_invoice(budget['id'], None, None)
        self.assertEqual(self.stock(), (6, 6))

    def test_validation_and_atomic_rollback(self):
        delivery = self.delivery()
        for args in [{'quantity': 7}, {'customer': 2}, {'kind': 'PRESUPUESTO'}]:
            with self.assertRaises(HTTPException):
                self.invoice(consignment_id=delivery['id'], **args)
        with self.assertRaises(HTTPException):
            self.delivery(items=[{'product_id': 2, 'quantity': 1}, {'product_id': 1, 'quantity': 100}])
        with self.assertRaises(HTTPException):
            main.admin_return_consignment(delivery['id'], {'idempotency_key': 'return-test', 'items': [{'product_id': 1, 'quantity': 7}]}, None)
        with self.assertRaises(HTTPException):
            self.delivery(quantity=1.5)
        self.assertEqual(self.stock(), (10, 6))

    def test_idempotent_delivery_return_and_sale(self):
        key = str(uuid.uuid4())
        first = self.delivery(key=key)
        self.assertEqual(first['id'], self.delivery(key=key)['id'])
        with self.assertRaises(HTTPException):
            self.delivery(quantity=5, key=key)
        sale_key = str(uuid.uuid4())
        sale = self.invoice(consignment_id=first['id'], idempotency_key=sale_key)
        self.assertEqual(sale['id'], self.invoice(consignment_id=first['id'], idempotency_key=sale_key)['id'])
        self.assertEqual(self.stock(), (8, 4))
        payload = {'idempotency_key': str(uuid.uuid4()), 'items': [{'product_id': 1, 'quantity': 1}]}
        main.admin_return_consignment(first['id'], payload, None)
        main.admin_return_consignment(first['id'], payload, None)
        self.assertEqual(self.stock(), (8, 3))

    def test_duplicate_product_lines_cannot_oversell(self):
        self.delivery()
        with self.assertRaises(HTTPException):
            self.invoice(items=[{'product_id': 1, 'quantity': 3}, {'product_id': 1, 'quantity': 3}])
        self.assertEqual(self.stock(), (10, 6))

    def test_competing_deliveries_do_not_overreserve(self):
        def reserve():
            try:
                self.delivery(quantity=7)
                return True
            except HTTPException:
                return False
        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = list(pool.map(lambda _: reserve(), range(2)))
        self.assertEqual(sorted(outcomes), [False, True])
        self.assertEqual(self.stock(), (10, 7))

    def test_product_stock_edit_and_delete_protect_reservations(self):
        self.delivery()
        with self.assertRaises(HTTPException):
            main.admin_update_product(1, None, None, {'stock': 0})
        with self.assertRaises(HTTPException):
            main.admin_delete_product(1, None, None)
        self.assertEqual(self.stock(), (10, 6))

    def test_search_by_product_and_customer(self):
        delivery = self.delivery()
        self.delivery(quantity=2, customer=2)
        conn = main._connect()
        try:
            self.assertEqual(len(consignments.list_consignments(conn, q='USB-1')), 2)
            self.assertEqual(consignments.list_consignments(conn, q='Uno')[0]['id'], delivery['id'])
        finally:
            conn.close()

    def test_customer_and_product_summaries_show_pending_stock(self):
        self.delivery(quantity=6)
        self.delivery(quantity=2, customer=2)
        customers = main.admin_consignment_customer_summary(None, limit=200)
        self.assertEqual({row['customer_name']: row['pending'] for row in customers}, {'Cliente Uno': 6, 'Cliente Dos': 2})
        products = main.admin_consignment_product_summary(None, q='USB-1', limit=100)
        self.assertEqual(products[0]['consigned'], 8)
        self.assertEqual(products[0]['customers'], 2)

    def test_combos_reserve_components_and_limit_web_stock(self):
        conn = main._connect()
        try:
            conn.execute("INSERT INTO products (id, name, sku, price, stock, category_id, is_active, is_bundle) VALUES (3, 'Combo', 'COMBO', 4000, 0, 1, 1, 1)")
            main._replace_product_bundle_items(conn, 3, [{'product_id': 1, 'quantity': 2}, {'product_id': 2, 'quantity': 1}])
            conn.commit()
        finally:
            conn.close()
        delivery = self.delivery(items=[{'product_id': 3, 'quantity': 2}])
        self.assertEqual(self.stock(), (10, 4))
        self.assertEqual({item['product_id']: item['pending'] for item in delivery['items']}, {1: 4, 2: 2})
        self.assertEqual(main.list_products(ids='3')[0]['stock'], 3)
        self.invoice(consignment_id=delivery['id'], items=[{'product_id': 3, 'quantity': 1, 'unit_price': 4000}])
        self.assertEqual(self.stock(), (8, 2))

    def test_return_rolls_back_all_lines_if_any_line_is_invalid(self):
        delivery = self.delivery(items=[{'product_id': 1, 'quantity': 6}, {'product_id': 2, 'quantity': 2}])
        with self.assertRaises(HTTPException):
            main.admin_return_consignment(delivery['id'], {'idempotency_key': str(uuid.uuid4()), 'items': [
                {'product_id': 1, 'quantity': 1}, {'product_id': 2, 'quantity': 3}]}, None)
        self.assertEqual(self.stock(), (10, 6))

    def test_schema_upgrade_preserves_deliveries(self):
        self.delivery()
        main._ensure_runtime_schema(force=True)
        self.assertEqual(self.stock(), (10, 6))

    def test_customer_detail_loads_complete_history_on_demand(self):
        first = self.invoice(quantity=1)
        second = self.invoice(quantity=1)
        detail = main.admin_backoffice_customer_detail(1, None, None)
        self.assertTrue(detail['accountHistory'])
        self.assertEqual([row['id'] for row in detail['documents']], [second['id'], first['id']])
        self.assertIn('movements', detail)


if __name__ == '__main__':
    import sys
    if '--serve' in sys.argv:
        # Browser-test fixture only: temporary inventory, no production data or email.
        import uvicorn
        fixture = ConsignmentTests()
        fixture.setUp()
        main.app.router.on_startup.clear()
        try:
            uvicorn.run(main.app, host='127.0.0.1', port=8011, log_level='warning')
        finally:
            fixture.doCleanups()
    else:
        unittest.main()
