import { useEffect } from 'react';
import { CART_STORAGE_KEY, readStoredCart, type CartItem } from './cart';
import { CART_SYNC_EVENT } from './checkoutSession';

export function useCartStorageSync(setCart: React.Dispatch<React.SetStateAction<Record<number, CartItem>>>) {
  useEffect(() => {
    const sync = () => {
      const stored = readStoredCart().items;
      setCart(prev => {
        if (Object.keys(prev).length === stored.length && stored.every(item => prev[item.product.id]?.qty === item.qty)) return prev;
        return Object.fromEntries(stored.map(item => [item.product.id, {
          product: prev[item.product.id]?.product || { ...item.product, stock: 9999 }, qty: item.qty,
        }]));
      });
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === CART_STORAGE_KEY || event.key === null) sync();
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener(CART_SYNC_EVENT, sync);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(CART_SYNC_EVENT, sync);
    };
  }, [setCart]);
}
