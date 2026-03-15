'use client';

import { useEffect, useMemo, useState } from 'react';
import { getApiBaseUrl, loadRuntimeConfig } from '@/lib/api';
import styles from './reportes.module.css';

type Summary = {
  products: number;
  stock_units: number;
  stock_value_cost: number;
  stock_value_sale: number;
  sales_count: number;
  sales_total: number;
  estimated_margin: number;
  cc_open_balance: number;
};

type MonthPoint = { month: string; sales: number; count: number };
type TopProduct = { product_id: number; name: string; quantity: number; revenue: number };
type Debtor = { customer_id: number; name: string; balance: number };
type LowStock = { id: number; name: string; stock: number; reorder_point: number };

const money = (value: number) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(value || 0);

export default function ReportesPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [monthly, setMonthly] = useState<MonthPoint[]>([]);
  const [topProducts, setTopProducts] = useState<TopProduct[]>([]);
  const [debtors, setDebtors] = useState<Debtor[]>([]);
  const [lowStock, setLowStock] = useState<LowStock[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    const load = async () => {
      try {
        await loadRuntimeConfig();
        const res = await fetch(`${getApiBaseUrl()}/admin/reports/overview`, { credentials: 'include' });
        if (!res.ok) throw new Error('No se pudieron cargar los reportes');
        const data = await res.json();
        setSummary(data.summary);
        setMonthly(data.monthly_sales || []);
        setTopProducts(data.top_products || []);
        setDebtors(data.top_debtors || []);
        setLowStock(data.low_stock || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error cargando reportes');
      }
    };
    load();
  }, []);

  const maxMonthly = useMemo(() => Math.max(1, ...monthly.map((item) => item.sales || 0)), [monthly]);

  return (
    <div className={styles.page}>
      <section className={styles.header}>
        <div>
          <h1>Reportes y balances</h1>
          <p>Resumen general, ventas mensuales, stock valorizado, deudores y top productos.</p>
        </div>
      </section>

      {error ? <div className={styles.error}>{error}</div> : null}

      {summary ? (
        <section className={styles.kpiGrid}>
          <article className={styles.kpi}><span>Ventas</span><strong>{money(summary.sales_total)}</strong></article>
          <article className={styles.kpi}><span>Comprobantes</span><strong>{summary.sales_count}</strong></article>
          <article className={styles.kpi}><span>Margen estimado</span><strong>{money(summary.estimated_margin)}</strong></article>
          <article className={styles.kpi}><span>Saldo cuenta corriente</span><strong>{money(summary.cc_open_balance)}</strong></article>
          <article className={styles.kpi}><span>Stock unidades</span><strong>{summary.stock_units}</strong></article>
          <article className={styles.kpi}><span>Stock a costo</span><strong>{money(summary.stock_value_cost)}</strong></article>
          <article className={styles.kpi}><span>Stock a venta</span><strong>{money(summary.stock_value_sale)}</strong></article>
          <article className={styles.kpi}><span>Productos activos</span><strong>{summary.products}</strong></article>
        </section>
      ) : null}

      <section className={styles.grid}>
        <article className={styles.panel}>
          <div className={styles.panelHeader}>
            <h2>Ventas por mes</h2>
          </div>
          <div className={styles.chart}>
            {monthly.map((point) => (
              <div key={point.month} className={styles.barItem}>
                <div className={styles.barValue}>{money(point.sales)}</div>
                <div className={styles.barTrack}>
                  <div className={styles.barFill} style={{ height: `${Math.max(8, (point.sales / maxMonthly) * 100)}%` }} />
                </div>
                <div className={styles.barLabel}>{point.month}</div>
              </div>
            ))}
          </div>
        </article>

        <article className={styles.panel}>
          <div className={styles.panelHeader}>
            <h2>Top productos</h2>
          </div>
          <div className={styles.list}>
            {topProducts.map((item) => (
              <div key={item.product_id} className={styles.listRow}>
                <div>
                  <strong>{item.name}</strong>
                  <span>{item.quantity} unidades</span>
                </div>
                <em>{money(item.revenue)}</em>
              </div>
            ))}
          </div>
        </article>

        <article className={styles.panel}>
          <div className={styles.panelHeader}>
            <h2>Mayores saldos pendientes</h2>
          </div>
          <div className={styles.list}>
            {debtors.map((item) => (
              <div key={item.customer_id} className={styles.listRow}>
                <div><strong>{item.name}</strong></div>
                <em>{money(item.balance)}</em>
              </div>
            ))}
          </div>
        </article>

        <article className={styles.panel}>
          <div className={styles.panelHeader}>
            <h2>Stock bajo</h2>
          </div>
          <div className={styles.list}>
            {lowStock.length === 0 ? (
              <div className={styles.empty}>No hay alertas de stock bajo.</div>
            ) : (
              lowStock.map((item) => (
                <div key={item.id} className={styles.listRow}>
                  <div>
                    <strong>{item.name}</strong>
                    <span>Stock {item.stock} · Punto reposicion {item.reorder_point}</span>
                  </div>
                  <em>{item.stock}</em>
                </div>
              ))
            )}
          </div>
        </article>
      </section>
    </div>
  );
}
