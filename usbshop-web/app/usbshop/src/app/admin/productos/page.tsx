'use client';

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useAdminSession } from '@/hooks/useAdminSession';
import { getApiBaseUrl, loadRuntimeConfig, resolveImageUrl } from '@/lib/api';
import { ProductForm } from './components/ProductForm';
import styles from './productos.module.css';

interface Product {
  id: number;
  name: string;
  sku: string;
  price: number;
  cost: number;
  stock: number;
  imageUrl?: string | null;
  category_id: number | null;
  is_active: boolean;
  is_featured: boolean;
  is_offer: boolean;
  image_path?: string | null;
  image_urls?: string[];
}

const calculateMargin = (cost: number, price: number) => {
  if (!Number.isFinite(cost) || cost <= 0 || !Number.isFinite(price)) {
    return null;
  }
  return ((price - cost) / cost) * 100;
};

const PAGE_SIZE = 100;

const normalizeSearchValue = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

const buildSearchTokens = (value: string) => {
  const base = normalizeSearchValue(value);
  if (!base) return [];
  const tokens = base.split(/\s+/).filter(Boolean);
  const expanded = new Set<string>();
  for (const token of tokens) {
    expanded.add(token);
    if (token.endsWith('es') && token.length > 4) expanded.add(token.slice(0, -2));
    if (token.endsWith('s') && token.length > 3) expanded.add(token.slice(0, -1));
  }
  return Array.from(expanded);
};

