'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAdminSession } from '@/hooks/useAdminSession';
import { fetchApiResponse } from '@/lib/api';
import styles from './login.module.css';

type LoginUserOption = {
  username: string;
  role: string;
};

const LAST_LOGIN_USERNAME_KEY = 'usbshop_last_login_username';

export default function LoginPage() {
  const router = useRouter();
  const { login, isLoading, error } = useAdminSession({ skipInitialCheck: true });
  const [userOptions, setUserOptions] = useState<LoginUserOption[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [localError, setLocalError] = useState('');
  const [targetPath, setTargetPath] = useState('/admin');

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
    if (typeof window === 'undefined' || !username.trim()) {
      return;
    }
    window.localStorage.setItem(LAST_LOGIN_USERNAME_KEY, username.trim());
  }, [username]);

  useEffect(() => {
    const loadUsers = async () => {
      try {
        setUsersLoading(true);
        const res = await fetchApiResponse('/auth/users', { cache: 'no-store' }, 5000);
        if (!res.ok) {
          throw new Error('No se pudo cargar la lista de usuarios');
        }
        const data = (await res.json()) as LoginUserOption[];
        setUserOptions(Array.isArray(data) ? data : []);
        setUsername((current) => {
          if (current) {
            return current;
          }
          if (!Array.isArray(data) || data.length === 0) {
            return '';
          }
          const savedUsername =
            typeof window !== 'undefined' ? window.localStorage.getItem(LAST_LOGIN_USERNAME_KEY)?.trim() || '' : '';
          if (savedUsername && data.some((option) => option.username === savedUsername)) {
            return savedUsername;
          }
          return data.length === 1 ? data[0].username : '';
        });
      } catch (err) {
        if (err instanceof Error) {
          setLocalError(err.message);
        } else {
          setLocalError('No se pudo cargar la lista de usuarios');
        }
      } finally {
        setUsersLoading(false);
      }
    };
    void loadUsers();
  }, []);

  const selectedUser = userOptions.find((option) => option.username === username) || null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError('');

    if (!username.trim()) {
      setLocalError('Selecciona un usuario');
      return;
    }

    if (!password.trim()) {
      setLocalError('Contrasena requerida');
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
          <p>Selecciona el usuario, ingresa la contrasena y confirma con el boton para abrir el panel.</p>
        </div>

        <form onSubmit={handleSubmit} className={styles.form}>
          <div className={styles.field}>
            <label htmlFor="username">Usuario</label>
            <input
              id="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={isLoading}
              className={styles.input}
              placeholder={usersLoading ? 'Cargando usuarios...' : 'Escribe o selecciona un usuario'}
              list="login-user-options"
              autoComplete="username"
            />
            <datalist id="login-user-options">
              {userOptions.map((option) => (
                <option key={option.username} value={option.username}>
                  {option.username}
                </option>
              ))}
            </datalist>
          </div>

          {selectedUser ? (
            <div className={styles.footer}>
              <p>Perfil: {selectedUser.role}</p>
            </div>
          ) : null}

          <div className={styles.field}>
            <label htmlFor="password">Contrasena</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Tu contrasena"
              disabled={isLoading || usersLoading}
              autoComplete="current-password"
              className={styles.input}
            />
          </div>

          {(localError || error) && <div className={styles.error}>{localError || error}</div>}

          <button type="submit" disabled={isLoading || !username.trim()} className={styles.button}>
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
