'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { getApiBaseUrl, loadRuntimeConfig, resolveImageUrl } from '@/lib/api';
import { ADMIN_LIMITS } from '../adminConfig';
import { argentinaDateTimeLocalToIso, getArgentinaNowDateTimeLocalInput } from '@/lib/datetime';
import styles from '../comprobantes/comprobantes.module.css';

type CustomerOption = { id: number; name: string; email?: string | null; phone?: string | null; sale_mode?: string | null; cuit?: string | null };
type ProductOption = {
  id: number;
  name: string;
  sku: string;
  barcode?: string | null;
  price: number;
  price_list_1?: number | null;
  price_list_2?: number | null;
  stock: number;
  imageUrl?: string | null;
  image_path?: string | null;
};
type ScannedProductDraft = {
  product: ProductOption;
  quantity: string;
};
type SellerOption = { id: number; name: string; commission_percent: number; is_active: boolean };
type OrderDraft = {
  id: number;
  customer_name: string;
  customer_phone?: string | null;
  customer_email?: string | null;
  notes?: string | null;
  items: Array<{ product_id: number; sku?: string | null; name?: string | null; quantity: number; unit_price: number }>;
};
type BudgetDraft = {
  invoice: {
    id: number;
    customer_id?: number | null;
    customer_name: string;
    seller_id?: number | null;
    document_type?: string | null;
    sale_mode?: string | null;
    price_list?: number | null;
    due_date?: string | null;
    notes?: string | null;
    payment_method?: string | null;
    special_discount?: number | null;
  };
  items: Array<{
    product_id?: number | null;
    quantity: number;
    unit_price: number;
  }>;
};
type InvoiceFormItem = { product_id: string; quantity: string; unit_price: string; manual_price: boolean };

const money = (value: number) => new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(value || 0);
const normalizeSearchValue = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
const normalizePhoneValue = (value?: string | null) => {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('549') && digits.length >= 12) return digits.slice(3);
  if (digits.startsWith('54') && digits.length >= 11) return digits.slice(2);
  if (digits.startsWith('9') && digits.length >= 11) return digits.slice(1);
  if (digits.startsWith('0') && digits.length >= 11) return digits.slice(1);
  return digits;
};
const tokenizeName = (value?: string | null) =>
  normalizeSearchValue(String(value || ''))
    .split(/\s+/)
    .filter((token) => token.length >= 3);
