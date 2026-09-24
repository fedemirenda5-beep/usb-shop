"""Public sold counts use real invoices in a disposable database."""
import unittest
from datetime import datetime, timezone

import main
import test_consignments as fixtures


class SoldCountTests(unittest.TestCase):
    setUp = fixtures.ConsignmentTests.setUp
    invoice = fixtures.ConsignmentTests.invoice

    def count(self):
        return main.list_products(ids='1')[0]['soldCount']

    def test_only_net_invoiced_units_are_public(self):
        self.assertEqual(self.count(), 0)
        self.invoice(quantity=3, kind='PRESUPUESTO')
        self.assertEqual(self.count(), 0)
        sale = self.invoice(quantity=5)
        self.assertEqual(self.count(), 5)
        credit = self.invoice(quantity=2, kind='NOTA_CREDITO')
        self.assertEqual(self.count(), 3)
        self.assertEqual(main.featured_products()[0]['soldCount'], 3)
        main.admin_delete_invoice(credit['id'], None, None)
        self.assertEqual(self.count(), 5)
        main.admin_delete_invoice(sale['id'], None, None)
        self.assertEqual(self.count(), 0)

    def test_pending_orders_are_not_sales(self):
        main.create_order(main.OrderPayload(
            items=[{'product_id': 1, 'quantity': 2}],
            customer_name='Web', customer_phone='123', idempotency_key='sold-count-test-pending',
        ))
        self.assertEqual(self.count(), 0)

    def test_counts_are_scoped_and_included_in_collections(self):
        sale = self.invoice(quantity=4)
        conn = main._connect()
        try:
            conn.execute("UPDATE invoices SET document_type='FACTURA_C' WHERE id=?", (sale['id'],))
            conn.execute('UPDATE products SET created_at=? WHERE id=1', (datetime.now(timezone.utc).isoformat(),))
            conn.commit()
            self.assertEqual(main._fetch_product_sold_counts(conn, []), {})
            self.assertEqual(main._fetch_product_sold_counts(conn, [2]), {})
        finally:
            conn.close()
        self.assertEqual(self.count(), 4)
        self.assertEqual(main.list_products(ids='2')[0]['soldCount'], 0)
        self.assertEqual(main.storefront_collections()['new_arrivals'][0]['soldCount'], 4)

    def test_historical_credits_never_produce_negative_counts(self):
        self.invoice(quantity=2, kind='NOTA_CREDITO')
        self.assertEqual(self.count(), 0)


if __name__ == '__main__':
    unittest.main()
