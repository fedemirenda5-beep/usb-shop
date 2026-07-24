'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { getApiBaseUrl, loadRuntimeConfig, resolveImageUrl } from '@/lib/api';
import { ADMIN_LIMITS } from '../adminConfig';
import { argentinaDateTimeLocalToIso, getArgentinaNowDateTimeLocalInput } from '@/lib/datetime';
import styles from '../comprobantes/comprobantes.module.css';

type CustomerOption = {
  id: number;
  name: string;
  email?: string | null;
  phone?: string | null;
  sale_mode?: string | null;
  cuit?: string | null;
  seller_id?: number | null;
};
type ProductOption = {
  id: number;
  name: string;
  sku: string;
  barcode?: string | null;
  category_id?: number | null;
  imeis?: string[];
  price: number;
  price_list_1?: number | null;
  price_list_2?: number | null;
  stock: number;
  imageUrl?: string | null;
  image_path?: string | null;
};
type CategoryOption = { id: number; name: string };
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
type InvoiceFormItem = { product_id: string; quantity: string; unit_price: string; manual_price: boolean; imeis: string[] };
type ImeiLookupResponse = {
  found: boolean;
  imei: string;
  is_own: boolean;
  status: 'available' | 'sold' | 'unknown';
  product?: {
    id?: number | null;
    name?: string | null;
    sku?: string | null;
    category_id?: number | null;
    category_name?: string | null;
  };
  sale?: {
    invoice_id?: number | null;
    sold_at?: string | null;
    document_type?: string | null;
  };
};

