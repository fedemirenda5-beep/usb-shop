'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ensureApiBaseUrl, getApiBaseUrl } from '@/lib/api';

interface AdminUser {
  id?: number | null;
  username: string;
  role: string;
}

type SessionSnapshot = {
  user: AdminUser | null;
  isLoading: boolean;
  error: string | null;
  isVerified: boolean;
};

const SESSION_STORAGE_KEY = 'usbshop_admin_session_v1';
const LEGACY_SESSION_STORAGE_KEY = SESSION_STORAGE_KEY;
const SESSION_REQUEST_TIMEOUT_MS = 15000;
const LOGIN_REQUEST_TIMEOUT_MS = 20000;
const SESSION_REVALIDATE_INTERVAL_MS = 2 * 60 * 1000;
const SESSION_REQUEST_ATTEMPTS = 2;
const SESSION_RETRY_DELAY_MS = 700;

const isBrowser = typeof window !== 'undefined';

const readStoredSession = () => {
  if (!isBrowser) {
    return null;
  }
  const localValue = window.localStorage.getItem(SESSION_STORAGE_KEY);
  if (localValue) {
    return localValue;
  }
  return window.sessionStorage.getItem(LEGACY_SESSION_STORAGE_KEY);
};

const restoreSnapshot = (): SessionSnapshot => {
  if (!isBrowser) {
    return {
      user: null,
      isLoading: true,
      error: null,
      isVerified: false,
    };
  }
  try {
    const raw = readStoredSession();
    if (!raw) {
      return {
        user: null,
        isLoading: true,
        error: null,
        isVerified: false,
      };
    }
    const parsed = JSON.parse(raw) as { user?: AdminUser | null } | null;
    const user =
      parsed?.user &&
      (parsed.user.id === undefined || parsed.user.id === null || typeof parsed.user.id === 'number') &&
      typeof parsed.user.username === 'string' &&
      typeof parsed.user.role === 'string'
        ? parsed.user
        : null;
    return {
      user,
      isLoading: user ? false : true,
      error: null,
      isVerified: false,
    };
  } catch {
    return {
      user: null,
      isLoading: true,
      error: null,
      isVerified: false,
    };
  }
};

const getFriendlySessionError = (err: unknown, fallback: string) => {
  if (!(err instanceof Error)) {
    return fallback;
  }
  const message = err.message.trim();
  if (!message) {
    return fallback;
  }
  if (message === 'Failed to fetch' || message.includes('NetworkError')) {
    return 'No se pudo conectar con la API. Revisa la conexion e intenta nuevamente.';
  }
  if (message.includes('timed out') || message.includes('tardo demasiado')) {
    return 'La API demoro demasiado en responder. Intenta nuevamente.';
  }
  return message;
};

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
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('La solicitud tardo demasiado');
    }
    throw err;
  } finally {
    clearTimeout(timeoutHandle);
  }
};

const isRetryableSessionError = (error: unknown) => {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.trim().toLowerCase();
  return (
    message.includes('tardo demasiado') ||
    message.includes('timed out') ||
    message === 'failed to fetch' ||
    message.includes('networkerror')
  );
};

