'use client';

import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { getApiBaseUrl, loadRuntimeConfig } from '@/lib/api';
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

const formatDate = (value?: string | null) => {
  return formatArgentinaDateTime(value);
};

export default function CuentasCorrientesPage() {
  const { user } = useAdminSession();
  const detailRef = useRef<HTMLElement | null>(null);
  const [customers, setCustomers] = useState<CustomerOverview[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [invoices, setInvoices] = useState<InvoiceOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState('');
  const [legacyMode, setLegacyMode] = useState(false);
  const [search, setSearch] = useState('');
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
  const [form, setForm] = useState({
    movement_type: 'CREDIT',
    entry_kind: 'PAYMENT',
    amount: '',
    payment_method: 'Transferencia',
    reference: '',
    invoice_id: '',
  });

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

  const mapLegacyCustomers = (rows: Array<Record<string, unknown>>) => {
    const normalized = rows.map((row) => ({
      id: Number(row.id || 0),
      name: String(row.name || 'Sin nombre'),
      email: typeof row.email === 'string' ? row.email : null,
      phone: typeof row.phone === 'string' ? row.phone : null,
      sale_mode: 'CUENTA_CORRIENTE',
      locality: typeof row.city === 'string' ? row.city : null,
      address: typeof row.address === 'string' ? row.address : null,
      tax_condition: typeof row.tax_condition === 'string' ? row.tax_condition : null,
      cuit: typeof row.tax_id === 'string' ? row.tax_id : null,
      debit: Number(row.balance || 0) > 0 ? Number(row.balance || 0) : 0,
      credit: Number(row.balance || 0) < 0 ? Math.abs(Number(row.balance || 0)) : 0,
      balance: Number(row.balance || 0),
      aging: { ...emptyAging(), total: Number(row.balance || 0) },
      classification: {
        ...emptyAging().classification,
        pending: Math.max(0, Number(row.balance || 0)),
      },
      last_movement: typeof row.updated_at === 'string' ? row.updated_at : null,
    }));
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

  const mapLegacyDetail = (
    customer: Record<string, unknown>,
    movementsPayload: { balance?: number; items?: Array<Record<string, unknown>> }
  ): CustomerDetail => {
    const items = Array.isArray(movementsPayload.items) ? movementsPayload.items : [];
    const signedAscending = [...items]
      .map((item) => ({
        id: Number(item.id || 0),
        movement_type: String(item.movement_type || ''),
        amount: Number(item.amount || 0),
        signed_amount: Number(item.signed_amount || 0),
        reference: typeof item.description === 'string' ? item.description : null,
        invoice_id: null,
        created_at: typeof item.created_at === 'string' ? item.created_at : null,
        payment_method: null,
        document_type:
          typeof item.document_type === 'string' && typeof item.document_number === 'string'
            ? `${item.document_type} ${item.document_number}`.trim()
            : typeof item.document_type === 'string'
              ? item.document_type
              : null,
        due_date: typeof item.due_date === 'string' ? item.due_date : null,
        running_balance: 0,
      }))
      .reverse();
    let runningBalance = 0;
    const movements = signedAscending
      .map((item) => {
        runningBalance += item.signed_amount;
        return { ...item, running_balance: runningBalance };
      })
      .reverse();
    const balance = Number(movementsPayload.balance || customer.balance || 0);
    return {
      customer: {
        id: Number(customer.id || 0),
        name: String(customer.name || 'Sin nombre'),
        email: typeof customer.email === 'string' ? customer.email : null,
        phone: typeof customer.phone === 'string' ? customer.phone : null,
        sale_mode: 'CUENTA_CORRIENTE',
        locality: typeof customer.city === 'string' ? customer.city : null,
        address: typeof customer.address === 'string' ? customer.address : null,
        tax_condition: typeof customer.tax_condition === 'string' ? customer.tax_condition : null,
        cuit: typeof customer.tax_id === 'string' ? customer.tax_id : null,
      },
      balance,
      aging: { ...emptyAging(), total: balance },
      classification: {
        ...emptyAging().classification,
        pending: Math.max(0, balance),
      },
      movements,
    };
  };

  async function loadOverview() {
    setLoading(true);
    await loadRuntimeConfig();
    const res = await fetch(`${getApiBaseUrl()}/admin/cc/overview`, { credentials: 'include' });
    if (res.ok) {
      const data = await res.json();
      setLegacyMode(false);
      setCustomers(data.customers || []);
      setSummary(
        data.summary || {
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
      if ((data.customers || []).length > 0) setSelectedId((current) => current ?? data.customers[0].id);
      return;
    }
    if (res.status !== 404) {
      throw new Error('No se pudo cargar cuentas corrientes');
    }
    const legacyRes = await fetch(`${getApiBaseUrl()}/admin/account-customers?limit=300`, { credentials: 'include' });
    if (!legacyRes.ok) throw new Error('No se pudo cargar cuentas corrientes');
    const legacyRows = await legacyRes.json();
    const data = mapLegacyCustomers(Array.isArray(legacyRows) ? legacyRows : []);
    setLegacyMode(true);
    setCustomers(data.customers);
    setSummary(data.summary);
    if (data.customers.length > 0) setSelectedId((current) => current ?? data.customers[0].id);
  }

  async function loadDetail(customerId: number) {
    setDetailLoading(true);
    await loadRuntimeConfig();
    try {
      if (!legacyMode) {
        const res = await fetch(`${getApiBaseUrl()}/admin/cc/${customerId}`, { credentials: 'include' });
        if (res.ok) {
          setDetail(await res.json());
          return;
        }
        if (res.status !== 404) throw new Error('No se pudo cargar el detalle');
        setLegacyMode(true);
      }
      const [customerRes, movementsRes] = await Promise.all([
        fetch(`${getApiBaseUrl()}/admin/account-customers/${customerId}`, { credentials: 'include' }),
        fetch(`${getApiBaseUrl()}/admin/account-customers/${customerId}/movements`, { credentials: 'include' }),
      ]);
      if (!customerRes.ok || !movementsRes.ok) throw new Error('No se pudo cargar el detalle');
      const customer = await customerRes.json();
      const movements = await movementsRes.json();
      setDetail(mapLegacyDetail(customer, movements));
    } finally {
      setDetailLoading(false);
    }
  }

  async function loadInvoices(customerId: number) {
    if (legacyMode) {
      setInvoices([]);
      return;
    }
    await loadRuntimeConfig();
    const res = await fetch(`${getApiBaseUrl()}/admin/invoices?customer_id=${customerId}&limit=100`, { credentials: 'include' });
    if (!res.ok) throw new Error('No se pudieron cargar los comprobantes del cliente');
    const data = await res.json();
    setInvoices(data || []);
  }

  useEffect(() => {
    const load = async () => {
      try {
        await loadOverview();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error cargando cuentas corrientes');
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    const loadSelectedCustomer = async () => {
      try {
        await Promise.all([loadDetail(selectedId), loadInvoices(selectedId)]);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error cargando el detalle');
      }
    };
    void loadSelectedCustomer();
  }, [selectedId]);

  const submitMovement = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedId) return;
    try {
      setSaving(true);
      setError('');
      await loadRuntimeConfig();
      const endpoint = legacyMode
        ? `${getApiBaseUrl()}/admin/account-customers/${selectedId}/movements`
        : `${getApiBaseUrl()}/admin/cc/${selectedId}/movements`;
      const payload = legacyMode
        ? {
            movement_type: form.movement_type,
            amount: Number(form.amount || 0),
            description: form.reference || form.payment_method || null,
          }
        : {
            movement_type: form.movement_type,
            entry_kind: form.entry_kind,
            amount: Number(form.amount || 0),
            payment_method: form.payment_method || null,
            reference: form.reference || null,
            invoice_id: form.invoice_id ? Number(form.invoice_id) : null,
          };
      const res = await fetch(endpoint, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || 'No se pudo registrar el movimiento');
      await Promise.all([loadOverview(), loadDetail(selectedId), loadInvoices(selectedId)]);
      setForm((current) => ({
        ...current,
        amount: '',
        reference: '',
        invoice_id: '',
        entry_kind: movementMode === 'payment' ? 'PAYMENT' : 'ADJUSTMENT',
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error guardando movimiento');
    } finally {
      setSaving(false);
    }
  };

  const filteredCustomers = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return customers;
    return customers.filter((customer) =>
      [customer.name, customer.email || '', customer.phone || '', customer.cuit || '', customer.locality || '']
        .join(' ')
        .toLowerCase()
        .includes(needle)
    );
  }, [customers, search]);

  const selectedOverview = useMemo(
    () => customers.find((customer) => customer.id === selectedId) || null,
    [customers, selectedId]
  );

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

  const visibleMovementSummary = useMemo(() => {
    return visibleMovements.reduce(
      (acc, movement) => {
        if (movement.movement_type === 'DEBIT') acc.debits += movement.amount;
        if (movement.movement_type === 'CREDIT') acc.credits += movement.amount;
        acc.movements += 1;
        return acc;
      },
      { debits: 0, credits: 0, movements: 0 }
    );
  }, [visibleMovements]);

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
        await Promise.all([loadDetail(selectedId), loadInvoices(selectedId)]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error cargando cuentas corrientes');
    }
  };

  const openCustomerDetail = (customerId: number) => {
    setSelectedId(customerId);
    setDetailOnly(true);
    setOutputRange(null);
    window.requestAnimationFrame(() => {
      detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
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
      if (!detail || detail.customer.id !== selectedId) {
        await Promise.all([loadDetail(selectedId), loadInvoices(selectedId)]);
      }
      setOutputRange({ ...dateRangeDraft });
      setDetailOnly(true);
      setShowDateRangeModal(false);
      window.setTimeout(() => window.print(), 180);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo preparar la exportación');
    }
  };

  const deleteSelectedAccount = async () => {
    if (!selectedId || !selectedOverview) return;
    try {
      setDeleting(true);
      setError('');
      await loadRuntimeConfig();
      const endpoint = legacyMode
        ? `${getApiBaseUrl()}/admin/account-customers/${selectedId}`
        : `${getApiBaseUrl()}/admin/cc/${selectedId}`;
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
      setError(err instanceof Error ? err.message : 'Error eliminando cuenta');
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
              <span>Período visible: {rangeLabel}</span>
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
                <button type="button" className={styles.secondaryButton} onClick={() => setMode('payment')}>
                  Registrar pago
                </button>
                <button type="button" className={styles.secondaryButton} onClick={() => setMode('debt')}>
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
                  <span>Movimiento neto del período</span>
                  <strong>{money(visibleMovementSummary.debits - visibleMovementSummary.credits)}</strong>
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
                  </tr>
                </thead>
                <tbody>
                  {visibleMovements.length === 0 ? (
                    <tr><td colSpan={6}>Sin movimientos.</td></tr>
                  ) : (
                    visibleMovements.map((movement) => (
                      <tr key={movement.id}>
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
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {!detailOnly ? <div className={styles.sideColumn}>
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
                      <div>
                        <strong>#{invoice.id} - {invoice.document_type || 'Comprobante'}</strong>
                        <span>{formatDate(invoice.created_at)}</span>
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

            <form className={styles.formCard} onSubmit={submitMovement}>
                <div className={styles.formHeader}>
                  <div>
                    <h3>{movementMode === 'payment' ? 'Registrar pago' : 'Registrar deuda historica'}</h3>
                    <p>Impacta directamente en la cuenta del cliente.</p>
                  </div>
                  <button type="submit" className={styles.primaryButton} disabled={saving}>
                    {saving ? 'Guardando...' : movementMode === 'payment' ? 'Guardar pago' : 'Guardar deuda'}
                  </button>
                </div>

                <div className={styles.modeSwitcher}>
                  <button
                    type="button"
                    className={`${styles.modeButton} ${movementMode === 'payment' ? styles.modeButtonActive : ''}`}
                    onClick={() => setMode('payment')}
                  >
                    Pago
                  </button>
                  <button
                    type="button"
                    className={`${styles.modeButton} ${movementMode === 'debt' ? styles.modeButtonActive : ''}`}
                    onClick={() => setMode('debt')}
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
                      type="number"
                      min="0"
                      step="0.01"
                      value={form.amount}
                      onChange={(e) => setForm((current) => ({ ...current, amount: e.target.value }))}
                      placeholder="0.00"
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
            <div className={styles.toolbarActions}>
              <button type="button" className={styles.primaryButton} onClick={() => setMode('payment')}>
                Registrar pago
              </button>
              <button type="button" className={styles.secondaryButton} onClick={() => setMode('debt')}>
                Registrar deuda historica
              </button>
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
            <div className={styles.boardHint}>Doble click sobre un cliente para abrir su detalle listo para imprimir o exportar.</div>
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
                              Pend.: {money(customer.classification?.pending || Math.max(0, customer.balance))} ·
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

      <section className={styles.content} ref={detailRef}>
        {renderDetailContent()}
      </section>

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
                <p>Esta accion solo se puede completar si la cuenta tiene deuda 0. El historial no bloquea la eliminacion.</p>
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
                Si el saldo es distinto de 0, el sistema no la va a borrar y te va a mostrar el motivo.
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
