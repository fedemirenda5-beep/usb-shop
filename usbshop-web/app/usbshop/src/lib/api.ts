const isPrivateIpv4Host = (host: string) => {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return false;
  }
  const octets = host.split(".").map((part) => Number(part));
  if (octets.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return false;
  }
  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
};

const isLocalLikeHost = (host: string) =>
  host === "localhost" ||
  host === "127.0.0.1" ||
  host === "::1" ||
  isPrivateIpv4Host(host);

const getLocalApiBaseUrl = (host: string) => {
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    return process.env.NEXT_PUBLIC_API_BASE_URL || "http://127.0.0.1:8000";
  }
  return `http://${host}:8000`;
};

const DEFAULT_API_BASE_URL = (() => {
  if (process.env.NEXT_PUBLIC_API_BASE_URL?.trim()) {
    return process.env.NEXT_PUBLIC_API_BASE_URL.trim();
  }
  if (typeof window !== "undefined") {
    const host = window.location.hostname;
    if (isLocalLikeHost(host)) {
      return getLocalApiBaseUrl(host);
    }
    if (host) {
      return "https://api.usbshop.com.ar";
    }
  }
  return process.env.NEXT_PUBLIC_API_BASE_URL || "/api";
})();
const DEFAULT_ORDER_SECRET = process.env.NEXT_PUBLIC_ORDER_SECRET || "";
const DEFAULT_API_TIMEOUT_MS = 18_000;
const RUNTIME_CONFIG_TIMEOUT_MS = 3_000;
const DEFAULT_API_RETRY_ATTEMPTS = 2;
const DEFAULT_API_RETRY_DELAY_MS = 700;
let runtimeApiBaseUrl = DEFAULT_API_BASE_URL;
let runtimeOrderSecret = DEFAULT_ORDER_SECRET;
let runtimeConfigLoaded = false;
let runtimeConfigPromise: Promise<string | null> | null = null;

const getRuntimeConfigUrl = (): string =>
  typeof window !== "undefined" ? `${window.location.origin}/usbshop-config.json` : "/usbshop-config.json";

export const getApiBaseUrl = () => runtimeApiBaseUrl;
export const getOrderSecret = () => runtimeOrderSecret;
export const API_BASE_URL = DEFAULT_API_BASE_URL;

const hasUsableApiBaseUrl = () => {
  const baseUrl = (runtimeApiBaseUrl || "").trim();
  return Boolean(baseUrl && baseUrl !== "/api");
};

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
  if (process.env.NEXT_PUBLIC_API_BASE_URL?.trim()) {
    const envBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL.trim();
    setRuntimeApiBaseUrl(envBaseUrl);
    runtimeConfigLoaded = true;
    return envBaseUrl;
  }
  if (runtimeConfigPromise) {
    return runtimeConfigPromise;
  }
  runtimeConfigPromise = (async () => {
    try {
      const host = window.location.hostname;
      const configUrl = getRuntimeConfigUrl();
      const controller = new AbortController();
      const timeoutHandle = window.setTimeout(() => controller.abort(), RUNTIME_CONFIG_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(configUrl, { cache: "no-store", signal: controller.signal });
      } finally {
        window.clearTimeout(timeoutHandle);
      }
      if (!response.ok) {
        return null;
      }
      const data = (await response.json()) as {
        apiBaseUrl?: string;
        orderSecret?: string;
        allowAbsoluteApiBaseUrlOnLocalhost?: boolean;
      };
      if (!data || typeof data.apiBaseUrl !== "string") {
        return null;
      }
      const apiBaseUrl = data.apiBaseUrl.trim();
      if (!apiBaseUrl) {
        return null;
      }
      if (
        isLocalLikeHost(host) &&
        /^https?:\/\//i.test(apiBaseUrl) &&
        !data.allowAbsoluteApiBaseUrlOnLocalhost
      ) {
        return runtimeApiBaseUrl;
      }
      setRuntimeApiBaseUrl(apiBaseUrl);
      if (typeof data.orderSecret === "string") {
        setRuntimeOrderSecret(data.orderSecret);
      }
      return apiBaseUrl;
    } catch {
      return null;
    } finally {
      runtimeConfigLoaded = true;
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

const withTimeout = async <T,>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> => {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
};

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const fetchWithTimeout = async (url: string, init: RequestInit, timeoutMs: number): Promise<Response> => {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("La API demoro demasiado en responder");
    }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }
};

const isRetryableApiError = (error: unknown) => {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.trim().toLowerCase();
  return (
    message.includes("demoro demasiado") ||
    message.includes("timed out") ||
    message === "failed to fetch" ||
    message.includes("networkerror")
  );
};

const fetchWithRetry = async (
  url: string,
  init: RequestInit,
  timeoutMs: number,
  attempts = DEFAULT_API_RETRY_ATTEMPTS
): Promise<Response> => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchWithTimeout(url, init, timeoutMs);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryableApiError(error)) {
        throw error;
      }
      await wait(DEFAULT_API_RETRY_DELAY_MS * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("API request failed");
};

export const getFriendlyApiError = (error: unknown, fallback: string): string => {
  if (!(error instanceof Error)) {
    return fallback;
  }
  const message = error.message.trim();
  if (!message) {
    return fallback;
  }
  if (message === "Failed to fetch" || message.includes("NetworkError")) {
    return "No se pudo conectar con la API. Revisa la conexion e intenta nuevamente.";
  }
  if (message.includes("demoro demasiado") || message.includes("timed out")) {
    return "La API demoro demasiado en responder. Intenta nuevamente.";
  }
  return message;
};

export async function ensureApiBaseUrl(timeoutMs = 5000): Promise<void> {
  if (hasUsableApiBaseUrl()) {
    void loadRuntimeConfig();
    return;
  }
  await withTimeout(loadRuntimeConfig(), timeoutMs, "No se pudo cargar la configuracion");
}

export async function fetchApiResponse(path: string, init?: RequestInit, timeoutMs = DEFAULT_API_TIMEOUT_MS): Promise<Response> {
  await ensureApiBaseUrl();
  const url = `${getApiBaseUrl()}${path}`;
  return fetchWithRetry(
    url,
    {
      ...init,
      credentials: "include",
    },
    timeoutMs
  );
}

type FetchJsonOptions = {
  attempts?: number;
  baseUrl?: string;
  timeoutMs?: number;
};

export async function fetchJson<T>(
  path: string,
  init?: RequestInit,
  options?: FetchJsonOptions
): Promise<T> {
  await ensureApiBaseUrl();
  const headers = new Headers(init?.headers || {});
  const hasBody = init?.body !== undefined && init.body !== null;
  const isFormData =
    typeof FormData !== "undefined" && hasBody && init?.body instanceof FormData;
  if (hasBody && !isFormData && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const baseUrl = options?.baseUrl?.trim() || getApiBaseUrl();
  const timeoutMs = options?.timeoutMs ?? DEFAULT_API_TIMEOUT_MS;
  const attempts = options?.attempts ?? DEFAULT_API_RETRY_ATTEMPTS;
  const url = `${baseUrl}${path}`;
  try {
    const response = await fetchWithRetry(url, {
      ...init,
      credentials: "include",
      headers,
    }, timeoutMs, attempts);
    if (!response.ok) {
      throw new Error(`API request failed (${response.status} ${response.statusText}) ${url}`);
    }
    return (await response.json()) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`API request failed: ${url} -> ${message}`);
  }
}
