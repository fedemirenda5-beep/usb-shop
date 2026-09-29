"""Shared product ranking for the storefront and back office.

Exact results always win. One-edit spelling suggestions are a fallback for words,
never for model numbers, SKUs or barcodes. Ranking happens before pagination.
"""
import re
import unicodedata
from functools import lru_cache


@lru_cache(maxsize=32768)
def normalize(value):
    value = unicodedata.normalize('NFD', str(value or '').casefold())
    return ''.join(c for c in value if unicodedata.category(c) != 'Mn').strip()


@lru_cache(maxsize=32768)
def words(value):
    return tuple(re.findall(r'[^\W_]+', normalize(value)))


@lru_cache(maxsize=32768)
def compact(value):
    return ''.join(words(value))


@lru_cache(maxsize=256)
def query_parts(query):
    tokens = words(query)
    meaningful = [t for t in tokens if t not in {'de', 'del', 'la', 'el', 'los', 'las', 'para', 'con', 'y', 'en', 'un', 'una'}]
    return tuple(dict.fromkeys(meaningful or tokens)), ' '.join(tokens), compact(query)


@lru_cache(maxsize=4096)
def one_edit(left, right):
    """Insertion, deletion, replacement or adjacent transposition in linear time."""
    if abs(len(left) - len(right)) > 1:
        return False
    if len(left) == len(right):
        differences = [i for i, (a, b) in enumerate(zip(left, right)) if a != b]
        return len(differences) <= 1 or (
            len(differences) == 2 and differences[1] == differences[0] + 1
            and left[differences[0]] == right[differences[1]]
            and left[differences[1]] == right[differences[0]]
        )
    short, long = (left, right) if len(left) < len(right) else (right, left)
    for index, char in enumerate(short):
        if char != long[index]:
            return short[index:] == long[index + 1:]
    return True


def score_product(query, row, *, admin=False, fuzzy=False):
    tokens, phrase, code = query_parts(query)
    if not tokens:
        return 0
    identifiers = [row['sku']]
    if admin:
        identifiers += [row['barcode'], str(row['id'])]
    if code and any(code == compact(value) for value in identifiers if value):
        return 10000
    title = words(row['name'])
    category = words(row['search_category'] if admin else row['category'])
    description = words(row['description'])
    identifier_words = [word for value in identifiers for word in words(value)]
    total = 0
    title_only = True
    for token in tokens:
        if token in title:
            points = 100
        elif not token.isdigit() and any(word.startswith(token) for word in title):
            points = 75
        elif len(token) >= 3 and not token.isdigit() and any(token in word for word in title):
            points = 45
        else:
            title_only = False
            if token in identifier_words:
                points = 65
            elif any(word.startswith(token) for word in identifier_words):
                points = 40
            elif any(word == token or (not token.isdigit() and word.startswith(token)) for word in category):
                points = 30
            elif any(word == token or (not token.isdigit() and word.startswith(token)) for word in description):
                points = 10
            elif fuzzy and len(token) >= 5 and token.isalpha() and any(
                word.isalpha() and one_edit(token, word) for word in title + category
            ):
                points = 5
            else:
                return 0
        total += points
    title_phrase = ' '.join(title)
    # The average prevents queries with many terms from overtaking exact codes.
    phrase_bonus = (600 if phrase == title_phrase else 450 if title_phrase.startswith(phrase) else 300 if phrase in title_phrase else 0)
    return (2000 if title_only else 0) + phrase_bonus + total / len(tokens)


def rank_products(query, rows, *, admin=False):
    scored = [(score_product(query, row, admin=admin), row) for row in rows]
    scored = [(score, row) for score, row in scored if score > 0]
    approximate = False
    if not scored and any(len(t) >= 5 and t.isalpha() for t in query_parts(query)[0]):
        scored = [(score_product(query, row, admin=admin, fuzzy=True), row) for row in rows]
        scored = [(score, row) for score, row in scored if score > 0]
        approximate = bool(scored)
    scored.sort(key=lambda item: (
        -item[0], int(item[1]['stock'] or 0) <= 0,
        normalize(item[1]['name']), int(item[1]['id']),
    ))
    return [row for _, row in scored], approximate
