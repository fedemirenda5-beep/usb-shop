"""Checkout retry regressions, using disposable databases only."""
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

import main
import test_consignments


class OrderRetryTests(unittest.TestCase):
    setUp = test_consignments.ConsignmentTests.setUp

    def order(self, **changes):
        payload = dict(customer_name='Cliente Web', customer_phone='11 1234-5678',
                       items=[{'product_id': 1, 'quantity': 2}],
                       idempotency_key=str(uuid.uuid4()))
        payload.update(changes)
        return main.create_order(main.OrderPayload(**payload))

    def count(self):
        conn = main._connect()
        try:
            return conn.execute('SELECT COUNT(*) FROM web_orders').fetchone()[0]
        finally:
            conn.close()

    def test_six_retries_with_new_keys_create_one_order_and_notification(self):
        with patch.object(main, '_send_order_email_async') as notify:
            results = [self.order() for _ in range(6)]
        self.assertTrue(all(result == results[0] for result in results))
        self.assertEqual(self.count(), 1)
        self.assertEqual(main.list_products(ids='1')[0]['stock'], 8)
        notify.assert_called_once()

    def test_simultaneous_retries_create_one_order(self):
        # Initialize schema before launching concurrent requests.
        conn = main._connect()
        main._ensure_web_order_tables(conn)
        conn.close()
        with ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(lambda _: self.order(), range(6)))
        self.assertEqual(len({result['id'] for result in results}), 1)
        self.assertEqual(self.count(), 1)

    def test_same_key_replays_even_after_window(self):
        key = str(uuid.uuid4())
        first = self.order(idempotency_key=key)
        self.age_orders()
        self.assertEqual(self.order(idempotency_key=key), first)

    def age_orders(self):
        conn = main._connect()
        try:
            conn.execute("UPDATE web_orders SET created_at = datetime('now', '-16 minutes')")
            conn.commit()
        finally:
            conn.close()

    def test_new_order_after_window_is_allowed(self):
        first = self.order()
        self.age_orders()
        self.assertNotEqual(self.order()['id'], first['id'])

    def test_changed_customer_quantity_or_notes_are_distinct(self):
        results = [self.order(), self.order(customer_phone='999'),
                   self.order(items=[{'product_id': 1, 'quantity': 1}]),
                   self.order(notes='Otro envio')]
        self.assertEqual(len({result['id'] for result in results}), 4)

    def test_format_and_browser_price_changes_do_not_duplicate(self):
        first = self.order()
        self.assertEqual(first, self.order(customer_name=' cliente   WEB ', customer_phone='(11)12345678',
                         items=[{'product_id': 1, 'quantity': 1, 'unit_price': 1},
                                {'product_id': 1, 'quantity': 1, 'unit_price': 2}]))

    def test_notification_failure_does_not_report_order_failure(self):
        with patch.object(main, '_send_order_email_async', side_effect=RuntimeError('thread unavailable')):
            first = self.order()
        self.assertEqual(first, self.order())
        self.assertEqual(self.count(), 1)

    def test_retry_recovers_order_even_when_stock_is_fully_reserved(self):
        items = [{'product_id': 1, 'quantity': 10}]
        first = self.order(items=items)
        self.assertEqual(self.order(items=items), first)


if __name__ == '__main__':
    unittest.main()
