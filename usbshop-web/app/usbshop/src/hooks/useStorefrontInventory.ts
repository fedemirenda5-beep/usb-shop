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
      if (request && Date.now() - lastAttempt >= 18_000) {
        request.abort();
        request = null;
        lastAttempt = 0;
      }
      if (!active || request || document.visibilityState !== 'visible' || !navigator.onLine) return;
      // Focus and visibilitychange can arrive together. Only send one request.
      if (Date.now() - lastAttempt < 10_000) return;
      const ids = [...new Set(latest.current.products.map(product => product.id))];
      if (!ids.length) return;
      lastAttempt = Date.now();
      const controller = new AbortController();
      request = controller;
      try {
        const inventory: InventoryMap = new Map();
        // The API caps each response at 100 products.
        for (let offset = 0; offset < ids.length; offset += 100) {
          const batch = ids.slice(offset, offset + 100);
          const params = new URLSearchParams({ ids: batch.join(','), limit: String(batch.length) });
          const rows = await fetchJson<Inventory[]>(`/products?${params}`, {
            cache: 'no-store', signal: controller.signal,
          }, { attempts: 1 });
          if (controller.signal.aborted) return;
          rows.forEach(product => inventory.set(product.id, product));
        }
        if (active && !controller.signal.aborted) latest.current.onRefresh(inventory);
      } catch {
        if (active && !controller.signal.aborted) latest.current.onError();
      } finally {
        if (request === controller) request = null;
      }
    };
    const trigger = () => { void refresh(); };
    const suspend = () => {
      request?.abort();
      request = null;
      lastAttempt = 0;
    };
    const visibility = () => {
      if (document.visibilityState === 'hidden') suspend();
      else trigger();
    };
    const reconnect = () => { suspend(); trigger(); };
    const pageshow = (event: PageTransitionEvent) => { if (event.persisted) reconnect(); };
    window.addEventListener('focus', trigger);
    window.addEventListener('online', reconnect);
    window.addEventListener('offline', suspend);
    window.addEventListener('pageshow', pageshow);
    document.addEventListener('visibilitychange', visibility);
    const interval = window.setInterval(trigger, 60_000);
    return () => {
      active = false;
      request?.abort();
      window.clearInterval(interval);
      window.removeEventListener('focus', trigger);
      window.removeEventListener('online', reconnect);
      window.removeEventListener('offline', suspend);
      window.removeEventListener('pageshow', pageshow);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);
}
