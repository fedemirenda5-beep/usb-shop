'use client';

import { useAdminSession } from '@/hooks/useAdminSession';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { NAV_MODULES } from './adminModules';
import styles from './admin.module.css';

interface AdminLayoutProps {
  children: React.ReactNode;
}

export default function AdminLayout({ children }: AdminLayoutProps) {
  const { user, logout, isLoading } = useAdminSession();
  const router = useRouter();
  const [sidebarOpen, setSidebarOpen] = useState(true);

  useEffect(() => {
    if (!isLoading && !user) {
      router.push('/login');
    }
  }, [user, isLoading, router]);

  if (isLoading || !user) {
    return (
      <div className={styles.loading}>
        <p>Cargando...</p>
      </div>
    );
  }

  return (
    <div className={styles.adminContainer}>
      <aside className={`${styles.sidebar} ${sidebarOpen ? styles.open : ''}`}>
        <div className={styles.sidebarHeader}>
          <h2>Admin</h2>
          <button
            className={styles.closeBtn}
            onClick={() => setSidebarOpen(false)}
            aria-label="Cerrar sidebar"
          >
            x
          </button>
        </div>

        <nav className={styles.sidebarNav}>
          <a href="/admin" className={styles.navItem}>Dashboard</a>
          {NAV_MODULES.map((module) => (
            <a key={module.id} href={module.href} className={styles.navItem}>
              {module.navLabel}
            </a>
          ))}
        </nav>

        <div className={styles.sidebarFooter}>
          <div className={styles.userInfo}>
            <p className={styles.username}>{user?.username}</p>
            <p className={styles.role}>{user?.role}</p>
          </div>
          <button onClick={logout} className={styles.logoutBtn}>
            Cerrar sesion
          </button>
        </div>
      </aside>

      <div className={styles.main}>
        <header className={styles.navbar}>
          <button
            className={styles.hamburger}
            onClick={() => setSidebarOpen(!sidebarOpen)}
            aria-label="Abrir menu"
          >
            =
          </button>
          <div className={styles.navbarTitle}>USB Shop - Panel Administrativo</div>
          <div className={styles.navbarRight}>
            <span className={styles.user}>{user?.username}</span>
          </div>
        </header>

        <main className={styles.content}>
          <div className={styles.contentInner}>{children}</div>
        </main>
      </div>
    </div>
  );
}