const money = (value: number) => new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(value || 0);
const CELULARES_COMMISSION_PERCENT = 5;
const normalizeSearchValue = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
const normalizeCategoryName = (value?: string | null) => normalizeSearchValue(String(value || ''));
const isNokia106ExceptionProduct = (value?: string | null) => {
  const normalized = normalizeSearchValue(String(value || ''));
  return normalized === 'nokia 106' || normalized.startsWith('nokia 106 ');
};
const sameProductIdentity = (
  left?: { id?: number | null; name?: string | null; sku?: string | null } | null,
  right?: { id?: number | null; name?: string | null; sku?: string | null } | null
) => {
  const leftId = Number(left?.id || 0);
  const rightId = Number(right?.id || 0);
  if (leftId > 0 && rightId > 0 && leftId === rightId) return true;
  const leftSku = normalizeSearchValue(String(left?.sku || ''));
  const rightSku = normalizeSearchValue(String(right?.sku || ''));
  if (leftSku && rightSku && leftSku === rightSku) return true;
  const leftName = normalizeSearchValue(String(left?.name || ''));
  const rightName = normalizeSearchValue(String(right?.name || ''));
  return Boolean(leftName && rightName && leftName === rightName);
};
const normalizePhoneValue = (value?: string | null) => {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('549') && digits.length >= 12) return digits.slice(3);
  if (digits.startsWith('54') && digits.length >= 11) return digits.slice(2);
  if (digits.startsWith('9') && digits.length >= 11) return digits.slice(1);
  if (digits.startsWith('0') && digits.length >= 11) return digits.slice(1);
  return digits;
};
const calculateCommissionPreview = ({
  items,
  sellerPercent,
  celularesCategoryIds,
  productMap,
  specialDiscount,
}: {
  items: InvoiceFormItem[];
  sellerPercent: number;
  celularesCategoryIds: Set<number>;
  productMap: Map<number, ProductOption>;
  specialDiscount: number;
}) => {
  const normalizedItems = items
    .map((item) => {
      const productId = Number(item.product_id || 0);
      const quantity = Math.max(0, Number(item.quantity || 0));
      const unitPrice = Math.max(0, Number(item.unit_price || 0));
      const product = productMap.get(productId);
      const lineTotal = round(quantity * unitPrice, 2);
      return {
        category_id: product?.category_id ?? null,
        product_name: product?.name ?? '',
        line_total: lineTotal,
      };
    })
    .filter((item) => item.line_total > 0);
  const subtotal = round(normalizedItems.reduce((acc, item) => acc + item.line_total, 0), 2);
  if (subtotal <= 0) return 0;
  return round(
    normalizedItems.reduce((acc, item) => {
      const discountShare = specialDiscount > 0 ? round((specialDiscount * item.line_total) / subtotal, 2) : 0;
      const commissionable = Math.max(0, round(item.line_total - discountShare, 2));
      const percent =
        !isNokia106ExceptionProduct(item.product_name) && item.category_id && celularesCategoryIds.has(item.category_id)
          ? CELULARES_COMMISSION_PERCENT
          : Number(sellerPercent || 0);
      return acc + (commissionable * percent) / 100;
    }, 0),
    2
  );
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
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [sellers, setSellers] = useState<SellerOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [customerSearch, setCustomerSearch] = useState('');
  const [productSearch, setProductSearch] = useState('');
  const [scannedDraft, setScannedDraft] = useState<ScannedProductDraft | null>(null);
  const [searchQuantities, setSearchQuantities] = useState<Record<number, string>>({});
  const [imeiDrafts, setImeiDrafts] = useState<Record<number, string>>({});
  const [showSpecialDiscountEditor, setShowSpecialDiscountEditor] = useState(false);
  const productSearchInputRef = useRef<HTMLInputElement | null>(null);
  const scannerBufferRef = useRef('');
  const scannerTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scannerAutoSubmitTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scannerLastAutoSubmittedRef = useRef('');
  const scannerLastKeyAtRef = useRef(0);
  const scannerProcessingRef = useRef(false);
  const scannerQueuedValueRef = useRef('');
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
        const [customersRes, productsRes, sellersRes, categoriesRes] = await Promise.all([
          fetch(`${getApiBaseUrl()}/admin/backoffice-customers?limit=${ADMIN_LIMITS.customersLargeList}`, { credentials: 'include' }),
          fetch(`${getApiBaseUrl()}/admin/products?limit=${ADMIN_LIMITS.productsLargeList}`, { credentials: 'include' }),
          fetch(`${getApiBaseUrl()}/admin/sellers?limit=${ADMIN_LIMITS.sellersList}`, { credentials: 'include' }),
          fetch(`${getApiBaseUrl()}/admin/categories`, { credentials: 'include' }),
        ]);
        if (!customersRes.ok || !productsRes.ok || !sellersRes.ok || !categoriesRes.ok) throw new Error('No se pudieron cargar las opciones');
        setCustomers(await customersRes.json());
        setProducts(await productsRes.json());
        setSellers((await sellersRes.json()).filter((seller: SellerOption) => seller.is_active));
        setCategories(await categoriesRes.json());
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
          seller_id: matchedCustomer?.seller_id ? String(matchedCustomer.seller_id) : '',
          price_list: '0',
          payment_method: 'EFECTIVO',
          created_at: nowInputValue(),
          due_date: '',
          notes: draft.notes || '',
          special_discount_percent: '0',
          items: draft.items.length
            ? draft.items.map((item) => ({ product_id: String(item.product_id), quantity: String(item.quantity), unit_price: String(item.unit_price), manual_price: true, imeis: [] }))
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
            imeis: [],
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
      seller_id: matchedCustomer.seller_id ? String(matchedCustomer.seller_id) : '',
    }));
  }, [customerIdParam, orderIdParam, budgetInvoiceIdParam, customers]);

  const customerMap = useMemo(() => new Map(customers.map((customer) => [customer.id, customer])), [customers]);
  const productMap = useMemo(() => new Map(products.map((product) => [product.id, product])), [products]);
  const sellerMap = useMemo(() => new Map(sellers.map((seller) => [seller.id, seller])), [sellers]);
  const celularesCategoryIds = useMemo(
    () => new Set(categories.filter((category) => normalizeCategoryName(category.name) === 'celulares').map((category) => category.id)),
    [categories]
  );
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
  const commissionPreview = useMemo(
    () =>
      selectedSeller
        ? calculateCommissionPreview({
            items: form.items,
            sellerPercent: Number(selectedSeller.commission_percent || 0),
            celularesCategoryIds,
            productMap,
            specialDiscount,
          })
        : 0,
    [celularesCategoryIds, form.items, productMap, selectedSeller, specialDiscount]
  );
  const documentBehavior = useMemo(() => {
    if (form.document_type === 'NOTA_CREDITO') {
      return 'La nota de crédito repone stock y, si la operación es por cuenta corriente, genera crédito a favor del cliente.';
    }
    if (form.document_type === 'PRESUPUESTO') {
      return 'El presupuesto solo guarda el documento. No mueve stock ni cuenta corriente hasta que se confirme desde Comprobantes.';
    }
    return 'La factura descuenta stock y, si la operación es por cuenta corriente, genera deuda del cliente.';
  }, [form.document_type]);
  const pendingOrderCellphoneImeiItems = useMemo(() => {
    if (form.document_type !== 'FACTURA') return [];
    return form.items
      .map((item, index) => {
        const product = productMap.get(Number(item.product_id));
        if (!product?.category_id || !celularesCategoryIds.has(product.category_id)) return null;
        const quantity = Math.max(0, Number(item.quantity || 0));
        const imeiCount = item.imeis.length;
        const missingCount = Math.max(0, quantity - imeiCount);
        if (missingCount <= 0) return null;
        return { index, product, quantity, imeiCount, missingCount };
      })
      .filter(Boolean) as Array<{ index: number; product: ProductOption; quantity: number; imeiCount: number; missingCount: number }>;
  }, [form.document_type, form.items, productMap, celularesCategoryIds]);
  const hasPendingOrderCellphoneImeis = pendingOrderCellphoneImeiItems.length > 0;

  const canSubmitWithoutCustomer = Boolean(form.order_id) && form.document_type !== 'NOTA_CREDITO';

  const clearScannerTimer = () => {
    if (scannerTimeoutRef.current) {
      clearTimeout(scannerTimeoutRef.current);
      scannerTimeoutRef.current = null;
    }
    if (scannerAutoSubmitTimeoutRef.current) {
      clearTimeout(scannerAutoSubmitTimeoutRef.current);
      scannerAutoSubmitTimeoutRef.current = null;
    }
  };

  const resetScannerBuffer = () => {
    scannerBufferRef.current = '';
    clearScannerTimer();
  };

  const clearProductSearchInput = () => {
    if (productSearchInputRef.current) {
      productSearchInputRef.current.value = '';
    }
    setProductSearch('');
    scannerLastAutoSubmittedRef.current = '';
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

  const addProductToInvoice = (product: ProductOption, quantityOverride?: number, scannedImei?: string) => {
    const inlineQuantity = searchQuantities[product.id];
    const normalizedQuantity = Math.max(1, Number(quantityOverride || inlineQuantity || 1));
    const requiresImei = Boolean(product.category_id && celularesCategoryIds.has(product.category_id));
    let wasAdded = true;
    setForm((current) => {
      const existingIndex = current.items.findIndex((item) => Number(item.product_id) === product.id);
      if (existingIndex >= 0) {
        if (scannedImei && current.items[existingIndex].imeis.includes(scannedImei)) {
          wasAdded = false;
          return current;
        }
        return {
          ...current,
          items: current.items.map((item, index) =>
            index === existingIndex
              ? {
                  ...item,
                  quantity: scannedImei
                    ? String(Math.max(Number(item.quantity || 0), item.imeis.length + normalizedQuantity))
                    : String(Number(item.quantity || 0) + normalizedQuantity),
                  imeis: scannedImei ? [...item.imeis, scannedImei] : item.imeis,
                }
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
            imeis: scannedImei ? [scannedImei] : [],
          },
        ],
      };
    });
    setSearchQuantities((current) => ({ ...current, [product.id]: '1' }));
    if (!wasAdded && scannedImei) {
      setError(`El IMEI ${scannedImei} ya esta cargado en este comprobante`);
      return wasAdded;
    }
    if (requiresImei && !scannedImei && form.document_type === 'FACTURA') {
      setError(`Agrega ${normalizedQuantity} IMEI${normalizedQuantity === 1 ? '' : 's'} para ${product.name} antes de emitir la factura`);
    }
    return wasAdded;
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

  const loadScannerProducts = async (rawValue: string) => {
    await loadRuntimeConfig();
    const params = new URLSearchParams({
      q: rawValue.trim(),
      limit: String(ADMIN_LIMITS.scannerLookup),
    });
    const res = await fetch(`${getApiBaseUrl()}/admin/products?${params.toString()}`, {
      credentials: 'include',
    });
    if (!res.ok) {
      throw new Error('No se pudieron cargar los productos para el lector');
    }
    const data = await res.json();
    return Array.isArray(data) ? (data as ProductOption[]) : [];
  };

  const lookupImeiValue = async (rawValue: string) => {
    await loadRuntimeConfig();
    const params = new URLSearchParams({ q: rawValue.trim() });
    const res = await fetch(`${getApiBaseUrl()}/admin/imei-lookup?${params.toString()}`, { credentials: 'include' });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      throw new Error(payload.detail || 'No se pudo consultar el IMEI');
    }
    return (await res.json()) as ImeiLookupResponse;
  };

  const processScannerValue = async (rawValue: string) => {
    try {
      const scannedValue = rawValue.trim();
      if (!scannedValue) return;
      const probablyImei = /^\d{14,17}$/.test(scannedValue);
      if (probablyImei) {
        const imeiLookup = await lookupImeiValue(scannedValue);
        if (!imeiLookup.found || !imeiLookup.is_own || !imeiLookup.product?.id) {
          setError(`El IMEI ${scannedValue} no esta registrado como propio`);
          return;
        }
        if (imeiLookup.status === 'sold') {
          const soldAt = imeiLookup.sale?.sold_at ? ` el ${String(imeiLookup.sale.sold_at).slice(0, 10)}` : '';
          const soldInvoice = imeiLookup.sale?.invoice_id ? ` en comprobante #${imeiLookup.sale.invoice_id}` : '';
          setError(`El IMEI ${scannedValue} ya fue vendido${soldAt}${soldInvoice}`);
          return;
        }
        const imeiProductId = Number(imeiLookup.product.id);
        const imeiProduct =
          products.find((product) => product.id === imeiProductId) ||
          (await loadScannerProducts(String(imeiProductId))).find((product) => product.id === imeiProductId) ||
          null;
        if (!imeiProduct) {
          setError(`El IMEI ${scannedValue} es propio, pero el producto no esta disponible en la lista actual`);
          return;
        }
        if (form.order_id) {
          const targetIndex = form.items.findIndex((item) => {
            const currentProduct = productMap.get(Number(item.product_id));
            return sameProductIdentity(
              currentProduct
                ? { id: currentProduct.id, name: currentProduct.name, sku: currentProduct.sku }
                : { id: Number(item.product_id || 0), name: null, sku: null },
              imeiLookup.product
            );
          });
          if (targetIndex >= 0) {
            setError('');
            await appendImeiToItem(targetIndex, scannedValue, imeiLookup);
            setScannedDraft((current) => {
              if (current?.product.id === imeiProduct.id) {
                return {
                  product: imeiProduct,
                  quantity: String(Math.max(1, Number(current.quantity || 1)) + 1),
                };
              }
              return { product: imeiProduct, quantity: '1' };
            });
            return;
          }
        }
        setError('');
        if (!addProductToInvoice(imeiProduct, 1, scannedValue)) {
          return;
        }
        setScannedDraft((current) => {
          if (current?.product.id === imeiProduct.id) {
            return {
              product: imeiProduct,
              quantity: String(Math.max(1, Number(current.quantity || 1)) + 1),
            };
          }
          return { product: imeiProduct, quantity: '1' };
        });
        return;
      }
      const matchedProduct = findProductByScannerValue(scannedValue);
      const resolvedProduct = matchedProduct || findProductByScannerValue(
        scannedValue,
      ) || (
        await (async () => {
          const remoteProducts = await loadScannerProducts(scannedValue);
          const normalizedValue = scannedValue.trim().toLowerCase();
          return (
            remoteProducts.find((product) => String(product.barcode || '').trim().toLowerCase() === normalizedValue) ||
            remoteProducts.find((product) => String(product.sku || '').trim().toLowerCase() === normalizedValue) ||
            remoteProducts.find((product) => String(product.id) === normalizedValue) ||
            null
          );
        })()
      );
      if (!resolvedProduct) {
        if (filteredProducts.length > 0) {
          setError('');
          addProductToInvoice(filteredProducts[0]);
          return;
        }
        setError(`No existe un producto con el codigo "${scannedValue}"`);
        return;
      }
      setError('');
      addProductToInvoice(resolvedProduct, 1);
      setScannedDraft((current) => {
        if (current?.product.id === resolvedProduct.id) {
          return {
            product: resolvedProduct,
            quantity: String(Math.max(1, Number(current.quantity || 1)) + 1),
          };
        }
        return { product: resolvedProduct, quantity: '1' };
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo procesar el escaneo');
    }
  };

  const submitScannerValue = (rawValue: string) => {
    const scannedValue = rawValue.trim();
    if (!scannedValue) return;
    resetScannerBuffer();
    clearProductSearchInput();
    if (scannerProcessingRef.current) {
      scannerQueuedValueRef.current = scannedValue;
      return;
    }
    scannerProcessingRef.current = true;
    void (async () => {
      let currentValue = scannedValue;
      while (currentValue) {
        await processScannerValue(currentValue);
        currentValue = scannerQueuedValueRef.current.trim();
        scannerQueuedValueRef.current = '';
      }
      scannerProcessingRef.current = false;
    })();
  };

  const handleProductSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const scannedValue = event.currentTarget.value.trim() || productSearch.trim();
    scannerLastAutoSubmittedRef.current = scannedValue;
    if (!scannedValue) return;
    submitScannerValue(scannedValue);
  };

  const scheduleProductSearchAutoSubmit = (rawValue: string) => {
    const scannedValue = rawValue.trim();
    if (!scannedValue) {
      scannerLastAutoSubmittedRef.current = '';
      if (scannerAutoSubmitTimeoutRef.current) {
        clearTimeout(scannerAutoSubmitTimeoutRef.current);
        scannerAutoSubmitTimeoutRef.current = null;
      }
      return;
    }
    const probablyScannerCode = /^\d{6,17}$/.test(scannedValue);
    if (!probablyScannerCode || scannerLastAutoSubmittedRef.current === scannedValue) {
      return;
    }
    if (scannerAutoSubmitTimeoutRef.current) {
      clearTimeout(scannerAutoSubmitTimeoutRef.current);
    }
    scannerAutoSubmitTimeoutRef.current = setTimeout(() => {
      scannerAutoSubmitTimeoutRef.current = null;
      if (scannerLastAutoSubmittedRef.current === scannedValue) return;
      scannerLastAutoSubmittedRef.current = scannedValue;
      submitScannerValue(scannedValue);
    }, 180);
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
      if (isProductSearchField) {
        if (event.key === 'Escape') {
          resetScannerBuffer();
        }
        return;
      }

      if (event.key === 'Escape') {
        resetScannerBuffer();
        return;
      }

      if (event.key === 'Enter') {
        const scannedValue = scannerBufferRef.current.trim();
        resetScannerBuffer();
        if (!scannedValue) return;
        submitScannerValue(scannedValue);
        return;
      }

      if (event.key.length !== 1) return;
      const now = Date.now();
      const delta = now - scannerLastKeyAtRef.current;
      scannerLastKeyAtRef.current = now;
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
  }, [productSearch, products, form.price_list]);

  const updateSearchQuantity = (productId: number, value: string) => {
    setSearchQuantities((current) => ({ ...current, [productId]: value }));
  };

  const selectCustomer = (customer: CustomerOption) => {
    setCustomerSearch(customer.name);
    setForm((current) => ({
      ...current,
      customer_id: String(customer.id),
      sale_mode: customer.sale_mode || current.sale_mode,
      seller_id: customer.seller_id ? String(customer.seller_id) : '',
    }));
  };

  const appendImeiToItem = async (index: number, rawValue: string, prefetchedLookup?: ImeiLookupResponse) => {
    const scannedValue = rawValue.trim();
    if (!scannedValue) return;
    const targetItem = form.items[index];
    if (!targetItem) return;
    const productId = Number(targetItem.product_id || 0);
    const selectedProduct = productMap.get(productId);
    if (!selectedProduct) {
      setError('No se encontro el producto para cargar el IMEI');
      return;
    }
    try {
      const imeiLookup = prefetchedLookup || (await lookupImeiValue(scannedValue));
      if (!imeiLookup.found || !imeiLookup.is_own || !imeiLookup.product?.id) {
        setError(`El IMEI ${scannedValue} no esta registrado como propio`);
        return;
      }
      if (
        Number(imeiLookup.product.id) !== productId &&
        !sameProductIdentity(
          { id: productId, name: selectedProduct.name, sku: selectedProduct.sku },
          imeiLookup.product
        )
      ) {
        setError(`El IMEI ${scannedValue} no pertenece al producto ${selectedProduct.name}`);
        return;
      }
      if (imeiLookup.status === 'sold') {
        const soldAt = imeiLookup.sale?.sold_at ? ` el ${String(imeiLookup.sale.sold_at).slice(0, 10)}` : '';
        const soldInvoice = imeiLookup.sale?.invoice_id ? ` en comprobante #${imeiLookup.sale.invoice_id}` : '';
        setError(`El IMEI ${scannedValue} ya fue vendido${soldAt}${soldInvoice}`);
        return;
      }

      let wasAdded = true;
      setForm((current) => {
        const duplicateInInvoice = current.items.some((item) => item.imeis.includes(scannedValue));
        if (duplicateInInvoice) {
          wasAdded = false;
          return current;
        }
        return {
          ...current,
          items: current.items.map((item, itemIndex) => {
            if (itemIndex !== index) return item;
            const nextImeis = [...item.imeis, scannedValue];
            return {
              ...item,
              quantity: String(Math.max(Number(item.quantity || 0), nextImeis.length)),
              imeis: nextImeis,
            };
          }),
        };
      });
      if (!wasAdded) {
        setError(`El IMEI ${scannedValue} ya esta cargado en este comprobante`);
        return;
      }
      setImeiDrafts((current) => ({ ...current, [index]: '' }));
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo cargar el IMEI');
    }
  };

  const submitInvoice = async (event: React.FormEvent) => {
    event.preventDefault();
    if (hasPendingOrderCellphoneImeis) {
      const pendingLabels = pendingOrderCellphoneImeiItems
        .map((item) => `${item.product.name}: faltan ${item.missingCount} IMEI${item.missingCount === 1 ? '' : 's'}`)
        .join(' · ');
      setError(`Antes de emitir la factura, carga los IMEIs pendientes. ${pendingLabels}`);
      return;
    }
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
        items: form.items.map((item) => ({
          product_id: Number(item.product_id),
          quantity: Number(item.quantity),
          unit_price: Number(item.unit_price),
          imeis: item.imeis,
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
                      ? 'Si no seleccionas un cliente, se crea uno basico automaticamente con los datos del pedido web al emitir.'
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
                    ref={productSearchInputRef}
                    type="text"
                    value={productSearch}
                    onChange={(e) => {
                      const nextValue = e.target.value;
                      setProductSearch(nextValue);
                      scheduleProductSearchAutoSubmit(nextValue);
                    }}
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
              {hasPendingOrderCellphoneImeis ? (
                <div className={styles.orderDraftInfo}>
                  Hay celulares pendientes de IMEI. Escanealos o elegilos desde la lista antes de emitir la factura.
                </div>
              ) : null}
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
                              {selectedProduct
                                ? `${selectedProduct.sku || 'Sin SKU'} · Cod. ${selectedProduct.barcode || '-'}${item.manual_price ? ' · precio manual' : ''}${item.imeis.length > 0 ? ` · IMEIs ${item.imeis.join(', ')}` : ''}`
                                : 'Producto no encontrado'}
                            </div>
                            {selectedProduct?.category_id && celularesCategoryIds.has(selectedProduct.category_id) && form.document_type === 'FACTURA' ? (
                              <>
                                <div className={styles.itemMeta}>
                                  IMEIs cargados: {item.imeis.length}/{Math.max(0, Number(item.quantity || 0))}
                                </div>
                                <div className={styles.imeiRowEditor}>
                                  <input
                                    type="text"
                                    inputMode="numeric"
                                    placeholder={`Escanear IMEI ${item.imeis.length + 1}`}
                                    value={imeiDrafts[index] || ''}
                                    list={`imei-options-${index}`}
                                    onChange={(e) => setImeiDrafts((current) => ({ ...current, [index]: e.target.value }))}
                                    onKeyDown={(e) => {
                                      if (e.key !== 'Enter') return;
                                      e.preventDefault();
                                      void appendImeiToItem(index, e.currentTarget.value || '');
                                    }}
                                  />
                                  <datalist id={`imei-options-${index}`}>
                                    {(selectedProduct.imeis || []).map((imei) => (
                                      <option key={imei} value={imei} />
                                    ))}
                                  </datalist>
                                  <button
                                    type="button"
                                    className={styles.secondaryButton}
                                    onClick={() => void appendImeiToItem(index, imeiDrafts[index] || '')}
                                  >
                                    Agregar IMEI
                                  </button>
                                </div>
                                {selectedProduct.imeis && selectedProduct.imeis.length > 0 ? (
                                  <div className={styles.itemMeta}>
                                    Disponibles para elegir: {selectedProduct.imeis.join(', ')}
                                  </div>
                                ) : null}
                              </>
                            ) : null}
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
                disabled={creating || (!form.customer_id && !canSubmitWithoutCustomer) || form.items.length === 0 || hasPendingOrderCellphoneImeis}
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