const resolveCustomerMatch = (
  customers: CustomerOption[],
  draft: Pick<OrderDraft, 'customer_name' | 'customer_email' | 'customer_phone'>
) => {
  const normalizedDraftName = normalizeSearchValue(draft.customer_name || '');
  const normalizedDraftEmail = normalizeSearchValue(draft.customer_email || '');
  const normalizedDraftPhone = normalizePhoneValue(draft.customer_phone || '');
  const draftTokens = tokenizeName(draft.customer_name || '');
  const ranked = customers
    .map((customer) => {
      const customerName = normalizeSearchValue(customer.name || '');
      const customerEmail = normalizeSearchValue(String(customer.email || ''));
      const customerPhone = normalizePhoneValue(customer.phone || '');
      const customerTokens = tokenizeName(customer.name || '');
      let score = 0;

      if (normalizedDraftEmail && customerEmail && normalizedDraftEmail === customerEmail) score += 120;
      if (normalizedDraftPhone && customerPhone) {
        if (normalizedDraftPhone === customerPhone) score += 110;
        else if (
          normalizedDraftPhone.length >= 8 &&
          customerPhone.length >= 8 &&
          (normalizedDraftPhone.endsWith(customerPhone) || customerPhone.endsWith(normalizedDraftPhone))
        ) {
          score += 80;
        }
      }
      if (normalizedDraftName && customerName) {
        if (normalizedDraftName === customerName) score += 90;
        else if (customerName.includes(normalizedDraftName) || normalizedDraftName.includes(customerName)) score += 60;
      }
      if (draftTokens.length > 0 && customerTokens.length > 0) {
        const sharedTokens = draftTokens.filter((token) => customerTokens.includes(token)).length;
        score += sharedTokens * 18;
      }

      return { customer, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  if (ranked.length === 0) return null;
  if (ranked[0].score >= 110) return ranked[0].customer;
  if (ranked[0].score >= 72 && (ranked.length === 1 || ranked[0].score - ranked[1].score >= 18)) return ranked[0].customer;
  return null;
};
const nowInputValue = () => getArgentinaNowDateTimeLocalInput();
const formatInputDateTime = (value?: string | null) => argentinaDateTimeLocalToIso(value);
const toDateInputValue = (value?: string | null) => (value ? String(value).slice(0, 10) : '');
const round = (value: number, decimals = 2) => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

export default function GenerarComprobantePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const orderIdParam = Number(searchParams?.get('order_id') || 0);
  const budgetInvoiceIdParam = Number(searchParams?.get('budget_invoice_id') || 0);
  const customerIdParam = Number(searchParams?.get('customer_id') || 0);
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [sellers, setSellers] = useState<SellerOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [customerSearch, setCustomerSearch] = useState('');
  const [productSearch, setProductSearch] = useState('');
  const [scannedDraft, setScannedDraft] = useState<ScannedProductDraft | null>(null);
  const [searchQuantities, setSearchQuantities] = useState<Record<number, string>>({});
  const [showSpecialDiscountEditor, setShowSpecialDiscountEditor] = useState(false);
  const scannerBufferRef = useRef('');
  const scannerTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
    special_discount_percent: '0',
    items: [] as InvoiceFormItem[],
  });

  useEffect(() => {
    const load = async () => {
      try {
        setLoading(true);
        await loadRuntimeConfig();
        const [customersRes, productsRes, sellersRes] = await Promise.all([
          fetch(`${getApiBaseUrl()}/admin/backoffice-customers?limit=${ADMIN_LIMITS.customersLargeList}`, { credentials: 'include' }),
          fetch(`${getApiBaseUrl()}/admin/products?limit=${ADMIN_LIMITS.productsLargeList}`, { credentials: 'include' }),
          fetch(`${getApiBaseUrl()}/admin/sellers?limit=${ADMIN_LIMITS.sellersList}`, { credentials: 'include' }),
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
    if (!orderIdParam || budgetInvoiceIdParam || customers.length === 0 || products.length === 0) return;
    const prefill = async () => {
      try {
        await loadRuntimeConfig();
        const res = await fetch(`${getApiBaseUrl()}/admin/orders/${orderIdParam}`, { credentials: 'include' });
        if (!res.ok) throw new Error('No se pudo cargar el pedido');
        const draft = (await res.json()) as OrderDraft;
        const matchedCustomer = resolveCustomerMatch(customers, draft);
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
          special_discount_percent: '0',
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
  }, [orderIdParam, budgetInvoiceIdParam, customers, products]);

  useEffect(() => {
    if (!budgetInvoiceIdParam || customers.length === 0 || products.length === 0) return;
    const prefillBudget = async () => {
      try {
        await loadRuntimeConfig();
        const res = await fetch(`${getApiBaseUrl()}/admin/invoices/${budgetInvoiceIdParam}`, { credentials: 'include' });
        if (!res.ok) throw new Error('No se pudo cargar el presupuesto');
        const draft = (await res.json()) as BudgetDraft;
        const invoice = draft.invoice;
        if (String(invoice.document_type || '').toUpperCase() !== 'PRESUPUESTO') {
          throw new Error('El comprobante seleccionado no es un presupuesto');
        }
        const draftSubtotal = draft.items.reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.unit_price || 0), 0);
        const loadedDiscount = Number(invoice.special_discount ?? 0);
        const loadedDiscountPercent = draftSubtotal > 0 ? round((loadedDiscount / draftSubtotal) * 100, 2) : 0;
        setForm({
          order_id: '',
          customer_id: invoice.customer_id ? String(invoice.customer_id) : '',
          document_type: 'FACTURA',
          sale_mode: invoice.sale_mode || 'CONTADO',
          seller_id: invoice.seller_id ? String(invoice.seller_id) : '',
          price_list: String(invoice.price_list ?? 0),
          payment_method: invoice.payment_method || 'EFECTIVO',
          created_at: nowInputValue(),
          due_date: toDateInputValue(invoice.due_date),
          notes: invoice.notes || '',
          special_discount_percent: String(loadedDiscountPercent),
          items: draft.items.map((item) => ({
            product_id: String(item.product_id || ''),
            quantity: String(item.quantity),
            unit_price: String(item.unit_price),
            manual_price: true,
          })),
        });
        setCustomerSearch(invoice.customer_name || '');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error cargando el presupuesto');
      }
    };
    void prefillBudget();
  }, [budgetInvoiceIdParam, customers, products]);

  useEffect(() => {
    if (!customerIdParam || orderIdParam || budgetInvoiceIdParam || customers.length === 0) return;
    const matchedCustomer = customers.find((customer) => customer.id === customerIdParam);
    if (!matchedCustomer) return;
    setCustomerSearch(matchedCustomer.name || '');
    setForm((current) => ({
      ...current,
      customer_id: String(matchedCustomer.id),
      sale_mode: matchedCustomer.sale_mode || current.sale_mode,
    }));
  }, [customerIdParam, orderIdParam, budgetInvoiceIdParam, customers]);

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
      .filter((product) => [product.name, product.sku, product.barcode || '', String(product.id)].join(' ').toLowerCase().includes(needle))
      .slice(0, 12);
  }, [productSearch, products]);
  const selectedSeller = sellerMap.get(Number(form.seller_id));
  const formSubtotal = useMemo(() => form.items.reduce((acc, item) => acc + Number(item.quantity || 0) * Number(item.unit_price || 0), 0), [form.items]);
  const specialDiscountPercent = useMemo(
    () => Math.min(100, Math.max(0, Number(form.special_discount_percent || 0))),
    [form.special_discount_percent]
  );
  const specialDiscount = useMemo(
    () => round((formSubtotal * specialDiscountPercent) / 100, 2),
    [formSubtotal, specialDiscountPercent]
  );
  const hasSpecialDiscount = specialDiscountPercent > 0;
  const isSpecialDiscountOpen = showSpecialDiscountEditor || hasSpecialDiscount;
  const formTotal = useMemo(() => Math.max(0, round(formSubtotal - specialDiscount, 2)), [formSubtotal, specialDiscount]);
  const commissionPreview = useMemo(() => (selectedSeller ? (formTotal * Number(selectedSeller.commission_percent || 0)) / 100 : 0), [formTotal, selectedSeller]);
  const documentBehavior = useMemo(() => {
    if (form.document_type === 'NOTA_CREDITO') {
      return 'La nota de crédito repone stock y, si la operación es por cuenta corriente, genera crédito a favor del cliente.';
    }
    if (form.document_type === 'PRESUPUESTO') {
      return 'El presupuesto solo guarda el documento. No mueve stock ni cuenta corriente hasta que se confirme desde Comprobantes.';
    }
    return 'La factura descuenta stock y, si la operación es por cuenta corriente, genera deuda del cliente.';
  }, [form.document_type]);

  const canSubmitWithoutCustomer = form.document_type === 'PRESUPUESTO' && Boolean(form.order_id);

  const clearScannerTimer = () => {
    if (scannerTimeoutRef.current) {
      clearTimeout(scannerTimeoutRef.current);
      scannerTimeoutRef.current = null;
    }
  };

  const resetScannerBuffer = () => {
    scannerBufferRef.current = '';
    clearScannerTimer();
  };

  const isEditableTarget = (target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName;
    return (
      target.isContentEditable ||
      tag === 'INPUT' ||
      tag === 'TEXTAREA' ||
      tag === 'SELECT' ||
      Boolean(target.closest('input, textarea, select, [contenteditable="true"]'))
    );
  };

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

  const findProductByScannerValue = (rawValue: string) => {
    const normalizedValue = rawValue.trim().toLowerCase();
    if (!normalizedValue) return null;
    return (
      products.find((product) => String(product.barcode || '').trim().toLowerCase() === normalizedValue) ||
      products.find((product) => String(product.sku || '').trim().toLowerCase() === normalizedValue) ||
      products.find((product) => String(product.id) === normalizedValue) ||
      null
    );
  };

  const processScannerValue = (rawValue: string) => {
    const scannedValue = rawValue.trim();
    if (!scannedValue) return;
    const matchedProduct = findProductByScannerValue(scannedValue);
    if (!matchedProduct) {
      if (filteredProducts.length > 0) {
        setError('');
        addProductToInvoice(filteredProducts[0]);
        return;
      }
      setError(`No existe un producto con el codigo "${scannedValue}"`);
      return;
    }
    setError('');
    addProductToInvoice(matchedProduct, 1);
    setScannedDraft((current) => {
      if (current?.product.id === matchedProduct.id) {
        return {
          product: matchedProduct,
          quantity: String(Math.max(1, Number(current.quantity || 1)) + 1),
        };
      }
      return { product: matchedProduct, quantity: '1' };
    });
    setProductSearch(scannedValue);
  };

  const handleProductSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    processScannerValue(productSearch);
  };

  useEffect(() => {
    const handleWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.ctrlKey || event.altKey || event.metaKey) return;

      const target = event.target;
      const isEditingField = isEditableTarget(target);
      const isProductSearchField =
        target instanceof HTMLInputElement &&
        target.getAttribute('placeholder') === 'Buscar por nombre, SKU, codigo o ID';

      if (isEditingField && !isProductSearchField) {
        resetScannerBuffer();
        return;
      }

      if (event.key === 'Escape') {
        resetScannerBuffer();
        return;
      }

      if (event.key === 'Enter') {
        const scannedValue = isProductSearchField ? productSearch.trim() : scannerBufferRef.current.trim();
        resetScannerBuffer();
        if (!scannedValue) return;
        if (isProductSearchField) {
          event.preventDefault();
        }
        processScannerValue(scannedValue);
        return;
      }

      if (event.key.length !== 1) return;
      scannerBufferRef.current += event.key;
      clearScannerTimer();
      scannerTimeoutRef.current = setTimeout(() => {
        scannerBufferRef.current = '';
        scannerTimeoutRef.current = null;
      }, 250);
    };

    window.addEventListener('keydown', handleWindowKeyDown);
    return () => {
      window.removeEventListener('keydown', handleWindowKeyDown);
      resetScannerBuffer();
    };
  }, [productSearch, products]);

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
        special_discount: specialDiscount,
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
              {budgetInvoiceIdParam ? <p className={styles.orderDraftInfo}>Presupuesto #{budgetInvoiceIdParam} cargado como borrador editable de factura.</p> : null}
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
                <input type="hidden" value={form.customer_id} required={!canSubmitWithoutCustomer} readOnly />
                {selectedCustomer ? (
                  <small className={styles.customerSelected}>
                    Cliente seleccionado: {selectedCustomer.name} {selectedCustomer.cuit ? `· ${selectedCustomer.cuit}` : ''}
                  </small>
                ) : null}
                <small className={styles.fieldHint}>
                  {selectedCustomer
                    ? `${filteredCustomerOptions.length} cliente${filteredCustomerOptions.length === 1 ? '' : 's'} encontrado${filteredCustomerOptions.length === 1 ? '' : 's'}`
                    : canSubmitWithoutCustomer
                      ? 'Si no seleccionas un cliente, se crea uno basico automaticamente con los datos del pedido web.'
                      : `${filteredCustomerOptions.length} cliente${filteredCustomerOptions.length === 1 ? '' : 's'} encontrado${filteredCustomerOptions.length === 1 ? '' : 's'}`}
                </small>
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
                <select
                  value={form.seller_id}
                  onChange={(e) => setForm((current) => ({ ...current, seller_id: e.target.value }))}
                  required={form.document_type !== 'PRESUPUESTO'}
                >
                  <option value="" disabled={form.document_type !== 'PRESUPUESTO'}>Selecciona un vendedor</option>
                  {sellers.map((seller) => (
                    <option key={seller.id} value={seller.id}>
                      {seller.name} - {seller.commission_percent}%
                    </option>
                  ))}
                </select>
                <small className={styles.fieldHint}>
                  {selectedSeller
                    ? `Comision estimada: ${money(commissionPreview)}`
                    : form.document_type === 'PRESUPUESTO'
                      ? 'En presupuestos el vendedor es opcional. Al facturarlo despues, si queres, podes asignarlo ahi.'
                      : 'El vendedor es obligatorio para emitir el comprobante'}
                </small>
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
            <section className={styles.specialDiscountPanel}>
              <div className={styles.specialDiscountHeader}>
                <div>
                  <strong>Descuento especial</strong>
                  <p>Aplicalo solo si queres descontar un monto extra del total final del comprobante o presupuesto.</p>
                </div>
                <button
                  type="button"
                  className={hasSpecialDiscount ? styles.removeButton : styles.secondaryButton}
                  onClick={() => {
                    if (isSpecialDiscountOpen) {
                      setShowSpecialDiscountEditor(false);
                      setForm((current) => ({ ...current, special_discount_percent: '0' }));
                      return;
                    }
                    setShowSpecialDiscountEditor(true);
                  }}
                >
                  {isSpecialDiscountOpen ? 'Quitar descuento' : 'Agregar descuento especial'}
                </button>
              </div>
              {isSpecialDiscountOpen ? (
                <div className={styles.specialDiscountFields}>
                  <label>
                    Porcentaje a descontar
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      max="100"
                      value={form.special_discount_percent}
                      onChange={(e) => setForm((current) => ({ ...current, special_discount_percent: e.target.value }))}
                      placeholder="0"
                    />
                    <small className={styles.fieldHint}>
                      Se aplica sobre el subtotal. Descuento actual: {money(specialDiscount)} ({specialDiscountPercent}%).
                    </small>
                  </label>
                </div>
              ) : null}
            </section>
            <section className={styles.desktopPickerPanel}>
              <div className={styles.desktopPickerBar}>
                <label className={styles.desktopPickerSearch}>
                  Buscar o escanear producto
                  <input
                    type="text"
                    value={productSearch}
                    onChange={(e) => setProductSearch(e.target.value)}
                    onKeyDown={handleProductSearchKeyDown}
                    placeholder="Buscar por nombre, SKU, codigo o ID"
                  />
                  <small className={styles.fieldHint}>
                    Cada lectura suma 1 unidad al comprobante. Si escaneas el mismo codigo varias veces, acumula cantidad sobre el mismo producto.
                  </small>
                </label>
              </div>
              {scannedDraft ? (
                <div className={styles.productSearchItem}>
                  <div className={styles.productSearchIdentity}>
                    <div className={styles.productSearchThumb}>
                      {resolveImageUrl(scannedDraft.product.imageUrl || scannedDraft.product.image_path, getApiBaseUrl()) ? (
                        <img
                          src={resolveImageUrl(scannedDraft.product.imageUrl || scannedDraft.product.image_path, getApiBaseUrl()) || ''}
                          alt={scannedDraft.product.name}
                          loading="lazy"
                        />
                      ) : (
                        <span>Sin imagen</span>
                      )}
                    </div>
                    <div className={styles.productSearchMain}>
                      <strong>{scannedDraft.product.name}</strong>
                      <span>
                        #{scannedDraft.product.id} · {scannedDraft.product.sku || 'Sin SKU'} · Cod. {scannedDraft.product.barcode || '-'} · Stock {scannedDraft.product.stock}
                      </span>
                    </div>
                  </div>
                  <div className={styles.productSearchPrices}>
                    <span>Esp. {money(scannedDraft.product.price)}</span>
                    <span>L1 {money(Number(scannedDraft.product.price_list_1 || scannedDraft.product.price || 0))}</span>
                    <span>L2 {money(Number(scannedDraft.product.price_list_2 || scannedDraft.product.price || 0))}</span>
                  </div>
                  <div className={styles.productSearchActions}>
                    <span>Escaneado {scannedDraft.quantity} {Number(scannedDraft.quantity) === 1 ? 'vez' : 'veces'}</span>
                    <button type="button" className={styles.secondaryButton} onClick={() => setScannedDraft(null)}>
                      Ocultar
                    </button>
                  </div>
                </div>
              ) : null}
              <div className={styles.desktopPickerResults}>
                {!productSearch.trim() ? (
                  <div className={styles.emptyCell}>Escribí para buscar productos y ver coincidencias.</div>
                ) : filteredProducts.length === 0 ? (
                  <div className={styles.emptyCell}>No hay productos que coincidan con la búsqueda.</div>
                ) : (
                  <div className={styles.productSearchList}>
                    {filteredProducts.map((product) => {
                      const productImageUrl = resolveImageUrl(product.imageUrl || product.image_path, getApiBaseUrl());
                      return (
                        <div key={product.id} className={styles.productSearchItem}>
                          <div className={styles.productSearchIdentity}>
                          <div className={styles.productSearchThumb}>
                            {productImageUrl ? (
                              <img src={productImageUrl} alt={product.name} loading="lazy" />
                            ) : (
                              <span>Sin imagen</span>
                            )}
                          </div>
                          <div className={styles.productSearchMain}>
                            <strong>{product.name}</strong>
                          <span>#{product.id} · {product.sku || 'Sin SKU'} · Cod. {product.barcode || '-'} · Stock {product.stock}</span>
                          </div>
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
                              value={searchQuantities[product.id] ?? '1'}
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
                      );
                    })}
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
                              {selectedProduct ? `${selectedProduct.sku || 'Sin SKU'} · Cod. ${selectedProduct.barcode || '-'}${item.manual_price ? ' · precio manual' : ''}` : 'Producto no encontrado'}
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
            <div className={styles.createTotalBar}>
              <div className={styles.summaryRows}>
                <div className={styles.metaRow}>
                  <span>Subtotal</span>
                  <strong>{money(formSubtotal)}</strong>
                </div>
                {specialDiscount > 0 ? (
                  <div className={styles.metaRow}>
                    <span>Descuento especial</span>
                    <strong>-{money(specialDiscount)} ({specialDiscountPercent}%)</strong>
                  </div>
                ) : null}
                <div className={styles.metaRow}>
                  <span>Total final</span>
                  <strong>{money(formTotal)}</strong>
                </div>
              </div>
            </div>
            <div className={styles.formActions}>
              <button type="button" className={styles.secondaryButton} onClick={() => {
                setScannedDraft(null);
                setProductSearch('');
                setSearchQuantities({});
                setShowSpecialDiscountEditor(false);
                setForm({ order_id: '', customer_id: '', document_type: 'FACTURA', sale_mode: 'CONTADO', seller_id: '', price_list: '0', payment_method: 'EFECTIVO', created_at: nowInputValue(), due_date: '', notes: '', special_discount_percent: '0', items: [] });
              }}>Limpiar</button>
              <button
                type="submit"
                className={styles.createButton}
                disabled={creating || (!form.customer_id && !canSubmitWithoutCustomer) || form.items.length === 0}
              >
                {creating ? 'Guardando...' : form.document_type === 'PRESUPUESTO' ? 'Guardar presupuesto' : form.document_type === 'NOTA_CREDITO' ? 'Emitir nota de crédito' : 'Emitir factura'}
              </button>
            </div>
          </form>
        </section>
      ) : null}
    </div>
  );
}
