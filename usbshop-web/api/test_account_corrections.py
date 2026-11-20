"""Historical account corrections use disposable databases and preserve invoice history."""
import unittest
from unittest.mock import patch

from fastapi import HTTPException
import main
import test_consignments as fixtures


class AccountCorrectionTests(unittest.TestCase):
    setUp = fixtures.ConsignmentTests.setUp
    invoice = fixtures.ConsignmentTests.invoice

    def setUp(self):
        fixtures.ConsignmentTests.setUp(self)
        patcher = patch.object(
            main,
            "_require_full_admin",
            return_value={"id": 1, "username": "test-admin", "role": "admin"},
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def sql(self, query, params=()):
        conn = main._connect()
        try:
            rows = conn.execute(query, params).fetchall()
            return [dict(row) for row in rows]
        finally:
            conn.close()

    def reclassify(self, invoice_id, replace_adjustment=True):
        return main.admin_reclassify_invoice_to_account(
            invoice_id,
            None,
            {
                "sale_mode": "CUENTA_CORRIENTE",
                "replace_matching_adjustment": replace_adjustment,
            },
            None,
        )

    def test_reclassification_replaces_matching_adjustment_without_changing_balance(self):
        invoice = self.invoice(
            quantity=1,
            created_at="2026-10-28T19:00:00Z",
            sale_mode="CONTADO",
        )
        main.admin_cc_create_movement(
            1,
            None,
            None,
            {
                "movement_type": "DEBIT",
                "entry_kind": "ADJUSTMENT",
                "amount": invoice["total"],
                "created_at": "2026-10-28T16:25:26-03:00",
                "reference": "Venta 28/10",
                "payment_method": "Ajuste",
            },
        )
        adjustment = self.sql(
            "SELECT id FROM account_movements WHERE customer_id = 1 AND entry_kind = 'ADJUSTMENT'"
        )[0]

        result = self.reclassify(invoice["id"])

        stored_invoice = self.sql("SELECT sale_mode FROM invoices WHERE id = ?", (invoice["id"],))[0]
        movements = self.sql(
            "SELECT * FROM account_movements WHERE customer_id = 1 ORDER BY id"
        )
        active = [row for row in movements if not row.get("is_deleted")]
        self.assertEqual(stored_invoice["sale_mode"], "CUENTA_CORRIENTE")
        self.assertEqual(result["replaced_adjustment_id"], adjustment["id"])
        self.assertEqual(result["balance"], invoice["total"])
        self.assertEqual(len(active), 1)
        self.assertEqual(active[0]["invoice_id"], invoice["id"])
        self.assertEqual(active[0]["entry_kind"], "SALE")
        self.assertEqual(active[0]["created_at"], "2026-10-28T19:00:00Z")
        self.assertEqual(
            next(row for row in movements if row["id"] == adjustment["id"])["is_deleted"],
            1,
        )

    def test_reclassification_without_adjustment_creates_sale_at_invoice_date_once(self):
        invoice = self.invoice(
            quantity=2,
            created_at="2026-10-20T13:00:00Z",
            sale_mode="CONTADO",
        )

        first = self.reclassify(invoice["id"], replace_adjustment=False)
        second = self.reclassify(invoice["id"], replace_adjustment=False)

        movement = self.sql(
            "SELECT * FROM account_movements WHERE customer_id = 1 AND invoice_id = ? AND is_deleted = 0",
            (invoice["id"],),
        )
        self.assertEqual(first["balance"], invoice["total"])
        self.assertEqual(second["sale_mode"], "CUENTA_CORRIENTE")
        self.assertEqual(len(movement), 1)
        self.assertEqual(movement[0]["created_at"], "2026-10-20T13:00:00Z")

    def test_ambiguous_adjustments_abort_without_mutating_invoice_or_movements(self):
        invoice = self.invoice(
            quantity=1,
            created_at="2026-10-28T19:00:00Z",
            sale_mode="CONTADO",
        )
        for _ in range(2):
            main.admin_cc_create_movement(
                1,
                None,
                None,
                {
                    "movement_type": "DEBIT",
                    "entry_kind": "ADJUSTMENT",
                    "amount": invoice["total"],
                    "created_at": "2026-10-28T16:25:26-03:00",
                    "reference": "Venta 28/10",
                    "payment_method": "Ajuste",
                },
            )

        with self.assertRaises(HTTPException) as failure:
            self.reclassify(invoice["id"])

        self.assertEqual(failure.exception.status_code, 409)
        self.assertEqual(self.sql("SELECT sale_mode FROM invoices WHERE id = ?", (invoice["id"],))[0]["sale_mode"], "CONTADO")
        self.assertEqual(
            len(self.sql("SELECT id FROM account_movements WHERE customer_id = 1 AND is_deleted = 0")),
            2,
        )

    def test_manual_movement_accepts_and_updates_historical_timestamp(self):
        main.admin_cc_create_movement(
            1,
            None,
            None,
            {
                "movement_type": "CREDIT",
                "entry_kind": "PAYMENT",
                "amount": 92360,
                "created_at": "2026-10-14T12:00:00-03:00",
                "payment_method": "Transferencia",
                "reference": "Transferencia 14/10",
            },
        )
        movement = self.sql("SELECT * FROM account_movements WHERE customer_id = 1")[0]
        main.admin_cc_update_movement(
            1,
            movement["id"],
            None,
            None,
            {
                "movement_type": "CREDIT",
                "entry_kind": "PAYMENT",
                "amount": 92360,
                "created_at": "2026-10-14T13:00:00-03:00",
                "payment_method": "Transferencia",
                "reference": "Transferencia 14/10",
                "invoice_id": None,
            },
        )

        updated = self.sql(
            "SELECT created_at FROM account_movements WHERE id = ?",
            (movement["id"],),
        )[0]
        self.assertEqual(updated["created_at"], "2026-10-14T13:00:00-03:00")

    def test_invalid_manual_movement_timestamp_is_rejected(self):
        with self.assertRaises(HTTPException) as failure:
            main.admin_cc_create_movement(
                1,
                None,
                None,
                {
                    "movement_type": "CREDIT",
                    "entry_kind": "PAYMENT",
                    "amount": 92360,
                    "created_at": "yesterday-ish",
                },
            )
        self.assertEqual(failure.exception.status_code, 400)
        self.assertEqual(self.sql("SELECT id FROM account_movements"), [])


if __name__ == "__main__":
    unittest.main()
