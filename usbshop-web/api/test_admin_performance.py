"""Admin read regressions against a disposable database and dictionary rows."""
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import main


class AdminReadTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        database = Path(directory.name) / 'admin.db'
        database.touch()
        for name, value in {
            'DB_PATH': database, 'SOURCE_DB_PATH': database, 'DB_IS_POSTGRES': False,
            '_require_admin': lambda token: {'role': token or 'admin'},
            '_ensure_bootstrap_admin': lambda conn: None,
        }.items():
            patcher = patch.object(main, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        main._TABLE_EXISTS_CACHE.clear()
        main._COLUMN_EXISTS_CACHE.clear()
        main._clear_admin_overview_cache()
        self.addCleanup(main._clear_admin_overview_cache)
        main._ensure_runtime_schema(force=True)
        conn = main._connect()
        try:
            main._ensure_product_bundle_support(conn)
            conn.execute('CREATE TABLE expenses (id INTEGER PRIMARY KEY, amount REAL, created_at TEXT)')
            conn.execute('CREATE TABLE purchases (id INTEGER PRIMARY KEY, total REAL, created_at TEXT)')
            main._invalidate_table_cache('expenses')
            main._invalidate_table_cache('purchases')
            for product_id in range(1, 81):
                conn.execute("""INSERT INTO products (id, name, sku, price, cost, stock, is_active)
                    VALUES (?, ?, ?, 500, 200, 10, 1)""",
                    (product_id, f'Producto {product_id:03}', f'SKU-{product_id}'))
            conn.execute("INSERT INTO customers (id, name) VALUES (1, 'Cliente prueba')")
            for values in [(1, 'FACTURA', 1000, 100), (2, 'NOTA_CREDITO', 200, 0), (3, 'PRESUPUESTO', 5000, 50)]:
                conn.execute("""INSERT INTO invoices
                    (id, customer_id, document_type, total, special_discount, created_at, sale_mode)
                    VALUES (?, 1, ?, ?, ?, '2026-09-01 12:00:00', 'CONTADO')""", values)
            conn.execute("""INSERT INTO invoice_items (invoice_id, product_id, quantity, unit_price, cost_snapshot)
                VALUES (1, 1, 2, 500, 200), (2, 1, 1, 200, 100), (3, 1, 10, 500, 200)""")
            conn.execute("INSERT INTO expenses (amount, created_at) VALUES (50, '2026-09-01')")
            conn.execute("INSERT INTO purchases (total, created_at) VALUES (100, '2026-09-01')")
            conn.execute("""INSERT INTO account_movements (customer_id, amount, movement_type, created_at)
                VALUES (1, 1000, 'DEBIT', '2026-09-01'), (1, 250, 'CREDIT', '2026-09-01')""")
            conn.commit()
        finally:
            conn.close()

    def dictionary_reads(self):
        execute = main.DBConn.execute

        def wrapped(conn, query, params=None):
            cursor = execute(conn, query, params)
            if query.lstrip().upper().startswith('SELECT'):
                rows = [dict(row) for row in cursor.fetchall()]
                return SimpleNamespace(fetchall=lambda: rows, fetchone=lambda: rows[0] if rows else None)
            return cursor

        return patch.object(main.DBConn, 'execute', wrapped)

    def test_dashboard_matches_full_report_without_loading_history(self):
        full = main.admin_reports_overview(None, 'admin')['summary']
        with self.dictionary_reads():
            result = main.admin_dashboard('admin')['summary']
        for key, value in result.items():
            self.assertEqual(value, full[key], key)
        self.assertEqual(result['sales_total'], 800)
        self.assertEqual(result['estimated_margin'], 400)
        self.assertEqual(result['cc_open_balance'], 750)

    def test_date_only_events_sort_with_timestamp_events_without_changing_day(self):
        date_only = main._argentina_datetime('2026-09-01')
        timestamp = main._argentina_datetime('2026-09-01 12:00:00')
        self.assertEqual(date_only.isoformat(), '2026-09-01T00:00:00-03:00')
        self.assertEqual(sorted([timestamp, date_only]), [date_only, timestamp])

    def test_losses_and_credit_notes_match_across_reports(self):
        for sale_cost, expected_margin in [(800, -600), (None, -900), (500, 0), (0, 1000)]:
            with self.subTest(sale_cost=sale_cost):
                main._clear_admin_cached_payload()
                self.addCleanup(main._clear_admin_cached_payload)
                conn = main._connect()
                try:
                    conn.execute('UPDATE products SET cost = 950 WHERE id = 1')
                    conn.execute('UPDATE invoice_items SET cost_snapshot = ? WHERE invoice_id = 1', (sale_cost,))
                    conn.execute('UPDATE invoice_items SET cost_snapshot = 300 WHERE invoice_id = 2')
                    conn.execute("INSERT OR IGNORE INTO sellers (id, name) VALUES (1, 'Vendedor prueba')")
                    conn.execute('UPDATE invoices SET seller_id = 1')
                    conn.commit()
                    annual = main._compute_annual_report_snapshot(conn, 2026)
                finally:
                    conn.close()

                with self.dictionary_reads(), patch.object(main, '_require_full_admin', return_value={'role': 'admin'}), patch.object(main, '_argentina_now', return_value=main.datetime(2026, 10, 8, 12)):
                    full = main.admin_reports_overview(None, 'admin')
                    dashboard = main.admin_dashboard('admin')
                    daily = main.admin_reports_daily(report_date='2026-09-01', session_token='admin')
                    customers = main.admin_reports_customer_ranking(session_token='admin')
                    sellers = main.admin_sellers_monthly_summary(None, period='2026-09', session_token='admin')
                # Sale: two units; credit note reverses a 100 loss;
                # special discount subtracts 100. Budgets are excluded.
                self.assertEqual(dashboard['summary']['estimated_margin'], expected_margin)
                self.assertEqual(full['summary']['estimated_margin'], expected_margin)
                self.assertEqual(full['summary']['operating_result'], expected_margin - 50)
                self.assertEqual(full['monthly_sales_all'][0]['margin'], expected_margin)
                self.assertEqual(full['monthly_sales_all'][0]['operating_result'], expected_margin - 50)
                self.assertEqual(daily['summary']['margin'], expected_margin)
                self.assertEqual(customers['summary']['profit_total'], expected_margin)
                self.assertEqual(sellers['items'][0]['profit'], expected_margin)
                self.assertEqual(annual['margin_total'], expected_margin)
                self.assertEqual(annual['operating_result_total'], expected_margin - 50)

    def test_return_of_a_loss_making_sale_cancels_its_loss_and_discount(self):
        conn = main._connect()
        try:
            conn.execute('UPDATE invoice_items SET quantity = 2, unit_price = 500, cost_snapshot = 800 WHERE invoice_id IN (1, 2)')
            conn.execute('UPDATE invoices SET total = 1000, special_discount = 100 WHERE id = 2')
            conn.commit()
        finally:
            conn.close()
        self.assertEqual(main.admin_dashboard('admin')['summary']['estimated_margin'], 0)
        full = main.admin_reports_overview(None, 'admin')
        self.assertEqual(full['summary']['estimated_margin'], 0)
        self.assertEqual(full['summary']['operating_result'], -50)

    def test_staff_report_accepts_postgres_dictionary_rows(self):
        with self.dictionary_reads():
            full = main.admin_reports_overview(None, 'staff')['summary']
            small = main.admin_dashboard('staff')['summary']
        self.assertEqual(full['expenses_total'], 50)
        self.assertIsNone(full['estimated_margin'])
        self.assertIsNone(small['estimated_margin'])
        self.assertEqual(small['sales_total'], full['sales_total'])

    def test_pages_are_bounded_in_database_and_summaries_skip_stock_queries(self):
        execute = main.DBConn.execute
        retrieved = []

        def wrapped(conn, query, params=None):
            cursor = execute(conn, query, params)
            if 'SELECT id, name, sku, barcode' in query:
                rows = cursor.fetchall()
                retrieved.append(len(rows))
                return SimpleNamespace(fetchall=lambda: rows)
            return cursor

        with patch.object(main.DBConn, 'execute', wrapped), patch.object(main.consignments, 'reserved_stock') as stock:
            rows = main.admin_list_products(None, 'admin', limit=12, offset=12, summary=True)
            stock.assert_not_called()
        self.assertEqual(retrieved, [12])
        self.assertEqual([item['id'] for item in rows], list(range(13, 25)))

    def test_search_still_paginates_all_matches(self):
        rows = main.admin_list_products(None, 'admin', q='Producto', limit=12, offset=60)
        self.assertEqual([item['id'] for item in rows], list(range(61, 73)))

    def test_admin_search_includes_storefront_matches_before_pagination(self):
        conn = main._connect()
        try:
            conn.execute("INSERT INTO categories (id, name) VALUES (901, 'Juguetes')")
            for values in [
                (101, 'Soporte para auto', 'SOPORTE', '', 0, None),
                (102, 'Auto acrobático 4x4 con control', '828A', '', 6, 901),
                (103, 'Vehículo con control', 'CX-81', 'Auto acrobático', 3, 901),
            ]:
                conn.execute('''INSERT INTO products
                    (id, name, sku, description, stock, category_id, price, cost, is_active)
                    VALUES (?, ?, ?, ?, ?, ?, 500, 200, 1)''', values)
            conn.commit()
        finally:
            conn.close()
        with self.dictionary_reads():
            for query in ['auto', 'auto acrobatico', 'acrobatico auto', 'juguetes', '828A', 'CX81', 'auto acrobatcio']:
                with self.subTest(query=query):
                    public_ids = {row['id'] for row in main.list_products(q=query)}
                    admin_ids = {row['id'] for row in main.admin_list_products(None, 'admin', q=query)}
                    self.assertTrue(public_ids)
                    self.assertEqual(admin_ids, public_ids)
            first = main.admin_list_products(None, 'admin', q='auto', limit=1)
            self.assertEqual(first[0]['id'], 102)
            exhausted = main.admin_list_products(None, 'admin', q='auto', out_of_stock_only=True)
            self.assertEqual([row['id'] for row in exhausted], [101])
            for search in [main.list_products, lambda **kwargs: main.admin_list_products(None, 'admin', **kwargs)]:
                suggestions = search(q='auto acrobatcio')
                self.assertTrue(all(row['search_match'] == 'approximate' for row in suggestions))
                self.assertEqual(search(q='828B'), [])
                self.assertEqual([row['id'] for row in search(q='auto', limit=1, offset=1)], [101])

    def test_mutations_invalidate_light_and_full_overview_caches(self):
        main.admin_dashboard('admin')
        main.admin_reports_overview(None, 'admin')
        main._clear_admin_overview_cache()
        self.assertIsNone(main._get_admin_overview_cache('dashboard:admin'))
        self.assertIsNone(main._get_admin_overview_cache('admin'))


if __name__ == '__main__':
    unittest.main()
