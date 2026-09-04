"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import CartCheckout from "@/components/CartCheckout";
import Navbar from "@/components/Navbar";
import PageLogo from "@/components/PageLogo";
import WhatsappFloat from "@/components/WhatsappFloat";
import {
  API_BASE_URL,
  fetchProductsByIds,
  loadRuntimeConfig,
  resolveImageUrl,
  resolveImageUrls,
} from "@/lib/api";
import { reconcileCartItems } from "@/lib/cart";
import { useUsbShopCart } from "@/lib/useUsbShopCart";

type Product = {
  id: number;
  name: string;
  price: number;
  category: string;
  stock: number;
  badge?: string;
  description?: string | null;
  imageUrl?: string | null;
  imageUrls?: string[] | null;
  isFeatured?: boolean;
  isOffer?: boolean;
  isRecommended?: boolean;
};

export default function CartPage() {
  const [productsApiBase, setProductsApiBase] = useState(API_BASE_URL);
  const {
    setCart,
    cartItems,
    totalItems,
    total,
    isHydrated: cartHydrated,
    stockNotice,
    cartNotice,
    updateQty,
    removeItem,
    clearCart,
  } = useUsbShopCart();

  useEffect(() => {
    let active = true;
    void loadRuntimeConfig().then((apiBaseUrl) => {
      if (active && apiBaseUrl) {
        setProductsApiBase(apiBaseUrl);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const normalizeProductWithBase = useCallback(
    (
      item: Product & { is_featured?: boolean; is_offer?: boolean; is_recommended?: boolean },
      baseUrl: string
    ) => {
      const isFeatured = Boolean(item.is_featured ?? item.isFeatured);
      const imageUrls = Array.isArray(item.imageUrls)
        ? resolveImageUrls(item.imageUrls, baseUrl)
        : [];
      const fallbackUrl = resolveImageUrl(item.imageUrl ?? null, baseUrl);
      const primaryUrl = imageUrls[0] ?? fallbackUrl;
      const mergedUrls = imageUrls.length > 0 ? imageUrls : fallbackUrl ? [fallbackUrl] : [];
      return {
        ...item,
        imageUrl: primaryUrl,
        imageUrls: mergedUrls,
        isFeatured,
        isOffer: Boolean(item.is_offer ?? item.isOffer),
        isRecommended: Boolean(item.is_recommended ?? item.isRecommended),
        badge: item.badge ?? (isFeatured ? "Destacado" : undefined),
      };
    },
    []
  );

  const refreshProducts = useCallback(async () => {
    if (cartItems.length === 0) {
      return false;
    }
    const cartProductIds = Array.from(
      new Set(
        cartItems
          .map((item) => Number(item.product.id))
          .filter((id) => Number.isInteger(id) && id > 0)
      )
    );
    if (cartProductIds.length === 0) {
      return false;
    }

    const host = typeof window !== "undefined" ? window.location.hostname : "";
    const protocol = typeof window !== "undefined" ? window.location.protocol || "http:" : "http:";
    const fallbackBase =
      productsApiBase.startsWith("/") && host ? `${protocol}//${host}:8000` : null;
    const bases = [productsApiBase || API_BASE_URL];
    if (API_BASE_URL && API_BASE_URL !== bases[0]) {
      bases.push(API_BASE_URL);
    }
    if (fallbackBase && !bases.includes(fallbackBase)) {
      bases.push(fallbackBase);
    }

    for (const baseUrl of bases) {
      try {
        const data = await fetchProductsByIds<Product>(cartProductIds, { baseUrl });
        setProductsApiBase((prev) => (prev === baseUrl ? prev : baseUrl));
        const normalized = data.map((item) => normalizeProductWithBase(item, baseUrl));
        const nextCart = reconcileCartItems(cartItems, normalized);
        setCart((prev) => {
          if (!nextCart.changed) {
            return prev;
          }
          const next: typeof prev = {};
          nextCart.items.forEach((entry) => {
            next[entry.product.id] = entry;
          });
          return next;
        });
        return nextCart.changed;
      } catch {
        // try next base
      }
    }
    return false;
  }, [cartItems, normalizeProductWithBase, productsApiBase, setCart]);

  useEffect(() => {
    if (!cartHydrated) {
      return;
    }
    void refreshProducts();
  }, [cartHydrated, refreshProducts]);

  return (
    <main className="page">
      <PageLogo />
      <Navbar
        cartCount={totalItems}
        cartTotal={total}
        showTrust={false}
        navItems={[
          { label: "Inicio", href: "/" },
          { label: "Catálogo", href: "/catalog/" },
        ]}
      />
      <WhatsappFloat />

      <header className="section">
        <p className="section-kicker">Carrito</p>
        <h1 className="section-title">Tu pedido</h1>
        <p className="hero-text">
          Tus productos quedan guardados por 2 días. Completá tus datos y confirmá el pedido.
        </p>
        <div className="section-actions">
          <Link className="button button--ghost" href="/catalog/">
            Seguir comprando
          </Link>
        </div>
      </header>

      <section className="section section--tight" id="carrito">
        <CartCheckout
          apiBaseUrl={productsApiBase || API_BASE_URL}
          cartItems={cartItems}
          totalItems={totalItems}
          total={total}
          stockNotice={stockNotice}
          cartNotice={cartNotice}
          onUpdateQty={updateQty}
          onRemoveItem={removeItem}
          onClearCart={clearCart}
          onSyncCart={refreshProducts}
          onAfterOrder={() => {
            void refreshProducts();
          }}
        />
      </section>
    </main>
  );
}
