'use client';

import { useAdminSession } from '@/hooks/useAdminSession';
import styles from './dashboard.module.css';

export default function AdminDashboard() {
  const { user } = useAdminSession();
  const sections = [
    {
      title: 'Productos',
      value: 'Catalogo',
      label: 'Stock, imagenes, costos y precios',
      href: '/admin/productos',
    },
    {
      title: 'Pedidos',
      value: 'Web',
      label: 'Seguimiento de pedidos pendientes',
      href: '/admin/pedidos',
    },
    {
      title: 'Clientes',
      value: 'Cuentas',
      label: 'Alta de clientes y saldo consolidado',
      href: '/admin/clientes',
    },
    {
      title: 'Comprobantes',
      value: 'Emitidos',
      label: 'Facturas, remitos y documentos',
      href: '/admin/comprobantes',
    },
    {
      title: 'Cuentas corrientes',
      value: 'Saldos',
      label: 'Movimientos, aging y balances',
      href: '/admin/cuentas-corrientes',
    },
    {
      title: 'Reportes',
      value: 'Analisis',
      label: 'Resumen general, ventas y top productos',
      href: '/admin/reportes',
    },
  ];

  return (
    <div className={styles.dashboard}>
      <div className={styles.header}>
        <h1>Dashboard</h1>
        <p>Bienvenido, {user?.username}</p>
      </div>

      <div className={styles.statsGrid}>
        {sections.map((section) => (
          <a key={section.href} href={section.href} className={styles.statCard}>
            <div className={styles.statContent}>
              <h3>{section.title}</h3>
              <p className={styles.statValue}>{section.value}</p>
              <span className={styles.statLabel}>{section.label}</span>
            </div>
          </a>
        ))}
      </div>

      <div className={styles.quickActions}>
        <h2>Accesos Rapidos</h2>
        <div className={styles.actionGrid}>
          {sections.map((section) => (
            <a key={`quick-${section.href}`} href={section.href} className={styles.actionCard}>
              <p>{section.title}</p>
            </a>
          ))}
        </div>
      </div>

      <div className={styles.infoBox}>
        <p>
          Este panel ya expone productos, pedidos, clientes, comprobantes, cuentas corrientes
          y reportes. Si no ves algun modulo en produccion, falta publicar el ultimo build.
        </p>
      </div>
    </div>
  );
}
