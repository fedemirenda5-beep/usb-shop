'use client';

import { useEffect, useMemo, useState } from 'react';
import { fetchApiResponse, getFriendlyApiError } from '@/lib/api';
import { formatArgentinaDate, formatArgentinaMonth, formatArgentinaShortMonthYear } from '@/lib/datetime';
import styles from './balances.module.css';

type Summary = {
  stock_value_cost: number;
  stock_value_sale: number;
  estimated_margin: number;
  purchases_total: number;
  expenses_total: number;
  commissions_total: number;
  operating_result: number;
  cc_open_balance: number;
  cash_on_hand: number;
  latest_invoice_at?: string | null;
};

type CurrentYearMonth = {
  month: string;
  sales: number;
  margin: number;
  adjusted_margin?: number | null;
  margin_display?: number;
  margin_adjustment_applied?: boolean;
  margin_adjustment_label?: string | null;
  expenses: number;
  operating_result: number;
  count: number;
  previous_year_sales: number;
  previous_year_margin: number;
  previous_year_adjusted_margin?: number | null;
  previous_year_margin_display?: number;
  previous_year_margin_adjustment_applied?: boolean;
  previous_year_margin_adjustment_label?: string | null;
  previous_year_expenses: number;
  previous_year_operating_result: number;
  sales_growth_pct?: number | null;
  margin_growth_pct?: number | null;
  operating_result_growth_pct?: number | null;
};

type MonthlySalesPoint = {
  month: string;
  sales: number;
  margin: number;
  adjusted_margin?: number | null;
  adjusted_operating_result?: number | null;
  margin_display?: number;
  margin_adjustment_applied?: boolean;
  margin_adjustment_label?: string | null;
  expenses?: number;
  commissions?: number;
  operating_result: number;
  count: number;
};

type CurrentYearDetail = {
  year: number;
  capital_total: number;
  sales_total: number;
  margin_total: number;
  purchases_total: number;
  expenses_total: number;
  commissions_total: number;
  operating_result_total: number;
  cash_on_hand: number;
  months: CurrentYearMonth[];
};

type AnnualHistoryEntry = {
  year: number;
  sales: number;
  margin: number;
  purchases: number;
  expenses: number;
  commissions: number;
  operating_result: number;
  invoice_count: number;
  cc_balance_end: number;
  cash_balance_end: number;
  capital_total: number;
  sales_growth_pct?: number | null;
  capital_growth_pct?: number | null;
  is_frozen?: boolean;
  closure_mode?: string | null;
  closed_at?: string | null;
};

const money = (value: number) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(value || 0);

const compactMoney = (value: number) =>
  new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: 'ARS',
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value || 0);

const integer = (value: number) => new Intl.NumberFormat('es-AR').format(value || 0);

const formatDate = (value?: string | null) => {
  return value ? formatArgentinaDate(value) : 'Sin registros';
};

const formatFrozenLabel = (value?: string | null) => {
  if (!value) return 'Congelado';
  if (value === 'source-import') return 'Congelado PC';
  if (value === 'auto-january') return 'Auto enero';
  return 'Congelado';
};

const formatMonthLabel = (value: string) => formatArgentinaMonth(value);

const formatPercent = (value?: number | null) => {
  if (value === null || value === undefined) return 'Sin base';
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
};

