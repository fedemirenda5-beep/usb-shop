'use client';

import { useEffect, useMemo, useState } from 'react';
import { getApiBaseUrl, loadRuntimeConfig } from '@/lib/api';
import styles from './comprobantes.module.css';

type Invoice = {
  id: number;
  customer_id?: number | null;
  customer_name: string;
  total: number;
  created_at: string;
  document_type?: string | null;
  sale_mode?: string | null;
  due_date?: string | null;
  notes?: string | null;
};

type InvoiceDetail = {
  invoice: Invoice & {
    customer_email?: string | null;
    customer_phone?: string | null;
    locality?: string | null;
    address?: string | null;
    tax_condition?: string | null;
    cuit?: string | null;
    external_ref?: string | null;
  };
  items: Array<{
    id: number;
    product_id?: number | null;
    product_name: string;
    quantity: number;
    unit_price: number;
    line_total: number;
    image_path?: string | null;
  }>;
  payments: Array<{
    id: number;
    amount: number;
    movement_type: string;
    reference?: string | null;
    created_at?: string | null;
    payment_method?: string | null;
  }>;
  summary: {
    items: number;
    subtotal: number;
    payments_total: number;
    balance_due: number;
  };
};

const money = (value: number) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(value || 0);

const formatDate = (value?: string | null) => {
  if (!value) return '-';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString('es-AR');
};

export default function ComprobantesPage() {
  const [items, setItems] = useState<Invoice[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<InvoiceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState('');
  const [detailError, setDetailError] = useState('');
  const [search, setSearch] = useState('');

  async function loadDetail(invoiceId: number) {
    try {
      setDetailLoading(true);
      setDetailError('');
      await loadRuntimeConfig();
      const res = await fetch(`${getApiBaseUrl()}/admin/invoices/${invoiceId}`, { credentials: 'include' });
      if (!res.ok) throw new Error('No se pudo cargar el detalle del comprobante');
      setDetail(await res.json());
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : 'Error cargando detalle');
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }

  useEffect(() => {
    const load = async () => {
      try {
        setLoading(true);
        await loadRuntimeConfig();
        const res = await fetch(`${getApiBaseUrl()}/admin/invoices?limit=300`, { credentials: 'include' });
        if (!res.ok) throw new Error('No se pudieron cargar los comprobantes');
        const data = await res.json();
        setItems(data);
        if (data.length > 0) setSelectedId((current: number | null) => current ?? data[0].id);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error cargando comprobantes');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    loadDetail(selectedId);
  }, [selectedId]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((item) =>
      [item.customer_name, item.document_type || '', item.notes || '', String(item.id)].join(' ').toLowerCase().includes(needle)
    );
  }, [items, search]);

  return (
    <div className={styles.page}>
      <section className={styles.header}>
        <div>
          <h1>Comprobantes emitidos</h1>
          <p>Historial de facturas, remitos y documentos de venta traidos desde la base actual.</p>
        </div>
        <input
          className={styles.search}
          placeholder="Buscar por cliente, tipo o numero..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </section>

      {error ? <div className={styles.error}>{error}</div> : null}

      <div className={styles.layout}>
        <div className={styles.tablePane}>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Tipo</th>
                  <th>Cliente</th>
                  <th>Modo</th>
                  <th>Total</th>
                  <th>Emision</th>
                  <th>Vencimiento</th>
                  <th>Notas</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={8}>Cargando comprobantes...</td></tr>
                ) : filtered.length === 0 ? (
                  <tr><td colSpan={8}>No hay comprobantes para mostrar.</td></tr>
                ) : (
                  filtered.map((item) => (
                    <tr
                      key={item.id}
                      className={selectedId === item.id ? styles.selectedRow : ''}
                      onClick={() => setSelectedId(item.id)}
                    >
                      <td><button type="button" className={styles.linkButton}>#{item.id}</button></td>
                      <td>{item.document_type || '-'}</td>
                      <td>{item.customer_name}</td>
                      <td>{item.sale_mode || '-'}</td>
                      <td className={styles.total}>{money(item.total)}</td>
                      <td>{formatDate(item.created_at)}</td>
                      <td>{formatDate(item.due_date)}</td>
                      <td>{item.notes || '-'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <aside className={styles.detailPane}>
          {detailError ? <div className={styles.error}>{detailError}</div> : null}
          {detailLoading ? <div className={styles.empty}>Cargando detalle...</div> : null}
          {!detailLoading && !detail ? <div className={styles.empty}>Selecciona un comprobante.</div> : null}
          {detail ? (
            <div className={styles.printArea}>
              <div className={styles.detailHeader}>
                <div>
                  <h2>{detail.invoice.document_type || 'Comprobante'} #{detail.invoice.id}</h2>
                  <p>{detail.invoice.customer_name}</p>
                  <p>{formatDate(detail.invoice.created_at)}</p>
                </div>
                <div className={styles.actions}>
                  <button type="button" className={styles.printButton} onClick={() => window.print()}>
                    Imprimir
                  </button>
                </div>
              </div>

              <div className={styles.detailMeta}>
                <div><span>Condicion</span><strong>{detail.invoice.tax_condition || '-'}</strong></div>
                <div><span>CUIT/DNI</span><strong>{detail.invoice.cuit || '-'}</strong></div>
                <div><span>Venta</span><strong>{detail.invoice.sale_mode || '-'}</strong></div>
                <div><span>Vencimiento</span><strong>{formatDate(detail.invoice.due_date)}</strong></div>
              </div>

              <div className={styles.customerBlock}>
                <p>{detail.invoice.address || detail.invoice.locality || 'Sin domicilio'}</p>
                <p>{detail.invoice.customer_phone || detail.invoice.customer_email || 'Sin contacto'}</p>
                {detail.invoice.notes ? <p>Notas: {detail.invoice.notes}</p> : null}
              </div>

              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Producto</th>
                      <th>Cant.</th>
                      <th>Unitario</th>
                      <th>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.items.map((item) => (
                      <tr key={item.id}>
                        <td>{item.product_name}</td>
                        <td>{item.quantity}</td>
                        <td>{money(item.unit_price)}</td>
                        <td className={styles.total}>{money(item.line_total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className={styles.summaryGrid}>
                <div><span>Items</span><strong>{detail.summary.items}</strong></div>
                <div><span>Subtotal</span><strong>{money(detail.summary.subtotal)}</strong></div>
                <div><span>Cobrado</span><strong>{money(detail.summary.payments_total)}</strong></div>
                <div><span>Saldo</span><strong>{money(detail.summary.balance_due)}</strong></div>
              </div>

              <div className={styles.paymentBlock}>
                <h3>Movimientos asociados</h3>
                {detail.payments.length === 0 ? (
                  <p>Sin pagos o ajustes asociados.</p>
                ) : (
                  <div className={styles.movementList}>
                    {detail.payments.map((payment) => (
                      <article key={payment.id} className={styles.movementItem}>
                        <strong>{payment.movement_type === 'CREDIT' ? 'Cobranza' : 'Debito'}</strong>
                        <span>{payment.payment_method || payment.reference || 'Movimiento manual'}</span>
                        <span>{formatDate(payment.created_at)}</span>
                        <em>{money(payment.amount)}</em>
                      </article>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
