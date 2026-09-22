'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ADMIN_SESSION_RECHECK_EVENT, fetchAuthResponse, getFriendlyApiError } from '@/lib/api';

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
const SESSION_REVALIDATE_INTERVAL_MS = 2 * 60 * 1000;
const SESSION_RECOVERY_DELAYS = [5000, 15000, 30000];

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
      isLoading: true,
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

let sessionSnapshot: SessionSnapshot = restoreSnapshot();
let sessionRequest: Promise<AdminUser | null> | null = null;
let lastSessionCheckAt = 0;
let sessionVersion = 0;
let recoveryAttempt = 0;
let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<(snapshot: SessionSnapshot) => void>();

const clearRecoveryTimer = () => {
  if (recoveryTimer) clearTimeout(recoveryTimer);
  recoveryTimer = null;
};

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
  const res = await fetchAuthResponse('/auth/me');

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
  if (sessionRequest) {
    return sessionRequest;
  }

  clearRecoveryTimer();
  const version = sessionVersion;
  const wasVerified = sessionSnapshot.isVerified && Boolean(sessionSnapshot.user);
  updateSnapshot({
    isLoading: sessionSnapshot.user ? false : true,
    error: force ? null : sessionSnapshot.error,
  });
  sessionRequest = (async () => {
    try {
      const user = await fetchSession();
      if (version !== sessionVersion) return sessionSnapshot.user;
      lastSessionCheckAt = Date.now();
      recoveryAttempt = 0;
      updateSnapshot({ user, isLoading: false, error: null, isVerified: true });
      return user;
    } catch (err) {
      if (version !== sessionVersion) return sessionSnapshot.user;
      lastSessionCheckAt = Date.now();
      const fallbackUser = sessionSnapshot.user;
      updateSnapshot({
        user: fallbackUser,
        isLoading: false,
        error: getFriendlyApiError(err, 'Error verificando sesion'),
        // Keep an already verified, mounted editor during a temporary outage.
        // Stored users still require verification on every fresh page load.
        isVerified: wasVerified,
      });
      if (recoveryAttempt < SESSION_RECOVERY_DELAYS.length) {
        recoveryTimer = setTimeout(() => {
          recoveryTimer = null;
          if (version === sessionVersion && listeners.size && navigator.onLine && document.visibilityState === 'visible') {
            void ensureSessionLoaded(true);
          }
        }, SESSION_RECOVERY_DELAYS[recoveryAttempt++]);
      }
      return fallbackUser;
    } finally {
      if (version === sessionVersion) sessionRequest = null;
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
    if (skipInitialCheck) return;
    const recheck = () => { void ensureSessionLoaded(true); };
    window.addEventListener(ADMIN_SESSION_RECHECK_EVENT, recheck);
    return () => window.removeEventListener(ADMIN_SESSION_RECHECK_EVENT, recheck);
  }, [skipInitialCheck]);

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
      if (sessionRequest || (!sessionSnapshot.error && now - lastSessionCheckAt < SESSION_REVALIDATE_INTERVAL_MS)) {
        return;
      }
      void ensureSessionLoaded(true);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        revalidateSession();
      }
    };
    const handleOnline = () => {
      recoveryAttempt = 0;
      void ensureSessionLoaded(true);
    };

    window.addEventListener('focus', revalidateSession);
    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('focus', revalidateSession);
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [skipInitialCheck]);

  const login = useCallback(async (username: string, password: string) => {
    const version = ++sessionVersion;
    sessionRequest = null;
    clearRecoveryTimer();
    updateSnapshot({ isLoading: true, error: null });
    try {
      const res = await fetchAuthResponse(
        '/auth/login',
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        }
      );

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || (res.status >= 500 ? 'El servidor está temporalmente ocupado. Volvé a intentar.' : 'No se pudo iniciar sesión'));
      }

      // Confirm that the browser actually accepted the session cookie.
      const data = await fetchSession();
      if (version !== sessionVersion) return false;
      if (!data) throw new Error('El navegador no pudo mantener la sesión. Abrí https://www.usbshop.com.ar/login en Chrome o Safari y permití las cookies del sitio.');
      lastSessionCheckAt = Date.now();
      recoveryAttempt = 0;
      updateSnapshot({ user: data, isLoading: false, error: null, isVerified: true });
      return true;
    } catch (err) {
      if (version !== sessionVersion) return false;
      const message = getFriendlyApiError(err, 'Error de login');
      updateSnapshot({ user: null, isLoading: false, error: message, isVerified: true });
      return false;
    }
  }, []);

  const logout = useCallback(async () => {
    const version = ++sessionVersion;
    sessionRequest = null;
    clearRecoveryTimer();
    updateSnapshot({ user: null, isLoading: false, error: null, isVerified: true });
    try {
      await fetchAuthResponse('/auth/logout', {
        method: 'POST',
        credentials: 'include',
      });
    } catch (err) {
      console.error('Error during logout:', err);
    } finally {
      if (version === sessionVersion) router.push('/login');
    }
  }, [router]);

  const refreshSession = useCallback(async () => {
    recoveryAttempt = 0;
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
