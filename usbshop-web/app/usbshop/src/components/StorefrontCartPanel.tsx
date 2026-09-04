"use client";

import Link from "next/link";

type CartProduct = {
  id: number;
  name: string;
  price: number;
};

type CartItem = {
  product: CartProduct;
  qty: number;
};

type StorefrontCartPanelProps = {
  cartItems: CartItem[];
  totalItems: number;
  total: number;
  remainingForFreeShipping: number;
  orderName: string;
  orderPhone: string;
  orderEmail: string;
  orderNotes: string;
  orderStatus: "idle" | "submitting" | "success" | "error";
  orderMessage: string | null;
  stockNotice: string | null;
  cartNotice: string | null;
  onOrderNameChange: (value: string) => void;
  onOrderPhoneChange: (value: string) => void;
  onOrderEmailChange: (value: string) => void;
  onOrderNotesChange: (value: string) => void;
  onUpdateQty: (id: number, delta: number) => void;
  onRemoveItem: (id: number) => void;
  onCheckout: () => void;
};

export default function StorefrontCartPanel({
  cartItems,
  totalItems,
  total,
  remainingForFreeShipping,
  orderName,
  orderPhone,
  orderEmail,
  orderNotes,
  orderStatus,
  orderMessage,
  stockNotice,
  cartNotice,
  onOrderNameChange,
  onOrderPhoneChange,
  onOrderEmailChange,
  onOrderNotesChange,
  onUpdateQty,
  onRemoveItem,
  onCheckout,
}: StorefrontCartPanelProps) {
  return (
    <>
      <div className="cart-header">
        <span>Tu pedido</span>
        <span className="cart-count">{totalItems}</span>
      </div>

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
            Todavia no agregaste productos. Elegi un destacado para empezar.
          </div>
        </div>
      ) : (
        <div className="cart-summary">
          <div className="empty-title">Revisa tu pedido</div>
          <div className="empty-text">
            Ajusta cantidades y completa tus datos para enviarlo sin vueltas.
          </div>
        </div>
      )}

      {orderMessage ? (
        <div
          className={`cart-notice ${
            orderStatus === "error" ? "cart-notice--error" : "cart-notice--success"
          }`}
        >
          {orderMessage}
        </div>
      ) : null}

      {cartItems.length > 0 ? (
        <>
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

          {stockNotice ? <div className="cart-notice">{stockNotice}</div> : null}
          {cartNotice ? (
            <div className="cart-notice cart-notice--success">{cartNotice}</div>
          ) : null}

          <div className="cart-form">
            <input
              type="text"
              placeholder="Nombre y apellido"
              value={orderName}
              onChange={(event) => onOrderNameChange(event.target.value)}
            />
            <input
              type="tel"
              placeholder="Telefono"
              value={orderPhone}
              onChange={(event) => onOrderPhoneChange(event.target.value)}
            />
            <input
              type="email"
              placeholder="Email (opcional)"
              value={orderEmail}
              onChange={(event) => onOrderEmailChange(event.target.value)}
            />
            <textarea
              placeholder="Notas (opcional)"
              value={orderNotes}
              onChange={(event) => onOrderNotesChange(event.target.value)}
              rows={2}
            />
          </div>

          <div className="cart-total">
            <span>Total</span>
            <span>${total.toLocaleString("es-AR")}</span>
          </div>
          <div className="cart-shipping-hint">
            {remainingForFreeShipping === 0
              ? "Envio gratis desbloqueado."
              : `Te faltan $${remainingForFreeShipping.toLocaleString(
                  "es-AR"
                )} para envio gratis.`}
          </div>
          <button
            className="button button--lime"
            onClick={onCheckout}
            disabled={orderStatus === "submitting"}
          >
            {orderStatus === "submitting" ? "Enviando..." : "Confirmar pedido"}
          </button>
          <Link className="button button--ghost" href="/carrito/">
            Abrir carrito completo
          </Link>
        </>
      ) : null}
    </>
  );
}
