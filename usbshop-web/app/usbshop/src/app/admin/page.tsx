'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
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

type LowStockItem = {
  id: number;
  name: string;
  stock: number;
  reorder_point: number;
};

type OverviewResponse = {
  summary: Summary;
  low_stock?: LowStockItem[];
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
  const overviewQuery = useQuery({
    queryKey: ['admin', 'reports', 'overview'],
    enabled: Boolean(user),
    placeholderData: () => {
      const summary = readCachedSummary();
      return summary ? { summary } : undefined;
    },
    queryFn: async (): Promise<OverviewResponse> => {
      const res = await fetchApiResponse('/admin/reports/overview', { cache: 'no-store' });
      if (!res.ok) throw new Error('No se pudo cargar el escritorio');
      const data = (await res.json()) as OverviewResponse;
      persistCachedSummary(data.summary);
      return data;
    },
  });
  const summary = overviewQuery.data?.summary ?? null;
  const lowStockCount = overviewQuery.data?.low_stock?.length ?? 0;
  const error = overviewQuery.error
    ? getFriendlyApiError(overviewQuery.error, 'Error cargando el escritorio')
    : '';

  const sections = useMemo(
    () =>
      ADMIN_MODULES.filter((module) =>
        ['pedidos', 'productos', 'clientes', 'cuentas-corrientes', 'comprobantes', 'balances', 'reportes'].includes(module.id)
      ).map((module) => {
        switch (module.id) {
          case 'pedidos':
            return {
              ...module,
              value: summary ? integer(summary.sales_count) : '...',
              label: 'Pedidos/cobranzas registrados y seguimiento de ventas.',
            };
          case 'productos':
            return {
              ...module,
              value: summary ? integer(summary.products) : '...',
              label: 'Stock, costo, precio y productos activos del catálogo.',
            };
          case 'clientes':
            return {
              ...module,
              value: summary ? integer(summary.active_customers) : '...',
              label: 'Clientes con actividad reciente y detalle comercial.',
            };
          case 'cuentas-corrientes':
            return {
              ...module,
              value: summary ? money(summary.cc_open_balance) : '...',
              label: 'Saldo abierto, cobros y movimientos operativos.',
            };
          case 'comprobantes':
            return {
              ...module,
              value: summary ? money(summary.sales_total) : '...',
              label: 'Cierres, comprobantes y facturación del negocio.',
            };
          case 'balances':
            return {
              ...module,
              value: summary ? money(summary.estimated_margin || 0) : '...',
              label: 'Margen real, gastos y resultado operativo completo.',
            };
          case 'reportes':
            return {
              ...module,
              value: lowStockCount ? integer(lowStockCount) : '0',
              label: 'Productos con stock crítico y alertas del catálogo.',
            };
          default:
            return {
              ...module,
              value: 'Panel',
              label: module.dashboardLabel,
            };
        }
      }),
    [summary, lowStockCount, user?.role]
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
            <span>Ventas registradas</span>
            <strong>{money(summary.sales_total)}</strong>
            <p>{integer(summary.sales_count)} comprobantes emitidos. Último: {formatDate(summary.latest_invoice_at)}</p>
          </article>
          <article className={styles.heroCard}>
            <span>Clientes activos</span>
            <strong>{integer(summary.active_customers)}</strong>
            <p>Clientes con actividad relevante para la operación.</p>
          </article>
          <article className={styles.heroCard}>
            <span>Stock crítico</span>
            <strong>{integer(lowStockCount)}</strong>
            <p>{integer(summary.stock_units)} unidades disponibles en total.</p>
          </article>
          {canViewProfitMetrics(user?.role) ? (
            <article className={`${styles.heroCard} ${styles.heroCardAccent}`}>
              <span>Margen estimado</span>
              <strong>{money(summary.estimated_margin || 0)}</strong>
              <p>Analisis completo en Balances y Reportes.</p>
            </article>
          ) : (
            <article className={`${styles.heroCard} ${styles.heroCardAccent}`}>
              <span>Saldo de cta. cte.</span>
              <strong>{money(summary.cc_open_balance)}</strong>
              <p>Detalle operativo dentro del modulo de clientes.</p>
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
