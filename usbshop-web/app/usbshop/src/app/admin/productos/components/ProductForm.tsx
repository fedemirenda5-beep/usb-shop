'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import { fetchApiResponse, getApiBaseUrl, getFriendlyApiError, resolveImageUrl } from '@/lib/api';
import styles from './ProductForm.module.css';

const MAX_PRODUCT_IMAGES = 3;

interface ProductFormData {
  name: string;
  sku: string;
  barcode?: string | null;
  imeis?: string[];
  price: number;
  price_list_1?: number | null;
  price_list_2?: number | null;
  cost: number;
  stock: number;
  category_id?: number | null;
  is_featured: boolean;
  is_offer: boolean;
  is_bundle?: boolean;
  bundle_items?: Array<{ product_id: number; quantity: number; name?: string | null; sku?: string | null }>;
  highlight_new_arrivals: boolean;
  flash_offer_price?: number | null;
  flash_offer_ends_at?: string | null;
  image_path: string;
  image_urls?: string[];
}

interface ProductFormState {
  name: string;
  sku: string;
  barcode: string;
  imeis: string;
  price: string;
  price_list_1: string;
  price_list_2: string;
  cost: string;
  stock: string;
  category_id: string;
  margin: string;
  is_featured: boolean;
  is_offer: boolean;
  is_bundle: boolean;
  highlight_new_arrivals: boolean;
  flash_offer_price: string;
  flash_offer_ends_at: string;
}

interface CategoryOption {
  id: number;
  name: string;
}

interface SelectableProductOption {
  id: number;
  name: string;
  sku: string;
  is_bundle?: boolean;
}

interface ProductFormProps {
  initialData?: ProductFormData & { id?: number };
  title: string;
  onSubmit: (data: ProductFormData & { image_urls: string[] }) => Promise<void>;
  categories?: CategoryOption[];
  selectableProducts?: SelectableProductOption[];
  canViewProfitMetrics?: boolean;
}

const toDecimalString = (value: number) => {
  if (!Number.isFinite(value)) {
    return '0';
  }
  return String(value);
};

const toIntegerString = (value: number) => {
  if (!Number.isFinite(value)) {
    return '0';
  }
  return String(Math.trunc(value));
};

const toDateTimeLocalInput = (value?: string | null) => {
  if (!value) {
    return '';
  }
  return String(value).replace(' ', 'T').slice(0, 16);
};

