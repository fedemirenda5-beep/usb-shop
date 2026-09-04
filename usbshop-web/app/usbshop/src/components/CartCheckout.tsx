"use client";

import { useMemo, useState } from "react";
import { getApiBaseUrl, getOrderSecret } from "@/lib/api";
import type { CartItem } from "@/lib/cart";
import { buildWhatsAppLink } from "@/lib/whatsapp";

type CartCheckoutProps = {
  apiBaseUrl?: string;
  cartItems: CartItem[];
  totalItems: number;
  total: number;
  freeShippingThreshold?: number;
  stockNotice: string | null;
  cartNotice: string | null;
  onUpdateQty: (id: number, delta: number) => void;
  onRemoveItem: (id: number) => void;
  onClearCart: () => void;
  onAfterOrder?: () => Promise<void> | void;
};

export default function CartCheckout({
  apiBaseUrl,
  cartItems,
  totalItems,
  total,
  freeShippingThreshold = 250000,
  stockNotice,
  cartNotice,
  onUpdateQty,
  onRemoveItem,
  onClearCart,
  onAfterOrder,
}: CartCheckoutProps) {
  const [orderName, setOrderName] = useState("");
  const [orderPhone, setOrderPhone] = useState("");
  const [orderEmail, setOrderEmail] = useState("");
  const [orderNotes, setOrderNotes] = useState("");
  const [orderStatus, setOrderStatus] = useState<
    "idle" | "submitting" | "success" | "error"
  >("idle");
  const [orderMessage, setOrderMessage] = useState<string | null>(null);

  const remainingForFreeShipping = useMemo(() => {
    return Math.max(0, freeShippingThreshold - total);
  }, [freeShippingThreshold, total]);

  const handleCheckout = async () => {
    if (cartItems.length === 0) {
      setOrderStatus("error");
      setOrderMessage("Agrega productos antes de iniciar el pedido.");
      return;
    }
    if (!orderName.trim() || !orderPhone.trim()) {
      setOrderStatus("error");
      setOrderMessage("Completa nombre y teléfono para continuar.");
      return;
    }
    if (orderEmail.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(orderEmail.trim())) {
      setOrderStatus("error");
      setOrderMessage("Completa un email válido para continuar.");
      return;
    }
    setOrderStatus("submitting");
    setOrderMessage(null);
    try {
      const baseUrl = (apiBaseUrl || "").trim() || getApiBaseUrl();
      const payload = {
        items: cartItems.map((item) => ({
          product_id: item.product.id,
          quantity: item.qty,
          unit_price: item.product.price,
        })),
        customer_name: orderName.trim(),
        customer_phone: orderPhone.trim(),
        customer_email: orderEmail.trim() || null,
        notes: orderNotes.trim() || null,
      };
      const orderSecret = getOrderSecret();
      const response = await fetch(`${baseUrl}/orders`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...(orderSecret ? { "X-USB-ORDER-SECRET": orderSecret } : {}),
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => null);
        const message =
          detail?.detail ||
          (response.status === 503
            ? "Sistema en mantenimiento. Intenta más tarde."
            : "No se pudo generar el pedido. Intenta nuevamente.");
        setOrderStatus("error");
        setOrderMessage(message);
        return;
      }
      const data = (await response.json()) as { id: number; total: number };
      onClearCart();
      setOrderName("");
      setOrderPhone("");
      setOrderEmail("");
      setOrderNotes("");
      setOrderStatus("success");
      setOrderMessage(`Pedido #${data.id} guardado como pendiente.`);
      try {
        await onAfterOrder?.();
      } catch {
        // ignore refresh errors
      }
    } catch {
      setOrderStatus("error");
      setOrderMessage("No se pudo generar el pedido. Intenta nuevamente.");
    }
  };

  return (
    <>
      {cartItems.length === 0 ? (
        <div className="empty-state">
          <div className="empty-illustration" aria-hidden="true">
            <svg viewBox="0 0 120 90" role="presentation">
              <path
                d="M12 14h12l8 44h56l10-30H40"
                fill="none"
                stroke="currentColor"
                strokeWidth="6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <circle cx="44" cy="76" r="6" fill="currentColor" />
              <circle cx="78" cy="76" r="6" fill="currentColor" />
              <path
                d="M48 22h42"
                fill="none"
                stroke="currentColor"
                strokeWidth="6"
                strokeLinecap="round"
              />
              <path
                d="M32 14l-6-8"
                fill="none"
                stroke="currentColor"
                strokeWidth="6"
                strokeLinecap="round"
              />
            </svg>
          </div>
          <div className="empty-title">Carrito listo para empezar</div>
          <div className="empty-text">
            Todavía no agregaste productos. Elegí un destacado para empezar.
          </div>
        </div>
      ) : (
        <div className="cart-list">
          {cartItems.map((item) => (
            <div key={item.product.id} className="cart-item">
              <div className="cart-row">
                <span>{item.product.name}</span>
                <strong>${item.product.price.toLocaleString("es-AR")}</strong>
              </div>
              <div className="cart-row">
                <span>Cantidad: {item.qty}</span>
                <div className="cart-actions">
                  <button type="button" onClick={() => onUpdateQty(item.product.id, -1)}>
                    -
                  </button>
                  <button type="button" onClick={() => onUpdateQty(item.product.id, 1)}>
                    +
                  </button>
                  <button type="button" onClick={() => onRemoveItem(item.product.id)}>
                    Quitar
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {stockNotice ? (
        <div className="cart-notice" role="status">
          {stockNotice}
        </div>
      ) : null}
      {cartNotice ? (
        <div className="cart-notice cart-notice--success" role="status">
          {cartNotice}
        </div>
      ) : null}

      <form
        className="cart-form"
        onSubmit={(event) => {
          event.preventDefault();
          void handleCheckout();
        }}
      >
        <label className="sr-only" htmlFor="usbshop-order-name">
          Nombre y apellido
        </label>
        <input
          id="usbshop-order-name"
          type="text"
          autoComplete="name"
          placeholder="Nombre y apellido"
          value={orderName}
          onChange={(event) => setOrderName(event.target.value)}
        />
        <label className="sr-only" htmlFor="usbshop-order-phone">
          Teléfono
        </label>
        <input
          id="usbshop-order-phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder="Teléfono"
          value={orderPhone}
          onChange={(event) => setOrderPhone(event.target.value)}
        />
        <label className="sr-only" htmlFor="usbshop-order-email">
          Email
        </label>
        <input
          id="usbshop-order-email"
          type="email"
          autoComplete="email"
          placeholder="Email (opcional)"
          value={orderEmail}
          onChange={(event) => setOrderEmail(event.target.value)}
        />
        <label className="sr-only" htmlFor="usbshop-order-notes">
          Notas (opcional)
        </label>
        <textarea
          id="usbshop-order-notes"
          placeholder="Notas (opcional)"
          value={orderNotes}
          onChange={(event) => setOrderNotes(event.target.value)}
          rows={2}
        />

        {orderMessage ? (
          <div
            className={`cart-notice ${
              orderStatus === "error" ? "cart-notice--error" : "cart-notice--success"
            }`}
            role={orderStatus === "error" ? "alert" : "status"}
          >
            {orderMessage}
          </div>
        ) : null}

        <div className="cart-total">
          <span>Total</span>
          <span>${total.toLocaleString("es-AR")}</span>
        </div>
        <div className="cart-shipping-hint">
          {totalItems === 0 ? (
            "Agregá productos para ver el total."
          ) : remainingForFreeShipping === 0 ? (
            "Envío gratis desbloqueado."
          ) : (
            `Te faltan $${remainingForFreeShipping.toLocaleString("es-AR")} para envío gratis.`
          )}
        </div>
        <button
          className="button button--lime"
          type="submit"
          disabled={orderStatus === "submitting" || cartItems.length === 0}
        >
          {orderStatus === "submitting"
            ? "Enviando..."
            : cartItems.length === 0
              ? "Agregá productos para continuar"
              : "Confirmar pedido"}
        </button>
        <button
          className="button button--whatsapp"
          type="button"
          disabled={cartItems.length === 0}
          onClick={() => {
            const name = orderName.trim();
            const phone = orderPhone.trim();
            const email = orderEmail.trim();
            const notes = orderNotes.trim();

            const lines: string[] = [
              "Hola! Quiero hacer un pedido desde la web.",
              "",
              ...(name ? [`Nombre: ${name}`] : []),
              ...(phone ? [`Teléfono: ${phone}`] : []),
              ...(email ? [`Email: ${email}`] : []),
              ...(notes ? [`Notas: ${notes}`] : []),
              "",
              "Productos:",
              ...cartItems.map((item) => `- ${item.qty}x ${item.product.name} (ID ${item.product.id})`),
              "",
              `Total aprox.: $${total.toLocaleString("es-AR")}`,
              "",
              "¿Me confirmas stock y envío? Gracias.",
            ];
            const href = buildWhatsAppLink(lines.join("\n"));
            window.open(href, "_blank", "noopener,noreferrer");
          }}
        >
          Enviar por WhatsApp
        </button>
      </form>
    </>
  );
}
