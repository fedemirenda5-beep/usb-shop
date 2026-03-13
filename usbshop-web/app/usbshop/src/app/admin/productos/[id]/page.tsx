'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ProductForm } from '../components/ProductForm';

interface EditProductPageProps {
  params: {
    id: string;
  };
}

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:8000';

interface ProductData {
  id: number;
  name: string;
  sku: string;
  price: number;
  stock: number;
  is_featured: boolean;
  is_offer: boolean;
}

export default function EditProductPage({ params }: EditProductPageProps) {
  const router = useRouter();
  const [product, setProduct] = useState<ProductData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const loadProduct = async () => {
      try {
        // Fetch all products and find the one with matching ID
        // Since there's no dedicated GET /admin/products/{id} endpoint,
        // we fetch the list and filter
        const res = await fetch(
          `${API_BASE}/admin/products?limit=1000&offset=0`,
          { credentials: 'include' }
        );

        if (!res.ok) {
          throw new Error('No se pudo cargar el producto');
        }

        const data = await res.json();
        const foundProduct = data.products?.find(
          (p: ProductData) => p.id === parseInt(params.id)
        );

        if (!foundProduct) {
          throw new Error('Producto no encontrado');
        }

        setProduct(foundProduct);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error cargando producto');
      } finally {
        setLoading(false);
      }
    };

    loadProduct();
  }, [params.id]);

  const handleSubmit = async (data: any) => {
    const res = await fetch(`${API_BASE}/admin/products/${params.id}`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });

    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.detail || 'Error actualizando producto');
    }
  };

  if (loading) {
    return <div style={{ padding: '2rem', textAlign: 'center' }}>Cargando...</div>;
  }

  if (error) {
    return (
      <div style={{ padding: '2rem', color: '#dc2626', textAlign: 'center' }}>
        {error}
      </div>
    );
  }

  if (!product) {
    return (
      <div style={{ padding: '2rem', textAlign: 'center' }}>
        Producto no encontrado
      </div>
    );
  }

  return (
    <ProductForm
      initialData={product}
      title="Editar Producto"
      onSubmit={handleSubmit}
    />
  );
}
