const STORAGE_KEY = "usbshop.order-attempt";
const RETRY_WINDOW_MS = 15 * 60 * 1000;
type Attempt = { fingerprint: string; key: string; createdAt: number };
let memoryAttempt: Attempt | null = null;

export function clearOrderAttemptKey(): void {
  memoryAttempt = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage can be unavailable during private browsing or restricted modes.
  }
}

// Shared by both checkouts and retained after a lost response or navigation.
export function getOrderAttemptKey(fingerprint: string, createKey: () => string): string {
  let attempt = memoryAttempt;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) attempt = JSON.parse(stored);
  } catch {
    // Private browsing or unavailable storage still has the in-memory fallback.
  }
  const now = Date.now();
  if (!attempt || attempt.fingerprint !== fingerprint || typeof attempt.key !== "string" ||
      !attempt.key || !Number.isFinite(attempt.createdAt) ||
      now - attempt.createdAt < 0 || now - attempt.createdAt >= RETRY_WINDOW_MS) {
    attempt = { fingerprint, key: createKey(), createdAt: now };
  }
  memoryAttempt = attempt;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(attempt));
  } catch {
    // The server also checks for recent identical orders.
  }
  return attempt.key;
}
