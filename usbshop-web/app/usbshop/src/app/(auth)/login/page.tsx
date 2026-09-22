'use client';

import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useAdminSession } from '@/hooks/useAdminSession';
import { fetchApiResponse } from '@/lib/api';
import styles from './login.module.css';

type LoginUserOption = {
  username: string;
  role: string;
};

const LAST_LOGIN_USERNAME_KEY = 'usbshop_last_login_username';
const LOGIN_USERS_CACHE_KEY = 'usbshop_login_users_v1';

const readPreference = (key: string) => {
  try { return window.localStorage.getItem(key) || ''; } catch { return ''; }
};
const savePreference = (key: string, value: string) => {
  try { window.localStorage.setItem(key, value); } catch { /* Login also works without browser storage. */ }
};

export default function LoginPage() {
  const router = useRouter();
  const { login, error } = useAdminSession({ skipInitialCheck: true });
  const [userOptions, setUserOptions] = useState<LoginUserOption[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [slowConnection, setSlowConnection] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [localError, setLocalError] = useState('');
  const [localNotice, setLocalNotice] = useState('');
  const [hasCachedUsers, setHasCachedUsers] = useState(false);
  const [targetPath, setTargetPath] = useState('/admin');
  const passwordInputRef = useRef<HTMLInputElement | null>(null);

  const applySuggestedUsername = (options: LoginUserOption[], preferredUsername = '') => {
    setUsername((current) => {
      if (current) {
        return current;
      }
      if (preferredUsername && options.some((option) => option.username === preferredUsername)) {
        return preferredUsername;
      }
      if (preferredUsername) {
        return preferredUsername;
      }
      return options.length === 1 ? options[0].username : '';
    });
  };

  const hydrateUserOptions = (options: LoginUserOption[]) => {
    setUserOptions(options);
    setHasCachedUsers(options.length > 0);
    if (typeof window !== 'undefined') {
      savePreference(LOGIN_USERS_CACHE_KEY, JSON.stringify(options));
      const savedUsername = readPreference(LAST_LOGIN_USERNAME_KEY).trim();
      applySuggestedUsername(options, savedUsername);
    } else {
      applySuggestedUsername(options);
    }
  };

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
    savePreference(LAST_LOGIN_USERNAME_KEY, username.trim());
  }, [username]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const savedUsername = readPreference(LAST_LOGIN_USERNAME_KEY).trim();
    if (savedUsername) {
      setUsername((current) => current || savedUsername);
    }
    try {
      const rawCachedUsers = readPreference(LOGIN_USERS_CACHE_KEY);
      if (!rawCachedUsers) {
        return;
      }
      const parsed = JSON.parse(rawCachedUsers) as LoginUserOption[] | null;
      const cachedUsers = Array.isArray(parsed)
        ? parsed.filter(
            (item): item is LoginUserOption =>
              Boolean(item) && typeof item.username === 'string' && typeof item.role === 'string'
          )
        : [];
      if (cachedUsers.length > 0) {
        setUserOptions(cachedUsers);
        setHasCachedUsers(true);
        applySuggestedUsername(cachedUsers, savedUsername);
        setUsersLoading(false);
      }
    } catch {
      return;
    }
  }, []);

  useEffect(() => {
    const loadUsers = async () => {
      try {
        setUsersLoading(true);
        setLocalNotice('');
        const res = await fetchApiResponse('/auth/users', { cache: 'no-store' }, 8000);
        if (!res.ok) {
          throw new Error('No se pudo cargar la lista de usuarios');
        }
        const data = (await res.json()) as LoginUserOption[];
        const nextOptions = Array.isArray(data) ? data : [];
        hydrateUserOptions(nextOptions);
      } catch (err) {
        const fallbackMessage = err instanceof Error ? err.message : 'No se pudo cargar la lista de usuarios';
        const cachedAvailable =
          hasCachedUsers ||
          (typeof window !== 'undefined' && Boolean(readPreference(LOGIN_USERS_CACHE_KEY)));
        if (cachedAvailable) {
          setLocalNotice('Se usó la lista guardada. Puedes continuar con tu nombre de usuario y contraseña.');
        } else {
          setLocalNotice('Podés ingresar escribiendo tu usuario y contraseña aunque la lista de usuarios no haya cargado.');
        }
      } finally {
        setUsersLoading(false);
      }
    };
    void loadUsers();
  }, []);

  const selectedUser = userOptions.find((option) => option.username === username) || null;

  useEffect(() => {
    setSlowConnection(false);
    if (!submitting) return;
    const timer = setTimeout(() => setSlowConnection(true), 6000);
    return () => clearTimeout(timer);
  }, [submitting]);

  const handleUsernameKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') {
      return;
    }
    event.preventDefault();
    passwordInputRef.current?.focus();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) {
      return;
    }
    setLocalError('');
    setLocalNotice('');

    if (!username.trim()) {
      setLocalError('Selecciona un usuario');
      return;
    }

    if (!password.trim()) {
      passwordInputRef.current?.focus();
      return;
    }

    try {
      setSubmitting(true);
      const success = await login(username, password);
      if (success) {
        router.replace(targetPath);
      }
    } finally {
      setSubmitting(false);
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
              name="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={submitting}
              className={styles.input}
              placeholder={usersLoading ? 'Cargando usuarios...' : 'Escribe o selecciona un usuario'}
              list="login-user-options"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="next"
              onKeyDown={handleUsernameKeyDown}
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
              name="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Tu contrasena"
              disabled={submitting}
              autoComplete="current-password"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="done"
              className={styles.input}
              ref={passwordInputRef}
            />
          </div>

          {(localError || error) && <div role="alert" className={styles.error}>{localError || error}</div>}
          {localNotice ? <div className={styles.notice}>{localNotice}</div> : null}
          {submitting && slowConnection && <div role="status" className={styles.notice}>Seguimos intentando conectar. No hace falta volver a tocar Ingresar.</div>}

          <button type="submit" disabled={submitting || !username.trim() || !password.trim()} className={styles.button}>
            {submitting ? 'Ingresando...' : 'Ingresar'}
          </button>

          {!submitting && (localError || localNotice) ? (
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => {
                setLocalError('');
                setLocalNotice('');
                setUsersLoading(true);
                void (async () => {
                  try {
                    const res = await fetchApiResponse('/auth/users', { cache: 'no-store' }, 8000);
                    if (!res.ok) {
                      throw new Error('No se pudo cargar la lista de usuarios');
                    }
                    const data = (await res.json()) as LoginUserOption[];
                    const nextOptions = Array.isArray(data) ? data : [];
                    hydrateUserOptions(nextOptions);
                  } catch (retryError) {
                    setLocalNotice('La lista de usuarios no está disponible. Podés escribir tu usuario y contraseña para ingresar.');
                  } finally {
                    setUsersLoading(false);
                  }
                })();
              }}
            >
              Reintentar carga
            </button>
          ) : null}
        </form>

        <div className={styles.footer}>
          <p>Sistema administrador - USB Shop</p>
        </div>
      </div>
    </div>
  );
}
