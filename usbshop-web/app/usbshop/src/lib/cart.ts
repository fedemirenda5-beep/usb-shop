export type CartProduct = {
  id: number;
  name: string;
  price: number;
  category: string;
  stock?: number;
  badge?: string;
  description?: string | null;
  imageUrl?: string | null;
  imageUrls?: string[] | null;
  isFeatured?: boolean;
  isOffer?: boolean;
  isRecommended?: boolean;
};

export type CartItem = {
  product: CartProduct;
  qty: number;
};

export type StoredCartProduct = {
  id: number;
  name: string;
  price: number;
  category: string;
};

export type StoredCartItem = {
  product?: StoredCartProduct;
  qty?: number;
};

export type StoredCart = {
  items?: StoredCartItem[];
  savedAt?: string;
};

export const CART_STORAGE_KEY = "usbshop_cart_v1";
export const CART_TTL_MS = 2 * 24 * 60 * 60 * 1000;

export const readStoredCart = (): {
  items: Array<{ product: StoredCartProduct; qty: number }>;
  expired: boolean;
} => {
  if (typeof window === "undefined") {
    return { items: [], expired: false };
  }
  try {
    const raw = window.localStorage.getItem(CART_STORAGE_KEY);
    if (!raw) {
      return { items: [], expired: false };
    }
    const parsed = JSON.parse(raw) as StoredCart | StoredCartItem[];
    const savedAt = Array.isArray(parsed) ? undefined : parsed?.savedAt;
    if (savedAt) {
      const ts = Date.parse(savedAt);
      if (Number.isFinite(ts) && Date.now() - ts > CART_TTL_MS) {
        window.localStorage.removeItem(CART_STORAGE_KEY);
        return { items: [], expired: true };
      }
    }

    const itemsRaw = Array.isArray(parsed) ? parsed : parsed?.items;
    if (!Array.isArray(itemsRaw)) {
      return { items: [], expired: false };
    }

    const normalized: Array<{ product: StoredCartProduct; qty: number }> = [];
    itemsRaw.forEach((entry) => {
      const product = entry?.product;
      const qty = Number(entry?.qty);
      if (!product || !Number.isFinite(qty) || qty <= 0) {
        return;
      }
      const id = Number(product.id);
      const price = Number(product.price);
      const name = String(product.name || "").trim();
      const category = String(product.category || "").trim();
      if (!Number.isFinite(id) || id <= 0) {
        return;
      }
      if (!name || !category || !Number.isFinite(price) || price < 0) {
        return;
      }
      normalized.push({
        product: { id, name, price, category },
        qty: Math.floor(qty),
      });
    });

    const merged = new Map<number, { product: StoredCartProduct; qty: number }>();
    normalized.forEach((entry) => {
      const current = merged.get(entry.product.id);
      if (current) {
        merged.set(entry.product.id, {
          product: entry.product,
          qty: current.qty + entry.qty,
        });
      } else {
        merged.set(entry.product.id, entry);
      }
    });

    return { items: Array.from(merged.values()), expired: false };
  } catch {
    return { items: [], expired: false };
  }
};

export const writeStoredCart = (items: Array<{ product: StoredCartProduct; qty: number }>) => {
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (!Array.isArray(items) || items.length === 0) {
      window.localStorage.removeItem(CART_STORAGE_KEY);
      return;
    }
    const payload: StoredCart = {
      savedAt: new Date().toISOString(),
      items: items.map((entry) => ({ product: entry.product, qty: entry.qty })),
    };
    window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // ignore storage failures (private mode, etc.)
  }
};

