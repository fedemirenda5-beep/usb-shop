'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useAdminSession } from '@/hooks/useAdminSession';
import { fetchApiResponse, getFriendlyApiError } from '@/lib/api';
import { formatArgentinaDate } from '@/lib/datetime';
import { ADMIN_MODULES } from './adminModules';
import { canAccessAdminModule, canViewProfitMetrics } from './adminPermissions';
import styles from './dashboard.module.css';

type Summary = {
  products: number;
  active_customers: number;
  stock_units: number;
  sales_count: number;
  sales_total: number;
  estimated_margin: number | null;
  expenses_total: number;
  cc_open_balance: number;
  latest_invoice_at?: string | null;
};

type OverviewResponse = {
  summary: Summary;
};

const money = (value: number) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(value || 0);

const integer = (value: number) => new Intl.NumberFormat('es-AR').format(value || 0);

const formatDate = (value?: string | null) => {
  return value ? formatArgentinaDate(value) : 'Sin registros';
};

export default function AdminDashboard() {
  const { user } = useAdminSession();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const load = async () => {
      try {
        setError('');
        const res = await fetchApiResponse('/admin/reports/overview', {
          cache: 'no-store',
        });
        if (!res.ok) throw new Error('No se pudo cargar el escritorio');
        const data: OverviewResponse = await res.json();
        setSummary(data.summary);
      } catch (err) {
        setError(getFriendlyApiError(err, 'Error cargando el escritorio'));
      }
    };
    load();
  }, []);

  const sections = useMemo(
    () =>
      ADMIN_MODULES.filter((module) => module.id !== 'dashboard' && module.id !== 'reportes' && module.id !== 'balances').map((module) => {
        switch (module.id) {
          case 'productos':
            return {
              ...module,
              value: summary ? integer(summary.products) : '...',
              label: 'Productos activos. Stock y precios dentro del modulo.',
            };
          case 'pedidos':
            return {
              ...module,
              value: 'Web',
              label: 'Seguimiento y gestion de pedidos online.',
            };
          case 'clientes':
            return {
              ...module,
              value: summary ? integer(summary.active_customers) : '...',
              label: 'Solo clientes activos. Ranking, historial y analisis dentro del modulo.',
            };
          case 'vendedores':
            return {
              ...module,
              value: 'Ventas',
              label: 'Comisiones y rendimiento comercial por vendedor.',
            };
          case 'gastos':
            return {
              ...module,
              value: summary ? money(summary.expenses_total) : '...',
              label: 'Gastos operativos registrados en la base actual.',
            };
          case 'generar-comprobante':
            return {
              ...module,
              value: 'Emitir',
              label: 'Alta rapida de comprobantes y notas.',
            };
          case 'comprobantes':
            return {
              ...module,
              value: summary ? integer(summary.sales_count) : '...',
              label: 'Comprobantes emitidos e historial de documentos.',
            };
          case 'cuentas-corrientes':
            return {
              ...module,
              value: summary ? money(summary.cc_open_balance) : '...',
              label: 'Saldos, cobranzas y movimientos del modulo.',
            };
          case 'usuarios':
            return {
              ...module,
              value: 'Acceso',
              label: 'Permisos, claves y administracion del panel.',
            };
          default:
            return {
              ...module,
              value: 'Panel',
              label: module.dashboardLabel,
            };
        }
      }),
    [summary, user?.role]
  );

  const visibleSections = useMemo(
    () => sections.filter((section) => canAccessAdminModule(user?.role, section.id)),
    [sections, user?.role]
  );

  return (
    <div className={styles.dashboard}>
      <div className={styles.header}>
        <div className={styles.headerCopy}>
          <span className={styles.kicker}>Centro de control</span>
          <h1>Escritorio</h1>
          <p>Bienvenido, {user?.username}. El resumen toma datos reales de la base actual y prioriza lo que mas usas en la operacion diaria.</p>
        </div>
        <div className={styles.headerCallout}>
          <span>Vista general</span>
          <strong>{summary ? money(summary.sales_total) : '...'}</strong>
          <p>Ultimo comprobante: {formatDate(summary?.latest_invoice_at)}</p>
        </div>
      </div>

      {error ? <div className={styles.errorBox}>{error}</div> : null}

      {summary ? (
        <section className={styles.heroGrid}>
          <article className={`${styles.heroCard} ${styles.heroCardPrimary}`}>
            <span>Comprobantes emitidos</span>
            <strong>{integer(summary.sales_count)}</strong>
            <p>Ultimo registro: {formatDate(summary.latest_invoice_at)}</p>
          </article>
          <article className={styles.heroCard}>
            <span>Clientes activos</span>
            <strong>{integer(summary.active_customers)}</strong>
            <p>El resto del detalle comercial queda dentro del modulo Clientes.</p>
          </article>
          <article className={styles.heroCard}>
            <span>Productos activos</span>
            <strong>{integer(summary.products)}</strong>
            <p>{integer(summary.stock_units)} unidades disponibles en stock.</p>
          </article>
          {canViewProfitMetrics(user?.role) ? (
            <article className={`${styles.heroCard} ${styles.heroCardAccent}`}>
              <span>Margen general</span>
              <strong>{money(summary.estimated_margin || 0)}</strong>
              <p>Analisis completo en Balances y Reportes.</p>
            </article>
          ) : (
            <article className={`${styles.heroCard} ${styles.heroCardAccent}`}>
              <span>Gastos registrados</span>
              <strong>{money(summary.expenses_total)}</strong>
              <p>Detalle operativo dentro del modulo Gastos.</p>
            </article>
          )}
        </section>
      ) : null}

      <div className={styles.statsGrid}>
        {visibleSections.map((section) => (
          <Link key={section.href} href={section.href} className={styles.statCard}>
            <div className={styles.statContent}>
              <span className={styles.statEyebrow}>Panel</span>
              <h3>{section.title}</h3>
              <p className={styles.statValue}>{section.value}</p>
              <span className={styles.statLabel}>{section.label}</span>
            </div>
            <span className={styles.statAction}>Abrir</span>
          </Link>
        ))}
      </div>
      <div className={styles.infoBox}>
        <p>
          El escritorio queda como resumen corto. El detalle operativo y los analisis viven dentro de
          cada modulo.
        </p>
      </div>
    </div>
  );
}
