'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { getApiBaseUrl, loadRuntimeConfig } from '@/lib/api';
import { ARGENTINA_TZ, formatArgentinaDateTime, getArgentinaNowDateInput } from '@/lib/datetime';
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
  commission_day: number;
  invoice_count_day: number;
  sales_week: number;
  commission_week: number;
  invoice_count_week: number;
  sales_month: number;
  commission_month: number;
  invoice_count_month: number;
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
    cost_total?: number | null;
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
const isDateWithinRange = (value: string, start: string, end: string) => value >= start && value <= end;
const formatShortDate = (value: string) => {
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', timeZone: ARGENTINA_TZ });
};

const roundMoney = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

const lineMargin = (lineTotal: number, costTotal: number) => Math.max(0, Number(lineTotal || 0) - Number(costTotal || 0));

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
  const hasExplicitPeriod = Boolean(searchParams.get('period'));
  const { user } = useAdminSession();
  const canViewProfit = canViewProfitMetrics(user?.role);
  const canViewCommissionBreakdown = canViewSellerCommissionBreakdown(user?.role);
  const [sellers, setSellers] = useState<Seller[]>([]);
  const [monthlySummary, setMonthlySummary] = useState<SellerMonthlySummary[]>([]);
  const [monthlyPeriod, setMonthlyPeriod] = useState(searchParams.get('period') || '');
  const [referenceDate, setReferenceDate] = useState(searchParams.get('date') || getArgentinaNowDateInput());
  const [rangeSummary, setRangeSummary] = useState<SellerRangeSummary[]>([]);
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

  const buildRangeSummaryFromInvoices = (
    invoices: InvoiceListItem[],
    sellerList: Seller[],
    baseDate: string
  ): SellerRangeSummary[] => {
    const monthKey = baseDate.slice(0, 7);
    const range = getWeekRange(baseDate);
    const summaryMap = new Map<number, SellerRangeSummary>();

    sellerList.forEach((seller) => {
      summaryMap.set(seller.id, {
        seller_id: seller.id,
        sales_day: 0,
        commission_day: 0,
        invoice_count_day: 0,
        sales_week: 0,
        commission_week: 0,
        invoice_count_week: 0,
        sales_month: 0,
        commission_month: 0,
        invoice_count_month: 0,
      });
    });

    invoices.forEach((item) => {
      const sellerId = Number(item.seller_id || 0);
      if (sellerId <= 0) return;
      const documentType = String(item.document_type || '').trim().toUpperCase();
      if (documentType === 'PRESUPUESTO') return;
      const dateKey = toDateInput(item.created_at);
      if (!dateKey) return;
      const sign = documentType === 'NOTA_CREDITO' ? -1 : 1;
      const salesValue = roundMoney(Number(item.total || 0) * sign);
      const commissionValue = roundMoney(Number(item.commission_amount || 0) * sign);
      const current = summaryMap.get(sellerId) ?? {
        seller_id: sellerId,
        sales_day: 0,
        commission_day: 0,
        invoice_count_day: 0,
        sales_week: 0,
        commission_week: 0,
        invoice_count_week: 0,
        sales_month: 0,
        commission_month: 0,
        invoice_count_month: 0,
      };
      if (dateKey === baseDate) {
        current.sales_day = roundMoney(current.sales_day + salesValue);
        current.commission_day = roundMoney(current.commission_day + commissionValue);
        current.invoice_count_day += 1;
      }
      if (isDateWithinRange(dateKey, range.start, range.end)) {
        current.sales_week = roundMoney(current.sales_week + salesValue);
        current.commission_week = roundMoney(current.commission_week + commissionValue);
        current.invoice_count_week += 1;
      }
      if (dateKey.slice(0, 7) === monthKey) {
        current.sales_month = roundMoney(current.sales_month + salesValue);
        current.commission_month = roundMoney(current.commission_month + commissionValue);
        current.invoice_count_month += 1;
      }
      summaryMap.set(sellerId, current);
    });

    return sellerList
      .map((seller) => summaryMap.get(seller.id))
      .filter((item): item is SellerRangeSummary => Boolean(item));
  };

  const buildMonthlySummaryFromInvoices = async (): Promise<{
    period: string;
    items: SellerMonthlySummary[];
  }> => {
    const availableSellers =
      sellers.length > 0
        ? sellers
        : await (async () => {
            const sellerRes = await fetch(`${getApiBaseUrl()}/admin/sellers?limit=${ADMIN_LIMITS.sellersExtendedList}`, {
              credentials: 'include',
              cache: 'no-store',
            });
            const sellerData = await sellerRes.json().catch(() => null);
            if (!sellerRes.ok) {
              throw new Error(sellerData?.detail || 'No se pudieron cargar los vendedores');
            }
            return Array.isArray(sellerData) ? (sellerData as Seller[]) : [];
          })();

    const listRes = await fetch(`${getApiBaseUrl()}/admin/invoices?limit=${ADMIN_LIMITS.invoicesList}`, {
      credentials: 'include',
      cache: 'no-store',
    });
    const listData = await listRes.json().catch(() => null);
    if (!listRes.ok) {
      throw new Error(listData?.detail || 'No se pudieron cargar los comprobantes');
    }
    const invoices = Array.isArray(listData) ? (listData as InvoiceListItem[]) : [];
    const detectedPeriod =
      monthlyPeriod ||
      invoices
        .filter((item) => Number(item.seller_id || 0) > 0 && String(item.document_type || '').trim().toUpperCase() !== 'PRESUPUESTO')
        .map((item) => (typeof item.created_at === 'string' ? item.created_at.slice(0, 7) : ''))
        .filter((value) => /^\d{4}-\d{2}$/.test(value))
        .sort()
        .at(-1) ||
      getArgentinaNowDateInput().slice(0, 7);
    const period = detectedPeriod;

    const summaryMap = new Map<number, SellerMonthlySummary>();
    availableSellers
      .filter((seller) => seller.is_active)
      .forEach((seller) => {
        summaryMap.set(seller.id, {
          seller_id: seller.id,
          name: seller.name,
          commission_percent: Number(seller.commission_percent || 0),
          sales: 0,
          profit: null,
          commission: 0,
          invoice_count: 0,
        });
      });

    invoices.forEach((item: InvoiceListItem) => {
      const sellerId = Number(item.seller_id || 0);
      const summary = summaryMap.get(sellerId);
      const createdAt = typeof item.created_at === 'string' ? item.created_at.slice(0, 7) : '';
      const documentType = String(item.document_type || '').trim().toUpperCase();
      if (!summary || createdAt !== period || documentType === 'PRESUPUESTO') {
        return;
      }
      const sign = documentType === 'NOTA_CREDITO' ? -1 : 1;
      summary.sales = roundMoney(summary.sales + Number(item.total || 0) * sign);
      summary.commission = roundMoney(summary.commission + Number(item.commission_amount || 0) * sign);
      summary.invoice_count += 1;
    });

    const filteredInvoices = invoices.filter((item: InvoiceListItem) => {
      const sellerId = Number(item.seller_id || 0);
      const createdAt = typeof item.created_at === 'string' ? item.created_at.slice(0, 7) : '';
      const documentType = String(item.document_type || '').trim().toUpperCase();
      return sellerId > 0 && createdAt === period && documentType !== 'PRESUPUESTO';
    });

    const detailResponses = await Promise.all(
      filteredInvoices.map(async (item: InvoiceListItem) => {
        const res = await fetch(`${getApiBaseUrl()}/admin/invoices/${item.id}`, {
          credentials: 'include',
          cache: 'no-store',
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          throw new Error(data?.detail || `No se pudo cargar el comprobante ${item.id}`);
        }
        return { item, data: data as InvoiceDetailResponse };
      })
    );

    detailResponses.forEach(({ item, data }) => {
      const sellerId = Number(item.seller_id || 0);
      const summary = summaryMap.get(sellerId);
      if (!summary) {
        return;
      }
      const documentType = String(item.document_type || '').trim().toUpperCase();
      const sign = documentType === 'NOTA_CREDITO' ? -1 : 1;
      const itemsProfit = data.items.reduce(
        (sum, detailItem) => sum + lineMargin(Number(detailItem.line_total || 0), Number(detailItem.cost_total || 0)),
        0
      );
      summary.profit = roundMoney(
        Number(summary.profit || 0) + (itemsProfit * sign) - (Number(item.special_discount || 0) * sign)
      );
    });

    return {
      period,
      items: Array.from(summaryMap.values()).sort((a, b) => a.name.localeCompare(b.name, 'es-AR')),
    };
  };

  const buildSellerDetailFromInvoices = async (sellerId: number): Promise<SellerMonthlyDetail> => {
    let selected = sellers.find((seller) => seller.id === sellerId) ?? null;
    if (!selected) {
      const sellerRes = await fetch(`${getApiBaseUrl()}/admin/sellers?limit=${ADMIN_LIMITS.sellersExtendedList}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      const sellerData = await sellerRes.json().catch(() => null);
      if (!sellerRes.ok) {
        throw new Error(sellerData?.detail || 'No se pudo cargar el vendedor');
      }
      selected = (Array.isArray(sellerData) ? sellerData : []).find((seller: Seller) => seller.id === sellerId) ?? null;
    }
    if (!selected) {
      throw new Error('Vendedor no encontrado');
    }

    const listRes = await fetch(`${getApiBaseUrl()}/admin/invoices?limit=${ADMIN_LIMITS.invoicesList}`, {
      credentials: 'include',
      cache: 'no-store',
    });
    const listData = await listRes.json().catch(() => null);
    if (!listRes.ok) {
      throw new Error(listData?.detail || 'No se pudieron cargar los comprobantes del vendedor');
    }
    const invoices = Array.isArray(listData) ? (listData as InvoiceListItem[]) : [];
    const period =
      monthlyPeriod ||
      invoices
        .filter((item) => Number(item.seller_id || 0) === sellerId && String(item.document_type || '').trim().toUpperCase() !== 'PRESUPUESTO')
        .map((item) => (typeof item.created_at === 'string' ? item.created_at.slice(0, 7) : ''))
        .filter((value) => /^\d{4}-\d{2}$/.test(value))
        .sort()
        .at(-1) ||
      getArgentinaNowDateInput().slice(0, 7);

    const filteredInvoices = invoices
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

    const detailResponses = await Promise.all(
      filteredInvoices.map(async (item: InvoiceListItem) => {
        const res = await fetch(`${getApiBaseUrl()}/admin/invoices/${item.id}`, {
          credentials: 'include',
          cache: 'no-store',
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          throw new Error(data?.detail || `No se pudo cargar el comprobante ${item.id}`);
        }
        return { item, data: data as InvoiceDetailResponse };
      })
    );

    const items = detailResponses.map(({ item, data }) => {
      const documentType = String(item.document_type || '').trim().toUpperCase();
      const sign = documentType === 'NOTA_CREDITO' ? -1 : 1;
      const detailedItems = data.items.map((detailItem) => ({
        product_id: detailItem.product_id,
        product_name: detailItem.product_name,
        quantity: Number(detailItem.quantity || 0),
        unit_price: roundMoney(Number(detailItem.unit_price || 0) * sign),
        line_total: roundMoney(Number(detailItem.line_total || 0) * sign),
        cost_total: roundMoney(Number(detailItem.cost_total || 0) * sign),
      }));
      const itemsProfit = data.items.reduce(
        (sum, detailItem) => sum + lineMargin(Number(detailItem.line_total || 0), Number(detailItem.cost_total || 0)),
        0
      );
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
        balance_due: roundMoney(Number(data.summary?.balance_due ?? item.total ?? 0) * sign),
        special_discount: roundMoney(Number(item.special_discount || 0) * sign),
        commission: roundMoney(Number(item.commission_amount || 0) * sign),
        profit: roundMoney((itemsProfit * sign) - (Number(item.special_discount || 0) * sign)),
        items: detailedItems,
      };
    });

    return {
      period,
      seller: selected,
      summary: {
        sales: roundMoney(items.reduce((sum, item) => sum + Number(item.total || 0), 0)),
        commission: roundMoney(items.reduce((sum, item) => sum + Number(item.commission || 0), 0)),
        profit: roundMoney(items.reduce((sum, item) => sum + Number(item.profit || 0), 0)),
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
      await loadRuntimeConfig();
      let requestedPeriod = monthlyPeriod;
      if (!requestedPeriod && !hasExplicitPeriod) {
        const listRes = await fetch(`${getApiBaseUrl()}/admin/invoices?limit=${ADMIN_LIMITS.invoicesList}`, {
          credentials: 'include',
          cache: 'no-store',
        });
        const listData = await listRes.json().catch(() => null);
        if (!listRes.ok) {
          throw new Error(listData?.detail || 'No se pudieron cargar los comprobantes');
        }
        requestedPeriod =
          (Array.isArray(listData) ? (listData as InvoiceListItem[]) : [])
            .filter((item) => Number(item.seller_id || 0) > 0 && String(item.document_type || '').trim().toUpperCase() !== 'PRESUPUESTO')
            .map((item) => (typeof item.created_at === 'string' ? item.created_at.slice(0, 7) : ''))
            .filter((value) => /^\d{4}-\d{2}$/.test(value))
            .sort()
            .at(-1) || '';
      }
      const params = new URLSearchParams();
      if (requestedPeriod) {
        params.set('period', requestedPeriod);
      }
      const res = await fetch(`${getApiBaseUrl()}/admin/sellers/monthly-summary?${params.toString()}`, {
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
      try {
        const fallbackSummary = await buildMonthlySummaryFromInvoices();
        setMonthlySummary(fallbackSummary.items);
        setMonthlyPeriod(fallbackSummary.period);
      } catch (fallbackErr) {
        setError(getErrorMessage(fallbackErr, 'Error cargando resumen mensual'));
      }
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
      await loadRuntimeConfig();
      const res = await fetch(`${getApiBaseUrl()}/admin/invoices?limit=${ADMIN_LIMITS.invoicesRangeList}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.detail || 'No se pudo cargar el corte de comisiones');
      }
      const invoices = Array.isArray(data) ? (data as InvoiceListItem[]) : [];
      setRangeSummary(buildRangeSummaryFromInvoices(invoices, sellers, referenceDate));
    } catch (err) {
      setError(getErrorMessage(err, 'Error cargando comisiones por dia y semana'));
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
        await loadRuntimeConfig();
        try {
          const detailParams = new URLSearchParams();
          if (monthlyPeriod) {
            detailParams.set('period', monthlyPeriod);
          }
          const res = await fetch(`${getApiBaseUrl()}/admin/sellers/${detailSellerId}/monthly-detail?${detailParams.toString()}`, {
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
        setError(getErrorMessage(err, 'Error cargando detalle del vendedor'));
      } finally {
        setDetailLoading(false);
      }
    };
    void loadSellerDetail();
  }, [detailSellerId, monthlyPeriod]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      if (document.visibilityState !== 'visible') {
        return;
      }
      void loadMonthlySummary(true);
      if (canViewCommissionBreakdown) {
        void loadRangeSummary(true);
      }
    }, 30000);

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
      setError(getErrorMessage(err, 'Error guardando vendedor'));
    } finally {
      setSaving(false);
    }
  };

  const openSellerMonthlyDetail = (sellerId: number) => {
    const params = new URLSearchParams();
    if (monthlyPeriod) {
      params.set('period', monthlyPeriod);
    }
    params.set('seller', String(sellerId));
    router.push(`/admin/vendedores?${params.toString()}`);
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
            <h1>Detalle mensual del vendedor</h1>
            <p>Ventas, comisiones y ganancia estimada del periodo con acceso a cada comprobante.</p>
          </div>
          <div className={styles.headerActions}>
            <label className={styles.periodField}>
              <span>Periodo</span>
              <input
                type="month"
                value={monthlyPeriod}
                onChange={(e) => setMonthlyPeriod(e.target.value)}
              />
            </label>
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
                {canViewProfit && sellerDetail.summary.profit !== null ? (
                  <div className={styles.detailItem}>
                    <span>Ganancia empresa</span>
                    <strong>{money(sellerDetail.summary.profit)}</strong>
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
            <span>Periodo</span>
            <input
              type="month"
              value={monthlyPeriod}
              onChange={(e) => setMonthlyPeriod(e.target.value)}
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

      <div className={styles.tablePanel}>
        <div className={styles.tableMeta}>
          <span>{sellers.length} vendedores{search ? ` para "${search}"` : ''} en {formattedMonthlyPeriod}</span>
        </div>
        {canViewCommissionBreakdown ? (
          <div className={styles.boardHint}>
            Corte rapido: dia {formatShortDate(referenceDate)} y semana {formatShortDate(weekRange.start)} al {formatShortDate(weekRange.end)}.
          </div>
        ) : null}
        <div className={styles.boardHint}>Doble click sobre un vendedor para abrir el detalle mensual del periodo seleccionado.</div>
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
                  {canViewCommissionBreakdown ? <th>Com. dia</th> : null}
                  {canViewCommissionBreakdown ? <th>Com. semana</th> : null}
                  {canViewCommissionBreakdown ? <th>Com. mes</th> : null}
                  <th>Venta mes</th>
                  {canViewProfit ? <th>Ganancia empresa</th> : null}
                  <th>Comprobantes</th>
                  <th>Estado</th>
                  <th>Actualizado</th>
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {sellers.map((seller) => {
                  const sellerSummary = monthlySummaryMap.get(seller.id);
                  const sellerRange = rangeSummaryMap.get(seller.id);
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
                      {canViewCommissionBreakdown ? <td>{money(sellerRange?.commission_day || 0)}</td> : null}
                      {canViewCommissionBreakdown ? <td>{money(sellerRange?.commission_week || 0)}</td> : null}
                      {canViewCommissionBreakdown ? <td>{money(sellerRange?.commission_month || sellerSummary?.commission || 0)}</td> : null}
                      <td>{money(sellerSummary?.sales || 0)}</td>
                      {canViewProfit ? <td>{money(sellerSummary?.profit || 0)}</td> : null}
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
              {`Ventas, comisiones y rentabilidad de ${formattedMonthlyPeriod} para los vendedores activos.`}
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
                  {canViewProfit && item.profit !== null ? (
                    <div>
                      <span>Ganancia empresa</span>
                      <strong>{money(item.profit)}</strong>
                    </div>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {canViewCommissionBreakdown ? (
        <section className={styles.panel}>
          <div className={styles.panelHeader}>
            <div>
              <h3>Comisiones por dia y semana</h3>
              <p>{`Base ${formatShortDate(referenceDate)}. Semana del ${formatShortDate(weekRange.start)} al ${formatShortDate(weekRange.end)}.`}</p>
            </div>
          </div>

          {summaryLoading ? (
            <div className={styles.empty}>Calculando comisiones...</div>
          ) : sellers.length === 0 ? (
            <div className={styles.empty}>No hay vendedores para mostrar.</div>
          ) : (
            <div className={styles.monthlySummaryGrid}>
              {sellers.map((seller) => {
                const sellerRange = rangeSummaryMap.get(seller.id);
                return (
                  <article key={`range-${seller.id}`} className={styles.summaryCard}>
                    <div className={styles.summaryHeader}>
                      <strong>{seller.name}</strong>
                      <span>{formatPercent(seller.commission_percent)}</span>
                    </div>
                    <div className={styles.summaryMetrics}>
                      <div>
                        <span>Comision del dia</span>
                        <strong>{money(sellerRange?.commission_day || 0)}</strong>
                      </div>
                      <div>
                        <span>Comision semana</span>
                        <strong>{money(sellerRange?.commission_week || 0)}</strong>
                      </div>
                      <div>
                        <span>Comprobantes semana</span>
                        <strong>{sellerRange?.invoice_count_week || 0}</strong>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      ) : null}

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
              {canViewCommissionBreakdown ? (
                <div className={styles.detailItem}>
                  <span>Comision del dia</span>
                  <strong>{money(selectedSellerRangeSummary?.commission_day || 0)}</strong>
                </div>
              ) : null}
              {canViewCommissionBreakdown ? (
                <div className={styles.detailItem}>
                  <span>Comision de la semana</span>
                  <strong>{money(selectedSellerRangeSummary?.commission_week || 0)}</strong>
                </div>
              ) : null}
              <div className={styles.detailItem}>
                <span>Comprobantes del mes</span>
                <strong>{selectedSellerSummary?.invoice_count || 0}</strong>
              </div>
              <div className={styles.detailItem}>
                <span>Comision acumulada</span>
                <strong>{money(canViewCommissionBreakdown ? (selectedSellerRangeSummary?.commission_month || selectedSellerSummary?.commission || 0) : (selectedSellerSummary?.commission || 0))}</strong>
              </div>
              {canViewProfit && selectedSellerSummary && selectedSellerSummary.profit !== null ? (
                <div className={styles.detailItem}>
                  <span>Ganancia empresa</span>
                  <strong>{money(selectedSellerSummary.profit)}</strong>
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
              <Link
                href={
                  monthlyPeriod
                    ? `/admin/vendedores?period=${encodeURIComponent(monthlyPeriod)}&seller=${selectedSeller.id}`
                    : `/admin/vendedores?seller=${selectedSeller.id}`
                }
                className={styles.primaryButton}
              >
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
