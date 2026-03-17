'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { getApiBaseUrl, loadRuntimeConfig } from '@/lib/api';
import styles from './comprobantes.module.css';

type Invoice = {
  id: number;
  customer_id?: number | null;
  customer_name: string;
  seller_id?: number | null;
  seller_name?: string | null;
  total: number;
  created_at: string;
  document_type?: string | null;
  sale_mode?: string | null;
  price_list?: number | null;
  due_date?: string | null;
  notes?: string | null;
  payment_method?: string | null;
  commission_amount?: number | null;
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
    payment_method?: string | null;
    price_list?: number | null;
    seller_name?: string | null;
    seller_commission_percent?: number | null;
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

const getPriceListLabel = (value?: number | null) => {
  if (value === 1) return 'Lista 1';
  if (value === 2) return 'Lista 2';
  return 'Lista especial';
};

export default function ComprobantesPage() {
  const [items, setItems] = useState<Invoice[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<InvoiceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState('');
  const [detailError, setDetailError] = useState('');
  const [detailOnly, setDetailOnly] = useState(false);
  const [search, setSearch] = useState('');
  const [deletingId, setDeletingId] = useState<number | null>(null);

  async function loadDetail(invoiceId: number) {
    try {
      setDetailLoading(true);
      setDetailError('');
      await loadRuntimeConfig();
      const res = await fetch(`${getApiBaseUrl()}/admin/invoices/${invoiceId}`, { credentials: 'include' });
      if (!res.ok) throw new Error('No se pudo cargar el detalle del comprobante');
      const payload = await res.json();
      setDetail(payload);
      return payload as InvoiceDetail;
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : 'Error cargando detalle');
      setDetail(null);
      return null;
    } finally {
      setDetailLoading(false);
    }
  }

  async function openInvoice(invoiceId: number, autoPrint = false) {
    setSelectedId(invoiceId);
    setDetailOnly(true);
    const loaded = await loadDetail(invoiceId);
    if (loaded && autoPrint) {
      window.setTimeout(() => window.print(), 150);
    }
  }

  async function loadInvoices() {
    await loadRuntimeConfig();
    const res = await fetch(`${getApiBaseUrl()}/admin/invoices?limit=300`, { credentials: 'include' });
    if (!res.ok) throw new Error('No se pudieron cargar los comprobantes');
    const data = await res.json();
    setItems(data);
    if (data.length > 0) setSelectedId((current: number | null) => current ?? data[0].id);
  }

  useEffect(() => {
    const load = async () => {
      try {
        setLoading(true);
        await loadInvoices();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error cargando comprobantes');
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, []);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((item) =>
      [item.customer_name, item.document_type || '', item.notes || '', String(item.id)].join(' ').toLowerCase().includes(needle)
    );
  }, [items, search]);

  const deleteInvoice = async (invoice: Invoice) => {
    const confirmed = window.confirm(
      `Vas a cancelar el comprobante #${invoice.id}. Esto eliminara el comprobante, revertira stock y quitara los movimientos de cuenta corriente asociados.`
    );
    if (!confirmed) return;

    try {
      setDeletingId(invoice.id);
      setError('');
      setDetailError('');
      await loadRuntimeConfig();
      const res = await fetch(`${getApiBaseUrl()}/admin/invoices/${invoice.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || 'No se pudo cancelar el comprobante');
      await loadInvoices();
      if (selectedId === invoice.id) {
        setSelectedId(null);
        setDetail(null);
        setDetailOnly(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error cancelando comprobante');
    } finally {
      setDeletingId(null);
    }
  };

  const printDocument = () => {
    window.print();
  };

  const exportPdf = () => {
    window.print();
  };

  return (
    <div className={styles.page}>
      <section className={styles.header}>
        <div>
          <h1>Comprobantes emitidos</h1>
          <p>Historial de facturas, remitos y ventas reales tomadas desde la base actual.</p>
        </div>
        <div className={styles.headerActions}>
          <Link href="/admin/generar-comprobante" className={styles.createButton}>
            Generar comprobante
          </Link>
          <input
            className={styles.search}
            placeholder="Buscar por cliente, tipo o numero..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </section>

      {error ? <div className={styles.error}>{error}</div> : null}

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
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={9}>Cargando comprobantes...</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={9}>No hay comprobantes para mostrar.</td></tr>
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
                    <td className={styles.rowActions}>
                      <button
                        type="button"
                        className={styles.secondaryButton}
                        onClick={(event) => {
                          event.stopPropagation();
                          void openInvoice(item.id, false);
                        }}
                      >
                        Ver comprobante
                      </button>
                      <button
                        type="button"
                        className={styles.printButton}
                        onClick={(event) => {
                          event.stopPropagation();
                          void openInvoice(item.id, true);
                        }}
                      >
                        Imprimir
                      </button>
                      <button
                        type="button"
                        className={styles.deleteButton}
                        disabled={deletingId === item.id}
                        onClick={(event) => {
                          event.stopPropagation();
                          void deleteInvoice(item);
                        }}
                      >
                        {deletingId === item.id ? 'Cancelando...' : 'Cancelar'}
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {detailOnly ? (
        <div className={styles.modalOverlay} onClick={() => setDetailOnly(false)}>
          <aside className={styles.detailModal} onClick={(event) => event.stopPropagation()}>
            <div className={styles.detailToolbar}>
              <button type="button" className={styles.pdfButton} onClick={exportPdf}>
                Exportar PDF
              </button>
              <button type="button" className={styles.printButton} onClick={printDocument}>
                Imprimir
              </button>
              <button type="button" className={styles.secondaryButton} onClick={() => setDetailOnly(false)}>
                Cerrar
              </button>
            </div>
            {detailError ? <div className={styles.error}>{detailError}</div> : null}
            {detailLoading ? <div className={styles.empty}>Cargando detalle...</div> : null}
            {!detailLoading && !detail ? <div className={styles.empty}>No se pudo abrir el comprobante.</div> : null}
            {detail ? (
              <div className={styles.printArea}>
                <div className={styles.documentShell}>
                  <div className={styles.desktopAccentBar} />

                  <div className={styles.printBanner}>
                    <div className={styles.logoBox}>
                      <img src="/logo-small.jpeg" alt="USB Shop" className={styles.logoImage} />
                    </div>
                    <div className={styles.docCenter}>
                      <div className={styles.docKindBadge}>
                        {detail.invoice.document_type || 'Comprobante'}
                      </div>
                    </div>
                    <div className={styles.brandHead}>
                      <div className={styles.brandName}>USB Shop</div>
                      <div className={styles.brandMeta}>
                        Venta mayorista
                        <br />
                        Comprobante emitido desde admin
                      </div>
                    </div>
                  </div>

                  <div className={styles.desktopPanel}>
                    <div className={styles.sectionTitle}>Datos del cliente</div>
                    <div className={styles.customerBlock}>
                      <strong>{detail.invoice.customer_name}</strong>
                      <span>{detail.invoice.address || detail.invoice.locality || 'Sin domicilio registrado'}</span>
                      <span>{detail.invoice.customer_phone || detail.invoice.customer_email || 'Sin contacto registrado'}</span>
                      <span>{detail.invoice.cuit ? `CUIT / DNI: ${detail.invoice.cuit}` : 'CUIT / DNI: -'}</span>
                      <span>{detail.invoice.tax_condition ? `Condicion fiscal: ${detail.invoice.tax_condition}` : 'Condicion fiscal: -'}</span>
                    </div>
                  </div>

                  <div className={styles.desktopPanel}>
                    <div className={styles.sectionTitle}>Resumen</div>
                    <div className={styles.summaryRows}>
                      <div className={styles.metaRow}><span>Numero</span><strong>#{detail.invoice.id}</strong></div>
                      <div className={styles.metaRow}><span>Fecha de emision</span><strong>{formatDate(detail.invoice.created_at)}</strong></div>
                      <div className={styles.metaRow}><span>Vencimiento</span><strong>{formatDate(detail.invoice.due_date)}</strong></div>
                      <div className={styles.metaRow}><span>Vendedor</span><strong>{detail.invoice.seller_name || '-'}</strong></div>
                      <div className={styles.metaRow}><span>Modo de venta</span><strong>{detail.invoice.sale_mode || '-'}</strong></div>
                      <div className={styles.metaRow}><span>Forma de pago</span><strong>{detail.invoice.payment_method || '-'}</strong></div>
                      <div className={styles.metaRow}><span>Lista de precios</span><strong>{getPriceListLabel(detail.invoice.price_list)}</strong></div>
                      <div className={styles.metaRow}><span>Referencia externa</span><strong>{detail.invoice.external_ref || '-'}</strong></div>
                      <div className={styles.metaRow}><span>Estado</span><strong>{detail.summary.balance_due > 0 ? 'Pendiente' : 'Emitido'}</strong></div>
                    </div>
                  </div>

                  {detail.invoice.notes ? (
                    <div className={styles.notesBox}>
                      <span className={styles.sectionTitle}>Observaciones</span>
                      <p>{detail.invoice.notes}</p>
                    </div>
                  ) : null}

                  <div className={styles.desktopPanel}>
                    <div className={styles.sectionTitle}>Detalle</div>
                    <div className={styles.documentTableWrap}>
                      <table className={styles.table}>
                        <thead>
                          <tr>
                            <th>Cant.</th>
                            <th>Producto</th>
                            <th>Unitario</th>
                            <th>Total</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detail.items.map((item) => (
                            <tr key={item.id}>
                              <td>{item.quantity}</td>
                              <td>{item.product_name}</td>
                              <td>{money(item.unit_price)}</td>
                              <td className={styles.total}>{money(item.line_total)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div className={styles.documentFooter}>
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

                    <div className={styles.totalBox}>
                      <span className={styles.totalLabel}>Total a pagar</span>
                      <strong className={styles.totalValue}>{money(detail.summary.subtotal)}</strong>
                      <div className={styles.metaRow}>
                        <span>Cobrado</span>
                        <strong>{money(detail.summary.payments_total)}</strong>
                      </div>
                      <div className={styles.metaRow}>
                        <span>Saldo</span>
                        <strong>{money(detail.summary.balance_due)}</strong>
                      </div>
                    </div>
                  </div>

                  <div className={styles.signatureRow}>
                    <div className={styles.signatureBox}>
                      <span>Firma / aclaracion</span>
                    </div>
                    <div className={styles.signatureBox}>
                      <span>Recepcion conforme</span>
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
          </aside>
        </div>
      ) : null}
    </div>
  );
}
