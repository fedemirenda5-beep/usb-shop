'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import styles from './ProductForm.module.css';

interface ProductFormData {
  name: string;
  sku: string;
  price: number;
  cost: number;
  stock: number;
  is_featured: boolean;
  is_offer: boolean;
  image_path: string;
  image_urls_text: string;
}

interface ProductFormProps {
  initialData?: ProductFormData & { id?: number };
  title: string;
  onSubmit: (data: ProductFormData & { image_urls: string[] }) => Promise<void>;
}

export function ProductForm({ initialData, title, onSubmit }: ProductFormProps) {
  const router = useRouter();
  const [formData, setFormData] = useState<ProductFormData>(
    initialData || {
      name: '',
      sku: '',
      price: 0,
      cost: 0,
      stock: 0,
      is_featured: false,
      is_offer: false,
      image_path: '',
      image_urls_text: '',
    }
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value, type, checked } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]:
        type === 'checkbox'
          ? checked
          : name === 'price' || name === 'cost' || name === 'stock'
          ? Number(value)
          : value,
    }));
  };

  const handleTextAreaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: value,
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
      if (formData.cost < 0) {
        throw new Error('Costo no puede ser negativo');
      }
      if (formData.stock < 0) {
        throw new Error('Stock no puede ser negativo');
      }

      await onSubmit({
        ...formData,
        image_path: formData.image_path.trim(),
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
        <div className={styles.fieldRowTriple}>
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

          <div className={styles.field}>
            <label htmlFor="cost">Costo ($)</label>
            <input
              id="cost"
              type="number"
              name="cost"
              value={formData.cost}
              onChange={handleChange}
              step="0.01"
              min="0"
              disabled={loading}
              className={styles.input}
            />
          </div>

          <div className={styles.field}>
            <label htmlFor="stock">Cantidad stock</label>
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

        <div className={styles.field}>
          <label htmlFor="image_path">Imagen principal</label>
          <input
            id="image_path"
            type="url"
            name="image_path"
            value={formData.image_path}
            onChange={handleChange}
            placeholder="https://.../foto-principal.jpg"
            disabled={loading}
            className={styles.input}
          />
          <p className={styles.help}>Usa una URL publica. No sirve una ruta local como C:\...</p>
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
