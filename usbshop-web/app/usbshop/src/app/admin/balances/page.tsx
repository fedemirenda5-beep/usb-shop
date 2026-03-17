'use client';

import { useEffect, useMemo, useState } from 'react';
import { getApiBaseUrl, loadRuntimeConfig } from '@/lib/api';
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
  count: number;
  previous_year_sales: number;
  previous_year_margin: number;
  sales_growth_pct?: number | null;
  margin_growth_pct?: number | null;
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
};

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
  return parsed.toLocaleDateString('es-AR', { month: 'long' });
};

const formatPercent = (value?: number | null) => {
  if (value === null || value === undefined) return 'Sin base';
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
};

export default function BalancesPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [currentYear, setCurrentYear] = useState<CurrentYearDetail | null>(null);
  const [annualHistory, setAnnualHistory] = useState<AnnualHistoryEntry[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    const load = async () => {
      try {
        await loadRuntimeConfig();
        const res = await fetch(`${getApiBaseUrl()}/admin/reports/overview`, { credentials: 'include' });
        if (!res.ok) throw new Error('No se pudieron cargar los balances');
        const data = await res.json();
        setSummary(data.summary || null);
        setCurrentYear(data.current_year_detail || null);
        setAnnualHistory((data.annual_history || []).filter((item: AnnualHistoryEntry) => item.year < (data.current_year_detail?.year || 9999)));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error cargando balances');
      }
    };
    void load();
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

  return (
    <div className={styles.page}>
      <section className={styles.header}>
        <div>
          <h1>Balances</h1>
          <p>Separado entre año corriente e historial anual para leer rápido los números clave.</p>
        </div>
      </section>

      {error ? <div className={styles.error}>{error}</div> : null}

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

                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th>Mes</th>
                        <th>Ventas {currentYear.year}</th>
                        <th>Ventas {currentYear.year - 1}</th>
                        <th>Var.</th>
                        <th>Ganancia {currentYear.year}</th>
                        <th>Ganancia {currentYear.year - 1}</th>
                        <th>Var.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {currentYear.months.length === 0 ? (
                        <tr><td colSpan={7}>Todavia no hay movimientos para {currentYear.year}.</td></tr>
                      ) : (
                        currentYear.months.map((item) => (
                          <tr key={item.month}>
                            <td>{formatMonthLabel(item.month)}</td>
                            <td>{money(item.sales)}</td>
                            <td>{money(item.previous_year_sales)}</td>
                            <td className={(item.sales_growth_pct || 0) >= 0 ? styles.positive : styles.negative}>
                              {formatPercent(item.sales_growth_pct)}
                            </td>
                            <td>{money(item.margin)}</td>
                            <td>{money(item.previous_year_margin)}</td>
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
                    <span>Ganancia bruta estimada</span>
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
                        <td>{item.year}</td>
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
        </>
      ) : null}
    </div>
  );
}
