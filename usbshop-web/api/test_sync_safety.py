"""Sync regressions: never erase or overwrite payments recorded on the web."""
import sqlite3
from contextlib import closing
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import main
from scripts import sync_backoffice_to_api as sync_script


class SyncSafetyTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.database = Path(directory.name) / 'sync.db'
        with closing(sqlite3.connect(self.database)) as conn, conn:
            for table in ('account_movements', 'categories'):
                fields = ', '.join(f'{name} {kind}' for name, kind, _ in main.SYNC_TABLE_SCHEMAS[table])
                conn.execute(f'CREATE TABLE {table} ({fields})')
            conn.execute("INSERT INTO categories (id, name) VALUES (1, 'Original')")
        for name, value in {
            'DB_IS_POSTGRES': False, 'DB_PATH': self.database,
            'SOURCE_DB_PATH': self.database,
            '_require_sync_token': lambda request: None,
            '_ensure_syncable_tables': lambda conn: None,
        }.items():
            patcher = patch.object(main, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        main._TABLE_EXISTS_CACHE.clear()
        main._COLUMN_EXISTS_CACHE.clear()
        self.addCleanup(main._TABLE_EXISTS_CACHE.clear)
        self.addCleanup(main._COLUMN_EXISTS_CACHE.clear)

    def seed_payments(self):
        with closing(sqlite3.connect(self.database)) as conn, conn:
            for movement_id, amount in enumerate([100000] * 3 + [200000] * 2, 1):
                conn.execute('INSERT INTO account_movements (id, customer_id, amount, movement_type) VALUES (?, 403, ?, ?)',
                             (movement_id, amount, 'CREDIT'))

    def assert_payments_preserved(self):
        with closing(sqlite3.connect(self.database)) as conn, conn:
            self.assertEqual(conn.execute('SELECT COUNT(*), SUM(amount) FROM account_movements').fetchone(), (5, 700000))

    def test_full_sync_preflight_rejects_existing_payments(self):
        self.seed_payments()
        with self.assertRaises(main.HTTPException) as error:
            main.sync_backoffice_preflight(None)
        self.assertEqual(error.exception.status_code, 409)
        self.assert_payments_preserved()

    def test_old_sync_client_cannot_delete_any_table_with_existing_ledger(self):
        self.seed_payments()
        for table in ('account_movements', 'categories'):
            with self.subTest(table=table), self.assertRaises(main.HTTPException) as error:
                main.sync_backoffice_table(None, {'table': table, 'replace': True, 'rows': []})
            self.assertEqual(error.exception.status_code, 409)
        self.assert_payments_preserved()
        with closing(sqlite3.connect(self.database)) as conn, conn:
            self.assertEqual(conn.execute('SELECT name FROM categories').fetchone()[0], 'Original')

    def test_collision_rejects_whole_batch_without_overwriting_or_inserting(self):
        self.seed_payments()
        with self.assertRaises(main.HTTPException) as error:
            main.sync_backoffice_table(None, {'table': 'account_movements', 'rows': [
                {'id': 6, 'customer_id': 403, 'amount': 900000, 'movement_type': 'DEBIT'},
                {'id': 1, 'customer_id': 999, 'amount': 1, 'movement_type': 'CREDIT'},
            ]})
        self.assertEqual(error.exception.status_code, 409)
        self.assert_payments_preserved()

    def test_empty_ledger_can_import_multiple_batches(self):
        self.assertEqual(main.sync_backoffice_preflight(None), {'status': 'ok'})
        for movement_id in (1, 2):
            result = main.sync_backoffice_table(None, {'table': 'account_movements', 'rows': [
                {'id': movement_id, 'customer_id': 403, 'amount': 100000, 'movement_type': 'CREDIT'},
            ]})
            self.assertEqual(result['processed'], 1)
        with closing(sqlite3.connect(self.database)) as conn, conn:
            self.assertEqual(conn.execute('SELECT SUM(amount) FROM account_movements').fetchone()[0], 200000)

    def test_script_stops_before_first_mutation_when_preflight_fails(self):
        with patch.object(sync_script, 'SYNC_TOKEN', 'test-token'), \
             patch.object(sync_script, '_source_db', return_value=self.database), \
             patch.object(sync_script, '_request_json', side_effect=RuntimeError('blocked')) as request:
            with self.assertRaises(RuntimeError):
                sync_script.main()
            request.assert_called_once_with('/admin/sync/preflight', {})


if __name__ == '__main__':
    unittest.main()