const parseDecimal = (value: string) => {
  const normalized = value.trim().replace(',', '.');
  if (!normalized) {
    return 0;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
};

const parseInteger = (value: string) => {
  const normalized = value.trim();
  if (!normalized) {
    return 0;
  }
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
};

const sanitizeDecimalInput = (value: string) => value.replace(',', '.').replace(/[^0-9.\-]/g, '');
const sanitizeIntegerInput = (value: string) => value.replace(/[^\d-]/g, '');

const calculateMargin = (cost: number, price: number) => {
  if (!Number.isFinite(cost) || cost <= 0 || !Number.isFinite(price)) {
    return 0;
  }
  return ((price - cost) / cost) * 100;
};

const formatMargin = (value: number) => {
  if (!Number.isFinite(value)) {
    return '0';
  }
  return String(Number(value.toFixed(2)));
};

const dedupeImageValues = (values: string[]) => {
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  return Array.from(new Set(normalized)).slice(0, MAX_PRODUCT_IMAGES);
};

const normalizeCategoryName = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

const splitCollapsedImeiToken = (value: string) => {
  const digits = value.replace(/[^\d]/g, '').trim();
  if (!digits) return [] as string[];
  if (digits.length <= 17) return [digits];
  for (const chunkSize of [15, 14, 16, 17]) {
    if (digits.length % chunkSize !== 0) continue;
    const chunks = Array.from({ length: digits.length / chunkSize }, (_, index) =>
      digits.slice(index * chunkSize, (index + 1) * chunkSize)
    ).filter(Boolean);
    if (chunks.length > 1 && chunks.every((chunk) => chunk.length >= 14 && chunk.length <= 17)) {
      return chunks;
    }
  }
  return [digits];
};

const parseImeiValues = (value: string) =>
  Array.from(
    new Set(
      value
        .split(/[\s,;]+/)
        .flatMap((item) => splitCollapsedImeiToken(item))
        .filter(Boolean)
    )
  );

const buildInitialImages = (initialData?: ProductFormData & { id?: number }) => {
  const entries = dedupeImageValues([
    initialData?.image_path || '',
    ...(Array.isArray(initialData?.image_urls) ? initialData.image_urls : []),
  ]);
  return Array.from({ length: MAX_PRODUCT_IMAGES }, (_, index) => entries[index] || '');
};

const buildInitialState = (initialData?: ProductFormData & { id?: number }): ProductFormState => {
  const source = initialData || {
    name: '',
    sku: '',
    barcode: '',
    imeis: [],
    price: 0,
    cost: 0,
    stock: 0,
    category_id: null,
    is_featured: false,
    is_offer: false,
    highlight_new_arrivals: false,
    flash_offer_price: 0,
    flash_offer_ends_at: null,
    image_path: '',
    image_urls: [],
  };
  const basePrice = toDecimalString(source.price);
  const fallbackListPrice = initialData ? basePrice : '';
  return {
    name: source.name,
    sku: source.sku,
    barcode: source.barcode || '',
    imeis: Array.isArray(source.imeis) ? source.imeis.join('\n') : '',
    price: basePrice,
    price_list_1: source.price_list_1 ? toDecimalString(source.price_list_1) : fallbackListPrice,
    price_list_2: source.price_list_2 ? toDecimalString(source.price_list_2) : fallbackListPrice,
    cost: toDecimalString(source.cost),
    stock: toIntegerString(source.stock),
    category_id: source.category_id ? String(source.category_id) : '',
    margin: formatMargin(calculateMargin(source.cost, source.price)),
    is_featured: source.is_featured,
    is_offer: source.is_offer,
    is_bundle: Boolean(source.is_bundle),
    highlight_new_arrivals: source.highlight_new_arrivals,
    flash_offer_price: source.flash_offer_price ? toDecimalString(source.flash_offer_price) : '',
    flash_offer_ends_at: toDateTimeLocalInput(source.flash_offer_ends_at),
  };
};

export function ProductForm({
  initialData,
  title,
  onSubmit,
  categories = [],
  selectableProducts = [],
  canViewProfitMetrics = true,
}: ProductFormProps) {
  const router = useRouter();
  const [formData, setFormData] = useState<ProductFormState>(() => buildInitialState(initialData));
  const [imageInputs, setImageInputs] = useState<string[]>(() => buildInitialImages(initialData));
  const [selectedImageFiles, setSelectedImageFiles] = useState<Array<File | null>>(() =>
    Array.from({ length: MAX_PRODUCT_IMAGES }, () => null)
  );
  const [localPreviewUrls, setLocalPreviewUrls] = useState<Array<string | null>>(() =>
    Array.from({ length: MAX_PRODUCT_IMAGES }, () => null)
  );
  const [uploadingSlots, setUploadingSlots] = useState<boolean[]>(() =>
    Array.from({ length: MAX_PRODUCT_IMAGES }, () => false)
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [bundleSearch, setBundleSearch] = useState('');
  const [bundleItems, setBundleItems] = useState<Array<{ product_id: number; quantity: string; name: string; sku: string }>>(
    () =>
      Array.isArray(initialData?.bundle_items)
        ? initialData.bundle_items.map((item) => ({
            product_id: Number(item.product_id),
            quantity: toIntegerString(Number(item.quantity || 1)),
            name: String(item.name || `Producto ${item.product_id}`),
            sku: String(item.sku || ''),
          }))
        : []
  );
  const previewUrlsRef = useRef<Array<string | null>>([]);
  const lastBasePriceRef = useRef(formData.price);

  useEffect(() => {
    previewUrlsRef.current = localPreviewUrls;
  }, [localPreviewUrls]);

  useEffect(() => {
    return () => {
      for (const url of previewUrlsRef.current) {
        if (url) {
          URL.revokeObjectURL(url);
        }
      }
    };
  }, []);

  const isUploadingAnyImage = uploadingSlots.some(Boolean);
  const selectedCategory = categories.find((category) => String(category.id) === formData.category_id);
  const isCellphonesCategory = !formData.is_bundle && normalizeCategoryName(selectedCategory?.name || '') === 'celulares';
  const parsedStock = parseInteger(formData.stock);
  const selectableBundleProducts = selectableProducts.filter((product) => {
    if (product.id === initialData?.id) return false;
    if (product.is_bundle) return false;
    if (bundleItems.some((item) => item.product_id === product.id)) return false;
    const query = normalizeCategoryName(bundleSearch);
    if (!query) return true;
    return normalizeCategoryName(`${product.name} ${product.sku}`).includes(query);
  });

  const handleBarcodeKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') {
      return;
    }
    event.preventDefault();
  };

  const handleFieldChange = (name: keyof ProductFormState, value: string | boolean) => {
    setFormData((prev) => ({ ...prev, [name]: value } as ProductFormState));
  };

  const handleNumericChange = (name: 'price' | 'price_list_1' | 'price_list_2' | 'cost' | 'stock' | 'flash_offer_price', rawValue: string) => {
    setFormData((prev) => {
      if (name === 'stock') {
        return {
          ...prev,
          stock: sanitizeIntegerInput(rawValue),
        };
      }

      const nextValue = sanitizeDecimalInput(rawValue);
      const next = {
        ...prev,
        [name]: nextValue,
      } as ProductFormState;

      if (name === 'price') {
        const previousBasePrice = lastBasePriceRef.current;
        const shouldSyncList1 = !prev.price_list_1.trim() || prev.price_list_1 === previousBasePrice;
        const shouldSyncList2 = !prev.price_list_2.trim() || prev.price_list_2 === previousBasePrice;
        if (shouldSyncList1) {
          next.price_list_1 = nextValue;
        }
        if (shouldSyncList2) {
          next.price_list_2 = nextValue;
        }
        lastBasePriceRef.current = nextValue;
      }

      if (name === 'flash_offer_price') {
        return next;
      }

      const price = parseDecimal(name === 'price' ? nextValue : prev.price);
      const cost = parseDecimal(name === 'cost' ? nextValue : prev.cost);
      if (Number.isFinite(price) && Number.isFinite(cost)) {
        next.margin = formatMargin(calculateMargin(cost, price));
      }
      return next;
    });
  };

  const handleMarginChange = (rawValue: string) => {
    setFormData((prev) => {
      const nextMargin = sanitizeDecimalInput(rawValue);
      const cost = parseDecimal(prev.cost);
      const margin = parseDecimal(nextMargin);
      const next = {
        ...prev,
        margin: nextMargin,
      };
      if (Number.isFinite(cost) && cost >= 0 && Number.isFinite(margin)) {
        next.price = toDecimalString(Number((cost * (1 + margin / 100)).toFixed(2)));
      }
      return next;
    });
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value, type, checked } = e.target;
    if (type === 'checkbox') {
      handleFieldChange(name as keyof ProductFormState, checked);
      return;
    }
    if (name === 'price' || name === 'price_list_1' || name === 'price_list_2' || name === 'cost' || name === 'stock' || name === 'flash_offer_price') {
      handleNumericChange(name, value);
      return;
    }
    if (name === 'margin') {
      handleMarginChange(value);
      return;
    }
    handleFieldChange(name as keyof ProductFormState, value);
  };

  const handleImageUrlChange = (index: number, value: string) => {
    setImageInputs((prev) => prev.map((current, currentIndex) => (currentIndex === index ? value : current)));
  };

  const handleImageUpload = (index: number, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setError('');
    setSelectedImageFiles((prev) => prev.map((current, currentIndex) => (currentIndex === index ? file : current)));
    setLocalPreviewUrls((prev) =>
      prev.map((current, currentIndex) => {
        if (currentIndex !== index) {
          return current;
        }
        if (current) {
          URL.revokeObjectURL(current);
        }
        return URL.createObjectURL(file);
      })
    );
    e.target.value = '';
  };

  const clearImageSlot = (index: number) => {
    setSelectedImageFiles((prev) => prev.map((current, currentIndex) => (currentIndex === index ? null : current)));
    setLocalPreviewUrls((prev) =>
      prev.map((current, currentIndex) => {
        if (currentIndex !== index) {
          return current;
        }
        if (current) {
          URL.revokeObjectURL(current);
        }
        return null;
      })
    );
    setImageInputs((prev) => prev.map((current, currentIndex) => (currentIndex === index ? '' : current)));
  };

  const uploadSelectedImage = async (index: number) => {
    const selectedFile = selectedImageFiles[index];
    if (!selectedFile) {
      return imageInputs[index].trim();
    }

    setUploadingSlots((prev) => prev.map((current, currentIndex) => (currentIndex === index ? true : current)));
    try {
      const body = new FormData();
      body.append('file', selectedFile);
      body.append('product_name', formData.name || selectedFile.name);

      const res = await fetchApiResponse('/admin/uploads/product-image', {
        method: 'POST',
        body,
      });

      if (!res.ok) {
        const payload = await res.json().catch(async () => {
          const detail = await res.text().catch(() => '');
          return { detail };
        });
        throw new Error(payload.detail || 'No se pudo subir la imagen');
      }

      const payload = await res.json();
      const uploadedUrl = String(payload.url || payload.path || '').trim();
      setImageInputs((prev) => prev.map((current, currentIndex) => (currentIndex === index ? uploadedUrl : current)));
      setSelectedImageFiles((prev) => prev.map((current, currentIndex) => (currentIndex === index ? null : current)));
      setLocalPreviewUrls((prev) =>
        prev.map((current, currentIndex) => {
          if (currentIndex !== index) {
            return current;
          }
          if (current) {
            URL.revokeObjectURL(current);
          }
          return null;
        })
      );
      return uploadedUrl;
    } catch (error) {
      throw new Error(getFriendlyApiError(error, 'No se pudo subir la imagen'));
    } finally {
      setUploadingSlots((prev) => prev.map((current, currentIndex) => (currentIndex === index ? false : current)));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const price = parseDecimal(formData.price);
      const priceList1 = parseDecimal(formData.price_list_1);
      const priceList2 = parseDecimal(formData.price_list_2);
      const cost = parseDecimal(formData.cost);
      const stock = parseInteger(formData.stock);
      const flashOfferPrice = parseDecimal(formData.flash_offer_price);

      if (!formData.name.trim()) {
        throw new Error('Nombre requerido');
      }
      if (!formData.sku.trim()) {
        throw new Error('SKU requerido');
      }
      if (!Number.isFinite(price) || price < 0) {
        throw new Error('Precio invalido');
      }
      if (!Number.isFinite(cost) || cost < 0) {
        throw new Error('Costo no puede ser negativo');
      }
      if (formData.price_list_1.trim() && (!Number.isFinite(priceList1) || priceList1 < 0)) {
        throw new Error('Lista 1 invalida');
      }
      if (formData.price_list_2.trim() && (!Number.isFinite(priceList2) || priceList2 < 0)) {
        throw new Error('Lista 2 invalida');
      }
      if (!Number.isFinite(stock) || stock < 0) {
        throw new Error('Stock no puede ser negativo');
      }
      if (formData.is_bundle && bundleItems.length === 0) {
        throw new Error('Agrega al menos un producto al combo');
      }
      const imeis = parseImeiValues(formData.imeis);
      if (isCellphonesCategory && stock > 0 && imeis.length === 0) {
        throw new Error('Para guardar un celular tenes que cargar al menos un IMEI');
      }
      if (isCellphonesCategory && imeis.length < stock) {
        throw new Error('Carga todos los IMEIs disponibles del equipo antes de guardar');
      }
      if (isCellphonesCategory && imeis.length > stock) {
        throw new Error('No podes cargar mas IMEIs que stock disponible');
      }
      if (formData.flash_offer_price.trim() && (!Number.isFinite(flashOfferPrice) || flashOfferPrice <= 0)) {
        throw new Error('El precio de oferta relampago debe ser mayor a 0');
      }
      if (formData.flash_offer_price.trim() && !formData.flash_offer_ends_at.trim()) {
        throw new Error('Indica hasta cuando dura la oferta relampago');
      }

      const uploadedImages: string[] = [];
      for (let index = 0; index < MAX_PRODUCT_IMAGES; index += 1) {
        const finalUrl = await uploadSelectedImage(index);
        if (finalUrl.trim()) {
          uploadedImages.push(finalUrl.trim());
        }
      }

      const finalImages = dedupeImageValues(uploadedImages);

      await onSubmit({
        name: formData.name.trim(),
        sku: formData.sku.trim(),
        barcode: formData.barcode.trim() || null,
        imeis,
        price,
        price_list_1: formData.price_list_1.trim() ? priceList1 : 0,
        price_list_2: formData.price_list_2.trim() ? priceList2 : 0,
        cost,
        stock: formData.is_bundle ? 0 : stock,
        category_id: formData.category_id ? Number(formData.category_id) : null,
        is_featured: formData.is_featured,
        is_offer: formData.is_offer,
        is_bundle: formData.is_bundle,
        bundle_items: formData.is_bundle
          ? bundleItems.map((item) => ({
              product_id: item.product_id,
              quantity: Math.max(1, parseInteger(item.quantity) || 1),
            }))
          : [],
        highlight_new_arrivals: formData.highlight_new_arrivals,
        flash_offer_price: formData.flash_offer_price.trim() ? flashOfferPrice : 0,
        flash_offer_ends_at: formData.flash_offer_ends_at.trim() || null,
        image_path: finalImages[0] || '',
        image_urls: finalImages.slice(1),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error guardando producto');
    } finally {
      setLoading(false);
    }
  };

  const marginPreview = calculateMargin(parseDecimal(formData.cost), parseDecimal(formData.price));

  return (
    <div className={styles.container}>
      <h1>{title}</h1>

      {error && <div className={styles.error}>{error}</div>}

      <form onSubmit={handleSubmit} className={styles.form}>
        <div className={styles.field}>
          <label htmlFor="name">Nombre *</label>
          <input
            id="name"
            type="text"
            name="name"
            value={formData.name}
            onChange={handleChange}
            placeholder="Ej: Cable USB-C"
            required
            disabled={loading}
            className={styles.input}
          />
        </div>

        <div className={styles.field}>
          <label htmlFor="sku">SKU *</label>
          <input
            id="sku"
            type="text"
            name="sku"
            value={formData.sku}
            onChange={handleChange}
            placeholder="Ej: CABLE-USB-C-001"
            required
            disabled={loading}
            className={styles.input}
          />
        </div>

        <div className={styles.field}>
          <label htmlFor="barcode">Codigo de barras</label>
          <input
            id="barcode"
            type="text"
            name="barcode"
            value={formData.barcode}
            onChange={handleChange}
            onKeyDown={handleBarcodeKeyDown}
            placeholder="Ej: 7791234567890"
            disabled={loading}
            className={styles.input}
          />
        </div>

        <div className={styles.field}>
          <label htmlFor="category_id">Rubro</label>
          <select
            id="category_id"
            name="category_id"
            value={formData.category_id}
            onChange={(e) => handleFieldChange('category_id', e.target.value)}
            disabled={loading}
            className={styles.input}
          >
            <option value="">Sin rubro</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </div>

        {isCellphonesCategory ? (
          <div className={styles.field}>
            <label htmlFor="imeis">IMEIs *</label>
            <textarea
              id="imeis"
              name="imeis"
              value={formData.imeis}
              onChange={(e) => handleFieldChange('imeis', e.target.value)}
              placeholder={'Un IMEI por linea\nEj: 356789012345678'}
              disabled={loading}
              className={styles.textarea}
              rows={6}
              required={isCellphonesCategory && parsedStock > 0}
            />
            <p className={styles.help}>
              Solo para celulares. Carga un IMEI por linea. Si el stock es {Math.max(0, Number.isFinite(parsedStock) ? parsedStock : 0)}, tenes que ingresar esa misma cantidad para guardarlo.
            </p>
          </div>
        ) : null}

        <div className={styles.fieldRowTriple}>
          <div className={styles.field}>
            <label htmlFor="price">Precio ($) *</label>
            <input
              id="price"
              type="text"
              inputMode="decimal"
              name="price"
              value={formData.price}
              onChange={handleChange}
              required
              disabled={loading}
              className={styles.input}
            />
          </div>

          <div className={styles.field}>
            <label htmlFor="price_list_1">Lista 1 web ($)</label>
            <input
              id="price_list_1"
              type="text"
              inputMode="decimal"
              name="price_list_1"
              value={formData.price_list_1}
              onChange={handleChange}
              disabled={loading}
              className={styles.input}
              placeholder="Si queda vacio usa el precio base"
            />
          </div>

          <div className={styles.field}>
            <label htmlFor="price_list_2">Lista 2 ($)</label>
            <input
              id="price_list_2"
              type="text"
              inputMode="decimal"
              name="price_list_2"
              value={formData.price_list_2}
              onChange={handleChange}
              disabled={loading}
              className={styles.input}
              placeholder="Opcional"
            />
          </div>
        </div>

        <div className={styles.fieldRowTriple}>
          <div className={styles.field}>
            <label htmlFor="cost">Costo ($)</label>
            <input
              id="cost"
              type="text"
              inputMode="decimal"
              name="cost"
              value={formData.cost}
              onChange={handleChange}
              disabled={loading}
              className={styles.input}
            />
          </div>

          <div className={styles.field}>
            <label htmlFor="stock">Cantidad stock</label>
            <input
              id="stock"
              type="text"
              inputMode="numeric"
              name="stock"
              value={formData.is_bundle ? '0' : formData.stock}
              onChange={handleChange}
              disabled={loading || formData.is_bundle}
              className={styles.input}
            />
          </div>
        </div>

        {canViewProfitMetrics ? (
          <div className={styles.fieldRow}>
            <div className={styles.field}>
              <label htmlFor="margin">Margen (%)</label>
              <input
                id="margin"
                type="text"
                inputMode="decimal"
                name="margin"
                value={formData.margin}
                onChange={handleChange}
                disabled={loading}
                className={styles.input}
              />
              <p className={styles.help}>Si cambias el margen, se recalcula el precio de venta.</p>
            </div>

            <div className={styles.summaryCard}>
              <span className={styles.summaryLabel}>Margen actual</span>
              <strong className={styles.summaryValue}>{formatMargin(marginPreview)}%</strong>
              <p className={styles.help}>Calculado como `(precio - costo) / costo`.</p>
            </div>
          </div>
        ) : null}

        <div className={styles.summaryCard}>
          <span className={styles.summaryLabel}>Precio visible en web</span>
          <strong className={styles.summaryValue}>
            {(() => {
              const flash = parseDecimal(formData.flash_offer_price);
              const list1 = parseDecimal(formData.price_list_1);
              const base = parseDecimal(formData.price);
              const visible =
                formData.flash_offer_price.trim() && Number.isFinite(flash) && flash > 0
                  ? flash
                  : formData.price_list_1.trim() && Number.isFinite(list1) && list1 > 0
                    ? list1
                    : base;
              return Number.isFinite(visible) ? visible.toLocaleString('es-AR', { style: 'currency', currency: 'ARS' }) : '$0';
            })()}
          </strong>
          <p className={styles.help}>Prioridad: relampago, lista 1, precio base.</p>
        </div>

        <div className={styles.field}>
          <label>Imagenes del producto</label>
          <div className={styles.imageSlots}>
            {imageInputs.map((value, index) => {
              const previewUrl = localPreviewUrls[index] || resolveImageUrl(value, getApiBaseUrl());
              const hasContent = Boolean(value.trim() || selectedImageFiles[index]);
              return (
                <div key={`image-slot-${index}`} className={styles.imageSlot}>
                  <div className={styles.imageSlotHeader}>
                    <strong>{index === 0 ? 'Imagen 1 principal' : `Imagen ${index + 1}`}</strong>
                    {hasContent ? (
                      <button
                        type="button"
                        className={styles.btnClearImage}
                        onClick={() => clearImageSlot(index)}
                        disabled={loading || isUploadingAnyImage}
                      >
                        Limpiar
                      </button>
                    ) : null}
                  </div>
                  <div className={styles.imageUpload}>
                    {previewUrl ? (
                      <div className={styles.preview}>
                        <img src={previewUrl} alt={formData.name || `Imagen ${index + 1}`} />
                      </div>
                    ) : (
                      <div className={styles.previewPlaceholder}>Sin imagen</div>
                    )}
                    <input
                      id={`image_file_${index}`}
                      type="file"
                      accept="image/*"
                      onChange={(event) => handleImageUpload(index, event)}
                      disabled={loading || isUploadingAnyImage}
                      className={styles.fileInput}
                    />
                    <input
                      type="text"
                      value={value}
                      onChange={(event) => handleImageUrlChange(index, event.target.value)}
                      placeholder={`https://.../foto-${index + 1}.jpg`}
                      disabled={loading || isUploadingAnyImage}
                      className={styles.input}
                    />
                    <p className={styles.help}>
                      Podes subir un archivo o pegar una URL publica.
                    </p>
                    {selectedImageFiles[index] ? (
                      <p className={styles.help}>Lista para guardar: {selectedImageFiles[index]?.name}</p>
                    ) : null}
                    {uploadingSlots[index] ? <p className={styles.help}>Subiendo imagen...</p> : null}
                  </div>
                </div>
              );
            })}
          </div>
          <p className={styles.help}>Cada producto admite hasta 3 imagenes.</p>
        </div>

        <div className={styles.checkboxGroup}>
          <label className={styles.checkbox}>
            <input
              type="checkbox"
              name="is_bundle"
              checked={formData.is_bundle}
              onChange={handleChange}
              disabled={loading}
            />
            <span>Vender como combo</span>
          </label>

          <label className={styles.checkbox}>
            <input
              type="checkbox"
              name="is_featured"
              checked={formData.is_featured}
              onChange={handleChange}
              disabled={loading}
            />
            <span>Destacar en seccion destacados</span>
          </label>

          <label className={styles.checkbox}>
            <input
              type="checkbox"
              name="is_offer"
              checked={formData.is_offer}
              onChange={handleChange}
              disabled={loading}
            />
            <span>Es una oferta especial</span>
          </label>

          <label className={styles.checkbox}>
            <input
              type="checkbox"
              name="highlight_new_arrivals"
              checked={formData.highlight_new_arrivals}
              onChange={handleChange}
              disabled={loading}
            />
            <span>Mostrar primero en Ultimos ingresos</span>
          </label>
        </div>

        {formData.is_bundle ? (
          <div className={styles.bundleBox}>
            <div>
              <strong>Componentes del combo</strong>
              <p className={styles.help}>La web lo muestra como un solo producto y el comprobante sale con este detalle.</p>
            </div>
            <div className={styles.field}>
              <label htmlFor="bundle_search">Buscar producto</label>
              <input
                id="bundle_search"
                type="text"
                value={bundleSearch}
                onChange={(event) => setBundleSearch(event.target.value)}
                disabled={loading}
                className={styles.input}
                placeholder="Buscar por nombre o SKU"
              />
            </div>
            {selectableBundleProducts.length > 0 ? (
              <div className={styles.bundleSearchResults}>
                {selectableBundleProducts.slice(0, 12).map((product) => (
                  <button
                    key={product.id}
                    type="button"
                    className={styles.bundleAddButton}
                    onClick={() => {
                      setBundleItems((prev) => [
                        ...prev,
                        { product_id: product.id, quantity: '1', name: product.name, sku: product.sku },
                      ]);
                      setBundleSearch('');
                    }}
                    disabled={loading}
                  >
                    <span>{product.name}</span>
                    <small>{product.sku || `#${product.id}`}</small>
                  </button>
                ))}
              </div>
            ) : null}
            {bundleItems.length > 0 ? (
              <div className={styles.bundleItems}>
                {bundleItems.map((item, index) => (
                  <div key={`${item.product_id}-${index}`} className={styles.bundleItemRow}>
                    <div>
                      <strong>{item.name}</strong>
                      <p className={styles.help}>{item.sku || `#${item.product_id}`}</p>
                    </div>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={item.quantity}
                      onChange={(event) =>
                        setBundleItems((prev) =>
                          prev.map((current, currentIndex) =>
                            currentIndex === index
                              ? { ...current, quantity: sanitizeIntegerInput(event.target.value) }
                              : current
                          )
                        )
                      }
                      disabled={loading}
                      className={styles.bundleQtyInput}
                    />
                    <button
                      type="button"
                      className={styles.btnClearImage}
                      onClick={() => setBundleItems((prev) => prev.filter((_, currentIndex) => currentIndex !== index))}
                      disabled={loading}
                    >
                      Quitar
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className={styles.help}>Todavia no agregaste productos al combo.</p>
            )}
            <p className={styles.help}>El stock del combo se calcula automaticamente segun sus componentes.</p>
          </div>
        ) : null}

        <div className={styles.flashOfferBox}>
          <div>
            <strong>Oferta relampago</strong>
            <p className={styles.help}>Si completas precio y vencimiento, se muestra con contador en la pagina principal.</p>
          </div>
          <div className={styles.fieldRow}>
            <div className={styles.field}>
              <label htmlFor="flash_offer_price">Precio relampago ($)</label>
              <input
                id="flash_offer_price"
                type="text"
                inputMode="decimal"
                name="flash_offer_price"
                value={formData.flash_offer_price}
                onChange={handleChange}
                disabled={loading}
                className={styles.input}
                placeholder="Ej: 9999"
              />
            </div>
            <div className={styles.field}>
              <label htmlFor="flash_offer_ends_at">Finaliza</label>
              <input
                id="flash_offer_ends_at"
                type="datetime-local"
                name="flash_offer_ends_at"
                value={formData.flash_offer_ends_at}
                onChange={handleChange}
                disabled={loading}
                className={styles.input}
              />
            </div>
          </div>
          <button
            type="button"
            className={styles.btnClearImage}
            onClick={() => {
              handleFieldChange('flash_offer_price', '');
              handleFieldChange('flash_offer_ends_at', '');
            }}
            disabled={loading}
          >
            Quitar oferta relampago
          </button>
        </div>

        <div className={styles.actions}>
          <button type="submit" disabled={loading || isUploadingAnyImage} className={styles.btnSubmit}>
            {isUploadingAnyImage ? 'Subiendo imagen...' : loading ? 'Guardando...' : 'Guardar Producto'}
          </button>
          <button
            type="button"
            onClick={() => router.push('/admin/productos')}
            disabled={loading || isUploadingAnyImage}
            className={styles.btnCancel}
          >
            Cancelar
          </button>
        </div>
      </form>
    </div>
  );
}
