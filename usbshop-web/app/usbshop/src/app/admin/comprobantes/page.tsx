'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { getApiBaseUrl, loadRuntimeConfig } from '@/lib/api';
import { formatArgentinaDateTime } from '@/lib/datetime';
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
  special_discount?: number | null;
  web_order_id?: number | null;
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
    special_discount?: number | null;
    web_order_id?: number | null;
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
    special_discount?: number;
    total?: number;
    payments_total: number;
    balance_due: number;
  };
};

const money = (value: number) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(value || 0);

const formatDate = (value?: string | null) => {
  return formatArgentinaDateTime(value);
};

const getPriceListLabel = (value?: number | null) => {
  if (value === 1) return 'Lista 1';
  if (value === 2) return 'Lista 2';
  return 'Lista especial';
};

export default function ComprobantesPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
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
  const [pendingDeleteInvoice, setPendingDeleteInvoice] = useState<Invoice | null>(null);
  const [pendingConfirmInvoice, setPendingConfirmInvoice] = useState<Invoice | null>(null);
  const detailRequestRef = useRef(0);

  const syncInvoiceRow = (invoice: InvoiceDetail['invoice']) => {
    setItems((current) =>
      current.map((item) =>
        item.id === invoice.id
          ? {
              ...item,
              customer_id: invoice.customer_id,
              customer_name: invoice.customer_name,
              seller_id: invoice.seller_id,
              seller_name: invoice.seller_name,
              total: invoice.total,
              created_at: invoice.created_at,
              document_type: invoice.document_type,
              sale_mode: invoice.sale_mode,
              price_list: invoice.price_list,
              due_date: invoice.due_date,
              notes: invoice.notes,
              payment_method: invoice.payment_method,
              commission_amount: invoice.commission_amount,
              special_discount: invoice.special_discount,
              web_order_id: invoice.web_order_id,
            }
          : item
      )
    );
  };

  async function loadDetail(invoiceId: number) {
    const requestId = detailRequestRef.current + 1;
    detailRequestRef.current = requestId;
    try {
      setDetailLoading(true);
      setDetailError('');
      setDetail(null);
      await loadRuntimeConfig();
      const res = await fetch(`${getApiBaseUrl()}/admin/invoices/${invoiceId}`, { credentials: 'include' });
      if (!res.ok) throw new Error('No se pudo cargar el detalle del comprobante');
      const payload = await res.json();
      if (detailRequestRef.current !== requestId) return null;
      setDetail(payload);
      syncInvoiceRow((payload as InvoiceDetail).invoice);
      return payload as InvoiceDetail;
    } catch (err) {
      if (detailRequestRef.current !== requestId) return null;
      setDetailError(err instanceof Error ? err.message : 'Error cargando detalle');
      setDetail(null);
      return null;
    } finally {
      if (detailRequestRef.current === requestId) {
        setDetailLoading(false);
      }
    }
  }

  async function openInvoice(invoiceId: number) {
    setSelectedId(invoiceId);
    setDetail(null);
    setDetailError('');
    setDetailOnly(true);
    await loadDetail(invoiceId);
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

  useEffect(() => {
    const rawInvoiceId = searchParams.get('invoice');
    if (!rawInvoiceId) return;
    const invoiceId = Number(rawInvoiceId);
    if (!Number.isInteger(invoiceId) || invoiceId <= 0) return;
    void openInvoice(invoiceId);
  }, [searchParams]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((item) =>
      [item.customer_name, item.document_type || '', item.notes || '', String(item.id)].join(' ').toLowerCase().includes(needle)
    );
  }, [items, search]);

  const requestDeleteInvoice = (invoice: Invoice) => {
    setPendingDeleteInvoice(invoice);
  };

  const requestConfirmInvoice = (invoice: Invoice) => {
    setPendingConfirmInvoice(invoice);
  };

  const openBudgetForInvoice = (invoice: Invoice) => {
    setPendingConfirmInvoice(null);
    router.push(`/admin/generar-comprobante?budget_invoice_id=${invoice.id}`);
  };

  const deleteInvoice = async (invoice: Invoice) => {
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
      setPendingDeleteInvoice(null);
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
                <th>Origen</th>
                <th>Acciones</th>
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
                    <td>
                      {item.web_order_id ? (
                        <span className={styles.originBadge}>Pedido web #{item.web_order_id}</span>
                      ) : (
                        <span className={styles.originMuted}>Manual</span>
                      )}
                    </td>
                    <td className={styles.rowActions}>
                      <div className={styles.rowActionsGroup}>
                        <button
                          type="button"
                          className={styles.secondaryButton}
                          onClick={(event) => {
                            event.stopPropagation();
                            void openInvoice(item.id);
                          }}
                        >
                          Ver comprobante
                        </button>
                        {item.document_type === 'PRESUPUESTO' ? (
                          <button
                            type="button"
                            className={styles.confirmButton}
                            onClick={(event) => {
                              event.stopPropagation();
                              requestConfirmInvoice(item);
                            }}
                          >
                            Revisar y facturar
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className={styles.pdfButton}
                          onClick={(event) => {
                            event.stopPropagation();
                            void openInvoice(item.id);
                          }}
                        >
                          Vista previa PDF
                        </button>
                        <button
                          type="button"
                          className={styles.printButton}
                          onClick={(event) => {
                            event.stopPropagation();
                            void openInvoice(item.id);
                          }}
                        >
                          Vista previa impresion
                        </button>
                        <button
                          type="button"
                          className={styles.deleteButton}
                          disabled={deletingId === item.id}
                          onClick={(event) => {
                            event.stopPropagation();
                            requestDeleteInvoice(item);
                          }}
                        >
                          {deletingId === item.id ? 'Eliminando...' : 'Eliminar'}
                        </button>
                      </div>
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
                <div className={styles.detailInlineActions}>
                  {detail.invoice.document_type === 'PRESUPUESTO' ? (
                    <button
                      type="button"
                      className={styles.confirmButton}
                      onClick={() =>
                        requestConfirmInvoice({
                          id: detail.invoice.id,
                          customer_id: detail.invoice.customer_id,
                          customer_name: detail.invoice.customer_name,
                          seller_id: detail.invoice.seller_id,
                          seller_name: detail.invoice.seller_name,
                          total: detail.invoice.total,
                          created_at: detail.invoice.created_at,
                          document_type: detail.invoice.document_type,
                          sale_mode: detail.invoice.sale_mode,
                          price_list: detail.invoice.price_list,
                          due_date: detail.invoice.due_date,
                          notes: detail.invoice.notes,
                          payment_method: detail.invoice.payment_method,
                          commission_amount: detail.invoice.commission_amount,
                          special_discount: detail.invoice.special_discount,
                          web_order_id: detail.invoice.web_order_id,
                        })
                      }
                    >
                      Revisar y facturar
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={styles.deleteButton}
                    disabled={deletingId === detail.invoice.id}
                    onClick={() =>
                      requestDeleteInvoice({
                        id: detail.invoice.id,
                        customer_id: detail.invoice.customer_id,
                        customer_name: detail.invoice.customer_name,
                        seller_id: detail.invoice.seller_id,
                        seller_name: detail.invoice.seller_name,
                        total: detail.invoice.total,
                        created_at: detail.invoice.created_at,
                        document_type: detail.invoice.document_type,
                        sale_mode: detail.invoice.sale_mode,
                        price_list: detail.invoice.price_list,
                        due_date: detail.invoice.due_date,
                        notes: detail.invoice.notes,
                        payment_method: detail.invoice.payment_method,
                        commission_amount: detail.invoice.commission_amount,
                        special_discount: detail.invoice.special_discount,
                        web_order_id: detail.invoice.web_order_id,
                      })
                    }
                  >
                    {deletingId === detail.invoice.id ? 'Eliminando...' : 'Eliminar comprobante'}
                  </button>
                </div>
                <div className={styles.documentShell}>
                  <div className={styles.desktopAccentBar} />

                  <div className={styles.printBanner}>
                    <div className={styles.brandLockup}>
                      <div className={styles.logoBox}>
                        <img src="/logo-small.jpeg" alt="USB Shop" className={styles.logoImage} />
                      </div>
                      <div className={styles.brandHead}>
                        <div className={styles.brandName}>USB Shop</div>
                        <div className={styles.brandMeta}>Venta mayorista</div>
                      </div>
                    </div>
                    <div className={styles.docCenter}>
                      <div className={styles.docKindBadge}>
                        {detail.invoice.document_type || 'Comprobante'}
                      </div>
                    </div>
                  </div>

                  <div className={styles.desktopPanel}>
                    <div className={styles.headerSplitPanel}>
                      <div className={styles.headerSplitColumn}>
                        <div className={styles.sectionTitle}>Datos del cliente</div>
                        <div className={styles.customerBlock}>
                          <strong>{detail.invoice.customer_name}</strong>
                          <span>{detail.invoice.address || detail.invoice.locality || 'Sin domicilio registrado'}</span>
                          <span>{detail.invoice.customer_phone || detail.invoice.customer_email || 'Sin contacto registrado'}</span>
                          <span>{detail.invoice.cuit ? `CUIT / DNI: ${detail.invoice.cuit}` : 'CUIT / DNI: -'}</span>
                          <span>{detail.invoice.tax_condition ? `Condicion fiscal: ${detail.invoice.tax_condition}` : 'Condicion fiscal: -'}</span>
                        </div>
                      </div>
                      <div className={styles.headerSplitColumn}>
                        <div className={styles.sectionTitle}>Resumen</div>
                        <div className={styles.summaryRows}>
                          <div className={styles.metaRow}><span>Numero</span><strong>#{detail.invoice.id}</strong></div>
                          <div className={styles.metaRow}><span>Fecha de emision</span><strong>{formatDate(detail.invoice.created_at)}</strong></div>
                          <div className={styles.metaRow}><span>Vendedor</span><strong>{detail.invoice.seller_name || '-'}</strong></div>
                          <div className={styles.metaRow}><span>Modo de venta</span><strong>{detail.invoice.sale_mode || '-'}</strong></div>
                          <div className={styles.metaRow}><span>Lista de precios</span><strong>{getPriceListLabel(detail.invoice.price_list)}</strong></div>
                          {Number(detail.invoice.special_discount || 0) > 0 ? (
                            <div className={styles.metaRow}><span>Descuento especial</span><strong>-{money(Number(detail.invoice.special_discount || 0))}</strong></div>
                          ) : null}
                        </div>
                      </div>
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
                      <strong className={styles.totalValue}>{money(Number(detail.summary.total ?? detail.summary.subtotal))}</strong>
                      {Number(detail.summary.special_discount || 0) > 0 ? (
                        <>
                          <div className={styles.metaRow}>
                            <span>Subtotal</span>
                            <strong>{money(detail.summary.subtotal)}</strong>
                          </div>
                          <div className={styles.metaRow}>
                            <span>Descuento especial</span>
                            <strong>-{money(Number(detail.summary.special_discount || 0))}</strong>
                          </div>
                        </>
                      ) : null}
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

      {pendingDeleteInvoice ? (
        <div className={styles.confirmOverlay} onClick={() => (deletingId ? null : setPendingDeleteInvoice(null))}>
          <aside
            className={styles.confirmModal}
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-invoice-title"
          >
            <div className={styles.confirmHeader}>
              <div>
                <h2 id="delete-invoice-title">Eliminar comprobante emitido</h2>
                <p>Esta acción va a borrar el comprobante, revertir stock y quitar los movimientos de cuenta corriente asociados.</p>
              </div>
            </div>

            <div className={styles.confirmBody}>
              <div className={styles.confirmCard}>
                <span>Comprobante</span>
                <strong>#{pendingDeleteInvoice.id} {pendingDeleteInvoice.document_type || 'Comprobante'}</strong>
              </div>
              <div className={styles.confirmCard}>
                <span>Cliente</span>
                <strong>{pendingDeleteInvoice.customer_name}</strong>
              </div>
              <div className={styles.confirmCard}>
                <span>Total</span>
                <strong>{money(pendingDeleteInvoice.total)}</strong>
              </div>
              <div className={styles.confirmWarning}>
                Si el comprobante ya tiene pagos o créditos aplicados, el sistema no lo va a dejar eliminar.
              </div>
            </div>

            <div className={styles.confirmActions}>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => setPendingDeleteInvoice(null)}
                disabled={deletingId === pendingDeleteInvoice.id}
              >
                Cancelar
              </button>
              <button
                type="button"
                className={styles.deleteButton}
                onClick={() => void deleteInvoice(pendingDeleteInvoice)}
                disabled={deletingId === pendingDeleteInvoice.id}
              >
                {deletingId === pendingDeleteInvoice.id ? 'Eliminando...' : 'Confirmar eliminación'}
              </button>
            </div>
          </aside>
        </div>
      ) : null}

      {pendingConfirmInvoice ? (
        <div className={styles.confirmOverlay} onClick={() => setPendingConfirmInvoice(null)}>
          <aside
            className={styles.confirmModal}
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-invoice-title"
          >
            <div className={styles.confirmHeader}>
              <div>
                <h2 id="confirm-invoice-title">Revisar presupuesto</h2>
                <p>Esta acción convierte el presupuesto en factura y genera los movimientos operativos correspondientes.</p>
              </div>
            </div>

            <div className={styles.confirmBody}>
              <div className={styles.confirmCard}>
                <span>Comprobante</span>
                <strong>#{pendingConfirmInvoice.id} {pendingConfirmInvoice.document_type || 'Comprobante'}</strong>
              </div>
              <div className={styles.confirmCard}>
                <span>Cliente</span>
                <strong>{pendingConfirmInvoice.customer_name}</strong>
              </div>
              <div className={styles.confirmCard}>
                <span>Total</span>
                <strong>{money(pendingConfirmInvoice.total)}</strong>
              </div>
              <div className={styles.confirmWarning}>
                Al confirmar se descuenta stock y, si la venta es por cuenta corriente, se genera el débito del cliente.
              </div>
            </div>

            <div className={styles.confirmActions}>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => setPendingConfirmInvoice(null)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className={styles.confirmButton}
                onClick={() => openBudgetForInvoice(pendingConfirmInvoice)}
              >
                Abrir para revisar
              </button>
            </div>
          </aside>
        </div>
      ) : null}
    </div>
  );
}
