"""Product edits against a disposable database, including Postgres-style rows."""
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException

import main


class ProductUpdateTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        path = Path(temp.name) / 'products.db'
        path.touch()
        for name, value in {'DB_PATH': path, 'SOURCE_DB_PATH': path,
                            'DB_IS_POSTGRES': False, '_require_admin': lambda token: None}.items():
            patcher = patch.object(main, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        main._TABLE_EXISTS_CACHE.clear()
        main._COLUMN_EXISTS_CACHE.clear()
        main._ensure_runtime_schema(force=True)
        conn = main._connect()
        try:
            conn.execute("INSERT INTO categories (id, name) VALUES (1, 'Celulares')")
            conn.execute("""INSERT INTO products (id, name, sku, price, stock, category_id)
                VALUES (1, 'Producto', 'PROD-1', 100, 0, NULL)""")
            conn.commit()
        finally:
            conn.close()

    def update(self, payload, dict_row=False):
        execute = main.DBConn.execute

        def execute_with_product_row(conn, query, params=None):
            cursor = execute(conn, query, params)
            # PostgreSQL returns dictionaries; SQLite normally returns sqlite3.Row.
            if dict_row and query.startswith('SELECT id, name, category_id,'):
                row = cursor.fetchone()
                return SimpleNamespace(fetchone=lambda: dict(row) if row else None)
            return cursor

        with patch.object(main.DBConn, 'execute', execute_with_product_row):
            return main.admin_update_product(1, None, None, payload)

    def product(self):
        conn = main._connect()
        try:
            return dict(conn.execute('SELECT stock, category_id FROM products WHERE id = 1').fetchone())
        finally:
            conn.close()

    def test_update_stock_without_category(self):
        for dict_row in (False, True):
            for stock in (5, 0):
                with self.subTest(dict_row=dict_row, stock=stock):
                    self.update({'stock': stock, 'category_id': None}, dict_row)
                    self.assertEqual(self.product(), {'stock': stock, 'category_id': None})

    def test_stock_only_preserves_empty_category(self):
        for dict_row in (False, True):
            with self.subTest(dict_row=dict_row):
                self.update({'stock': 3}, dict_row)
                self.assertEqual(self.product(), {'stock': 3, 'category_id': None})

    def test_remove_category_validates_new_category(self):
        for dict_row in (False, True):
            with self.subTest(dict_row=dict_row):
                self.update({'stock': 0, 'category_id': 1}, dict_row)
                self.update({'stock': 2, 'category_id': None, 'imeis': []}, dict_row)
                self.assertEqual(self.product(), {'stock': 2, 'category_id': None})

    def test_stock_only_keeps_cellphone_imei_validation(self):
        self.update({'stock': 0, 'category_id': 1})
        with self.assertRaises(HTTPException) as error:
            self.update({'stock': 2})
        self.assertEqual(error.exception.status_code, 400)
        self.assertEqual(self.product(), {'stock': 0, 'category_id': 1})

    def test_existing_phone_can_be_featured_without_rewriting_legacy_inventory(self):
        conn = main._connect()
        try:
            conn.execute('UPDATE products SET category_id = 1, stock = 3 WHERE id = 1')
            conn.commit()
        finally:
            conn.close()
        self.update({'is_featured': True}, dict_row=True)
        self.assertEqual(self.product(), {'stock': 3, 'category_id': 1})
        conn = main._connect()
        try:
            self.assertEqual(conn.execute('SELECT is_featured FROM products WHERE id = 1').fetchone()['is_featured'], 1)
        finally:
            conn.close()
        with self.assertRaises(HTTPException):
            self.update({'stock': 4})

    def test_restocked_featured_product_returns_without_recreation(self):
        conn = main._connect()
        try:
            conn.execute('UPDATE products SET is_active = 1, is_featured = 1 WHERE id = 1')
            # More than six recently updated but sold-out highlights.
            for product_id in range(2, 10):
                conn.execute('''INSERT INTO products (id, name, sku, stock, price, is_active, is_featured, updated_at)
                    VALUES (?, ?, ?, 0, 100, 1, 1, '2099-01-01')''',
                    (product_id, f'Agotado {product_id}', f'AG-{product_id}'))
            conn.commit()
        finally:
            conn.close()
        self.assertEqual(main.featured_products(), [])
        self.update({'stock': 5})
        self.assertEqual([p['id'] for p in main.featured_products()], [1])
        main.admin_save_showcase({'product_ids': [1]}, None)
        self.update({'is_featured': False})
        self.assertEqual(main.featured_products(), [])
        self.update({'is_featured': True})
        self.assertEqual([p['id'] for p in main.featured_products()], [1])

    def test_new_highlight_promotes_old_product_and_skips_reserved_stock(self):
        conn = main._connect()
        try:
            conn.execute("UPDATE products SET is_active = 1, stock = 5, updated_at = '2000-01-01' WHERE id = 1")
            for product_id in range(2, 10):
                conn.execute('''INSERT INTO products (id, name, sku, stock, price, is_active, is_featured, updated_at)
                    VALUES (?, ?, ?, 1, 100, 1, 1, '2001-01-01')''',
                    (product_id, f'Destacado {product_id}', f'D-{product_id}'))
            conn.commit()
        finally:
            conn.close()
        # An oversized old selection now requires an explicit editorial choice.
        main.admin_save_showcase({'product_ids': [1, 9, 8]}, None)
        self.assertEqual(main.featured_products(limit=1)[0]['id'], 1)
        with patch.object(main, '_fetch_reserved_stock', return_value={1: 5, 9: 1}):
            self.assertEqual(main.featured_products(limit=1)[0]['id'], 8)
