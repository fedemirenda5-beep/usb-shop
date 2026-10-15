'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { fetchJson, getApiBaseUrl, loadRuntimeConfig } from '@/lib/api';
import { refreshInventory, useStorefrontInventory } from '@/hooks/useStorefrontInventory';

type DiscoveryItem = { id: number; stock: number };
const BATCH_SIZE = 100;
const VISIBLE_COUNT = 8;

export default function ProductDiscovery<T extends DiscoveryItem>({
  excludedIds, ready, normalize, renderProduct,
}: {
  excludedIds: number[];
  ready: boolean;
  normalize: (item: T, baseUrl: string) => T;
  renderProduct: (product: T, index: number) => ReactNode;
}) {
  const [products, setProducts] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const latest = useRef({ excludedIds, normalize });
  latest.current = { excludedIds, normalize };
  const state = useRef({ seed: 0, offset: 0, queue: [] as T[], more: true, seen: new Set<number>() });
  const request = useRef<AbortController | null>(null);
  const loaded = useRef(false);

  const showOthers = async () => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError(false);
    // Commit the cursor only after success so Retry cannot skip products.
    const next = { ...state.current, queue: [...state.current.queue], seen: new Set(state.current.seen) };
    if (!next.seed) next.seed = window.crypto.getRandomValues(new Uint32Array(1))[0];
    const excluded = new Set(latest.current.excludedIds);
    const selected: T[] = [];
    try {
      await loadRuntimeConfig();
      while (selected.length < VISIBLE_COUNT) {
        if (!next.queue.length) {
          if (!next.more) break;
          const params = new URLSearchParams({ sort: 'discover', seed: String(next.seed), limit: String(BATCH_SIZE), offset: String(next.offset) });
          const rows = await fetchJson<T[]>(`/products?${params}`, { signal: controller.signal, cache: 'no-store' });
          if (controller.signal.aborted) return;
          next.offset += rows.length;
          next.more = rows.length === BATCH_SIZE;
          next.queue = rows.map(item => latest.current.normalize(item, getApiBaseUrl()));
          if (!next.queue.length) break;
        }
        const item = next.queue.shift()!;
        if (item.stock <= 0 || excluded.has(item.id) || next.seen.has(item.id)) continue;
        selected.push(item);
        next.seen.add(item.id);
      }
      if (controller.signal.aborted) return;
      state.current = next;
      loaded.current = true;
      setHasMore(next.more || next.queue.some(item => item.stock > 0 && !excluded.has(item.id) && !next.seen.has(item.id)));
      if (selected.length) setProducts(selected);
    } catch {
      if (!controller.signal.aborted) setError(true);
    } finally {
      if (request.current === controller) {
        request.current = null;
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    if (ready && !loaded.current) void showOthers();
    return () => { request.current?.abort(); request.current = null; };
  }, [ready]);

  useStorefrontInventory(products, inventory => {
    setProducts(items => items.map(item => refreshInventory(item, inventory)));
  }, () => setError(true));

  return (
    <section id="descubri-productos" className="section">
      <div className="section-header">
        <div>
          <p className="section-kicker">Más variedad para tu negocio</p>
          <h2 className="section-title">Descubrí más productos</h2>
          <p>Explorá distintos rubros y sumá nuevas opciones a tu pedido.</p>
        </div>
        <button type="button" className="button button--ghost" onClick={() => void showOthers()} disabled={loading || !ready || (!hasMore && !error)}>
          {loading ? 'Buscando productos…' : error ? 'Reintentar' : 'Ver otros'}
        </button>
      </div>
      {error ? <p role="alert">No pudimos actualizar los productos. Volvé a intentar.</p> : null}
      <div className="product-grid stagger" aria-busy={loading || !ready}>
        {products.filter(item => item.stock > 0 && !excludedIds.includes(item.id)).map((product, index) => (
          <div key={product.id}>{renderProduct(product, index)}</div>
        ))}
        {!products.length && (loading || !ready) ? Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="product-card product-skeleton" />
        )) : null}
      </div>
      {!hasMore && !error ? <p role="status">Ya recorriste esta selección. Seguí explorando en el catálogo completo.</p> : null}
    </section>
  );
}
