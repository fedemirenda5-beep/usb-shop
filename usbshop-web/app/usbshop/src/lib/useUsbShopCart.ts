"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  readStoredCart,
  writeStoredCart,
  type CartItem,
  type CartProduct,
} from "@/lib/cart";

type CartState = Record<number, CartItem>;

type UseUsbShopCartResult = {
  cart: CartState;
  setCart: React.Dispatch<React.SetStateAction<CartState>>;
  cartItems: CartItem[];
  totalItems: number;
  total: number;
  isHydrated: boolean;
  stockNotice: string | null;
  cartNotice: string | null;
  addItem: (product: CartProduct) => void;
  updateQty: (id: number, delta: number) => void;
  removeItem: (id: number) => void;
  clearCart: () => void;
};

const DEFAULT_PLACEHOLDER_STOCK = 9999;

export function useUsbShopCart(): UseUsbShopCartResult {
  const [cart, setCart] = useState<CartState>({});
  const [isHydrated, setIsHydrated] = useState(false);
  const [stockNotice, setStockNotice] = useState<string | null>(null);
  const stockNoticeTimer = useRef<number | null>(null);
  const [cartNotice, setCartNotice] = useState<string | null>(null);
  const cartNoticeTimer = useRef<number | null>(null);

  const cartItems = useMemo(() => Object.values(cart), [cart]);
  const totalItems = useMemo(
    () => cartItems.reduce((sum, item) => sum + item.qty, 0),
    [cartItems]
  );
  const total = useMemo(
    () => cartItems.reduce((sum, item) => sum + item.qty * item.product.price, 0),
    [cartItems]
  );

  useEffect(() => {
    const stored = readStoredCart();
    if (stored.expired) {
      setCartNotice("Tu carrito venció y se limpió.");
      if (cartNoticeTimer.current) {
        window.clearTimeout(cartNoticeTimer.current);
      }
      cartNoticeTimer.current = window.setTimeout(() => {
        setCartNotice(null);
      }, 2600);
    }
    if (stored.items.length > 0) {
      const hydrated: CartState = {};
      stored.items.forEach((entry) => {
        hydrated[entry.product.id] = {
          product: {
            id: entry.product.id,
            name: entry.product.name,
            price: entry.product.price,
            category: entry.product.category,
            stock: DEFAULT_PLACEHOLDER_STOCK,
            imageUrl: null,
            imageUrls: null,
          },
          qty: entry.qty,
        };
      });
      setCart(hydrated);
    }
    setIsHydrated(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!isHydrated) {
      return;
    }
    const items = Object.values(cart)
      .map((entry) => ({
        product: {
          id: entry.product.id,
          name: entry.product.name,
          price: entry.product.price,
          category: entry.product.category,
        },
        qty: entry.qty,
      }))
      .filter((entry) => Number.isFinite(entry.qty) && entry.qty > 0);
    writeStoredCart(items);
  }, [cart, isHydrated]);

  useEffect(() => {
    return () => {
      if (stockNoticeTimer.current) {
        window.clearTimeout(stockNoticeTimer.current);
      }
      if (cartNoticeTimer.current) {
        window.clearTimeout(cartNoticeTimer.current);
      }
    };
  }, []);

  const showStockNotice = (message: string) => {
    setStockNotice(message);
    if (stockNoticeTimer.current) {
      window.clearTimeout(stockNoticeTimer.current);
    }
    stockNoticeTimer.current = window.setTimeout(() => {
      setStockNotice(null);
    }, 2500);
  };

  const showCartNotice = (message: string) => {
    setCartNotice(message);
    if (cartNoticeTimer.current) {
      window.clearTimeout(cartNoticeTimer.current);
    }
    cartNoticeTimer.current = window.setTimeout(() => {
      setCartNotice(null);
    }, 2200);
  };

  const addItem = (product: CartProduct) => {
    setCart((prev) => {
      const current = prev[product.id];
      const rawStock = Number(product.stock);
      const stock = Number.isFinite(rawStock) ? rawStock : Number.POSITIVE_INFINITY;
      if (stock <= 0) {
        showStockNotice(`${product.name} no tiene stock disponible.`);
        return prev;
      }
      const nextQty = current ? current.qty + 1 : 1;
      const qty = stock === Number.POSITIVE_INFINITY ? nextQty : Math.min(nextQty, stock);

      if (stock !== Number.POSITIVE_INFINITY && current && current.qty >= stock) {
        showStockNotice(`Máximo disponible para ${product.name}: ${stock}.`);
        return prev;
      }
      if (qty <= 0) {
        return prev;
      }
      showCartNotice(`${product.name} agregado al carrito.`);
      return { ...prev, [product.id]: { product, qty } };
    });
  };

  const updateQty = (id: number, delta: number) => {
    setCart((prev) => {
      const current = prev[id];
      if (!current) {
        return prev;
      }
      const rawStock = Number(current.product.stock);
      const stock = Number.isFinite(rawStock) ? rawStock : Number.POSITIVE_INFINITY;
      if (delta > 0 && stock <= 0) {
        showStockNotice(`${current.product.name} no tiene stock disponible.`);
        const next = { ...prev };
        delete next[id];
        return next;
      }
      const nextQty =
        stock === Number.POSITIVE_INFINITY
          ? current.qty + delta
          : Math.min(current.qty + delta, stock);

      if (delta > 0 && stock !== Number.POSITIVE_INFINITY && current.qty >= stock) {
        showStockNotice(`Máximo disponible para ${current.product.name}: ${stock}.`);
      }
      if (nextQty <= 0) {
        const next = { ...prev };
        delete next[id];
        return next;
      }
      return { ...prev, [id]: { ...current, qty: nextQty } };
    });
  };

  const removeItem = (id: number) => {
    setCart((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const clearCart = () => {
    setCart({});
  };

  return {
    cart,
    setCart,
    cartItems,
    totalItems,
    total,
    isHydrated,
    stockNotice,
    cartNotice,
    addItem,
    updateQty,
    removeItem,
    clearCart,
  };
}
