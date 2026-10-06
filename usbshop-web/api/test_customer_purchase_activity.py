"""Customer purchase reports use disposable data and Argentina calendar dates."""
import unittest
from datetime import datetime
from unittest.mock import patch

from fastapi import HTTPException

import main
import test_consignments as fixtures


class CustomerPurchaseActivityTests(unittest.TestCase):
    setUp = fixtures.ConsignmentTests.setUp
    invoice = fixtures.ConsignmentTests.invoice

    def dated_invoice(self, date, **kwargs):
        invoice = self.invoice(quantity=1, **kwargs)
        conn = main._connect()
        try:
            conn.execute('UPDATE invoices SET created_at=? WHERE id=?', (date, invoice['id']))
            conn.commit()
        finally:
            conn.close()
        return invoice

    def report(self, month='2026-10', **kwargs):
        with patch.object(main, '_argentina_now', return_value=datetime(2026, 10, 6, 12, tzinfo=main.ARGENTINA_TZ)):
            return main.admin_backoffice_customers(None, None, purchase_month=month, **kwargs)

    def test_net_sales_last_purchase_and_customers_without_history(self):
        self.dated_invoice('2026-09-20 12:00:00')
        self.dated_invoice('2026-10-02 12:00:00')
        self.dated_invoice('2026-10-03 12:00:00', kind='NOTA_CREDITO')
        self.dated_invoice('2026-10-05 12:00:00', kind='PRESUPUESTO')
        customers = {item['id']: item for item in self.report()}
        customer, never_bought = customers[1], customers[2]
        self.assertEqual(customer['monthly_sales_total'], 0)
        self.assertEqual(customer['monthly_purchase_count'], 1)
        self.assertEqual(customer['last_purchase_month'], '2026-10')
        self.assertEqual(customer['days_without_purchase'], 4)
        self.assertEqual(never_bought['monthly_sales_total'], 0)
        self.assertEqual(never_bought['monthly_purchase_count'], 0)
        self.assertIsNone(never_bought['last_purchase_at'])
        self.assertIsNone(never_bought['days_without_purchase'])

    def test_argentina_month_boundaries_and_old_purchase(self):
        self.dated_invoice('2026-10-01T02:59:59Z')  # September 30 in Argentina.
        self.dated_invoice('2026-10-01T03:00:00Z', customer=2)
        customers = {item['id']: item for item in self.report(summary=True)}
        september, october = customers[1], customers[2]
        self.assertEqual(september['monthly_sales_total'], 0)
        self.assertEqual(september['monthly_purchase_count'], 0)
        self.assertEqual(september['last_purchase_month'], '2026-09')
        self.assertEqual(september['days_without_purchase'], 6)
        self.assertEqual(october['monthly_sales_total'], 1000)
        self.assertEqual(october['days_without_purchase'], 5)
        self.assertEqual(self.report(month='2026-09', q='Uno')[0]['monthly_sales_total'], 1000)

    def test_credit_only_is_not_a_purchase_and_filters_are_preserved(self):
        self.dated_invoice('2026-10-02 12:00:00', kind='NOTA_CREDITO')
        customer = self.report(q='Uno')[0]
        self.assertEqual(customer['monthly_sales_total'], -1000)
        self.assertEqual(customer['monthly_purchase_count'], 0)
        self.assertIsNone(customer['last_purchase_at'])
        self.assertEqual(len(self.report(q='Uno')), 1)
        self.assertEqual(self.report(offset=1, limit=1)[0]['id'], 1)

    def test_deleted_invoices_and_invalid_months(self):
        invoice = self.dated_invoice('2026-10-02 12:00:00')
        main.admin_delete_invoice(invoice['id'], None, None)
        customer = self.report(q='Uno')[0]
        self.assertIsNone(customer['last_purchase_at'])
        self.assertEqual(customer['monthly_purchase_count'], 0)
        self.assertEqual(customer['monthly_sales_total'], 0)
        for month in ['2026-13', '2026-1', '', 'bad']:
            with self.subTest(month=month), self.assertRaises(HTTPException) as error:
                self.report(month=month)
            self.assertEqual(error.exception.status_code, 400)

    def test_normal_list_does_not_include_activity(self):
        self.assertNotIn('monthly_sales_total', main.admin_backoffice_customers(None, None)[0])


if __name__ == '__main__':
    unittest.main()
