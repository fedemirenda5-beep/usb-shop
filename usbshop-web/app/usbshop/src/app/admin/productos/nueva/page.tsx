'use client';

import { useRouter } from 'next/navigation';
import { getApiBaseUrl, loadRuntimeConfig } from '@/lib/api';
import { ProductForm } from '../components/ProductForm';

export default function NuevaProductoPage() {
  const router = useRouter();

  const handleSubmit = async (data: any) => {
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
    router.push('/admin/productos');
  };

  return (
    <ProductForm
      title="Crear Nuevo Producto"
      onSubmit={handleSubmit}
    />
  );
}
