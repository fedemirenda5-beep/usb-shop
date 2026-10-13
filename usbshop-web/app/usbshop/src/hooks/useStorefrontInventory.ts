'use client';

import { useEffect, useRef } from 'react';
import { fetchJson } from '@/lib/api';

type Inventory = { id: number; stock: number; soldCount?: number };
export type InventoryMap = Map<number, Inventory>;

export function refreshInventory<T extends Inventory>(product: T, inventory: InventoryMap): T {
  const current = inventory.get(product.id);
  return current ? { ...product, stock: current.stock, soldCount: current.soldCount } : product;
}

export function useStorefrontInventory(
  products: Inventory[],
  onRefresh: (inventory: InventoryMap) => void,
  onError: () => void,
) {
  const latest = useRef({ products, onRefresh, onError });
  latest.current = { products, onRefresh, onError };

  useEffect(() => {
    let active = true;
    let request: AbortController | null = null;
    let lastAttempt = 0;
    const refresh = async () => {
      if (!active || request || document.visibilityState !== 'visible' || !navigator.onLine) return;
      // Focus and visibilitychange can arrive together. Only send one request.
      if (Date.now() - lastAttempt < 10_000) return;
      const ids = [...new Set(latest.current.products.map(product => product.id))];
      if (!ids.length) return;
      lastAttempt = Date.now();
      request = new AbortController();
      try {
        const inventory: InventoryMap = new Map();
        // The API caps each response at 100 products.
        for (let offset = 0; offset < ids.length; offset += 100) {
          const batch = ids.slice(offset, offset + 100);
          const params = new URLSearchParams({ ids: batch.join(','), limit: String(batch.length) });
          const rows = await fetchJson<Inventory[]>(`/products?${params}`, {
            cache: 'no-store', signal: request.signal,
          }, { attempts: 1 });
          rows.forEach(product => inventory.set(product.id, product));
        }
        if (active) latest.current.onRefresh(inventory);
      } catch {
        if (active) latest.current.onError();
      } finally {
        request = null;
      }
    };
    const trigger = () => { void refresh(); };
    window.addEventListener('focus', trigger);
    window.addEventListener('online', trigger);
    document.addEventListener('visibilitychange', trigger);
    const interval = window.setInterval(trigger, 60_000);
    return () => {
      active = false;
      request?.abort();
      window.clearInterval(interval);
      window.removeEventListener('focus', trigger);
      window.removeEventListener('online', trigger);
      document.removeEventListener('visibilitychange', trigger);
    };
  }, []);
}
