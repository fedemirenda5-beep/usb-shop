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
  onContinueShopping: () => void;
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
  onContinueShopping,
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
            <div className="cart-form-hint">Solo te pedimos estos datos para confirmar tu pedido.</div>

            <div className="cart-field">
              <label htmlFor="storefront-order-name">Nombre y apellido <span>*</span></label>
              <input
                id="storefront-order-name"
                type="text"
                placeholder="Ingresá tu nombre completo"
                value={orderName}
                onChange={(event) => onOrderNameChange(event.target.value)}
                required
              />
            </div>

            <div className="cart-field">
              <label htmlFor="storefront-order-phone">Telefono <span>*</span></label>
              <input
                id="storefront-order-phone"
                type="tel"
                placeholder="Tu numero para coordinar envio"
                value={orderPhone}
                onChange={(event) => onOrderPhoneChange(event.target.value)}
                required
              />
            </div>

            <div className="cart-field">
              <label htmlFor="storefront-order-email">Email</label>
              <input
                id="storefront-order-email"
                type="email"
                placeholder="mail@ejemplo.com (opcional)"
                value={orderEmail}
                onChange={(event) => onOrderEmailChange(event.target.value)}
              />
            </div>

            <div className="cart-field">
              <label htmlFor="storefront-order-notes">Notas (opcional)</label>
              <textarea
                id="storefront-order-notes"
                placeholder="Indicá horario, dirección, o cualquier detalle importante"
                value={orderNotes}
                onChange={(event) => onOrderNotesChange(event.target.value)}
                rows={2}
              />
            </div>
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
          <div className="cart-panel-footer">
            <button
              type="button"
              className="button button--ghost"
              onClick={onContinueShopping}
            >
              Seguir comprando
            </button>
            <button
              className="button button--lime"
              onClick={onCheckout}
              disabled={orderStatus === "submitting"}
            >
              {orderStatus === "submitting" ? "Enviando..." : "Confirmar pedido"}
            </button>
          </div>
          <Link className="button button--ghost" href="/carrito/">
            Abrir carrito completo
          </Link>
        </>
      ) : null}
    </>
  );
}
