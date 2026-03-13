"use client";

import { useEffect, useRef } from "react";

type CartDrawerProps = {
  open: boolean;
  title?: string;
  label?: string;
  onClose: () => void;
  children: React.ReactNode;
};

export default function CartDrawer({
  open,
  title = "Carrito",
  label = "Carrito",
  onClose,
  children,
}: CartDrawerProps) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    window.setTimeout(() => closeButtonRef.current?.focus(), 0);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  return (
    <div
      className="cart-drawer-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="cart-drawer" role="dialog" aria-modal="true" aria-label={label}>
        <div className="cart-drawer__header">
          <span className="cart-drawer__title">{title}</span>
          <button
            ref={closeButtonRef}
            type="button"
            className="button button--ghost button--icon"
            onClick={onClose}
            aria-label="Cerrar"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

