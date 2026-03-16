'use client';

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
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
  price_list?: number | null;
  due_date?: string | null;
  notes?: string | null;
  payment_method?: string | null;
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

type CustomerOption = {
  id: number;
  name: string;
  email?: string | null;
  phone?: string | null;
  sale_mode?: string | null;
  cuit?: string | null;
};

type ProductOption = {
  id: number;
  name: string;
  sku: string;
  price: number;
  price_list_1?: number | null;
  price_list_2?: number | null;
  stock: number;
};

type OrderDraft = {
  id: number;
  customer_name: string;
  customer_phone?: string | null;
  customer_email?: string | null;
  notes?: string | null;
  total: number;
  status: string;
  created_at: string;
  confirmed_invoice_id?: string | null;
  items: Array<{
    product_id: number;
    sku?: string | null;
    name?: string | null;
    quantity: number;
    unit_price: number;
  }>;
};

type InvoiceFormItem = {
  product_id: string;
  quantity: string;
  unit_price: string;
};

const money = (value: number) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(value || 0);

const formatDate = (value?: string | null) => {
  if (!value) return '-';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString('es-AR');
};

const emptyItem = (): InvoiceFormItem => ({
  product_id: '',
  quantity: '1',
  unit_price: '0',
});

const nowInputValue = () => new Date().toISOString().slice(0, 16);

