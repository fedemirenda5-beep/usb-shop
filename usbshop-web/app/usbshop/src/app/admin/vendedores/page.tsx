'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { fetchApiResponse, getApiBaseUrl, loadRuntimeConfig } from '@/lib/api';
import { ARGENTINA_TZ, formatArgentinaDateTime, getArgentinaNowDateInput } from '@/lib/datetime';
import { openAdminSellerSettlementPrint } from '@/lib/adminSellerSettlementPrint';
import { useAdminSession } from '@/hooks/useAdminSession';
import { ADMIN_LIMITS } from '../adminConfig';
import { canViewProfitMetrics, canViewSellerCommissionBreakdown } from '../adminPermissions';
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

type SellerRangeSummary = {
  seller_id: number;
  sales_day: number;
  profit_day: number | null;
  commission_day: number;
  invoice_count_day: number;
  sales_week: number;
  profit_week: number | null;
  commission_week: number;
  invoice_count_week: number;
  sales_month: number;
  profit_month: number | null;
  commission_month: number;
  invoice_count_month: number;
  sales_year: number;
  profit_year: number | null;
  commission_year: number;
  invoice_count_year: number;
};

type DashboardPanel = 'overview' | 'ranking' | 'seller';
type PerformanceWindow = 'day' | 'week' | 'month' | 'year';
const SELLERS_AUTO_REFRESH_MS = 2 * 60 * 1000;

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
  scope: PerformanceWindow;
  range_start: string;
  range_end: string;
  seller: Seller;
  summary: {
    sales: number;
    commission: number;
    profit: number | null;
    invoice_count: number;
  };
  items: SellerMonthlyInvoice[];
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
const toDateInput = (value?: string | null) => {
  const match = String(value || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : '';
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
const formatShortDate = (value: string) => {
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', timeZone: ARGENTINA_TZ });
};

const roundMoney = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

const getWindowMetrics = (summary: SellerRangeSummary | null | undefined, window: PerformanceWindow) => {
  if (window === 'day') {
    return {
      sales: Number(summary?.sales_day || 0),
      profit: summary?.profit_day ?? null,
      commission: Number(summary?.commission_day || 0),
      invoices: Number(summary?.invoice_count_day || 0),
    };
  }
  if (window === 'week') {
    return {
      sales: Number(summary?.sales_week || 0),
      profit: summary?.profit_week ?? null,
      commission: Number(summary?.commission_week || 0),
      invoices: Number(summary?.invoice_count_week || 0),
    };
  }
  if (window === 'year') {
    return {
      sales: Number(summary?.sales_year || 0),
      profit: summary?.profit_year ?? null,
      commission: Number(summary?.commission_year || 0),
      invoices: Number(summary?.invoice_count_year || 0),
    };
  }
  return {
    sales: Number(summary?.sales_month || 0),
    profit: summary?.profit_month ?? null,
    commission: Number(summary?.commission_month || 0),
    invoices: Number(summary?.invoice_count_month || 0),
  };
};

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

export default function VendedoresPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const { user } = useAdminSession();
  const canViewProfit = canViewProfitMetrics(user?.role);
  const canViewCommissionBreakdown = canViewSellerCommissionBreakdown(user?.role);
  const [sellers, setSellers] = useState<Seller[]>([]);
  const [monthlySummary, setMonthlySummary] = useState<SellerMonthlySummary[]>([]);
  const [monthlyPeriod, setMonthlyPeriod] = useState(searchParams.get('period') || '');
  const [referenceDate, setReferenceDate] = useState(searchParams.get('date') || getArgentinaNowDateInput());
  const [rangeSummary, setRangeSummary] = useState<SellerRangeSummary[]>([]);
  const [selectedSellerId, setSelectedSellerId] = useState<number | null>(null);
  const [activePanel, setActivePanel] = useState<DashboardPanel>('overview');
  const [activeWindow, setActiveWindow] = useState<PerformanceWindow>('day');
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
  const detailScopeParam = searchParams.get('scope');
  const detailScope: PerformanceWindow =
    detailScopeParam === 'day' || detailScopeParam === 'week' || detailScopeParam === 'year' || detailScopeParam === 'month'
      ? detailScopeParam
      : 'month';
  const detailReferenceDate = searchParams.get('date') || referenceDate;
  const selectedSeller = sellers.find((seller) => seller.id === selectedSellerId) ?? null;
  const monthlySummaryMap = useMemo(
    () => new Map(monthlySummary.map((item) => [item.seller_id, item])),
    [monthlySummary]
  );
  const rangeSummaryMap = useMemo(
    () => new Map(rangeSummary.map((item) => [item.seller_id, item])),
    [rangeSummary]
  );
  const selectedSellerSummary = selectedSeller ? monthlySummaryMap.get(selectedSeller.id) ?? null : null;
  const selectedSellerRangeSummary = selectedSeller ? rangeSummaryMap.get(selectedSeller.id) ?? null : null;
  const weekRange = useMemo(() => getWeekRange(referenceDate), [referenceDate]);
  const formattedMonthlyPeriod = useMemo(() => {
    if (!monthlyPeriod) return 'ultimo periodo con ventas';
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
  const formattedDetailRange = useMemo(() => {
    if (!sellerDetail) return 'el periodo seleccionado';
    if (sellerDetail.scope === 'day') return `Dia ${formatShortDate(sellerDetail.range_start)}`;
    if (sellerDetail.scope === 'week') return `Semana ${formatShortDate(sellerDetail.range_start)} al ${formatShortDate(sellerDetail.range_end)}`;
    if (sellerDetail.scope === 'year') return `Ano ${sellerDetail.range_start.slice(0, 4)}`;
    return formattedDetailMonthlyPeriod;
  }, [formattedDetailMonthlyPeriod, sellerDetail]);
  const selectedWindowLabel = useMemo(() => {
    if (activeWindow === 'day') return `Dia ${formatShortDate(referenceDate)}`;
    if (activeWindow === 'week') return `Semana ${formatShortDate(weekRange.start)} al ${formatShortDate(weekRange.end)}`;
    if (activeWindow === 'year') return `Ano ${referenceDate.slice(0, 4)}`;
    return `Mes ${formattedMonthlyPeriod}`;
  }, [activeWindow, formattedMonthlyPeriod, referenceDate, weekRange.end, weekRange.start]);
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
  const sellerPerformanceRows = useMemo(
    () =>
      sellers.map((seller) => {
        const monthSummary = monthlySummaryMap.get(seller.id) ?? null;
        const rangeSummaryItem = rangeSummaryMap.get(seller.id) ?? null;
        const monthProfit = monthSummary?.profit ?? rangeSummaryItem?.profit_month ?? null;
        const monthCommission = Number(monthSummary?.commission ?? rangeSummaryItem?.commission_month ?? 0);
        const monthSales = Number(monthSummary?.sales ?? rangeSummaryItem?.sales_month ?? 0);
        const monthInvoices = Number(monthSummary?.invoice_count ?? rangeSummaryItem?.invoice_count_month ?? 0);
        const windowMetrics = activeWindow === 'month'
          ? { sales: monthSales, profit: monthProfit, commission: monthCommission, invoices: monthInvoices }
          : getWindowMetrics(rangeSummaryItem, activeWindow);
        const monthNet = monthProfit === null ? null : roundMoney(monthProfit - monthCommission);
        const windowNet = windowMetrics.profit === null ? null : roundMoney(windowMetrics.profit - windowMetrics.commission);
        const productivity = windowNet === null || windowMetrics.invoices <= 0 ? null : roundMoney(windowNet / windowMetrics.invoices);
        return {
          seller,
          monthSummary,
          rangeSummary: rangeSummaryItem,
          windowMetrics,
          monthSales,
          monthProfit,
          monthCommission,
          monthInvoices,
          monthNet,
          windowNet,
          productivity,
          efficiency:
            windowMetrics.sales > 0 && windowNet !== null ? roundMoney((windowNet / windowMetrics.sales) * 100) : null,
        };
      }),
    [activeWindow, monthlySummaryMap, rangeSummaryMap, sellers]
  );
  const rankedSellerPerformance = useMemo(
    () =>
      [...sellerPerformanceRows].sort((a, b) => {
        const left = a.windowNet ?? Number.NEGATIVE_INFINITY;
        const right = b.windowNet ?? Number.NEGATIVE_INFINITY;
        if (right !== left) return right - left;
        return b.windowMetrics.sales - a.windowMetrics.sales;
      }),
    [sellerPerformanceRows]
  );
  const totalWindowMetrics = useMemo(
    () =>
      sellerPerformanceRows.reduce(
        (acc, item) => {
          acc.sales = roundMoney(acc.sales + item.windowMetrics.sales);
          acc.commission = roundMoney(acc.commission + item.windowMetrics.commission);
          acc.invoices += item.windowMetrics.invoices;
          if (item.windowMetrics.profit !== null) {
            acc.profit = roundMoney((acc.profit ?? 0) + item.windowMetrics.profit);
          }
          return acc;
        },
        { sales: 0, commission: 0, profit: canViewProfit ? 0 : null as number | null, invoices: 0 }
      ),
    [canViewProfit, sellerPerformanceRows]
  );
  const totalWindowNet = canViewProfit && totalWindowMetrics.profit !== null
    ? roundMoney(totalWindowMetrics.profit - totalWindowMetrics.commission)
    : null;
  const averageTicket = totalWindowMetrics.invoices > 0 ? roundMoney(totalWindowMetrics.sales / totalWindowMetrics.invoices) : 0;
  const activeSellersWithSales = sellerPerformanceRows.filter((item) => item.windowMetrics.sales > 0).length;
  const bestSeller = rankedSellerPerformance[0] ?? null;
  const selectedSellerPerformance = selectedSeller
    ? sellerPerformanceRows.find((item) => item.seller.id === selectedSeller.id) ?? null
    : null;

  const loadSellers = async (query = '') => {
    try {
      setLoading(true);
      setError('');
      const params = new URLSearchParams({ limit: '150' });
      if (query.trim()) params.set('q', query.trim());
      const data = await queryClient.fetchQuery({
        queryKey: ['admin', 'sellers', 'list', params.toString()],
        queryFn: async () => {
          await loadRuntimeConfig();
          const res = await fetchApiResponse(`/admin/sellers?${params.toString()}`);
          if (!res.ok) {
            const payload = await res.json().catch(() => null);
            throw new Error(payload?.detail || 'No se pudieron cargar los vendedores');
          }
          return res.json();
        },
      });
      const nextSellers = Array.isArray(data) ? data : [];
      setSellers(nextSellers);
      setSelectedSellerId((currentId: number | null) => {
        if (showSellerForm) return currentId;
        if (currentId && nextSellers.some((item: Seller) => item.id === currentId)) return currentId;
        return nextSellers[0]?.id ?? null;
      });
    } catch (err) {
      setError(getErrorMessage(err, 'Error cargando vendedores'));
    } finally {
      setLoading(false);
    }
  };

  const loadMonthlySummary = async (silent = false) => {
    try {
      if (!silent) {
        setSummaryLoading(true);
      }
      const params = new URLSearchParams();
      if (monthlyPeriod) {
        params.set('period', monthlyPeriod);
      }
      const data = await queryClient.fetchQuery({
        queryKey: ['admin', 'sellers', 'monthly-summary', params.toString()],
        queryFn: async () => {
          await loadRuntimeConfig();
          const res = await fetchApiResponse(`/admin/sellers/monthly-summary?${params.toString()}`, { cache: 'no-store' });
          if (!res.ok) {
            const payload = await res.json().catch(() => null);
            throw new Error(payload?.detail || 'No se pudo cargar el resumen mensual');
          }
          return res.json();
        },
      });
      setMonthlySummary(Array.isArray(data.items) ? data.items : []);
      setMonthlyPeriod(typeof data.period === 'string' ? data.period : '');
    } catch (err) {
      setError(getErrorMessage(err, 'Error cargando resumen mensual'));
    } finally {
      if (!silent) {
        setSummaryLoading(false);
      }
    }
  };

  const loadRangeSummary = async (silent = false) => {
    try {
      if (!silent) {
        setSummaryLoading(true);
      }
      const params = new URLSearchParams({ reference_date: referenceDate });
      const data = await queryClient.fetchQuery({
        queryKey: ['admin', 'sellers', 'performance-summary', params.toString()],
        queryFn: async () => {
          await loadRuntimeConfig();
          const res = await fetchApiResponse(`/admin/sellers/performance-summary?${params.toString()}`, { cache: 'no-store' });
          const payload = await res.json().catch(() => null);
          if (!res.ok) {
            throw new Error(payload?.detail || 'No se pudo cargar el rendimiento de vendedores');
          }
          return payload;
        },
      });
      setRangeSummary(Array.isArray(data?.items) ? (data.items as SellerRangeSummary[]) : []);
    } catch (err) {
      setError(getErrorMessage(err, 'Error cargando resumen por periodo'));
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
  }, [monthlyPeriod]);

  useEffect(() => {
    if (!canViewCommissionBreakdown || sellers.length === 0) {
      setRangeSummary([]);
      return;
    }
    void loadRangeSummary();
  }, [canViewCommissionBreakdown, sellers, referenceDate]);

  useEffect(() => {
    const params = new URLSearchParams(searchParams.toString());
    if (monthlyPeriod) {
      params.set('period', monthlyPeriod);
    } else {
      params.delete('period');
    }
    const detailSellerParam = Number(searchParams.get('seller') || 0) || null;
    if (detailSellerParam) {
      params.set('seller', String(detailSellerParam));
    } else {
      params.delete('seller');
    }
    if (canViewCommissionBreakdown && referenceDate) {
      params.set('date', referenceDate);
    } else {
      params.delete('date');
    }
    const nextQuery = params.toString();
    const currentQuery = searchParams.toString();
    if (nextQuery !== currentQuery) {
      router.replace(nextQuery ? `/admin/vendedores?${nextQuery}` : '/admin/vendedores');
    }
  }, [canViewCommissionBreakdown, monthlyPeriod, referenceDate, router, searchParams]);

  useEffect(() => {
    if (!detailSellerId) {
      setSellerDetail(null);
      return;
    }
    const loadSellerDetail = async () => {
      try {
        setDetailLoading(true);
        setError('');
        try {
          const detailParams = new URLSearchParams();
          detailParams.set('scope', detailScope);
          if (detailScope === 'month' && monthlyPeriod) {
            detailParams.set('period', monthlyPeriod);
          }
          if (detailScope !== 'month') detailParams.set('reference_date', detailReferenceDate);
          const data = await queryClient.fetchQuery({
            queryKey: ['admin', 'sellers', 'monthly-detail', detailSellerId, detailParams.toString()],
            queryFn: async () => {
              await loadRuntimeConfig();
              const res = await fetchApiResponse(
                `/admin/sellers/${detailSellerId}/monthly-detail?${detailParams.toString()}`,
                { cache: 'no-store' }
              );
              const payload = await res.json().catch(() => null);
              if (!res.ok) {
                throw new Error(payload?.detail || 'No se pudo cargar el detalle mensual del vendedor');
              }
              return payload;
            },
          });
          setSellerDetail(data);
        } catch (detailErr) {
          throw detailErr;
        }
      } catch (err) {
        setSellerDetail(null);
        setError(getErrorMessage(err, 'Error cargando detalle del vendedor'));
      } finally {
        setDetailLoading(false);
      }
    };
    void loadSellerDetail();
  }, [detailReferenceDate, detailScope, detailSellerId, monthlyPeriod]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      if (document.visibilityState !== 'visible') {
        return;
      }
      void loadMonthlySummary(true);
      if (canViewCommissionBreakdown) {
        void loadRangeSummary(true);
      }
    }, SELLERS_AUTO_REFRESH_MS);

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void loadMonthlySummary(true);
        if (canViewCommissionBreakdown) {
          void loadRangeSummary(true);
        }
      }
    };

    const handleFocus = () => {
      void loadMonthlySummary(true);
      if (canViewCommissionBreakdown) {
        void loadRangeSummary(true);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleFocus);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleFocus);
    };
  }, [canViewCommissionBreakdown]);

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
    setActivePanel('seller');
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
    setActivePanel('seller');
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
      await queryClient.invalidateQueries({ queryKey: ['admin', 'sellers'] });
      await loadSellers(search);
      setSelectedSellerId(data.id);
      setShowSellerForm(false);
    } catch (err) {
      setError(getErrorMessage(err, 'Error guardando vendedor'));
    } finally {
      setSaving(false);
    }
  };

  const openSellerMonthlyDetail = (sellerId: number) => {
    const params = new URLSearchParams();
    params.set('scope', activeWindow);
    if (activeWindow === 'month' && monthlyPeriod) {
      params.set('period', monthlyPeriod);
    }
    if (activeWindow !== 'month') params.set('date', referenceDate);
    params.set('seller', String(sellerId));
    router.push(`/admin/vendedores?${params.toString()}`);
  };

  const printSellerSettlement = () => {
    if (!sellerDetail) return;
    openAdminSellerSettlementPrint({
      sellerName: sellerDetail.seller.name,
      rangeLabel: formattedDetailRange,
      sales: sellerDetail.summary.sales,
      commission: sellerDetail.summary.commission,
      invoiceCount: sellerDetail.summary.invoice_count,
      invoices: sortedSellerDetailItems,
    });
  };

  const closeSellerMonthlyDetail = () => {
    const params = new URLSearchParams();
    if (monthlyPeriod) {
      params.set('period', monthlyPeriod);
    }
    const nextQuery = params.toString();
    router.push(nextQuery ? `/admin/vendedores?${nextQuery}` : '/admin/vendedores');
  };

  if (detailSellerId) {
    return (
      <div className={styles.page}>
        <section className={styles.header}>
          <div>
            <h1>Detalle del vendedor</h1>
            <p>Solo lo necesario para leer el periodo y revisar sus ventas.</p>
          </div>
          <div className={styles.headerActions}>
            {detailScope === 'month' ? (
              <label className={styles.periodField}>
                <span>Periodo</span>
                <input
                  type="month"
                  value={monthlyPeriod}
                  onChange={(e) => setMonthlyPeriod(e.target.value)}
                />
              </label>
            ) : null}
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
                  <p>{formattedDetailRange}.</p>
                </div>
                <button type="button" className={styles.primaryButton} onClick={printSellerSettlement}>
                  Imprimir liquidacion
                </button>
              </div>

              <div className={styles.detailGrid}>
                <div className={styles.detailItem}>
                  <span>Vendio</span>
                  <strong>{money(sellerDetail.summary.sales)}</strong>
                </div>
                <div className={styles.detailItem}>
                  <span>Gana vendedor</span>
                  <strong>{money(sellerDetail.summary.commission)}</strong>
                </div>
                {canViewProfit && sellerDetail.summary.profit !== null ? (
                  <div className={styles.detailItem}>
                    <span>Gana empresa</span>
                    <strong>{money(roundMoney(sellerDetail.summary.profit - sellerDetail.summary.commission))}</strong>
                  </div>
                ) : null}
              </div>
            </section>

            <section className={styles.panel}>
              <div className={styles.panelHeader}>
                <div>
                  <h3>Ventas del periodo</h3>
                  <p>{formattedDetailRange}.</p>
                </div>
              </div>

              {sortedSellerDetailItems.length === 0 ? (
                <div className={styles.empty}>No hay ventas registradas para este vendedor en {formattedDetailRange}.</div>
              ) : (
                <div className={styles.saleTableWrap}>
                  <table className={styles.saleTable}>
                    <thead>
                      <tr>
                        <th>Cliente</th>
                        <th>Fecha</th>
                        <th>Vendio</th>
                        <th>Gana vendedor</th>
                        {canViewProfit ? <th>Gana empresa</th> : null}
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
                          <td>{money(item.total)}</td>
                          <td>{money(item.commission)}</td>
                          {canViewProfit ? <td>{money(roundMoney(Number(item.profit || 0) - Number(item.commission || 0)))}</td> : null}
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
          <p>Padron comercial unificado con ventas, comisiones y ganancia por vendedor.</p>
        </div>
        <div className={styles.headerActions}>
          {canViewCommissionBreakdown ? (
            <label className={styles.periodField}>
              <span>Fecha base</span>
              <input
                type="date"
                value={referenceDate}
                onChange={(e) => setReferenceDate(e.target.value)}
              />
            </label>
          ) : null}
          <label className={styles.periodField}>
            <span>Mes a consultar</span>
            <input
              type="month"
              value={monthlyPeriod}
              onChange={(e) => {
                setMonthlyPeriod(e.target.value);
                setActiveWindow('month');
              }}
            />
          </label>
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

      <section className={styles.panel}>
        <div className={styles.panelHeader}>
          <div>
            <h3>Tablero comercial</h3>
            <p>Usa los botones para mirar productividad sin mezclar toda la informacion en una sola vista.</p>
          </div>
        </div>
        <div className={styles.segmentedBar}>
          <div className={styles.segmentedGroup}>
            <button type="button" className={activePanel === 'overview' ? styles.segmentedActive : styles.segmentedButton} onClick={() => setActivePanel('overview')}>
              Resumen
            </button>
            <button type="button" className={activePanel === 'ranking' ? styles.segmentedActive : styles.segmentedButton} onClick={() => setActivePanel('ranking')}>
              Ranking
            </button>
            <button type="button" className={activePanel === 'seller' ? styles.segmentedActive : styles.segmentedButton} onClick={() => setActivePanel('seller')}>
              Ficha
            </button>
          </div>
          <div className={styles.segmentedGroup}>
            <button type="button" className={activeWindow === 'day' ? styles.segmentedActive : styles.segmentedButton} onClick={() => setActiveWindow('day')}>
              Dia
            </button>
            <button type="button" className={activeWindow === 'week' ? styles.segmentedActive : styles.segmentedButton} onClick={() => setActiveWindow('week')}>
              Semana
            </button>
            <button type="button" className={activeWindow === 'month' ? styles.segmentedActive : styles.segmentedButton} onClick={() => setActiveWindow('month')}>
              Mes
            </button>
            <button type="button" className={activeWindow === 'year' ? styles.segmentedActive : styles.segmentedButton} onClick={() => setActiveWindow('year')}>
              Ano
            </button>
          </div>
        </div>
        <div className={styles.boardHint}>
          {activeWindow === 'day'
            ? `Corte del dia ${formatShortDate(referenceDate)}.`
            : activeWindow === 'week'
              ? `Semana del ${formatShortDate(weekRange.start)} al ${formatShortDate(weekRange.end)}.`
              : activeWindow === 'year'
                ? `Ano calendario ${referenceDate.slice(0, 4)}.`
                : `Mes ${formattedMonthlyPeriod}.`}
          {' '}Doble click sobre un vendedor para abrir su detalle mensual.
        </div>
        <div className={styles.kpiGrid}>
          <article className={styles.kpiCard}>
            <span>Vendio</span>
            <strong>{money(totalWindowMetrics.sales)}</strong>
          </article>
          <article className={styles.kpiCard}>
            <span>Gana vendedor</span>
            <strong>{money(totalWindowMetrics.commission)}</strong>
          </article>
          <article className={styles.kpiCard}>
            <span>Ganancia empresa</span>
            <strong>{canViewProfit && totalWindowNet !== null ? money(totalWindowNet) : 'Sin permiso'}</strong>
          </article>
          <article className={styles.kpiCard}>
            <span>Periodo consultado</span>
            <strong>{selectedWindowLabel}</strong>
          </article>
        </div>
      </section>

      {activePanel === 'overview' ? (
        <>
          <div className={styles.tablePanel}>
            <div className={styles.tableMeta}>
              <span>{sellers.length} vendedores{search ? ` para "${search}"` : ''} | {selectedWindowLabel}</span>
            </div>
            <div className={styles.tableWrap}>
              {loading ? (
                <div className={styles.empty}>Cargando vendedores...</div>
              ) : sellers.length === 0 ? (
                <div className={styles.empty}>No hay vendedores cargados.</div>
              ) : (
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Vendedor</th>
                      <th>Vendio</th>
                      <th>Gana vendedor</th>
                      {canViewProfit ? <th>Gana empresa</th> : null}
                      <th>Acciones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sellerPerformanceRows.map((row) => (
                      <tr
                        key={row.seller.id}
                        className={row.seller.id === selectedSellerId ? styles.activeRow : ''}
                        onClick={() => {
                          setSelectedSellerId(row.seller.id);
                          setActivePanel('seller');
                        }}
                        onDoubleClick={() => openSellerMonthlyDetail(row.seller.id)}
                      >
                        <td>
                          <strong>{row.seller.name}</strong>
                          <span className={styles.metaLine}>{formatPercent(row.seller.commission_percent)} · actualizado {formatDate(row.seller.updated_at || row.seller.created_at)}</span>
                        </td>
                        <td>{money(row.windowMetrics.sales)}</td>
                        <td>{money(row.windowMetrics.commission)}</td>
                        {canViewProfit ? <td>{row.windowNet !== null ? money(row.windowNet) : 'Sin permiso'}</td> : null}
                        <td>
                          <button
                            type="button"
                            className={styles.secondaryButton}
                            onClick={(event) => {
                              event.stopPropagation();
                              setSelectedSellerId(row.seller.id);
                              setActivePanel('seller');
                            }}
                          >
                            Ver ficha
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </>
      ) : null}

      {activePanel === 'ranking' ? (
        <section className={styles.panel}>
          <div className={styles.panelHeader}>
            <div>
              <h3>Ranking de rentabilidad</h3>
              <p>Ordenado por lo que realmente deja a la empresa en el periodo elegido.</p>
            </div>
          </div>
          {summaryLoading ? (
            <div className={styles.empty}>Calculando ranking...</div>
          ) : rankedSellerPerformance.length === 0 ? (
            <div className={styles.empty}>No hay vendedores para analizar.</div>
          ) : (
            <div className={styles.rankingList}>
              {rankedSellerPerformance.map((row, index) => (
                <article key={`rank-${row.seller.id}`} className={styles.rankingCard}>
                  <div className={styles.rankingHeader}>
                    <div>
                      <span className={styles.rankBadge}>#{index + 1}</span>
                      <strong>{row.seller.name}</strong>
                    </div>
                    <button type="button" className={styles.secondaryButton} onClick={() => { setSelectedSellerId(row.seller.id); setActivePanel('seller'); }}>
                      Abrir ficha
                    </button>
                  </div>
                  <div className={styles.rankingMetrics}>
                    <div><span>Ventas</span><strong>{money(row.windowMetrics.sales)}</strong></div>
                    <div><span>Gana vendedor</span><strong>{money(row.windowMetrics.commission)}</strong></div>
                    <div><span>Gana empresa</span><strong>{canViewProfit && row.windowNet !== null ? money(row.windowNet) : 'Sin permiso'}</strong></div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {activePanel === 'seller' ? (
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
                <p>Resumen rapido para decidir si el vendedor es rentable y abrir su detalle mensual.</p>
              </div>
              <button type="button" className={styles.secondaryButton} onClick={() => editSeller(selectedSeller)}>
                Editar vendedor
              </button>
            </div>

            <div className={styles.detailGrid}>
              <div className={styles.detailItem}>
                <span>Vendio en el periodo</span>
                <strong>{money(selectedSellerPerformance?.windowMetrics.sales || 0)}</strong>
              </div>
              {canViewCommissionBreakdown ? (
                <div className={styles.detailItem}>
                  <span>Gana vendedor</span>
                  <strong>{money(selectedSellerPerformance?.windowMetrics.commission || 0)}</strong>
                </div>
              ) : null}
              {canViewProfit && selectedSellerPerformance?.windowMetrics.profit !== null ? (
                <div className={styles.detailItem}>
                  <span>Gana empresa</span>
                  <strong>{money(selectedSellerPerformance.windowNet || 0)}</strong>
                </div>
              ) : null}
              <div className={styles.detailItem}>
                <span>Periodo consultado</span>
                <strong>{selectedWindowLabel}</strong>
              </div>
            </div>
            <div className={styles.inlineActions}>
              <button type="button" className={styles.primaryButton} onClick={() => openSellerMonthlyDetail(selectedSeller.id)}>
                Ver ventas del periodo
              </button>
            </div>
          </div>
        ) : (
          <div className={styles.notice}>
            Selecciona un vendedor para ver su ficha o usa <strong>+ Nuevo vendedor</strong> para darlo de alta.
          </div>
        )}
      </section>
      ) : null}
    </div>
  );
}