export default function ProductosPage() {
  const { user } = useAdminSession();
  const searchParams = useSearchParams();
  const editId = searchParams?.get('edit');

  const [products, setProducts] = useState<Product[]>([]);
  const [editProduct, setEditProduct] = useState<Product | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const loadProducts = async () => {
    try {
      setLoading(true);
      setError('');

      const params = new URLSearchParams();
      params.append('limit', '1000');

      await loadRuntimeConfig();
      const res = await fetch(`${getApiBaseUrl()}/admin/products?${params.toString()}`, {
        credentials: 'include',
      });

      if (!res.ok) throw new Error('No se pudieron cargar los productos');

      const data = await res.json();
      const sorted = Array.isArray(data)
        ? [...data].sort(
            (a, b) =>
              String(a.name || '').localeCompare(String(b.name || ''), 'es', {
                sensitivity: 'base',
                numeric: true,
              }) || a.id - b.id
          )
        : [];
      setProducts(sorted);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error cargando productos');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadProducts();
  }, []);

  useEffect(() => {
    if (editId && products.length > 0) {
      const product = products.find((item) => item.id === Number.parseInt(editId, 10));
      setEditProduct(product || null);
    } else {
      setEditProduct(null);
    }
  }, [editId, products]);

  const filteredProducts = useMemo(() => {
    const tokens = buildSearchTokens(search);
    if (tokens.length === 0) {
      return products;
    }
    return products.filter((product) => {
      const haystack = normalizeSearchValue(
        [product.name, product.sku, product.image_path || '', ...(product.image_urls || [])].join(' ')
      );
      return tokens.every((token) => haystack.includes(token));
    });
  }, [products, search]);

  const totalPages = Math.max(1, Math.ceil(filteredProducts.length / PAGE_SIZE));

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [page, totalPages]);

  const visibleProducts = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return filteredProducts.slice(start, start + PAGE_SIZE);
  }, [filteredProducts, page]);

  const baseUrl = getApiBaseUrl();

  const openEditor = (productId: number) => {
    window.history.pushState(null, '', `/admin/productos?edit=${productId}`);
    const product = products.find((item) => item.id === productId) || null;
    setEditProduct(product);
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Eliminar este producto?')) return;

    try {
      await loadRuntimeConfig();
      const res = await fetch(`${getApiBaseUrl()}/admin/products/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      });

      if (!res.ok) throw new Error('No se pudo eliminar');

      setProducts((current) => current.filter((product) => product.id !== id));
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error eliminando producto');
    }
  };

  const toggleFeatured = async (product: Product) => {
    try {
      await loadRuntimeConfig();
      const res = await fetch(`${getApiBaseUrl()}/admin/products/${product.id}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_featured: !product.is_featured }),
      });

      if (!res.ok) throw new Error('No se pudo actualizar');

      setProducts((current) =>
        current.map((item) =>
          item.id === product.id ? { ...item, is_featured: !item.is_featured } : item
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
          <p>Gestiona el catalogo de productos</p>
        </div>
        <Link href="/admin/productos/nueva" className={styles.btnNew}>
          + Nuevo producto
        </Link>
      </div>

      {error ? <div className={styles.error}>{error}</div> : null}

      <div className={styles.searchForm}>
        <input
          type="text"
          placeholder="Buscar por nombre o SKU..."
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          className={styles.searchInput}
        />
      </div>

      <div className={styles.pagination}>
        <span>
          {filteredProducts.length} productos{search ? ` para "${search}"` : ''} |
          {' '}orden alfabetico
        </span>
      </div>

      <div className={styles.tableWrapper}>
        {loading ? (
          <div className={styles.loading}>Cargando...</div>
        ) : visibleProducts.length === 0 ? (
          <div className={styles.empty}>
            <p>No hay productos para ese filtro</p>
          </div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>ID</th>
                <th>Imagen</th>
                <th>Nombre</th>
                <th>SKU</th>
                <th>Precio</th>
                <th>Costo</th>
                <th>Margen</th>
                <th>Stock</th>
                <th>Destacado</th>
                <th>Oferta</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {visibleProducts.map((product) => {
                const productImageUrl = resolveImageUrl(product.imageUrl, baseUrl);
                const margin = calculateMargin(product.cost, product.price);
                return (
                  <tr
                    key={product.id}
                    className={styles.clickableRow}
                    onDoubleClick={() => openEditor(product.id)}
                    title="Doble click para editar"
                  >
                    <td>{product.id}</td>
                    <td>
                      {productImageUrl ? (
                        <img src={productImageUrl} alt={product.name} className={styles.productThumb} />
                      ) : (
                        <span className={styles.noImage}>Sin imagen</span>
                      )}
                    </td>
                    <td className={styles.name}>{product.name}</td>
                    <td>{product.sku}</td>
                    <td className={styles.price}>${product.price.toFixed(2)}</td>
                    <td className={styles.price}>${product.cost.toFixed(2)}</td>
                    <td className={styles.margin}>
                      {margin === null ? <span className={styles.marginEmpty}>Sin costo</span> : `${margin.toFixed(1)}%`}
                    </td>
                    <td>
                      <span className={product.stock > 0 ? styles.inStock : styles.outOfStock}>
                        {product.stock}
                      </span>
                    </td>
                    <td>
                      <button
                        className={`${styles.toggle} ${product.is_featured ? styles.active : ''}`}
                        onClick={() => toggleFeatured(product)}
                        title="Cambiar destacado"
                      >
                        {product.is_featured ? 'Si' : 'No'}
                      </button>
                    </td>
                    <td>
                      <span className={product.is_offer ? styles.badge : ''}>
                        {product.is_offer ? 'Si' : 'No'}
                      </span>
                    </td>
                    <td className={styles.actions}>
                      <Link href={`/admin/productos?edit=${product.id}`} className={styles.btnEdit}>
                        Editar
                      </Link>
                      <button className={styles.btnDelete} onClick={() => handleDelete(product.id)}>
                        Eliminar
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {filteredProducts.length > 0 ? (
        <div className={styles.pagination}>
          <button
            disabled={page === 1}
            onClick={() => setPage(Math.max(1, page - 1))}
            className={styles.btnPagination}
          >
            Anterior
          </button>
          <span>
            Pagina {page} de {totalPages} | Mostrando {visibleProducts.length} de {filteredProducts.length}
          </span>
          <button
            disabled={page >= totalPages}
            onClick={() => setPage(Math.min(totalPages, page + 1))}
            className={styles.btnPagination}
          >
            Siguiente
          </button>
        </div>
      ) : null}

      {editProduct ? (
        <div className={styles.modal}>
          <div className={styles.modalContent}>
            <button
              className={styles.modalClose}
              onClick={() => window.history.pushState(null, '', '/admin/productos')}
            >
              x
            </button>
            <ProductForm
              initialData={{
                ...editProduct,
                image_path: editProduct.image_path || '',
                image_urls_text: Array.isArray(editProduct.image_urls)
                  ? editProduct.image_urls.join('\n')
                  : '',
              }}
              title="Editar producto"
              onSubmit={async (data) => {
                await loadRuntimeConfig();
                const res = await fetch(`${getApiBaseUrl()}/admin/products/${editProduct.id}`, {
                  method: 'PUT',
                  credentials: 'include',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(data),
                });

                if (!res.ok) {
                  const responseError = await res.json();
                  throw new Error(responseError.detail || 'Error actualizando producto');
                }

                window.history.pushState(null, '', '/admin/productos');
                loadProducts();
              }}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