const fetchWithRetry = async (url: string, init: RequestInit, timeoutMs: number): Promise<Response> => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= SESSION_REQUEST_ATTEMPTS; attempt += 1) {
    try {
      return await fetchWithTimeout(url, init, timeoutMs);
    } catch (error) {
      lastError = error;
      if (attempt >= SESSION_REQUEST_ATTEMPTS || !isRetryableSessionError(error)) {
        throw error;
      }
      await wait(SESSION_RETRY_DELAY_MS * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('No se pudo verificar la sesion');
};

let sessionSnapshot: SessionSnapshot = restoreSnapshot();
let sessionRequest: Promise<AdminUser | null> | null = null;
let lastSessionCheckAt = 0;
const listeners = new Set<(snapshot: SessionSnapshot) => void>();

const emitSnapshot = () => {
  listeners.forEach((listener) => listener(sessionSnapshot));
};

const persistSnapshot = (snapshot: SessionSnapshot) => {
  if (!isBrowser) {
    return;
  }
  try {
    if (!snapshot.user) {
      window.localStorage.removeItem(SESSION_STORAGE_KEY);
      window.sessionStorage.removeItem(LEGACY_SESSION_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({
        user: snapshot.user,
      })
    );
    window.sessionStorage.removeItem(LEGACY_SESSION_STORAGE_KEY);
  } catch {
    return;
  }
};

const updateSnapshot = (next: Partial<SessionSnapshot>) => {
  sessionSnapshot = { ...sessionSnapshot, ...next };
  persistSnapshot(sessionSnapshot);
  emitSnapshot();
};

const subscribe = (listener: (snapshot: SessionSnapshot) => void) => {
  listeners.add(listener);
  listener(sessionSnapshot);
  return () => {
    listeners.delete(listener);
  };
};

const fetchSession = async (): Promise<AdminUser | null> => {
  await ensureApiBaseUrl();
  const res = await fetchWithRetry(`${getApiBaseUrl()}/auth/me`, {
    credentials: 'include',
  }, SESSION_REQUEST_TIMEOUT_MS);

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      return null;
    }
    throw new Error('No se pudo verificar la sesion');
  }

  return (await res.json()) as AdminUser;
};

const ensureSessionLoaded = async (force = false): Promise<AdminUser | null> => {
  if (!force && sessionSnapshot.isVerified && !sessionSnapshot.error) {
    return sessionSnapshot.user;
  }
  if (!force && sessionRequest) {
    return sessionRequest;
  }

  updateSnapshot({
    isLoading: sessionSnapshot.user ? false : true,
    error: force ? null : sessionSnapshot.error,
    isVerified: false,
  });
  sessionRequest = (async () => {
    try {
      const user = await fetchSession();
      lastSessionCheckAt = Date.now();
      updateSnapshot({ user, isLoading: false, error: null, isVerified: true });
      return user;
    } catch (err) {
      lastSessionCheckAt = Date.now();
      const message = getFriendlySessionError(err, 'Error verificando sesion');
      const fallbackUser = sessionSnapshot.user;
      updateSnapshot({ user: fallbackUser, isLoading: false, error: message, isVerified: true });
      return fallbackUser;
    } finally {
      sessionRequest = null;
    }
  })();

  return sessionRequest;
};

type UseAdminSessionOptions = {
  skipInitialCheck?: boolean;
};

export function useAdminSession(options?: UseAdminSessionOptions) {
  const router = useRouter();
  const [state, setState] = useState<SessionSnapshot>(sessionSnapshot);
  const skipInitialCheck = options?.skipInitialCheck === true;

  useEffect(() => subscribe(setState), []);

  useEffect(() => {
    if (skipInitialCheck && !sessionSnapshot.user && sessionSnapshot.isLoading) {
      updateSnapshot({ isLoading: false, error: null });
      return;
    }
    if (!skipInitialCheck) {
      void ensureSessionLoaded();
    }
  }, [skipInitialCheck]);

  useEffect(() => {
    if (skipInitialCheck) {
      return;
    }
    if (!isBrowser) {
      return;
    }

    const revalidateSession = () => {
      const now = Date.now();
      if (sessionRequest || now - lastSessionCheckAt < SESSION_REVALIDATE_INTERVAL_MS) {
        return;
      }
      void ensureSessionLoaded(true);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        revalidateSession();
      }
    };

    window.addEventListener('focus', revalidateSession);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('focus', revalidateSession);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [skipInitialCheck]);

  const login = useCallback(async (username: string, password: string) => {
    updateSnapshot({ isLoading: true, error: null });
    try {
      await ensureApiBaseUrl();
      const res = await fetchWithRetry(
        `${getApiBaseUrl()}/auth/login`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        },
        LOGIN_REQUEST_TIMEOUT_MS
      );

      if (!res.ok) {
        const errData = await res.json().catch(() => ({ detail: 'Error desconocido' }));
        throw new Error(errData.detail || 'Credenciales invalidas');
      }

      const data = (await res.json()) as AdminUser;
      updateSnapshot({ user: data, isLoading: false, error: null, isVerified: true });
      return true;
    } catch (err) {
      const message = getFriendlySessionError(err, 'Error de login');
      updateSnapshot({ user: null, isLoading: false, error: message, isVerified: true });
      return false;
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await ensureApiBaseUrl();
      await fetch(`${getApiBaseUrl()}/auth/logout`, {
        method: 'POST',
        credentials: 'include',
      });
    } catch (err) {
      console.error('Error during logout:', err);
    } finally {
      sessionSnapshot = { user: null, isLoading: false, error: null, isVerified: true };
      persistSnapshot(sessionSnapshot);
      emitSnapshot();
      router.push('/login');
    }
  }, [router]);

  const refreshSession = useCallback(async () => {
    return ensureSessionLoaded(true);
  }, []);

  return {
    user: state.user,
    isLoading: state.isLoading,
    error: state.error,
    isVerified: state.isVerified,
    login,
    logout,
    refreshSession,
    isAuthenticated: !!state.user,
  };
}
