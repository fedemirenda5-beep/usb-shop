import unittest

from product_search import rank_products, one_edit


def product(product_id, name, *, sku='', stock=5, category='Juguetes', description='', barcode=''):
    return dict(id=product_id, name=name, sku=sku, stock=stock, category=category,
                search_category=category, description=description, barcode=barcode)


class ProductSearchTests(unittest.TestCase):
    def setUp(self):
        self.rows = [
            product(1, 'Soporte para auto', stock=0, category='Accesorios'),
            product(2, 'Auto acrobático 4x4 con control', sku='828A'),
            product(3, 'Vehículo a control', sku='CX-81', description='Auto acrobático'),
            product(4, 'Auto acrobático 4x4 con control', sku='OLD', stock=0),
        ]

    def ids(self, query, rows=None, admin=False):
        rows, approximate = rank_products(query, self.rows if rows is None else rows, admin=admin)
        return [row['id'] for row in rows], approximate

    def test_title_matches_rank_above_description_and_support_accessory(self):
        self.assertEqual(self.ids('auto')[0], [2, 4, 1, 3])

    def test_accents_case_word_order_and_connecting_words(self):
        for query in ['AUTO ACROBATICO', 'acrobatico auto', 'auto con acrobatico', 'auto,acrobático']:
            with self.subTest(query=query):
                self.assertEqual(self.ids(query), ([2, 4, 3], False))

    def test_partial_title_and_exact_code_with_separators(self):
        self.assertEqual(self.ids('acro')[0], [2, 4, 3])
        for query in ['cx81', 'CX-81', 'cx 81']:
            self.assertEqual(self.ids(query), ([3], False))

    def test_code_beats_title(self):
        rows = [product(10, 'CX81 juguete'), product(11, 'Vehículo', sku='CX-81', stock=0)]
        self.assertEqual(self.ids('cx81', rows)[0], [11, 10])

    def test_title_prefix_beats_an_alphabetically_earlier_accessory(self):
        rows = [product(10, 'Adaptador para auto'), product(11, 'Auto acrobático')]
        self.assertEqual(self.ids('auto', rows)[0], [11, 10])

    def test_available_stock_breaks_relevance_ties(self):
        self.assertEqual(self.ids('auto acrobatico')[0][:2], [2, 4])

    def test_one_typo_or_transposition_suggests_names(self):
        for query in ['auto acrobatcio', 'auto acrobtico', 'auto acrobattico', 'auto acrobstico']:
            ids, approximate = self.ids(query)
            self.assertIn(2, ids)
        self.assertEqual(self.ids('auto acrobatcio'), ([2, 4], True))
        self.assertEqual(self.ids('auto acrobattico'), ([2, 4], True))

    def test_exact_matches_exclude_typo_suggestions(self):
        rows = [product(10, 'Parlante'), product(11, 'Parlantes')]
        self.assertEqual(self.ids('parlantes', rows), ([11], False))

    def test_numbers_and_codes_are_never_fuzzy_corrected(self):
        rows = [product(10, 'iPhone 15', sku='ZX-81', barcode='123456789')]
        for query in ['iphone 16', 'ZX82', '123456788', '11']:
            self.assertEqual(self.ids(query, rows, admin=True), ([], False))
        self.assertEqual(self.ids('123456789', rows, admin=True), ([10], False))
        self.assertEqual(self.ids('10', rows, admin=True), ([10], False))

    def test_every_meaningful_word_must_match(self):
        self.assertEqual(self.ids('auto submarino'), ([], False))
        self.assertEqual(self.ids('zzzzzzzz'), ([], False))
        self.assertEqual(self.ids('---'), ([], False))

    def test_same_ranking_on_both_surfaces(self):
        for query in ['auto', 'auto acrobatcio', 'juguetes', '828A']:
            self.assertEqual(self.ids(query), self.ids(query, admin=True))

    def test_one_edit_rejects_two_errors(self):
        for left, right in [('auto', 'auot'), ('auto', 'autos'), ('auto', 'ato'), ('auto', 'audo')]:
            self.assertTrue(one_edit(left, right))
        self.assertFalse(one_edit('auto', 'otro'))


if __name__ == '__main__':
    unittest.main()
