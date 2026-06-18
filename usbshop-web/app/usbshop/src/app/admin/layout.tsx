'use client';

import { useAdminSession } from '@/hooks/useAdminSession';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { NAV_MODULES } from './adminModules';
import { canAccessAdminModule } from './adminPermissions';
import styles from './admin.module.css';

interface AdminLayoutProps {
  children: React.ReactNode;
}

const getCurrentModule = (pathname: string | null) => {
  if (!pathname || !pathname.startsWith('/admin')) {
    return null;
  }
  return (
    [...NAV_MODULES]
      .sort((left, right) => right.href.length - left.href.length)
      .find((module) => pathname === module.href || pathname.startsWith(`${module.href}/`)) || null
  );
};

export default function AdminLayout({ children }: AdminLayoutProps) {
  const { user, logout, isLoading, error, refreshSession, isVerified } = useAdminSession();
  const router = useRouter();
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const currentModule = getCurrentModule(pathname);
  const visibleModules = NAV_MODULES.filter((module) => canAccessAdminModule(user?.role, module.id));
  const quickMobileModules = visibleModules.slice(0, 4);

  useEffect(() => {
    if (!isLoading && isVerified && !user && !error) {
      const targetPath =
        typeof window !== 'undefined' && window.location.pathname.startsWith('/admin')
          ? `${window.location.pathname}${window.location.search || ''}`
          : pathname?.startsWith('/admin')
            ? pathname
            : '/admin';
      router.replace(`/login?from=${encodeURIComponent(targetPath)}`);
    }
  }, [user, isLoading, isVerified, error, pathname, router]);

  useEffect(() => {
    if (!user) return;
    const restricted = currentModule && !canAccessAdminModule(user.role, currentModule.id) ? currentModule : null;
    if (restricted) {
      router.replace('/admin');
    }
  }, [pathname, router, user]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    if (window.innerWidth <= 768) {
      setSidebarOpen(false);
    }
  }, [pathname]);

  if (isLoading) {
    return (
      <div className={styles.loading}>
        <p>Cargando...</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className={styles.loading}>
        <p>{error || 'Redirigiendo al login...'}</p>
      </div>
    );
  }

  return (
    <div className={styles.adminContainer}>
      <button
        type="button"
        className={`${styles.sidebarBackdrop} ${sidebarOpen ? styles.sidebarBackdropVisible : ''}`}
        onClick={() => setSidebarOpen(false)}
        aria-label="Cerrar menu"
      />
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
            x
          </button>
        </div>

        <nav className={styles.sidebarNav}>
          <Link
            href="/admin"
            className={`${styles.navItem} ${pathname === '/admin' ? styles.navItemActive : ''}`}
            onClick={() => {
              if (typeof window !== 'undefined' && window.innerWidth <= 768) {
                setSidebarOpen(false);
              }
            }}
          >
            Dashboard
          </Link>
          {visibleModules.map((module) => (
            <Link
              key={module.id}
              href={module.href}
              className={`${styles.navItem} ${
                pathname === module.href || pathname?.startsWith(`${module.href}/`) ? styles.navItemActive : ''
              }`}
              onClick={() => {
                if (typeof window !== 'undefined' && window.innerWidth <= 768) {
                  setSidebarOpen(false);
                }
              }}
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
            <span className={styles.hamburgerIcon} aria-hidden="true">|||</span>
            <span className={styles.hamburgerLabel}>Menu</span>
          </button>
          <div className={styles.navbarTitle}>
            <strong>USB Shop</strong>
            <span>Gestion central del negocio</span>
          </div>
          <div className={styles.navbarRight}>
            {error ? (
              <button type="button" className={styles.hamburger} onClick={() => void refreshSession()}>
                Reintentar sesion
              </button>
            ) : null}
            <div className={styles.userBadge}>
              <span className={styles.userLabel}>Sesion</span>
              <strong className={styles.user}>{user?.username}</strong>
            </div>
          </div>
        </header>

        <div className={styles.mobileAccessBar}>
          <div className={styles.mobileAccessHeader}>
            <div className={styles.mobileAccessCurrent}>
              <span>Panel actual</span>
              <strong>{currentModule?.title ?? 'Dashboard'}</strong>
            </div>
            <button
              type="button"
              className={styles.mobileMenuButton}
              onClick={() => setSidebarOpen(true)}
            >
              Ver menu
            </button>
          </div>
          <div className={styles.mobileQuickNav} aria-label="Accesos rapidos del admin">
            <Link
              href="/admin"
              className={`${styles.mobileQuickLink} ${pathname === '/admin' ? styles.mobileQuickLinkActive : ''}`}
            >
              Dashboard
            </Link>
            {quickMobileModules.map((module) => (
              <Link
                key={module.id}
                href={module.href}
                className={`${styles.mobileQuickLink} ${
                  pathname === module.href || pathname?.startsWith(`${module.href}/`) ? styles.mobileQuickLinkActive : ''
                }`}
              >
                {module.navLabel}
              </Link>
            ))}
          </div>
        </div>

        <main className={styles.content}>
          <div className={styles.contentInner}>{children}</div>
        </main>
      </div>
    </div>
  );
}
