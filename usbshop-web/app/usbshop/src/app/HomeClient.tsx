"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import Navbar from "@/components/Navbar";
import ProductCard from "@/components/ProductCard";
import CartDrawer from "@/components/CartDrawer";
import StorefrontCartPanel from "@/components/StorefrontCartPanel";
import {
  fetchJson,
  getOrderSecret,
  getApiBaseUrl,
  loadRuntimeConfig,
  resolveImageUrl,
  resolveImageUrls,
} from "@/lib/api";
import { buildSearchHaystack, matchesSearchQuery, normalizeSearchText, searchTokensFromQuery } from "@/lib/search";

type Product = {
  id: number;
  name: string;
  price: number;
  originalPrice?: number | null;
  category: string;
  stock: number;
  created_at?: string | null;
  updated_at?: string | null;
  badge?: string;
  imageUrl?: string | null;
  imageUrls?: string[] | null;
  description?: string | null;
  isFeatured?: boolean;
  isOffer?: boolean;
  isRecommended?: boolean;
  highlightNewArrivals?: boolean;
  flashOffer?: {
    price: number;
    endsAt: string;
  } | null;
};

type Category = {
  id: number;
  name: string;
  product_count?: number;
};

type CartItem = {
  product: Product;
  qty: number;
};

type HomeClientProps = {
  initialProducts?: Product[];
  initialFeatured?: Product[];
  initialCategories?: Category[];
  initialApiBase?: string;
  initialHasMoreProducts?: boolean;
};

const fallbackFeatured: Product[] = [];

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
const PRODUCTS_PAGE_SIZE = 24;
const BULK_PRODUCTS_PAGE_SIZE = 240;
const CATALOG_PAGE_SIZE = 12;
const SEARCH_PAGE_SIZE = 48;
const SEARCH_DEBOUNCE_MS = 250;
const HOME_SECTION_CARD_LIMIT = 4;
const STOREFRONT_FETCH_TIMEOUT_MS = 4_500;
const STOREFRONT_FETCH_ATTEMPTS = 1;
const STOREFRONT_BASE_ATTEMPTS = 2;
const STOREFRONT_RETRY_DELAY_MS = 250;
const getCardImagePriority = (index: number): "high" | "auto" | "low" => {
  if (index === 0) {
    return "high";
  }
  if (index < 4) {
    return "auto";
  }
  return "low";
};
const CART_STORAGE_KEY = "usbshop_cart_v1";
const CART_TTL_MS = 2 * 24 * 60 * 60 * 1000;
const PRODUCTS_CACHE_KEY = "usbshop_products_cache_v10";
const FEATURED_CACHE_KEY = "usbshop_featured_cache_v10";
const PRODUCTS_CACHE_TTL_MS = 5 * 60 * 1000;
const NEW_ARRIVAL_PIN_WINDOW_DAYS = 21;
const NEW_ARRIVAL_PIN_WINDOW_MS = NEW_ARRIVAL_PIN_WINDOW_DAYS * 24 * 60 * 60 * 1000;
const getStaggerDelay = (index: number, step = 0.05, max = 0.6) =>
  `${Math.min(index * step, max)}s`;
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
const parseTimestamp = (value?: string | null) => {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : NaN;
};
const getProductActivityTimestamp = (product: Product) => {
  const createdAt = parseTimestamp(product.created_at);
  const updatedAt = parseTimestamp(product.updated_at);
  if (Number.isFinite(createdAt) && Number.isFinite(updatedAt)) {
    return Math.max(createdAt, updatedAt);
  }
  if (Number.isFinite(updatedAt)) {
    return updatedAt;
  }
  if (Number.isFinite(createdAt)) {
    return createdAt;
  }
  return product.id;
};
const getFlashOfferCampaignLabel = (product: Product) => {
  const badge = (product.badge || "").trim();
  if (!badge) {
    return "Dia especial";
  }
  const normalized = normalizeLabel(badge);
  if (normalized === "relampago" || normalized === "oferta" || normalized === "destacado") {
    return "Dia especial";
  }
  return badge;
};
const getFlashOfferDiscountPercent = (product: Product) => {
  const original = Number(product.originalPrice || 0);
  const current = Number(product.price || 0);
  if (original <= current || original <= 0) {
    return 0;
  }
  return Math.round(((original - current) / original) * 100);
};
const toComparableTimestamp = (product: Product) => {
  return getProductActivityTimestamp(product);
};
const compareByNewest = (a: Product, b: Product) =>
  toComparableTimestamp(b) - toComparableTimestamp(a) || b.id - a.id;
const isPinnedNewArrival = (product: Product, now = Date.now()) =>
  Boolean(product.highlightNewArrivals) &&
  now - getProductActivityTimestamp(product) <= NEW_ARRIVAL_PIN_WINDOW_MS;
const hasDiscountedPrice = (product: Product) =>
  Number(product.originalPrice || 0) > Number(product.price || 0);
const getFlashOfferTimeLeftAt = (product: Product | null | undefined, now: number) => {
  const endsAt = product?.flashOffer?.endsAt;
  if (!endsAt) {
    return 0;
  }
  const parsed = Date.parse(endsAt);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.max(0, parsed - now);
};
const getFlashOfferTimeLeft = (product?: Product | null) =>
  getFlashOfferTimeLeftAt(product, Date.now());
