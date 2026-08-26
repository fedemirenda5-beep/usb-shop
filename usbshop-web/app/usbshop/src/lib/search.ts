export const normalizeSearchText = (value: string | null | undefined) =>
  (value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

export const searchTokensFromQuery = (value: string | null | undefined) =>
  normalizeSearchText(value)
    .split(/[\s,;|/\\-]+/)
    .filter(Boolean);

export const buildSearchHaystack = (...values: Array<string | number | null | undefined>) =>
  values
    .map((value) => normalizeSearchText(value == null ? "" : String(value)))
    .filter(Boolean)
    .join(" ");

export const matchesSearchQuery = (
  query: string | null | undefined,
  ...values: Array<string | number | null | undefined>
) => {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) {
    return true;
  }
  const haystack = buildSearchHaystack(...values);
  if (!haystack) {
    return false;
  }
  const tokens = searchTokensFromQuery(normalizedQuery);
  const effectiveTokens = tokens.length > 0 ? tokens : [normalizedQuery];
  return effectiveTokens.every((token) => haystack.includes(token));
};
