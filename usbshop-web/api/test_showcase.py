"""Curation, automatic windows and sync preservation against a disposable DB."""
from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from fastapi import HTTPException
import main
import unittest
import test_product_updates as fixtures


class ShowcaseTests(unittest.TestCase):
    setUp = fixtures.ProductUpdateTests.setUp
    update = fixtures.ProductUpdateTests.update

    def seed(self, count=10):
        conn = main._connect()
        try:
            conn.execute('UPDATE products SET is_active=1, stock=3 WHERE id=1')
            for value in range(2, count + 1):
                conn.execute('''INSERT INTO products (id, name, sku, stock, price, is_active, is_featured, created_at)
                    VALUES (?, ?, ?, 3, 100, 1, 1, ?)''',
                    (value, f'Producto {value}', f'SKU-{value}', (datetime.now(timezone.utc)-timedelta(days=30)).isoformat()))
            conn.commit()
        finally:
            conn.close()

    def sql(self, query, params=()):
        conn = main._connect()
        try:
            result = conn.execute(query, params)
            rows = result.fetchall() if query.lstrip().upper().startswith('SELECT') else []
            conn.commit()
            return [dict(row) for row in rows]
        finally:
            conn.close()

    def test_legacy_selection_is_preserved_until_explicit_save(self):
        self.seed()
        state = main.admin_showcase(None)
        self.assertEqual(state['legacy_count'], 9)
        self.assertEqual(state['selected'], [])
        self.assertEqual(len(self.sql('SELECT id FROM products WHERE is_featured=1')), 9)
        with self.assertRaises(HTTPException):
            self.update({'is_featured': True})
        saved = main.admin_save_showcase({'product_ids': [4, 2, 1]}, None)
        self.assertEqual([p['id'] for p in saved['selected']], [4, 2, 1])
        self.assertEqual([p['id'] for p in main.featured_products()], [4, 2, 1])

    def test_limit_and_invalid_selection_are_atomic(self):
        self.seed()
        main.admin_save_showcase({'product_ids': list(range(2, 10))}, None)
        for ids in [list(range(1, 10)), [2, 2], [999], ['2'], None]:
            with self.assertRaises(HTTPException):
                main.admin_save_showcase({'product_ids': ids}, None)
            self.assertEqual([p['id'] for p in main.admin_showcase(None)['selected']], list(range(2, 10)))
        with self.assertRaises(HTTPException):
            self.update({'is_featured': True})
        with self.assertRaises(HTTPException):
            main.admin_create_product(None, None, {'name': 'Nuevo', 'sku': 'NEW', 'stock': 1, 'is_featured': True})
        self.assertEqual(self.sql("SELECT id FROM products WHERE sku='NEW'"), [])

    def test_pause_restock_order_and_empty_selection(self):
        self.seed()
        main.admin_save_showcase({'product_ids': [1, 3, 2]}, None)
        self.update({'stock': 0})
        self.assertEqual([p['id'] for p in main.featured_products()], [3, 2])
        self.assertEqual(len(main.admin_showcase(None)['selected']), 3)
        self.update({'stock': 4})
        self.assertEqual([p['id'] for p in main.featured_products()], [1, 3, 2])
        main.admin_save_showcase({'product_ids': []}, None)
        self.assertEqual(main.featured_products(), [])

    def test_windows_use_creation_and_actual_restock(self):
        self.seed(4)
        now = datetime.now(timezone.utc)
        self.sql('UPDATE products SET created_at=? WHERE id=2', ((now-timedelta(days=13)).isoformat(),))
        self.sql('UPDATE products SET created_at=? WHERE id=3', ((now-timedelta(days=15)).isoformat(),))
        self.sql('UPDATE products SET created_at=? WHERE id=4', ((now+timedelta(days=1)).isoformat(),))
        self.sql('UPDATE storefront_products SET restocked_at=? WHERE product_id=1', ((now-timedelta(days=8)).isoformat(),))
        self.assertEqual([p['id'] for p in main.storefront_collections()['new_arrivals']], [2])
        self.assertEqual(main.storefront_collections()['restocked'], [])
        self.update({'stock': 0})
        self.update({'stock': 5})
        stamp = self.sql('SELECT restocked_at FROM storefront_products WHERE product_id=1')
        self.assertEqual([p['id'] for p in main.storefront_collections()['restocked']], [1])
        self.update({'stock': 6})
        self.assertEqual(self.sql('SELECT restocked_at FROM storefront_products WHERE product_id=1'), stamp)
        with patch.object(main, '_fetch_reserved_stock', return_value={1: 6, 2: 3}):
            self.assertEqual(main.storefront_collections(), {'new_arrivals': [], 'restocked': []})

    def test_new_creation_has_date_without_restock(self):
        product = main.admin_create_product(None, None, {'name': 'Cable nuevo', 'sku': 'CABLE', 'stock': 3})
        self.assertFalse(product['is_featured'])
        self.assertEqual([p['id'] for p in main.storefront_collections()['new_arrivals']], [product['id']])
        self.assertEqual(main.storefront_collections()['restocked'], [])

    def test_sync_preserves_order_and_tracks_zero_to_available(self):
        self.seed(3)
        main.admin_save_showcase({'product_ids': [1, 3]}, None)
        self.update({'stock': 0})
        with patch.object(main, '_require_sync_token', return_value=None):
            main.sync_products(None, {'products': [{'sku': 'PROD-1', 'name': 'Producto', 'stock': 4, 'is_featured': False}]})
            self.assertEqual([p['id'] for p in main.featured_products()], [1, 3])
            self.assertEqual([p['id'] for p in main.storefront_collections()['restocked']], [1])
            self.update({'stock': 0})
            main.sync_backoffice_table(None, {'table': 'products', 'replace': True, 'rows': []})
            main.sync_backoffice_table(None, {'table': 'products', 'rows': [
                {'id': 1, 'sku': 'PROD-1', 'name': 'Producto', 'stock': 5, 'is_active': 1, 'is_featured': 0},
                {'id': 3, 'sku': 'SKU-3', 'name': 'Producto 3', 'stock': 2, 'is_active': 1, 'is_featured': 0},
            ]})
        self.assertEqual([p['id'] for p in main.featured_products()], [1, 3])
        self.assertEqual([p['id'] for p in main.storefront_collections()['restocked']], [1])

    def test_reused_identifier_does_not_inherit_selection_or_restock(self):
        self.seed(2)
        main.admin_save_showcase({'product_ids': [1]}, None)
        self.update({'stock': 0})
        self.sql("UPDATE products SET sku='DIFFERENT', stock=4 WHERE id=1")
        self.assertEqual(main.featured_products(), [])
        self.assertEqual(main.admin_showcase(None)['selected'], [])
        self.assertEqual(main.storefront_collections()['restocked'], [])