const formatFlashTimeLeft = (ms: number) => {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return days > 0
    ? `${days}d ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
};
const parseStoredCart = (raw: string) => {
  try {
    const parsed = JSON.parse(raw) as
      | { items?: Array<{ product?: Product; qty?: number }>; savedAt?: string }
      | Array<{ product?: Product; qty?: number }>;
    if (!Array.isArray(parsed)) {
      const savedAt = parsed?.savedAt ? Date.parse(parsed.savedAt) : NaN;
      if (Number.isFinite(savedAt) && Date.now() - savedAt > CART_TTL_MS) {
        return null;
      }
    }
    const items = Array.isArray(parsed) ? parsed : parsed?.items;
    if (!Array.isArray(items)) {
      return null;
    }
    const next: Record<number, CartItem> = {};
    items.forEach((item) => {
      if (!item || typeof item !== "object") {
        return;
      }
      const product = item.product;
      const qty = Number(item.qty);
      const id = Number(product?.id);
      if (!product || !Number.isFinite(id) || !Number.isFinite(qty) || qty <= 0) {
        return;
      }
      next[id] = { product, qty: Math.round(qty) };
    });
    return Object.keys(next).length > 0 ? next : null;
  } catch {
    return null;
  }
};

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
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const savedAt = parsed.savedAt ? Date.parse(parsed.savedAt) : NaN;
    if (!Number.isFinite(savedAt) || Date.now() - savedAt > ttlMs) {
      return null;
    }
    if (!Array.isArray(parsed.data)) {
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

const isStoredCartExpired = (raw: string) => {
  try {
    const parsed = JSON.parse(raw) as { savedAt?: string } | unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    const savedAt = (parsed as { savedAt?: string }).savedAt;
    if (!savedAt) {
      return false;
    }
    const ts = Date.parse(savedAt);
    return Number.isFinite(ts) && Date.now() - ts > CART_TTL_MS;
  } catch {
    return false;
  }
};
const normalizeProductWithBase = (
  item: Product & {
    is_featured?: boolean;
    is_offer?: boolean;
    is_recommended?: boolean;
    highlight_new_arrivals?: boolean;
  },
  baseUrl: string
) => {
  const isFeatured = Boolean(item.is_featured ?? item.isFeatured);
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
    isFeatured,
    isOffer: Boolean(item.is_offer ?? item.isOffer),
    isRecommended: Boolean(item.is_recommended ?? item.isRecommended),
    highlightNewArrivals: Boolean(item.highlight_new_arrivals ?? item.highlightNewArrivals),
    badge: item.badge ?? (isFeatured ? "Destacado" : undefined),
  };
};

const getProductPlaceholderLabel = (value?: string | null) => {
  const words = (value ?? "")
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (words.length === 0) {
    return "USB";
  }
  return words
    .slice(0, 2)
    .map((item) => item.charAt(0).toUpperCase())
    .join("");
};

const FlashOfferTimer = memo(function FlashOfferTimer({ product }: { product: Product }) {
  const [timeLeft, setTimeLeft] = useState(() => getFlashOfferTimeLeft(product));

  useEffect(() => {
    setTimeLeft(getFlashOfferTimeLeft(product));
    const timer = window.setInterval(() => {
      setTimeLeft(getFlashOfferTimeLeft(product));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [product.id, product.flashOffer?.endsAt]);

  return (
    <div className="flash-offer__timer" aria-label="Tiempo restante">
      <span>Termina en</span>
      <strong>{formatFlashTimeLeft(timeLeft)}</strong>
    </div>
  );
});

export default function HomeClient({
  initialProducts,
  initialFeatured,
  initialCategories,
  initialApiBase,
  initialHasMoreProducts,
}: HomeClientProps) {
  const initialBase = initialApiBase || getApiBaseUrl();
  const [productsApiBase, setProductsApiBase] = useState(initialBase);
  const [featured, setFeatured] = useState<Product[]>(() =>
    (initialFeatured ?? fallbackFeatured).map((item) =>
      normalizeProductWithBase(item, initialBase)
    )
  );
  const [products, setProducts] = useState<Product[]>(() =>
    (initialProducts ?? []).map((item) => normalizeProductWithBase(item, initialBase))
  );
  const [categories, setCategories] = useState<Category[]>(() =>
    Array.isArray(initialCategories) ? initialCategories : []
  );
  const [categoriesLoaded, setCategoriesLoaded] = useState(
    Array.isArray(initialCategories)
  );
  const [imageRefreshKey, setImageRefreshKey] = useState(0);
  const [catalogLimit, setCatalogLimit] = useState(CATALOG_PAGE_SIZE);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [hasMoreProducts, setHasMoreProducts] = useState(
    typeof initialHasMoreProducts === "boolean" ? initialHasMoreProducts : true
  );
  const [cart, setCart] = useState<Record<number, CartItem>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Product[] | null>(null);
  const [isLoadingSearch, setIsLoadingSearch] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [showCatalogSection, setShowCatalogSection] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [featuredIndex, setFeaturedIndex] = useState(0);
  const [orderStatus, setOrderStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [orderMessage, setOrderMessage] = useState<string | null>(null);
  const [isCartOpen, setIsCartOpen] = useState(false);
  const [isLoadingFeatured, setIsLoadingFeatured] = useState(!Array.isArray(initialFeatured));
  const [isLoadingProducts, setIsLoadingProducts] = useState(!Array.isArray(initialProducts));
  const [stockNotice, setStockNotice] = useState<string | null>(null);
  const stockNoticeTimer = useRef<number | null>(null);
  const [cartNotice, setCartNotice] = useState<string | null>(null);
  const cartNoticeTimer = useRef<number | null>(null);
  const cartHydrated = useRef(false);
  const featuredRetryTimer = useRef<number | null>(null);
  const productsRetryTimer = useRef<number | null>(null);
  const featuredRequestRef = useRef(0);
  const productsRequestRef = useRef(0);
  const searchRequestRef = useRef(0);
  const isFetchingMoreRef = useRef(false);
  const hasMoreProductsRef = useRef(true);
  const quickViewHistoryActiveRef = useRef(false);
  const quickViewClosingFromHistoryRef = useRef(false);
  const [orderName, setOrderName] = useState("");
  const [orderPhone, setOrderPhone] = useState("");
  const [orderEmail, setOrderEmail] = useState("");
  const [orderNotes, setOrderNotes] = useState("");
  const [quickView, setQuickView] = useState<Product | null>(null);
  const [quickViewImageIndex, setQuickViewImageIndex] = useState(0);
  const [quickViewImageFailed, setQuickViewImageFailed] = useState(false);
  const [isQuickViewImageExpanded, setIsQuickViewImageExpanded] = useState(false);
  const [isMobileLayout, setIsMobileLayout] = useState(false);
  const isPublic =
    typeof window !== "undefined" &&
    !["localhost", "127.0.0.1"].includes(window.location.hostname);

  useEffect(() => {
    isFetchingMoreRef.current = isFetchingMore;
  }, [isFetchingMore]);

  useEffect(() => {
    hasMoreProductsRef.current = hasMoreProducts;
  }, [hasMoreProducts]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const media = window.matchMedia("(max-width: 700px)");
    const sync = () => setIsMobileLayout(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    let active = true;
    const loadConfig = async () => {
      const runtimeBase = await loadRuntimeConfig();
      if (active && runtimeBase) {
        setProductsApiBase(runtimeBase);
      }
    };
    void loadConfig();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const requestedCategory = params.get("categoria");
    if (!requestedCategory) {
      return;
    }
    const normalizedRequestedCategory = normalizeLabel(requestedCategory);
    const matchedCategory =
      categories.find((category) => normalizeLabel(category.name) === normalizedRequestedCategory)?.name ||
      products.find((product) => normalizeLabel(product.category) === normalizedRequestedCategory)?.category ||
      requestedCategory;
    setSelectedCategory(matchedCategory);
    setSearchQuery("");
    setCatalogLimit(Number.MAX_SAFE_INTEGER);
  }, [categories, products]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearchQuery(searchQuery.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [searchQuery]);

  const wait = (ms: number) =>
    new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });

  const handleSearchChange = (value: string) => {
    setSearchQuery(value);
    setSelectedCategory(null);
  };

  const handleCategorySelect = (category: string | null) => {
    setSelectedCategory(category);
    setSearchQuery("");
    setShowCatalogSection(Boolean(category));
    setCatalogLimit(category ? Number.MAX_SAFE_INTEGER : CATALOG_PAGE_SIZE);
    if (category && hasMoreProducts && !isFetchingMore) {
      void fetchAllProducts();
    }
    window.requestAnimationFrame(() => {
      const target =
        (category ? document.getElementById("selected-category-results") : null) ||
        document.getElementById("featured-grid") ||
        document.getElementById("category-strip") ||
        document.getElementById("catalogo");
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  };

  const handleReturnHome = () => {
    setSelectedCategory(null);
    setSearchQuery("");
    setShowCatalogSection(false);
    setCatalogLimit(CATALOG_PAGE_SIZE);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleSearchSubmit = () => {
    const targetId = isSearching ? "resultados" : "catalogo";
    const target = document.getElementById(targetId);
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  const handleOpenCart = () => {
    setIsCartOpen(true);
    if (isMobileLayout) {
      return;
    }
    const cartSection = document.getElementById("carrito");
    if (cartSection) {
      cartSection.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  const handleOpenQuickView = (product: Product) => {
    setQuickView(product);
  };

  const handleCloseQuickView = () => {
    setIsQuickViewImageExpanded(false);
    if (
      typeof window !== "undefined" &&
      quickViewHistoryActiveRef.current &&
      window.history.state?.usbshopQuickView
    ) {
      quickViewClosingFromHistoryRef.current = true;
      window.history.back();
      return;
    }
    setQuickView(null);
  };

  const showPreviousQuickViewImage = () => {
    setQuickViewImageIndex((current) =>
      quickViewImages.length > 0 ? (current - 1 + quickViewImages.length) % quickViewImages.length : 0
    );
    setQuickViewImageFailed(false);
  };

  const showNextQuickViewImage = () => {
    setQuickViewImageIndex((current) =>
      quickViewImages.length > 0 ? (current + 1) % quickViewImages.length : 0
    );
    setQuickViewImageFailed(false);
  };

  const handleOpenExpandedQuickViewImage = () => {
    if (!quickViewImages[quickViewImageIndex]) {
      return;
    }
    setIsQuickViewImageExpanded(true);
  };

  const handleCloseExpandedQuickViewImage = () => {
    setIsQuickViewImageExpanded(false);
  };

  useEffect(() => {
    setQuickViewImageFailed(false);
    setQuickViewImageIndex(0);
    setIsQuickViewImageExpanded(false);
  }, [quickView?.id, quickView?.imageUrl, quickView?.imageUrls]);

  const quickViewImages = useMemo(() => {
    if (!quickView) {
      return [];
    }
    const values = Array.isArray(quickView.imageUrls)
      ? quickView.imageUrls
      : quickView.imageUrl
      ? [quickView.imageUrl]
      : [];
    return Array.from(new Set(values.filter(Boolean)));
  }, [quickView]);

  const handleViewFullCatalog = () => {
    setShowCatalogSection(true);
    setCatalogLimit(Number.MAX_SAFE_INTEGER);
    if (hasMoreProducts && !isFetchingMore) {
      void fetchAllProducts();
    }
    const target = document.getElementById("catalogo");
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  const handleLoadMoreCatalog = () => {
    setShowCatalogSection(true);
    setCatalogLimit((value) => value + CATALOG_PAGE_SIZE);
    if (hasMoreProducts && !isFetchingMore) {
      void loadMoreProducts();
    }
  };

  const loadMoreProducts = async () => {
    if (isFetchingMoreRef.current || !hasMoreProductsRef.current) {
      return;
    }
    isFetchingMoreRef.current = true;
    setIsFetchingMore(true);
    try {
      const result = await fetchProductsPage(products.length);
      if (result.normalized.length === 0) {
        setHasMoreProducts(false);
        return;
      }
      setProductsApiBase(result.baseUrl);
      setProducts((prev) => [...prev, ...result.normalized]);
      setHasMoreProducts(result.data.length >= PRODUCTS_PAGE_SIZE);
    } catch {
      setHasMoreProducts(false);
    } finally {
      isFetchingMoreRef.current = false;
      setIsFetchingMore(false);
    }
  };

  const fetchAllProducts = async () => {
    if (isFetchingMoreRef.current || !hasMoreProductsRef.current) {
      return;
    }
    isFetchingMoreRef.current = true;
    setIsFetchingMore(true);
    try {
      let offset = products.length;
      let combined = [...products];
      let more = true;
      let baseUrl = productsApiBase;
      while (more) {
        const result = await fetchProductsPage(offset, "", BULK_PRODUCTS_PAGE_SIZE);
        baseUrl = result.baseUrl;
        if (result.normalized.length === 0) {
          more = false;
          break;
        }
        combined = [...combined, ...result.normalized];
        offset += result.normalized.length;
        if (result.data.length < BULK_PRODUCTS_PAGE_SIZE) {
          more = false;
        }
      }
      setProductsApiBase(baseUrl);
      setProducts(combined);
      setHasMoreProducts(false);
    } catch {
      setHasMoreProducts(false);
    } finally {
      isFetchingMoreRef.current = false;
      setIsFetchingMore(false);
    }
  };


  const fetchWithRetry = async <T,>(
    path: string,
    attempts = STOREFRONT_BASE_ATTEMPTS,
    delayMs = STOREFRONT_RETRY_DELAY_MS
  ): Promise<{ data: T; baseUrl: string }> => {
    let lastError: unknown;
    await loadRuntimeConfig();
    const host = typeof window !== "undefined" ? window.location.hostname : "";
    const fallbackBase =
      host === "localhost" || host === "127.0.0.1" ? `http://${host}:8000` : null;
    const primaryBase = (productsApiBase || getApiBaseUrl()).trim();
    const bases = Array.from(
      new Set(
        [primaryBase, getApiBaseUrl(), fallbackBase]
          .map((value) => (value || "").trim())
          .filter(Boolean)
      )
    );
    const fetchFromBase = async (baseUrl: string) => {
      return fetchJson<T>(path, undefined, {
        attempts: STOREFRONT_FETCH_ATTEMPTS,
        baseUrl,
        timeoutMs: STOREFRONT_FETCH_TIMEOUT_MS,
      });
    };
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      for (const baseUrl of bases) {
        try {
          const data = await fetchFromBase(baseUrl);
          return { data, baseUrl };
        } catch (error) {
          lastError = error;
        }
      }
      if (attempt < attempts - 1) {
        await wait(delayMs * (attempt + 1));
      }
    }
    throw lastError ?? new Error("API request failed");
  };

  const normalizeProduct = (
    item: Product & { is_featured?: boolean; is_offer?: boolean; is_recommended?: boolean },
    baseUrl: string = productsApiBase
  ) => normalizeProductWithBase(item, baseUrl);

  const applyFeaturedResult = (result: { data: Product[]; baseUrl: string }) => {
    setProductsApiBase(result.baseUrl);
    const normalized = result.data.map((item) => normalizeProduct(item, result.baseUrl));
    setFeatured(normalized);
    saveCachedList(FEATURED_CACHE_KEY, result.data, result.baseUrl);
    setImageRefreshKey((value) => value + 1);
  };

  const applyProductsResult = (result: { data: Product[]; baseUrl: string; normalized: Product[] }) => {
    setProductsApiBase(result.baseUrl);
    setProducts(result.normalized);
    setHasMoreProducts(result.data.length >= PRODUCTS_PAGE_SIZE);
    saveCachedList(PRODUCTS_CACHE_KEY, result.data, result.baseUrl);
    setImageRefreshKey((value) => value + 1);
  };

  const fetchProductsPage = async (
    offset: number,
    query = "",
    limit = PRODUCTS_PAGE_SIZE
  ) => {
    const params = new URLSearchParams({
      sort: "newest",
      limit: String(limit),
      offset: String(offset),
    });
    if (query.trim()) {
      params.set("q", query.trim());
    }
    const result = await fetchWithRetry<Product[]>(`/products?${params.toString()}`);
    const normalized = result.data.map((item) => normalizeProduct(item, result.baseUrl));
    return { ...result, normalized };
  };

  const refreshProducts = async () => {
    const [featuredResult, productsResult] = await Promise.all([
      fetchWithRetry<Product[]>("/featured?limit=6"),
      fetchProductsPage(0),
    ]);
    applyFeaturedResult(featuredResult);
    applyProductsResult(productsResult);
  };

  useEffect(() => {
    let active = true;
    if (Array.isArray(initialCategories)) {
      setCategories(initialCategories);
      setCategoriesLoaded(true);
      return () => {
        active = false;
      };
    }
    const loadCategories = async () => {
      try {
        const result = await fetchWithRetry<Category[]>("/categories");
        if (!active || !Array.isArray(result.data)) {
          return;
        }
        setCategories(result.data);
      } catch {
        if (active) {
          setCategories([]);
        }
      } finally {
        if (active) {
          setCategoriesLoaded(true);
        }
      }
    };
    void loadCategories();
    return () => {
      active = false;
    };
  }, [initialCategories]);

  useEffect(() => {
    let active = true;
    const requestId = featuredRequestRef.current + 1;
    featuredRequestRef.current = requestId;
    let refreshTimer: number | null = null;
    const loadFeatured = async () => {
      try {
        if (!Array.isArray(initialFeatured)) {
          const cached = loadCachedList<Product[]>(FEATURED_CACHE_KEY, PRODUCTS_CACHE_TTL_MS);
          if (cached && active) {
            setProductsApiBase(cached.baseUrl);
            setFeatured(cached.data.map((item) => normalizeProduct(item, cached.baseUrl)));
            setIsLoadingFeatured(false);
          } else {
            setIsLoadingFeatured(true);
          }
        }
        const result = await fetchWithRetry<Product[]>("/featured?limit=6");
        if (!active || featuredRequestRef.current !== requestId || !Array.isArray(result.data) || result.data.length === 0) {
          return;
        }
        applyFeaturedResult(result);
      } catch {
        if (!active || featuredRequestRef.current !== requestId) {
          return;
        }
        if (featuredRetryTimer.current) {
          window.clearTimeout(featuredRetryTimer.current);
        }
        featuredRetryTimer.current = window.setTimeout(() => {
          void loadFeatured();
        }, 2500);
      } finally {
        if (active && featuredRequestRef.current === requestId) {
          setIsLoadingFeatured(false);
        }
      }
    };
    if (Array.isArray(initialFeatured)) {
      refreshTimer = window.setTimeout(() => {
        void loadFeatured();
      }, 1200);
    } else {
      void loadFeatured();
    }
    return () => {
      active = false;
      if (refreshTimer) {
        window.clearTimeout(refreshTimer);
      }
      if (featuredRetryTimer.current) {
        window.clearTimeout(featuredRetryTimer.current);
        featuredRetryTimer.current = null;
      }
    };
  }, [initialFeatured]);

  useEffect(() => {
    const source = featured.length > 0 ? featured : products;
    if (source.length <= 4) {
      return;
    }
    const interval = setInterval(() => {
      setFeaturedIndex((prev) => (prev + 4) % source.length);
    }, 8000);
    return () => clearInterval(interval);
  }, [featured, products]);

  useEffect(() => {
    let active = true;
    const requestId = productsRequestRef.current + 1;
    productsRequestRef.current = requestId;
    let refreshTimer: number | null = null;
    const loadProducts = async () => {
      try {
        if (!Array.isArray(initialProducts)) {
          const cached = loadCachedList<Product[]>(PRODUCTS_CACHE_KEY, PRODUCTS_CACHE_TTL_MS);
          if (cached && active) {
            setProductsApiBase(cached.baseUrl);
            setProducts(cached.data.map((item) => normalizeProduct(item, cached.baseUrl)));
            setHasMoreProducts(cached.data.length >= PRODUCTS_PAGE_SIZE);
            setIsLoadingProducts(false);
          } else {
            setIsLoadingProducts(true);
          }
        }
        const result = await fetchProductsPage(0);
        if (!active || productsRequestRef.current !== requestId || !Array.isArray(result.data) || result.data.length === 0) {
          return;
        }
        applyProductsResult(result);
      } catch {
        if (!active || productsRequestRef.current !== requestId) {
          return;
        }
        if (productsRetryTimer.current) {
          window.clearTimeout(productsRetryTimer.current);
        }
        productsRetryTimer.current = window.setTimeout(() => {
          void loadProducts();
        }, 2500);
      } finally {
        if (active && productsRequestRef.current === requestId) {
          isFetchingMoreRef.current = false;
          setIsLoadingProducts(false);
          setIsFetchingMore(false);
        }
      }
    };
    if (Array.isArray(initialProducts)) {
      refreshTimer = window.setTimeout(() => {
        void loadProducts();
      }, 1600);
    } else {
      void loadProducts();
    }
    return () => {
      active = false;
      if (refreshTimer) {
        window.clearTimeout(refreshTimer);
      }
      if (productsRetryTimer.current) {
        window.clearTimeout(productsRetryTimer.current);
        productsRetryTimer.current = null;
      }
    };
  }, [initialProducts]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const stored = window.localStorage.getItem(CART_STORAGE_KEY);
    if (stored) {
      const parsed = parseStoredCart(stored);
      if (parsed) {
        setCart(parsed);
      } else if (isStoredCartExpired(stored)) {
        window.localStorage.removeItem(CART_STORAGE_KEY);
        setCartNotice("Tu carrito vencio y se limpio. Volve a armarlo.");
      }
    }
    cartHydrated.current = true;
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    if (!cartHydrated.current) {
      return;
    }
    const items = Object.values(cart);
    if (items.length === 0) {
      window.localStorage.removeItem(CART_STORAGE_KEY);
      return;
    }
    const payload = {
      items: items.map((item) => ({ product: item.product, qty: item.qty })),
      savedAt: new Date().toISOString(),
    };
    window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(payload));
  }, [cart]);

  useEffect(() => {
    if (!quickView || typeof window === "undefined") {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (isQuickViewImageExpanded) {
          setIsQuickViewImageExpanded(false);
          return;
        }
        setQuickView(null);
      }
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isQuickViewImageExpanded, quickView]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handlePopState = () => {
      if (!quickViewHistoryActiveRef.current) {
        return;
      }
      quickViewHistoryActiveRef.current = false;
      setQuickView(null);
      window.setTimeout(() => {
        quickViewClosingFromHistoryRef.current = false;
      }, 0);
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    if (!quickView) {
      if (quickViewClosingFromHistoryRef.current) {
        return;
      }
      if (quickViewHistoryActiveRef.current && window.history.state?.usbshopQuickView) {
        quickViewHistoryActiveRef.current = false;
        window.history.back();
      }
      return;
    }

    const nextState = {
      ...(window.history.state && typeof window.history.state === "object"
        ? window.history.state
        : {}),
      usbshopQuickView: true,
      usbshopQuickViewProductId: quickView.id,
    };

    if (quickViewHistoryActiveRef.current) {
      window.history.replaceState(nextState, "", window.location.href);
      return;
    }

    quickViewClosingFromHistoryRef.current = false;
    quickViewHistoryActiveRef.current = true;
    window.history.pushState(nextState, "", window.location.href);
  }, [quickView]);

  const cartItems = useMemo(() => Object.values(cart), [cart]);
  const totalItems = cartItems.reduce((sum, item) => sum + item.qty, 0);
  const total = cartItems.reduce((sum, item) => sum + item.qty * item.product.price, 0);
  const freeShippingThreshold = 250000;
  const remainingForFreeShipping = Math.max(0, freeShippingThreshold - total);

  useEffect(() => {
    setIsCartOpen(totalItems > 0);
  }, [totalItems]);

  const orderedCategories = useMemo(() => {
    if (!categoriesLoaded) {
      return fallbackCategories;
    }
    const apiCategories = categories
      .map((category) => String(category.name || "").trim())
      .filter(Boolean);
    if (apiCategories.length > 0) {
      return collectOrderedCategories(apiCategories, []);
    }
    const source = products.length > 0 ? products : featured;
    const sourceCategories = Array.from(
      new Set(
        source
          .map((product) => (product.category || "General").trim())
          .filter(Boolean)
      )
    ).sort((a, b) => a.localeCompare(b, "es"));
    return collectOrderedCategories(sourceCategories, fallbackCategories);
  }, [categories, categoriesLoaded, products, featured]);
  const categoryRank = useMemo(
    () => new Map(orderedCategories.map((category, index) => [normalizeLabel(category), index])),
    [orderedCategories]
  );
  const compareByCategoryThenName = (a: Product, b: Product) => {
    const categoryA = normalizeLabel(a.category) || "general";
    const categoryB = normalizeLabel(b.category) || "general";
    const rankA = categoryRank.get(categoryA) ?? Number.MAX_SAFE_INTEGER;
    const rankB = categoryRank.get(categoryB) ?? Number.MAX_SAFE_INTEGER;
    if (rankA !== rankB) {
      return rankA - rankB;
    }
    const categoryCompare = (a.category || "General").localeCompare(b.category || "General", "es", {
      sensitivity: "base",
      numeric: true,
    });
    if (categoryCompare !== 0) {
      return categoryCompare;
    }
    return (
      a.name.localeCompare(b.name, "es", { sensitivity: "base", numeric: true }) ||
      compareByNewest(a, b)
    );
  };
  const availableCategories = useMemo(() => {
    return orderedCategories.length > 0 ? orderedCategories : fallbackCategories;
  }, [orderedCategories]);
  const featuredSource = useMemo(() => {
    if (featured.length > 0) {
      return featured;
    }
    return products.slice(0, 12);
  }, [featured, products]);

  const searchTokens = useMemo(() => {
    return searchTokensFromQuery(debouncedSearchQuery);
  }, [debouncedSearchQuery]);
  const isSearching = searchTokens.length > 0;
  const skeletonCards = useMemo(() => Array.from({ length: 8 }, (_, idx) => idx), []);
  const allIndexedProducts = useMemo(() => {
    const map = new Map<number, Product>();
    for (const product of products) {
      map.set(product.id, product);
    }
    for (const product of featuredSource) {
      if (!map.has(product.id)) {
        map.set(product.id, product);
      }
    }
    return Array.from(map.values());
  }, [products, featuredSource]);
  const productSearchIndex = useMemo(() => {
    const map = new Map<number, string>();
    for (const product of allIndexedProducts) {
      map.set(
        product.id,
        buildSearchHaystack(product.name, product.category, product.badge)
      );
    }
    return map;
  }, [allIndexedProducts]);
  const productCategoryIndex = useMemo(() => {
    const map = new Map<number, string>();
    for (const product of allIndexedProducts) {
      map.set(product.id, normalizeLabel(product.category) || "general");
    }
    return map;
  }, [allIndexedProducts]);

  useEffect(() => {
    if (selectedCategory && hasMoreProducts && !isFetchingMore) {
      void fetchAllProducts();
    }
  }, [selectedCategory, hasMoreProducts, isFetchingMore]);

  useEffect(() => {
    if (!debouncedSearchQuery) {
      setSearchResults(null);
      setIsLoadingSearch(false);
      return;
    }
    let active = true;
    const requestId = searchRequestRef.current + 1;
    searchRequestRef.current = requestId;
    setIsLoadingSearch(true);
    const runSearch = async () => {
      try {
        const result = await fetchProductsPage(0, debouncedSearchQuery, SEARCH_PAGE_SIZE);
        if (!active || searchRequestRef.current !== requestId) {
          return;
        }
        setProductsApiBase(result.baseUrl);
        setSearchResults(result.normalized);
      } catch {
        if (!active || searchRequestRef.current !== requestId) {
          return;
        }
        setSearchResults([]);
      } finally {
        if (active && searchRequestRef.current === requestId) {
          setIsLoadingSearch(false);
        }
      }
    };
    void runSearch();
    return () => {
      active = false;
    };
  }, [debouncedSearchQuery]);

  useEffect(() => {
    if (!debouncedSearchQuery || !hasMoreProducts || isFetchingMore) {
      return;
    }
    void fetchAllProducts();
  }, [debouncedSearchQuery, hasMoreProducts, isFetchingMore]);

  const matchesSearch = (product: Product) => {
    if (searchTokens.length === 0) {
      return true;
    }
    const haystack =
      productSearchIndex.get(product.id) ||
      buildSearchHaystack(product.name, product.category, product.badge);
    return matchesSearchQuery(searchTokens.join(" "), haystack);
  };
  const matchesSelectedCategory = (product: Product) => {
    if (!selectedCategory) {
      return true;
    }
    return (
      (productCategoryIndex.get(product.id) || normalizeLabel(product.category) || "general") ===
      normalizeLabel(selectedCategory)
    );
  };

  const filteredFeatured = useMemo(() => {
    return [...featuredSource]
      .filter((product) => {
      if (!matchesSelectedCategory(product)) {
        return false;
      }
      return matchesSearch(product);
      })
      .sort(compareByNewest);
  }, [featuredSource, searchTokens, selectedCategory, productSearchIndex, productCategoryIndex]);
  const filteredProducts = useMemo(() => {
    const sourceMap = new Map<number, Product>();
    for (const product of products) {
      sourceMap.set(product.id, product);
    }
    for (const product of featuredSource) {
      if (!sourceMap.has(product.id)) {
        sourceMap.set(product.id, product);
      }
    }
    for (const product of searchResults ?? []) {
      sourceMap.set(product.id, product);
    }
    const source = Array.from(sourceMap.values());
    return [...source]
      .filter((product) => {
      if (!matchesSelectedCategory(product)) {
        return false;
      }
      return matchesSearch(product);
      })
      .sort(compareByCategoryThenName);
  }, [products, featuredSource, searchResults, searchTokens, selectedCategory, categoryRank, productSearchIndex, productCategoryIndex]);

  const catalogSource = useMemo(() => {
    const source = products.length > 0 ? products : featuredSource;
    if (selectedCategory) {
      return source;
    }
    const curated = source.filter((product) => product.isFeatured || product.isOffer);
    const list = curated.length > 0 ? curated : source;
    return list;
  }, [products, featuredSource, selectedCategory]);

  const filteredCatalog = useMemo(() => {
    return [...catalogSource]
      .filter((product) => {
      if (!matchesSelectedCategory(product)) {
        return false;
      }
      return matchesSearch(product);
      })
      .sort(selectedCategory ? compareByNewest : compareByCategoryThenName);
  }, [catalogSource, searchTokens, selectedCategory, categoryRank, productSearchIndex, productCategoryIndex]);

  const newestIds = useMemo(() => {
    return new Set(products.slice(0, 6).map((product) => product.id));
  }, [products]);

  const applyBadge = (product: Product, context: "top" | "catalog" | "featured" | "offer") => {
    let badge: string | undefined;
    if (context === "top") {
      badge = "Recomendado";
    } else if (context === "offer") {
      badge = product.flashOffer ? "Relampago" : "Oferta";
    } else if ((product.stock ?? 0) > 0 && (product.stock ?? 0) <= 3) {
      badge = "Stock bajo";
    } else if (newestIds.has(product.id)) {
      badge = "Nuevo";
    } else if (product.isOffer) {
      badge = "Oferta";
    } else if (product.isRecommended) {
      badge = "Recomendado";
    } else if (product.isFeatured) {
      badge = product.badge ?? "Destacado";
    } else {
      badge = product.badge;
    }
    return { ...product, badge };
  };

  const newArrivals = useMemo(() => {
    const source = products.length > 0 ? products : featuredSource;
    const now = Date.now();
    const available = [...source]
      .filter((product) => (product.stock ?? 0) > 0)
      .sort((a, b) => {
        const pinnedScore = (product: Product) =>
          Number(Boolean(product.isFeatured)) * 3 + Number(isPinnedNewArrival(product, now));
        const pinnedDelta = pinnedScore(b) - pinnedScore(a);
        if (pinnedDelta !== 0) {
          return pinnedDelta;
        }
        return compareByNewest(a, b);
      });
    if (!selectedCategory) {
      return available.slice(0, HOME_SECTION_CARD_LIMIT);
    }
    const normalizedCategory = normalizeLabel(selectedCategory);
    return available
      .filter((product) => normalizeLabel(product.category) === normalizedCategory)
      .slice(0, HOME_SECTION_CARD_LIMIT);
  }, [products, featuredSource, selectedCategory]);

  const weeklyOffers = useMemo(() => {
    const source = products.length > 0 ? products : featuredSource;
    const offers = source
      .filter((product) => {
        if ((product.stock ?? 0) <= 0) {
          return false;
        }
        return product.isOffer || hasDiscountedPrice(product) || getFlashOfferTimeLeft(product) > 0;
      })
      .sort((a, b) => {
        const flashDelta = Number(getFlashOfferTimeLeft(b) > 0) - Number(getFlashOfferTimeLeft(a) > 0);
        if (flashDelta !== 0) {
          return flashDelta;
        }
        const discountA = Math.max(0, Number(a.originalPrice || 0) - Number(a.price || 0));
        const discountB = Math.max(0, Number(b.originalPrice || 0) - Number(b.price || 0));
        if (discountB !== discountA) {
          return discountB - discountA;
        }
        return compareByNewest(a, b);
      });
    if (offers.length > 0) {
      return offers.slice(0, HOME_SECTION_CARD_LIMIT);
    }
    return [...source]
      .filter((product) => (product.stock ?? 0) > 0)
      .sort((a, b) => (a.price ?? 0) - (b.price ?? 0))
      .slice(0, HOME_SECTION_CARD_LIMIT);
  }, [products, featuredSource]);

  const discountedProducts = useMemo(() => {
    const source = products.length > 0 ? products : featuredSource;
    return [...source]
      .filter((product) => (product.stock ?? 0) > 0 && hasDiscountedPrice(product))
      .sort((a, b) => {
        const discountA = Math.max(0, Number(a.originalPrice || 0) - Number(a.price || 0));
        const discountB = Math.max(0, Number(b.originalPrice || 0) - Number(b.price || 0));
        if (discountB !== discountA) {
          return discountB - discountA;
        }
        return compareByNewest(a, b);
      })
      .slice(0, HOME_SECTION_CARD_LIMIT);
  }, [products, featuredSource]);

  const flashOfferProducts = useMemo(() => {
    const source = products.length > 0 ? products : featuredSource;
    return [...source]
      .filter((product) => (product.stock ?? 0) > 0 && getFlashOfferTimeLeft(product) > 0)
      .sort((a, b) => getFlashOfferTimeLeft(a) - getFlashOfferTimeLeft(b))
      .slice(0, 2);
  }, [products, featuredSource]);

  const filteredWeeklyOffers = useMemo(() => {
    return weeklyOffers.filter((product) => {
      if (!matchesSelectedCategory(product)) {
        return false;
      }
      return matchesSearch(product);
    });
  }, [weeklyOffers, searchTokens, selectedCategory, productSearchIndex, productCategoryIndex]);

  const filteredDiscountedProducts = useMemo(() => {
    return discountedProducts.filter((product) => {
      if (!matchesSelectedCategory(product)) {
        return false;
      }
      return matchesSearch(product);
    });
  }, [discountedProducts, searchTokens, selectedCategory, productSearchIndex, productCategoryIndex]);

  const showStockNoticeMessage = (message: string) => {
    setStockNotice(message);
    if (stockNoticeTimer.current) {
      window.clearTimeout(stockNoticeTimer.current);
    }
    stockNoticeTimer.current = window.setTimeout(() => {
      setStockNotice(null);
    }, 2500);
  };

  useEffect(() => {
    if (!cartHydrated.current || products.length === 0) {
      return;
    }
    const liveProducts = new Map(products.map((product) => [product.id, product] as const));
    setCart((prev) => {
      const entries = Object.entries(prev);
      if (entries.length === 0) {
        return prev;
      }
      let changed = false;
      const next: Record<number, CartItem> = {};
      entries.forEach(([idRaw, entry]) => {
        const id = Number(idRaw);
        const live = liveProducts.get(id);
        if (!live) {
          next[id] = entry;
          return;
        }
        const stock = Number.isFinite(live.stock) ? Number(live.stock) : 0;
        if (stock <= 0) {
          changed = true;
          return;
        }
        const qty = Math.min(entry.qty, stock);
        if (qty <= 0) {
          changed = true;
          return;
        }
        if (entry.product !== live || entry.qty !== qty) {
          changed = true;
        }
        next[id] = { product: live, qty };
      });
      return changed ? next : prev;
    });
  }, [products]);

  const addItem = (product: Product) => {
    setCart((prev) => {
      const current = prev[product.id];
      const stock = Number.isFinite(product.stock) ? Number(product.stock) : 0;
      if (stock <= 0) {
        showStockNoticeMessage(`${product.name} no tiene stock disponible.`);
        return prev;
      }
      const nextQty = current ? current.qty + 1 : 1;
      const qty = Math.min(nextQty, stock);
      if (current && current.qty >= stock) {
        showStockNoticeMessage(`Maximo disponible para ${product.name}: ${stock}.`);
        return prev;
      }
      if (qty <= 0) {
        return prev;
      }
      setCartNotice(`${product.name} agregado al carrito.`);
      if (cartNoticeTimer.current) {
        window.clearTimeout(cartNoticeTimer.current);
      }
      cartNoticeTimer.current = window.setTimeout(() => {
        setCartNotice(null);
      }, 2200);
      return { ...prev, [product.id]: { product, qty } };
    });
  };

  const updateQty = (id: number, delta: number) => {
    setCart((prev) => {
      const current = prev[id];
      if (!current) {
        return prev;
      }
      const stock = Number.isFinite(current.product.stock)
        ? Number(current.product.stock)
        : 0;
      if (delta > 0 && stock <= 0) {
        showStockNoticeMessage(`${current.product.name} no tiene stock disponible.`);
        const next = { ...prev };
        delete next[id];
        return next;
      }
      const nextQty = Math.min(current.qty + delta, stock);
      if (delta > 0 && current.qty >= stock) {
        showStockNoticeMessage(`Maximo disponible para ${current.product.name}: ${stock}.`);
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

  const handleCheckout = async () => {
    if (cartItems.length === 0) {
      setOrderStatus("error");
      setOrderMessage("Agrega productos antes de iniciar el pedido.");
      return;
    }
    if (!orderName.trim() || !orderPhone.trim()) {
      setOrderStatus("error");
      setOrderMessage("Completa nombre y telefono para continuar.");
      return;
    }
    setOrderStatus("submitting");
    setOrderMessage(null);
    try {
      const baseUrl = productsApiBase || getApiBaseUrl();
      const orderSecret = getOrderSecret();
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
            ? "Sistema en mantenimiento. Intenta mas tarde."
            : "No se pudo generar el pedido. Intenta nuevamente.");
        setOrderStatus("error");
        setOrderMessage(message);
        return;
      }
      const data = (await response.json()) as { id: number; total: number };
      await refreshProducts();
      setCart({});
      setOrderName("");
      setOrderPhone("");
      setOrderEmail("");
      setOrderNotes("");
      setOrderStatus("success");
        const firstName = orderName.trim().split(/\s+/)[0] || orderName.trim();
        setOrderMessage(
          `Gracias ${firstName} por confiar en Usb-Shop. Tu pedido tiene prioridad para el envio.`
        );
    } catch {
      setOrderStatus("error");
      setOrderMessage("No se pudo generar el pedido. Intenta nuevamente.");
    }
  };

  const featuredWindow = useMemo(() => {
    if (filteredFeatured.length <= 4) {
      return filteredFeatured;
    }
    const start = featuredIndex % filteredFeatured.length;
    return Array.from({ length: 4 }, (_, idx) => {
      const pos = (start + idx) % filteredFeatured.length;
      return filteredFeatured[pos];
    });
  }, [filteredFeatured, featuredIndex]);
  const catalogWithoutFeatured = useMemo(() => {
    if (isSearching || selectedCategory) {
      return filteredCatalog;
    }
    const featuredIds = new Set(featuredWindow.map((product) => product.id));
    if (featuredIds.size === 0) {
      return filteredCatalog;
    }
    return filteredCatalog.filter((product) => !featuredIds.has(product.id));
  }, [filteredCatalog, featuredWindow, isSearching, selectedCategory]);
  const visibleCatalog = useMemo(
    () => catalogWithoutFeatured.slice(0, catalogLimit),
    [catalogWithoutFeatured, catalogLimit]
  );

  const toggleFeatured = async (product: Product) => {
    if (isPublic) {
      return;
    }
    const nextValue = !product.isFeatured;
    const baseUrl = productsApiBase || getApiBaseUrl();
    await fetch(`${baseUrl}/products/${product.id}/featured`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_featured: nextValue }),
    });
    try {
      const [featuredData, productsData] = await Promise.all([
        fetchWithRetry<Product[]>("/featured?limit=6"),
        fetchProductsPage(0),
      ]);
      applyFeaturedResult(featuredData);
      applyProductsResult(productsData);
    } catch {
      setProducts((prev) =>
        prev.map((item) =>
          item.id === product.id ? { ...item, isFeatured: nextValue } : item
        )
      );
    }
  };

  const requestAdminAccess = () => {
    setEditMode((value) => !value);
  };

  const showCategoryStripBeforeProducts = !isMobileLayout || isSearching || Boolean(selectedCategory);
  const categoryStrip = (
    <div className="category-strip category-strip--hero" id="category-strip">
      <div className="category-strip-header">
        <div className="category-strip-title">Rubros</div>
        <div className="category-strip-meta">
          {availableCategories.length + 1} filtros para explorar mas rapido
        </div>
      </div>
      <div className="category-strip-list">
        <button
          type="button"
          className={`category-chip ${selectedCategory ? "" : "is-active"}`}
          onClick={() => handleCategorySelect(null)}
        >
          Todas
        </button>
        {availableCategories.map((category) => (
          <button
            key={category}
            type="button"
            className={`category-chip ${selectedCategory === category ? "is-active" : ""}`}
            onClick={() => handleCategorySelect(category)}
          >
            {category}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <main className="page">
      <Navbar cartCount={totalItems} cartTotal={total} onCartClick={handleOpenCart} />
      <a
        className="whatsapp-float"
        href="https://wa.me/542364574765?text=Hola%2C%20quiero%20consultar%20por%20un%20producto"
        target="_blank"
        rel="noreferrer"
        aria-label="Contactar por WhatsApp"
      >
        <svg viewBox="0 0 32 32" role="presentation" aria-hidden="true">
          <path
            d="M16.02 5C9.96 5 5 9.92 5 15.98c0 2.1.56 4.06 1.56 5.76L5 27l5.4-1.5c1.64.9 3.5 1.4 5.62 1.4 6.06 0 11-4.92 11-10.98C27 9.92 22.06 5 16.02 5zm0 19.94c-1.8 0-3.48-.48-4.94-1.34l-.36-.2-3.2.9.86-3.12-.22-.38a8.83 8.83 0 0 1-1.38-4.82c0-4.9 3.98-8.88 8.9-8.88 4.9 0 8.88 3.98 8.88 8.88s-3.98 8.96-8.84 8.96zm4.98-6.68c-.28-.14-1.66-.82-1.92-.92-.26-.1-.46-.14-.66.14-.2.28-.76.92-.94 1.1-.18.2-.34.2-.62.06-.28-.14-1.2-.44-2.28-1.42-.84-.76-1.4-1.7-1.56-1.98-.16-.28-.02-.44.12-.58.12-.12.28-.34.42-.5.14-.16.18-.28.28-.48.1-.2.04-.38-.02-.52-.06-.14-.66-1.6-.9-2.2-.24-.58-.48-.5-.66-.5h-.56c-.2 0-.52.08-.78.38-.26.3-1.02 1-1.02 2.44s1.04 2.84 1.18 3.02c.14.2 2.06 3.14 4.98 4.4.7.3 1.24.48 1.66.62.7.22 1.34.18 1.84.12.56-.08 1.66-.68 1.9-1.34.24-.66.24-1.22.18-1.34-.06-.12-.26-.2-.54-.34z"
            fill="currentColor"
          />
        </svg>
      </a>
      <div className="hero-search hero-search--standalone">
        <input
          type="search"
          placeholder="Buscar productos por nombre o categoria..."
          value={searchQuery}
          onChange={(event) => handleSearchChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              handleSearchSubmit();
            }
          }}
        />
        <button type="button" className="button button--lime" onClick={handleSearchSubmit}>
          Buscar
        </button>
      </div>
      {showCategoryStripBeforeProducts ? categoryStrip : null}

      {!isSearching && !selectedCategory && flashOfferProducts.length > 0 ? (
        <section className="flash-offers">
          {flashOfferProducts.map((product, index) => {
            const campaignLabel = getFlashOfferCampaignLabel(product);
            const discountPercent = getFlashOfferDiscountPercent(product);
            return (
              <article key={`flash-offer-${product.id}`} className="flash-offer">
                <div className="flash-offer__content">
                  <div className="flash-offer__copy">
                    <div className="flash-offer__header">
                      <div className="flash-offer__campaign">
                        <div className="flash-offer__campaign-copy">
                          <p className="section-kicker flash-offer__kicker">{campaignLabel}</p>
                          <span className="flash-offer__campaign-tag">Drop curado</span>
                        </div>
                        <div className="flash-offer__signal">
                          <span className="flash-offer__signal-dot" />
                          <strong>Edicion online</strong>
                        </div>
                      </div>
                      <div className="flash-offer__editorial">
                        <span className="flash-offer__overline">Lanzamiento destacado</span>
                        <h2>{product.name}</h2>
                        <p className="flash-offer__subtitle">
                          Curaduria premium para la campaña actual, con precio de evento, disponibilidad limitada y salida automatica al cierre de la accion.
                        </p>
                      </div>
                      <div className="flash-offer__metaRail" aria-label="Resumen de campaña">
                        <div className="flash-offer__metaPill">
                          <span>Categoria</span>
                          <strong>{product.category}</strong>
                        </div>
                        <div className="flash-offer__metaPill">
                          <span>Ahorro</span>
                          <strong>{discountPercent > 0 ? `${discountPercent}%` : "Exclusivo"}</strong>
                        </div>
                        <div className="flash-offer__metaPill">
                          <span>Stock</span>
                          <strong>{product.stock && product.stock > 0 ? `${product.stock} unidades` : "Disponible"}</strong>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="flash-offer__price" aria-label="Precio de oferta">
                    {product.originalPrice && product.originalPrice > product.price ? (
                      <span>${product.originalPrice.toLocaleString("es-AR")}</span>
                    ) : null}
                    <strong>${product.price.toLocaleString("es-AR")}</strong>
                  </div>
                  <FlashOfferTimer product={product} />
                  <button
                    type="button"
                    className="button button--lime flash-offer__button"
                    onClick={() => addItem(product)}
                  >
                    Agregar oferta
                  </button>
                </div>
                <ProductCard
                  product={{ ...applyBadge(product, "offer"), badge: "Relampago" }}
                  imageRefreshKey={imageRefreshKey}
                  imagePriority={getCardImagePriority(index)}
                  inCart={cart[product.id]?.qty ?? 0}
                  onAdd={() => addItem(product)}
                  onView={() => handleOpenQuickView(product)}
                />
              </article>
            );
          })}
        </section>
      ) : null}

      {!isSearching && !selectedCategory ? (
      <section id="novedades" className="section">
        <div className="section-header">
          <div>
            <p className="section-kicker">Novedades</p>
            <h2 className="section-title">
              {selectedCategory ? `Lo nuevo en ${selectedCategory}` : "Ultimos ingresos"}
            </h2>
          </div>
          {!isSearching && !selectedCategory ? (
            <button
              type="button"
              className="button button--ghost"
              onClick={handleViewFullCatalog}
            >
              Ver catalogo completo
            </button>
          ) : null}
        </div>
        <div className="product-grid stagger">
          {newArrivals.length > 0 ? (
            newArrivals.map((product, index) => (
              <ProductCard
                key={`new-${product.id}`}
                product={applyBadge(product, "catalog")}
                imageRefreshKey={imageRefreshKey}
                imagePriority={getCardImagePriority(index)}
                inCart={cart[product.id]?.qty ?? 0}
                onAdd={() => addItem(product)}
                onView={() => handleOpenQuickView(product)}
                style={{ "--delay": getStaggerDelay(index) } as React.CSSProperties}
              />
            ))
          ) : isLoadingProducts ? (
            skeletonCards.slice(0, 4).map((card) => (
              <div key={`new-skeleton-${card}`} className="product-card product-skeleton" />
            ))
          ) : (
            <div className="empty-state empty-state--wide">
              No hay novedades disponibles por el momento.
            </div>
          )}
        </div>
      </section>
      ) : null}

      {!isSearching && !selectedCategory && (isLoadingProducts || filteredDiscountedProducts.length > 1) ? (
        <section id="bajaron-de-precio" className="section">
          <div className="section-header">
            <div>
              <p className="section-kicker">Bajaron de precio</p>
              <h2 className="section-title">Productos con precio actualizado</h2>
            </div>
            <a className="button button--ghost" href="#catalogo">
              Ver catalogo completo
            </a>
          </div>
          <div className="product-grid stagger">
            {filteredDiscountedProducts.length > 0 ? (
              filteredDiscountedProducts.map((product, index) => (
                <ProductCard
                  key={`discount-${product.id}`}
                  product={{
                    ...applyBadge(product, "offer"),
                    badge: product.flashOffer ? "Relampago" : "Bajo de precio",
                  }}
                  imageRefreshKey={imageRefreshKey}
                  imagePriority={getCardImagePriority(index)}
                  inCart={cart[product.id]?.qty ?? 0}
                  onAdd={() => addItem(product)}
                  onView={() => handleOpenQuickView(product)}
                  style={{ "--delay": getStaggerDelay(index) } as React.CSSProperties}
                />
              ))
            ) : isLoadingProducts ? (
              skeletonCards.slice(0, 4).map((card) => (
                <div key={`discount-skeleton-${card}`} className="product-card product-skeleton" />
              ))
            ) : null}
          </div>
        </section>
      ) : null}

      {!showCategoryStripBeforeProducts ? categoryStrip : null}

      {!isSearching && !selectedCategory && (
        <section id="ofertas" className="section">
        <div className="section-header">
          <div>
            <p className="section-kicker">Ofertas</p>
            <h2 className="section-title">Ofertas para aprovechar ahora</h2>
          </div>
          <a className="button button--ghost" href="#catalogo">
            Ver mas productos
          </a>
        </div>
        <div className="product-grid stagger">
          {filteredWeeklyOffers.length > 0 ? (
            filteredWeeklyOffers.map((product, index) => (
              <ProductCard
                key={`offer-${product.id}`}
                product={applyBadge(product, "offer")}
                imageRefreshKey={imageRefreshKey}
                imagePriority={getCardImagePriority(index)}
                inCart={cart[product.id]?.qty ?? 0}
                onAdd={() => addItem(product)}
                onView={() => handleOpenQuickView(product)}
                style={{ "--delay": getStaggerDelay(index) } as React.CSSProperties}
              />
            ))
          ) : isLoadingProducts ? (
            skeletonCards.slice(0, 4).map((card) => (
              <div key={`offer-skeleton-${card}`} className="product-card product-skeleton" />
            ))
          ) : (
            <div className="empty-state empty-state--wide">
              No hay ofertas disponibles por el momento.
            </div>
          )}
        </div>
      </section>
      )}

        <section
          id={selectedCategory ? "selected-category-results" : "destacados"}
          className="section"
        >
          <div className="section-header">
            <div>
              <p className="section-kicker">
                {isSearching
                  ? "Resultados"
                  : selectedCategory
                  ? "Rubro"
                  : "Explorar"}
              </p>
              <h2 className="section-title">
                {isSearching
                  ? `${filteredProducts.length} productos encontrados`
                  : selectedCategory
                  ? `${selectedCategory}: productos disponibles`
                  : "Productos destacados"}
              </h2>
            </div>
            {isSearching ? (
              <button
                className="button button--ghost"
                onClick={() => handleSearchChange("")}
              >
                Limpiar busqueda
              </button>
            ) : selectedCategory ? (
              <button
                type="button"
                className="button button--ghost"
                onClick={handleReturnHome}
              >
                Volver al inicio
              </button>
            ) : (
              <button
                type="button"
                className="button button--ghost"
                onClick={handleViewFullCatalog}
              >
                Ver catalogo completo
              </button>
            )}
          </div>

        <div className="featured-layout">
          <div className="featured-main">
            <div className="featured-grid" id={isSearching ? "resultados" : "featured-grid"}>
              {isSearching ? (
                filteredProducts.length > 0 ? (
                  filteredProducts.map((product, index) => (
                    <ProductCard
                      key={`search-${product.id}`}
                      product={applyBadge(product, "catalog")}
                      imageRefreshKey={imageRefreshKey}
                      imagePriority={getCardImagePriority(index)}
                      inCart={cart[product.id]?.qty ?? 0}
                      onAdd={() => addItem(product)}
                      onView={() => handleOpenQuickView(product)}
                      style={{ "--delay": getStaggerDelay(index) } as React.CSSProperties}
                    />
                  ))
                ) : isLoadingProducts ? (
                  skeletonCards.map((card) => (
                    <div key={`search-skeleton-${card}`} className="product-card product-skeleton" />
                  ))
                ) : (
                  <div className="empty-state empty-state--wide">
                    No hay productos disponibles con esos filtros.
                  </div>
                )
              ) : selectedCategory ? (
                filteredCatalog.length > 0 ? (
                  filteredCatalog.map((product, index) => (
                    <ProductCard
                      key={`category-${product.id}`}
                      product={applyBadge(product, "catalog")}
                      imageRefreshKey={imageRefreshKey}
                      imagePriority={getCardImagePriority(index)}
                      inCart={cart[product.id]?.qty ?? 0}
                      onAdd={() => addItem(product)}
                      onView={() => handleOpenQuickView(product)}
                      style={{ "--delay": getStaggerDelay(index) } as React.CSSProperties}
                    />
                  ))
                ) : isLoadingProducts ? (
                  skeletonCards.map((card) => (
                    <div key={`category-skeleton-${card}`} className="product-card product-skeleton" />
                  ))
                ) : (
                  <div className="empty-state empty-state--wide">
                    No hay productos en esta categoria.
                  </div>
                )
              ) : featuredWindow.length > 0 ? (
                featuredWindow.map((product, index) => (
                  <div
                    key={`${product.id}-${featuredIndex}`}
                    className="featured-fade"
                    style={{ "--delay": getStaggerDelay(index, 0.12, 0.6) } as React.CSSProperties}
                  >
                    <ProductCard
                      product={applyBadge(product, "featured")}
                      imageRefreshKey={imageRefreshKey}
                      imagePriority={getCardImagePriority(index)}
                      inCart={cart[product.id]?.qty ?? 0}
                      onAdd={() => addItem(product)}
                      onView={() => handleOpenQuickView(product)}
                    />
                  </div>
                ))
              ) : isLoadingFeatured ? (
                skeletonCards.slice(0, 4).map((card) => (
                  <div key={`featured-skeleton-${card}`} className="product-card product-skeleton" />
                ))
              ) : (
                <div className="empty-state empty-state--wide">
                  No encontramos productos con ese criterio de busqueda.
                </div>
              )}
            </div>
            {!selectedCategory &&
            (filteredCatalog.length > visibleCatalog.length || hasMoreProducts) ? (
              <div className="section-actions">
                <button
                  type="button"
                  className="button button--ghost"
                  onClick={handleLoadMoreCatalog}
                  disabled={isFetchingMore}
                >
                  {isFetchingMore ? "Cargando mas..." : "Mostrar mas"}
                </button>
              </div>
            ) : null}
          </div>

          {!isMobileLayout ? (
            <aside className="cart-panel" id="carrito">
              <StorefrontCartPanel
                cartItems={cartItems}
                totalItems={totalItems}
                total={total}
                remainingForFreeShipping={remainingForFreeShipping}
                orderName={orderName}
                orderPhone={orderPhone}
                orderEmail={orderEmail}
                orderNotes={orderNotes}
                orderStatus={orderStatus}
                orderMessage={orderMessage}
                stockNotice={stockNotice}
                cartNotice={cartNotice}
                onOrderNameChange={setOrderName}
                onOrderPhoneChange={setOrderPhone}
                onOrderEmailChange={setOrderEmail}
                onOrderNotesChange={setOrderNotes}
                onUpdateQty={updateQty}
                onRemoveItem={removeItem}
                onCheckout={handleCheckout}
              />
            </aside>
          ) : null}
        </div>
        </section>

      {!isSearching && !selectedCategory && showCatalogSection ? (
        <section className="section" id="catalogo">
          <div className="section-header">
            <div>
              <p className="section-kicker">Catalogo</p>
              <h2 className="section-title">Mas productos</h2>
              {selectedCategory ? (
                <p className="hero-text">Filtrando por: {selectedCategory}</p>
              ) : null}
            </div>
          </div>
          <div className="product-grid stagger" id="catalogo-grid">
            {visibleCatalog.length > 0 ? (
              visibleCatalog.map((product, index) => (
                <ProductCard
                  key={product.id}
                  product={applyBadge(product, "catalog")}
                  imageRefreshKey={imageRefreshKey}
                  imagePriority={getCardImagePriority(index)}
                  inCart={cart[product.id]?.qty ?? 0}
                  onAdd={() => addItem(product)}
                  onView={() => handleOpenQuickView(product)}
                  onToggleFeatured={editMode ? () => toggleFeatured(product) : undefined}
                  style={{ "--delay": getStaggerDelay(index) } as React.CSSProperties}
                />
              ))
            ) : isLoadingProducts ? (
              skeletonCards.map((card) => (
                <div key={`catalog-skeleton-${card}`} className="product-card product-skeleton" />
              ))
            ) : (
              <div className="empty-state empty-state--wide">
                No hay destacados u ofertas con esos filtros.
              </div>
            )}
          </div>
          {filteredCatalog.length > visibleCatalog.length || hasMoreProducts ? (
            <div className="section-actions">
              <button
                type="button"
                className="button button--ghost"
                onClick={handleLoadMoreCatalog}
                disabled={isFetchingMore}
              >
                {isFetchingMore ? "Cargando mas..." : "Mostrar mas"}
              </button>
            </div>
          ) : null}
        </section>
      ) : null}

      {isMobileLayout ? (
        <CartDrawer open={isCartOpen} onClose={() => setIsCartOpen(false)}>
          <div className="cart-panel cart-panel--drawer">
            <StorefrontCartPanel
              cartItems={cartItems}
              totalItems={totalItems}
              total={total}
              remainingForFreeShipping={remainingForFreeShipping}
              orderName={orderName}
              orderPhone={orderPhone}
              orderEmail={orderEmail}
              orderNotes={orderNotes}
              orderStatus={orderStatus}
              orderMessage={orderMessage}
              stockNotice={stockNotice}
              cartNotice={cartNotice}
              onOrderNameChange={setOrderName}
              onOrderPhoneChange={setOrderPhone}
              onOrderEmailChange={setOrderEmail}
              onOrderNotesChange={setOrderNotes}
              onUpdateQty={updateQty}
              onRemoveItem={removeItem}
              onCheckout={handleCheckout}
            />
          </div>
        </CartDrawer>
      ) : null}

      {cartItems.length > 0 ? (
        <div className="cart-bar" role="region" aria-label="Resumen de carrito">
          <div className="cart-bar-info">
            <span>{totalItems} {totalItems === 1 ? "producto" : "productos"}</span>
            <strong>${total.toLocaleString("es-AR")}</strong>
          </div>
          <button type="button" className="button button--lime" onClick={handleOpenCart}>
            Ver carrito
          </button>
        </div>
      ) : null}

      {quickView ? (
        <div className="modal-backdrop" onClick={handleCloseQuickView}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label={`Detalle de ${quickView.name}`}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="modal-close"
              onClick={handleCloseQuickView}
              aria-label="Cerrar"
            >
              x
            </button>
            <div className="modal-media">
              {quickViewImages[quickViewImageIndex] && !quickViewImageFailed ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={quickViewImages[quickViewImageIndex]}
                    alt={quickView.name}
                    className="modal-media-image"
                    onDoubleClick={handleOpenExpandedQuickViewImage}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        handleOpenExpandedQuickViewImage();
                      }
                    }}
                    onError={() => setQuickViewImageFailed(true)}
                    role="button"
                    tabIndex={0}
                    aria-label={`Abrir imagen completa de ${quickView.name}`}
                  />
                  <span className="modal-zoom-hint">
                    Doble click para ampliar
                  </span>
                  {quickViewImages.length > 1 ? (
                    <>
                      <button
                        type="button"
                        className="modal-arrow modal-arrow--prev"
                        onClick={showPreviousQuickViewImage}
                        aria-label="Imagen anterior"
                      >
                        {"<"}
                      </button>
                      <button
                        type="button"
                        className="modal-arrow modal-arrow--next"
                        onClick={showNextQuickViewImage}
                        aria-label="Imagen siguiente"
                      >
                        {">"}
                      </button>
                      <div className="modal-thumbs">
                        {quickViewImages.map((imageUrl, index) => (
                          <button
                            key={`${quickView.id}-quick-image-${index}`}
                            type="button"
                            className={`modal-thumb${index === quickViewImageIndex ? ' is-active' : ''}`}
                            onClick={() => {
                              setQuickViewImageIndex(index);
                              setQuickViewImageFailed(false);
                            }}
                            aria-label={`Ver imagen ${index + 1}`}
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={imageUrl} alt={`${quickView.name} ${index + 1}`} />
                          </button>
                        ))}
                      </div>
                    </>
                  ) : null}
                </>
              ) : (
                <div className="modal-placeholder">
                  <div className="modal-placeholder-icon">
                    {getProductPlaceholderLabel(quickView.category || quickView.name)}
                  </div>
                  <div className="modal-placeholder-title">{quickView.name}</div>
                  <div className="modal-placeholder-meta">
                    {quickView.category || "Producto sin foto"}
                  </div>
                </div>
              )}
            </div>
            <div className="modal-content">
              <div className="modal-meta">
                <span>{quickView.category}</span>
                <span>{quickView.stock && quickView.stock > 0 ? `Stock: ${quickView.stock}` : "Consultar stock"}</span>
              </div>
              <h3 className="modal-title">{quickView.name}</h3>
              <p className="modal-price">${quickView.price.toLocaleString("es-AR")}</p>
              <p className="modal-stock">
                {quickView.stock && quickView.stock > 0
                  ? `Stock disponible: ${quickView.stock}`
                  : "Consultar stock disponible"}
              </p>
              <div className="modal-actions">
                <button
                  type="button"
                  className="button button--lime"
                  onClick={() => addItem(quickView)}
                  disabled={!quickView.stock || quickView.stock <= 0}
                >
                  {quickView.stock && quickView.stock > 0 ? "Agregar al carrito" : "Sin stock"}
                </button>
                <a
                  className="button button--ghost"
                  href={`https://wa.me/542364574765?text=${encodeURIComponent(
                    `Hola! Quiero consultar por ${quickView.name} (ID ${quickView.id}).`
                  )}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Consultar por WhatsApp
                </a>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {quickView && isQuickViewImageExpanded && quickViewImages[quickViewImageIndex] ? (
        <div className="image-lightbox-backdrop" onClick={handleCloseExpandedQuickViewImage}>
          <div
            className="image-lightbox"
            role="dialog"
            aria-modal="true"
            aria-label={`Imagen ampliada de ${quickView.name}`}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="image-lightbox-close"
              onClick={handleCloseExpandedQuickViewImage}
              aria-label="Cerrar imagen"
            >
              x
            </button>
            {quickViewImages.length > 1 ? (
              <>
                <button
                  type="button"
                  className="modal-arrow modal-arrow--prev"
                  onClick={showPreviousQuickViewImage}
                  aria-label="Imagen anterior"
                >
                  {"<"}
                </button>
                <button
                  type="button"
                  className="modal-arrow modal-arrow--next"
                  onClick={showNextQuickViewImage}
                  aria-label="Imagen siguiente"
                >
                  {">"}
                </button>
              </>
            ) : null}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={quickViewImages[quickViewImageIndex]}
              alt={quickView.name}
              className="image-lightbox-image"
            />
          </div>
        </div>
      ) : null}

    </main>
  );
}
