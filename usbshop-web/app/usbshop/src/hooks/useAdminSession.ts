'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getApiBaseUrl, loadRuntimeConfig } from '@/lib/api';

interface AdminUser {
  username: string;
  role: string;
}

type SessionSnapshot = {
  user: AdminUser | null;
  isLoading: boolean;
  error: string | null;
  isVerified: boolean;
};

const CONFIG_TIMEOUT_MS = 5000;
const SESSION_REQUEST_TIMEOUT_MS = 10000;

const emptySnapshot = (): SessionSnapshot => ({
  user: null,
  isLoading: true,
  error: null,
  isVerified: false,
});

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

let sessionSnapshot: SessionSnapshot = emptySnapshot();
let sessionRequest: Promise<AdminUser | null> | null = null;
const listeners = new Set<(snapshot: SessionSnapshot) => void>();

const emitSnapshot = () => {
  listeners.forEach((listener) => listener(sessionSnapshot));
};

const updateSnapshot = (next: Partial<SessionSnapshot>) => {
  sessionSnapshot = { ...sessionSnapshot, ...next };
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
  await withTimeout(loadRuntimeConfig(), CONFIG_TIMEOUT_MS, 'No se pudo cargar la configuracion');
  const res = await fetchWithTimeout(`${getApiBaseUrl()}/auth/me`, {
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
  if (!force && sessionRequest) {
    return sessionRequest;
  }

  updateSnapshot({
    isLoading: sessionSnapshot.user ? false : true,
    error: null,
    isVerified: false,
  });
  sessionRequest = (async () => {
    try {
      const user = await fetchSession();
      updateSnapshot({ user, isLoading: false, error: null, isVerified: true });
      return user;
    } catch (err) {
      const message = getFriendlySessionError(err, 'Error verificando sesion');
      updateSnapshot({ user: null, isLoading: false, error: message, isVerified: true });
      return null;
    } finally {
      sessionRequest = null;
    }
  })();

  return sessionRequest;
};

export function useAdminSession() {
  const router = useRouter();
  const [state, setState] = useState<SessionSnapshot>(sessionSnapshot);

  useEffect(() => subscribe(setState), []);

  useEffect(() => {
    void ensureSessionLoaded();
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    updateSnapshot({ isLoading: true, error: null });
    try {
      await withTimeout(loadRuntimeConfig(), CONFIG_TIMEOUT_MS, 'No se pudo cargar la configuracion');
      const res = await fetchWithTimeout(`${getApiBaseUrl()}/auth/login`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      }, SESSION_REQUEST_TIMEOUT_MS);

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
      await loadRuntimeConfig();
      await fetch(`${getApiBaseUrl()}/auth/logout`, {
        method: 'POST',
        credentials: 'include',
      });
    } catch (err) {
      console.error('Error during logout:', err);
    } finally {
      sessionSnapshot = { user: null, isLoading: false, error: null, isVerified: true };
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
