"use client";

import { useEffect, useMemo, useState } from "react";
import ProductCard from "@/components/ProductCard";
import { fetchJson, getApiBaseUrl, loadRuntimeConfig, resolveImageUrl, resolveImageUrls } from "@/lib/api";
import { matchesSearchQuery, normalizeSearchText } from "@/lib/search";

type Product = {
  id: number;
  name: string;
  price: number;
  category: string;
  stock: number;
  created_at?: string | null;
  updated_at?: string | null;
  imageUrl?: string | null;
  imageUrls?: string[] | null;
  description?: string | null;
};

type Category = {
  id: number;
  name: string;
  product_count?: number;
};

const fallbackCategories = [
  "Cables y cargadores",
  "Celulares",
  "Hogar",
  "Auriculares",
  "Parlantes y microfonos",
  "Consolas y computacion",
  "Luces e iluminacion",
  "Smartwatch",
  "Termos y vasos",
  "Pilas y baterias",
  "Pendrive y memorias",
  "Soportes",
  "Variedad",
  "Oficina",
  "Vapers",
];

const normalizeLabel = (value: string | null | undefined) =>
  normalizeSearchText(value);
const collectOrderedCategories = (preferred: string[], fallback: string[]) => {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const category of [...preferred, ...fallback]) {
    const trimmed = String(category || "").trim();
    const normalized = normalizeLabel(trimmed);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    next.push(trimmed);
    seen.add(normalized);
  }
  return next;
};
const PRODUCTS_CACHE_KEY = "usbshop_catalog_cache_v1";
const PRODUCTS_CACHE_TTL_MS = 5 * 60 * 1000;
const INITIAL_PAGE_SIZE = 60;
const REQUEST_TIMEOUT_MS = 12000;
const SEARCH_DEBOUNCE_MS = 300;

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

const loadCachedList = <T,>(key: string, ttlMs: number) => {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as { savedAt?: string; data?: T; baseUrl?: string };
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.data)) {
      return null;
    }
    const savedAt = parsed.savedAt ? Date.parse(parsed.savedAt) : NaN;
    if (!Number.isFinite(savedAt) || Date.now() - savedAt > ttlMs) {
      return null;
    }
    return {
      data: parsed.data,
      baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : getApiBaseUrl(),
    };
  } catch {
    return null;
  }
};

const saveCachedList = (key: string, data: unknown, baseUrl: string) => {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(
      key,
      JSON.stringify({ data, baseUrl, savedAt: new Date().toISOString() })
    );
  } catch {
    return;
  }
};

const toComparableTimestamp = (product: Product) => {
  const raw = product.created_at || product.updated_at || "";
  const parsed = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : product.id;
};

