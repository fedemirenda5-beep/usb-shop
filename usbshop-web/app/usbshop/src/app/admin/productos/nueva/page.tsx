'use client';

import { useRouter } from 'next/navigation';
import { ProductForm } from '../components/ProductForm';

import { getApiBaseUrl } from '@/lib/api';

export default function NuevaProductoPage() {
  const API_BASE = getApiBaseUrl();
  const router = useRouter();

  const handleSubmit = async (data: any) => {
    // 1. Crear producto (sin imagen en el body JSON)
    const { image, ...productData } = data;
    
    const res = await fetch(`${API_BASE}/admin/products`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(productData),
    });

    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.detail || 'Error creando producto');
    }

    const newProduct = await res.json();
    const productId = newProduct.id;

    // 2. Si hay imagen, subirla al endpoint de imagen
    if (image && productId) {
      const formData = new FormData();
      formData.append('file', image);

      const imgRes = await fetch(`${API_BASE}/admin/products/${productId}/image`, {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });

      if (!imgRes.ok) {
        console.error('Error subiendo imagen, pero el producto fue creado.');
      }
    }

    // Redirect after success
    router.push('/admin/productos');
  };

  return (
    <ProductForm
      title="Crear Nuevo Producto"
      onSubmit={handleSubmit}
    />
  );
}
