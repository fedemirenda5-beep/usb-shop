const DEFAULT_API_BASE_URL = (() => {
  if (typeof window !== "undefined") {
    const host = window.location.hostname;
    if (host === "localhost" || host === "127.0.0.1") {
      return process.env.NEXT_PUBLIC_API_BASE_URL || "http://127.0.0.1:8000";
    }
    if (host && host !== "localhost" && host !== "127.0.0.1") {
      return "https://usbshop-api.onrender.com";
    }
  }
  return process.env.NEXT_PUBLIC_API_BASE_URL || "/api";
})();
const DEFAULT_ORDER_SECRET = process.env.NEXT_PUBLIC_ORDER_SECRET || "";
let runtimeApiBaseUrl = DEFAULT_API_BASE_URL;
let runtimeOrderSecret = DEFAULT_ORDER_SECRET;
let runtimeConfigLoaded = false;
let runtimeConfigPromise: Promise<string | null> | null = null;

export const getApiBaseUrl = () => runtimeApiBaseUrl;
export const getOrderSecret = () => runtimeOrderSecret;
export const API_BASE_URL = DEFAULT_API_BASE_URL;

export const setRuntimeApiBaseUrl = (nextBaseUrl: string) => {
  const trimmed = (nextBaseUrl || "").trim();
  if (!trimmed) {
    return;
  }
  runtimeApiBaseUrl = trimmed;
};

export const setRuntimeOrderSecret = (nextSecret: string) => {
  const trimmed = (nextSecret || "").trim();
  if (!trimmed) {
    return;
  }
  runtimeOrderSecret = trimmed;
};

export async function loadRuntimeConfig(): Promise<string | null> {
  if (runtimeConfigLoaded || typeof window === "undefined") {
    return null;
  }
  if (runtimeConfigPromise) {
    return runtimeConfigPromise;
  }
  runtimeConfigPromise = (async () => {
    let shouldMarkLoaded = false;
    try {
      const host = window.location.hostname;
      const response = await fetch("/usbshop-config.json", { cache: "no-store" });
      if (!response.ok) {
        shouldMarkLoaded = true;
        return null;
      }
      const data = (await response.json()) as { apiBaseUrl?: string; orderSecret?: string };
      if (!data || typeof data.apiBaseUrl !== "string") {
        shouldMarkLoaded = true;
        return null;
      }
      const apiBaseUrl = data.apiBaseUrl.trim();
      if (!apiBaseUrl) {
        shouldMarkLoaded = true;
        return null;
      }
      if ((host === "localhost" || host === "127.0.0.1") && /^https?:\/\//i.test(apiBaseUrl)) {
        shouldMarkLoaded = true;
        return runtimeApiBaseUrl;
      }
      setRuntimeApiBaseUrl(apiBaseUrl);
      if (typeof data.orderSecret === "string") {
        setRuntimeOrderSecret(data.orderSecret);
      }
      shouldMarkLoaded = true;
      return apiBaseUrl;
    } catch {
      return null;
    } finally {
      runtimeConfigLoaded = shouldMarkLoaded;
      runtimeConfigPromise = null;
    }
  })();
  return runtimeConfigPromise;
}
export const ORDER_SECRET = DEFAULT_ORDER_SECRET;
export const SYNC_SECRET = process.env.NEXT_PUBLIC_SYNC_SECRET || "";

const httpPattern = /^https?:\/\//i;
const missingColonPattern = /^(https?)(\/\/.+)$/i;
const windowsPathPattern = /^[A-Za-z]:[\\/]/;
const storagePublicMarker = "/storage/v1/object/public/";
const localHttpPattern = /^http:\/\/(localhost|127\.0\.0\.1)([:/]|$)/i;

const extractBasename = (value: string) => {
  const parts = value.split(/[\\/]/);
  return parts.length > 0 ? parts[parts.length - 1] : value;
};

const normalizeStorageUrl = (value: string) => {
  if (!value.includes("%5C")) {
    return value;
  }
  try {
    const parsed = new URL(value);
    const markerIndex = parsed.pathname.indexOf(storagePublicMarker);
    if (markerIndex === -1) {
      return value;
    }
    const afterMarker = parsed.pathname.slice(markerIndex + storagePublicMarker.length);
    const slashIndex = afterMarker.indexOf("/");
    if (slashIndex === -1) {
      return value;
    }
    const bucket = afterMarker.slice(0, slashIndex);
    const rest = afterMarker.slice(slashIndex + 1);
    if (!rest.includes("%5C")) {
      return value;
    }
    const filename = rest.split("%5C").pop();
    if (!filename) {
      return value;
    }
    parsed.pathname = `${storagePublicMarker}${bucket}/${filename}`;
    return parsed.toString();
  } catch {
    return value;
  }
};

const upgradeInsecureUrl = (value: string) => {
  if (value.startsWith("http://") && !localHttpPattern.test(value)) {
    return `https://${value.slice("http://".length)}`;
  }
  return value;
};

export function resolveImageUrl(
  imageUrl?: string | null,
  baseUrl: string = getApiBaseUrl()
): string | null {
  if (!imageUrl) {
    return null;
  }
  const trimmed = imageUrl.trim();
  if (!trimmed) {
    return null;
  }
  const windowsBasename = windowsPathPattern.test(trimmed) ? extractBasename(trimmed) : null;
  const cleaned = windowsBasename ?? trimmed;
  const backslashBasename = cleaned.includes("\\") ? extractBasename(cleaned) : null;
  const normalizedInput = upgradeInsecureUrl(backslashBasename ?? cleaned);
  const missingColonMatch = trimmed.match(missingColonPattern);
  if (missingColonMatch) {
    return `${missingColonMatch[1].toLowerCase()}:${missingColonMatch[2]}`;
  }
  if (httpPattern.test(normalizedInput)) {
    return normalizeStorageUrl(normalizedInput);
  }
  if (!baseUrl) {
    return normalizedInput;
  }
  const normalizedRelative = normalizedInput.includes("%5C")
    ? normalizedInput.split("%5C").pop() || normalizedInput
    : normalizedInput;
  if (normalizedRelative.startsWith("/")) {
    return baseUrl.endsWith("/")
      ? `${baseUrl.slice(0, -1)}${normalizedRelative}`
      : `${baseUrl}${normalizedRelative}`;
  }
  return baseUrl.endsWith("/")
    ? `${baseUrl}${normalizedRelative}`
    : `${baseUrl}/${normalizedRelative}`;
}

export function resolveImageUrls(
  imageUrls?: string[] | null,
  baseUrl: string = getApiBaseUrl()
): string[] {
  if (!Array.isArray(imageUrls)) {
    return [];
  }
  const resolved = imageUrls
    .map((url) => resolveImageUrl(url, baseUrl))
    .filter((url): url is string => Boolean(url));
  return Array.from(new Set(resolved));
}

export async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers || {});
  const hasBody = init?.body !== undefined && init.body !== null;
  const isFormData =
    typeof FormData !== "undefined" && hasBody && init?.body instanceof FormData;
  if (hasBody && !isFormData && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    ...init,
    credentials: "include",
    headers,
  });
  if (!response.ok) {
    throw new Error("API request failed");
  }
  return (await response.json()) as T;
}
