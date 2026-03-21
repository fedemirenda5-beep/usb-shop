'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAdminSession } from '@/hooks/useAdminSession';
import { getApiBaseUrl, loadRuntimeConfig } from '@/lib/api';
import { ADMIN_MODULES } from './adminModules';
import { canAccessAdminModule, canViewFinancialModules } from './adminPermissions';
import styles from './dashboard.module.css';

type Summary = {
  products: number;
  active_customers: number;
  stock_units: number;
  stock_value_cost: number;
  stock_value_sale: number;
  sales_count: number;
  sales_total: number;
  estimated_margin: number;
  expenses_total: number;
  cc_open_balance: number;
  account_movements: number;
  debtors: number;
  latest_invoice_at?: string | null;
};

type OverviewResponse = {
  summary: Summary;
  top_debtors: Array<{ customer_id: number; name: string; balance: number }>;
  low_stock: Array<{ id: number; name: string; stock: number; reorder_point: number }>;
};

const money = (value: number) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(value || 0);

const integer = (value: number) => new Intl.NumberFormat('es-AR').format(value || 0);

const formatDate = (value?: string | null) => {
  if (!value) return 'Sin registros';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString('es-AR');
};

export default function AdminDashboard() {
  const { user } = useAdminSession();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [topDebtors, setTopDebtors] = useState<OverviewResponse['top_debtors']>([]);
  const [lowStock, setLowStock] = useState<OverviewResponse['low_stock']>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    const load = async () => {
      try {
        await loadRuntimeConfig();
        const res = await fetch(`${getApiBaseUrl()}/admin/reports/overview`, {
          credentials: 'include',
        });
        if (!res.ok) throw new Error('No se pudo cargar el escritorio');
        const data: OverviewResponse = await res.json();
        setSummary(data.summary);
        setTopDebtors(data.top_debtors || []);
        setLowStock(data.low_stock || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error cargando el escritorio');
      }
    };
    load();
  }, []);

  const sections = useMemo(
    () =>
      ADMIN_MODULES.filter((module) => module.id !== 'dashboard' && module.id !== 'reportes').map((module) => {
        if (module.id === 'productos') {
          return {
            ...module,
            value: summary ? integer(summary.products) : '...',
            label: summary
              ? `${integer(summary.stock_units)} unidades en stock`
              : module.dashboardLabel,
          };
        }
        if (module.id === 'pedidos') {
          return {
            ...module,
            value: 'Web',
            label: module.dashboardLabel,
          };
        }
        if (module.id === 'clientes') {
          return {
            ...module,
            value: summary ? integer(summary.active_customers) : '...',
            label: 'Clientes reales sincronizados desde la app',
          };
        }
        if (module.id === 'gastos') {
          return {
            ...module,
            value: summary ? money(summary.expenses_total) : '...',
            label: summary
              ? 'Gastos operativos acumulados registrados'
              : module.dashboardLabel,
          };
        }
        if (module.id === 'comprobantes') {
          return {
            ...module,
            value: summary ? integer(summary.sales_count) : '...',
            label: 'Comprobantes emitidos en la base actual',
          };
        }
        if (module.id === 'cuentas-corrientes') {
          return {
            ...module,
            value: summary
              ? canViewFinancialModules(user?.role)
                ? money(summary.cc_open_balance)
                : integer(summary.debtors)
              : '...',
            label: summary
              ? canViewFinancialModules(user?.role)
                ? `${integer(summary.account_movements)} movimientos registrados`
                : 'Clientes con cuenta corriente activa'
              : module.dashboardLabel,
          };
        }
        return {
          ...module,
          value: summary ? money(summary.sales_total) : '...',
          label: module.dashboardLabel,
        };
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
          <p>Bienvenido, {user?.username}. El resumen toma datos reales de la base actual y prioriza lo que más usás en la operación diaria.</p>
        </div>
        <div className={styles.headerCallout}>
          {canViewFinancialModules(user?.role) ? (
            <>
              <span>Ventas acumuladas</span>
              <strong>{summary ? money(summary.sales_total) : '...'}</strong>
              <p>Último registro: {formatDate(summary?.latest_invoice_at)}</p>
            </>
          ) : (
            <>
              <span>Operación activa</span>
              <strong>{summary ? integer(summary.sales_count) : '...'}</strong>
              <p>Comprobantes emitidos y gestión diaria disponible.</p>
            </>
          )}
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
            <span>Saldo abierto en cuentas corrientes</span>
            <strong>{money(summary.cc_open_balance)}</strong>
            <p>{integer(summary.debtors)} clientes con saldo pendiente</p>
          </article>
          <article className={styles.heroCard}>
            <span>Clientes activos</span>
            <strong>{integer(summary.active_customers)}</strong>
            <p>{integer(summary.account_movements)} movimientos de cuenta corriente</p>
          </article>
          {canViewFinancialModules(user?.role) ? (
            <article className={`${styles.heroCard} ${styles.heroCardAccent}`}>
              <span>Balance comercial</span>
              <strong>{money(summary.estimated_margin)}</strong>
              <p>Margen estimado sobre ventas por {money(summary.sales_total)}</p>
            </article>
          ) : (
            <article className={`${styles.heroCard} ${styles.heroCardAccent}`}>
              <span>Stock operativo</span>
              <strong>{integer(summary.stock_units)}</strong>
              <p>Unidades disponibles para la operación diaria.</p>
            </article>
          )}
        </section>
      ) : null}

      <div className={styles.statsGrid}>
        {visibleSections.map((section) => (
          <a key={section.href} href={section.href} className={styles.statCard}>
            <div className={styles.statContent}>
              <span className={styles.statEyebrow}>Panel</span>
              <h3>{section.title}</h3>
              <p className={styles.statValue}>{section.value}</p>
              <span className={styles.statLabel}>{section.label}</span>
            </div>
            <span className={styles.statAction}>Abrir</span>
          </a>
        ))}
      </div>

      <section className={styles.insightGrid}>
        <article className={styles.panel}>
          <div className={styles.panelHeader}>
            <h2>Mayores saldos pendientes</h2>
            <a href="/admin/cuentas-corrientes">Ver cuentas corrientes</a>
          </div>
          <div className={styles.list}>
            {topDebtors.length === 0 ? (
              <p className={styles.empty}>No hay saldos pendientes.</p>
            ) : (
              topDebtors.slice(0, 5).map((debtor) => (
                <div key={debtor.customer_id} className={styles.listRow}>
                  <strong>{debtor.name}</strong>
                  <span>{money(debtor.balance)}</span>
                </div>
              ))
            )}
          </div>
        </article>

        <article className={styles.panel}>
          <div className={styles.panelHeader}>
            <h2>Alertas de stock</h2>
            <a href="/admin/balances">Ver balances</a>
          </div>
          <div className={styles.list}>
            {lowStock.length === 0 ? (
              <p className={styles.empty}>No hay alertas de stock bajo.</p>
            ) : (
              lowStock.slice(0, 5).map((product) => (
                <div key={product.id} className={styles.listRow}>
                  <strong>{product.name}</strong>
                  <span>
                    Stock {integer(product.stock)} / Min. {integer(product.reorder_point)}
                  </span>
                </div>
              ))
            )}
          </div>
        </article>
      </section>

      <div className={styles.infoBox}>
        <p>
          El escritorio ya refleja clientes, comprobantes emitidos, saldos de cuentas corrientes y
          balance comercial desde `controlStock.db`.
        </p>
      </div>
    </div>
  );
}
