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
const RETRYABLE_HTTP_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const inFlightGetRequests = new Map<string, Promise<Response>>();
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

const safeDecodeURIComponent = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const normalizeStorageUrl = (value: string) => {
  try {
    const parsed = new URL(value);
    const markerIndex = parsed.pathname.indexOf(storagePublicMarker);
    if (markerIndex === -1) {
      return value;
    }
    const afterMarker = parsed.pathname.slice(markerIndex + storagePublicMarker.length);
    const cleanedRemainder = afterMarker.replace(/%5C/gi, "/").replace(/\\/g, "/").replace(/^\/+/, "");
    if (!cleanedRemainder) {
      return value;
    }
    const parts = cleanedRemainder.split("/").filter(Boolean);
    if (parts.length < 2) {
      return value;
    }
    parsed.pathname = `${storagePublicMarker}${parts
      .map((part) => encodeURIComponent(safeDecodeURIComponent(part)))
      .join("/")}`;
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

const createAbortSignal = (timeoutMs: number, externalSignal?: AbortSignal) => {
  const controller = new AbortController();
  const abortFromExternalSignal = () => controller.abort(externalSignal?.reason);
  const timeoutHandle = setTimeout(() => controller.abort(new DOMException("Request timeout", "AbortError")), timeoutMs);

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason);
    } else {
      externalSignal.addEventListener("abort", abortFromExternalSignal, { once: true });
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeoutHandle);
      if (externalSignal) {
        externalSignal.removeEventListener("abort", abortFromExternalSignal);
      }
    },
  };
};

const fetchWithTimeout = async (url: string, init: RequestInit, timeoutMs: number): Promise<Response> => {
  const { signal, cleanup } = createAbortSignal(timeoutMs, init.signal);
  try {
    return await fetch(url, {
      ...init,
      signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      if (init.signal?.aborted) {
        throw error;
      }
      throw new Error("La API demoro demasiado en responder");
    }
    throw error;
  } finally {
    cleanup();
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
  const method = (init.method || "GET").toUpperCase();
  const canRetry = RETRYABLE_HTTP_METHODS.has(method);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, init, timeoutMs);
      if (response.status < 500 || !canRetry || attempt >= attempts) {
        return response;
      }
      await wait(DEFAULT_API_RETRY_DELAY_MS * attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !canRetry || !isRetryableApiError(error)) {
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
  const method = (init?.method || "GET").toUpperCase();
  const requestInit: RequestInit = {
    ...init,
    credentials: "include",
  };

  // A caller-owned signal must remain isolated, otherwise one cancellation aborts all consumers.
  if (method !== "GET" || requestInit.signal) {
    return fetchWithRetry(
      url,
      requestInit,
      timeoutMs
    );
  }

  const requestKey = JSON.stringify({
    url,
    credentials: requestInit.credentials || "include",
    cache: requestInit.cache || "",
  });
  const existingRequest = inFlightGetRequests.get(requestKey);
  if (existingRequest) {
    const response = await existingRequest;
    return response.clone();
  }

  const requestPromise = fetchWithRetry(
    url,
    requestInit,
    timeoutMs
  );
  inFlightGetRequests.set(requestKey, requestPromise);

  try {
    const response = await requestPromise;
    return response.clone();
  } finally {
    inFlightGetRequests.delete(requestKey);
  }
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

export type OrderPayload = {
  items: Array<{
    product_id: number;
    quantity: number;
    unit_price: number;
  }>;
  customer_name: string;
  customer_phone: string;
  customer_email?: string | null;
  notes?: string | null;
  idempotency_key: string;
};

export type OrderResponse = {
  id: number;
  total: number;
};

export const createOrderIdempotencyKey = () => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `order-${Date.now()}-${Math.random().toString(36).slice(2, 14)}`;
};

export async function fetchProductsByIds<T>(
  ids: number[],
  options?: FetchJsonOptions
): Promise<T[]> {
  const uniqueIds = Array.from(
    new Set(
      ids
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0)
    )
  );
  if (uniqueIds.length === 0) {
    return [];
  }
  const params = new URLSearchParams({
    ids: uniqueIds.join(","),
    limit: String(uniqueIds.length),
  });
  return fetchJson<T[]>(`/products?${params.toString()}`, undefined, options);
}

export async function submitOrder(
  payload: OrderPayload,
  options?: { baseUrl?: string; timeoutMs?: number }
): Promise<OrderResponse> {
  await ensureApiBaseUrl();
  const baseUrl = options?.baseUrl?.trim() || getApiBaseUrl();
  const headers = new Headers({ "Content-Type": "application/json" });
  const orderSecret = getOrderSecret();
  if (orderSecret) {
    headers.set("X-USB-ORDER-SECRET", orderSecret);
  }
  let response: Response;
  try {
    response = await fetchWithRetry(
      `${baseUrl}/orders`,
      {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify(payload),
      },
      options?.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
      1
    );
  } catch (error) {
    throw new Error(
      getFriendlyApiError(error, "No se pudo generar el pedido. Intenta nuevamente.")
    );
  }

  const detail = await response
    .clone()
    .json()
    .catch(() => null) as { detail?: string; id?: number; total?: number } | null;

  if (!response.ok) {
    throw new Error(
      detail?.detail ||
        (response.status === 503
          ? "Sistema en mantenimiento. Intenta mas tarde."
          : "No se pudo generar el pedido. Intenta nuevamente.")
    );
  }

  const data = detail || ((await response.json()) as OrderResponse);
  return {
    id: Number(data.id),
    total: Number(data.total),
  };
}
