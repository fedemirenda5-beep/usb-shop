'use client';

import { useAdminSession } from '@/hooks/useAdminSession';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { NAV_MODULES } from './adminModules';
import styles from './admin.module.css';

interface AdminLayoutProps {
  children: React.ReactNode;
}

export default function AdminLayout({ children }: AdminLayoutProps) {
  const { user, logout, isLoading } = useAdminSession();
  const router = useRouter();
  const pathname = usePathname();
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
          <Link href="/admin" className={styles.brandBlock}>
            <div className={styles.brandLogoFrame}>
              <img src="/logo-small.jpeg" alt="USB Shop" className={styles.brandLogo} />
            </div>
            <div className={styles.brandCopy}>
              <strong>USB Shop</strong>
              <span>Panel Administrativo</span>
            </div>
          </Link>
          <button
            className={styles.closeBtn}
            onClick={() => setSidebarOpen(false)}
            aria-label="Cerrar sidebar"
          >
            ×
          </button>
        </div>

        <nav className={styles.sidebarNav}>
          <Link href="/admin" className={`${styles.navItem} ${pathname === '/admin' ? styles.navItemActive : ''}`}>Dashboard</Link>
          {NAV_MODULES.map((module) => (
            <Link
              key={module.id}
              href={module.href}
              className={`${styles.navItem} ${pathname === module.href ? styles.navItemActive : ''}`}
            >
              {module.navLabel}
            </Link>
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
            ☰
          </button>
          <div className={styles.navbarTitle}>
            <strong>USB Shop</strong>
            <span>Gestión central del negocio</span>
          </div>
          <div className={styles.navbarRight}>
            <div className={styles.userBadge}>
              <span className={styles.userLabel}>Sesión</span>
              <strong className={styles.user}>{user?.username}</strong>
            </div>
          </div>
        </header>

        <main className={styles.content}>
          <div className={styles.contentInner}>{children}</div>
        </main>
      </div>
    </div>
  );
}