export default function BalancesPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [currentYear, setCurrentYear] = useState<CurrentYearDetail | null>(null);
  const [annualHistory, setAnnualHistory] = useState<AnnualHistoryEntry[]>([]);
  const [monthlySalesAll, setMonthlySalesAll] = useState<MonthlySalesPoint[]>([]);
  const [selectedHistoryYear, setSelectedHistoryYear] = useState('');
  const [error, setError] = useState('');
  const [closeYearError, setCloseYearError] = useState('');
  const [closeYearMessage, setCloseYearMessage] = useState('');
  const [isClosingYear, setIsClosingYear] = useState(false);
  const loadOverview = async () => {
    try {
      setError('');
      const res = await fetchApiResponse('/admin/reports/overview', { cache: 'no-store' });
      if (!res.ok) throw new Error('No se pudieron cargar los balances');
      const data = await res.json();
      setSummary(data.summary || null);
      setCurrentYear(data.current_year_detail || null);
      setMonthlySalesAll(Array.isArray(data.monthly_sales_all) ? data.monthly_sales_all : []);
      setAnnualHistory((data.annual_history || []).filter((item: AnnualHistoryEntry) => item.year < (data.current_year_detail?.year || 9999)));
    } catch (err) {
      setError(getFriendlyApiError(err, 'Error cargando balances'));
    }
  };
  useEffect(() => {
    void loadOverview();
  }, []);

  const latestMonth = useMemo(
    () => currentYear?.months[currentYear.months.length - 1] || null,
    [currentYear]
  );

  const previousYears = useMemo(
    () => annualHistory.filter((item) => item.year >= 2021),
    [annualHistory]
  );

  const currentCapitalTotal = useMemo(() => {
    if (!summary) return 0;
    return summary.stock_value_sale + summary.cc_open_balance;
  }, [summary]);

  const rollingSales = useMemo(
    () =>
      monthlySalesAll
        .map((item) => ({
          month: String(item.month || ''),
          sales: Number(item.sales || 0),
          margin: Number(item.margin || 0),
          operating_result: Number(item.operating_result || 0),
          count: Number(item.count || 0),
        }))
        .filter((item) => item.month)
        .slice(-12),
    [monthlySalesAll]
  );

  const chartData = useMemo(() => {
    if (rollingSales.length === 0) return [];
    const width = 760;
    const height = 290;
    const paddingTop = 18;
    const paddingRight = 20;
    const paddingBottom = 52;
    const paddingLeft = 74;
    const maxSales = Math.max(...rollingSales.map((item) => item.sales), 1);
    const innerWidth = width - paddingLeft - paddingRight;
    const innerHeight = height - paddingTop - paddingBottom;

    return rollingSales.map((item, index) => {
      const x =
        rollingSales.length === 1
          ? paddingLeft + innerWidth / 2
          : paddingLeft + (index / (rollingSales.length - 1)) * innerWidth;
      const y = paddingTop + innerHeight - (item.sales / maxSales) * innerHeight;
      return {
        ...item,
        x,
        y,
        shortLabel: formatMonthLabel(item.month),
        fullLabel: (() => {
          return formatArgentinaShortMonthYear(item.month);
        })(),
      };
    });
  }, [rollingSales]);

  const chartMaxSales = useMemo(
    () => Math.max(...chartData.map((item) => item.sales), 1),
    [chartData]
  );

  const chartTicks = useMemo(() => {
    if (chartData.length === 0) return [];
    return Array.from({ length: 4 }, (_, index) => {
      const value = (chartMaxSales / 3) * (3 - index);
      const y = 18 + ((290 - 18 - 52) / 3) * index;
      return {
        value,
        y,
      };
    });
  }, [chartData, chartMaxSales]);

  const chartLinePath = useMemo(() => {
    if (chartData.length === 0) return '';
    return chartData
      .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`)
      .join(' ');
  }, [chartData]);

  const chartAreaPath = useMemo(() => {
    if (chartData.length === 0) return '';
    const first = chartData[0];
    const last = chartData[chartData.length - 1];
    const baseline = 290 - 52;
    return `${chartLinePath} L ${last.x} ${baseline} L ${first.x} ${baseline} Z`;
  }, [chartData, chartLinePath]);

  const historyYears = useMemo(
    () =>
      Array.from(
        new Set(
          monthlySalesAll
            .map((item) => String(item.month || '').slice(0, 4))
            .filter((value) => /^\d{4}$/.test(value))
        )
      ).sort((a, b) => Number(b) - Number(a)),
    [monthlySalesAll]
  );

  useEffect(() => {
    if (historyYears.length === 0 || selectedHistoryYear) return;
    const currentYearValue = currentYear?.year ?? 0;
    const preferredYear =
      historyYears.find((year) => Number(year) < currentYearValue) ||
      historyYears[0];
    setSelectedHistoryYear(preferredYear);
  }, [currentYear?.year, historyYears, selectedHistoryYear]);

  const historicalMonthlyItems = useMemo(
    () =>
      monthlySalesAll.filter((item) =>
        selectedHistoryYear ? String(item.month || '').startsWith(`${selectedHistoryYear}-`) : false
      ),
    [monthlySalesAll, selectedHistoryYear]
  );

  const previousYear = currentYear ? currentYear.year - 1 : 0;
  const previousYearSnapshot = useMemo(
    () => annualHistory.find((item) => item.year === previousYear),
    [annualHistory, previousYear]
  );
  const canClosePreviousYear =
    Boolean(currentYear) &&
    new Date().getMonth() === 0 &&
    previousYear > 0 &&
    !previousYearSnapshot?.is_frozen;

  const handleClosePreviousYear = async () => {
    if (!currentYear || previousYear <= 0 || !canClosePreviousYear) return;
    const confirmed = window.confirm(
      `Se va a congelar el balance contable de ${previousYear}. Hace esto solo antes de mover stock o registrar movimientos del nuevo año.`
    );
    if (!confirmed) return;
    try {
      setIsClosingYear(true);
      setCloseYearError('');
      setCloseYearMessage('');
      const res = await fetchApiResponse('/admin/reports/annual-close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ year: previousYear }),
      });
      if (!res.ok) throw new Error('No se pudo cerrar el año');
      setCloseYearMessage(`Cierre anual ${previousYear} guardado.`);
      await loadOverview();
    } catch (err) {
      setCloseYearError(getFriendlyApiError(err, 'Error cerrando el año'));
    } finally {
      setIsClosingYear(false);
    }
  };

  return (
    <div className={styles.page}>
      <section className={styles.header}>
        <div>
          <h1>Balances</h1>
          <p>Separado entre año corriente e historial anual para leer rápido los números clave.</p>
        </div>
        {canClosePreviousYear ? (
          <button type="button" className={styles.closeYearButton} onClick={handleClosePreviousYear} disabled={isClosingYear}>
            {isClosingYear ? `Cerrando ${previousYear}...` : `Cerrar ${previousYear}`}
          </button>
        ) : null}
      </section>

      {error ? <div className={styles.error}>{error}</div> : null}
      {closeYearError ? <div className={styles.error}>{closeYearError}</div> : null}
      {closeYearMessage ? <div className={styles.success}>{closeYearMessage}</div> : null}

      {summary && currentYear ? (
        <>
          <section className={styles.section}>
            <div className={styles.sectionHeader}>
              <div>
                <span className={styles.kicker}>Actual</span>
                <h2>Balance año corriente ({currentYear.year})</h2>
              </div>
              <p>Ultimo comprobante: {formatDate(summary.latest_invoice_at)}</p>
            </div>

            <div className={styles.topGrid}>
              <article className={styles.heroCard}>
                <span>Capital total de la empresa</span>
                <strong>{money(currentCapitalTotal)}</strong>
                <p>Stock a venta + saldo de cuentas corrientes.</p>
              </article>
              <article className={styles.statCard}>
                <span>Venta total anual</span>
                <strong>{money(currentYear.sales_total)}</strong>
                <p>Facturado acumulado en {currentYear.year}.</p>
              </article>
              <article className={styles.statCard}>
                <span>Resultado operativo</span>
                <strong>{money(currentYear.operating_result_total)}</strong>
                <p>Ganancia bruta menos gastos y comisiones.</p>
              </article>
              <article className={styles.statCard}>
                <span>Cuenta corriente abierta</span>
                <strong>{money(summary.cc_open_balance)}</strong>
                <p>Saldo actual pendiente de cobro.</p>
              </article>
            </div>

            <div className={styles.subGrid}>
              <article className={styles.panel}>
                <div className={styles.panelHeader}>
                  <div>
                    <h3>Ventas por mes</h3>
                    <p>Comparativo con el mismo mes del año anterior.</p>
                  </div>
                </div>

                {latestMonth ? (
                  <div className={styles.comparisonStrip}>
                    <div>
                      <span>Mes actual cargado</span>
                      <strong>{formatMonthLabel(latestMonth.month)}</strong>
                    </div>
                    <div>
                      <span>Ventas</span>
                      <strong>{money(latestMonth.sales)}</strong>
                    </div>
                    <div>
                      <span>Vs. año anterior</span>
                      <strong className={(latestMonth.sales_growth_pct || 0) >= 0 ? styles.positive : styles.negative}>
                        {formatPercent(latestMonth.sales_growth_pct)}
                      </strong>
                    </div>
                  </div>
                ) : null}

                {chartData.length > 0 ? (
                  <div className={styles.chartCard}>
                    <div className={styles.chartHeader}>
                      <div>
                        <h4>Ventas de los ultimos 12 meses</h4>
                        <p>Linea continua para detectar picos, caidas y ritmo comercial reciente.</p>
                      </div>
                      <div className={styles.chartSummary}>
                        <span>Pico</span>
                        <strong>{compactMoney(chartMaxSales)}</strong>
                      </div>
                    </div>

                    <div className={styles.chartWrap}>
                      <svg viewBox="0 0 760 290" className={styles.chart} role="img" aria-label="Grafico de ventas de los ultimos 12 meses">
                        <defs>
                          <linearGradient id="salesAreaGradient" x1="0" x2="0" y1="0" y2="1">
                            <stop offset="0%" stopColor="#06b6d4" stopOpacity="0.32" />
                            <stop offset="100%" stopColor="#06b6d4" stopOpacity="0.04" />
                          </linearGradient>
                        </defs>

                        {chartTicks.map((tick) => (
                          <g key={tick.y}>
                            <line
                              x1="74"
                              x2="740"
                              y1={tick.y}
                              y2={tick.y}
                              className={styles.chartGrid}
                            />
                            <text x="64" y={tick.y + 4} textAnchor="end" className={styles.chartAxisLabel}>
                              {compactMoney(tick.value)}
                            </text>
                          </g>
                        ))}

                        <path d={chartAreaPath} className={styles.chartArea} />
                        <path d={chartLinePath} className={styles.chartLine} />

                        {chartData.map((point) => (
                          <g key={point.month}>
                            <circle cx={point.x} cy={point.y} r="5.5" className={styles.chartPoint} />
                            <text x={point.x} y={point.y - 12} textAnchor="middle" className={styles.chartValueLabel}>
                              {compactMoney(point.sales)}
                            </text>
                            <text x={point.x} y="256" textAnchor="middle" className={styles.chartMonthLabel}>
                              {point.fullLabel}
                            </text>
                          </g>
                        ))}
                      </svg>
                    </div>
                  </div>
                ) : null}

                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th>Mes</th>
                        <th>Ventas {currentYear.year}</th>
                        <th>Ventas {currentYear.year - 1}</th>
                        <th>Var.</th>
                        <th>Margen {currentYear.year}</th>
                        <th>Margen {currentYear.year - 1}</th>
                        <th>Gastos {currentYear.year}</th>
                        <th>Gastos {currentYear.year - 1}</th>
                        <th>Var.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {currentYear.months.length === 0 ? (
                        <tr><td colSpan={9}>Todavia no hay movimientos para {currentYear.year}.</td></tr>
                      ) : (
                        currentYear.months.map((item) => (
                          <tr key={item.month}>
                            <td>{formatMonthLabel(item.month)}</td>
                            <td>{money(item.sales)}</td>
                            <td>{money(item.previous_year_sales)}</td>
                            <td className={(item.sales_growth_pct || 0) >= 0 ? styles.positive : styles.negative}>
                              {formatPercent(item.sales_growth_pct)}
                            </td>
                            <td>{money(item.margin_display ?? item.margin)}</td>
                            <td>{money(item.previous_year_margin_display ?? item.previous_year_margin)}</td>
                            <td>{money(item.expenses)}</td>
                            <td>{money(item.previous_year_expenses)}</td>
                            <td className={(item.margin_growth_pct || 0) >= 0 ? styles.positive : styles.negative}>
                              {formatPercent(item.margin_growth_pct)}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </article>

              <article className={styles.panel}>
                <div className={styles.panelHeader}>
                  <div>
                    <h3>Lectura rápida</h3>
                    <p>Capital actual y resultado del período separados correctamente.</p>
                  </div>
                </div>

                <div className={styles.breakdownList}>
                  <div className={styles.breakdownRow}>
                    <span>Stock a venta actual</span>
                    <strong>{money(summary.stock_value_sale)}</strong>
                  </div>
                  <div className={styles.breakdownRow}>
                    <span>Cuenta corriente actual</span>
                    <strong>{money(summary.cc_open_balance)}</strong>
                  </div>
                  <div className={`${styles.breakdownRow} ${styles.breakdownTotal}`}>
                    <span>Total actual</span>
                    <strong>{money(currentCapitalTotal)}</strong>
                  </div>
                </div>

                <div className={styles.breakdownList}>
                  <div className={styles.breakdownRow}>
                    <span>Margen bruto estimado</span>
                    <strong>{money(currentYear.margin_total)}</strong>
                  </div>
                  <div className={styles.breakdownRow}>
                    <span>Gastos del año</span>
                    <strong>{money(currentYear.expenses_total)}</strong>
                  </div>
                  <div className={styles.breakdownRow}>
                    <span>Comisiones del año</span>
                    <strong>{money(currentYear.commissions_total)}</strong>
                  </div>
                  <div className={styles.breakdownRow}>
                    <span>Compras del año</span>
                    <strong>{money(currentYear.purchases_total)}</strong>
                  </div>
                  <div className={`${styles.breakdownRow} ${styles.breakdownTotal}`}>
                    <span>Resultado operativo</span>
                    <strong>{money(currentYear.operating_result_total)}</strong>
                  </div>
                </div>
              </article>
            </div>
          </section>

          <section className={styles.section}>
            <div className={styles.sectionHeader}>
              <div>
                <span className={styles.kicker}>Historico</span>
                <h2>Balances anuales</h2>
              </div>
              <p>Ventas, ganancia y capital de cierre por año, con crecimiento porcentual.</p>
            </div>

            <div className={styles.note}>
              El capital total se calcula como stock valorizado a precio de venta más saldo de cuentas corrientes. Las compras se informan aparte como inversión y reposición de stock.
            </div>

            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Año</th>
                    <th>Vendí</th>
                    <th>Gan. bruta</th>
                    <th>Compré</th>
                    <th>Gasté</th>
                    <th>Comisiones</th>
                    <th>Resultado operativo</th>
                    <th>Cuenta corriente cierre</th>
                    <th>Capital total cierre</th>
                    <th>Crec. capital</th>
                  </tr>
                </thead>
                <tbody>
                  {previousYears.length === 0 ? (
                    <tr><td colSpan={10}>No hay balances anuales previos disponibles.</td></tr>
                  ) : (
                    previousYears.map((item) => (
                      <tr key={item.year}>
                        <td>
                          <div className={styles.yearCell}>
                            <strong>{item.year}</strong>
                            {item.is_frozen ? <span className={styles.frozenBadge}>{formatFrozenLabel(item.closure_mode)}</span> : null}
                            {item.is_frozen && item.closed_at ? (
                              <span className={styles.frozenMeta}>Cierre: {formatDate(item.closed_at)}</span>
                            ) : null}
                          </div>
                        </td>
                        <td>{money(item.sales)}</td>
                        <td>{money(item.margin)}</td>
                        <td>{money(item.purchases)}</td>
                        <td>{money(item.expenses)}</td>
                        <td>{money(item.commissions)}</td>
                        <td>{money(item.operating_result)}</td>
                        <td>{money(item.cc_balance_end)}</td>
                        <td>{money(item.capital_total)}</td>
                        <td className={(item.capital_growth_pct || 0) >= 0 ? styles.positive : styles.negative}>
                          {formatPercent(item.capital_growth_pct)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className={styles.section}>
            <div className={styles.sectionHeader}>
              <div>
                <span className={styles.kicker}>Mes A Mes</span>
                <h2>Historial mensual</h2>
              </div>
              <div className={styles.historyToolbar}>
                <label htmlFor="history-year" className={styles.historyLabel}>Año</label>
                <select
                  id="history-year"
                  className={styles.historySelect}
                  value={selectedHistoryYear}
                  onChange={(e) => setSelectedHistoryYear(e.target.value)}
                >
                  {historyYears.map((year) => (
                    <option key={year} value={year}>
                      {year}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className={styles.note}>
              Cuando un mes usa productos reutilizados y no conserva costo historico, el admin muestra un margen ajustado basado en la rentabilidad anual guardada en la app de escritorio.
            </div>

            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Mes</th>
                    <th>Ventas</th>
                    <th>Margen visible</th>
                    <th>Resultado operativo</th>
                    <th>Comprobantes</th>
                  </tr>
                </thead>
                <tbody>
                  {historicalMonthlyItems.length === 0 ? (
                    <tr><td colSpan={5}>No hay meses para el año seleccionado.</td></tr>
                  ) : (
                    historicalMonthlyItems.map((item) => (
                      <tr key={item.month}>
                        <td>{formatMonthLabel(item.month)}</td>
                        <td>{money(item.sales)}</td>
                        <td>{money(item.margin_display ?? item.margin)}</td>
                        <td>{money(item.adjusted_operating_result ?? item.operating_result)}</td>
                        <td>{integer(item.count)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
