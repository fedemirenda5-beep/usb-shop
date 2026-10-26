'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { fetchApiResponse } from '@/lib/api';
import { usePathname } from 'next/navigation';

export type Buyer = { id: number; name: string; email: string; phone: string; status: string; customer_id: number | null };
const Context = createContext<{ buyer: Buyer | null; loading: boolean; approved: boolean }>({ buyer: null, loading: true, approved: false });

export function clearBuyerStorage(nextBuyerId?: number) {
  try {
  // Remove previous catalog snapshots and shopping data on a shared device.
  if (nextBuyerId && window.localStorage.getItem('usbshop_buyer_owner') === String(nextBuyerId)) return;
  for (const storage of [window.localStorage, window.sessionStorage]) {
    for (const key of Object.keys(storage)) {
      if (key.startsWith('usbshop') && /cache|cart|checkout|pending|order_attempt/.test(key)) storage.removeItem(key);
    }
  }
  if (nextBuyerId) window.localStorage.setItem('usbshop_buyer_owner', String(nextBuyerId));
  else window.localStorage.removeItem('usbshop_buyer_owner');
  } catch { /* Browser storage is optional; authentication uses an HttpOnly cookie. */ }
}

export function BuyerSession({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const staffPage = pathname === '/login' || pathname?.startsWith('/admin');
  const [buyer, setBuyer] = useState<Buyer | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (staffPage) { setBuyer(null); setLoading(false); return; }
    let active = true;
    const refresh = async () => {
      try {
        const response = await fetchApiResponse('/buyer/me', { cache: 'no-store' });
        if (active) setBuyer(response.ok ? await response.json() : null);
      } catch { if (active) setBuyer(null); }
      finally { if (active) setLoading(false); }
    };
    void refresh();
    const visible = () => { if (document.visibilityState === 'visible') void refresh(); };
    const timer = window.setInterval(visible, 60_000);
    window.addEventListener('focus', visible);
    window.addEventListener('pageshow', visible);
    document.addEventListener('visibilitychange', visible);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', visible);
      window.removeEventListener('pageshow', visible);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [staffPage]);
  return <Context.Provider value={{ buyer, loading, approved: buyer?.status === 'approved' && Boolean(buyer.customer_id) }}>{children}</Context.Provider>;
}

export const useBuyer = () => useContext(Context);

export function BuyerWelcome() {
  const { buyer, approved } = useBuyer();
  const pathname = usePathname();
  if (!approved || !buyer || pathname === '/login' || pathname?.startsWith('/admin')) return null;
  return <section className="buyer-welcome" role="status" aria-live="polite" aria-atomic="true">
    <strong>¡Hola, {buyer.name}! Te damos la bienvenida a USB Shop.</strong>
    <p>Ya podés ver tus precios y hacer tu pedido. ¡Gracias por elegirnos!</p>
  </section>;
}

export function BuyerNav() {
  const { buyer, loading } = useBuyer();
  const [busy, setBusy] = useState(false);
  return <div className="buyer-nav">
    <a className="button button--ghost" href="/mi-cuenta/" title={buyer?.name} aria-label={!loading && !buyer ? 'Ingresar o crear cuenta' : undefined}>{loading ? 'Mi cuenta' : buyer ? (buyer.status === 'approved' ? buyer.name : buyer.status === 'pending' ? 'Solicitud pendiente' : 'Mi cuenta') : 'Ingresar'}</a>
    {buyer && <button className="button button--ghost" disabled={busy} onClick={async () => {
      setBusy(true);
      try {
        const response = await fetchApiResponse('/buyer/logout', { method: 'POST' });
        if (!response.ok) throw new Error('logout');
        clearBuyerStorage();
        window.location.assign('/');
      } catch { setBusy(false); }
    }}>Salir</button>}
  </div>;
}
