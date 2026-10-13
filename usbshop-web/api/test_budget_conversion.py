"""Editable budget conversion keeps one document and one inventory operation."""
import unittest
from unittest.mock import patch

from fastapi import HTTPException
import main
import test_consignments as fixtures


class BudgetConversionTests(unittest.TestCase):
    setUp = fixtures.ConsignmentTests.setUp
    invoice = fixtures.ConsignmentTests.invoice
    stock = fixtures.ConsignmentTests.stock

    def document(self, invoice_id):
        conn = main._connect()
        try:
            header = dict(conn.execute('SELECT * FROM invoices WHERE id = ?', (invoice_id,)).fetchone())
            items = [dict(row) for row in conn.execute('SELECT * FROM invoice_items WHERE invoice_id = ?', (invoice_id,)).fetchall()]
            count = conn.execute('SELECT COUNT(*) AS count FROM invoices').fetchone()['count']
            movements = [dict(row) for row in conn.execute('SELECT * FROM account_movements WHERE invoice_id = ?', (invoice_id,)).fetchall()]
            return header, items, count, movements
        finally:
            conn.close()

    def test_edited_budget_becomes_only_invoice_with_same_number(self):
        budget = self.invoice(quantity=3, kind='PRESUPUESTO')
        self.assertEqual(self.stock()[0], 10)
        result = self.invoice(quantity=2, budget_invoice_id=budget['id'],
                              items=[{'product_id': 1, 'quantity': 2, 'unit_price': 1200}],
                              special_discount=100, notes='Aceptado')
        self.assertEqual(result['id'], budget['id'])
        self.assertEqual(result['external_ref'], budget['external_ref'])
        header, items, count, movements = self.document(budget['id'])
        self.assertEqual((count, header['document_type'], header['total']), (1, 'FACTURA', 2300))
        self.assertEqual(header['notes'], 'Aceptado')
        self.assertEqual([(item['quantity'], item['unit_price']) for item in items], [(2, 1200)])
        self.assertEqual(self.stock()[0], 8)
        self.assertEqual(movements, [])
        self.assertEqual(main.list_products(ids='1')[0]['soldCount'], 2)

    def test_current_account_conversion_creates_debt_once_and_rejects_retry(self):
        budget = self.invoice(quantity=2, kind='PRESUPUESTO', sale_mode='CUENTA_CORRIENTE')
        self.invoice(quantity=2, budget_invoice_id=budget['id'], sale_mode='CUENTA_CORRIENTE')
        with self.assertRaises(HTTPException) as error:
            self.invoice(quantity=2, budget_invoice_id=budget['id'], sale_mode='CUENTA_CORRIENTE')
        self.assertEqual(error.exception.status_code, 409)
        header, items, count, movements = self.document(budget['id'])
        self.assertEqual(count, 1)
        self.assertEqual(len(items), 1)
        self.assertEqual([(row['movement_type'], row['amount']) for row in movements], [('DEBIT', 2000)])
        self.assertEqual(self.stock()[0], 8)

    def test_insufficient_stock_preserves_original_budget(self):
        budget = self.invoice(quantity=3, kind='PRESUPUESTO')
        original = self.document(budget['id'])
        with self.assertRaises(HTTPException):
            self.invoice(quantity=11, budget_invoice_id=budget['id'])
        self.assertEqual(self.document(budget['id']), original)
        self.assertEqual(self.stock()[0], 10)

    def test_failure_after_header_update_rolls_back_budget_and_items(self):
        budget = self.invoice(quantity=3, kind='PRESUPUESTO')
        original = self.document(budget['id'])
        with patch.object(main, '_store_invoice_item_imeis', side_effect=RuntimeError('storage failed')):
            with self.assertRaises(RuntimeError):
                self.invoice(quantity=2, budget_invoice_id=budget['id'])
        self.assertEqual(self.document(budget['id']), original)
        self.assertEqual(self.stock()[0], 10)

    def test_only_existing_budgets_can_be_converted_to_invoice(self):
        with self.assertRaises(HTTPException) as missing:
            self.invoice(budget_invoice_id=99999)
        self.assertEqual(missing.exception.status_code, 404)
        budget = self.invoice(kind='PRESUPUESTO')
        with self.assertRaises(HTTPException) as wrong_type:
            self.invoice(budget_invoice_id=budget['id'], kind='NOTA_CREDITO')
        self.assertEqual(wrong_type.exception.status_code, 400)
        self.assertEqual(self.document(budget['id'])[0]['document_type'], 'PRESUPUESTO')

    def test_linked_web_order_is_confirmed_using_same_document(self):
        order = main.create_order(main.OrderPayload(customer_name='Web', customer_phone='123',
            idempotency_key='budget-conversion-order', items=[{'product_id': 1, 'quantity': 10}]))
        budget = self.invoice(quantity=10, kind='PRESUPUESTO', order_id=order['id'])
        result = self.invoice(quantity=10, budget_invoice_id=budget['id'])
        self.assertEqual(result['id'], budget['id'])
        self.assertEqual(self.stock()[0], 0)
        conn = main._connect()
        try:
            row = conn.execute('SELECT status, confirmed_invoice_id FROM web_orders WHERE id = ?', (order['id'],)).fetchone()
            self.assertEqual(row['status'], 'CONFIRMED')
            self.assertEqual(int(row['confirmed_invoice_id']), budget['id'])
        finally:
            conn.close()


if __name__ == '__main__':
    unittest.main()
