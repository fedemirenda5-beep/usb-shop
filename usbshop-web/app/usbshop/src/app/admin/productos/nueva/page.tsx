'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAdminSession } from '@/hooks/useAdminSession';
import { fetchApiResponse, getFriendlyApiError } from '@/lib/api';
import { canViewProfitMetrics } from '../../adminPermissions';
import { ADMIN_LIMITS } from '../../adminConfig';
import { ProductForm } from '../components/ProductForm';

type ProductPayload = {
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
  bundle_items?: Array<{ product_id: number; quantity: number }>;
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
  const [products, setProducts] = useState<Array<{ id: number; name: string; sku: string; is_bundle?: boolean }>>([]);

  useEffect(() => {
    const loadReferences = async () => {
      const [categoriesRes, productsRes] = await Promise.all([
        fetchApiResponse('/admin/categories'),
        fetchApiResponse(`/admin/products?limit=${ADMIN_LIMITS.productsLargeList}&summary=true`),
      ]);
      if (categoriesRes.ok) {
        const categoriesData = await categoriesRes.json().catch(() => []);
        setCategories(Array.isArray(categoriesData) ? categoriesData : []);
      }
      if (productsRes.ok) {
        const productsData = await productsRes.json().catch(() => []);
        setProducts(Array.isArray(productsData) ? productsData : []);
      }
    };
    void loadReferences();
  }, []);

  const handleSubmit = async (data: ProductPayload) => {
    let res: Response;
    try {
      res = await fetchApiResponse('/admin/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
    } catch (error) {
      throw new Error(getFriendlyApiError(error, 'No se pudo conectar con la API para crear el producto'));
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
      selectableProducts={products}
      canViewProfitMetrics={canViewProfitMetrics(user?.role)}
    />
  );
}
