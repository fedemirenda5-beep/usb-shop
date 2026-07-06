'use client';

import { useAdminSession } from '@/hooks/useAdminSession';
import { getApiBaseUrl, loadRuntimeConfig } from '@/lib/api';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ADMIN_LIMITS } from './adminConfig';
import { NAV_MODULES } from './adminModules';
import { canAccessAdminModule } from './adminPermissions';
import styles from './admin.module.css';

interface AdminLayoutProps {
  children: React.ReactNode;
}

type ScannerProductPreview = {
  id: number;
  name: string;
  sku: string;
  barcode?: string | null;
  price: number;
  price_list_1?: number | null;
  stock: number;
  imageUrl?: string | null;
  image_path?: string | null;
};

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
  const [scannerPreviewError, setScannerPreviewError] = useState('');
  const scannerBufferRef = useRef('');
  const scannerTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentModule = getCurrentModule(pathname);
  const visibleModules = NAV_MODULES.filter((module) => canAccessAdminModule(user?.role, module.id));
  const quickMobileModules = visibleModules.slice(0, 4);
  const isGenerateInvoicePage = Boolean(pathname?.startsWith('/admin/generar-comprobante'));

  const clearScannerTimer = () => {
    if (scannerTimeoutRef.current) {
      clearTimeout(scannerTimeoutRef.current);
      scannerTimeoutRef.current = null;
    }
  };

  const resetScannerBuffer = () => {
    scannerBufferRef.current = '';
    clearScannerTimer();
  };

  const isEditableTarget = (target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName;
    return (
      target.isContentEditable ||
      tag === 'INPUT' ||
      tag === 'TEXTAREA' ||
      tag === 'SELECT' ||
      Boolean(target.closest('input, textarea, select, [contenteditable="true"]'))
    );
  };

  const loadScannerProducts = async (rawValue: string) => {
    await loadRuntimeConfig();
    const params = new URLSearchParams({
      q: rawValue.trim(),
      limit: String(ADMIN_LIMITS.scannerLookup),
    });
    const res = await fetch(`${getApiBaseUrl()}/admin/products?${params.toString()}`, {
      credentials: 'include',
    });
    if (!res.ok) {
      throw new Error('No se pudieron cargar los productos para el lector');
    }
    const data = await res.json();
    return Array.isArray(data) ? (data as ScannerProductPreview[]) : [];
  };

  const findScannerProduct = (products: ScannerProductPreview[], rawValue: string) => {
    const normalizedValue = rawValue.trim().toLowerCase();
    if (!normalizedValue) return null;
    return (
      products.find((product) => String(product.barcode || '').trim().toLowerCase() === normalizedValue) ||
      products.find((product) => String(product.sku || '').trim().toLowerCase() === normalizedValue) ||
      products.find((product) => String(product.id) === normalizedValue) ||
      null
    );
  };

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

  useEffect(() => {
    if (!user || isGenerateInvoicePage) {
      resetScannerBuffer();
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      if (isEditableTarget(event.target)) return;

      if (event.key === 'Escape') {
        setScannerPreviewError('');
        resetScannerBuffer();
        return;
      }

      if (event.key === 'Enter') {
        const scannedValue = scannerBufferRef.current.trim();
        resetScannerBuffer();
        if (!scannedValue) return;
        void (async () => {
          try {
            setScannerPreviewError('');
            const products = await loadScannerProducts(scannedValue);
            const matchedProduct = findScannerProduct(products, scannedValue);
            if (!matchedProduct) {
              setScannerPreviewError(`No existe un producto con el codigo "${scannedValue}"`);
              return;
            }
            router.push(`/admin/productos?edit=${matchedProduct.id}`);
          } catch (scanError) {
            setScannerPreviewError(
              scanError instanceof Error ? scanError.message : 'No se pudo resolver el producto escaneado'
            );
          }
        })();
        return;
      }

      if (event.key.length !== 1) return;
      scannerBufferRef.current += event.key;
      clearScannerTimer();
      scannerTimeoutRef.current = setTimeout(() => {
        scannerBufferRef.current = '';
        scannerTimeoutRef.current = null;
      }, 250);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      resetScannerBuffer();
    };
  }, [user, isGenerateInvoicePage, router]);

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
          <div className={styles.contentInner}>
            {scannerPreviewError ? (
              <div className={styles.scannerToastError}>{scannerPreviewError}</div>
            ) : null}
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
