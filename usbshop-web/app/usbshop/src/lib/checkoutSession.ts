import type { OrderPayload, OrderResponse } from './api';
import { readStoredCart, writeStoredCart } from './cart';

export const PENDING_ORDER_KEY = 'usbshop.pending-order.v1';
export const CHECKOUT_EVENT = 'usbshop:checkout';
export const CART_SYNC_EVENT = 'usbshop:cart-sync';
export type PendingOrder = { payload: OrderPayload; createdAt: number };
let memoryPending: PendingOrder | null = null;

export function readPendingOrder(): PendingOrder | null {
  try {
    const raw = localStorage.getItem(PENDING_ORDER_KEY);
    const saved = raw ? JSON.parse(raw) : null;
    if (!saved) return memoryPending = null;
    if (typeof saved.payload?.idempotency_key !== 'string' ||
        !Array.isArray(saved.payload.items) || !saved.payload.items.length) return null;
    return memoryPending = saved;
  } catch {
    return memoryPending;
  }
}

export function checkoutEvent(detail: { phase: 'sending' | 'uncertain' | 'confirmed' | 'rejected'; order?: OrderResponse; message?: string }) {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(CHECKOUT_EVENT, { detail }));
}

export function savePendingOrder(payload: OrderPayload) {
  const current = readPendingOrder();
  if (current && JSON.stringify(current.payload) !== JSON.stringify(payload)) {
    checkoutEvent({ phase: 'uncertain' });
    throw new Error('Hay un pedido sin confirmar. Verifica ese envio antes de iniciar otro.');
  }
  memoryPending = current || { payload: JSON.parse(JSON.stringify(payload)), createdAt: Date.now() };
  try {
    localStorage.setItem(PENDING_ORDER_KEY, JSON.stringify(memoryPending));
  } catch {
    // Private browsing retains the pending request for the lifetime of this page.
  }
  checkoutEvent({ phase: 'sending' });
}

export function clearPendingOrder() {
  memoryPending = null;
  try { localStorage.removeItem(PENDING_ORDER_KEY); } catch { /* memory fallback */ }
}

export function confirmPendingOrder(order: OrderResponse) {
  const pending = readPendingOrder();
  if (pending) {
    const purchased = new Map<number, number>();
    pending.payload.items.forEach(item => purchased.set(item.product_id, (purchased.get(item.product_id) || 0) + item.quantity));
    // Remove only the purchased quantities. Another tab may have added new items.
    writeStoredCart(readStoredCart().items.map(item => ({
      ...item, qty: Math.max(0, item.qty - (purchased.get(item.product.id) || 0)),
    })).filter(item => item.qty > 0));
    clearPendingOrder();
    window.dispatchEvent(new Event(CART_SYNC_EVENT));
  }
  checkoutEvent({ phase: 'confirmed', order });
}
