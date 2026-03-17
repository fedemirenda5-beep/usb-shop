'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
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
const currencyFormatter = new Intl.NumberFormat('es-AR', {
  style: 'currency',
  currency: 'ARS',
});

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

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

export default function ProductosPage() {
  const { user } = useAdminSession();
  const router = useRouter();
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
    router.push(`/admin/productos?edit=${productId}`);
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

  const exportPriceListPdf = (includeImages: boolean) => {
    const exportItems = filteredProducts;
    if (exportItems.length === 0) {
      alert('No hay productos para exportar con el filtro actual.');
      return;
    }

    const generatedAt = new Date().toLocaleString('es-AR');
    const title = includeImages ? 'Lista de precios con imagenes' : 'Lista de precios';
    const rows = exportItems
      .map((product) => {
        const imageUrl = resolveImageUrl(product.imageUrl, baseUrl);
        const imageCell = includeImages
          ? imageUrl
            ? `<td class="imageCell"><img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(product.name)}" /></td>`
            : '<td class="imageCell emptyImage">Sin imagen</td>'
          : '';
        return `
          <tr>
            ${imageCell}
            <td class="nameCell">
              <strong>${escapeHtml(product.name)}</strong>
              <span>SKU ${escapeHtml(product.sku || '-')}</span>
            </td>
            <td>${product.stock}</td>
            <td class="priceCell">${escapeHtml(currencyFormatter.format(product.price || 0))}</td>
          </tr>
        `;
      })
      .join('');

    const printWindow = window.open('', '_blank', 'noopener,noreferrer,width=1100,height=800');
    if (!printWindow) {
      alert('No se pudo abrir la ventana de exportacion.');
      return;
    }

    printWindow.document.write(`
      <!doctype html>
      <html lang="es">
        <head>
          <meta charset="utf-8" />
          <title>${escapeHtml(title)}</title>
          <style>
            body { font-family: Arial, sans-serif; color: #111827; margin: 24px; }
            .header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; margin-bottom: 20px; }
            .header h1 { margin: 0 0 6px; font-size: 24px; }
            .header p { margin: 0; color: #4b5563; font-size: 12px; }
            .summary { margin-bottom: 14px; color: #374151; font-size: 13px; }
            table { width: 100%; border-collapse: collapse; table-layout: fixed; }
            th, td { border-bottom: 1px solid #d1d5db; padding: 10px 8px; text-align: left; vertical-align: middle; font-size: 12px; }
            th { text-transform: uppercase; color: #4b5563; font-size: 11px; letter-spacing: 0.04em; }
            .imageCell { width: 84px; }
            .imageCell img { width: 64px; height: 64px; object-fit: cover; border-radius: 8px; border: 1px solid #e5e7eb; display: block; }
            .emptyImage { color: #9ca3af; font-size: 11px; }
            .nameCell strong { display: block; font-size: 13px; }
            .nameCell span { display: block; color: #6b7280; margin-top: 4px; font-size: 11px; }
            .priceCell { white-space: nowrap; font-weight: 700; }
            @media print { body { margin: 12mm; } }
          </style>
        </head>
        <body>
          <div class="header">
            <div>
              <h1>USB Shop</h1>
              <p>${escapeHtml(title)}</p>
            </div>
            <div>
              <p>Generado: ${escapeHtml(generatedAt)}</p>
              <p>Productos: ${exportItems.length}</p>
            </div>
          </div>
          <div class="summary">
            ${search ? `Filtro aplicado: <strong>${escapeHtml(search)}</strong>` : 'Sin filtro aplicado'}
          </div>
          <table>
            <thead>
              <tr>
                ${includeImages ? '<th>Imagen</th>' : ''}
                <th>Producto</th>
                <th>Stock</th>
                <th>Precio</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
          <script>
            window.onload = function () {
              setTimeout(function () {
                window.print();
              }, 250);
            };
          </script>
        </body>
      </html>
    `);
    printWindow.document.close();
  };

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div>
          <h1>Productos</h1>
          <p>Gestiona el catalogo de productos</p>
        </div>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.btnSecondary}
            onClick={() => exportPriceListPdf(false)}
          >
            PDF sin imagenes
          </button>
          <button
            type="button"
            className={styles.btnSecondary}
            onClick={() => exportPriceListPdf(true)}
          >
            PDF con imagenes
          </button>
          <Link href="/admin/productos/nueva" className={styles.btnNew}>
            + Nuevo producto
          </Link>
        </div>
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
                    <td className={styles.skuCell} title={product.sku}>{product.sku}</td>
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
                        onClick={(event) => {
                          event.stopPropagation();
                          void toggleFeatured(product);
                        }}
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
                      <button
                        className={styles.btnDelete}
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleDelete(product.id);
                        }}
                      >
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
              onClick={() => router.push('/admin/productos')}
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

                router.push('/admin/productos');
                loadProducts();
              }}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
