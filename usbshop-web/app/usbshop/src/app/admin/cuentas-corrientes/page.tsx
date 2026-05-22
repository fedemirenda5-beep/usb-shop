'use client';

import Link from 'next/link';
import { type FormEvent, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { getApiBaseUrl, loadRuntimeConfig } from '@/lib/api';
import { openAdminAccountPrint } from '@/lib/adminAccountPrint';
import { openAdminInvoicePrint } from '@/lib/adminInvoicePrint';
import { formatArgentinaDateTime } from '@/lib/datetime';
import { useAdminSession } from '@/hooks/useAdminSession';
import styles from './cuentas-corrientes.module.css';

type Aging = {
  current: number;
  d1_30: number;
  d31_60: number;
  d61_90: number;
  d90_plus: number;
  total: number;
  classification?: {
    pending: number;
    overdue: number;
    collected: number;
    payments: number;
    credit_notes: number;
    writeoffs: number;
    adjustments: number;
    opening_balance: number;
  };
};

type CustomerOverview = {
  id: number;
  name: string;
  email?: string | null;
  phone?: string | null;
  sale_mode?: string | null;
  locality?: string | null;
  address?: string | null;
  tax_condition?: string | null;
  cuit?: string | null;
  debit?: number;
  credit?: number;
  balance: number;
  aging: Aging;
  classification?: Aging['classification'];
  last_movement?: string | null;
};

type Movement = {
  id: number;
  movement_type: string;
  entry_kind?: string | null;
  entry_label?: string | null;
  amount: number;
  signed_amount: number;
  reference?: string | null;
  invoice_id?: number | null;
  created_at?: string | null;
  payment_method?: string | null;
  document_type?: string | null;
  due_date?: string | null;
  remaining_amount?: number | null;
  status_label?: string | null;
  running_balance: number;
  editable?: boolean;
};

type CustomerDetail = {
  customer: {
    id: number;
    name: string;
    email?: string | null;
    phone?: string | null;
    sale_mode?: string | null;
    locality?: string | null;
    address?: string | null;
    tax_condition?: string | null;
    cuit?: string | null;
  };
  balance: number;
  aging: Aging;
  classification?: Aging['classification'];
  movements: Movement[];
};

type InvoiceOption = {
  id: number;
  total: number;
  created_at: string;
  document_type?: string | null;
  sale_mode?: string | null;
  status?: string | null;
};

const money = (value: number) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(value || 0);

const parseArAmount = (raw: string): number => {
  const value = String(raw || '').trim();
  if (!value) return 0;
  const normalized = value.replace(/\s+/g, '');

  if (normalized.includes(',') && normalized.includes('.')) {
    return Number(normalized.replace(/\./g, '').replace(',', '.'));
  }
  if (normalized.includes(',')) {
    return Number(normalized.replace(/\./g, '').replace(',', '.'));
  }
  if (normalized.includes('.')) {
    const parts = normalized.split('.');
    const looksLikeThousands = parts.length > 1 && parts.slice(1).every((part) => part.length === 3);
    return Number(looksLikeThousands ? parts.join('') : normalized);
  }
  return Number(normalized);
};

const formatDate = (value?: string | null) => {
  return formatArgentinaDateTime(value);
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

export default function CuentasCorrientesPage() {
  const { user } = useAdminSession();
  const detailRef = useRef<HTMLElement | null>(null);
  const movementFormRef = useRef<HTMLFormElement | null>(null);
  const amountInputRef = useRef<HTMLInputElement | null>(null);
  const overviewRequestRef = useRef(0);
  const detailRequestRef = useRef(0);
  const invoicesRequestRef = useRef(0);
  const [isMobileLayout, setIsMobileLayout] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth <= 860 : false
  );
  const [customers, setCustomers] = useState<CustomerOverview[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [invoices, setInvoices] = useState<InvoiceOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [customerFilter, setCustomerFilter] = useState<'all' | 'debt' | 'overdue' | 'credit'>('all');
  const [summary, setSummary] = useState({
    customers: 0,
    debit: 0,
    credit: 0,
    balance: 0,
    pending: 0,
    overdue: 0,
    collected: 0,
    credit_notes: 0,
    writeoffs: 0,
    adjustments: 0,
  });
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [detailOnly, setDetailOnly] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showDateRangeModal, setShowDateRangeModal] = useState(false);
  const [outputMode, setOutputMode] = useState<'print' | 'pdf' | null>(null);
  const [outputRange, setOutputRange] = useState<{ from: string; to: string } | null>(null);
  const [dateRangeDraft, setDateRangeDraft] = useState<{ from: string; to: string }>({ from: '', to: '' });
  const [movementMode, setMovementMode] = useState<'payment' | 'debt'>('payment');
  const [movementFilter, setMovementFilter] = useState<'all' | 'debit' | 'credit' | 'editable'>('all');
  const [movementSearch, setMovementSearch] = useState('');
  const [editingMovementId, setEditingMovementId] = useState<number | null>(null);
  const [form, setForm] = useState({
    movement_type: 'CREDIT',
    entry_kind: 'PAYMENT',
    amount: '',
    payment_method: 'Transferencia',
    reference: '',
    invoice_id: '',
  });
  const deferredSearch = useDeferredValue(search);
  const deferredMovementSearch = useDeferredValue(movementSearch);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const media = window.matchMedia('(max-width: 860px)');
    const sync = () => setIsMobileLayout(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  const emptyAging = (): Aging => ({
    current: 0,
    d1_30: 0,
    d31_60: 0,
    d61_90: 0,
    d90_plus: 0,
    total: 0,
    classification: {
      pending: 0,
      overdue: 0,
      collected: 0,
      payments: 0,
      credit_notes: 0,
      writeoffs: 0,
      adjustments: 0,
      opening_balance: 0,
    },
  });

  const mapBackofficeCustomers = (rows: Array<Record<string, unknown>>) => {
    const normalized = rows
      .map((row) => {
        const balance = Number(row.balance || 0);
        return {
          id: Number(row.id || 0),
          name: String(row.name || 'Sin nombre'),
          email: typeof row.email === 'string' ? row.email : null,
          phone: typeof row.phone === 'string' ? row.phone : null,
          sale_mode: typeof row.sale_mode === 'string' ? row.sale_mode : null,
          locality: typeof row.locality === 'string' ? row.locality : null,
          address: typeof row.address === 'string' ? row.address : null,
          tax_condition: typeof row.tax_condition === 'string' ? row.tax_condition : null,
          cuit: typeof row.cuit === 'string' ? row.cuit : null,
          debit: balance > 0 ? balance : 0,
          credit: balance < 0 ? Math.abs(balance) : 0,
          balance,
          aging: { ...emptyAging(), total: Math.max(0, balance) },
          classification: {
            ...emptyAging().classification,
            pending: Math.max(0, balance),
          },
          last_movement: null,
        };
      })
      .filter((item) => item.balance !== 0 || String(item.sale_mode || '').trim().toUpperCase() === 'CUENTA_CORRIENTE');
    const debit = normalized.filter((item) => item.balance > 0).reduce((sum, item) => sum + item.balance, 0);
    const credit = Math.abs(
      normalized.filter((item) => item.balance < 0).reduce((sum, item) => sum + item.balance, 0)
    );
    return {
      customers: normalized,
      summary: {
        customers: normalized.length,
        debit,
        credit,
        balance: normalized.reduce((sum, item) => sum + item.balance, 0),
        pending: normalized.reduce((sum, item) => sum + Math.max(0, item.balance), 0),
        overdue: 0,
        collected: 0,
        credit_notes: 0,
        writeoffs: 0,
        adjustments: 0,
      },
    };
  };

  async function loadOverview() {
    const requestId = overviewRequestRef.current + 1;
    overviewRequestRef.current = requestId;
    setLoading(true);
    await loadRuntimeConfig();
    const res = await fetch(`${getApiBaseUrl()}/admin/backoffice-customers?limit=1000`, { credentials: 'include' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(
        typeof data?.detail === 'string' && data.detail.trim()
          ? data.detail
          : 'No se pudo cargar cuentas corrientes'
      );
    }
    if (overviewRequestRef.current !== requestId) return;
    const mapped = mapBackofficeCustomers(Array.isArray(data) ? data : []);
    setCustomers(mapped.customers);
    setSummary(
      mapped.summary || {
        customers: 0,
        debit: 0,
        credit: 0,
        balance: 0,
        pending: 0,
        overdue: 0,
        collected: 0,
        credit_notes: 0,
        writeoffs: 0,
        adjustments: 0,
      }
    );
  }

  async function loadDetail(customerId: number): Promise<CustomerDetail | null> {
    const requestId = detailRequestRef.current + 1;
    detailRequestRef.current = requestId;
    setDetailLoading(true);
    await loadRuntimeConfig();
    try {
      const res = await fetch(`${getApiBaseUrl()}/admin/cc/${customerId}`, { credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          typeof data?.detail === 'string' && data.detail.trim()
            ? data.detail
            : 'No se pudo cargar el detalle de la cuenta corriente'
        );
      }
      if (detailRequestRef.current !== requestId) return null;
      setDetail(data);
      return data as CustomerDetail;
    } finally {
      if (detailRequestRef.current === requestId) {
        setDetailLoading(false);
      }
    }
  }

  async function loadInvoices(customerId: number) {
    const requestId = invoicesRequestRef.current + 1;
    invoicesRequestRef.current = requestId;
    await loadRuntimeConfig();
    try {
      const res = await fetch(`${getApiBaseUrl()}/admin/invoices?customer_id=${customerId}&limit=100`, { credentials: 'include' });
      if (!res.ok) throw new Error('No se pudieron cargar los comprobantes del cliente');
      const data = await res.json();
      if (invoicesRequestRef.current !== requestId) return;
      setInvoices(data || []);
    } catch {
      if (invoicesRequestRef.current !== requestId) return;
      setInvoices([]);
    }
  }

  useEffect(() => {
    const load = async () => {
      try {
        await loadOverview();
      } catch (err) {
        setError(getErrorMessage(err, 'Error cargando cuentas corrientes'));
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    resetMovementForm();
    const loadSelectedCustomer = async () => {
      try {
        await loadDetail(selectedId);
        await loadInvoices(selectedId);
      } catch (err) {
        setError(getErrorMessage(err, 'Error cargando el detalle'));
      }
    };
    void loadSelectedCustomer();
  }, [selectedId]);

  useEffect(() => {
    if (isMobileLayout) return;
    setDetailOnly(false);
  }, [customers, isMobileLayout]);

  const submitMovement = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedId) return;
    try {
      setSaving(true);
      setError('');
      const parsedAmount = parseArAmount(form.amount);
      if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
        throw new Error('Ingresa un importe valido. Podes usar 306000, 306.000 o 306,00');
      }
      await loadRuntimeConfig();
      const endpoint = editingMovementId
        ? `${getApiBaseUrl()}/admin/cc/${selectedId}/movements/${editingMovementId}`
        : `${getApiBaseUrl()}/admin/cc/${selectedId}/movements`;
      const payload = {
        movement_type: form.movement_type,
        entry_kind: form.entry_kind,
        amount: parsedAmount,
        payment_method: form.payment_method || null,
        reference: form.reference || null,
        invoice_id: form.invoice_id ? Number(form.invoice_id) : null,
      };
      const res = await fetch(endpoint, {
        method: editingMovementId ? 'PUT' : 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || (editingMovementId ? 'No se pudo actualizar el movimiento' : 'No se pudo registrar el movimiento'));
      await loadOverview();
      await loadDetail(selectedId);
      await loadInvoices(selectedId);
      setEditingMovementId(null);
      setForm((current) => ({
        ...current,
        amount: '',
        reference: '',
        invoice_id: '',
        entry_kind: movementMode === 'payment' ? 'PAYMENT' : 'ADJUSTMENT',
      }));
    } catch (err) {
      setError(getErrorMessage(err, 'Error guardando movimiento'));
    } finally {
      setSaving(false);
    }
  };

  const filteredCustomers = useMemo(() => {
    const needle = deferredSearch.trim().toLowerCase();
    return customers
      .filter((customer) => {
        if (customerFilter === 'debt') return customer.balance > 0;
        if (customerFilter === 'overdue') return (customer.classification?.overdue || 0) > 0;
        if (customerFilter === 'credit') return customer.balance < 0;
        return true;
      })
      .filter((customer) => {
        if (!needle) return true;
        return [customer.name, customer.email || '', customer.phone || '', customer.cuit || '', customer.locality || '']
          .join(' ')
          .toLowerCase()
          .includes(needle);
      })
      .sort((a, b) => {
        const overdueDiff = (b.classification?.overdue || 0) - (a.classification?.overdue || 0);
        if (overdueDiff !== 0) return overdueDiff;
        return Math.abs(b.balance) - Math.abs(a.balance);
      });
  }, [customers, customerFilter, deferredSearch]);

  const selectedOverview = useMemo(
    () => customers.find((customer) => customer.id === selectedId) || null,
    [customers, selectedId]
  );

  const printInvoice = async (invoiceId: number) => {
    try {
      setError('');
      await openAdminInvoicePrint(invoiceId);
    } catch (err) {
      setError(getErrorMessage(err, 'No se pudo preparar la impresion'));
    }
  };

  const movementSummary = useMemo(() => {
    if (!detail) return { debits: 0, credits: 0, movements: 0 };
    return detail.movements.reduce(
      (acc, movement) => {
        if (movement.movement_type === 'DEBIT') acc.debits += movement.amount;
        if (movement.movement_type === 'CREDIT') acc.credits += movement.amount;
        acc.movements += 1;
        return acc;
      },
      { debits: 0, credits: 0, movements: 0 }
    );
  }, [detail]);

  const visibleMovements = useMemo(() => {
    if (!detail) return [];
    if (!outputRange?.from && !outputRange?.to) return detail.movements;
    const fromTs = outputRange?.from ? new Date(`${outputRange.from}T00:00:00`).getTime() : null;
    const toTs = outputRange?.to ? new Date(`${outputRange.to}T23:59:59`).getTime() : null;
    return detail.movements.filter((movement) => {
      if (!movement.created_at) return false;
      const ts = new Date(movement.created_at).getTime();
      if (Number.isNaN(ts)) return false;
      if (fromTs !== null && ts < fromTs) return false;
      if (toTs !== null && ts > toTs) return false;
      return true;
    });
  }, [detail, outputRange]);

  const filteredMovements = useMemo(() => {
    const needle = deferredMovementSearch.trim().toLowerCase();
    return visibleMovements.filter((movement) => {
      if (movementFilter === 'debit' && movement.movement_type !== 'DEBIT') return false;
      if (movementFilter === 'credit' && movement.movement_type !== 'CREDIT') return false;
      if (movementFilter === 'editable' && movement.editable === false) return false;
      if (!needle) return true;
      return [
        movement.reference || '',
        movement.payment_method || '',
        movement.document_type || '',
        movement.entry_label || '',
        movement.status_label || '',
        movement.invoice_id ? String(movement.invoice_id) : '',
      ]
        .join(' ')
        .toLowerCase()
        .includes(needle);
    });
  }, [deferredMovementSearch, movementFilter, visibleMovements]);

  const editingMovement = useMemo(() => {
    if (!detail || !editingMovementId) return null;
    return detail.movements.find((movement) => movement.id === editingMovementId) || null;
  }, [detail, editingMovementId]);

  const visibleMovementSummary = useMemo(() => {
    return filteredMovements.reduce(
      (acc, movement) => {
        if (movement.movement_type === 'DEBIT') acc.debits += movement.amount;
        if (movement.movement_type === 'CREDIT') acc.credits += movement.amount;
        acc.movements += 1;
        return acc;
      },
      { debits: 0, credits: 0, movements: 0 }
    );
  }, [filteredMovements]);

  const displayMovements = detailOnly ? visibleMovements : filteredMovements;
  const displayMovementSummary = detailOnly
    ? visibleMovements.reduce(
        (acc, movement) => {
          if (movement.movement_type === 'DEBIT') acc.debits += movement.amount;
          if (movement.movement_type === 'CREDIT') acc.credits += movement.amount;
          acc.movements += 1;
          return acc;
        },
        { debits: 0, credits: 0, movements: 0 }
      )
    : visibleMovementSummary;

  const rangeLabel = useMemo(() => {
    if (!outputRange?.from && !outputRange?.to) return 'Historial completo';
    const from = outputRange?.from || 'Inicio';
    const to = outputRange?.to || 'Hoy';
    return `${from} a ${to}`;
  }, [outputRange]);

  const setMode = (mode: 'payment' | 'debt') => {
    setMovementMode(mode);
    setForm((current) => ({
      ...current,
      movement_type: mode === 'payment' ? 'CREDIT' : 'DEBIT',
      entry_kind: mode === 'payment' ? 'PAYMENT' : 'ADJUSTMENT',
      payment_method: mode === 'payment' ? current.payment_method || 'Transferencia' : '',
      invoice_id: mode === 'payment' ? current.invoice_id : '',
      reference: mode === 'payment' ? current.reference : current.reference || 'Faltante de pago / deuda historica',
    }));
  };

  const openMovementForm = (mode: 'payment' | 'debt') => {
    setMode(mode);
    window.requestAnimationFrame(() => {
      movementFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  const resetMovementForm = () => {
    setEditingMovementId(null);
    setMovementMode('payment');
    setForm({
      movement_type: 'CREDIT',
      entry_kind: 'PAYMENT',
      amount: '',
      payment_method: 'Transferencia',
      reference: '',
      invoice_id: '',
    });
  };

  const startEditingMovement = (movement: Movement) => {
    const nextMode = movement.movement_type === 'DEBIT' ? 'debt' : 'payment';
    setEditingMovementId(movement.id);
    setMovementMode(nextMode);
    setForm({
      movement_type: movement.movement_type,
      entry_kind: movement.entry_kind || (nextMode === 'payment' ? 'PAYMENT' : 'ADJUSTMENT'),
      amount: movement.amount ? String(movement.amount) : '',
      payment_method: movement.payment_method || (nextMode === 'payment' ? 'Transferencia' : ''),
      reference: movement.reference || '',
      invoice_id: movement.invoice_id ? String(movement.invoice_id) : '',
    });
    window.requestAnimationFrame(() => {
      movementFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  useEffect(() => {
    if (!editingMovementId) return;
    const timeout = window.setTimeout(() => {
      amountInputRef.current?.focus();
      amountInputRef.current?.select();
    }, 120);
    return () => window.clearTimeout(timeout);
  }, [editingMovementId]);

  const movementConceptOptions = useMemo(
    () =>
      movementMode === 'payment'
        ? [
            { value: 'PAYMENT', label: 'Cobranza' },
            { value: 'CREDIT_NOTE', label: 'Nota de credito' },
            { value: 'WRITEOFF', label: 'Incobrable' },
            { value: 'ADJUSTMENT', label: 'Ajuste a favor' },
          ]
        : [
            { value: 'ADJUSTMENT', label: 'Ajuste de deuda' },
            { value: 'OPENING_BALANCE', label: 'Saldo inicial' },
          ],
    [movementMode]
  );

  const hideGlobalTotals = (user?.role || '').toLowerCase() === 'staff';

  const refreshAll = async () => {
      try {
      setError('');
      await loadOverview();
      if (selectedId) {
        await loadDetail(selectedId);
        await loadInvoices(selectedId);
      }
      } catch (err) {
      setError(getErrorMessage(err, 'Error cargando cuentas corrientes'));
    }
  };

  const openCustomerDetail = async (customerId: number) => {
    setError('');
    setSelectedId(customerId);
    setDetail(null);
    setInvoices([]);
    setDetailOnly(true);
    setOutputRange(null);
    try {
      await loadDetail(customerId);
      await loadInvoices(customerId);
    } catch (err) {
      setError(getErrorMessage(err, 'Error cargando el detalle'));
    } finally {
      window.requestAnimationFrame(() => {
        detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  };

  const closeDetailOnly = () => {
    setDetailOnly(false);
    setOutputRange(null);
  };

  const requestOutput = (mode: 'print' | 'pdf') => {
    if (!selectedId) return;
    setOutputMode(mode);
    setDateRangeDraft(outputRange || { from: '', to: '' });
    setShowDateRangeModal(true);
  };

  const confirmOutput = async () => {
    if (!selectedId) return;
    try {
      let currentDetail = detail;
      if (!currentDetail || currentDetail.customer.id !== selectedId) {
        currentDetail = await loadDetail(selectedId);
        await loadInvoices(selectedId);
      }
      const nextRange = { ...dateRangeDraft };
      setOutputRange(nextRange);
      setDetailOnly(true);
      setShowDateRangeModal(false);
      if (!currentDetail) {
        throw new Error('No se pudo cargar el detalle de la cuenta');
      }
      const fromTs = nextRange.from ? new Date(`${nextRange.from}T00:00:00`).getTime() : null;
      const toTs = nextRange.to ? new Date(`${nextRange.to}T23:59:59`).getTime() : null;
      const printableMovements = currentDetail.movements.filter((movement) => {
        if (!movement.created_at) return false;
        const ts = new Date(movement.created_at).getTime();
        if (Number.isNaN(ts)) return false;
        if (fromTs !== null && ts < fromTs) return false;
        if (toTs !== null && ts > toTs) return false;
        return true;
      });
      const printableRangeLabel =
        !nextRange.from && !nextRange.to
          ? 'Historial completo'
          : `${nextRange.from || 'Inicio'} a ${nextRange.to || 'Hoy'}`;
      await openAdminAccountPrint({
        customer: currentDetail.customer,
        balance: currentDetail.balance,
        movements: printableMovements,
        rangeLabel: printableRangeLabel,
      });
    } catch (err) {
      setError(getErrorMessage(err, 'No se pudo preparar la exportacion'));
    }
  };

  const deleteSelectedAccount = async () => {
    if (!selectedId || !selectedOverview) return;
    try {
      setDeleting(true);
      setError('');
      await loadRuntimeConfig();
      const endpoint = `${getApiBaseUrl()}/admin/cc/${selectedId}`;
      const res = await fetch(endpoint, {
        method: 'DELETE',
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || 'No se pudo eliminar la cuenta');

      setShowDeleteModal(false);
      setDetailOnly(false);
      setDetail(null);
      setInvoices([]);
      setSelectedId(null);
      await loadOverview();
    } catch (err) {
      setError(getErrorMessage(err, 'Error eliminando cuenta'));
    } finally {
      setDeleting(false);
    }
  };

  const renderDetailContent = () => {
    if (detailLoading && !detail) {
      return <div className={styles.empty}>Cargando detalle de la cuenta...</div>;
    }
    if (!detail) {
      return <div className={styles.empty}>Selecciona un cliente para ver su cuenta corriente.</div>;
    }

    return (
      <>
        <div className={styles.accountHeader}>
          <div className={styles.accountSummary}>
            <strong>
              {detail.customer.name} (#{detail.customer.id}) -{' '}
              {detail.balance >= 0 ? `Saldo deudor: ${money(detail.balance)}` : `Saldo a favor: ${money(Math.abs(detail.balance))}`}
            </strong>
            <span>
              {detail.customer.tax_condition || 'Sin condicion fiscal'} - {detail.customer.cuit || 'Sin CUIT/DNI'} -{' '}
              {detail.customer.address || detail.customer.locality || 'Sin domicilio'}
            </span>
            {detailOnly ? (
              <span>Periodo visible: {rangeLabel}</span>
            ) : (
              <span>
                Facturas: {money(invoices.reduce((sum, invoice) => sum + invoice.total, 0))} - Cobrado:{' '}
                {money(detail.classification?.payments || movementSummary.credits)}
              </span>
            )}
          </div>
          <div className={styles.accountActions}>
            {detailOnly ? (
              <>
                <button type="button" className={styles.secondaryButton} onClick={closeDetailOnly}>
                  Volver
                </button>
                <button type="button" className={styles.secondaryButton} onClick={() => requestOutput('print')}>
                  Imprimir
                </button>
                <button type="button" className={styles.primaryButton} onClick={() => requestOutput('pdf')}>
                  Exportar PDF
                </button>
              </>
            ) : (
              <>
                <button type="button" className={styles.secondaryButton} onClick={() => openMovementForm('payment')}>
                  Registrar pago
                </button>
                <button type="button" className={styles.secondaryButton} onClick={() => openMovementForm('debt')}>
                  Registrar deuda
                </button>
                <button type="button" className={styles.secondaryButton} onClick={() => requestOutput('print')}>
                  Imprimir
                </button>
                <button type="button" className={styles.primaryButton} onClick={() => requestOutput('pdf')}>
                  Exportar PDF
                </button>
              </>
            )}
          </div>
        </div>

        <div className={styles.detailGrid}>
          <div className={styles.mainColumn}>
            {detailOnly ? (
              <div className={styles.printSummaryBar}>
                <div>
                  <span>Saldo actual</span>
                  <strong>{detail.balance >= 0 ? `Deudor ${money(detail.balance)}` : `A favor ${money(Math.abs(detail.balance))}`}</strong>
                </div>
                <div>
                  <span>Movimiento neto del periodo</span>
                  <strong>{money(displayMovementSummary.debits - displayMovementSummary.credits)}</strong>
                </div>
              </div>
            ) : (
              <div className={styles.desktopStats}>
                <article className={styles.statChip}><span>Contacto</span><strong>{detail.customer.phone || detail.customer.email || 'Sin dato'}</strong></article>
                <article className={styles.statChip}><span>Modo</span><strong>{detail.customer.sale_mode || 'Sin definir'}</strong></article>
                <article className={styles.statChip}><span>Pendiente</span><strong>{money(detail.classification?.pending || detail.balance)}</strong></article>
                <article className={styles.statChip}><span>Vencido</span><strong>{money(detail.classification?.overdue || 0)}</strong></article>
                <article className={styles.statChip}><span>Cobrado</span><strong>{money(detail.classification?.collected || 0)}</strong></article>
                <article className={styles.statChip}><span>NC / Incobrable</span><strong>{money((detail.classification?.credit_notes || 0) + (detail.classification?.writeoffs || 0))}</strong></article>
                <article className={styles.statChip}><span>Ajustes</span><strong>{money((detail.classification?.adjustments || 0) + (detail.classification?.opening_balance || 0))}</strong></article>
              </div>
            )}

            {!detailOnly ? (
              <div className={styles.detailToolbar}>
                <div className={styles.filterPills}>
                  <button
                    type="button"
                    className={`${styles.filterPill} ${movementFilter === 'all' ? styles.filterPillActive : ''}`}
                    onClick={() => setMovementFilter('all')}
                  >
                    Todos ({visibleMovements.length})
                  </button>
                  <button
                    type="button"
                    className={`${styles.filterPill} ${movementFilter === 'debit' ? styles.filterPillActive : ''}`}
                    onClick={() => setMovementFilter('debit')}
                  >
                    Deuda
                  </button>
                  <button
                    type="button"
                    className={`${styles.filterPill} ${movementFilter === 'credit' ? styles.filterPillActive : ''}`}
                    onClick={() => setMovementFilter('credit')}
                  >
                    Pagos
                  </button>
                  <button
                    type="button"
                    className={`${styles.filterPill} ${movementFilter === 'editable' ? styles.filterPillActive : ''}`}
                    onClick={() => setMovementFilter('editable')}
                  >
                    Editables
                  </button>
                </div>
                <input
                  className={styles.inlineSearch}
                  placeholder="Filtrar movimientos por detalle, estado o comprobante..."
                  value={movementSearch}
                  onChange={(event) => setMovementSearch(event.target.value)}
                />
              </div>
            ) : null}

            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>Concepto</th>
                    <th>Detalle</th>
                    <th>Importe</th>
                    <th>Estado</th>
                    <th>Saldo</th>
                    {!detailOnly ? <th>Acciones</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {displayMovements.length === 0 ? (
                    <tr><td colSpan={detailOnly ? 6 : 7}>Sin movimientos.</td></tr>
                  ) : (
                    displayMovements.map((movement) => (
                      <tr
                        key={movement.id}
                        className={movement.id === editingMovementId ? styles.movementRowActive : ''}
                        onClick={() => {
                          if (movement.editable !== false && !detailOnly) startEditingMovement(movement);
                        }}
                      >
                        <td>{formatDate(movement.created_at)}</td>
                        <td>{movement.entry_label || movement.document_type || (movement.movement_type === 'DEBIT' ? 'Debito' : 'Pago')}</td>
                        <td>
                          {movement.reference || movement.payment_method || (movement.invoice_id ? `Comprobante #${movement.invoice_id}` : '-')}
                        </td>
                        <td className={movement.signed_amount >= 0 ? styles.debit : styles.credit}>
                          {money(movement.signed_amount)}
                        </td>
                        <td>{movement.status_label || '-'}</td>
                        <td className={styles.balanceCell}>{money(movement.running_balance)}</td>
                        {!detailOnly ? (
                          <td className={styles.actionsCell}>
                            {movement.editable !== false ? (
                              <button
                                type="button"
                                className={styles.linkButton}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  startEditingMovement(movement);
                                }}
                              >
                                Editar
                              </button>
                            ) : (
                              <span className={styles.mutedText}>Bloqueado</span>
                            )}
                          </td>
                        ) : null}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {!detailOnly ? <div className={styles.sideColumn}>
            <form className={styles.formCard} onSubmit={submitMovement} ref={movementFormRef}>
                <div className={styles.formHeader}>
                  <div>
                    <h3>
                      {editingMovementId
                        ? movementMode === 'payment'
                          ? 'Editar pago'
                          : 'Editar deuda'
                        : movementMode === 'payment'
                          ? 'Registrar pago'
                          : 'Registrar deuda historica'}
                    </h3>
                    <p>Impacta directamente en la cuenta del cliente.</p>
                  </div>
                  <div className={styles.formActions}>
                    {editingMovementId ? (
                      <button type="button" className={styles.secondaryButton} onClick={resetMovementForm} disabled={saving}>
                        Cancelar edicion
                      </button>
                    ) : null}
                    <button type="submit" className={styles.primaryButton} disabled={saving}>
                      {saving ? 'Guardando...' : editingMovementId ? 'Guardar cambios' : movementMode === 'payment' ? 'Guardar pago' : 'Guardar deuda'}
                    </button>
                  </div>
                </div>

                {editingMovementId ? (
                  <div className={styles.editingNotice}>
                    Editando movimiento #{editingMovementId}. Al guardar se recalcula el saldo de la cuenta.
                  </div>
                ) : null}

                {editingMovement ? (
                  <div className={styles.editingSummary}>
                    <div>
                      <span>Movimiento actual</span>
                      <strong>
                        {editingMovement.entry_label || (editingMovement.movement_type === 'DEBIT' ? 'Debito' : 'Pago')} por {money(editingMovement.amount)}
                      </strong>
                    </div>
                    <small>
                      {formatDate(editingMovement.created_at)} · {editingMovement.reference || editingMovement.payment_method || 'Sin detalle'}
                    </small>
                  </div>
                ) : null}

                <div className={styles.modeSwitcher}>
                  <button
                    type="button"
                    className={`${styles.modeButton} ${movementMode === 'payment' ? styles.modeButtonActive : ''}`}
                    onClick={() => setMode('payment')}
                    disabled={saving}
                  >
                    Pago
                  </button>
                  <button
                    type="button"
                    className={`${styles.modeButton} ${movementMode === 'debt' ? styles.modeButtonActive : ''}`}
                    onClick={() => setMode('debt')}
                    disabled={saving}
                  >
                    Deuda
                  </button>
                </div>

                <div className={styles.formGrid}>
                  <label>
                    <span>Concepto</span>
                    <select
                      value={form.entry_kind}
                      onChange={(e) => setForm((current) => ({ ...current, entry_kind: e.target.value }))}
                    >
                      {movementConceptOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>Importe</span>
                    <input
                      ref={amountInputRef}
                      type="text"
                      inputMode="decimal"
                      value={form.amount}
                      onChange={(e) => setForm((current) => ({ ...current, amount: e.target.value }))}
                      placeholder="306.000"
                      required
                    />
                  </label>
                  <label>
                    <span>{movementMode === 'payment' ? 'Metodo' : 'Origen'}</span>
                    <input
                      value={form.payment_method}
                      onChange={(e) => setForm((current) => ({ ...current, payment_method: e.target.value }))}
                      placeholder={movementMode === 'payment' ? 'Transferencia, efectivo...' : 'Saldo previo, ajuste...'}
                    />
                  </label>
                  <label className={styles.fullWidth}>
                    <span>Detalle</span>
                    <input
                      value={form.reference}
                      onChange={(e) => setForm((current) => ({ ...current, reference: e.target.value }))}
                      placeholder={
                        movementMode === 'payment'
                          ? 'Ej: Recibo manual, transferencia, pago parcial'
                          : 'Ej: Faltante de pago, deuda previa, ajuste historico'
                      }
                    />
                  </label>
                  <label className={styles.fullWidth}>
                    <span>Comprobante</span>
                    <select
                      value={form.invoice_id}
                      onChange={(e) => setForm((current) => ({ ...current, invoice_id: e.target.value }))}
                      disabled={movementMode === 'debt'}
                    >
                      <option value="">Sin asociar</option>
                      {invoices.map((invoice) => (
                        <option key={invoice.id} value={invoice.id}>
                          #{invoice.id} - {invoice.document_type || 'Comprobante'} - {money(invoice.total)}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </form>

            <section className={styles.invoiceCard}>
              <div className={styles.sectionHeader}>
                <div>
                  <h3>Estado de cuenta</h3>
                  <p>Separado por cobranza, vencimiento, notas de credito y ajustes.</p>
                </div>
              </div>
              <div className={styles.breakdownList}>
                <div className={styles.breakdownRowCompact}><span>Pendiente</span><strong>{money(detail.classification?.pending || detail.balance)}</strong></div>
                <div className={styles.breakdownRowCompact}><span>Vencido</span><strong>{money(detail.classification?.overdue || 0)}</strong></div>
                <div className={styles.breakdownRowCompact}><span>Cobranzas</span><strong>{money(detail.classification?.payments || 0)}</strong></div>
                <div className={styles.breakdownRowCompact}><span>Notas de credito</span><strong>{money(detail.classification?.credit_notes || 0)}</strong></div>
                <div className={styles.breakdownRowCompact}><span>Incobrables</span><strong>{money(detail.classification?.writeoffs || 0)}</strong></div>
                <div className={styles.breakdownRowCompact}><span>Ajustes / saldo inicial</span><strong>{money((detail.classification?.adjustments || 0) + (detail.classification?.opening_balance || 0))}</strong></div>
              </div>
            </section>

            <section className={styles.invoiceCard}>
              <div className={styles.sectionHeader}>
                <div>
                  <h3>Comprobantes emitidos</h3>
                  <p>Detalle de comprobantes generados a nombre de este cliente.</p>
                </div>
                <span className={styles.sectionMeta}>{invoices.length} comprobantes</span>
              </div>
              <div className={styles.invoiceList}>
                {invoices.length === 0 ? (
                  <div className={styles.emptyPanel}>No hay comprobantes asociados a este cliente.</div>
                ) : (
                  invoices.map((invoice) => (
                    <article key={invoice.id} className={styles.invoiceItem}>
                      <div className={styles.invoiceMeta}>
                        <strong>#{invoice.id} - {invoice.document_type || 'Comprobante'}</strong>
                        <span>{formatDate(invoice.created_at)}</span>
                        <div className={styles.invoiceActions}>
                          <Link href={`/admin/comprobantes?invoice=${invoice.id}`} className={styles.linkButton}>
                            Ver
                          </Link>
                          <button
                            type="button"
                            className={styles.linkButton}
                            onClick={() => void printInvoice(invoice.id)}
                          >
                            Imprimir
                          </button>
                          <button
                            type="button"
                            className={styles.linkButton}
                            onClick={() => void printInvoice(invoice.id)}
                          >
                            PDF
                          </button>
                        </div>
                      </div>
                      <div className={styles.invoiceAmounts}>
                        <em>{money(invoice.total)}</em>
                        <small>{invoice.sale_mode || invoice.status || 'Emitido'}</small>
                      </div>
                    </article>
                  ))
                )}
              </div>
            </section>
          </div> : null}
        </div>
      </>
    );
  };

  return (
    <div className={`${styles.page} ${detailOnly ? styles.pageDetailOnly : ''}`}>
      <section className={styles.header}>
        <div>
          <h1>Cuentas corrientes</h1>
          <p>Vista operativa inspirada en la app de escritorio: clientes, saldo y movimientos en una sola pantalla.</p>
        </div>
      </section>

      {error ? <div className={styles.error}>{error}</div> : null}

      {!detailOnly ? (
        <>
          <section className={styles.mobilePicker}>
            <div className={styles.mobilePickerHeader}>
              <div>
                <h2>Cuentas disponibles</h2>
                <p>Busca un cliente y toca una cuenta para ver el detalle completo.</p>
              </div>
              <strong>{filteredCustomers.length}</strong>
            </div>

            <div className={styles.searchBar}>
              <span>Buscar</span>
              <input
                className={styles.search}
                placeholder="Nombre, CUIT, telefono o localidad..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            <div className={styles.filterPills}>
              <button
                type="button"
                className={`${styles.filterPill} ${customerFilter === 'all' ? styles.filterPillActive : ''}`}
                onClick={() => setCustomerFilter('all')}
              >
                Todos
              </button>
              <button
                type="button"
                className={`${styles.filterPill} ${customerFilter === 'debt' ? styles.filterPillActive : ''}`}
                onClick={() => setCustomerFilter('debt')}
              >
                Con deuda
              </button>
              <button
                type="button"
                className={`${styles.filterPill} ${customerFilter === 'overdue' ? styles.filterPillActive : ''}`}
                onClick={() => setCustomerFilter('overdue')}
              >
                Vencidos
              </button>
              <button
                type="button"
                className={`${styles.filterPill} ${customerFilter === 'credit' ? styles.filterPillActive : ''}`}
                onClick={() => setCustomerFilter('credit')}
              >
                A favor
              </button>
            </div>

            <div className={styles.mobileCustomerList}>
              {loading ? (
                <div className={styles.emptyPanel}>Cargando cuentas...</div>
              ) : filteredCustomers.length === 0 ? (
                <div className={styles.emptyPanel}>No hay cuentas que coincidan con la busqueda.</div>
              ) : (
                filteredCustomers.map((customer) => (
                  <button
                    key={customer.id}
                    type="button"
                    className={styles.mobileCustomerCard}
                    onClick={() => openCustomerDetail(customer.id)}
                  >
                    <div className={styles.mobileCustomerTop}>
                      <strong>{customer.name}</strong>
                      <span>{customer.balance >= 0 ? `Debe ${money(customer.balance)}` : `Haber ${money(Math.abs(customer.balance))}`}</span>
                    </div>
                    <div className={styles.mobileCustomerMeta}>
                      <span>{customer.email || customer.phone || customer.cuit || 'Sin dato de contacto'}</span>
                      <span>
                        Pend.: {money(customer.classification?.pending || Math.max(0, customer.balance))} - Venc.:{' '}
                        {money(customer.classification?.overdue || 0)}
                      </span>
                      <span>{customer.last_movement ? `Ult. mov.: ${formatDate(customer.last_movement)}` : 'Sin movimientos recientes'}</span>
                    </div>
                  </button>
                ))
              )}
            </div>
          </section>

          <section className={styles.desktopToolbar}>
            <div className={styles.searchBar}>
              <span>Buscar</span>
              <input
                className={styles.search}
                placeholder="Buscar cliente por nombre, CUIT, telefono o localidad..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className={styles.filterPills}>
              <button
                type="button"
                className={`${styles.filterPill} ${customerFilter === 'all' ? styles.filterPillActive : ''}`}
                onClick={() => setCustomerFilter('all')}
              >
                Todos
              </button>
              <button
                type="button"
                className={`${styles.filterPill} ${customerFilter === 'debt' ? styles.filterPillActive : ''}`}
                onClick={() => setCustomerFilter('debt')}
              >
                Con deuda
              </button>
              <button
                type="button"
                className={`${styles.filterPill} ${customerFilter === 'overdue' ? styles.filterPillActive : ''}`}
                onClick={() => setCustomerFilter('overdue')}
              >
                Vencidos
              </button>
              <button
                type="button"
                className={`${styles.filterPill} ${customerFilter === 'credit' ? styles.filterPillActive : ''}`}
                onClick={() => setCustomerFilter('credit')}
              >
                A favor
              </button>
            </div>
            <div className={styles.toolbarActions}>
              <button type="button" className={styles.primaryButton} onClick={() => openMovementForm('payment')}>
                Registrar pago
              </button>
              <button type="button" className={styles.secondaryButton} onClick={() => openMovementForm('debt')}>
                Registrar deuda historica
              </button>
              <Link href="/admin/clientes" className={styles.secondaryButton}>
                Nuevo cliente
              </Link>
              <Link
                href={selectedId ? `/admin/generar-comprobante?customer_id=${selectedId}` : '/admin/generar-comprobante'}
                className={styles.secondaryButton}
              >
                Nuevo comprobante
              </Link>
              <button
                type="button"
                className={styles.dangerButton}
                onClick={() => setShowDeleteModal(true)}
                disabled={!selectedId || deleting}
              >
                {deleting ? 'Eliminando...' : 'Eliminar cuenta'}
              </button>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => requestOutput('print')}
                disabled={!selectedId}
              >
                Imprimir
              </button>
              <button
                type="button"
                className={styles.primaryButton}
                onClick={() => requestOutput('pdf')}
                disabled={!selectedId}
              >
                Exportar PDF
              </button>
              <button type="button" className={styles.secondaryButton} onClick={() => void refreshAll()}>
                Actualizar
              </button>
            </div>
          </section>

          <section className={styles.customerBoard}>
            <div className={styles.boardHeader}>
              <span>{filteredCustomers.length} clientes visibles</span>
              {hideGlobalTotals ? (
                <strong>Totales globales ocultos para este usuario</strong>
              ) : (
                <strong>
                  Pendiente: {money(summary.pending)} - Vencido: {money(summary.overdue)}
                </strong>
              )}
            </div>
            <div className={styles.boardHint}>Click selecciona. Doble click abre el detalle listo para imprimir. La lista prioriza primero saldos vencidos y cuentas con mayor impacto.</div>
            <div className={styles.customerTableWrap}>
              <table className={styles.customerTable}>
                <thead>
                  <tr>
                    <th>Cliente</th>
                    <th>Saldo</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr><td colSpan={2}>Cargando...</td></tr>
                  ) : filteredCustomers.length === 0 ? (
                    <tr><td colSpan={2}>No hay clientes para mostrar.</td></tr>
                  ) : (
                    filteredCustomers.map((customer) => (
                      <tr
                        key={customer.id}
                        className={selectedId === customer.id ? styles.customerRowActive : ''}
                        onClick={() => setSelectedId(customer.id)}
                        onDoubleClick={() => openCustomerDetail(customer.id)}
                      >
                        <td>
                          <div className={styles.customerNameCell}>
                            <strong>{customer.name}</strong>
                            <span>
                              {customer.last_movement ? `Ult. mov.: ${formatDate(customer.last_movement)}` : (customer.email || customer.phone || customer.cuit || 'Sin dato')}
                            </span>
                            <span>
                              Pend.: {money(customer.classification?.pending || Math.max(0, customer.balance))} -
                              Venc.: {money(customer.classification?.overdue || 0)}
                            </span>
                          </div>
                        </td>
                        <td className={styles.customerBalanceCell}>
                          <strong>{customer.balance >= 0 ? `Debe ${money(customer.balance)}` : `Haber ${money(Math.abs(customer.balance))}`}</strong>
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

      {!isMobileLayout || detailOnly ? (
        <section className={styles.content} ref={detailRef}>
          {renderDetailContent()}
        </section>
      ) : null}

      {showDeleteModal && selectedOverview ? (
        <div className={styles.modalOverlay} onClick={() => !deleting && setShowDeleteModal(false)}>
          <aside
            className={styles.confirmModal}
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-account-title"
          >
            <div className={styles.confirmHeader}>
              <div>
                <h2 id="delete-account-title">Eliminar cuenta corriente</h2>
                <p>Esta accion elimina la cuenta corriente aunque tenga saldo o movimientos.</p>
              </div>
            </div>

            <div className={styles.confirmBody}>
              <div className={styles.confirmBlock}>
                <span>Cliente</span>
                <strong>{selectedOverview.name}</strong>
              </div>
              <div className={styles.confirmBlock}>
                <span>Saldo actual</span>
                <strong>{money(selectedOverview.balance)}</strong>
              </div>
              <div className={styles.confirmWarning}>
                Se van a borrar los movimientos de la cuenta. Los comprobantes ya emitidos no se eliminan.
              </div>
            </div>

            <div className={styles.confirmActions}>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => setShowDeleteModal(false)}
                disabled={deleting}
              >
                Cancelar
              </button>
              <button
                type="button"
                className={styles.dangerButton}
                onClick={() => void deleteSelectedAccount()}
                disabled={deleting}
              >
                {deleting ? 'Eliminando...' : 'Confirmar eliminacion'}
              </button>
            </div>
          </aside>
        </div>
      ) : null}

      {showDateRangeModal ? (
        <div className={styles.modalOverlay} onClick={() => setShowDateRangeModal(false)}>
          <aside
            className={styles.confirmModal}
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="date-range-title"
          >
            <div className={styles.confirmHeader}>
              <div>
                <h2 id="date-range-title">{outputMode === 'pdf' ? 'Exportar cuenta a PDF' : 'Imprimir cuenta corriente'}</h2>
                <p>Elegí el rango de fechas para mostrar solo los movimientos necesarios.</p>
              </div>
            </div>

            <div className={styles.confirmBody}>
              <label className={styles.confirmField}>
                <span>Desde</span>
                <input
                  type="date"
                  value={dateRangeDraft.from}
                  onChange={(event) => setDateRangeDraft((current) => ({ ...current, from: event.target.value }))}
                />
              </label>
              <label className={styles.confirmField}>
                <span>Hasta</span>
                <input
                  type="date"
                  value={dateRangeDraft.to}
                  onChange={(event) => setDateRangeDraft((current) => ({ ...current, to: event.target.value }))}
                />
              </label>
              <div className={styles.confirmWarning}>
                Si dejás las fechas vacías, se va a usar el historial completo de la cuenta.
              </div>
            </div>

            <div className={styles.confirmActions}>
              <button type="button" className={styles.secondaryButton} onClick={() => setShowDateRangeModal(false)}>
                Cancelar
              </button>
              <button type="button" className={styles.primaryButton} onClick={() => void confirmOutput()}>
                {outputMode === 'pdf' ? 'Continuar a PDF' : 'Continuar a impresión'}
              </button>
            </div>
          </aside>
        </div>
      ) : null}
    </div>
  );
}
