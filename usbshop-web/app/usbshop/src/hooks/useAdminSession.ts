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
};

const SESSION_STORAGE_KEY = 'usbshop_admin_session_v1';

const isBrowser = typeof window !== 'undefined';

const restoreSnapshot = (): SessionSnapshot => {
  if (!isBrowser) {
    return {
      user: null,
      isLoading: true,
      error: null,
    };
  }
  try {
    const raw = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) {
      return {
        user: null,
        isLoading: true,
        error: null,
      };
    }
    const parsed = JSON.parse(raw) as { user?: AdminUser | null } | null;
    const user =
      parsed?.user &&
      typeof parsed.user.username === 'string' &&
      typeof parsed.user.role === 'string'
        ? parsed.user
        : null;
    return {
      user,
      isLoading: user ? false : true,
      error: null,
    };
  } catch {
    return {
      user: null,
      isLoading: true,
      error: null,
    };
  }
};

const persistSnapshot = (snapshot: SessionSnapshot) => {
  if (!isBrowser) {
    return;
  }
  try {
    if (!snapshot.user) {
      window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
      return;
    }
    window.sessionStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({
        user: snapshot.user,
      })
    );
  } catch {
    return;
  }
};

let sessionSnapshot: SessionSnapshot = restoreSnapshot();
let sessionRequest: Promise<AdminUser | null> | null = null;
const listeners = new Set<(snapshot: SessionSnapshot) => void>();

const emitSnapshot = () => {
  listeners.forEach((listener) => listener(sessionSnapshot));
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
  await loadRuntimeConfig();
  const res = await fetch(`${getApiBaseUrl()}/auth/me`, {
    credentials: 'include',
  });

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      return null;
    }
    throw new Error('No se pudo verificar la sesion');
  }

  return (await res.json()) as AdminUser;
};

const ensureSessionLoaded = async (force = false): Promise<AdminUser | null> => {
  if (!force && sessionSnapshot.user && !sessionSnapshot.error) {
    return sessionSnapshot.user;
  }
  if (!force && sessionRequest) {
    return sessionRequest;
  }

  updateSnapshot({
    isLoading: sessionSnapshot.user ? false : true,
    error: force ? null : sessionSnapshot.error,
  });
  sessionRequest = (async () => {
    try {
      const user = await fetchSession();
      updateSnapshot({ user, isLoading: false, error: null });
      return user;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Error verificando sesion';
      updateSnapshot({ user: null, isLoading: false, error: message });
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
      await loadRuntimeConfig();
      const res = await fetch(`${getApiBaseUrl()}/auth/login`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({ detail: 'Error desconocido' }));
        throw new Error(errData.detail || 'Credenciales invalidas');
      }

      const data = (await res.json()) as AdminUser;
      updateSnapshot({ user: data, isLoading: false, error: null });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Error de login';
      updateSnapshot({ user: null, isLoading: false, error: message });
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
      sessionSnapshot = { user: null, isLoading: false, error: null };
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
    login,
    logout,
    refreshSession,
    isAuthenticated: !!state.user,
  };
}
