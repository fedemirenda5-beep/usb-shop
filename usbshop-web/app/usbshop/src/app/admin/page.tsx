'use client';

import { useState, useEffect } from 'react';
import { useAdminSession } from '@/hooks/useAdminSession';
import { getApiBaseUrl } from '@/lib/api';
import styles from './dashboard.module.css';

interface DashboardStats {
  products: number;
  pending_orders: number;
  customers: number;
  sales_today: number;
}

export default function AdminDashboard() {
  const { user } = useAdminSession();
  const [stats, setStats] = useState<DashboardStats | null>(null);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const API_BASE = getApiBaseUrl();
        const res = await fetch(`${API_BASE}/admin/stats`, { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          setStats(data);
        }
      } catch (error) {
        console.error("Error fetching admin stats:", error);
      }
    };
    fetchStats();
  }, []);

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
            <p className={styles.statValue}>{stats?.products ?? '--'}</p>
            <span className={styles.statLabel}>Total en catálogo</span>
          </div>
        </div>

        <div className={styles.statCard}>
          <div className={styles.statIcon}>🛒</div>
          <div className={styles.statContent}>
            <h3>Pedidos Pendientes</h3>
            <p className={styles.statValue}>{stats?.pending_orders ?? '--'}</p>
            <span className={styles.statLabel}>Requieren atención</span>
          </div>
        </div>

        <div className={styles.statCard}>
          <div className={styles.statIcon}>👥</div>
          <div className={styles.statContent}>
            <h3>Clientes</h3>
            <p className={styles.statValue}>{stats?.customers ?? '--'}</p>
            <span className={styles.statLabel}>Total registrados</span>
          </div>
        </div>

        <div className={styles.statCard}>
          <div className={styles.statIcon}>💰</div>
          <div className={styles.statContent}>
            <h3>Ventas Today</h3>
            <p className={styles.statValue}>
              {stats ? `$${stats.sales_today.toLocaleString()}` : '--'}
            </p>
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

