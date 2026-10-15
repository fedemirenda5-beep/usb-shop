import sqlite3
import unittest

from product_discovery import discovery_order
import main
import test_consignments as fixtures


class ProductDiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(':memory:')
        self.addCleanup(self.conn.close)
        self.conn.execute('CREATE TABLE products (id INTEGER, category_id INTEGER, stock INTEGER, is_bundle INTEGER)')
        self.conn.executemany('INSERT INTO products VALUES (?, ?, ?, 0)', [
            (i, 1 if i <= 150 else 2 if i <= 175 else 3, 0 if i % 7 == 0 else 10)
            for i in range(1, 201)
        ])

    def selection(self, seed, limit=100, offset=0):
        order, params = discovery_order(seed)
        return self.conn.execute(
            f'SELECT p.id, p.category_id, p.stock FROM products p ORDER BY {order} LIMIT ? OFFSET ?',
            [*params, limit, offset],
        ).fetchall()

    def test_includes_old_products_and_balances_uneven_categories(self):
        rows = self.selection(921783551, 12)
        self.assertEqual({row[1] for row in rows}, {1, 2, 3})
        self.assertEqual([sum(row[1] == category for row in rows) for category in [1, 2, 3]], [4, 4, 4])
        self.assertTrue(all(row[2] > 0 for row in rows))
        self.assertTrue(any(row[0] < 150 for row in rows))

    def test_visit_order_is_stable_but_varies_by_seed(self):
        self.assertEqual(self.selection(123456789), self.selection(123456789))
        self.assertNotEqual(self.selection(123456789), self.selection(921783551))

    def test_paging_never_repeats_or_skips_and_puts_unavailable_last(self):
        rows = self.selection(4294967295) + self.selection(4294967295, offset=100)
        self.assertEqual(len({row[0] for row in rows}), 200)
        self.assertEqual(rows, self.selection(4294967295, 200))
        first_unavailable = next(index for index, row in enumerate(rows) if row[2] == 0)
        self.assertTrue(all(row[2] == 0 for row in rows[first_unavailable:]))


class PublicDiscoveryIntegrationTests(unittest.TestCase):
    setUp = fixtures.ConsignmentTests.setUp

    def test_public_catalog_keeps_visibility_deduplication_and_pagination(self):
        conn = main._connect()
        try:
            conn.execute("INSERT INTO categories (id, name) VALUES (2, 'Hogar')")
            conn.execute("""INSERT INTO products (id, name, sku, price, stock, cost, category_id, is_active)
                VALUES (3, 'Oculto', 'HIDDEN', 100, 10, 50, 2, 0),
                       (4, 'Cable USB', 'NEW', 100, 10, 50, 1, 1),
                       (5, 'Producto antiguo', 'OLD', 100, 10, 50, 2, 1)""")
            conn.commit()
        finally:
            conn.close()
        rows = main.list_products(sort='discover', seed=912783551, limit=100)
        self.assertEqual({row['id'] for row in rows}, {2, 4, 5})
        first = main.list_products(sort='discover', seed=912783551, limit=2)
        second = main.list_products(sort='discover', seed=912783551, limit=2, offset=2)
        self.assertEqual(first + second, rows)
        self.assertEqual(main.list_products(q='Cable', sort='discover', seed=1), main.list_products(q='Cable'))


if __name__ == '__main__':
    unittest.main()
