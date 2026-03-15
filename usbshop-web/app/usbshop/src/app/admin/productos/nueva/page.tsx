'use client';

import { useRouter } from 'next/navigation';
import { getApiBaseUrl, loadRuntimeConfig } from '@/lib/api';
import { ProductForm } from '../components/ProductForm';

export default function NuevaProductoPage() {
  const router = useRouter();

  const handleSubmit = async (data: any) => {
    await loadRuntimeConfig();
    const res = await fetch(`${getApiBaseUrl()}/admin/products`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });

    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.detail || 'Error creando producto');
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
