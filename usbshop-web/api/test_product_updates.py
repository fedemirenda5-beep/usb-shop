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
