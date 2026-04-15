'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { getApiBaseUrl, loadRuntimeConfig } from '@/lib/api';
import { ARGENTINA_TZ, formatArgentinaDateTime } from '@/lib/datetime';
import { useAdminSession } from '@/hooks/useAdminSession';
import { canViewProfitMetrics } from '../adminPermissions';
import styles from './vendedores.module.css';

type Seller = {
  id: number;
  name: string;
  commission_percent: number;
  is_active: boolean;
  created_at?: string | null;
  updated_at?: string | null;
};

type SellerFormState = {
  name: string;
  commission_percent: string;
  is_active: boolean;
};

type SellerMonthlySummary = {
  seller_id: number;
  name: string;
  commission_percent: number;
  sales: number;
  profit: number | null;
  commission: number;
  invoice_count: number;
};

type SellerMonthlyInvoiceItem = {
  product_id?: number | null;
  product_name: string;
  quantity: number;
  unit_price: number;
  line_total: number;
  cost_total: number;
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
  profit: number | null;
  items: SellerMonthlyInvoiceItem[];
};

type SellerMonthlyDetail = {
  period: string;
  seller: Seller;
  summary: {
    sales: number;
    commission: number;
    profit: number | null;
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

type InvoiceDetailResponse = {
  invoice: {
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
  summary?: {
    balance_due?: number | null;
  };
  items: Array<{
    product_id?: number | null;
    product_name: string;
    quantity: number;
    unit_price: number;
    line_total: number;
  }>;
};

const emptySellerForm = (): SellerFormState => ({
  name: '',
  commission_percent: '0',
  is_active: true,
});

const formatPercent = (value: number) =>
  `${new Intl.NumberFormat('es-AR', {
    minimumFractionDigits: value % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value || 0)}%`;

const money = (value: number) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(value || 0);

const formatDate = (value?: string | null) => formatArgentinaDateTime(value);

const currentPeriodKey = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
};

export default function VendedoresPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useAdminSession();
  const canViewProfit = canViewProfitMetrics(user?.role);
  const [sellers, setSellers] = useState<Seller[]>([]);
  const [monthlySummary, setMonthlySummary] = useState<SellerMonthlySummary[]>([]);
  const [monthlyPeriod, setMonthlyPeriod] = useState('');
  const [selectedSellerId, setSelectedSellerId] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [showSellerForm, setShowSellerForm] = useState(false);
  const [sellerDetail, setSellerDetail] = useState<SellerMonthlyDetail | null>(null);
  const [sellerForm, setSellerForm] = useState<SellerFormState>(emptySellerForm);

  const detailSellerId = Number(searchParams.get('seller') || 0) || null;
  const selectedSeller = sellers.find((seller) => seller.id === selectedSellerId) ?? null;
  const monthlySummaryMap = useMemo(
    () => new Map(monthlySummary.map((item) => [item.seller_id, item])),
    [monthlySummary]
  );
  const selectedSellerSummary = selectedSeller ? monthlySummaryMap.get(selectedSeller.id) ?? null : null;
  const formattedMonthlyPeriod = useMemo(() => {
    if (!monthlyPeriod) return 'este mes';
    const [year, month] = monthlyPeriod.split('-');
    const parsed = new Date(Number(year), Number(month) - 1, 1);
    return Number.isNaN(parsed.getTime())
      ? monthlyPeriod
      : parsed.toLocaleDateString('es-AR', { month: 'long', year: 'numeric', timeZone: ARGENTINA_TZ });
  }, [monthlyPeriod]);
  const formattedDetailMonthlyPeriod = useMemo(() => {
    if (!sellerDetail?.period) return 'este mes';
    const [year, month] = sellerDetail.period.split('-');
    const parsed = new Date(Number(year), Number(month) - 1, 1);
    return Number.isNaN(parsed.getTime())
      ? sellerDetail.period
      : parsed.toLocaleDateString('es-AR', { month: 'long', year: 'numeric', timeZone: ARGENTINA_TZ });
  }, [sellerDetail?.period]);
  const sortedSellerDetailItems = useMemo(() => {
    if (!sellerDetail?.items) return [];
    return [...sellerDetail.items].sort((a, b) => {
      const left = new Date(b.created_at || '').getTime();
      const right = new Date(a.created_at || '').getTime();
      if (Number.isNaN(left) && Number.isNaN(right)) {
        return b.invoice_id - a.invoice_id;
      }
      if (Number.isNaN(left)) return -1;
      if (Number.isNaN(right)) return 1;
      if (left !== right) return left - right;
      return b.invoice_id - a.invoice_id;
    });
  }, [sellerDetail?.items]);

  const buildSellerDetailFromInvoices = async (sellerId: number): Promise<SellerMonthlyDetail> => {
    const selected = sellers.find((seller) => seller.id === sellerId);
    if (!selected) {
      throw new Error('Vendedor no encontrado');
    }

    const period = monthlyPeriod || currentPeriodKey();
    const listRes = await fetch(`${getApiBaseUrl()}/admin/invoices?limit=300`, {
      credentials: 'include',
      cache: 'no-store',
    });
    const listData = await listRes.json().catch(() => null);
    if (!listRes.ok) {
      throw new Error(listData?.detail || 'No se pudieron cargar los comprobantes del vendedor');
    }

    const filteredInvoices = (Array.isArray(listData) ? listData : [])
      .filter((item: InvoiceListItem) => {
        const createdAt = typeof item.created_at === 'string' ? item.created_at.slice(0, 7) : '';
        const documentType = String(item.document_type || '').trim().toUpperCase();
        return (
          Number(item.seller_id || 0) === sellerId &&
          createdAt === period &&
          documentType !== 'PRESUPUESTO'
        );
      })
      .sort((a: InvoiceListItem, b: InvoiceListItem) => {
        const left = new Date(b.created_at).getTime();
        const right = new Date(a.created_at).getTime();
        return left - right;
      });

    const items = filteredInvoices.map((item: InvoiceListItem) => ({
      invoice_id: item.id,
      created_at: item.created_at,
      document_type: item.document_type,
      sale_mode: item.sale_mode,
      payment_method: item.payment_method,
      notes: item.notes,
      customer_id: item.customer_id,
      customer_name: item.customer_name || 'Sin cliente',
      total: Number(item.total || 0),
      balance_due: Number(item.total || 0),
      special_discount: Number(item.special_discount || 0),
      commission: Number(item.commission_amount || 0),
      profit: null,
      items: [],
    }));

    return {
      period,
      seller: selected,
      summary: {
        sales: items.reduce((sum, item) => sum + Number(item.total || 0), 0),
        commission: items.reduce((sum, item) => sum + Number(item.commission || 0), 0),
        profit: null,
        invoice_count: items.length,
      },
      items,
    };
  };

  const loadSellers = async (query = '') => {
    try {
      setLoading(true);
      setError('');
      const params = new URLSearchParams({ limit: '150' });
      if (query.trim()) params.set('q', query.trim());
      await loadRuntimeConfig();
      const res = await fetch(`${getApiBaseUrl()}/admin/sellers?${params.toString()}`, {
        credentials: 'include',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.detail || 'No se pudieron cargar los vendedores');
      }
      const data = await res.json();
      setSellers(data);
      setSelectedSellerId((currentId: number | null) => {
        if (showSellerForm) return currentId;
        if (currentId && data.some((item: Seller) => item.id === currentId)) return currentId;
        return data[0]?.id ?? null;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error cargando vendedores');
    } finally {
      setLoading(false);
    }
  };

  const loadMonthlySummary = async (silent = false) => {
    try {
      if (!silent) {
        setSummaryLoading(true);
      }
      await loadRuntimeConfig();
      const res = await fetch(`${getApiBaseUrl()}/admin/sellers/monthly-summary`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.detail || 'No se pudo cargar el resumen mensual');
      }
      const data = await res.json();
      setMonthlySummary(Array.isArray(data.items) ? data.items : []);
      setMonthlyPeriod(typeof data.period === 'string' ? data.period : '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error cargando resumen mensual');
    } finally {
      if (!silent) {
        setSummaryLoading(false);
      }
    }
  };

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void loadSellers(search);
    }, 250);
    return () => window.clearTimeout(timeoutId);
  }, [search]);

  useEffect(() => {
    void loadMonthlySummary();
  }, []);

  useEffect(() => {
    if (!detailSellerId) {
      setSellerDetail(null);
      return;
    }
    const loadSellerDetail = async () => {
      try {
        setDetailLoading(true);
        setError('');
        await loadRuntimeConfig();
        try {
          const res = await fetch(`${getApiBaseUrl()}/admin/sellers/${detailSellerId}/monthly-detail`, {
            credentials: 'include',
            cache: 'no-store',
          });
          const data = await res.json().catch(() => null);
          if (!res.ok) {
            throw new Error(data?.detail || 'No se pudo cargar el detalle mensual del vendedor');
          }
          setSellerDetail(data);
        } catch {
          const fallbackDetail = await buildSellerDetailFromInvoices(detailSellerId);
          setSellerDetail(fallbackDetail);
        }
      } catch (err) {
        setSellerDetail(null);
        setError(err instanceof Error ? err.message : 'Error cargando detalle del vendedor');
      } finally {
        setDetailLoading(false);
      }
    };
    void loadSellerDetail();
  }, [detailSellerId]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      if (document.visibilityState !== 'visible') {
        return;
      }
      void loadMonthlySummary(true);
    }, 30000);

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void loadMonthlySummary(true);
      }
    };

    const handleFocus = () => {
      void loadMonthlySummary(true);
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleFocus);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleFocus);
    };
  }, []);

  const handleSellerFormChange = (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const { name, type, checked, value } = e.target;
    setSellerForm((prev) => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value,
    }));
  };

  const resetForNewSeller = () => {
    setSelectedSellerId(null);
    setSellerForm(emptySellerForm());
    setShowSellerForm(true);
    setError('');
  };

  const editSeller = (seller: Seller) => {
    setSelectedSellerId(seller.id);
    setSellerForm({
      name: seller.name,
      commission_percent: String(seller.commission_percent ?? 0),
      is_active: seller.is_active,
    });
    setShowSellerForm(true);
    setError('');
  };

  const saveSeller = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const commission = Number(sellerForm.commission_percent.replace(',', '.'));
      if (Number.isNaN(commission) || commission < 0) {
        throw new Error('La comision debe ser un numero mayor o igual a 0');
      }
      await loadRuntimeConfig();
      const url = selectedSellerId
        ? `${getApiBaseUrl()}/admin/sellers/${selectedSellerId}`
        : `${getApiBaseUrl()}/admin/sellers`;
      const method = selectedSellerId ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: sellerForm.name,
          commission_percent: commission,
          is_active: sellerForm.is_active,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.detail || 'No se pudo guardar el vendedor');
      }
      const data = await res.json();
      await loadSellers(search);
      setSelectedSellerId(data.id);
      setShowSellerForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error guardando vendedor');
    } finally {
      setSaving(false);
    }
  };

  const openSellerMonthlyDetail = (sellerId: number) => {
    router.push(`/admin/vendedores?seller=${sellerId}`);
  };

  const closeSellerMonthlyDetail = () => {
    router.push('/admin/vendedores');
  };

  if (detailSellerId) {
    return (
      <div className={styles.page}>
        <section className={styles.header}>
          <div>
            <h1>Detalle mensual del vendedor</h1>
            <p>Ventas del mes, cliente asociado y acceso a cada comprobante.</p>
          </div>
          <div className={styles.headerActions}>
            <button type="button" className={styles.secondaryButton} onClick={closeSellerMonthlyDetail}>
              Volver a vendedores
            </button>
          </div>
        </section>

        {error ? <div className={styles.errorBox}>{error}</div> : null}

        {detailLoading ? (
          <div className={styles.empty}>Cargando detalle mensual...</div>
        ) : !sellerDetail ? (
          <div className={styles.empty}>No se pudo cargar el vendedor.</div>
        ) : (
          <>
            <section className={styles.panel}>
              <div className={styles.panelHeader}>
                <div>
                  <h2>{sellerDetail.seller.name}</h2>
                  <p>Periodo {formattedDetailMonthlyPeriod}.</p>
                </div>
                <span className={sellerDetail.seller.is_active ? styles.activeBadge : styles.inactiveBadge}>
                  {sellerDetail.seller.is_active ? 'Activo' : 'Inactivo'}
                </span>
              </div>

              <div className={styles.detailGrid}>
                <div className={styles.detailItem}>
                  <span>Comision actual</span>
                  <strong>{formatPercent(sellerDetail.seller.commission_percent)}</strong>
                </div>
                <div className={styles.detailItem}>
                  <span>Venta del mes</span>
                  <strong>{money(sellerDetail.summary.sales)}</strong>
                </div>
                <div className={styles.detailItem}>
                  <span>Comprobantes</span>
                  <strong>{sellerDetail.summary.invoice_count}</strong>
                </div>
                <div className={styles.detailItem}>
                  <span>Comision acumulada</span>
                  <strong>{money(sellerDetail.summary.commission)}</strong>
                </div>
                {canViewProfit ? (
                  <div className={styles.detailItem}>
                    <span>Ganancia estimada</span>
                    <strong>{money(sellerDetail.summary.profit || 0)}</strong>
                  </div>
                ) : null}
                <div className={styles.detailItem}>
                  <span>Ultima actualizacion</span>
                  <strong>{formatDate(sellerDetail.seller.updated_at || sellerDetail.seller.created_at)}</strong>
                </div>
              </div>
            </section>

            <section className={styles.panel}>
              <div className={styles.panelHeader}>
                <div>
                  <h3>Ventas del mes</h3>
                  <p>Listado compacto por venta para administrar mejor el espacio.</p>
                </div>
              </div>

              {sortedSellerDetailItems.length === 0 ? (
                <div className={styles.empty}>No hay ventas registradas para este vendedor en {formattedDetailMonthlyPeriod}.</div>
              ) : (
                <div className={styles.saleTableWrap}>
                  <table className={styles.saleTable}>
                    <thead>
                      <tr>
                        <th>Cliente</th>
                        <th>Fecha</th>
                        <th>Comprobante</th>
                        <th>Modo</th>
                        <th>Total</th>
                        <th>Saldo</th>
                        <th>Accion</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedSellerDetailItems.map((item) => (
                        <tr key={item.invoice_id}>
                          <td>
                            <div className={styles.saleCustomerCell}>
                              <strong>{item.customer_name}</strong>
                              {item.notes ? <span>{item.notes}</span> : null}
                            </div>
                          </td>
                          <td>{formatDate(item.created_at)}</td>
                          <td>#{item.invoice_id} {item.document_type || 'Comprobante'}</td>
                          <td>{item.sale_mode || '-'}</td>
                          <td>{money(item.total)}</td>
                          <td>{money(item.balance_due)}</td>
                          <td>
                            <Link href={`/admin/comprobantes?invoice=${item.invoice_id}`} className={styles.rowLink}>
                              Ver comprobante
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1>Vendedores</h1>
          <p>Alta y mantenimiento de vendedores con comision asignada.</p>
        </div>
        <div className={styles.headerActions}>
          <button type="button" className={styles.primaryButton} onClick={resetForNewSeller}>
            + Nuevo vendedor
          </button>
        </div>
      </div>

      {error ? <div className={styles.errorBox}>{error}</div> : null}

      <div className={styles.searchBar}>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar vendedor por nombre"
        />
      </div>

      <div className={styles.tablePanel}>
        <div className={styles.tableMeta}>
          <span>{sellers.length} vendedores{search ? ` para "${search}"` : ''}</span>
        </div>
        <div className={styles.boardHint}>Doble click sobre un vendedor para abrir el detalle de sus ventas del mes.</div>
        <div className={styles.tableWrap}>
          {loading ? (
            <div className={styles.empty}>Cargando vendedores...</div>
          ) : sellers.length === 0 ? (
            <div className={styles.empty}>No hay vendedores cargados.</div>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Vendedor</th>
                  <th>Comision</th>
                  <th>Venta mes</th>
                  <th>Comprobantes</th>
                  <th>Estado</th>
                  <th>Actualizado</th>
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {sellers.map((seller) => {
                  const sellerSummary = monthlySummaryMap.get(seller.id);
                  return (
                    <tr
                      key={seller.id}
                      className={seller.id === selectedSellerId ? styles.activeRow : ''}
                      onClick={() => setSelectedSellerId(seller.id)}
                      onDoubleClick={() => openSellerMonthlyDetail(seller.id)}
                    >
                      <td>{seller.id}</td>
                      <td>
                        <strong>{seller.name}</strong>
                        <span className={styles.metaLine}>
                          Creado: {formatDate(seller.created_at)}
                        </span>
                      </td>
                      <td>{formatPercent(seller.commission_percent)}</td>
                      <td>{money(sellerSummary?.sales || 0)}</td>
                      <td>{sellerSummary?.invoice_count || 0}</td>
                      <td>
                        <span className={seller.is_active ? styles.activeBadge : styles.inactiveBadge}>
                          {seller.is_active ? 'Activo' : 'Inactivo'}
                        </span>
                      </td>
                      <td>{formatDate(seller.updated_at || seller.created_at)}</td>
                      <td>
                        <button
                          type="button"
                          className={styles.secondaryButton}
                          onClick={(event) => {
                            event.stopPropagation();
                            editSeller(seller);
                          }}
                        >
                          Editar
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <section className={styles.panel}>
        <div className={styles.panelHeader}>
          <div>
            <h3>Resumen mensual por vendedor</h3>
            <p>
              {canViewProfit
                ? `Ventas y ganancia estimada de ${formattedMonthlyPeriod} para los vendedores activos.`
                : `Ventas y comisiones de ${formattedMonthlyPeriod} para los vendedores activos.`}
            </p>
          </div>
        </div>

        {summaryLoading ? (
          <div className={styles.empty}>Cargando resumen mensual...</div>
        ) : monthlySummary.length === 0 ? (
          <div className={styles.empty}>No hay ventas registradas este mes para vendedores activos.</div>
        ) : (
          <div className={styles.monthlySummaryGrid}>
            {monthlySummary.map((item) => (
              <article key={item.seller_id} className={styles.summaryCard}>
                <div className={styles.summaryHeader}>
                  <strong>{item.name}</strong>
                  <span>{formatPercent(item.commission_percent)}</span>
                </div>
                <div className={styles.summaryMetrics}>
                  <div>
                    <span>Venta del mes</span>
                    <strong>{money(item.sales)}</strong>
                  </div>
                  <div>
                    <span>Comision</span>
                    <strong>{money(item.commission)}</strong>
                  </div>
                  {canViewProfit ? (
                    <div>
                      <span>Ganancia</span>
                      <strong>{money(item.profit || 0)}</strong>
                    </div>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className={styles.main}>
        {showSellerForm ? (
          <div className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <h2>{selectedSellerId ? 'Editar vendedor' : 'Nuevo vendedor'}</h2>
                <p>Defini nombre comercial y porcentaje de comision.</p>
              </div>
            </div>

            <form className={styles.formGrid} onSubmit={saveSeller}>
              <label>
                Nombre
                <input
                  name="name"
                  value={sellerForm.name}
                  onChange={handleSellerFormChange}
                  required
                />
              </label>
              <label>
                Comision (%)
                <input
                  name="commission_percent"
                  type="number"
                  step="0.01"
                  min="0"
                  value={sellerForm.commission_percent}
                  onChange={handleSellerFormChange}
                  required
                />
              </label>
              <label className={styles.checkboxField}>
                <input
                  name="is_active"
                  type="checkbox"
                  checked={sellerForm.is_active}
                  onChange={handleSellerFormChange}
                />
                <span>Vendedor activo</span>
              </label>
              <div className={styles.formActions}>
                <button type="submit" className={styles.primaryButton} disabled={saving}>
                  {saving ? 'Guardando...' : selectedSellerId ? 'Guardar cambios' : 'Crear vendedor'}
                </button>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={() => setShowSellerForm(false)}
                >
                  Cancelar
                </button>
              </div>
            </form>
          </div>
        ) : null}

        {selectedSeller ? (
          <div className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <h3>Ficha del vendedor</h3>
                <p>Resumen rapido para consultar y editar sin perder la grilla.</p>
              </div>
              <button type="button" className={styles.secondaryButton} onClick={() => editSeller(selectedSeller)}>
                Editar vendedor
              </button>
            </div>

            <div className={styles.detailGrid}>
              <div className={styles.detailItem}>
                <span>Nombre</span>
                <strong>{selectedSeller.name}</strong>
              </div>
              <div className={styles.detailItem}>
                <span>Comision actual</span>
                <strong>{formatPercent(selectedSeller.commission_percent)}</strong>
              </div>
              <div className={styles.detailItem}>
                <span>Venta del mes</span>
                <strong>{money(selectedSellerSummary?.sales || 0)}</strong>
              </div>
              <div className={styles.detailItem}>
                <span>Comprobantes del mes</span>
                <strong>{selectedSellerSummary?.invoice_count || 0}</strong>
              </div>
              <div className={styles.detailItem}>
                <span>Comision acumulada</span>
                <strong>{money(selectedSellerSummary?.commission || 0)}</strong>
              </div>
              {canViewProfit ? (
                <div className={styles.detailItem}>
                  <span>Ganancia estimada</span>
                  <strong>{money(selectedSellerSummary?.profit || 0)}</strong>
                </div>
              ) : null}
              <div className={styles.detailItem}>
                <span>Estado</span>
                <strong>{selectedSeller.is_active ? 'Activo' : 'Inactivo'}</strong>
              </div>
              <div className={styles.detailItem}>
                <span>Ultima actualizacion</span>
                <strong>{formatDate(selectedSeller.updated_at || selectedSeller.created_at)}</strong>
              </div>
            </div>
            <div className={styles.inlineActions}>
              <Link href={`/admin/vendedores?seller=${selectedSeller.id}`} className={styles.primaryButton}>
                Ver ventas del mes
              </Link>
            </div>
          </div>
        ) : (
          <div className={styles.notice}>
            Selecciona un vendedor para ver su ficha o usa <strong>+ Nuevo vendedor</strong> para darlo de alta.
          </div>
        )}
      </section>
    </div>
  );
}
