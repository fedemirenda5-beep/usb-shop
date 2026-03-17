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
type LowStock = { id: number; name: string; stock: number; reorder_point: number };
type SellerBalance = {
  seller_id: number;
  name: string;
  sales: number;
  margin: number;
  commission: number;
  invoice_count: number;
};
type YearProjection = {
  year: number;
  current_ytd_sales: number;
  previous_ytd_sales: number;
  previous_full_year_sales: number;
  growth_projection: number;
  trend_projection: number;
  recent_window_months: number;
};
type AnnualMetricMode = 'sales' | 'margin' | 'count';

const money = (value: number) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(value || 0);

const integer = (value: number) => new Intl.NumberFormat('es-AR').format(value || 0);

const formatDate = (value?: string | null) => {
  if (!value) return 'Sin registros';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString('es-AR');
};

const buildLinePath = (points: number[], width: number, height: number) => {
  if (points.length === 0) return '';
  const max = Math.max(1, ...points);
  return points
    .map((value, index) => {
      const x = points.length === 1 ? width / 2 : (index / (points.length - 1)) * width;
      const y = height - (value / max) * height;
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(' ');
};

export default function BalancesPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [monthly, setMonthly] = useState<MonthPoint[]>([]);
  const [lowStock, setLowStock] = useState<LowStock[]>([]);
  const [sellerBalances, setSellerBalances] = useState<SellerBalance[]>([]);
  const [yearProjection, setYearProjection] = useState<YearProjection | null>(null);
  const [metricMode, setMetricMode] = useState<AnnualMetricMode>('sales');
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
        setLowStock(data.low_stock || []);
        setSellerBalances(data.sales_by_seller || []);
        setYearProjection(data.year_projection || null);
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

  const annualCapital = useMemo(() => {
    if (!summary) return 0;
    return summary.stock_value_cost + summary.cc_open_balance + summary.estimated_margin;
  }, [summary]);

  const composition = useMemo(() => {
    if (!summary) return [];
    return [
      { label: 'Stock a costo', value: summary.stock_value_cost, tone: 'var(--lime)' },
      { label: 'Cuenta corriente', value: summary.cc_open_balance, tone: '#2563eb' },
      { label: 'Ganancia estimada', value: summary.estimated_margin, tone: '#7c3aed' },
    ];
  }, [summary]);

  const compositionTotal = useMemo(
    () => composition.reduce((acc, item) => acc + Math.max(0, item.value), 0),
    [composition]
  );

  const monthlyMetricPoints = useMemo(() => {
    if (!summary) return [];
    return monthly.map((item) => {
      if (metricMode === 'count') return item.count || 0;
      if (metricMode === 'margin') {
        const ratio = summary.sales_total > 0 ? (item.sales || 0) / summary.sales_total : 0;
        return summary.estimated_margin * ratio;
      }
      return item.sales || 0;
    });
  }, [metricMode, monthly, summary]);

  const annualMetricPath = useMemo(
    () => buildLinePath(monthlyMetricPoints, 520, 170),
    [monthlyMetricPoints]
  );

  const maxAnnualMetric = useMemo(() => Math.max(1, ...monthlyMetricPoints, 0), [monthlyMetricPoints]);

  const annualBarData = useMemo(
    () =>
      monthly.map((item, index) => ({
        month: item.month,
        value: monthlyMetricPoints[index] || 0,
        count: item.count || 0,
      })),
    [monthly, monthlyMetricPoints]
  );

  const annualSummaryRows = useMemo(() => {
    if (!summary) return [];
    return [
      { label: 'Capital total', value: money(annualCapital), help: 'Stock + cuenta corriente + ganancia estimada' },
      { label: 'Ventas acumuladas', value: money(summary.sales_total), help: `${integer(summary.sales_count)} comprobantes emitidos` },
      { label: 'Ganancia estimada', value: money(summary.estimated_margin), help: 'Calculada sobre ventas reales emitidas' },
      { label: 'Cierre comercial', value: money(grossPosition), help: 'Stock a costo + cuenta corriente abierta' },
    ];
  }, [annualCapital, grossPosition, summary]);

  const metricLabel =
    metricMode === 'margin'
      ? 'Ganancia'
      : metricMode === 'count'
        ? 'Comprobantes'
        : 'Ventas';

  const monthlyDetailRows = useMemo(
    () =>
      annualBarData.slice(-6).reverse().map((item) => ({
        ...item,
        display:
          metricMode === 'count'
            ? `${integer(item.value)} comprobantes`
            : money(item.value),
      })),
    [annualBarData, metricMode]
  );
  const sellerMaxSales = useMemo(
    () => Math.max(1, ...sellerBalances.map((item) => item.sales || 0), 0),
    [sellerBalances]
  );

  return (
    <div className={styles.page}>
      <section className={styles.header}>
        <div>
          <h1>Balances</h1>
          <p>Modelo anual inspirado en la app de escritorio: capital, ventas, ganancia y cierre comercial.</p>
        </div>
      </section>

      {error ? <div className={styles.error}>{error}</div> : null}

      {summary ? (
        <>
          <section className={styles.desktopHero}>
            <article className={styles.heroLead}>
              <span>Balance anual</span>
              <strong>{money(annualCapital)}</strong>
              <p>Ultimo comprobante: {formatDate(summary.latest_invoice_at)}</p>
            </article>
            <div className={styles.summaryStrip}>
              {annualSummaryRows.map((item) => (
                <article key={item.label} className={styles.summaryTile}>
                  <span>{item.label}</span>
                  <strong>{item.value}</strong>
                  <p>{item.help}</p>
                </article>
              ))}
            </div>
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
            <article className={`${styles.panel} ${styles.primaryPanel}`}>
              <div className={styles.panelHeader}>
                <div>
                  <h2>Ventas mensuales</h2>
                  <p className={styles.panelNote}>Comparativo mensual del balance anual, como en escritorio.</p>
                </div>
                <div className={styles.metricSwitch}>
                  <button
                    type="button"
                    className={metricMode === 'sales' ? styles.metricSwitchActive : ''}
                    onClick={() => setMetricMode('sales')}
                  >
                    Ventas
                  </button>
                  <button
                    type="button"
                    className={metricMode === 'margin' ? styles.metricSwitchActive : ''}
                    onClick={() => setMetricMode('margin')}
                  >
                    Ganancia
                  </button>
                  <button
                    type="button"
                    className={metricMode === 'count' ? styles.metricSwitchActive : ''}
                    onClick={() => setMetricMode('count')}
                  >
                    Comprobantes
                  </button>
                </div>
              </div>
              <div className={styles.highlight}>
                <div>
                  <span>{metricLabel} actual</span>
                  <strong>
                    {metricMode === 'count'
                      ? integer(monthlyMetricPoints[monthlyMetricPoints.length - 1] || 0)
                      : money(monthlyMetricPoints[monthlyMetricPoints.length - 1] || 0)}
                  </strong>
                </div>
                <div>
                  <span>Variacion mensual</span>
                  <strong className={monthlyDelta >= 0 ? styles.positive : styles.negative}>
                    {monthlyDelta >= 0 ? '+' : ''}{monthlyDelta.toFixed(1)}%
                  </strong>
                </div>
              </div>
              <div className={styles.desktopChartPanel}>
                <div className={styles.chartBox}>
                  <svg viewBox="0 0 520 190" className={styles.lineChart} aria-hidden="true">
                    <path d="M 0 170 L 520 170" className={styles.chartBaseline} />
                    {annualMetricPath ? <path d={annualMetricPath} className={styles.linePrimary} /> : null}
                  </svg>
                </div>
                <div className={styles.barChart}>
                  {annualBarData.slice(-8).map((item) => (
                    <div key={item.month} className={styles.barItem}>
                      <div
                        className={styles.barFill}
                        style={{ height: `${Math.max(8, (item.value / maxAnnualMetric) * 100)}%` }}
                      />
                      <span>{item.month}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className={styles.monthList}>
                {monthlyDetailRows.map((item) => (
                  <div key={item.month} className={styles.monthRow}>
                    <div>
                      <strong>{item.month}</strong>
                      <span>{item.count} comprobantes</span>
                    </div>
                    <em>{item.display}</em>
                  </div>
                ))}
              </div>
            </article>

            <article className={styles.panel}>
              <div className={styles.panelHeader}>
                <h2>Composicion general</h2>
              </div>
              <div className={styles.compactComposition}>
                <div className={styles.ringChart}>
                  <div
                    className={styles.ringChartFill}
                    style={{
                      background: `conic-gradient(
                        var(--lime) 0 ${(compositionTotal > 0 ? (Math.max(0, composition[0]?.value || 0) / compositionTotal) * 100 : 0).toFixed(2)}%,
                        #2563eb ${(compositionTotal > 0 ? (Math.max(0, composition[0]?.value || 0) / compositionTotal) * 100 : 0).toFixed(2)}% ${(
                          compositionTotal > 0
                            ? ((Math.max(0, composition[0]?.value || 0) + Math.max(0, composition[1]?.value || 0)) / compositionTotal) * 100
                            : 0
                        ).toFixed(2)}%,
                        #7c3aed ${(
                          compositionTotal > 0
                            ? ((Math.max(0, composition[0]?.value || 0) + Math.max(0, composition[1]?.value || 0)) / compositionTotal) * 100
                            : 0
                        ).toFixed(2)}% 100%
                      )`,
                    }}
                  />
                  <div className={styles.ringChartCenter}>
                    <span>Total</span>
                    <strong>{money(annualCapital)}</strong>
                  </div>
                </div>
                <div className={styles.compositionList}>
                  {composition.map((item) => (
                    <div key={item.label} className={styles.compositionRow}>
                      <span className={styles.compositionDot} style={{ background: item.tone }} />
                      <div>
                        <strong>{item.label}</strong>
                        <p>{money(item.value)}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </article>

            <article className={styles.panel}>
              <div className={styles.panelHeader}>
                <h2>Vendedores</h2>
              </div>
              <div className={styles.sellerList}>
                {sellerBalances.length === 0 ? (
                  <div className={styles.empty}>Todavia no hay comprobantes asignados a vendedores.</div>
                ) : (
                  sellerBalances.map((item) => (
                    <div key={item.seller_id} className={styles.sellerCard}>
                      <div className={styles.sellerHead}>
                        <div>
                          <strong>{item.name}</strong>
                          <span>{integer(item.invoice_count)} comprobantes</span>
                        </div>
                        <em>{money(item.sales)}</em>
                      </div>
                      <div className={styles.sellerBarTrack}>
                        <div
                          className={styles.sellerBarFill}
                          style={{ width: `${(item.sales / sellerMaxSales) * 100}%` }}
                        />
                      </div>
                      <div className={styles.sellerMeta}>
                        <div>
                          <span>Ganancia</span>
                          <strong>{money(item.margin)}</strong>
                        </div>
                        <div>
                          <span>Comision interna</span>
                          <strong>{money(item.commission)}</strong>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </article>

            <article className={styles.panel}>
              <div className={styles.panelHeader}>
                <h2>Proyeccion anual</h2>
              </div>
              {yearProjection ? (
                <div className={styles.projectionGrid}>
                  <div className={styles.projectionCard}>
                    <span>Ventas YTD</span>
                    <strong>{money(yearProjection.current_ytd_sales)}</strong>
                    <p>Mismo periodo anterior: {money(yearProjection.previous_ytd_sales)}</p>
                  </div>
                  <div className={styles.projectionCard}>
                    <span>Crecimiento sobre cierre previo</span>
                    <strong>{money(yearProjection.growth_projection)}</strong>
                    <p>Basado en ventas del ano {yearProjection.year - 1}.</p>
                  </div>
                  <div className={styles.projectionCard}>
                    <span>Tendencia real</span>
                    <strong>{money(yearProjection.trend_projection)}</strong>
                    <p>Ventana reciente: {yearProjection.recent_window_months || 1} meses.</p>
                  </div>
                </div>
              ) : (
                <div className={styles.empty}>Sin datos suficientes para proyectar el ano.</div>
              )}
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
          </section>
        </>
      ) : null}
    </div>
  );
}