const formatInputDateTime = (value?: string | null) => {
  if (!value) return null;
  const normalized = value.length === 16 ? `${value}:00` : value;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

const getPriceListLabel = (value?: number | null) => {
  if (value === 1) return 'Lista 1';
  if (value === 2) return 'Lista 2';
  return 'Lista base';
};

export default function ComprobantesPage() {
  const searchParams = useSearchParams();
  const orderIdParam = Number(searchParams?.get('order_id') || 0);
  const [items, setItems] = useState<Invoice[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<InvoiceDetail | null>(null);
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState('');
  const [detailError, setDetailError] = useState('');
  const [detailOnly, setDetailOnly] = useState(false);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [form, setForm] = useState({
    order_id: '',
    customer_id: '',
    document_type: 'FACTURA',
    sale_mode: 'CONTADO',
    price_list: '0',
    payment_method: 'EFECTIVO',
    created_at: nowInputValue(),
    due_date: '',
    notes: '',
    items: [emptyItem()],
  });

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

  async function loadOptions() {
    await loadRuntimeConfig();
    const [customersRes, productsRes] = await Promise.all([
      fetch(`${getApiBaseUrl()}/admin/backoffice-customers?limit=300`, { credentials: 'include' }),
      fetch(`${getApiBaseUrl()}/admin/products?limit=1000`, { credentials: 'include' }),
    ]);
    if (!customersRes.ok) throw new Error('No se pudieron cargar los clientes');
    if (!productsRes.ok) throw new Error('No se pudieron cargar los productos');
    setCustomers(await customersRes.json());
    setProducts(await productsRes.json());
  }

  async function loadOrderDraft(orderId: number) {
    await loadRuntimeConfig();
    const res = await fetch(`${getApiBaseUrl()}/admin/orders/${orderId}`, { credentials: 'include' });
    if (!res.ok) throw new Error('No se pudo cargar el pedido');
    return (await res.json()) as OrderDraft;
  }

  useEffect(() => {
    const load = async () => {
      try {
        setLoading(true);
        await loadInvoices();
        try {
          await loadOptions();
        } catch (optionsError) {
          console.error('No se pudieron cargar las opciones de comprobantes:', optionsError);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error cargando comprobantes');
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, []);

  useEffect(() => {
    if (!orderIdParam || customers.length === 0 || products.length === 0) return;
    const prefill = async () => {
      try {
        const draft = await loadOrderDraft(orderIdParam);
        const matchedCustomer =
          customers.find((customer) => {
            return (
              (draft.customer_email && customer.email && draft.customer_email.toLowerCase() === String(customer.email).toLowerCase()) ||
              (draft.customer_phone && customer.phone && draft.customer_phone === customer.phone) ||
              draft.customer_name === customer.name
            );
          }) || null;
        setForm({
          order_id: String(draft.id),
          customer_id: matchedCustomer ? String(matchedCustomer.id) : '',
          document_type: 'FACTURA',
          sale_mode: matchedCustomer?.sale_mode || 'CONTADO',
          price_list: '0',
          payment_method: 'EFECTIVO',
          created_at: nowInputValue(),
          due_date: '',
          notes: draft.notes || '',
          items: draft.items.length
            ? draft.items.map((item) => ({
                product_id: String(item.product_id),
                quantity: String(item.quantity),
                unit_price: String(item.unit_price),
              }))
            : [emptyItem()],
        });
        setShowCreateForm(true);
      } catch (err) {
        setCreateError(err instanceof Error ? err.message : 'Error cargando el pedido');
      }
    };
    void prefill();
  }, [orderIdParam, customers, products]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((item) =>
      [item.customer_name, item.document_type || '', item.notes || '', String(item.id)].join(' ').toLowerCase().includes(needle)
    );
  }, [items, search]);

  const customerMap = useMemo(
    () => new Map(customers.map((customer) => [customer.id, customer])),
    [customers]
  );

  const productMap = useMemo(
    () => new Map(products.map((product) => [product.id, product])),
    [products]
  );

  const formTotal = useMemo(
    () =>
      form.items.reduce((acc, item) => {
        const quantity = Number(item.quantity || 0);
        const unitPrice = Number(item.unit_price || 0);
        return acc + quantity * unitPrice;
      }, 0),
    [form.items]
  );

  const getProductPriceByList = (product: ProductOption, priceList: string) => {
    if (priceList === '1') {
      return Number(product.price_list_1 || product.price || 0);
    }
    if (priceList === '2') {
      return Number(product.price_list_2 || product.price || 0);
    }
    return Number(product.price || 0);
  };

  const updateItem = (index: number, field: keyof InvoiceFormItem, value: string) => {
    setForm((current) => {
      const nextItems = current.items.map((item, itemIndex) => {
        if (itemIndex !== index) return item;
        const nextItem = { ...item, [field]: value };
        if (field === 'product_id') {
          const selected = productMap.get(Number(value));
          if (selected) {
            nextItem.unit_price = String(getProductPriceByList(selected, current.price_list));
          }
        }
        return nextItem;
      });
      return { ...current, items: nextItems };
    });
  };

  const recalculateItemsForPriceList = (nextPriceList: string) => {
    setForm((current) => ({
      ...current,
      price_list: nextPriceList,
      items: current.items.map((item) => {
        const selected = productMap.get(Number(item.product_id));
        if (!selected) return item;
        return { ...item, unit_price: String(getProductPriceByList(selected, nextPriceList)) };
      }),
    }));
  };

  const addItem = () => setForm((current) => ({ ...current, items: [...current.items, emptyItem()] }));

  const removeItem = (index: number) =>
    setForm((current) => ({
      ...current,
      items: current.items.filter((_, itemIndex) => itemIndex !== index),
    }));

  const resetForm = () => {
    setForm({
      order_id: '',
      customer_id: '',
      document_type: 'FACTURA',
      sale_mode: 'CONTADO',
      price_list: '0',
      payment_method: 'EFECTIVO',
      created_at: nowInputValue(),
      due_date: '',
      notes: '',
      items: [emptyItem()],
    });
    setCreateError('');
  };

  const submitInvoice = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      setCreating(true);
      setCreateError('');
      await loadRuntimeConfig();
      const payload = {
        order_id: form.order_id ? Number(form.order_id) : null,
        customer_id: Number(form.customer_id),
        document_type: form.document_type,
        sale_mode: form.sale_mode,
        price_list: Number(form.price_list || 0),
        payment_method: form.payment_method || null,
        created_at: formatInputDateTime(form.created_at),
        due_date: form.due_date || null,
        notes: form.notes || null,
        items: form.items.map((item) => ({
          product_id: Number(item.product_id),
          quantity: Number(item.quantity),
          unit_price: Number(item.unit_price),
        })),
      };
      const res = await fetch(`${getApiBaseUrl()}/admin/invoices`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || 'No se pudo crear el comprobante');
      await Promise.all([loadInvoices(), loadOptions()]);
      setSelectedId(data.id);
      setShowCreateForm(false);
      resetForm();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Error creando comprobante');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className={styles.page}>
      <section className={styles.header}>
        <div>
          <h1>Comprobantes emitidos</h1>
          <p>Historial de facturas, remitos y ventas reales tomadas desde la base actual.</p>
        </div>
        <div className={styles.headerActions}>
          <button type="button" className={styles.createButton} onClick={() => setShowCreateForm((current) => !current)}>
            {showCreateForm ? 'Cerrar formulario' : 'Nuevo comprobante'}
          </button>
          <input
            className={styles.search}
            placeholder="Buscar por cliente, tipo o numero..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </section>

      {error ? <div className={styles.error}>{error}</div> : null}

      {showCreateForm ? (
        <section className={styles.createPanel}>
          <div className={styles.createHeader}>
            <div>
              <h2>Emitir comprobante real</h2>
              <p>Genera venta, descuenta stock y, si corresponde, impacta en cuenta corriente.</p>
              <p className={styles.modelNote}>
                Modelo activo en web: tipo, fecha/hora, lista de precios, forma de pago, vencimiento y notas.
                Vendedor/comision se habilita cuando exista esa entidad en la base.
              </p>
              {form.order_id ? (
                <p className={styles.orderDraftInfo}>
                  Pedido web #{form.order_id} cargado como borrador editable.
                </p>
              ) : null}
            </div>
            <div className={styles.createTotal}>{money(formTotal)}</div>
          </div>

          {createError ? <div className={styles.error}>{createError}</div> : null}

          <form onSubmit={submitInvoice} className={styles.createForm}>
            <div className={styles.formGrid}>
              <label>
                Cliente
                <select
                  value={form.customer_id}
                  onChange={(e) => {
                    const customer = customerMap.get(Number(e.target.value));
                    setForm((current) => ({
                      ...current,
                      customer_id: e.target.value,
                      sale_mode: customer?.sale_mode || current.sale_mode,
                    }));
                  }}
                  required
                >
                  <option value="">Seleccionar cliente</option>
                  {customers.map((customer) => (
                    <option key={customer.id} value={customer.id}>
                      {customer.name} {customer.cuit ? `- ${customer.cuit}` : ''}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Tipo
                <select
                  value={form.document_type}
                  onChange={(e) => setForm((current) => ({ ...current, document_type: e.target.value }))}
                >
                  <option value="FACTURA">Factura</option>
                  <option value="REMITO">Remito</option>
                  <option value="NOTA_DEBITO">Nota de debito</option>
                </select>
              </label>

              <label>
                Fecha y hora
                <input
                  type="datetime-local"
                  value={form.created_at}
                  onChange={(e) => setForm((current) => ({ ...current, created_at: e.target.value }))}
                />
              </label>

              <label>
                Modalidad
                <select
                  value={form.sale_mode}
                  onChange={(e) => setForm((current) => ({ ...current, sale_mode: e.target.value }))}
                >
                  <option value="CONTADO">Contado</option>
                  <option value="CUENTA_CORRIENTE">Cuenta corriente</option>
                </select>
              </label>

              <label>
                Lista de precios
                <select
                  value={form.price_list}
                  onChange={(e) => recalculateItemsForPriceList(e.target.value)}
                >
                  <option value="0">Lista base</option>
                  <option value="1">Lista 1</option>
                  <option value="2">Lista 2</option>
                </select>
              </label>

              <label>
                Forma de pago
                <select
                  value={form.payment_method}
                  onChange={(e) => setForm((current) => ({ ...current, payment_method: e.target.value }))}
                >
                  <option value="EFECTIVO">Efectivo</option>
                  <option value="TRANSFERENCIA">Transferencia</option>
                  <option value="TARJETA">Tarjeta</option>
                  <option value="CHEQUE">Cheque</option>
                  <option value="CUENTA_CORRIENTE">Cuenta corriente</option>
                  <option value="MIXTO">Mixto</option>
                </select>
              </label>

              <label>
                Vencimiento
                <input
                  type="date"
                  value={form.due_date}
                  onChange={(e) => setForm((current) => ({ ...current, due_date: e.target.value }))}
                />
              </label>

              <label className={styles.fullWidth}>
                Notas
                <textarea
                  rows={2}
                  value={form.notes}
                  onChange={(e) => setForm((current) => ({ ...current, notes: e.target.value }))}
                />
              </label>
            </div>

            <div className={styles.itemList}>
              {form.items.map((item, index) => {
                const selectedProduct = productMap.get(Number(item.product_id));
                return (
                  <div key={index} className={styles.itemRow}>
                    <select
                      value={item.product_id}
                      onChange={(e) => updateItem(index, 'product_id', e.target.value)}
                      required
                    >
                      <option value="">Producto</option>
                      {products.map((product) => (
                        <option key={product.id} value={product.id}>
                          {product.name} - {product.sku} - stock {product.stock}
                        </option>
                      ))}
                    </select>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={item.quantity}
                      onChange={(e) => updateItem(index, 'quantity', e.target.value)}
                      required
                    />
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={item.unit_price}
                      onChange={(e) => updateItem(index, 'unit_price', e.target.value)}
                      required
                    />
                    <div className={styles.itemMeta}>
                      {selectedProduct ? `Stock actual ${selectedProduct.stock}` : 'Sin producto'}
                    </div>
                    <button
                      type="button"
                      className={styles.removeButton}
                      onClick={() => removeItem(index)}
                      disabled={form.items.length === 1}
                    >
                      Quitar
                    </button>
                  </div>
                );
              })}
            </div>

            <div className={styles.formActions}>
              <button type="button" className={styles.secondaryButton} onClick={addItem}>
                Agregar item
              </button>
              <button type="button" className={styles.secondaryButton} onClick={resetForm}>
                Limpiar
              </button>
              <button type="submit" className={styles.createButton} disabled={creating}>
                {creating ? 'Guardando...' : 'Emitir comprobante'}
              </button>
            </div>
          </form>
        </section>
      ) : null}

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
