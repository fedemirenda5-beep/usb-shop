"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ProductCard from "@/components/ProductCard";
import { fetchJson, getApiBaseUrl, loadRuntimeConfig, resolveImageUrl, resolveImageUrls } from "@/lib/api";
import { normalizeSearchText } from "@/lib/search";

type Product = {
  search_match?: 'exact' | 'approximate';
  id: number;
  name: string;
  price: number;
  category: string;
  stock: number;
  soldCount?: number;
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
const SEARCH_DEBOUNCE_MS = 300;


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
  const [retry, setRetry] = useState(0);
  const requestController = useRef<AbortController | null>(null);
  const currentQuery = useRef(query.trim());
  currentQuery.current = query.trim();
  const pending = isLoading || query.trim() !== debouncedQuery;

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

  const fetchProductsPage = async (offset = 0, search = "", signal?: AbortSignal) => {
    await loadRuntimeConfig();
    const baseUrl = getApiBaseUrl();
    const params = new URLSearchParams({ limit: String(pageSize), offset: String(offset) });
    if (search) params.set("q", search);
    const data = await fetchJson<Product[]>(`/products?${params}`, { signal, cache: "no-store" });
    return { data, baseUrl, normalized: normalizeProducts(data, baseUrl) };
  };

  useEffect(() => {
    let active = true;
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    if (query.trim() !== debouncedQuery) return () => controller.abort();
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
        await loadRuntimeConfig();
        if (mode === "replace" && !debouncedQuery) {
          const cached = loadCachedList<Product[]>(PRODUCTS_CACHE_KEY, PRODUCTS_CACHE_TTL_MS);
          if (cached && active && cached.baseUrl === getApiBaseUrl()) {
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
        const result = await fetchProductsPage(offset, debouncedQuery, controller.signal);
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
    if (!categories.length) void loadCategories();
    loadProducts(0, "replace").catch(() => {
      if (active) {
        setProducts([]);
      }
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [debouncedQuery, retry, query]);

  const filtered = useMemo(() => {
    const value = query.trim();
    if (value) return value === debouncedQuery ? products : [];
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
    return [...products].sort(compareByCategoryThenNewest);
  }, [categories, products, query, debouncedQuery]);

  const skeletonCards = useMemo(() => Array.from({ length: 12 }, (_, idx) => idx), []);

  return (
    <main className="page">
      <header className="section">
        <p className="section-kicker">Catalogo</p>
        <h1 className="section-title">Explora todos los productos</h1>
        <p className="hero-text">Los precios y stock se sincronizan con ControlStock.</p>
        <div className="hero-actions catalog-tools">
          <input
            type="search"
            enterKeyHint="search"
            value={query}
            onKeyDown={event => { if (event.key === 'Enter') setDebouncedQuery(query.trim()); }}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Buscar por nombre, categoría o código"
            aria-label="Buscar por nombre, categoría o código"
            className="catalog-search"
          />
          {query ? <button type="button" className="button button--ghost" onClick={() => { setQuery(''); setDebouncedQuery(''); }}>Limpiar búsqueda</button> : null}
          <span className="catalog-meta" role="status">
            {pending ? 'Buscando…' : `${filtered.length}${hasMore ? '+' : ''} productos` }
          </span>
        </div>
      </header>
      {filtered.some(product => product.search_match === 'approximate') ? <p role="status">Sin coincidencias exactas. Estos productos tienen nombres similares.</p> : null}
      {error ? <div role="alert" className="empty-state"><p>{error}</p><button className="button button--ghost" onClick={() => setRetry(value => value + 1)}>Reintentar</button></div> : null}
      <div className="product-grid stagger" aria-busy={pending}>
        {pending ? (
          skeletonCards.map((card) => (
            <div key={`catalog-skeleton-${card}`} className="product-card product-skeleton" />
          ))
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
            {error ? "Podés volver a intentar la búsqueda." : `No encontramos “${query}”. Probá con menos palabras, otro nombre o el código del producto.`}
          </div>
        )}
      </div>
      {!pending && !error && hasMore ? (
        <div className="section catalog-footer">
          <button
            className="button button--ghost"
            onClick={() => {
              if (!isFetchingMore) {
                const offset = products.length;
                const controller = requestController.current;
                if (!controller || controller.signal.aborted) return;
                const requestedQuery = debouncedQuery;
                const loadMore = async () => {
                  try {
                    setIsFetchingMore(true);
                    const result = await fetchProductsPage(offset, requestedQuery, controller.signal);
                    if (!controller.signal.aborted && currentQuery.current === requestedQuery && Array.isArray(result.data)) {
                      setProducts((prev) => [...prev, ...result.normalized]);
                      setHasMore(result.data.length >= pageSize);
                    }
                  } catch {
                    if (!controller.signal.aborted) setError('No pudimos cargar más resultados. Volvé a intentar.');
                  } finally {
                    if (!controller.signal.aborted) setIsFetchingMore(false);
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
