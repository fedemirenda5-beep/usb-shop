'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { getApiBaseUrl, loadRuntimeConfig } from '@/lib/api';
import { ARGENTINA_TZ, formatArgentinaDateTime, getArgentinaNowDateInput } from '@/lib/datetime';
import styles from './ventas-vendedores.module.css';

type Seller = {
  id: number;
  name: string;
  commission_percent: number;
  is_active: boolean;
  created_at?: string | null;
  updated_at?: string | null;
};

type SellerMonthlySummary = {
  seller_id: number;
  name: string;
  commission_percent: number;
  sales: number;
  commission: number;
  invoice_count: number;
};

type SellerMonthlyInvoiceItem = {
  product_id?: number | null;
  product_name: string;
  quantity: number;
  unit_price: number;
  line_total: number;
};

type SellerMonthlyInvoice = {
  invoice_id: number;
  created_at?: string | null;
  document_type?: string | null;
  sale_mode?: string | null;
  payment_method?: string | null;
  notes?: string | null;
  customer_id?: number | null;
  customer_name: string;
  total: number;
  balance_due: number;
  special_discount: number;
  commission: number;
  items: SellerMonthlyInvoiceItem[];
};

type SellerMonthlyDetail = {
  period: string;
  seller: Seller;
  summary: {
    sales: number;
    commission: number;
    invoice_count: number;
  };
  items: SellerMonthlyInvoice[];
};

type InvoiceListItem = {
  id: number;
  customer_id?: number | null;
  customer_name: string;
  seller_id?: number | null;
  total: number;
  created_at: string;
  document_type?: string | null;
  sale_mode?: string | null;
  notes?: string | null;
  payment_method?: string | null;
  commission_amount?: number | null;
  special_discount?: number | null;
};

const money = (value: number) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(value || 0);

const formatPercent = (value: number) =>
  `${new Intl.NumberFormat('es-AR', {
    minimumFractionDigits: value % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value || 0)}%`;

const formatDate = (value?: string | null) => formatArgentinaDateTime(value);

const todayMonthInput = () => getArgentinaNowDateInput().slice(0, 7);

const roundMoney = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

const getErrorMessage = (error: unknown, fallback: string) => {
  if (error instanceof Error) {
    const normalized = error.message.trim().toLowerCase();
    if (
      normalized === 'failed to fetch' ||
      normalized === 'fetch failed' ||
      normalized.includes('networkerror') ||
      normalized.includes('load failed')
    ) {
      return 'No se pudo conectar con el servidor. Revisa la API y volve a intentar.';
    }
    return error.message;
  }
  return fallback;
};

const formatPeriodLabel = (period: string) => {
  const [year, month] = String(period || '').split('-');
  const parsed = new Date(Number(year), Number(month) - 1, 1);
  return Number.isNaN(parsed.getTime())
    ? period
    : parsed.toLocaleDateString('es-AR', { month: 'long', year: 'numeric', timeZone: ARGENTINA_TZ });
};

