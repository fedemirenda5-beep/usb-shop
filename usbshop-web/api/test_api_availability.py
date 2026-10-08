"""Availability checks use fake connections, never a production database."""
import asyncio
import unittest
from unittest.mock import Mock, patch

import anyio
from fastapi import HTTPException, Request

import main


class AvailabilityTests(unittest.TestCase):
    def test_session_verification_does_not_wait_for_busy_database_workers(self):
        async def run():
            limiter = anyio.to_thread.current_default_thread_limiter()
            # Occupy every worker token without running real database/image work.
            borrowers = [object() for _ in range(limiter.total_tokens)]
            for borrower in borrowers:
                limiter.acquire_on_behalf_of_nowait(borrower)
            try:
                with patch.object(main, 'AUTH_SECRET', 'availability-test-secret'), patch.object(main, '_connect', side_effect=AssertionError('Session must not access DB')):
                    token = main._sign_session({'id': 7, 'username': 'test', 'role': 'admin', 'exp': main.time.time() + 60})
                    for cookie, status in [(token, 200), ('invalid', 401)]:
                        request = Request({'type': 'http', 'method': 'GET', 'path': '/auth/me',
                                           'query_string': b'', 'headers': [(b'cookie', f'{main.SESSION_COOKIE}={cookie}'.encode())]})
                        # Use the registered FastAPI handler, including parameter resolution.
                        route = next(route for route in main.app.routes if getattr(route, 'path', '') == '/auth/me')
                        if status == 200:
                            response = await asyncio.wait_for(route.get_route_handler()(request), timeout=1)
                            self.assertEqual(response.status_code, status)
                            self.assertIn(b'"username":"test"', response.body)
                        else:
                            with self.assertRaises(HTTPException) as failure:
                                await asyncio.wait_for(route.get_route_handler()(request), timeout=1)
                            self.assertEqual(failure.exception.status_code, status)
            finally:
                for borrower in borrowers:
                    limiter.release_on_behalf_of(borrower)

        asyncio.run(run())

    def test_postgres_connection_has_bounded_wait_and_preserves_ssl(self):
        for url, expected_ssl in [('postgresql://test/db', 'require'), ('postgresql://test/db?sslmode=verify-full', None)]:
            with self.subTest(url=url), patch.object(main, 'DB_IS_POSTGRES', True), patch.object(main, 'DB_URL', url), patch.object(main, 'psycopg2') as driver:
                connection = main._connect()
                expected = {'connect_timeout': main.DB_CONNECT_TIMEOUT_SECONDS}
                if expected_ssl:
                    expected['sslmode'] = expected_ssl
                driver.connect.assert_called_once_with(url, **expected)
                connection.close()
                driver.connect.return_value.close.assert_called_once()

    def test_authentication_failures_are_not_cached(self):
        for path in ['/auth/me', '/admin/products']:
            messages = self.request(path)
            response = next(item for item in messages if item['type'] == 'http.response.start')
            self.assertEqual(response['status'], 401)
            self.assertEqual(dict(response['headers'])[b'cache-control'], b'no-store')

    def request(self, path):
        async def run():
            messages = []
            delivered = False

            async def receive():
                nonlocal delivered
                if not delivered:
                    delivered = True
                    return {'type': 'http.request', 'body': b'', 'more_body': False}
                await asyncio.Event().wait()

            async def send(message):
                messages.append(message)

            scope = {'type': 'http', 'asgi': {'version': '3.0', 'spec_version': '2.4'},
                     'http_version': '1.1', 'method': 'GET', 'scheme': 'https',
                     'path': path, 'raw_path': path.encode(), 'query_string': b'',
                     'root_path': '', 'server': ('testserver', 443), 'client': ('127.0.0.1', 1),
                     'headers': [(b'origin', b'https://www.usbshop.com.ar')]}
            try:
                await main.app(scope, receive, send)
            except RuntimeError:
                # ServerErrorMiddleware re-raises after sending the error response.
                pass
            return messages

        return asyncio.run(asyncio.wait_for(run(), timeout=5))

    def test_database_failure_through_actual_middleware_stack(self):
        for path, status in [('/health', 503), ('/categories', 500)]:
            with self.subTest(path=path), patch.object(main, '_connect', side_effect=RuntimeError('private database address')), patch.object(main, 'LOGGER'):
                messages = self.request(path)
                response = next(item for item in messages if item['type'] == 'http.response.start')
                headers = dict(response['headers'])
                self.assertEqual(response['status'], status)
                self.assertEqual(headers[b'access-control-allow-origin'], b'https://www.usbshop.com.ar')
                self.assertTrue(headers.get(b'x-request-id'))
                body = b''.join(item.get('body', b'') for item in messages)
                self.assertNotIn(b'private database address', body)

    def test_health_checks_database_and_closes_connection(self):
        connection = Mock()
        with patch.object(main, '_connect', return_value=connection), patch.object(main, '_RUNTIME_SCHEMA_READY', True):
            self.assertEqual(main.health()['status'], 'ok')
        connection.execute.assert_called_once_with('SELECT 1')
        connection.close.assert_called_once()

    def test_health_reports_unavailable_database_without_exposing_details(self):
        with patch.object(main, '_connect', side_effect=RuntimeError('private database address')), patch.object(main.LOGGER, 'exception'):
            with self.assertRaises(HTTPException) as failure:
                main.health()
        self.assertEqual(failure.exception.status_code, 503)
        self.assertNotIn('private', failure.exception.detail)

    def test_failed_query_still_closes_connection(self):
        connection = Mock()
        connection.execute.side_effect = RuntimeError('connection lost')
        with patch.object(main, '_connect', return_value=connection), patch.object(main.LOGGER, 'exception'):
            with self.assertRaises(HTTPException) as failure:
                main.health()
        self.assertEqual(failure.exception.status_code, 503)
        connection.close.assert_called_once()

    def test_health_reports_failed_schema_initialization(self):
        with patch.object(main, '_connect', return_value=Mock()), patch.object(main, '_RUNTIME_SCHEMA_READY', False):
            with self.assertRaises(HTTPException) as failure:
                main.health()
        self.assertEqual(failure.exception.status_code, 503)

    def test_unhandled_error_is_readable_only_by_allowed_origins(self):
        for origin, allowed in [('https://www.usbshop.com.ar', True), ('https://usbshop.com.ar', True), ('https://untrusted.invalid', False)]:
            with self.subTest(origin=origin), patch.object(main.LOGGER, 'error'):
                request = Request({'type': 'http', 'method': 'GET', 'path': '/admin/products',
                                   'headers': [(b'origin', origin.encode())]})
                request.state.request_id = 'test-request-id'
                response = main.unhandled_exception_handler(request, RuntimeError('private error'))
                self.assertEqual(response.status_code, 500)
                self.assertNotIn(b'private error', response.body)
                self.assertEqual(response.headers.get('X-Request-ID'), 'test-request-id')
                self.assertEqual(response.headers.get('Access-Control-Allow-Origin'), origin if allowed else None)
                if allowed:
                    self.assertEqual(response.headers.get('Access-Control-Allow-Credentials'), 'true')
                    self.assertIn('Origin', response.headers.get('Vary', ''))


if __name__ == '__main__':
    unittest.main()
