"""Availability checks use fake connections, never a production database."""
import asyncio
import threading
import unittest
from unittest.mock import Mock, patch

import anyio
from fastapi import HTTPException, Request

import main


class AvailabilityTests(unittest.TestCase):
    def test_image_workers_are_bounded_and_do_not_block_database_requests(self):
        async def run():
            release = threading.Event()
            started = []
            limiter = anyio.CapacityLimiter(2)

            def slow_image(*args):
                started.append(args[0])
                release.wait(timeout=5)
                return main.Response(content=b'image', media_type='image/webp')

            with patch.object(main, '_IMAGE_WORKER_LIMITER', limiter), patch.object(main, '_product_image_response', side_effect=slow_image), patch.object(main, '_connect', return_value=Mock()), patch.object(main, '_RUNTIME_SCHEMA_READY', True):
                route = next(route for route in main.app.routes if getattr(route, 'path', '') == '/products/{product_id}/image')
                tasks = []
                try:
                    for product_id in range(4):
                        request = Request({'type': 'http', 'method': 'GET', 'path': f'/products/{product_id}/image',
                                           'path_params': {'product_id': str(product_id)}, 'query_string': b'w=420', 'headers': []})
                        tasks.append(asyncio.create_task(route.get_route_handler()(request)))
                    with anyio.fail_after(2):
                        while len(started) < 2:
                            await anyio.sleep(0.01)
                    self.assertEqual(len(started), 2)
                    health_route = next(route for route in main.app.routes if getattr(route, 'path', '') == '/health')
                    request = Request({'type': 'http', 'method': 'GET', 'path': '/health', 'query_string': b'', 'headers': []})
                    response = await asyncio.wait_for(health_route.get_route_handler()(request), timeout=1)
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(len(started), 2)
                finally:
                    release.set()
                    if tasks:
                        responses = await asyncio.gather(*tasks)
                        self.assertTrue(all(response.status_code == 200 for response in responses))
                self.assertEqual(len(started), 4)

        asyncio.run(run())

    def test_image_requests_do_not_use_database_worker_tokens(self):
        async def run():
            limiter = anyio.to_thread.current_default_thread_limiter()
            borrowers = [object() for _ in range(limiter.total_tokens)]
            for borrower in borrowers:
                limiter.acquire_on_behalf_of_nowait(borrower)
            try:
                with patch.object(main, '_IMAGE_WORKER_LIMITER', None), patch.object(main, '_product_image_response', return_value=main.Response(content=b'image')):
                    response = await asyncio.wait_for(main.product_image(1, 0, 420, 315, 72, 'webp'), timeout=1)
                    self.assertEqual(response.status_code, 200)
            finally:
                for borrower in borrowers:
                    limiter.release_on_behalf_of(borrower)

        asyncio.run(run())

    def test_remote_download_failure_is_not_repeated_for_thumbnail_fallback(self):
        connection = Mock()
        connection.execute.return_value.fetchone.return_value = {'image_path': ''}
        with patch.object(main, '_connect', return_value=connection), patch.object(main, '_product_image_candidates', return_value=['https://images.test/product.jpg']), patch.object(main, 'Image', Mock()), patch.object(main, 'ImageOps', Mock()), patch.object(main, '_get_remote_thumbnail_cache', return_value=None), patch.object(main, '_fetch_remote_image_bytes', side_effect=TimeoutError('remote image timed out')) as download:
            with self.assertRaises(TimeoutError):
                main._product_image_response(1, 0, 420, 315, 72, 'webp')
            download.assert_called_once()

    def test_render_failure_reuses_downloaded_original(self):
        connection = Mock()
        connection.execute.return_value.fetchone.return_value = {'image_path': ''}
        with patch.object(main, '_connect', return_value=connection), patch.object(main, '_product_image_candidates', return_value=['https://images.test/product.jpg']), patch.object(main, 'Image', Mock()), patch.object(main, 'ImageOps', Mock()), patch.object(main, '_get_remote_thumbnail_cache', return_value=None), patch.object(main, '_fetch_remote_image_bytes', return_value=(b'original', 'image/jpeg')) as download, patch.object(main, '_render_thumbnail_from_bytes', side_effect=ValueError('bad format')), patch.object(main.logging, 'exception'):
            response = main._product_image_response(1, 0, 420, 315, 72, 'webp')
            self.assertEqual(response.body, b'original')
            self.assertEqual(response.media_type, 'image/jpeg')
            download.assert_called_once()

    def test_remote_image_download_limits_bytes_read(self):
        response = Mock()
        response.read.return_value = b'image'
        with patch.object(main, '_is_allowed_remote_image_url', return_value=True), patch.object(main, '_get_remote_image_cache', return_value=None), patch.object(main, '_set_remote_image_cache', return_value=(b'image', 'image/jpeg')), patch.object(main, 'urlopen') as download:
            download.return_value.__enter__.return_value = response
            main._fetch_remote_image_bytes('https://images.test/product.jpg')
            response.read.assert_called_once_with(12 * 1024 * 1024 + 1)

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
