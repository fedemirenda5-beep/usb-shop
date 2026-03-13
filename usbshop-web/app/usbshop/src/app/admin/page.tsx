import { notFound } from "next/navigation";

'use client';

import { useAdminSession } from '@/hooks/useAdminSession';
import styles from './dashboard.module.css';

export default function AdminDashboard() {
  const { user } = useAdminSession();

  return (
    <div className={styles.dashboard}>
      <div className={styles.header}>
        <h1>Dashboard</h1>
        <p>Bienvenido, {user?.username}</p>
      </div>

      {/* Stats Cards */}
      <div className={styles.statsGrid}>
        <div className={styles.statCard}>
          <div className={styles.statIcon}>📦</div>
          <div className={styles.statContent}>
            <h3>Productos</h3>
            <p className={styles.statValue}>--</p>
            <span className={styles.statLabel}>Total en catálogo</span>
          </div>
        </div>

        <div className={styles.statCard}>
          <div className={styles.statIcon}>🛒</div>
          <div className={styles.statContent}>
            <h3>Pedidos Pendientes</h3>
            <p className={styles.statValue}>--</p>
            <span className={styles.statLabel}>Requieren atención</span>
          </div>
        </div>

        <div className={styles.statCard}>
          <div className={styles.statIcon}>👥</div>
          <div className={styles.statContent}>
            <h3>Clientes</h3>
            <p className={styles.statValue}>--</p>
            <span className={styles.statLabel}>Total registrados</span>
          </div>
        </div>

        <div className={styles.statCard}>
          <div className={styles.statIcon}>💰</div>
          <div className={styles.statContent}>
            <h3>Ventas Today</h3>
            <p className={styles.statValue}>--</p>
            <span className={styles.statLabel}>Hoy</span>
          </div>
        </div>
      </div>

      {/* Quick Actions */}
      <div className={styles.quickActions}>
        <h2>Accesos Rápidos</h2>
        <div className={styles.actionGrid}>
          <a href="/admin/productos/nueva" className={styles.actionCard}>
            <div className={styles.actionIcon}>➕</div>
            <p>Nuevo Producto</p>
          </a>
          <a href="/admin/pedidos" className={styles.actionCard}>
            <div className={styles.actionIcon}>📋</div>
            <p>Ver Pedidos</p>
          </a>
          <a href="/admin/clientes" className={styles.actionCard}>
            <div className={styles.actionIcon}>👁️</div>
            <p>Gestionar Clientes</p>
          </a>
          <a href="/admin/reportes" className={styles.actionCard}>
            <div className={styles.actionIcon}>📊</div>
            <p>Reportes</p>
          </a>
        </div>
      </div>

      {/* Status Message */}
      <div className={styles.infoBox}>
        <p>
          <strong>Nota:</strong> Este es el panel administrativo de USB Shop. 
          Las funcionalidades están en desarrollo progresivo.
        </p>
      </div>
    </div>
  );
}

