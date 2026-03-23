'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useAdminSession } from '@/hooks/useAdminSession';
import { getApiBaseUrl, loadRuntimeConfig, resolveImageUrl } from '@/lib/api';
import { formatArgentinaDateTime } from '@/lib/datetime';
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
  category?: string | null;
  is_active: boolean;
  is_featured: boolean;
  is_offer: boolean;
  image_path?: string | null;
  image_urls?: string[];
}

interface Category {
  id: number;
  name: string;
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
type ExportValueMode = 'price' | 'cost';

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

const slugifyFilePart = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .trim() || 'lista';

const fetchImageAsDataUrl = async (imageUrl: string) => {
  try {
    const response = await fetch(imageUrl, { mode: 'cors', credentials: 'omit', cache: 'force-cache' });
    if (!response.ok) return null;
    const blob = await response.blob();
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
};

export default function ProductosPage() {
  const { user } = useAdminSession();
  const router = useRouter();
  const searchParams = useSearchParams();
  const editId = searchParams?.get('edit');

  const [products, setProducts] = useState<Product[]>([]);
  const [editProduct, setEditProduct] = useState<Product | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [categoriesLoading, setCategoriesLoading] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [page, setPage] = useState(1);
  const [showCategoriesModal, setShowCategoriesModal] = useState(false);
  const [categoryDraft, setCategoryDraft] = useState('');
  const [editingCategoryId, setEditingCategoryId] = useState<number | null>(null);
  const [categoryError, setCategoryError] = useState('');

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

  const loadCategories = async () => {
    try {
      setCategoriesLoading(true);
      setCategoryError('');
      await loadRuntimeConfig();
      const res = await fetch(`${getApiBaseUrl()}/admin/categories`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error('No se pudieron cargar los rubros');
      const data = await res.json();
      setCategories(Array.isArray(data) ? data : []);
    } catch (err) {
      setCategoryError(err instanceof Error ? err.message : 'Error cargando rubros');
    } finally {
      setCategoriesLoading(false);
    }
  };

  useEffect(() => {
    void Promise.all([loadProducts(), loadCategories()]);
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
    return products.filter((product) => {
      if (categoryFilter && String(product.category_id || '') !== categoryFilter) {
        return false;
      }
      if (tokens.length === 0) {
        return true;
      }
      const haystack = normalizeSearchValue(
        [product.name, product.sku, product.category || '', product.image_path || '', ...(product.image_urls || [])].join(' ')
      );
      return tokens.every((token) => haystack.includes(token));
    });
  }, [products, search, categoryFilter]);

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
  const categoryMap = useMemo(
    () => new Map(categories.map((category) => [category.id, category.name])),
    [categories]
  );

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

  const resetCategoryEditor = () => {
    setCategoryDraft('');
    setEditingCategoryId(null);
    setCategoryError('');
  };

  const submitCategory = async () => {
    const name = categoryDraft.trim();
    if (!name) {
      setCategoryError('Nombre de rubro requerido');
      return;
    }
    try {
      setCategoryError('');
      await loadRuntimeConfig();
      const url = editingCategoryId
        ? `${getApiBaseUrl()}/admin/categories/${editingCategoryId}`
        : `${getApiBaseUrl()}/admin/categories`;
      const res = await fetch(url, {
        method: editingCategoryId ? 'PUT' : 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || 'No se pudo guardar el rubro');
      await loadCategories();
      resetCategoryEditor();
    } catch (err) {
      setCategoryError(err instanceof Error ? err.message : 'Error guardando rubro');
    }
  };

  const deleteCategory = async (category: Category) => {
    if (!confirm(`Eliminar rubro "${category.name}"?`)) return;
    try {
      setCategoryError('');
      await loadRuntimeConfig();
      const res = await fetch(`${getApiBaseUrl()}/admin/categories/${category.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || 'No se pudo eliminar el rubro');
      if (categoryFilter === String(category.id)) {
        setCategoryFilter('');
      }
      await Promise.all([loadCategories(), loadProducts()]);
    } catch (err) {
      setCategoryError(err instanceof Error ? err.message : 'Error eliminando rubro');
    }
  };

  const exportPriceListPdf = async (includeImages: boolean, valueMode: ExportValueMode) => {
    const exportItems = filteredProducts;
    if (exportItems.length === 0) {
      alert('No hay productos para exportar con el filtro actual.');
      return;
    }

    const generatedAt = formatArgentinaDateTime(new Date().toISOString());
    const label = valueMode === 'cost' ? 'costos' : 'precios';
    const title = includeImages
      ? `Lista de ${label} con imagenes`
      : `Lista de ${label}`;
    const fileName = `usbshop-${slugifyFilePart(label)}${includeImages ? '-con-imagenes' : ''}.html`;

    const printWindow = window.open('', '_blank', 'noopener,noreferrer,width=1100,height=800');
    if (!printWindow) {
      alert('No se pudo abrir la ventana de exportacion.');
      return;
    }

    printWindow.document.open();
    printWindow.document.write(`
      <!doctype html>
      <html lang="es">
        <head>
          <meta charset="utf-8" />
          <title>${escapeHtml(title)}</title>
          <style>
            body { font-family: Arial, sans-serif; color: #111827; margin: 24px; }
            .loading { min-height: 60vh; display: grid; place-items: center; color: #4b5563; font-size: 14px; }
          </style>
        </head>
        <body>
          <div class="loading">Preparando exportacion...</div>
        </body>
      </html>
    `);
    printWindow.document.close();

    const rowParts = await Promise.all(
      exportItems.map(async (product) => {
        const resolvedImageUrl =
          resolveImageUrl(product.imageUrl, baseUrl) ||
          resolveImageUrl(product.image_path, baseUrl) ||
          resolveImageUrl(Array.isArray(product.image_urls) ? product.image_urls[0] : null, baseUrl);
        const embeddedImageUrl =
          includeImages && resolvedImageUrl ? await fetchImageAsDataUrl(resolvedImageUrl) : null;
        const finalImageUrl = embeddedImageUrl || resolvedImageUrl;
        const amount = valueMode === 'cost' ? product.cost || 0 : product.price || 0;
        const imageCell = includeImages
          ? finalImageUrl
            ? `<td class="imageCell"><img src="${escapeHtml(finalImageUrl)}" alt="${escapeHtml(product.name)}" /></td>`
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
            <td class="priceCell">${escapeHtml(currencyFormatter.format(amount))}</td>
          </tr>
        `;
      })
    );
    const rows = rowParts.join('');

    printWindow.document.write(`
      <!doctype html>
      <html lang="es">
        <head>
          <meta charset="utf-8" />
          <title>${escapeHtml(title)}</title>
          <style>
            body { font-family: Arial, sans-serif; color: #111827; margin: 24px; }
            .toolbar { position: sticky; top: 0; z-index: 10; display: flex; justify-content: space-between; gap: 12px; align-items: center; margin: -24px -24px 24px; padding: 16px 24px; background: rgba(255,255,255,.96); backdrop-filter: blur(8px); border-bottom: 1px solid #e5e7eb; }
            .toolbarInfo { color: #4b5563; font-size: 12px; }
            .toolbarActions { display: flex; gap: 10px; flex-wrap: wrap; }
            .toolbarButton { border: 0; border-radius: 10px; padding: 10px 14px; font: inherit; font-size: 13px; font-weight: 700; cursor: pointer; }
            .primaryButton { background: #111827; color: white; }
            .secondaryButton { background: #e5e7eb; color: #111827; }
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
          <div class="toolbar">
            <div class="toolbarInfo">Vista previa lista de ${escapeHtml(label)}${includeImages ? ' con imagenes' : ''}</div>
            <div class="toolbarActions">
              <button type="button" class="toolbarButton primaryButton" onclick="window.print()">Imprimir / Guardar PDF</button>
              <button
                type="button"
                class="toolbarButton secondaryButton"
                onclick="(function(){ var blob = new Blob(['<!doctype html>' + document.documentElement.outerHTML], { type: 'text/html;charset=utf-8' }); var link = document.createElement('a'); var url = URL.createObjectURL(blob); link.href = url; link.download = '${escapeHtml(fileName)}'; link.click(); setTimeout(function(){ URL.revokeObjectURL(url); }, 1000); })()"
              >
                Descargar archivo
              </button>
              <button type="button" class="toolbarButton secondaryButton" onclick="window.close()">Cerrar</button>
            </div>
          </div>
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
                <th>${valueMode === 'cost' ? 'Costo' : 'Precio'}</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
          <script>
            (function () {
              var includeImages = ${includeImages ? 'true' : 'false'};
              if (!includeImages) return;
              var root = document.querySelector('.toolbarInfo');
              if (!root) return;
              var images = Array.prototype.slice.call(document.images || []);
              var pending = images.filter(function (img) { return !img.complete; }).length;
              if (pending === 0) {
                root.textContent = 'Vista previa lista de ${escapeHtml(label)} con imagenes';
                return;
              }
              root.textContent = 'Cargando imagenes para la vista previa...';
              var remaining = pending;
              var settle = function () {
                remaining -= 1;
                if (remaining <= 0) {
                  root.textContent = 'Vista previa lista de ${escapeHtml(label)} con imagenes';
                }
              };
              images.forEach(function (img) {
                if (img.complete) return;
                img.addEventListener('load', settle, { once: true });
                img.addEventListener('error', settle, { once: true });
              });
            })();
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
          <div className={styles.exportGroup}>
            <span className={styles.exportLabel}>Precios</span>
            <button
              type="button"
              className={styles.btnSecondary}
              onClick={() => exportPriceListPdf(false, 'price')}
            >
              PDF sin imagenes
            </button>
            <button
              type="button"
              className={styles.btnSecondary}
              onClick={() => exportPriceListPdf(true, 'price')}
            >
              PDF con imagenes
            </button>
          </div>
          <div className={styles.exportGroup}>
            <span className={styles.exportLabel}>Costos</span>
            <button
              type="button"
              className={styles.btnSecondary}
              onClick={() => exportPriceListPdf(false, 'cost')}
            >
              PDF sin imagenes
            </button>
            <button
              type="button"
              className={styles.btnSecondary}
              onClick={() => exportPriceListPdf(true, 'cost')}
            >
              PDF con imagenes
            </button>
          </div>
          <button
            type="button"
            className={styles.btnSecondary}
            onClick={() => setShowCategoriesModal(true)}
          >
            Rubros
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
        <select
          value={categoryFilter}
          onChange={(e) => {
            setCategoryFilter(e.target.value);
            setPage(1);
          }}
          className={styles.categoryFilter}
        >
          <option value="">Todos los rubros</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
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
                <th>Rubro</th>
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
                    <td>{product.category || categoryMap.get(product.category_id || 0) || 'Sin rubro'}</td>
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
                category_id: editProduct.category_id,
                image_path: editProduct.image_path || '',
                image_urls: Array.isArray(editProduct.image_urls) ? editProduct.image_urls : [],
              }}
              title="Editar producto"
              categories={categories}
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

      {showCategoriesModal ? (
        <div className={styles.modal}>
          <div className={styles.modalContent}>
            <button
              className={styles.modalClose}
              onClick={() => {
                setShowCategoriesModal(false);
                resetCategoryEditor();
              }}
            >
              x
            </button>
            <div className={styles.categoryModalHeader}>
              <h2>Rubros</h2>
              <p>Rubros creados en la base actual.</p>
            </div>

            {categoryError ? <div className={styles.error}>{categoryError}</div> : null}

            <div className={styles.categoryEditor}>
              <input
                type="text"
                value={categoryDraft}
                onChange={(e) => setCategoryDraft(e.target.value)}
                placeholder="Nombre del rubro"
                className={styles.searchInput}
              />
              <button type="button" className={styles.btnSecondary} onClick={() => void submitCategory()}>
                {editingCategoryId ? 'Guardar' : 'Crear'}
              </button>
              {editingCategoryId ? (
                <button type="button" className={styles.btnSecondary} onClick={resetCategoryEditor}>
                  Cancelar
                </button>
              ) : null}
            </div>

            <div className={styles.categoryList}>
              {categoriesLoading ? (
                <div className={styles.loading}>Cargando rubros...</div>
              ) : categories.length === 0 ? (
                <div className={styles.empty}>
                  <p>No hay rubros cargados.</p>
                </div>
              ) : (
                categories.map((category) => (
                  <div key={category.id} className={styles.categoryRow}>
                    <strong>{category.name}</strong>
                    <div className={styles.actions}>
                      <button
                        type="button"
                        className={styles.btnEdit}
                        onClick={() => {
                          setEditingCategoryId(category.id);
                          setCategoryDraft(category.name);
                        }}
                      >
                        Editar
                      </button>
                      <button
                        type="button"
                        className={styles.btnDelete}
                        onClick={() => void deleteCategory(category)}
                      >
                        Eliminar
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
