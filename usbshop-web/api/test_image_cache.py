"""Thumbnail requests must not fetch originals when the rendered image is cached."""
import io
import unittest
from unittest.mock import Mock, patch

import main


class ImageCacheTests(unittest.TestCase):
    def setUp(self):
        self.url = 'https://example.supabase.co/storage/v1/object/public/catalog/photo.jpg'
        connection = Mock()
        connection.execute.return_value.fetchone.return_value = {'image_path': self.url}
        for name, value in {
            '_connect': Mock(return_value=connection),
            '_product_image_candidates': Mock(return_value=[self.url]),
            '_REMOTE_THUMBNAIL_CACHE': {},
        }.items():
            patcher = patch.object(main, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def request(self):
        return main.product_image(1, i=0, w=420, h=315, q=72, format='webp')

    def test_warm_thumbnail_does_not_need_original_or_network(self):
        key = main._remote_thumbnail_cache_key(self.url, 420, 315, 72, 'webp')
        main._set_remote_thumbnail_cache(key, b'cached-webp', 'image/webp')
        with patch.object(main, '_fetch_remote_image_bytes', side_effect=AssertionError('unnecessary download')):
            response = self.request()
        self.assertEqual(response.body, b'cached-webp')
        self.assertIn('max-age=86400', response.headers['cache-control'])

    def test_cold_thumbnail_is_rendered_once_and_reused(self):
        original = io.BytesIO()
        main.Image.new('RGB', (1000, 800), 'white').save(original, format='JPEG')
        with patch.object(main, '_fetch_remote_image_bytes', return_value=(original.getvalue(), 'image/jpeg')) as fetch:
            first = self.request()
            second = self.request()
        fetch.assert_called_once_with(self.url)
        self.assertEqual(first.body, second.body)
        self.assertEqual(first.media_type, 'image/webp')
        with main.Image.open(io.BytesIO(first.body)) as image:
            self.assertLessEqual(image.width, 420)
            self.assertLessEqual(image.height, 315)

    def test_expired_thumbnail_is_refreshed(self):
        key = main._remote_thumbnail_cache_key(self.url, 420, 315, 72, 'webp')
        main._REMOTE_THUMBNAIL_CACHE[key] = (0, b'expired', 'image/webp')
        with patch.object(main, '_fetch_remote_image_bytes', return_value=(b'original', 'image/jpeg')) as fetch, \
             patch.object(main, '_render_thumbnail_from_bytes', return_value=(b'fresh', 'image/webp')):
            self.assertEqual(self.request().body, b'fresh')
        fetch.assert_called_once()

    def test_unresized_image_still_returns_original(self):
        with patch.object(main, '_fetch_remote_image_bytes', return_value=(b'original', 'image/jpeg')):
            response = main.product_image(1, i=0, w=None, h=None, q=72, format='webp')
        self.assertEqual(response.body, b'original')
        self.assertEqual(response.media_type, 'image/jpeg')
