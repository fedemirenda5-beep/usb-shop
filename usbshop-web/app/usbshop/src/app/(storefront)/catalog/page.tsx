"use client";

import { useEffect, useMemo, useState } from "react";
import ProductCard from "@/components/ProductCard";
import { fetchJson, loadRuntimeConfig, resolveImageUrl, resolveImageUrls } from "@/lib/api";

type Product = {
  id: number;
  name: string;
  price: number;
  category: string;
  stock: number;
  imageUrl?: string | null;
  imageUrls?: string[] | null;
  description?: string | null;
};

export default function CatalogPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [query, setQuery] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const pageSize = 2000;

  useEffect(() => {
    let active = true;
    const loadProducts = async (offset = 0, mode: "replace" | "append" = "replace") => {
      try {
        if (mode === "replace") {
          setIsLoading(true);
        } else {
          setIsFetchingMore(true);
        }
        setError(null);
        await loadRuntimeConfig();
        const trimmed = query.trim();
        const params = new URLSearchParams({
          limit: String(pageSize),
          offset: String(offset),
        });
        if (trimmed) {
          params.set("q", trimmed);
        }
        const data = await fetchJson<Product[]>(`/products?${params.toString()}`);
        if (!active || !Array.isArray(data)) {
          return;
        }
        const normalized = data.map((item) => {
          const resolvedImageUrl = resolveImageUrl(item.imageUrl);
          const resolvedImageUrls = resolveImageUrls(item.imageUrls);
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
        setHasMore(data.length >= pageSize);
        setProducts((prev) => (mode === "append" ? [...prev, ...normalized] : normalized));
      } catch {
        if (active) {
          setError("No pudimos cargar el catalogo. Intenta de nuevo en unos segundos.");
          if (mode === "replace") {
            setProducts([]);
          }
        }
      } finally {
        if (active) {
          setIsLoading(false);
          setIsFetchingMore(false);
        }
      }
    };
    loadProducts(0, "replace").catch(() => {
      if (active) {
        setProducts([]);
      }
    });
    return () => {
      active = false;
    };
  }, [query]);

  const filtered = useMemo(() => {
    const value = query.trim().toLowerCase();
    if (!value) {
      return products;
    }
    return products.filter((product) => {
      return product.name.toLowerCase().includes(value) || product.category.toLowerCase().includes(value);
    });
  }, [products, query]);

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
                  const trimmed = query.trim();
                  const params = new URLSearchParams({
                    limit: String(pageSize),
                    offset: String(offset),
                  });
                  if (trimmed) {
                    params.set("q", trimmed);
                  }
                  try {
                    setIsFetchingMore(true);
                    const data = await fetchJson<Product[]>(`/products?${params.toString()}`);
                    if (Array.isArray(data)) {
                      const normalized = data.map((item) => {
                        const resolvedImageUrl = resolveImageUrl(item.imageUrl);
                        const resolvedImageUrls = resolveImageUrls(item.imageUrls);
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
                      setProducts((prev) => [...prev, ...normalized]);
                      setHasMore(data.length >= pageSize);
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
