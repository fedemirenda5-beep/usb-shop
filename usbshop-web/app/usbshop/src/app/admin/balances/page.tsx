'use client';

import { useEffect, useMemo, useState } from 'react';
import { getApiBaseUrl, loadRuntimeConfig } from '@/lib/api';
import styles from './balances.module.css';

type Summary = {
  products: number;
  active_customers: number;
  stock_units: number;
  stock_value_cost: number;
  stock_value_sale: number;
  sales_count: number;
  sales_total: number;
  estimated_margin: number;
  cc_open_balance: number;
  account_movements: number;
  debtors: number;
  latest_invoice_at?: string | null;
};

type MonthPoint = { month: string; sales: number; count: number };
type Debtor = { customer_id: number; name: string; balance: number };
type LowStock = { id: number; name: string; stock: number; reorder_point: number };

const money = (value: number) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(value || 0);

const integer = (value: number) => new Intl.NumberFormat('es-AR').format(value || 0);

const formatDate = (value?: string | null) => {
  if (!value) return 'Sin registros';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString('es-AR');
};

export default function BalancesPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [monthly, setMonthly] = useState<MonthPoint[]>([]);
  const [debtors, setDebtors] = useState<Debtor[]>([]);
  const [lowStock, setLowStock] = useState<LowStock[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    const load = async () => {
      try {
        await loadRuntimeConfig();
        const res = await fetch(`${getApiBaseUrl()}/admin/reports/overview`, { credentials: 'include' });
        if (!res.ok) throw new Error('No se pudieron cargar los balances');
        const data = await res.json();
        setSummary(data.summary);
        setMonthly(data.monthly_sales || []);
        setDebtors(data.top_debtors || []);
        setLowStock(data.low_stock || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error cargando balances');
      }
    };
    void load();
  }, []);

  const currentMonth = monthly[monthly.length - 1];
  const previousMonth = monthly[monthly.length - 2];
  const monthlyDelta = useMemo(() => {
    const current = currentMonth?.sales || 0;
    const previous = previousMonth?.sales || 0;
    if (!previous) return current ? 100 : 0;
    return ((current - previous) / previous) * 100;
  }, [currentMonth, previousMonth]);

  const grossPosition = useMemo(() => {
    if (!summary) return 0;
    return summary.stock_value_cost + summary.cc_open_balance;
  }, [summary]);

  return (
    <div className={styles.page}>
      <section className={styles.header}>
        <div>
          <h1>Balances</h1>
          <p>Lectura operativa del negocio: ventas, stock valorizado, saldo abierto y posicion comercial.</p>
        </div>
      </section>

      {error ? <div className={styles.error}>{error}</div> : null}

      {summary ? (
        <>
          <section className={styles.heroGrid}>
            <article className={styles.heroCard}>
              <span>Posicion comercial</span>
              <strong>{money(grossPosition)}</strong>
              <p>Stock a costo + saldo de cuentas corrientes</p>
            </article>
            <article className={styles.heroCard}>
              <span>Ventas acumuladas</span>
              <strong>{money(summary.sales_total)}</strong>
              <p>{integer(summary.sales_count)} comprobantes emitidos</p>
            </article>
            <article className={styles.heroCard}>
              <span>Margen estimado</span>
              <strong>{money(summary.estimated_margin)}</strong>
              <p>Ultimo comprobante: {formatDate(summary.latest_invoice_at)}</p>
            </article>
          </section>

          <section className={styles.metricGrid}>
            <article className={styles.metricCard}>
              <span>Saldo abierto</span>
              <strong>{money(summary.cc_open_balance)}</strong>
              <p>{integer(summary.debtors)} clientes con deuda</p>
            </article>
            <article className={styles.metricCard}>
              <span>Stock a costo</span>
              <strong>{money(summary.stock_value_cost)}</strong>
              <p>{integer(summary.stock_units)} unidades</p>
            </article>
            <article className={styles.metricCard}>
              <span>Stock a venta</span>
              <strong>{money(summary.stock_value_sale)}</strong>
              <p>{integer(summary.products)} productos activos</p>
            </article>
            <article className={styles.metricCard}>
              <span>Clientes activos</span>
              <strong>{integer(summary.active_customers)}</strong>
              <p>{integer(summary.account_movements)} movimientos registrados</p>
            </article>
          </section>

          <section className={styles.grid}>
            <article className={styles.panel}>
              <div className={styles.panelHeader}>
                <h2>Corte mensual</h2>
              </div>
              <div className={styles.highlight}>
                <div>
                  <span>Mes actual</span>
                  <strong>{currentMonth ? money(currentMonth.sales) : money(0)}</strong>
                </div>
                <div>
                  <span>Variacion mensual</span>
                  <strong className={monthlyDelta >= 0 ? styles.positive : styles.negative}>
                    {monthlyDelta >= 0 ? '+' : ''}{monthlyDelta.toFixed(1)}%
                  </strong>
                </div>
              </div>
              <div className={styles.monthList}>
                {monthly.slice(-6).reverse().map((item) => (
                  <div key={item.month} className={styles.monthRow}>
                    <div>
                      <strong>{item.month}</strong>
                      <span>{item.count} comprobantes</span>
                    </div>
                    <em>{money(item.sales)}</em>
                  </div>
                ))}
              </div>
            </article>

            <article className={styles.panel}>
              <div className={styles.panelHeader}>
                <h2>Mayor exposicion</h2>
              </div>
              <div className={styles.list}>
                {debtors.length === 0 ? (
                  <div className={styles.empty}>No hay saldos pendientes.</div>
                ) : (
                  debtors.map((item) => (
                    <div key={item.customer_id} className={styles.listRow}>
                      <div>
                        <strong>{item.name}</strong>
                        <span>Cuenta corriente abierta</span>
                      </div>
                      <em>{money(item.balance)}</em>
                    </div>
                  ))
                )}
              </div>
            </article>

            <article className={styles.panel}>
              <div className={styles.panelHeader}>
                <h2>Alertas de stock</h2>
              </div>
              <div className={styles.list}>
                {lowStock.length === 0 ? (
                  <div className={styles.empty}>No hay alertas de stock bajo.</div>
                ) : (
                  lowStock.map((item) => (
                    <div key={item.id} className={styles.listRow}>
                      <div>
                        <strong>{item.name}</strong>
                        <span>Minimo {integer(item.reorder_point)}</span>
                      </div>
                      <em>{integer(item.stock)}</em>
                    </div>
                  ))
                )}
              </div>
            </article>

            <article className={styles.panel}>
              <div className={styles.panelHeader}>
                <h2>Lectura rapida</h2>
              </div>
              <div className={styles.notes}>
                <p>
                  El admin ya trabaja con una sola fuente operativa para clientes, comprobantes y cuentas corrientes.
                </p>
                <p>
                  El balance comercial combina ventas emitidas, stock valorizado y saldos pendientes del backoffice.
                </p>
                <p>
                  Si la web corre en `localhost`, toma la base local real; en produccion depende de la API publicada.
                </p>
              </div>
            </article>
          </section>
        </>
      ) : null}
    </div>
  );
}
