"""Seller retirement transfers the portfolio and preserves sales history."""
import unittest
from unittest.mock import patch

from fastapi import HTTPException

import main
import test_consignments as fixtures


class SellerRetirementTests(unittest.TestCase):
    setUp = fixtures.ConsignmentTests.setUp
    invoice = fixtures.ConsignmentTests.invoice

    def sql(self, query, params=()):
        conn = main._connect()
        try:
            cursor = conn.execute(query, params)
            rows = cursor.fetchall() if query.lstrip().upper().startswith('SELECT') else []
            conn.commit()
            return [dict(row) for row in rows]
        finally:
            conn.close()

    def portfolio(self):
        self.sql("INSERT INTO sellers (id, name, is_active) VALUES (2, 'Reemplazo', 1), (3, 'Inactivo', 0)")
        self.sql('UPDATE customers SET seller_id = 1')

    def test_transfers_active_and_inactive_customers_preserving_history(self):
        self.portfolio()
        invoice = self.invoice(quantity=1)
        self.sql('UPDATE customers SET is_active = 0 WHERE id = 2')
        before = self.sql('SELECT * FROM invoices WHERE id = ?', (invoice['id'],))
        result = main.admin_delete_seller(1, None, replacement_seller_id=2, session_token=None)
        self.assertEqual(result['reassigned_customers'], 2)
        self.assertEqual([row['seller_id'] for row in self.sql('SELECT seller_id FROM customers')], [2, 2])
        self.assertEqual(self.sql('SELECT is_active FROM sellers WHERE id = 1')[0]['is_active'], 0)
        self.assertEqual(self.sql('SELECT * FROM invoices WHERE id = ?', (invoice['id'],)), before)
        counts = {row['id']: row['customer_count'] for row in main.admin_sellers(None, None)}
        self.assertEqual(counts[1], 0)
        self.assertEqual(counts[2], 2)
        # Repeating a completed request never transfers the portfolio again.
        self.assertEqual(main.admin_delete_seller(1, None, 2, None)['reassigned_customers'], 0)

    def test_destination_is_required_and_must_be_another_active_seller(self):
        self.portfolio()
        for destination, status in [(None, 400), (1, 400), (3, 400), (999, 404)]:
            with self.subTest(destination=destination), self.assertRaises(HTTPException) as error:
                main.admin_delete_seller(1, None, destination, None)
            self.assertEqual(error.exception.status_code, status)
            self.assertEqual(self.sql('SELECT is_active FROM sellers WHERE id = 1')[0]['is_active'], 1)
            self.assertEqual([row['seller_id'] for row in self.sql('SELECT seller_id FROM customers')], [1, 1])

    def test_seller_without_customers_can_retire_without_destination(self):
        result = main.admin_delete_seller(1, None, session_token=None)
        self.assertEqual(result['reassigned_customers'], 0)
        self.assertEqual(self.sql('SELECT is_active FROM sellers WHERE id = 1')[0]['is_active'], 0)

    def test_deleted_customers_are_not_transferred(self):
        self.portfolio()
        self.sql("UPDATE customers SET deleted_at = '2026-10-07' WHERE id = 2")
        result = main.admin_delete_seller(1, None, 2, None)
        self.assertEqual(result['reassigned_customers'], 1)
        self.assertEqual(self.sql('SELECT seller_id FROM customers WHERE id = 2')[0]['seller_id'], 1)

    def test_transfer_rolls_back_if_retirement_fails(self):
        self.portfolio()
        execute = main.DBConn.execute

        def fail_retirement(conn, query, params=None):
            if query.startswith('UPDATE sellers SET is_active = 0'):
                raise RuntimeError('simulated write failure')
            return execute(conn, query, params)

        with patch.object(main.DBConn, 'execute', fail_retirement), self.assertRaises(RuntimeError):
            main.admin_delete_seller(1, None, 2, None)
        self.assertEqual([row['seller_id'] for row in self.sql('SELECT seller_id FROM customers')], [1, 1])
        self.assertEqual(self.sql('SELECT is_active FROM sellers WHERE id = 1')[0]['is_active'], 1)

    def test_missing_seller(self):
        with self.assertRaises(HTTPException) as error:
            main.admin_delete_seller(999, None, session_token=None)
        self.assertEqual(error.exception.status_code, 404)

    def test_requires_admin_before_connecting(self):
        with patch.object(main, '_require_admin', side_effect=HTTPException(status_code=403)), \
                patch.object(main, '_connect') as connect, self.assertRaises(HTTPException):
            main.admin_delete_seller(1, None, 2, None)
        connect.assert_not_called()


if __name__ == '__main__':
    unittest.main()
