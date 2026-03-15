'use client';

import { useCallback, useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getApiBaseUrl, loadRuntimeConfig } from '@/lib/api';

interface AdminUser {
  username: string;
  role: string;
}

export function useAdminSession() {
  const router = useRouter();
  const [user, setUser] = useState<AdminUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Verificar sesión al montar
  useEffect(() => {
    // Verificar si hay sesión activa (cookie)
    verifySessionOnLoad();
  }, []);

  const verifySessionOnLoad = async () => {
    try {
      await loadRuntimeConfig();
      const res = await fetch(`${getApiBaseUrl()}/auth/me`, {
        credentials: 'include'
      });

      if (res.ok) {
        const data = await res.json();
        setUser(data);
        setError(null);
      } else {
        setUser(null);
      }
    } catch (err) {
      console.error('Error verifying session on load:', err);
      setUser(null);
    } finally {
      setIsLoading(false);
    }
  };

  const login = useCallback(async (username: string, password: string) => {
    setIsLoading(true);
    setError(null);
    try {
      await loadRuntimeConfig();
      const res = await fetch(`${getApiBaseUrl()}/auth/login`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({ detail: 'Error desconocido' }));
        throw new Error(errData.detail || 'Credenciales inválidas');
      }

      const data = await res.json();
      
      // No necesitamos guardar token en localStorage, las cookies httponly se manejan automáticamente
      setUser(data);
      
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Error de login';
      setError(message);
      return false;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await loadRuntimeConfig();
      await fetch(`${getApiBaseUrl()}/auth/logout`, {
        method: 'POST',
        credentials: 'include'
      });
    } catch (err) {
      console.error('Error during logout:', err);
    } finally {
      setUser(null);
      router.push('/login');
    }
  }, [router]);

  return {
    user,
    isLoading,
    error,
    login,
    logout,
    isAuthenticated: !!user
  };
}
