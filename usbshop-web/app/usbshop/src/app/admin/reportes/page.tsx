'use client';

import { useEffect, useMemo, useState } from 'react';
import { fetchApiResponse, getFriendlyApiError } from '@/lib/api';
import { getArgentinaNowDateInput } from '@/lib/datetime';
import InteractiveDualLineChart from '@/components/charts/InteractiveDualLineChart';
import styles from './reportes.module.css';

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

const REPORTS_AUTO_REFRESH_MS = 5 * 60 * 1000;

type Summary = {
  products: number;
  active_customers: number;
  stock_units: number;
  stock_value_cost: number;
  stock_value_sale: number;
  sales_count: number;
  sales_total: number;
  estimated_margin: number;
  operating_result: number;
  cc_open_balance: number;
  account_movements: number;
  debtors: number;
  latest_invoice_at?: string | null;
};

type MonthPoint = { month: string; sales: number; count: number };
type TopProduct = { product_id: number; name: string; quantity: number; revenue: number };
type TopCustomer = { customer_id: number; name: string; quantity: number; invoice_count: number; revenue: number };
type CategorySales = { category: string; revenue: number };
type Debtor = { customer_id: number; name: string; balance: number };
type LowStock = { id: number; name: string; stock: number; reorder_point: number };
type YearProjection = {
  year: number;
  current_ytd_sales: number;
  previous_ytd_sales: number;
  previous_full_year_sales: number;
  growth_projection: number;
  trend_projection: number;
  recent_window_months: number;
};
type DailyInvoice = { id: number; customer_id: number; customer_name: string; total: number; created_at: string; document_type?: string | null };
type DailyProduct = { product_id: number; name: string; quantity: number; sales: number; avg_price: number };
type DailyCustomer = { customer_id: number; name: string; invoice_count: number; sales: number; avg_ticket: number };
type DailySeller = { seller_id: number; name: string; sales: number; commission: number; invoice_count: number };
type DailyReport = {
  date: string;
  start_date?: string;
  end_date?: string;
  is_range?: boolean;
  label?: string;
  summary: {
    sales: number;
    margin: number;
    commissions?: number;
    invoice_count: number;
    avg_ticket: number;
  };
  products: DailyProduct[];
  customers: DailyCustomer[];
  sellers: DailySeller[];
  invoices: DailyInvoice[];
};

const money = (value: number) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(value || 0);