export default function CatalogPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const pageSize = INITIAL_PAGE_SIZE;

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedQuery(query.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timeoutId);
  }, [query]);

  const normalizeProducts = (items: Product[], baseUrl: string) =>
    items.map((item) => {
      const resolvedImageUrl = resolveImageUrl(item.imageUrl, baseUrl);
      const resolvedImageUrls = resolveImageUrls(item.imageUrls, baseUrl);
      const imageUrls =
        resolvedImageUrls.length > 0
          ? resolvedImageUrls
          : resolvedImageUrl
          ? [resolvedImageUrl]
          : [];
      return {
        ...item,
        imageUrl: imageUrls[0] ?? resolvedImageUrl ?? null,
        imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
      };
    });

  const fetchProductsPage = async (offset = 0, currentQuery = "") => {
    let lastError: unknown = null;
    await loadRuntimeConfig();
    const host = typeof window !== "undefined" ? window.location.hostname : "";
    const defaultBase = getApiBaseUrl();
    const fallbackBase =
      host === "localhost" || host === "127.0.0.1" ? `http://${host}:8000` : null;
    const baseUrls = fallbackBase && fallbackBase !== defaultBase ? [defaultBase, fallbackBase] : [defaultBase];
    const params = new URLSearchParams({
      limit: String(pageSize),
      offset: String(offset),
    });
    if (currentQuery) {
      params.set("q", currentQuery);
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      for (const baseUrl of baseUrls) {
        const controller = new AbortController();
        const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
          const data =
            baseUrl === defaultBase
              ? await fetchJson<Product[]>(`/products?${params.toString()}`, { signal: controller.signal, cache: "no-store" })
              : await fetch(`${baseUrl}/products?${params.toString()}`, {
                  credentials: "include",
                  cache: "no-store",
                  headers: { "Content-Type": "application/json" },
                  signal: controller.signal,
                }).then(async (response) => {
                  if (!response.ok) {
                    throw new Error("API request failed");
                  }
                  return (await response.json()) as Product[];
                });
          return {
            data,
            baseUrl,
            normalized: normalizeProducts(data, baseUrl),
          };
        } catch (fetchError) {
          lastError = fetchError;
        } finally {
          window.clearTimeout(timeoutId);
        }
      }
      if (attempt < 2) {
        await wait(500 * (attempt + 1));
      }
    }
    throw lastError ?? new Error("API request failed");
  };

  useEffect(() => {
    let active = true;
    const loadCategories = async () => {
      try {
        await loadRuntimeConfig();
        const data = await fetchJson<Category[]>("/categories", { cache: "no-store" });
        if (active && Array.isArray(data)) {
          setCategories(data);
        }
      } catch {
        if (active) {
          setCategories([]);
        }
      }
    };
    const loadProducts = async (offset = 0, mode: "replace" | "append" = "replace") => {
      let hadCachedData = false;
      try {
        if (mode === "replace" && !debouncedQuery) {
          const cached = loadCachedList<Product[]>(PRODUCTS_CACHE_KEY, PRODUCTS_CACHE_TTL_MS);
          if (cached && active) {
            hadCachedData = true;
            setProducts(normalizeProducts(cached.data, cached.baseUrl));
            setHasMore(cached.data.length >= pageSize);
            setError(null);
            setIsLoading(false);
          }
        }
        if (mode === "replace") {
          if (!hadCachedData) {
            setIsLoading(true);
          }
        } else {
          setIsFetchingMore(true);
        }
        if (!hadCachedData) {
          setError(null);
        }
        const result = await fetchProductsPage(offset, debouncedQuery);
        if (!active || !Array.isArray(result.data)) {
          return;
        }
        setHasMore(result.data.length >= pageSize);
        setProducts((prev) => (mode === "append" ? [...prev, ...result.normalized] : result.normalized));
        if (!debouncedQuery && offset === 0) {
          saveCachedList(PRODUCTS_CACHE_KEY, result.data, result.baseUrl);
        }
        setError(null);
      } catch {
        if (active) {
          if (mode === "replace" && !hadCachedData) {
            setProducts([]);
            setError("No pudimos cargar el catalogo. Intenta de nuevo en unos segundos.");
          }
        }
      } finally {
        if (active) {
          setIsLoading(false);
          setIsFetchingMore(false);
        }
      }
    };
    void loadCategories();
    loadProducts(0, "replace").catch(() => {
      if (active) {
        setProducts([]);
      }
    });
    return () => {
      active = false;
    };
  }, [debouncedQuery]);

  const filtered = useMemo(() => {
    const value = normalizeSearchText(query);
    const sourceCategories = Array.from(
      new Set(
        products
          .map((product) => (product.category || "General").trim())
          .filter(Boolean)
      )
    ).sort((a, b) => a.localeCompare(b, "es"));
    const apiCategories = categories.map((category) => category.name).filter(Boolean);
    const orderedCategories = collectOrderedCategories(
      apiCategories.length > 0 ? apiCategories : fallbackCategories,
      sourceCategories
    );
    const categoryRank = new Map(
      orderedCategories.map((category, index) => [normalizeLabel(category), index])
    );
    const compareByCategoryThenNewest = (a: Product, b: Product) => {
      const rankA = categoryRank.get(normalizeLabel(a.category)) ?? Number.MAX_SAFE_INTEGER;
      const rankB = categoryRank.get(normalizeLabel(b.category)) ?? Number.MAX_SAFE_INTEGER;
      if (rankA !== rankB) {
        return rankA - rankB;
      }
      const dateCompare = toComparableTimestamp(b) - toComparableTimestamp(a);
      if (dateCompare !== 0) {
        return dateCompare;
      }
      return a.name.localeCompare(b.name, "es", { sensitivity: "base", numeric: true });
    };
    const source = value
      ? products.filter((product) => {
          return matchesSearchQuery(value, product.name, product.category, product.description || "");
        })
      : products;
    return [...source].sort(compareByCategoryThenNewest);
  }, [categories, products, query]);

  const skeletonCards = useMemo(() => Array.from({ length: 12 }, (_, idx) => idx), []);

  return (
    <main className="page">
      <header className="section">
        <p className="section-kicker">Catalogo</p>
        <h1 className="section-title">Explora todos los productos</h1>
        <p className="hero-text">Los precios y stock se sincronizan con ControlStock.</p>
        <div className="hero-actions catalog-tools">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Buscar por nombre o categoria"
            aria-label="Buscar por nombre o categoria"
            className="catalog-search"
          />
          <span className="catalog-meta">
            {filtered.length} productos
          </span>
        </div>
      </header>
      <div className="product-grid stagger">
        {isLoading ? (
          skeletonCards.map((card) => (
            <div key={`catalog-skeleton-${card}`} className="product-card product-skeleton" />
          ))
        ) : error ? (
          <div className="empty-state empty-state--wide">{error}</div>
        ) : filtered.length > 0 ? (
          filtered.map((product, index) => (
            <ProductCard
              key={product.id}
              product={product}
              imagePriority={index < 6 ? "high" : "auto"}
              style={{ "--delay": `${Math.min(index * 0.05, 0.6)}s` } as React.CSSProperties}
            />
          ))
        ) : (
          <div className="empty-state empty-state--wide">
            No hay productos con esos filtros.
          </div>
        )}
      </div>
      {!isLoading && !error && hasMore ? (
        <div className="section catalog-footer">
          <button
            className="button button--ghost"
            onClick={() => {
              if (!isFetchingMore) {
                const offset = products.length;
                const loadMore = async () => {
                  try {
                    setIsFetchingMore(true);
                    const result = await fetchProductsPage(offset, debouncedQuery);
                    if (Array.isArray(result.data)) {
                      setProducts((prev) => [...prev, ...result.normalized]);
                      setHasMore(result.data.length >= pageSize);
                    }
                  } finally {
                    setIsFetchingMore(false);
                  }
                };
                loadMore().catch(() => null);
              }
            }}
            disabled={isFetchingMore}
          >
            {isFetchingMore ? "Cargando mas..." : "Mostrar mas"}
          </button>
          <span className="catalog-meta">
            Mostrando {filtered.length}
          </span>
        </div>
      ) : null}
    </main>
  );
}
