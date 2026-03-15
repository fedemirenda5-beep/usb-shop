'use client';

import { useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { useAdminSession } from '@/hooks/useAdminSession';
import Link from 'next/link';
import { ProductForm } from './components/ProductForm';
import { getApiBaseUrl } from '@/lib/api';
import styles from './productos.module.css';

interface Product {
  id: number;
  name: string;
  sku: string;
  price: number;
  stock: number;
  category_id: number | null;
  is_active: boolean;
  is_featured: boolean;
  is_offer: boolean;
}

export default function ProductosPage() {
  const API_BASE = getApiBaseUrl();
  const { user } = useAdminSession();
  const searchParams = useSearchParams();
  const editId = searchParams?.get('edit');
  
  const [products, setProducts] = useState<Product[]>([]);
  const [editProduct, setEditProduct] = useState<Product | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(50);
  const [offset, setOffset] = useState(0);

  const loadProducts = async () => {
    try {
      setLoading(true);
      setError('');

      const params = new URLSearchParams();
      params.append('limit', String(limit));
      params.append('offset', String(offset));
      if (search) params.append('q', search);

      const res = await fetch(`${API_BASE}/admin/products?${params}`, {
        credentials: 'include',
      });

      if (!res.ok) throw new Error('No se pudieron cargar los productos');

      const data = await res.json();
      setProducts(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error cargando productos');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadProducts();
  }, [offset, limit]);

  // Cargar producto cuando se activa edit mode
  useEffect(() => {
    if (editId && products.length > 0) {
      const product = products.find((p) => p.id === parseInt(editId));
      setEditProduct(product || null);
    } else {
      setEditProduct(null);
    }
  }, [editId, products]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setOffset(0);
    loadProducts();
  };

  const handleDelete = async (id: number) => {
    if (!confirm('¿Eliminar este producto?')) return;

    try {
      const res = await fetch(`${API_BASE}/admin/products/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      });

      if (!res.ok) throw new Error('No se pudo eliminar');

      setProducts(products.filter((p) => p.id !== id));
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error eliminando producto');
    }
  };

  const toggleFeatured = async (product: Product) => {
    try {
      const res = await fetch(`${API_BASE}/admin/products/${product.id}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_featured: !product.is_featured }),
      });

      if (!res.ok) throw new Error('No se pudo actualizar');

      setProducts(
        products.map((p) =>
          p.id === product.id ? { ...p, is_featured: !p.is_featured } : p
        )
      );
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error actualizando');
    }
  };

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div>
          <h1>Productos</h1>
          <p>Gestiona el catálogo de productos</p>
        </div>
        <Link href="/admin/productos/nueva" className={styles.btnNew}>
          ➕ Nuevo Producto
        </Link>
      </div>

      {error && <div className={styles.error}>{error}</div>}

      {/* Search Bar */}
      <form onSubmit={handleSearch} className={styles.searchForm}>
        <input
          type="text"
          placeholder="Buscar por nombre o SKU..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className={styles.searchInput}
        />
        <button type="submit" className={styles.btnSearch}>
          🔍 Buscar
        </button>
      </form>

      {/* Products Table */}
      <div className={styles.tableWrapper}>
        {loading ? (
          <div className={styles.loading}>Cargando...</div>
        ) : products.length === 0 ? (
          <div className={styles.empty}>
            <p>No hay productos</p>
            <Link href="/admin/productos/nueva">Crear el primero</Link>
          </div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>ID</th>
                <th>Nombre</th>
                <th>SKU</th>
                <th>Precio</th>
                <th>Stock</th>
                <th>Destacado</th>
                <th>Oferta</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {products.map((product) => (
                <tr key={product.id}>
                  <td>{product.id}</td>
                  <td className={styles.name}>{product.name}</td>
                  <td>{product.sku}</td>
                  <td className={styles.price}>${product.price.toFixed(2)}</td>
                  <td>
                    <span
                      className={
                        product.stock > 0 ? styles.inStock : styles.outOfStock
                      }
                    >
                      {product.stock}
                    </span>
                  </td>
                  <td>
                    <button
                      className={`${styles.toggle} ${
                        product.is_featured ? styles.active : ''
                      }`}
                      onClick={() => toggleFeatured(product)}
                      title="Toggle destacado"
                    >
                      {product.is_featured ? '⭐' : '☆'}
                    </button>
                  </td>
                  <td>
                    <span className={product.is_offer ? styles.badge : ''}>
                      {product.is_offer ? 'Sí' : 'No'}
                    </span>
                  </td>
                  <td className={styles.actions}>
                    <Link
                      href={`/admin/productos?edit=${product.id}`}
                      className={styles.btnEdit}
                    >
                      ✏️
                    </Link>
                    <button
                      className={styles.btnDelete}
                      onClick={() => handleDelete(product.id)}
                    >
                      🗑️
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {products.length > 0 && (
        <div className={styles.pagination}>
          <button
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - limit))}
            className={styles.btnPagination}
          >
            ← Anterior
          </button>
          <span>
            Página {Math.floor(offset / limit) + 1} | Mostrando {products.length}
          </span>
          <button
            disabled={products.length < limit}
            onClick={() => setOffset(offset + limit)}
            className={styles.btnPagination}
          >
            Siguiente →
          </button>
        </div>
      )}

      {/* Edit Modal */}
      {editProduct && (
        <div className={styles.modal}>
          <div className={styles.modalContent}>
            <button
              className={styles.modalClose}
              onClick={() => window.history.pushState(null, '', '/admin/productos')}
            >
              ✕
            </button>
            <ProductForm
              initialData={editProduct}
              title="Editar Producto"
              onSubmit={async (data) => {
                const { image, ...productData } = data;

                const res = await fetch(`${API_BASE}/admin/products/${editProduct.id}`, {
                  method: 'PUT',
                  credentials: 'include',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(productData),
                });

                if (!res.ok) {
                  const error = await res.json();
                  throw new Error(error.detail || 'Error actualizando producto');
                }

                // Subir imagen si se seleccionó una nueva
                if (image) {
                  const formData = new FormData();
                  formData.append('file', image);

                  const imgRes = await fetch(`${API_BASE}/admin/products/${editProduct.id}/image`, {
                    method: 'POST',
                    credentials: 'include',
                    body: formData,
                  });

                  if (!imgRes.ok) {
                    console.error('Error subiendo imagen');
                  }
                }
                
                // Cerrar modal y recargar
                window.history.pushState(null, '', '/admin/productos');
                loadProducts();
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