const integer = (value: number) => new Intl.NumberFormat('es-AR').format(value || 0);
const todayInput = () => getArgentinaNowDateInput();
const toDateInput = (value?: string | null) => {
  const match = String(value || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : '';
};
const shiftDateInput = (value: string, deltaDays: number) => {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return value;
  const [, year, month, day] = match;
  const base = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  base.setUTCDate(base.getUTCDate() + deltaDays);
  return `${base.getUTCFullYear()}-${String(base.getUTCMonth() + 1).padStart(2, '0')}-${String(base.getUTCDate()).padStart(2, '0')}`;
};
const getWeekRange = (value: string) => {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return { start: value, end: value };
  const [, year, month, day] = match;
  const base = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  const weekDay = base.getUTCDay();
  const offsetToMonday = weekDay === 0 ? -6 : 1 - weekDay;
  const monday = new Date(base);
  monday.setUTCDate(base.getUTCDate() + offsetToMonday);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  const format = (date: Date) =>
    `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
  return { start: format(monday), end: format(sunday) };
};
const getMonthRange = (value: string) => {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return { start: value, end: value };
  const [, year, month] = match;
  const monthIndex = Number(month) - 1;
  const first = new Date(Date.UTC(Number(year), monthIndex, 1));
  const last = new Date(Date.UTC(Number(year), monthIndex + 1, 0));
  const format = (date: Date) =>
    `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
  return { start: format(first), end: format(last) };
};

export default function ReportesPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [monthly, setMonthly] = useState<MonthPoint[]>([]);
  const [topProducts, setTopProducts] = useState<TopProduct[]>([]);
  const [topCustomers, setTopCustomers] = useState<TopCustomer[]>([]);
  const [salesByCategory, setSalesByCategory] = useState<CategorySales[]>([]);
  const [debtors, setDebtors] = useState<Debtor[]>([]);
  const [lowStock, setLowStock] = useState<LowStock[]>([]);
  const [yearProjection, setYearProjection] = useState<YearProjection | null>(null);
  const [dailyDate, setDailyDate] = useState('');
  const [dailyEndDate, setDailyEndDate] = useState('');
  const [dailyReport, setDailyReport] = useState<DailyReport | null>(null);
  const [error, setError] = useState('');
  const [loadingDaily, setLoadingDaily] = useState(true);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    let active = true;

    const loadOverview = async () => {
      try {
        setError('');
        const overviewRes = await fetchApiResponse('/admin/reports/overview', {
          cache: 'no-store',
        });
        if (!overviewRes.ok) throw new Error('No se pudieron cargar los reportes');
        const data = await overviewRes.json();
        if (!active) return;
        setSummary(data.summary);
        setMonthly(data.monthly_sales || []);
        setTopProducts(data.top_products || []);
        setTopCustomers(data.top_customers || []);
        setSalesByCategory(data.sales_by_category || []);
        setDebtors(data.top_debtors || []);
        setLowStock(data.low_stock || []);
        setYearProjection(data.year_projection || null);
        const fallbackDate = toDateInput(data?.summary?.latest_invoice_at) || todayInput();
        setDailyDate((current) => current || fallbackDate);
        setDailyEndDate((current) => current || fallbackDate);
      } catch (err) {
        if (!active) return;
        setError(getFriendlyApiError(err, 'Error cargando reportes'));
      }
    };

    void loadOverview();

    return () => {
      active = false;
    };
  }, [refreshTick]);

  useEffect(() => {
    if (!dailyDate || !dailyEndDate) return;
    if (dailyDate > dailyEndDate) {
      setDailyEndDate(dailyDate);
      return;
    }

    let active = true;

    const loadDailyReport = async () => {
      try {
        if (active) {
          setLoadingDaily(true);
          setError('');
        }
        const dailyRes = await fetchApiResponse(`/admin/reports/daily?start_date=${dailyDate}&end_date=${dailyEndDate}`, {
          cache: 'no-store',
        });
        if (!dailyRes.ok) throw new Error('No se pudo cargar el reporte diario');
        const dailyData = await dailyRes.json();
        if (!active) return;
        setDailyReport(dailyData || null);
      } catch (err) {
        if (!active) return;
        setError(getFriendlyApiError(err, 'Error cargando reporte diario'));
      } finally {
        if (active) {
          setLoadingDaily(false);
        }
      }
    };

    void loadDailyReport();

    return () => {
      active = false;
    };
  }, [dailyDate, dailyEndDate, refreshTick]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      if (document.visibilityState !== 'visible') {
        return;
      }
      setRefreshTick((current) => current + 1);
    }, REPORTS_AUTO_REFRESH_MS);

    const refreshOnFocus = () => {
      if (document.visibilityState === 'visible') {
        setRefreshTick((current) => current + 1);
      }
    };

    window.addEventListener('focus', refreshOnFocus);
    document.addEventListener('visibilitychange', refreshOnFocus);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('focus', refreshOnFocus);
      document.removeEventListener('visibilitychange', refreshOnFocus);
    };
  }, []);

  const maxMonthly = useMemo(() => Math.max(1, ...monthly.map((item) => item.sales || 0)), [monthly]);
  const monthlyPath = useMemo(
    () => buildLinePath(monthly.map((item) => item.sales || 0), 560, 180),
    [monthly]
  );
  const monthlyCountPath = useMemo(
    () => buildLinePath(monthly.map((item) => item.count || 0), 560, 120),
    [monthly]
  );
  const maxRevenue = useMemo(() => Math.max(1, ...topProducts.map((item) => item.revenue || 0)), [topProducts]);
  const maxDebtorBalance = useMemo(() => Math.max(1, ...debtors.map((item) => item.balance || 0)), [debtors]);
  const maxCategoryRevenue = useMemo(
    () => Math.max(1, ...salesByCategory.map((item) => item.revenue || 0)),
    [salesByCategory]
  );
  const maxCustomerRevenue = useMemo(
    () => Math.max(1, ...topCustomers.map((item) => item.revenue || 0)),
    [topCustomers]
  );

  return (
    <div className={styles.page}>
      <section className={styles.header}>
        <div>
          <h1>Reportes</h1>
          <p>Analisis general, ventas mensuales, top productos, deudores y alertas de stock.</p>
        </div>
      </section>

      {error ? <div className={styles.error}>{error}</div> : null}

      <section className={styles.grid}>
        <article className={`${styles.panel} ${styles.dailyPanel}`}>
          <div className={styles.panelHeader}>
            <div>
              <h2>Reporte diario</h2>
              <p>Venta y ganancia del día con selección de fecha.</p>
            </div>
            <div className={styles.dailyActions}>
              <div className={styles.dateStepper}>
                <button
                  type="button"
                  className={styles.navButton}
                  onClick={() => {
                    setDailyDate((current) => shiftDateInput(current || todayInput(), -1));
                    setDailyEndDate((current) => shiftDateInput(current || todayInput(), -1));
                  }}
                >
                  Dia anterior
                </button>
                <button
                  type="button"
                  className={styles.navButton}
                  onClick={() => {
                    setDailyDate((current) => shiftDateInput(current || todayInput(), 1));
                    setDailyEndDate((current) => shiftDateInput(current || todayInput(), 1));
                  }}
                >
                  Dia siguiente
                </button>
                <button
                  type="button"
                  className={styles.navButton}
                  onClick={() => {
                    const end = todayInput();
                    setDailyDate(shiftDateInput(end, -6));
                    setDailyEndDate(end);
                  }}
                >
                  Ultimos 7 dias
                </button>
                <button
                  type="button"
                  className={styles.navButton}
                  onClick={() => {
                    const { start, end } = getWeekRange(dailyDate || todayInput());
                    setDailyDate(start);
                    setDailyEndDate(end);
                  }}
                >
                  Esta semana
                </button>
                <button
                  type="button"
                  className={styles.navButton}
                  onClick={() => {
                    const { start, end } = getMonthRange(dailyDate || todayInput());
                    setDailyDate(start);
                    setDailyEndDate(end);
                  }}
                >
                  Este mes
                </button>
              </div>
              <label className={styles.dateFilter}>
                <span>Ver día</span>
                <input type="date" value={dailyDate} onChange={(event) => setDailyDate(event.target.value)} />
              </label>
              <label className={styles.dateFilter}>
                <span>Hasta</span>
                <input type="date" value={dailyEndDate} onChange={(event) => setDailyEndDate(event.target.value)} />
              </label>
              <button
                type="button"
                className={styles.refreshButton}
                onClick={() => setRefreshTick((current) => current + 1)}
              >
                Actualizar
              </button>
            </div>
          </div>
          {dailyReport ? (
            <>
              <div className={styles.dailyKpiGrid}>
                <article className={`${styles.kpi} ${styles.dailyKpiLead}`}><span>Venta del día</span><strong>{money(dailyReport.summary.sales)}</strong></article>
                <article className={`${styles.kpi} ${styles.dailyKpiLead}`}><span>Margen del día</span><strong>{money(dailyReport.summary.margin)}</strong></article>
                <article className={styles.kpi}><span>Comisiones</span><strong>{money(dailyReport.summary.commissions || 0)}</strong></article>
                <article className={styles.kpi}><span>Periodo</span><strong>{dailyReport.label || dailyReport.date}</strong></article>
                <article className={styles.kpi}><span>Comprobantes</span><strong>{integer(dailyReport.summary.invoice_count)}</strong></article>
                <article className={styles.kpi}><span>Ticket promedio</span><strong>{money(dailyReport.summary.avg_ticket)}</strong></article>
              </div>
              <div className={styles.dailyGrid}>
                <div className={styles.list}>
                  <div className={styles.subheading}>Comprobantes del día</div>
                  {dailyReport.invoices.length === 0 ? (
                    <div className={styles.empty}>No hubo comprobantes en ese periodo.</div>
                  ) : (
                    dailyReport.invoices.map((item) => (
                      <div key={item.id} className={styles.listRow}>
                        <div>
                          <strong>#{item.id} · {item.document_type || 'Comprobante'}</strong>
                          <span>{item.customer_name}</span>
                        </div>
                        <em>{money(item.total)}</em>
                      </div>
                    ))
                  )}
                </div>
                <div className={styles.list}>
                  <div className={styles.subheading}>Productos vendidos</div>
                  {dailyReport.products.length === 0 ? (
                    <div className={styles.empty}>Sin productos vendidos en ese periodo.</div>
                  ) : (
                    dailyReport.products.slice(0, 8).map((item) => (
                      <div key={item.product_id} className={styles.listRow}>
                        <div>
                          <strong>{item.name}</strong>
                          <span>{integer(item.quantity)} unidades · Promedio {money(item.avg_price)}</span>
                        </div>
                        <em>{money(item.sales)}</em>
                      </div>
                    ))
                  )}
                </div>
                <div className={styles.list}>
                  <div className={styles.subheading}>Comisiones por vendedor</div>
                  {dailyReport.sellers.length === 0 ? (
                    <div className={styles.empty}>No hay comisiones de vendedores en ese periodo.</div>
                  ) : (
                    dailyReport.sellers.map((item) => (
                      <div key={item.seller_id} className={styles.listRow}>
                        <div>
                          <strong>{item.name}</strong>
                          <span>{integer(item.invoice_count)} comprobantes · Venta {money(item.sales)}</span>
                        </div>
                        <em>{money(item.commission)}</em>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className={styles.empty}>{loadingDaily ? 'Cargando reporte diario...' : 'No se pudo cargar el reporte diario.'}</div>
          )}
        </article>

        {summary ? (
          <article className={`${styles.panel} ${styles.secondarySummaryPanel}`}>
            <div className={styles.panelHeader}>
              <div>
                <h2>Panorama general</h2>
                <p>Resumen secundario del negocio con números más compactos.</p>
              </div>
            </div>
            <div className={styles.kpiGridCompact}>
              <article className={`${styles.kpi} ${styles.kpiCompact}`}><span>Ventas</span><strong>{money(summary.sales_total)}</strong></article>
              <article className={`${styles.kpi} ${styles.kpiCompact}`}><span>Comprobantes</span><strong>{summary.sales_count}</strong></article>
              <article className={`${styles.kpi} ${styles.kpiCompact}`}><span>Margen estimado</span><strong>{money(summary.estimated_margin)}</strong></article>
              <article className={`${styles.kpi} ${styles.kpiCompact}`}><span>Resultado operativo</span><strong>{money(summary.operating_result)}</strong></article>
              <article className={`${styles.kpi} ${styles.kpiCompact}`}><span>Saldo cuenta corriente</span><strong>{money(summary.cc_open_balance)}</strong></article>
              <article className={`${styles.kpi} ${styles.kpiCompact}`}><span>Clientes activos</span><strong>{summary.active_customers}</strong></article>
              <article className={`${styles.kpi} ${styles.kpiCompact}`}><span>Movimientos CC</span><strong>{summary.account_movements}</strong></article>
              <article className={`${styles.kpi} ${styles.kpiCompact}`}><span>Stock unidades</span><strong>{summary.stock_units}</strong></article>
              <article className={`${styles.kpi} ${styles.kpiCompact}`}><span>Stock a costo</span><strong>{money(summary.stock_value_cost)}</strong></article>
              <article className={`${styles.kpi} ${styles.kpiCompact}`}><span>Stock a venta</span><strong>{money(summary.stock_value_sale)}</strong></article>
              <article className={`${styles.kpi} ${styles.kpiCompact}`}><span>Productos activos</span><strong>{summary.products}</strong></article>
            </div>
          </article>
        ) : null}

        <article className={styles.panel}>
          <div className={styles.panelHeader}>
            <h2>Ventas por mes</h2>
          </div>
          <div className={styles.chartCard}>
            <div className={styles.lineChartWrap}>
              <InteractiveDualLineChart
                data={monthly.map((point) => ({
                  id: point.month,
                  label: point.month,
                  meta: `Mes ${point.month}`,
                  primary: point.sales,
                  secondary: point.count,
                }))}
                primaryLabel="Facturacion"
                secondaryLabel="Comprobantes"
                formatPrimary={money}
                formatSecondary={(value) => integer(Math.round(value))}
                primaryColor="#84cc16"
                secondaryColor="#0f172a"
              />
              <svg viewBox="0 0 560 220" className={styles.lineChart} aria-hidden="true">
                <defs>
                  <linearGradient id="salesArea" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="rgba(132, 204, 22, 0.35)" />
                    <stop offset="100%" stopColor="rgba(132, 204, 22, 0.04)" />
                  </linearGradient>
                </defs>
                <path d="M 0 180 L 560 180" className={styles.chartBaseline} />
                {monthlyPath ? (
                  <>
                    <path d={`${monthlyPath} L 560 180 L 0 180 Z`} fill="url(#salesArea)" />
                    <path d={monthlyPath} className={styles.linePrimary} />
                  </>
                ) : null}
                {monthlyCountPath ? <path d={monthlyCountPath} className={styles.lineSecondary} /> : null}
              </svg>
            </div>
            <div className={styles.chartLegend}>
              <span><i className={styles.legendSales} /> Facturación</span>
              <span><i className={styles.legendCount} /> Cantidad de comprobantes</span>
            </div>
            <div className={styles.chart}>
              {monthly.map((point) => (
                <div key={point.month} className={styles.barItem}>
                  <div className={styles.barValue}>{money(point.sales)}</div>
                  <div className={styles.barTrack}>
                    <div
                      className={styles.barFill}
                      style={{ height: `${Math.max(8, (point.sales / maxMonthly) * 100)}%` }}
                    />
                  </div>
                  <div className={styles.barLabel}>{point.month}</div>
                </div>
              ))}
            </div>
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
                  <span>{integer(item.quantity)} unidades</span>
                  <div className={styles.progressTrack}>
                    <div
                      className={styles.progressFill}
                      style={{ width: `${Math.max(6, (item.revenue / maxRevenue) * 100)}%` }}
                    />
                  </div>
                </div>
                <em>{money(item.revenue)}</em>
              </div>
            ))}
          </div>
        </article>

        <article className={styles.panel}>
          <div className={styles.panelHeader}>
            <h2>Clientes que más compran</h2>
          </div>
          <div className={styles.list}>
            {topCustomers.map((item) => (
              <div key={item.customer_id} className={styles.listRow}>
                <div>
                  <strong>{item.name}</strong>
                  <span>{item.invoice_count} comprobantes · {integer(item.quantity)} unidades</span>
                  <div className={styles.progressTrack}>
                    <div
                      className={styles.progressFill}
                      style={{ width: `${Math.max(6, (item.revenue / maxCustomerRevenue) * 100)}%` }}
                    />
                  </div>
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
                <div>
                  <strong>{item.name}</strong>
                  <div className={styles.progressTrack}>
                    <div
                      className={styles.progressFillDebt}
                      style={{ width: `${Math.max(6, (item.balance / maxDebtorBalance) * 100)}%` }}
                    />
                  </div>
                </div>
                <em>{money(item.balance)}</em>
              </div>
            ))}
          </div>
        </article>

        <article className={styles.panel}>
          <div className={styles.panelHeader}>
            <h2>Ventas por rubro</h2>
          </div>
          <div className={styles.list}>
            {salesByCategory.map((item) => (
              <div key={item.category} className={styles.listRow}>
                <div>
                  <strong>{item.category}</strong>
                  <div className={styles.progressTrack}>
                    <div
                      className={styles.progressFillCategory}
                      style={{ width: `${Math.max(6, (item.revenue / maxCategoryRevenue) * 100)}%` }}
                    />
                  </div>
                </div>
                <em>{money(item.revenue)}</em>
              </div>
            ))}
          </div>
        </article>

        <article className={styles.panel}>
          <div className={styles.panelHeader}>
            <h2>Proyección {yearProjection?.year || ''}</h2>
          </div>
          {yearProjection ? (
            <div className={styles.projectionGrid}>
              <div className={styles.projectionCard}>
                <span>Ventas YTD</span>
                <strong>{money(yearProjection.current_ytd_sales)}</strong>
                <p>Contra {money(yearProjection.previous_ytd_sales)} del mismo período anterior.</p>
              </div>
              <div className={styles.projectionCard}>
                <span>Proyección por crecimiento</span>
                <strong>{money(yearProjection.growth_projection)}</strong>
                <p>Aplica la variación YTD sobre el cierre anual previo.</p>
              </div>
              <div className={styles.projectionCard}>
                <span>Proyección por tendencia</span>
                <strong>{money(yearProjection.trend_projection)}</strong>
                <p>Annualiza los últimos {yearProjection.recent_window_months || 1} meses completos.</p>
              </div>
            </div>
          ) : (
            <div className={styles.empty}>Sin datos suficientes para proyectar el año.</div>
          )}
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
