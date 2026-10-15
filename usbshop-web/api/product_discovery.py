def discovery_order(seed: int) -> tuple[str, list[int]]:
    """Stable, category-balanced ordering for a visit, on SQLite and PostgreSQL."""
    multiplier = 1000003 + abs(seed) % 1000000000
    return (
        "CASE WHEN p.stock > 0 OR p.is_bundle = 1 THEN 0 ELSE 1 END, "
        "ROW_NUMBER() OVER (PARTITION BY p.category_id ORDER BY "
        "CASE WHEN p.stock > 0 OR p.is_bundle = 1 THEN 0 ELSE 1 END, "
        "MOD(CAST(p.id AS BIGINT) * ?, 2147483647), p.id), "
        "MOD(CAST(COALESCE(p.category_id, 0) AS BIGINT) * ?, 2147483647), p.id",
        [multiplier, multiplier],
    )
