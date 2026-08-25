import HomeClient from "./HomeClient";

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

const PRODUCTS_PAGE_SIZE = 24;
const FEATURED_LIMIT = 6;
const SERVER_FETCH_TIMEOUT_MS = 2500;

const getServerApiBaseUrl = () => {
  const envBase = process.env.NEXT_PUBLIC_API_BASE_URL?.trim();
  if (envBase) {
    return envBase.replace(/\/+$/, "");
  }
  return "https://api.usbshop.com.ar";
};

const fetchJson = async <T,>(path: string): Promise<T | null> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SERVER_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${getServerApiBaseUrl()}${path}`, {
      next: { revalidate: 300 },
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
};

export const revalidate = 300;

export default async function Page() {
  const apiBase = getServerApiBaseUrl();
  const [initialProducts, initialFeatured, initialCategories] = await Promise.all([
    fetchJson<Product[]>(`/products?sort=newest&limit=${PRODUCTS_PAGE_SIZE}&offset=0`),
    fetchJson<Product[]>(`/featured?limit=${FEATURED_LIMIT}`),
    fetchJson<Category[]>("/categories"),
  ]);

  return (
    <HomeClient
      initialApiBase={apiBase}
      initialProducts={Array.isArray(initialProducts) ? initialProducts : undefined}
      initialFeatured={Array.isArray(initialFeatured) ? initialFeatured : undefined}
      initialCategories={Array.isArray(initialCategories) ? initialCategories : undefined}
      initialHasMoreProducts={
        Array.isArray(initialProducts) ? initialProducts.length >= PRODUCTS_PAGE_SIZE : undefined
      }
    />
  );
}
