'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getApiBaseUrl, loadRuntimeConfig, resolveImageUrl } from '@/lib/api';
import styles from './ProductForm.module.css';

interface ProductFormData {
  name: string;
  sku: string;
  price: number;
  cost: number;
  stock: number;
  category_id?: number | null;
  is_featured: boolean;
  is_offer: boolean;
  image_path: string;
  image_urls_text: string;
}

interface ProductFormState {
  name: string;
  sku: string;
  price: string;
  cost: string;
  stock: string;
  category_id: string;
  margin: string;
  is_featured: boolean;
  is_offer: boolean;
  image_path: string;
  image_urls_text: string;
}

interface CategoryOption {
  id: number;
  name: string;
}

interface ProductFormProps {
  initialData?: ProductFormData & { id?: number };
  title: string;
  onSubmit: (data: ProductFormData & { image_urls: string[] }) => Promise<void>;
  categories?: CategoryOption[];
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

const buildInitialState = (initialData?: ProductFormData & { id?: number }): ProductFormState => {
  const source = initialData || {
    name: '',
    sku: '',
    price: 0,
    cost: 0,
    stock: 0,
    category_id: null,
    is_featured: false,
    is_offer: false,
    image_path: '',
    image_urls_text: '',
  };
  return {
    name: source.name,
    sku: source.sku,
    price: toDecimalString(source.price),
    cost: toDecimalString(source.cost),
    stock: toIntegerString(source.stock),
    category_id: source.category_id ? String(source.category_id) : '',
    margin: formatMargin(calculateMargin(source.cost, source.price)),
    is_featured: source.is_featured,
    is_offer: source.is_offer,
    image_path: source.image_path,
    image_urls_text: source.image_urls_text,
  };
};

export function ProductForm({ initialData, title, onSubmit, categories = [] }: ProductFormProps) {
  const router = useRouter();
  const [formData, setFormData] = useState<ProductFormState>(() => buildInitialState(initialData));
  const [loading, setLoading] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [selectedImageFile, setSelectedImageFile] = useState<File | null>(null);
  const [localPreviewUrl, setLocalPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState('');

  const handleFieldChange = (name: keyof ProductFormState, value: string | boolean) => {
    setFormData((prev) => {
      if (typeof value === 'boolean') {
        return { ...prev, [name]: value };
      }
      return { ...prev, [name]: value };
    });
  };

  const handleNumericChange = (name: 'price' | 'cost' | 'stock', rawValue: string) => {
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
    if (name === 'price' || name === 'cost' || name === 'stock') {
      handleNumericChange(name, value);
      return;
    }
    if (name === 'margin') {
      handleMarginChange(value);
      return;
    }
    handleFieldChange(name as keyof ProductFormState, value);
  };

  const handleTextAreaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    handleFieldChange(name as keyof ProductFormState, value);
  };

  useEffect(() => {
    if (!selectedImageFile) {
      setLocalPreviewUrl(null);
      return;
    }
    const objectUrl = URL.createObjectURL(selectedImageFile);
    setLocalPreviewUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [selectedImageFile]);

  const uploadSelectedImage = async () => {
    if (!selectedImageFile) {
      return formData.image_path.trim();
    }

    setUploadingImage(true);
    try {
      await loadRuntimeConfig();
      const body = new FormData();
      body.append('file', selectedImageFile);
      body.append('product_name', formData.name || selectedImageFile.name);

      const res = await fetch(`${getApiBaseUrl()}/admin/uploads/product-image`, {
        method: 'POST',
        credentials: 'include',
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
      setFormData((prev) => ({
        ...prev,
        image_path: uploadedUrl,
      }));
      setSelectedImageFile(null);
      return uploadedUrl;
    } finally {
      setUploadingImage(false);
    }
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setError('');
    setSelectedImageFile(file);
    e.target.value = '';
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const price = parseDecimal(formData.price);
      const cost = parseDecimal(formData.cost);
      const stock = parseInteger(formData.stock);

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
      if (!Number.isFinite(stock) || stock < 0) {
        throw new Error('Stock no puede ser negativo');
      }

      const finalImagePath = await uploadSelectedImage();

      await onSubmit({
        name: formData.name.trim(),
        sku: formData.sku.trim(),
        price,
        cost,
        stock,
        category_id: formData.category_id ? Number(formData.category_id) : null,
        is_featured: formData.is_featured,
        is_offer: formData.is_offer,
        image_path: finalImagePath,
        image_urls_text: formData.image_urls_text,
        image_urls: formData.image_urls_text
          .split(/\r?\n/)
          .map((value) => value.trim())
          .filter(Boolean),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error guardando producto');
    } finally {
      setLoading(false);
    }
  };

  const marginPreview = calculateMargin(parseDecimal(formData.cost), parseDecimal(formData.price));
  const previewUrl = localPreviewUrl || resolveImageUrl(formData.image_path, getApiBaseUrl());

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
              value={formData.stock}
              onChange={handleChange}
              disabled={loading}
              className={styles.input}
            />
          </div>
        </div>

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

        <div className={styles.field}>
          <label htmlFor="image_path">Imagen principal</label>
          <div className={styles.imageUpload}>
            {previewUrl ? (
              <div className={styles.preview}>
                <img src={previewUrl} alt={formData.name || 'Vista previa'} />
              </div>
            ) : null}
            <input
              id="image_file"
              type="file"
              accept="image/*"
              onChange={handleImageUpload}
              disabled={loading || uploadingImage}
              className={styles.fileInput}
            />
            <p className={styles.help}>
              Elegi la foto desde tu PC. Se sube a Supabase automaticamente al guardar el producto.
            </p>
            {selectedImageFile ? <p className={styles.help}>Imagen lista para guardar: {selectedImageFile.name}</p> : null}
            {uploadingImage ? <p className={styles.help}>Subiendo imagen...</p> : null}
          </div>
          <input
            id="image_path"
            type="text"
            name="image_path"
            value={formData.image_path}
            onChange={handleChange}
            placeholder="https://.../foto-principal.jpg"
            disabled={loading || uploadingImage}
            className={styles.input}
          />
          <p className={styles.help}>Tambien podes pegar una URL publica si ya la tenes.</p>
        </div>

        <div className={styles.field}>
          <label htmlFor="image_urls_text">Imagenes adicionales</label>
          <textarea
            id="image_urls_text"
            name="image_urls_text"
            value={formData.image_urls_text}
            onChange={handleTextAreaChange}
            placeholder={'https://.../foto-2.jpg\nhttps://.../foto-3.jpg'}
            disabled={loading}
            className={styles.textarea}
            rows={4}
          />
          <p className={styles.help}>Una URL por linea.</p>
        </div>

        <div className={styles.checkboxGroup}>
          <label className={styles.checkbox}>
            <input
              type="checkbox"
              name="is_featured"
              checked={formData.is_featured}
              onChange={handleChange}
              disabled={loading}
            />
            <span>Destacar en página principal</span>
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
        </div>

        <div className={styles.actions}>
          <button type="submit" disabled={loading || uploadingImage} className={styles.btnSubmit}>
            {uploadingImage ? 'Subiendo imagen...' : loading ? 'Guardando...' : 'Guardar Producto'}
          </button>
          <button
            type="button"
            onClick={() => router.push('/admin/productos')}
            disabled={loading || uploadingImage}
            className={styles.btnCancel}
          >
            Cancelar
          </button>
        </div>
      </form>
    </div>
  );
}
