"""Order counters must cover the database, not just the visible page."""
import unittest

import main
import test_consignments


class OrderSummaryTests(unittest.TestCase):
    setUp = test_consignments.ConsignmentTests.setUp

    def seed(self):
        conn = main._connect()
        try:
            main._ensure_web_order_tables(conn)
            for order_id in range(1, 151):
                status = 'PENDING' if order_id <= 125 else (
                    'CONFIRMED' if order_id <= 140 else (
                        'BUDGETED' if order_id <= 145 else 'CANCELLED'))
                conn.execute(
                    'INSERT INTO web_orders (id, customer_name, customer_phone, total, status, created_at) '
                    'VALUES (?, ?, ?, ?, ?, ?)',
                    (order_id, 'Cliente', '123', 100, status, '2026-01-01T12:00:00'),
                )
            conn.commit()
        finally:
            conn.close()

    def load(self, **options):
        return main.admin_list_orders(None, None, status='ALL', limit=120,
                                      include_items=False, **options)

    def test_summary_counts_orders_beyond_page_limit_and_keeps_legacy_response(self):
        self.seed()
        response = self.load(include_summary=True)
        self.assertEqual(len(response['orders']), 120)
        self.assertEqual(response['summary'], {
            'total': 150, 'pending': 125, 'processed': 25,
            'confirmed': 15, 'cancelled': 5,
        })
        self.assertEqual(len(self.load()), 120)
        self.assertNotIn('items', response['orders'][0])

    def test_counts_update_after_new_order_confirmation_and_deletion(self):
        self.seed()
        order = main.create_order(main.OrderPayload(
            customer_name='Nuevo', customer_phone='456',
            idempotency_key='order-summary-new-order',
            items=[{'product_id': 1, 'quantity': 1}],
        ))
        self.assertEqual(self.load(include_summary=True)['summary']['total'], 151)
        main.admin_update_order_status(order['id'], None, None,
                                       main.OrderStatusPayload(status='CONFIRMED'))
        self.assertEqual(self.load(include_summary=True)['summary'], {
            'total': 151, 'pending': 125, 'processed': 26,
            'confirmed': 16, 'cancelled': 5,
        })
        main.admin_update_order_status(1, None, None, main.OrderStatusPayload(status='DELETED'))
        summary = self.load(include_summary=True)['summary']
        self.assertEqual(summary['total'], 150)
        self.assertEqual(summary['pending'], 124)

    def test_empty_database_has_zero_counts(self):
        self.assertEqual(self.load(include_summary=True), {
            'orders': [], 'summary': {'total': 0, 'pending': 0, 'processed': 0,
                                     'confirmed': 0, 'cancelled': 0},
        })


if __name__ == '__main__':
    unittest.main()
