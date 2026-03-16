'use client';

import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { getApiBaseUrl, loadRuntimeConfig } from '@/lib/api';
import styles from './cuentas-corrientes.module.css';

type Aging = {
  current: number;
  d1_30: number;
  d31_60: number;
  d61_90: number;
  d90_plus: number;
  total: number;
};

type CustomerOverview = {
  id: number;
  name: string;
  email?: string | null;
  phone?: string | null;
  sale_mode?: string | null;
  balance: number;
  aging: Aging;
  last_movement?: string | null;
};

type Movement = {
  id: number;
  movement_type: string;
  amount: number;
  signed_amount: number;
  reference?: string | null;
  invoice_id?: number | null;
  created_at?: string | null;
  payment_method?: string | null;
  document_type?: string | null;
  due_date?: string | null;
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
  movements: Movement[];
};

type InvoiceOption = {
  id: number;
  total: number;
  created_at: string;
  document_type?: string | null;
};

const money = (value: number) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(value || 0);

const formatDate = (value?: string | null) => {
  if (!value) return '-';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString('es-AR');
};

export default function CuentasCorrientesPage() {
  const [customers, setCustomers] = useState<CustomerOverview[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [invoices, setInvoices] = useState<InvoiceOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [legacyMode, setLegacyMode] = useState(false);
  const [search, setSearch] = useState('');
  const [summary, setSummary] = useState({ customers: 0, debit: 0, credit: 0, balance: 0 });
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    movement_type: 'CREDIT',
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
  });

  const mapLegacyCustomers = (rows: Array<Record<string, unknown>>) => {
    const normalized = rows.map((row) => ({
      id: Number(row.id || 0),
      name: String(row.name || 'Sin nombre'),
      email: typeof row.email === 'string' ? row.email : null,
      phone: typeof row.phone === 'string' ? row.phone : null,
      sale_mode: 'CUENTA_CORRIENTE',
      balance: Number(row.balance || 0),
      aging: { ...emptyAging(), total: Number(row.balance || 0) },
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
    const movements = signedAscending.map((item) => {
      runningBalance += item.signed_amount;
      return { ...item, running_balance: runningBalance };
    }).reverse();
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
      setSummary(data.summary || { customers: 0, debit: 0, credit: 0, balance: 0 });
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
    await loadRuntimeConfig();
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
    load();
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
    loadSelectedCustomer();
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
      [customer.name, customer.email || '', customer.phone || ''].join(' ').toLowerCase().includes(needle)
    );
  }, [customers, search]);

  return (
    <div className={styles.page}>
      <section className={styles.header}>
        <div>
          <h1>Cuentas corrientes</h1>
          <p>Vista inspirada en la app de escritorio: saldos, aging y movimientos por cliente.</p>
        </div>
      </section>

      {error ? <div className={styles.error}>{error}</div> : null}

      <section className={styles.summaryGrid}>
        <article className={styles.metricCard}><span>Clientes</span><strong>{summary.customers}</strong></article>
        <article className={styles.metricCard}><span>Debe</span><strong>{money(summary.debit)}</strong></article>
        <article className={styles.metricCard}><span>Haber</span><strong>{money(summary.credit)}</strong></article>
        <article className={styles.metricCard}><span>Saldo abierto</span><strong>{money(summary.balance)}</strong></article>
      </section>

      <div className={styles.layout}>
        <aside className={styles.sidebar}>
          <input
            className={styles.search}
            placeholder="Buscar cliente..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className={styles.customerList}>
            {loading ? <p>Cargando...</p> : null}
            {filteredCustomers.map((customer) => (
              <button
                key={customer.id}
                type="button"
                className={`${styles.customerItem} ${selectedId === customer.id ? styles.active : ''}`}
                onClick={() => setSelectedId(customer.id)}
              >
                <div>
                  <strong>{customer.name}</strong>
                  <span>{customer.email || customer.phone || 'Sin dato'}</span>
                </div>
                <em>{money(customer.balance)}</em>
              </button>
            ))}
          </div>
        </aside>

        <section className={styles.content}>
          {detail ? (
            <>
              <div className={styles.customerHeader}>
                <div>
                  <h2>{detail.customer.name}</h2>
                  <p>
                    {detail.customer.tax_condition || 'Sin condicion fiscal'} · {detail.customer.cuit || 'Sin CUIT/DNI'}
                  </p>
                  <p>{detail.customer.address || detail.customer.locality || 'Sin domicilio'}</p>
                </div>
                <div className={styles.balanceBox}>
                  <span>Saldo actual</span>
                  <strong>{money(detail.balance)}</strong>
                </div>
              </div>

              <div className={styles.agingGrid}>
                <div><span>Al dia</span><strong>{money(detail.aging.current)}</strong></div>
                <div><span>1-30</span><strong>{money(detail.aging.d1_30)}</strong></div>
                <div><span>31-60</span><strong>{money(detail.aging.d31_60)}</strong></div>
                <div><span>61-90</span><strong>{money(detail.aging.d61_90)}</strong></div>
                <div><span>90+</span><strong>{money(detail.aging.d90_plus)}</strong></div>
              </div>

              <form className={styles.formCard} onSubmit={submitMovement}>
                <div className={styles.formHeader}>
                  <div>
                    <h3>Registrar cobranza o ajuste</h3>
                    <p>Impacta directamente en la cuenta corriente del cliente.</p>
                  </div>
                  <button type="submit" className={styles.primaryButton} disabled={saving}>
                    {saving ? 'Guardando...' : 'Guardar movimiento'}
                  </button>
                </div>

                <div className={styles.formGrid}>
                  <label>
                    <span>Tipo</span>
                    <select
                      value={form.movement_type}
                      onChange={(e) => setForm((current) => ({ ...current, movement_type: e.target.value }))}
                    >
                      <option value="CREDIT">Cobranza / pago del cliente</option>
                      <option value="DEBIT">Debito manual</option>
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
                    <span>Metodo</span>
                    <input
                      value={form.payment_method}
                      onChange={(e) => setForm((current) => ({ ...current, payment_method: e.target.value }))}
                      placeholder="Transferencia, efectivo, cheque..."
                    />
                  </label>
                  <label>
                    <span>Comprobante</span>
                    <select
                      value={form.invoice_id}
                      onChange={(e) => setForm((current) => ({ ...current, invoice_id: e.target.value }))}
                    >
                      <option value="">Sin asociar</option>
                      {invoices.map((invoice) => (
                        <option key={invoice.id} value={invoice.id}>
                          #{invoice.id} · {invoice.document_type || 'Comprobante'} · {money(invoice.total)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className={styles.fullWidth}>
                    <span>Referencia</span>
                    <input
                      value={form.reference}
                      onChange={(e) => setForm((current) => ({ ...current, reference: e.target.value }))}
                      placeholder="Ej: Transferencia 15/03, recibo manual, ajuste de saldo"
                    />
                  </label>
                </div>
              </form>

              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Fecha</th>
                      <th>Tipo</th>
                      <th>Comprobante</th>
                      <th>Detalle</th>
                      <th>Debe/Haber</th>
                      <th>Saldo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.movements.length === 0 ? (
                      <tr><td colSpan={6}>Sin movimientos.</td></tr>
                    ) : (
                      detail.movements.map((movement) => (
                        <tr key={movement.id}>
                          <td>{formatDate(movement.created_at)}</td>
                          <td>{movement.movement_type === 'DEBIT' ? 'Debito' : 'Credito'}</td>
                          <td>{movement.document_type || '-'} {movement.invoice_id ? `#${movement.invoice_id}` : ''}</td>
                          <td>{movement.reference || movement.payment_method || '-'}</td>
                          <td className={movement.signed_amount >= 0 ? styles.debit : styles.credit}>
                            {money(movement.signed_amount)}
                          </td>
                          <td>{money(movement.running_balance)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <div className={styles.empty}>Selecciona un cliente para ver su cuenta corriente.</div>
          )}
        </section>
      </div>
    </div>
  );
}
