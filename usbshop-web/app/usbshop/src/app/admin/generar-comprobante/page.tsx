'use client';

import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { getApiBaseUrl, loadRuntimeConfig } from '@/lib/api';
import styles from '../comprobantes/comprobantes.module.css';

type CustomerOption = { id: number; name: string; email?: string | null; phone?: string | null; sale_mode?: string | null; cuit?: string | null };
type ProductOption = { id: number; name: string; sku: string; price: number; price_list_1?: number | null; price_list_2?: number | null; stock: number };
type SellerOption = { id: number; name: string; commission_percent: number; is_active: boolean };
type OrderDraft = {
  id: number;
  customer_name: string;
  customer_phone?: string | null;
  customer_email?: string | null;
  notes?: string | null;
  items: Array<{ product_id: number; sku?: string | null; name?: string | null; quantity: number; unit_price: number }>;
};
type InvoiceFormItem = { product_id: string; quantity: string; unit_price: string; manual_price: boolean };

const money = (value: number) => new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(value || 0);
const normalizeSearchValue = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
const nowInputValue = () => new Date().toISOString().slice(0, 16);
const formatInputDateTime = (value?: string | null) => {
  if (!value) return null;
  const normalized = value.length === 16 ? `${value}:00` : value;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

export default function GenerarComprobantePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const orderIdParam = Number(searchParams?.get('order_id') || 0);
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [sellers, setSellers] = useState<SellerOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [customerSearch, setCustomerSearch] = useState('');
  const [productSearch, setProductSearch] = useState('');
  const [searchQuantities, setSearchQuantities] = useState<Record<number, string>>({});
  const [form, setForm] = useState({
    order_id: '',
    customer_id: '',
    document_type: 'FACTURA',
    sale_mode: 'CONTADO',
    seller_id: '',
    price_list: '0',
    payment_method: 'EFECTIVO',
    created_at: nowInputValue(),
    due_date: '',
    notes: '',
    items: [] as InvoiceFormItem[],
  });

  useEffect(() => {
    const load = async () => {
      try {
        setLoading(true);
        await loadRuntimeConfig();
        const [customersRes, productsRes, sellersRes] = await Promise.all([
          fetch(`${getApiBaseUrl()}/admin/backoffice-customers?limit=1000`, { credentials: 'include' }),
          fetch(`${getApiBaseUrl()}/admin/products?limit=1000`, { credentials: 'include' }),
          fetch(`${getApiBaseUrl()}/admin/sellers?limit=200`, { credentials: 'include' }),
        ]);
        if (!customersRes.ok || !productsRes.ok || !sellersRes.ok) throw new Error('No se pudieron cargar las opciones');
        setCustomers(await customersRes.json());
        setProducts(await productsRes.json());
        setSellers((await sellersRes.json()).filter((seller: SellerOption) => seller.is_active));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error cargando formulario');
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
        await loadRuntimeConfig();
        const res = await fetch(`${getApiBaseUrl()}/admin/orders/${orderIdParam}`, { credentials: 'include' });
        if (!res.ok) throw new Error('No se pudo cargar el pedido');
        const draft = (await res.json()) as OrderDraft;
        const normalizedDraftName = normalizeSearchValue(draft.customer_name || '');
        const normalizedDraftEmail = normalizeSearchValue(draft.customer_email || '');
        const normalizedDraftPhone = String(draft.customer_phone || '').trim();
        const matchedCustomer =
          customers.find((customer) =>
            (normalizedDraftEmail && normalizeSearchValue(String(customer.email || '')) === normalizedDraftEmail) ||
            (normalizedDraftPhone && String(customer.phone || '').trim() === normalizedDraftPhone) ||
            (normalizedDraftName && normalizeSearchValue(customer.name) === normalizedDraftName)
          ) || null;
        setForm({
          order_id: String(draft.id),
          customer_id: matchedCustomer ? String(matchedCustomer.id) : '',
          document_type: 'FACTURA',
          sale_mode: matchedCustomer?.sale_mode || 'CONTADO',
          seller_id: '',
          price_list: '0',
          payment_method: 'EFECTIVO',
          created_at: nowInputValue(),
          due_date: '',
          notes: draft.notes || '',
          items: draft.items.length
            ? draft.items.map((item) => ({ product_id: String(item.product_id), quantity: String(item.quantity), unit_price: String(item.unit_price), manual_price: true }))
            : [],
        });
        setCustomerSearch(matchedCustomer?.name || draft.customer_name || '');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error cargando el pedido');
      }
    };
    void prefill();
  }, [orderIdParam, customers, products]);

  const customerMap = useMemo(() => new Map(customers.map((customer) => [customer.id, customer])), [customers]);
  const productMap = useMemo(() => new Map(products.map((product) => [product.id, product])), [products]);
  const sellerMap = useMemo(() => new Map(sellers.map((seller) => [seller.id, seller])), [sellers]);
  const selectedCustomer = useMemo(() => customerMap.get(Number(form.customer_id)), [customerMap, form.customer_id]);
  const normalizedCustomerSearch = normalizeSearchValue(customerSearch);
  const filteredCustomerOptions = useMemo(() => {
    const needle = normalizedCustomerSearch;
    if (!needle) return customers;
    return customers.filter((customer) =>
      normalizeSearchValue([customer.name, customer.email || '', customer.phone || '', customer.cuit || ''].join(' ')).includes(needle)
    ).slice(0, 10);
  }, [normalizedCustomerSearch, customers]);
  const showCustomerResults = normalizedCustomerSearch.length > 0;
  const filteredProducts = useMemo(() => {
    const needle = productSearch.trim().toLowerCase();
    if (!needle) return [];
    return products
      .filter((product) => [product.name, product.sku, String(product.id)].join(' ').toLowerCase().includes(needle))
      .slice(0, 12);
  }, [productSearch, products]);
  const selectedSeller = sellerMap.get(Number(form.seller_id));
  const formTotal = useMemo(() => form.items.reduce((acc, item) => acc + Number(item.quantity || 0) * Number(item.unit_price || 0), 0), [form.items]);
  const commissionPreview = useMemo(() => (selectedSeller ? (formTotal * Number(selectedSeller.commission_percent || 0)) / 100 : 0), [formTotal, selectedSeller]);
  const documentBehavior = useMemo(() => {
    if (form.document_type === 'NOTA_CREDITO') {
      return 'La nota de crédito repone stock y, si la operación es por cuenta corriente, genera crédito a favor del cliente.';
    }
    if (form.document_type === 'PRESUPUESTO') {
      return 'El presupuesto solo guarda el documento. No mueve stock ni cuenta corriente.';
    }
    return 'La factura descuenta stock y, si la operación es por cuenta corriente, genera deuda del cliente.';
  }, [form.document_type]);

  const getProductPriceByList = (product: ProductOption, priceList: string) => {
    if (priceList === '1') return Number(product.price_list_1 || product.price || 0);
    if (priceList === '2') return Number(product.price_list_2 || product.price || 0);
    return Number(product.price || 0);
  };

  const addProductToInvoice = (product: ProductOption, quantityOverride?: number) => {
    const inlineQuantity = searchQuantities[product.id];
    const normalizedQuantity = Math.max(1, Number(quantityOverride || inlineQuantity || 1));
    setForm((current) => {
      const existingIndex = current.items.findIndex((item) => Number(item.product_id) === product.id);
      if (existingIndex >= 0) {
        return {
          ...current,
          items: current.items.map((item, index) =>
            index === existingIndex
              ? { ...item, quantity: String(Number(item.quantity || 0) + normalizedQuantity) }
              : item
          ),
        };
      }
      return {
        ...current,
        items: [
          ...current.items,
          {
            product_id: String(product.id),
            quantity: String(normalizedQuantity),
            unit_price: String(getProductPriceByList(product, current.price_list)),
            manual_price: false,
          },
        ],
      };
    });
    setSearchQuantities((current) => ({ ...current, [product.id]: '1' }));
  };

  const updateItem = (index: number, field: keyof InvoiceFormItem, value: string | boolean) => {
    setForm((current) => ({
      ...current,
      items: current.items.map((item, itemIndex) => {
        if (itemIndex !== index) return item;
        const nextItem = { ...item, [field]: value };
        if (field === 'unit_price') {
          nextItem.manual_price = true;
        }
        return nextItem;
      }),
    }));
  };

  const handleProductSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (filteredProducts.length > 0) addProductToInvoice(filteredProducts[0]);
  };

  const updateSearchQuantity = (productId: number, value: string) => {
    setSearchQuantities((current) => ({ ...current, [productId]: value }));
  };

  const selectCustomer = (customer: CustomerOption) => {
    setCustomerSearch(customer.name);
    setForm((current) => ({
      ...current,
      customer_id: String(customer.id),
      sale_mode: customer.sale_mode || current.sale_mode,
    }));
  };

  const submitInvoice = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      setCreating(true);
      setError('');
      await loadRuntimeConfig();
      const payload = {
        order_id: form.order_id ? Number(form.order_id) : null,
        customer_id: Number(form.customer_id),
        document_type: form.document_type,
        sale_mode: form.sale_mode,
        seller_id: form.seller_id ? Number(form.seller_id) : null,
        price_list: Number(form.price_list || 0),
        payment_method: form.payment_method || null,
        created_at: formatInputDateTime(form.created_at),
        due_date: form.due_date || null,
        notes: form.notes || null,
        items: form.items.map((item) => ({ product_id: Number(item.product_id), quantity: Number(item.quantity), unit_price: Number(item.unit_price) })),
      };
      const res = await fetch(`${getApiBaseUrl()}/admin/invoices`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || 'No se pudo crear el comprobante');
      router.push(`/admin/comprobantes?created=${data.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error creando comprobante');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className={styles.page}>
      <section className={styles.header}>
        <div>
          <h1>Generar comprobante</h1>
          <p>Alta operativa de facturas, notas de crédito y presupuestos desde la base actual.</p>
        </div>
      </section>
      {loading ? <div className={styles.empty}>Cargando formulario...</div> : null}
      {error ? <div className={styles.error}>{error}</div> : null}
      {!loading ? (
        <section className={styles.createPanel}>
          <div className={styles.createHeader}>
            <div>
              <h2>Emitir comprobante real</h2>
              <p>{documentBehavior}</p>
              <p className={styles.modelNote}>Modelo activo en web: tipo, fecha/hora, lista de precios, forma de pago, vencimiento, vendedor y comisión.</p>
              {form.order_id ? <p className={styles.orderDraftInfo}>Pedido web #{form.order_id} cargado como borrador editable.</p> : null}
            </div>
          </div>
          <form onSubmit={submitInvoice} className={styles.createForm}>
            <div className={styles.formGrid}>
              <label>
                Cliente
                <input
                  type="text"
                  value={customerSearch}
                  onChange={(e) => {
                    const value = e.target.value;
                    setCustomerSearch(value);
                    if (!value.trim()) {
                      setForm((current) => ({ ...current, customer_id: '' }));
                    }
                  }}
                  placeholder="Buscar cliente por nombre, mail, telefono o CUIT"
                  required={!form.customer_id}
                />
                {showCustomerResults ? (
                  <div className={styles.customerSearchResults}>
                    {filteredCustomerOptions.length === 0 ? (
                      <div className={styles.customerSearchEmpty}>No hay clientes que coincidan.</div>
                    ) : (
                      filteredCustomerOptions.map((customer) => (
                        <button
                          key={customer.id}
                          type="button"
                          className={`${styles.customerSearchItem} ${Number(form.customer_id) === customer.id ? styles.customerSearchItemActive : ''}`}
                          onClick={() => selectCustomer(customer)}
                        >
                          <strong>{customer.name}</strong>
                          <span>
                            {[customer.cuit || null, customer.phone || null, customer.email || null].filter(Boolean).join(' · ') || 'Sin datos extra'}
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                ) : null}
                <input type="hidden" value={form.customer_id} required readOnly />
                {selectedCustomer ? (
                  <small className={styles.customerSelected}>
                    Cliente seleccionado: {selectedCustomer.name} {selectedCustomer.cuit ? `· ${selectedCustomer.cuit}` : ''}
                  </small>
                ) : null}
                <small className={styles.fieldHint}>{filteredCustomerOptions.length} cliente{filteredCustomerOptions.length === 1 ? '' : 's'} encontrado{filteredCustomerOptions.length === 1 ? '' : 's'}</small>
              </label>
              <label>
                Tipo de comprobante
                <select value={form.document_type} onChange={(e) => setForm((current) => ({ ...current, document_type: e.target.value }))}>
                  <option value="FACTURA">Factura</option>
                  <option value="NOTA_CREDITO">Nota de crédito</option>
                  <option value="PRESUPUESTO">Presupuesto</option>
                </select>
              </label>
              <label>
                Fecha y hora
                <input type="datetime-local" value={form.created_at} onChange={(e) => setForm((current) => ({ ...current, created_at: e.target.value }))} />
              </label>
              <label>
                Modalidad
                <select value={form.sale_mode} onChange={(e) => setForm((current) => ({ ...current, sale_mode: e.target.value }))}>
                  <option value="CONTADO">Contado</option>
                  <option value="CUENTA_CORRIENTE">Cuenta corriente</option>
                </select>
              </label>
              <label>
                Vendedor
                <select value={form.seller_id} onChange={(e) => setForm((current) => ({ ...current, seller_id: e.target.value }))}>
                  <option value="">Sin vendedor</option>
                  {sellers.map((seller) => (
                    <option key={seller.id} value={seller.id}>
                      {seller.name} - {seller.commission_percent}%
                    </option>
                  ))}
                </select>
                <small className={styles.fieldHint}>{selectedSeller ? `Comision estimada: ${money(commissionPreview)}` : 'Selecciona un vendedor para imputar comision'}</small>
              </label>
              <label>
                Lista de precios
                <select value={form.price_list} onChange={(e) => setForm((current) => ({ ...current, price_list: e.target.value, items: current.items.map((item) => {
                  const selected = productMap.get(Number(item.product_id));
                  if (!selected || item.manual_price) return item;
                  return { ...item, unit_price: String(getProductPriceByList(selected, e.target.value)) };
                }) }))}>
                  <option value="0">Lista especial</option>
                  <option value="1">Lista 1</option>
                  <option value="2">Lista 2</option>
                </select>
              </label>
              <label>
                Forma de pago
                <select value={form.payment_method} onChange={(e) => setForm((current) => ({ ...current, payment_method: e.target.value }))}>
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
                <input type="date" value={form.due_date} onChange={(e) => setForm((current) => ({ ...current, due_date: e.target.value }))} />
              </label>
              <label className={styles.fullWidth}>
                Notas
                <textarea rows={2} value={form.notes} onChange={(e) => setForm((current) => ({ ...current, notes: e.target.value }))} />
              </label>
            </div>
            <section className={styles.desktopPickerPanel}>
              <div className={styles.desktopPickerBar}>
                <label className={styles.desktopPickerSearch}>
                  Buscar producto
                  <input
                    type="text"
                    value={productSearch}
                    onChange={(e) => setProductSearch(e.target.value)}
                    onKeyDown={handleProductSearchKeyDown}
                    placeholder="Buscar por nombre, SKU o ID"
                  />
                </label>
              </div>
              <div className={styles.desktopPickerResults}>
                {!productSearch.trim() ? (
                  <div className={styles.emptyCell}>Escribí para buscar productos y ver coincidencias.</div>
                ) : filteredProducts.length === 0 ? (
                  <div className={styles.emptyCell}>No hay productos que coincidan con la búsqueda.</div>
                ) : (
                  <div className={styles.productSearchList}>
                    {filteredProducts.map((product) => (
                      <div key={product.id} className={styles.productSearchItem}>
                        <div className={styles.productSearchMain}>
                          <strong>{product.name}</strong>
                          <span>#{product.id} · {product.sku || 'Sin SKU'} · Stock {product.stock}</span>
                        </div>
                        <div className={styles.productSearchPrices}>
                          <span>Esp. {money(product.price)}</span>
                          <span>L1 {money(Number(product.price_list_1 || product.price || 0))}</span>
                          <span>L2 {money(Number(product.price_list_2 || product.price || 0))}</span>
                        </div>
                        <div
                          className={styles.productSearchActions}
                          onClick={(event) => event.stopPropagation()}
                        >
                          <label className={styles.inlineQty}>
                            <span>Cant.</span>
                            <input
                              type="number"
                              min="1"
                              step="1"
                              value={searchQuantities[product.id] || '1'}
                              onChange={(event) => updateSearchQuantity(product.id, event.target.value)}
                            />
                          </label>
                          <button
                            type="button"
                            className={styles.secondaryButton}
                            onClick={() => addProductToInvoice(product)}
                          >
                            Agregar
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>
            <div className={styles.invoiceLinesPanel}>
              <div className={styles.invoiceLinesHeader}>
                <div>
                  <h3>Items del comprobante</h3>
                  <p>Cantidad y precio editables directo en la grilla, como en escritorio.</p>
                </div>
                <strong>{form.items.length} item{form.items.length === 1 ? '' : 's'}</strong>
              </div>
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Producto</th>
                      <th>Stock</th>
                      <th>Cantidad</th>
                      <th>Precio unitario</th>
                      <th>Subtotal</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {form.items.map((item, index) => {
                      const selectedProduct = productMap.get(Number(item.product_id));
                      const subtotal = Number(item.quantity || 0) * Number(item.unit_price || 0);
                      return (
                        <tr key={`${item.product_id}-${index}`}>
                          <td>
                            <strong>{selectedProduct?.name || `Producto #${item.product_id}`}</strong>
                            <div className={styles.itemMeta}>
                              {selectedProduct ? `${selectedProduct.sku || 'Sin SKU'}${item.manual_price ? ' · precio manual' : ''}` : 'Producto no encontrado'}
                            </div>
                          </td>
                          <td>{selectedProduct?.stock ?? '-'}</td>
                          <td>
                            <input
                              type="number"
                              min="1"
                              step="1"
                              value={item.quantity}
                              onChange={(e) => updateItem(index, 'quantity', e.target.value)}
                              required
                            />
                          </td>
                          <td>
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              value={item.unit_price}
                              onChange={(e) => updateItem(index, 'unit_price', e.target.value)}
                              required
                            />
                          </td>
                          <td className={styles.total}>{money(subtotal)}</td>
                          <td className={styles.rowActions}>
                            <button
                              type="button"
                              className={styles.removeButton}
                              onClick={() => setForm((current) => ({ ...current, items: current.items.filter((_, itemIndex) => itemIndex !== index) }))}
                            >
                              Quitar
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                    {form.items.length === 0 ? (
                      <tr>
                        <td colSpan={6} className={styles.emptyCell}>Agrega productos desde el buscador superior para armar el comprobante.</td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </div>
            <div className={styles.createTotalBar}>
              <span>Total del comprobante</span>
              <strong className={styles.createTotal}>{money(formTotal)}</strong>
            </div>
            <div className={styles.formActions}>
              <button type="button" className={styles.secondaryButton} onClick={() => {
                setProductSearch('');
                setSearchQuantities({});
                setForm({ order_id: '', customer_id: '', document_type: 'FACTURA', sale_mode: 'CONTADO', seller_id: '', price_list: '0', payment_method: 'EFECTIVO', created_at: nowInputValue(), due_date: '', notes: '', items: [] });
              }}>Limpiar</button>
              <button type="submit" className={styles.createButton} disabled={creating || !form.customer_id || form.items.length === 0}>
                {creating ? 'Guardando...' : form.document_type === 'PRESUPUESTO' ? 'Guardar presupuesto' : form.document_type === 'NOTA_CREDITO' ? 'Emitir nota de crédito' : 'Emitir factura'}
              </button>
            </div>
          </form>
        </section>
      ) : null}
    </div>
  );
}
