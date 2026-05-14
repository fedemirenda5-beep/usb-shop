'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAdminSession } from '@/hooks/useAdminSession';
import styles from './login.module.css';

export default function LoginPage() {
  const router = useRouter();
  const { login, isLoading, error, isAuthenticated, user } = useAdminSession();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [localError, setLocalError] = useState('');

  // Redirigir si ya está autenticado
  useEffect(() => {
    if (isAuthenticated && user) {
      router.replace('/admin');
    }
  }, [isAuthenticated, user, router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError('');

    if (!username.trim() || !password.trim()) {
      setLocalError('Usuario y contraseña requeridos');
      return;
    }

    const success = await login(username, password);
    if (success) {
      router.replace('/admin');
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
            <label htmlFor="password">Contraseña</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Tu contraseña"
              disabled={isLoading}
              autoComplete="current-password"
              className={styles.input}
            />
          </div>

          {(localError || error) && (
            <div className={styles.error}>
              {localError || error}
            </div>
          )}

          <button
            type="submit"
            disabled={isLoading}
            className={styles.button}
          >
            {isLoading ? 'Ingresando...' : 'Ingresar'}
          </button>
        </form>

        <div className={styles.footer}>
          <p>Sistema administrador - USB Shop</p>
        </div>
      </div>
    </div>
  );
}
