'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAdminSession } from '@/hooks/useAdminSession';
import { getApiBaseUrl, getFriendlyApiError } from '@/lib/api';
import styles from './usuarios.module.css';

type AdminUser = {
  id: number;
  username: string;
  role: string;
  active: boolean;
  created_at?: string | null;
};

type UserFormState = {
  username: string;
  password: string;
  role: 'admin' | 'staff';
  active: boolean;
};

const emptyForm: UserFormState = {
  username: '',
  password: '',
  role: 'staff',
  active: true,
};

const isCurrentSessionUser = (
  target: Pick<AdminUser, 'id' | 'username'>,
  currentUser?: { id?: number | null; username?: string | null } | null
) => {
  if (typeof currentUser?.id === 'number') {
    return target.id === currentUser.id;
  }
  return target.username.trim() === String(currentUser?.username || '').trim();
};

const parseError = async (response: Response, fallback: string) => {
  try {
    const data = (await response.json()) as { detail?: string };
    if (data?.detail?.trim()) {
      return data.detail.trim();
    }
  } catch {
    return fallback;
  }
  return fallback;
};

export default function AdminUsersPage() {
  const { user } = useAdminSession();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<UserFormState>(emptyForm);

  const editingUser = useMemo(
    () => users.find((item) => item.id === editingId) ?? null,
    [editingId, users]
  );

  const loadUsers = async () => {
    try {
      setLoading(true);
      setError('');
      const res = await fetch(`${getApiBaseUrl()}/admin/users`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) {
        throw new Error(await parseError(res, 'No se pudo cargar la lista de usuarios'));
      }
      const data = (await res.json()) as AdminUser[];
      setUsers(data);
    } catch (err) {
      setError(getFriendlyApiError(err, 'No se pudo cargar la lista de usuarios'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadUsers();
  }, []);

  const resetForm = () => {
    setEditingId(null);
    setForm(emptyForm);
    setSuccess('');
    setError('');
  };

  const startEdit = (target: AdminUser) => {
    setEditingId(target.id);
    setForm({
      username: target.username,
      password: '',
      role: target.role === 'admin' ? 'admin' : 'staff',
      active: target.active,
    });
    setSuccess('');
    setError('');
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      setSaving(true);
      setError('');
      setSuccess('');
      const payload: Record<string, unknown> = {
        username: form.username.trim(),
        role: form.role,
        active: form.active,
      };
      if (!editingId || form.password.trim()) {
        payload.password = form.password;
      }
      const endpoint = editingId
        ? `${getApiBaseUrl()}/admin/users/${editingId}`
        : `${getApiBaseUrl()}/admin/users`;
      const method = editingId ? 'PUT' : 'POST';
      const res = await fetch(endpoint, {
        method,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        throw new Error(await parseError(res, 'No se pudo guardar el usuario'));
      }
      await loadUsers();
      setSuccess(editingId ? 'Usuario actualizado.' : 'Usuario creado.');
      if (editingId) {
        setForm((current) => ({ ...current, password: '' }));
      } else {
        setForm(emptyForm);
      }
      setEditingId(null);
    } catch (err) {
      setError(getFriendlyApiError(err, 'No se pudo guardar el usuario'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (target: AdminUser) => {
    const isCurrentUser = isCurrentSessionUser(target, user);
    if (isCurrentUser) {
      setError('No puedes eliminar tu propio usuario.');
      setSuccess('');
      return;
    }
    const confirmed = window.confirm(`Vas a eliminar el usuario "${target.username}". Esta accion no se puede deshacer.`);
    if (!confirmed) {
      return;
    }
    try {
      setDeletingId(target.id);
      setError('');
      setSuccess('');
      const res = await fetch(`${getApiBaseUrl()}/admin/users/${target.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) {
        throw new Error(await parseError(res, 'No se pudo eliminar el usuario'));
      }
      if (editingId === target.id) {
        setEditingId(null);
        setForm(emptyForm);
      }
      await loadUsers();
      setSuccess('Usuario eliminado.');
    } catch (err) {
      setError(getFriendlyApiError(err, 'No se pudo eliminar el usuario'));
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <p className={styles.kicker}>Seguridad</p>
          <h1>Usuarios del panel admin</h1>
          <p className={styles.subtitle}>
            Crea usuarios, actualiza claves y define si cada cuenta entra como <strong>admin</strong> o <strong>staff</strong>.
          </p>
        </div>
        <button type="button" className={styles.secondaryButton} onClick={() => void loadUsers()} disabled={loading || saving}>
          Recargar
        </button>
      </div>

      {error ? <div className={styles.errorBox}>{error}</div> : null}
      {success ? <div className={styles.successBox}>{success}</div> : null}

      <div className={styles.layout}>
        <section className={styles.panel}>
          <div className={styles.panelHeader}>
            <h2>Usuarios actuales</h2>
            <span>{loading ? 'Cargando...' : `${users.length} registrados`}</span>
          </div>

          <div className={styles.userList}>
            {users.map((item) => {
              const isCurrentUser = isCurrentSessionUser(item, user);
              return (
                <article
                  key={item.id}
                  className={`${styles.userCard} ${editingId === item.id ? styles.userCardActive : ''}`}
                >
                  <div className={styles.userCardTop}>
                    <div>
                      <strong>{item.username}</strong>
                      <p>{isCurrentUser ? 'Sesion actual' : 'Usuario del panel'}</p>
                    </div>
                    <span className={`${styles.statusBadge} ${item.active ? styles.statusActive : styles.statusInactive}`}>
                      {item.active ? 'Activo' : 'Inactivo'}
                    </span>
                  </div>
                  <div className={styles.metaRow}>
                    <span className={styles.roleBadge}>{item.role}</span>
                    {isCurrentUser ? <span className={styles.selfBadge}>Tu usuario</span> : null}
                  </div>
                  <div className={styles.cardActions}>
                    <button type="button" className={styles.editButton} onClick={() => startEdit(item)} disabled={saving || deletingId === item.id}>
                      Editar
                    </button>
                    <button
                      type="button"
                      className={styles.deleteButton}
                      onClick={() => void handleDelete(item)}
                      disabled={saving || deletingId === item.id || isCurrentUser}
                      title={isCurrentUser ? 'No puedes eliminar tu propio usuario' : 'Eliminar usuario'}
                    >
                      {deletingId === item.id ? 'Eliminando...' : 'Eliminar'}
                    </button>
                  </div>
                </article>
              );
            })}
            {!loading && users.length === 0 ? <p className={styles.empty}>No hay usuarios cargados.</p> : null}
          </div>
        </section>

        <section className={styles.panel}>
          <div className={styles.panelHeader}>
            <div>
              <h2>{editingUser ? `Editar ${editingUser.username}` : 'Crear usuario'}</h2>
              <span>{editingUser ? 'Si dejas la clave vacia, se mantiene la actual.' : 'Define nombre, clave y rol.'}</span>
            </div>
            {editingUser ? (
              <button type="button" className={styles.secondaryButton} onClick={resetForm} disabled={saving}>
                Nuevo
              </button>
            ) : null}
          </div>

          <form className={styles.form} onSubmit={handleSubmit}>
            <label className={styles.field}>
              <span>Usuario</span>
              <input
                value={form.username}
                onChange={(event) => setForm((current) => ({ ...current, username: event.target.value }))}
                placeholder="Ej. Mariana"
                disabled={saving}
                required
              />
            </label>

            <label className={styles.field}>
              <span>{editingUser ? 'Nueva clave' : 'Clave'}</span>
              <input
                type="password"
                value={form.password}
                onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))}
                placeholder={editingUser ? 'Solo si quieres cambiarla' : 'Clave inicial'}
                disabled={saving}
                required={!editingUser}
              />
            </label>

            <div className={styles.row}>
              <label className={styles.field}>
                <span>Rol</span>
                <select
                  value={form.role}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      role: event.target.value === 'admin' ? 'admin' : 'staff',
                    }))
                  }
                  disabled={saving}
                >
                  <option value="admin">admin</option>
                  <option value="staff">staff</option>
                </select>
              </label>

              <label className={styles.toggle}>
                <input
                  type="checkbox"
                  checked={form.active}
                  onChange={(event) => setForm((current) => ({ ...current, active: event.target.checked }))}
                  disabled={saving}
                />
                <span>Usuario activo</span>
              </label>
            </div>

            <div className={styles.actions}>
              <button type="submit" className={styles.primaryButton} disabled={saving}>
                {saving ? 'Guardando...' : editingUser ? 'Guardar cambios' : 'Crear usuario'}
              </button>
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}
