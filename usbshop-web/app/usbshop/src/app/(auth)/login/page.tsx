'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAdminSession } from '@/hooks/useAdminSession';
import { getApiBaseUrl, loadRuntimeConfig } from '@/lib/api';
import styles from './login.module.css';

export default function LoginPage() {
  const router = useRouter();
  const { login, isLoading, error, isAuthenticated, user, isVerified } = useAdminSession();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [localError, setLocalError] = useState('');
  const [targetPath, setTargetPath] = useState('/admin');
  const [apiBaseUrl, setApiBaseUrl] = useState('');

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const from = params.get('from');
    if (from && from.startsWith('/admin') && !from.startsWith('//')) {
      setTargetPath(from);
    }
  }, []);

  useEffect(() => {
    const syncApiBaseUrl = async () => {
      try {
        await loadRuntimeConfig();
      } finally {
        setApiBaseUrl(getApiBaseUrl());
      }
    };
    void syncApiBaseUrl();
  }, []);

  useEffect(() => {
    if (isVerified && isAuthenticated && user) {
      router.replace(targetPath);
    }
  }, [isAuthenticated, isVerified, user, router, targetPath]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError('');

    if (!username.trim() || !password.trim()) {
      setLocalError('Usuario y contrasena requeridos');
      return;
    }

    const success = await login(username, password);
    if (success) {
      router.replace(targetPath);
    }
  };

  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <div className={styles.header}>
          <h1>Admin - USB Shop</h1>
          <p>Ingresa tus credenciales para continuar</p>
        </div>

        <form onSubmit={handleSubmit} className={styles.form}>
          <div className={styles.field}>
            <label htmlFor="username">Usuario</label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Tu usuario"
              disabled={isLoading}
              autoComplete="username"
              className={styles.input}
            />
          </div>

          <div className={styles.field}>
            <label htmlFor="password">Contrasena</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Tu contrasena"
              disabled={isLoading}
              autoComplete="current-password"
              className={styles.input}
            />
          </div>

          {(localError || error) && <div className={styles.error}>{localError || error}</div>}

          <button type="submit" disabled={isLoading} className={styles.button}>
            {isLoading ? 'Ingresando...' : 'Ingresar'}
          </button>
        </form>

        <div className={styles.footer}>
          <p>Sistema administrador - USB Shop</p>
          <div className={styles.debugBox}>
            <p><strong>API:</strong> {apiBaseUrl || 'cargando...'}</p>
            <p><strong>Sesion verificada:</strong> {isVerified ? 'si' : 'no'}</p>
            <p><strong>Autenticado:</strong> {isAuthenticated ? 'si' : 'no'}</p>
            <p><strong>Destino:</strong> {targetPath}</p>
            <p><strong>Error:</strong> {localError || error || 'sin error'}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
