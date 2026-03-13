'use client';

import { ProductForm } from '../components/ProductForm';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:8000';

export default function NuevaProductoPage() {
  const handleSubmit = async (data: any) => {
    const res = await fetch(`${API_BASE}/admin/products`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });

    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.detail || 'Error creando producto');
    }
  };

  return (
    <ProductForm
      title="Crear Nuevo Producto"
      onSubmit={handleSubmit}
    />
  );
}
