const DEFAULT_API_BASE_URL = (() => {
  if (typeof window !== "undefined") {
    const host = window.location.hostname;
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
  try {
    const response = await fetch("/usbshop-config.json", { cache: "no-store" });
    if (!response.ok) {
      return null;
    }
    const data = (await response.json()) as { apiBaseUrl?: string; orderSecret?: string };
    if (!data || typeof data.apiBaseUrl !== "string") {
      return null;
    }
    const apiBaseUrl = data.apiBaseUrl.trim();
    if (!apiBaseUrl) {
      return null;
    }
    setRuntimeApiBaseUrl(apiBaseUrl);
    if (typeof data.orderSecret === "string") {
      setRuntimeOrderSecret(data.orderSecret);
    }
    runtimeConfigLoaded = true;
    return apiBaseUrl;
  } catch {
    runtimeConfigLoaded = false;
    return null;
  }
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
  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  if (!response.ok) {
    throw new Error("API request failed");
  }
  return (await response.json()) as T;
}
