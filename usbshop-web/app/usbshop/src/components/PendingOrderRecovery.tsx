"use client";

import { useEffect, useState } from 'react';
import { submitOrder } from '@/lib/api';
import { CHECKOUT_EVENT, readPendingOrder } from '@/lib/checkoutSession';
import { clearOrderAttemptKey } from '@/lib/orderAttempt';

export default function PendingOrderRecovery() {
  const [pending, setPending] = useState(false);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    const refresh = () => setPending(Boolean(readPendingOrder()));
    const onCheckout = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      setSending(detail.phase === 'sending');
      if (detail.phase === 'confirmed') setMessage(`Pedido #${detail.order.id} confirmado.`);
      else setMessage('');
      refresh();
    };
    refresh();
    window.addEventListener(CHECKOUT_EVENT, onCheckout);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(CHECKOUT_EVENT, onCheckout);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  const recover = async () => {
    const saved = readPendingOrder();
    if (!saved || sending) return;
    setSending(true);
    try {
      await submitOrder(saved.payload);
      clearOrderAttemptKey();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'No se pudo verificar el pedido.');
    } finally {
      setSending(false);
      setPending(Boolean(readPendingOrder()));
    }
  };

  if (!pending && !message) return null;
  return <div className="cart-notice" role="status">
    {pending && <>
      <p>Hay un envio sin confirmar. Verifica el pedido original antes de enviar otro, aunque haya cambiado el carrito.</p>
      <button className="button button--lime" type="button" disabled={sending} onClick={recover}>
        {sending ? 'Verificando pedido...' : 'Verificar envio pendiente'}
      </button>
    </>}
    {message && <p>{message}</p>}
  </div>;
}
