'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import styles from './ProductForm.module.css';

interface ProductFormData {
  name: string;
  sku: string;
  price: number;
  stock: number;
  is_featured: boolean;
  is_offer: boolean;
  image?: File | null;
}

interface ProductFormProps {
  initialData?: ProductFormData & { id?: number };
  title: string;
  onSubmit: (data: ProductFormData) => Promise<void>;
}

import { getApiBaseUrl } from '@/lib/api';

const API_BASE = getApiBaseUrl();

export function ProductForm({ initialData, title, onSubmit }: ProductFormProps) {
  const router = useRouter();
  const [formData, setFormData] = useState<ProductFormData>(
    initialData || {
      name: '',
      sku: '',
      price: 0,
      stock: 0,
      is_featured: false,
      is_offer: false,
    }
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value, type, checked, files } = e.target;
    
    if (type === 'file' && files && files[0]) {
      const file = files[0];
      setSelectedFile(file);
      setPreviewUrl(URL.createObjectURL(file));
      return;
    }

    setFormData((prev) => ({
      ...prev,
      [name]:
        type === 'checkbox'
          ? checked
          : name === 'price' || name === 'stock'
          ? Number(value)
          : value,
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      if (!formData.name.trim()) {
        throw new Error('Nombre requerido');
      }
      if (!formData.sku.trim()) {
        throw new Error('SKU requerido');
      }
      if (formData.price < 0) {
        throw new Error('Precio no puede ser negativo');
      }
      if (formData.stock < 0) {
        throw new Error('Stock no puede ser negativo');
      }

      await onSubmit({ ...formData, image: selectedFile });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error guardando producto');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.container}>
      <h1>{title}</h1>

      {error && <div className={styles.error}>{error}</div>}

      <form onSubmit={handleSubmit} className={styles.form}>
        {/* Nombre */}
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

        {/* SKU */}
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

        {/* Precio */}
        <div className={styles.fieldRow}>
          <div className={styles.field}>
            <label htmlFor="price">Precio ($) *</label>
            <input
              id="price"
              type="number"
              name="price"
              value={formData.price}
              onChange={handleChange}
              step="0.01"
              min="0"
              required
              disabled={loading}
              className={styles.input}
            />
          </div>

          {/* Stock */}
          <div className={styles.field}>
            <label htmlFor="stock">Stock</label>
            <input
              id="stock"
              type="number"
              name="stock"
              value={formData.stock}
              onChange={handleChange}
              min="0"
              disabled={loading}
              className={styles.input}
            />
          </div>
        </div>

        {/* Imagen */}
        <div className={styles.field}>
          <label htmlFor="image">Imagen del Producto</label>
          <div className={styles.imageUpload}>
            {previewUrl && (
              <div className={styles.preview}>
                <img src={previewUrl} alt="Vista previa" />
              </div>
            )}
            <input
              id="image"
              type="file"
              name="image"
              accept="image/*"
              onChange={handleChange}
              disabled={loading}
              className={styles.fileInput}
            />
          </div>
          <small className="help-text">JPG, PNG o WEBP. Se subirá a Supabase Storage.</small>
        </div>

        {/* Checkboxes */}
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

        {/* Buttons */}
        <div className={styles.actions}>
          <button
            type="submit"
            disabled={loading}
            className={styles.btnSubmit}
          >
            {loading ? 'Guardando...' : 'Guardar Producto'}
          </button>
          <button
            type="button"
            onClick={() => router.push('/admin/productos')}
            disabled={loading}
            className={styles.btnCancel}
          >
            Cancelar
          </button>
        </div>
      </form>
    </div>
  );
}