export default function VentasPorVendedorPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [period, setPeriod] = useState(searchParams.get('period') || todayMonthInput());
  const [summary, setSummary] = useState<SellerMonthlySummary[]>([]);
  const [detail, setDetail] = useState<SellerMonthlyDetail | null>(null);
  const [selectedSellerId, setSelectedSellerId] = useState<number | null>(
    Number(searchParams.get('seller') || 0) || null
  );
  const [loadingSummary, setLoadingSummary] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState('');

  const periodLabel = useMemo(() => formatPeriodLabel(period), [period]);

  const loadAvailableSellers = async () => {
    const sellerRes = await fetch(`${getApiBaseUrl()}/admin/sellers?limit=150`, {
      credentials: 'include',
      cache: 'no-store',
    });
    const sellerData = await sellerRes.json().catch(() => null);
    if (!sellerRes.ok) {
      throw new Error(sellerData?.detail || 'No se pudieron cargar los vendedores');
    }
    return Array.isArray(sellerData) ? (sellerData as Seller[]) : [];
  };

  const loadInvoiceList = async () => {
    const listRes = await fetch(`${getApiBaseUrl()}/admin/invoices?limit=300`, {
      credentials: 'include',
      cache: 'no-store',
    });
    const listData = await listRes.json().catch(() => null);
    if (!listRes.ok) {
      throw new Error(listData?.detail || 'No se pudieron cargar los comprobantes');
    }
    return Array.isArray(listData) ? (listData as InvoiceListItem[]) : [];
  };

  const buildSummaryFromInvoices = async (): Promise<SellerMonthlySummary[]> => {
    const sellers = (await loadAvailableSellers()).filter((seller) => seller.is_active);
    const invoices = await loadInvoiceList();
    const summaryMap = new Map<number, SellerMonthlySummary>();

    sellers.forEach((seller) => {
      summaryMap.set(seller.id, {
        seller_id: seller.id,
        name: seller.name,
        commission_percent: Number(seller.commission_percent || 0),
        sales: 0,
        commission: 0,
        invoice_count: 0,
      });
    });

    invoices.forEach((item) => {
      const sellerId = Number(item.seller_id || 0);
      const summaryItem = summaryMap.get(sellerId);
      const createdAt = typeof item.created_at === 'string' ? item.created_at.slice(0, 7) : '';
      const documentType = String(item.document_type || '').trim().toUpperCase();
      if (!summaryItem || createdAt !== period || documentType === 'PRESUPUESTO') {
        return;
      }
      const sign = documentType === 'NOTA_CREDITO' ? -1 : 1;
      summaryItem.sales = roundMoney(summaryItem.sales + Number(item.total || 0) * sign);
      summaryItem.commission = roundMoney(summaryItem.commission + Number(item.commission_amount || 0) * sign);
      summaryItem.invoice_count += 1;
    });

    return Array.from(summaryMap.values()).sort((a, b) => a.name.localeCompare(b.name, 'es-AR'));
  };

  const buildDetailFromInvoices = async (sellerId: number): Promise<SellerMonthlyDetail> => {
    const sellers = await loadAvailableSellers();
    const selectedSeller = sellers.find((seller) => seller.id === sellerId);
    if (!selectedSeller) {
      throw new Error('Vendedor no encontrado');
    }

    const invoices = await loadInvoiceList();
    const items = invoices
      .filter((item) => {
        const createdAt = typeof item.created_at === 'string' ? item.created_at.slice(0, 7) : '';
        const documentType = String(item.document_type || '').trim().toUpperCase();
        return Number(item.seller_id || 0) === sellerId && createdAt === period && documentType !== 'PRESUPUESTO';
      })
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .map((item) => {
        const documentType = String(item.document_type || '').trim().toUpperCase();
        const sign = documentType === 'NOTA_CREDITO' ? -1 : 1;
        return {
          invoice_id: item.id,
          created_at: item.created_at,
          document_type: item.document_type,
          sale_mode: item.sale_mode,
          payment_method: item.payment_method,
          notes: item.notes,
          customer_id: item.customer_id,
          customer_name: item.customer_name || 'Sin cliente',
          total: roundMoney(Number(item.total || 0) * sign),
          balance_due: roundMoney(Number(item.total || 0) * sign),
          special_discount: roundMoney(Number(item.special_discount || 0) * sign),
          commission: roundMoney(Number(item.commission_amount || 0) * sign),
          items: [],
        };
      });

    return {
      period,
      seller: selectedSeller,
      summary: {
        sales: roundMoney(items.reduce((sum, item) => sum + Number(item.total || 0), 0)),
        commission: roundMoney(items.reduce((sum, item) => sum + Number(item.commission || 0), 0)),
        invoice_count: items.length,
      },
      items,
    };
  };

  useEffect(() => {
    const params = new URLSearchParams(searchParams.toString());
    if (period) {
      params.set('period', period);
    } else {
      params.delete('period');
    }
    if (selectedSellerId) {
      params.set('seller', String(selectedSellerId));
    } else {
      params.delete('seller');
    }
    const nextQuery = params.toString();
    const currentQuery = searchParams.toString();
    if (nextQuery !== currentQuery) {
      router.replace(nextQuery ? `/admin/ventas-vendedores?${nextQuery}` : '/admin/ventas-vendedores');
    }
  }, [period, selectedSellerId, router, searchParams]);

  useEffect(() => {
    let active = true;

    const loadSummary = async () => {
      try {
        setLoadingSummary(true);
        setError('');
        await loadRuntimeConfig();
        const params = new URLSearchParams();
        if (period) {
          params.set('period', period);
        }
        const res = await fetch(`${getApiBaseUrl()}/admin/sellers/monthly-summary?${params.toString()}`, {
          credentials: 'include',
          cache: 'no-store',
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          throw new Error(data?.detail || 'No se pudo cargar el resumen por vendedor');
        }
        if (!active) return;
        const items = Array.isArray(data?.items) ? data.items : [];
        setSummary(items);
        setSelectedSellerId((current) => {
          if (current && items.some((item: SellerMonthlySummary) => item.seller_id === current)) {
            return current;
          }
          return items[0]?.seller_id ?? null;
        });
      } catch (err) {
        try {
          const fallbackItems = await buildSummaryFromInvoices();
          if (!active) return;
          setSummary(fallbackItems);
          setSelectedSellerId((current) => {
            if (current && fallbackItems.some((item) => item.seller_id === current)) {
              return current;
            }
            return fallbackItems[0]?.seller_id ?? null;
          });
        } catch (fallbackErr) {
          if (!active) return;
          setSummary([]);
          setSelectedSellerId(null);
          setDetail(null);
          setError(getErrorMessage(fallbackErr, 'Error cargando el resumen por vendedor'));
        }
      } finally {
        if (active) {
          setLoadingSummary(false);
        }
      }
    };

    void loadSummary();
    return () => {
      active = false;
    };
  }, [period]);

  useEffect(() => {
    if (!selectedSellerId) {
      setDetail(null);
      return;
    }

    let active = true;

    const loadDetail = async () => {
      try {
        setLoadingDetail(true);
        setError('');
        await loadRuntimeConfig();
        const params = new URLSearchParams({ period });
        const res = await fetch(`${getApiBaseUrl()}/admin/sellers/${selectedSellerId}/monthly-detail?${params.toString()}`, {
          credentials: 'include',
          cache: 'no-store',
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          throw new Error(data?.detail || 'No se pudo cargar el detalle del vendedor');
        }
        if (!active) return;
        setDetail(data);
      } catch (err) {
        try {
          const fallbackDetail = await buildDetailFromInvoices(selectedSellerId);
          if (!active) return;
          setDetail(fallbackDetail);
        } catch (fallbackErr) {
          if (!active) return;
          setDetail(null);
          setError(getErrorMessage(fallbackErr, 'Error cargando el detalle del vendedor'));
        }
      } finally {
        if (active) {
          setLoadingDetail(false);
        }
      }
    };

    void loadDetail();
    return () => {
      active = false;
    };
  }, [period, selectedSellerId]);

  return (
    <div className={styles.page}>
      <section className={styles.header}>
        <div>
          <h1>Ventas por vendedor</h1>
          <p>Reporte comercial mensual con total vendido, comprobantes asociados y comision acumulada.</p>
        </div>
        <label className={styles.periodFilter}>
          <span>Periodo</span>
          <input type="month" value={period} onChange={(event) => setPeriod(event.target.value)} />
        </label>
      </section>

      {error ? <div className={styles.errorBox}>{error}</div> : null}

      <section className={styles.panel}>
        <div className={styles.panelHeader}>
          <div>
            <h2>Resumen de {periodLabel}</h2>
            <p>Selecciona un vendedor para abrir el detalle completo de sus comprobantes.</p>
          </div>
        </div>

        {loadingSummary ? (
          <div className={styles.empty}>Cargando resumen mensual...</div>
        ) : summary.length === 0 ? (
          <div className={styles.empty}>No hay ventas registradas para el periodo seleccionado.</div>
        ) : (
          <div className={styles.summaryGrid}>
            {summary.map((item) => (
              <button
                key={item.seller_id}
                type="button"
                className={`${styles.summaryCard} ${selectedSellerId === item.seller_id ? styles.summaryCardActive : ''}`}
                onClick={() => setSelectedSellerId(item.seller_id)}
              >
                <div className={styles.summaryHeader}>
                  <strong>{item.name}</strong>
                  <span>{formatPercent(item.commission_percent)}</span>
                </div>
                <div className={styles.summaryMetrics}>
                  <div>
                    <span>Total vendido</span>
                    <strong>{money(item.sales)}</strong>
                  </div>
                  <div>
                    <span>Comision total</span>
                    <strong>{money(item.commission)}</strong>
                  </div>
                  <div>
                    <span>Comprobantes</span>
                    <strong>{item.invoice_count}</strong>
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </section>

      <section className={styles.panel}>
        <div className={styles.panelHeader}>
          <div>
            <h2>Detalle del vendedor</h2>
            <p>Detalle por comprobante con cliente, forma de venta, items y comision asignada.</p>
          </div>
        </div>

        {loadingDetail ? (
          <div className={styles.empty}>Cargando detalle del vendedor...</div>
        ) : !detail ? (
          <div className={styles.empty}>Selecciona un vendedor con ventas para ver el reporte.</div>
        ) : (
          <>
            <div className={styles.detailSummary}>
              <article className={styles.kpi}>
                <span>Vendedor</span>
                <strong>{detail.seller.name}</strong>
                <em>Comision base {formatPercent(detail.seller.commission_percent)}</em>
              </article>
              <article className={styles.kpi}>
                <span>Total vendido</span>
                <strong>{money(detail.summary.sales)}</strong>
                <em>Periodo {formatPeriodLabel(detail.period)}</em>
              </article>
              <article className={styles.kpi}>
                <span>Comision acumulada</span>
                <strong>{money(detail.summary.commission)}</strong>
                <em>{detail.summary.invoice_count} comprobantes</em>
              </article>
            </div>

            {detail.items.length === 0 ? (
              <div className={styles.empty}>No hay comprobantes para este vendedor en el periodo seleccionado.</div>
            ) : (
              <div className={styles.invoiceList}>
                {detail.items.map((invoice) => (
                  <article key={invoice.invoice_id} className={styles.invoiceCard}>
                    <div className={styles.invoiceHeader}>
                      <div>
                        <div className={styles.invoiceTitleRow}>
                          <strong>#{invoice.invoice_id} {invoice.document_type || 'Comprobante'}</strong>
                          <span className={styles.invoiceTag}>{invoice.sale_mode || 'Sin modo'}</span>
                        </div>
                        <p>{invoice.customer_name}</p>
                      </div>
                      <Link href={`/admin/comprobantes?invoice=${invoice.invoice_id}`} className={styles.invoiceLink}>
                        Ver comprobante
                      </Link>
                    </div>

                    <div className={styles.invoiceMeta}>
                      <div><span>Fecha</span><strong>{formatDate(invoice.created_at)}</strong></div>
                      <div><span>Pago</span><strong>{invoice.payment_method || '-'}</strong></div>
                      <div><span>Total venta</span><strong>{money(invoice.total)}</strong></div>
                      <div><span>Saldo</span><strong>{money(invoice.balance_due)}</strong></div>
                      <div><span>Comision</span><strong>{money(invoice.commission)}</strong></div>
                      <div><span>Descuento</span><strong>{money(invoice.special_discount)}</strong></div>
                    </div>

                    {invoice.notes ? <div className={styles.noteBox}>{invoice.notes}</div> : null}

                    <div className={styles.itemsWrap}>
                      <table className={styles.itemsTable}>
                        <thead>
                          <tr>
                            <th>Producto</th>
                            <th>Cantidad</th>
                            <th>Precio unitario</th>
                            <th>Total</th>
                          </tr>
                        </thead>
                        <tbody>
                          {invoice.items.length === 0 ? (
                            <tr>
                              <td colSpan={4}>Sin items para mostrar.</td>
                            </tr>
                          ) : (
                            invoice.items.map((item, index) => (
                              <tr key={`${invoice.invoice_id}-${item.product_id || index}`}>
                                <td>{item.product_name}</td>
                                <td>{item.quantity}</td>
                                <td>{money(item.unit_price)}</td>
                                <td>{money(item.line_total)}</td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
