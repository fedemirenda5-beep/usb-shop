type SectionProduct = { id: number; stock: number };

// The first section claiming a product keeps it. The complete catalog remains
// independent so customers can always find every product in its category.
export function uniqueStorefrontSections<T extends SectionProduct>(
  sections: Array<{ key: string; products: T[]; limit: number }>,
): Record<string, T[]> {
  const seen = new Set<number>();
  const result: Record<string, T[]> = {};
  for (const section of sections) {
    const selected: T[] = [];
    for (const product of section.products) {
      if (selected.length >= section.limit) break;
      if (product.stock <= 0 || seen.has(product.id)) continue;
      selected.push(product);
      seen.add(product.id);
    }
    result[section.key] = selected;
  }
  return result;
}
