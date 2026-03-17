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

type MonthPoint = { month: string; sales: number; count: number; margin?: number };
type LowStock = { id: number; name: string; stock: number; reorder_point: number };
type DailySummary = {
  sales: number;
  margin: number;
  invoice_count: number;
  avg_ticket: number;
};
type DailyProduct = {
  product_id: number;
  name: string;
  quantity: number;
  sales: number;
  avg_price: number;
};
type DailyCustomer = {
  customer_id: number;
  name: string;
  invoice_count: number;
  sales: number;
  avg_ticket: number;
};
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

const formatMonthLabel = (value: string) => {
  const [year, month] = value.split('-');
  const parsed = new Date(Number(year), Number(month) - 1, 1);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString('es-AR', { month: 'short', year: 'numeric' });
};

const formatAxisMonthLabel = (value: string) => {
  const [year, month] = value.split('-');
  const parsed = new Date(Number(year), Number(month) - 1, 1);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString('es-AR', { month: 'short' });
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
  const [dailyDate, setDailyDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [dailySummary, setDailySummary] = useState<DailySummary | null>(null);
  const [dailyProducts, setDailyProducts] = useState<DailyProduct[]>([]);
  const [dailyCustomers, setDailyCustomers] = useState<DailyCustomer[]>([]);
  const [dailyLoading, setDailyLoading] = useState(false);
  const [sellerBalances, setSellerBalances] = useState<SellerBalance[]>([]);
  const [yearProjection, setYearProjection] = useState<YearProjection | null>(null);
  const [metricMode, setMetricMode] = useState<AnnualMetricMode>('sales');
  const [selectedMonth, setSelectedMonth] = useState('');
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
        const monthlySales = data.monthly_sales || [];
        if (monthlySales.length > 0) {
          setSelectedMonth((current) => current || monthlySales[monthlySales.length - 1].month);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error cargando balances');
      }
    };
    void load();
  }, []);

  useEffect(() => {
    const loadDaily = async () => {
      try {
        setDailyLoading(true);
        await loadRuntimeConfig();
        const res = await fetch(`${getApiBaseUrl()}/admin/reports/daily?report_date=${dailyDate}`, {
          credentials: 'include',
        });
        if (!res.ok) throw new Error('No se pudo cargar el reporte diario');
        const data = await res.json();
        setDailySummary(data.summary || null);
        setDailyProducts(data.products || []);
        setDailyCustomers(data.customers || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error cargando balances');
      } finally {
        setDailyLoading(false);
      }
    };
    void loadDaily();
  }, [dailyDate]);

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
      if (metricMode === 'margin') return item.margin || 0;
      return item.sales || 0;
    });
  }, [metricMode, monthly, summary]);

  const annualMetricPath = useMemo(
    () => buildLinePath(monthlyMetricPoints, 380, 124),
    [monthlyMetricPoints]
  );
  const annualBarData = useMemo(
    () =>
      monthly.map((item, index) => ({
        month: item.month,
        value: monthlyMetricPoints[index] || 0,
        count: item.count || 0,
      })),
    [monthly, monthlyMetricPoints]
  );
  const chartPoints = useMemo(() => {
    if (monthlyMetricPoints.length === 0) return [];
    return monthlyMetricPoints.map((value, index) => {
      const x = monthlyMetricPoints.length === 1 ? 190 : (index / (monthlyMetricPoints.length - 1)) * 380;
      const max = Math.max(1, ...monthlyMetricPoints);
      const y = 124 - (value / max) * 124;
      return {
        key: annualBarData[index]?.month || String(index),
        x,
        y,
        month: annualBarData[index]?.month || '',
        value,
      };
    });
  }, [annualBarData, monthlyMetricPoints]);

  const annualSummaryRows = useMemo(() => {
    if (!summary) return [];
    return [
      { label: 'Capital total', value: money(annualCapital), help: 'Stock + cuenta corriente + ganancia estimada' },
      { label: 'Ventas acumuladas', value: money(summary.sales_total), help: `${integer(summary.sales_count)} comprobantes emitidos` },
      { label: 'Ganancia estimada', value: money(summary.estimated_margin), help: 'Calculada sobre ventas reales emitidas' },
      { label: 'Cierre comercial', value: money(grossPosition), help: 'Stock a costo + cuenta corriente abierta' },
    ];
  }, [annualCapital, grossPosition, summary]);

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
  const selectedMonthData = useMemo(
    () => annualBarData.find((item) => item.month === selectedMonth) || annualBarData[annualBarData.length - 1] || null,
    [annualBarData, selectedMonth]
  );
  const selectedMonthValue = useMemo(() => {
    if (!selectedMonthData) return 0;
    if (metricMode === 'count') return selectedMonthData.count;
    return selectedMonthData.value;
  }, [metricMode, selectedMonthData]);
  const monthOptions = annualBarData.map((item) => ({
    value: item.month,
    label: formatMonthLabel(item.month),
  }));
  const viewLabel = metricMode === 'sales' ? 'Ventas' : metricMode === 'margin' ? 'Ganancia' : 'Comprobantes';

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
                  <h2>Reporte diario</h2>
                  <p className={styles.panelNote}>Ventas y ganancia del dia de trabajo seleccionado.</p>
                </div>
                <label className={styles.chartField}>
                  <span>Fecha:</span>
                  <input
                    type="date"
                    value={dailyDate}
                    onChange={(e) => setDailyDate(e.target.value)}
                    className={styles.dateInput}
                  />
                </label>
              </div>

              <div className={styles.dailySummaryGrid}>
                <article className={styles.dailyMetric}>
                  <span>Ventas del dia</span>
                  <strong>{money(dailySummary?.sales || 0)}</strong>
                </article>
                <article className={styles.dailyMetric}>
                  <span>Ganancia del dia</span>
                  <strong>{money(dailySummary?.margin || 0)}</strong>
                </article>
                <article className={styles.dailyMetric}>
                  <span>Comprobantes emitidos</span>
                  <strong>{integer(dailySummary?.invoice_count || 0)}</strong>
                </article>
                <article className={styles.dailyMetric}>
                  <span>Ticket promedio</span>
                  <strong>{money(dailySummary?.avg_ticket || 0)}</strong>
                </article>
              </div>

              <div className={styles.dailyTables}>
                <section className={styles.dailyTableCard}>
                  <div className={styles.panelHeader}>
                    <h3>Productos</h3>
                    <span className={styles.tableMeta}>{dailyProducts.length} filas</span>
                  </div>
                  <div className={styles.tableWrap}>
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          <th>Producto</th>
                          <th>Cantidad</th>
                          <th>Ventas</th>
                          <th>Precio promedio</th>
                        </tr>
                      </thead>
                      <tbody>
                        {dailyLoading ? (
                          <tr><td colSpan={4}>Cargando...</td></tr>
                        ) : dailyProducts.length === 0 ? (
                          <tr><td colSpan={4}>No hay productos vendidos en la fecha seleccionada.</td></tr>
                        ) : (
                          dailyProducts.map((item) => (
                            <tr key={item.product_id}>
                              <td>{item.name}</td>
                              <td>{integer(item.quantity)}</td>
                              <td>{money(item.sales)}</td>
                              <td>{money(item.avg_price)}</td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </section>

                <section className={styles.dailyTableCard}>
                  <div className={styles.panelHeader}>
                    <h3>Clientes</h3>
                    <span className={styles.tableMeta}>{dailyCustomers.length} filas</span>
                  </div>
                  <div className={styles.tableWrap}>
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          <th>Cliente</th>
                          <th>Comprobantes</th>
                          <th>Ventas</th>
                          <th>Ticket promedio</th>
                        </tr>
                      </thead>
                      <tbody>
                        {dailyLoading ? (
                          <tr><td colSpan={4}>Cargando...</td></tr>
                        ) : dailyCustomers.length === 0 ? (
                          <tr><td colSpan={4}>No hay clientes con compras en la fecha seleccionada.</td></tr>
                        ) : (
                          dailyCustomers.map((item) => (
                            <tr key={`${item.customer_id}-${item.name}`}>
                              <td>{item.name}</td>
                              <td>{integer(item.invoice_count)}</td>
                              <td>{money(item.sales)}</td>
                              <td>{money(item.avg_ticket)}</td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </section>
              </div>
            </article>

            <article className={`${styles.panel} ${styles.primaryPanel}`}>
              <div className={styles.chartToolbar}>
                <label className={styles.chartField}>
                  <span>Mes:</span>
                  <select value={selectedMonth} onChange={(e) => setSelectedMonth(e.target.value)}>
                    {monthOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={styles.chartField}>
                  <span>Vista:</span>
                  <select
                    value={metricMode}
                    onChange={(e) => setMetricMode(e.target.value as AnnualMetricMode)}
                  >
                    <option value="sales">Ventas</option>
                    <option value="margin">Ganancia</option>
                    <option value="count">Comprobantes</option>
                  </select>
                </label>
              </div>
              <div className={styles.panelHeader}>
                <div>
                  <h2>{viewLabel} de los ultimos 12 meses</h2>
                  <p className={styles.panelNote}>
                    El mes actual se actualiza con cada comprobante emitido.
                  </p>
                </div>
              </div>
              <div className={styles.highlight}>
                <div>
                  <span>{viewLabel} del mes</span>
                  <strong>
                    {metricMode === 'count'
                      ? integer(selectedMonthValue)
                      : money(selectedMonthValue)}
                  </strong>
                </div>
                <div>
                  <span>Variacion mensual</span>
                  <strong className={monthlyDelta >= 0 ? styles.positive : styles.negative}>
                    {monthlyDelta >= 0 ? '+' : ''}{monthlyDelta.toFixed(1)}%
                  </strong>
                </div>
              </div>
              <div className={styles.chartBox}>
                <svg viewBox="0 0 380 172" className={styles.lineChart} aria-hidden="true">
                  <path d="M 0 124 L 380 124" className={styles.chartBaseline} />
                  {[24, 48, 72, 96].map((y) => (
                    <path key={y} d={`M 0 ${y} L 380 ${y}`} className={styles.chartGrid} />
                  ))}
                  {annualMetricPath ? <path d={annualMetricPath} className={styles.linePrimary} /> : null}
                  {chartPoints.map((point) => (
                    <g key={point.key}>
                      <circle
                        cx={point.x}
                        cy={point.y}
                        r={point.month === selectedMonth ? 8 : 6}
                        className={point.month === selectedMonth ? styles.pointSelected : styles.point}
                      />
                      <text
                        x={point.x}
                        y={Math.max(18, point.y - 12)}
                        textAnchor="middle"
                        className={styles.pointLabel}
                      >
                        {metricMode === 'count' ? integer(point.value) : money(point.value)}
                      </text>
                      <text
                        x={point.x}
                        y="154"
                        textAnchor="middle"
                        className={styles.axisLabel}
                      >
                        {formatAxisMonthLabel(point.month)}
                      </text>
                    </g>
                  ))}
                </svg>
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
