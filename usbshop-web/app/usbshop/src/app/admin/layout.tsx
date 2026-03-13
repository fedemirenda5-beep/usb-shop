'use client';

import { useAdminSession } from '@/hooks/useAdminSession';
import { useRouter } from 'next/navigation';
import { useState, useEffect } from 'react';
import styles from './admin.module.css';

interface AdminLayoutProps {
  children: React.ReactNode;
}

export default function AdminLayout({ children }: AdminLayoutProps) {
  const { user, logout, isLoading } = useAdminSession();
  const router = useRouter();
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // Redirigir si no está autenticado
  useEffect(() => {
    if (!isLoading && !user) {
      router.push('/(auth)/login');
    }
  }, [user, isLoading, router]);

  if (isLoading || !user) {
    return (
      <div className={styles.loading}>
        <p>Cargando...</p>
      </div>
    );
  }

  const handleLogout = async () => {
    await logout();
  };

  return (
    <div className={styles.adminContainer}>
      {/* Sidebar */}
      <aside className={`${styles.sidebar} ${sidebarOpen ? styles.open : ''}`}>
        <div className={styles.sidebarHeader}>
          <h2>Admin</h2>
          <button 
            className={styles.closeBtn}
            onClick={() => setSidebarOpen(false)}
            aria-label="Cerrar sidebar"
          >
            ✕
          </button>
        </div>

        <nav className={styles.sidebarNav}>
          <a href="/admin" className={styles.navItem}>
            📊 Dashboard
          </a>
          <a href="/admin/productos" className={styles.navItem}>
            📦 Productos
          </a>
          <a href="/admin/pedidos" className={styles.navItem}>
            🛒 Pedidos
          </a>
          <a href="/admin/clientes" className={styles.navItem}>
            👥 Clientes
          </a>
          <a href="/admin/ventas" className={styles.navItem}>
            💰 Ventas
          </a>
          <a href="/admin/compras" className={styles.navItem}>
            📥 Compras
          </a>
          <a href="/admin/reportes" className={styles.navItem}>
            📈 Reportes
          </a>
          <a href="/admin/gastos" className={styles.navItem}>
            💸 Gastos
          </a>
        </nav>

        <div className={styles.sidebarFooter}>
          <div className={styles.userInfo}>
            <p className={styles.username}>{user?.username}</p>
            <p className={styles.role}>{user?.role}</p>
          </div>
          <button 
            onClick={handleLogout}
            className={styles.logoutBtn}
          >
            Cerrar sesión
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <div className={styles.main}>
        {/* Top Navbar */}
        <header className={styles.navbar}>
          <button 
            className={styles.hamburger}
            onClick={() => setSidebarOpen(!sidebarOpen)}
            aria-label="Abrir menu"
          >
            ☰
          </button>
          <div className={styles.navbarTitle}>
            USB Shop - Panel Administrativo
          </div>
          <div className={styles.navbarRight}>
            <span className={styles.user}>{user?.username}</span>
          </div>
        </header>

        {/* Content Area */}
        <main className={styles.content}>
          {children}
        </main>
      </div>
    </div>
  );
}
