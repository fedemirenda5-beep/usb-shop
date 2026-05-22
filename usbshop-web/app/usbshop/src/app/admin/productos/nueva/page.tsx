'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAdminSession } from '@/hooks/useAdminSession';
import { getApiBaseUrl, loadRuntimeConfig } from '@/lib/api';
import { canViewProfitMetrics } from '../../adminPermissions';
import { ProductForm } from '../components/ProductForm';

type ProductPayload = {
  name: string;
  sku: string;
  price: number;
  price_list_1?: number | null;
  price_list_2?: number | null;
  cost: number;
  stock: number;
  category_id?: number | null;
  is_featured: boolean;
  is_offer: boolean;
  highlight_new_arrivals: boolean;
  flash_offer_price?: number | null;
  flash_offer_ends_at?: string | null;
  image_path: string;
  image_urls: string[];
};

export default function NuevaProductoPage() {
  const router = useRouter();
  const { user } = useAdminSession();
  const [categories, setCategories] = useState<Array<{ id: number; name: string }>>([]);

  useEffect(() => {
    const loadCategories = async () => {
      await loadRuntimeConfig();
      const res = await fetch(`${getApiBaseUrl()}/admin/categories`, {
        credentials: 'include',
      });
      if (!res.ok) return;
      const data = await res.json().catch(() => []);
      setCategories(Array.isArray(data) ? data : []);
    };
    void loadCategories();
  }, []);

  const handleSubmit = async (data: ProductPayload) => {
    await loadRuntimeConfig();
    let res: Response;
    try {
      res = await fetch(`${getApiBaseUrl()}/admin/products`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
    } catch {
      throw new Error('No se pudo conectar con la API para crear el producto');
    }

    if (!res.ok) {
      const error = await res.json().catch(async () => {
        const detail = await res.text().catch(() => '');
        return { detail };
      });
      throw new Error(error.detail || 'Error creando producto');
    }

    // Redirect after success
    router.replace('/admin/productos');
  };

  return (
    <ProductForm
      title="Crear Nuevo Producto"
      onSubmit={handleSubmit}
      categories={categories}
      canViewProfitMetrics={canViewProfitMetrics(user?.role)}
    />
  );
}
