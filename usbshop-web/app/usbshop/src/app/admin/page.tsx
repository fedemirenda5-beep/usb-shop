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

type CachedOverview = {
  summary: Summary;
  savedAt: number;
};

const DASHBOARD_CACHE_KEY = 'usbshop_admin_dashboard_overview_v1';
const DASHBOARD_CACHE_TTL_MS = 5 * 60 * 1000;

const money = (value: number) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(value || 0);

const integer = (value: number) => new Intl.NumberFormat('es-AR').format(value || 0);

const formatDate = (value?: string | null) => {
  return value ? formatArgentinaDate(value) : 'Sin registros';
};

const isValidSummary = (value: unknown): value is Summary => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const summary = value as Partial<Summary>;
  return (
    typeof summary.products === 'number' &&
    typeof summary.active_customers === 'number' &&
    typeof summary.stock_units === 'number' &&
    typeof summary.sales_count === 'number' &&
    typeof summary.sales_total === 'number' &&
    typeof summary.expenses_total === 'number' &&
    typeof summary.cc_open_balance === 'number'
  );
};

const readCachedSummary = (): Summary | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(DASHBOARD_CACHE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as CachedOverview | null;
    if (!parsed || typeof parsed.savedAt !== 'number' || !isValidSummary(parsed.summary)) {
      return null;
    }
    if (Date.now() - parsed.savedAt > DASHBOARD_CACHE_TTL_MS) {
      return null;
    }
    return parsed.summary;
  } catch {
    return null;
  }
};

const persistCachedSummary = (summary: Summary) => {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(
      DASHBOARD_CACHE_KEY,
      JSON.stringify({
        summary,
        savedAt: Date.now(),
      } satisfies CachedOverview)
    );
  } catch {
    return;
  }
};

export default function AdminDashboard() {
  const { user } = useAdminSession();
  const [summary, setSummary] = useState<Summary | null>(() => readCachedSummary());
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
        persistCachedSummary(data.summary);
      } catch (err) {
        setError(getFriendlyApiError(err, 'Error cargando el escritorio'));
      }
    };
    load();
  }, []);

  const sections = useMemo(
    () =>
      ADMIN_MODULES.filter(
        (module) =>
          module.id !== 'dashboard' &&
          module.id !== 'reportes' &&
          module.id !== 'balances' &&
          module.id !== 'productos' &&
          module.id !== 'pedidos' &&
          module.id !== 'vendedores' &&
          module.id !== 'gastos' &&
          module.id !== 'generar-comprobante' &&
          module.id !== 'comprobantes' &&
          module.id !== 'usuarios'
      ).map((module) => {
        switch (module.id) {
          case 'clientes':
            return {
              ...module,
              value: summary ? integer(summary.active_customers) : '...',
              label: 'Solo clientes activos. Ranking, historial y analisis dentro del modulo.',
            };
          case 'cuentas-corrientes':
            return {
              ...module,
              value: summary ? money(summary.cc_open_balance) : '...',
              label: 'Saldos, cobranzas y movimientos del modulo.',
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
