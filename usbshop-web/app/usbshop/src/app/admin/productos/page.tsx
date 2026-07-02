'use client';

import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useAdminSession } from '@/hooks/useAdminSession';
import { getApiBaseUrl, loadRuntimeConfig, resolveImageUrl } from '@/lib/api';
import { formatArgentinaDateTime } from '@/lib/datetime';
import { canViewProfitMetrics } from '../adminPermissions';
import { ProductForm } from './components/ProductForm';
import styles from './productos.module.css';

interface Product {
  id: number;
  name: string;
  sku: string;
  barcode?: string | null;
  price: number;
  price_list_1?: number | null;
  price_list_2?: number | null;
  storefront_price?: number;
  storefront_original_price?: number;
  storefront_price_source?: 'flash_offer' | 'price_list_1' | 'price';
  cost: number;
  stock: number;
  imageUrl?: string | null;
  category_id: number | null;
  category?: string | null;
  is_active: boolean;
  is_featured: boolean;
  is_offer: boolean;
  highlight_new_arrivals: boolean;
  flash_offer_price?: number | null;
  flash_offer_ends_at?: string | null;
  flash_offer_active?: boolean;
  image_path?: string | null;
  image_urls?: string[];
}

interface Category {
  id: number;
  name: string;
}

const normalizeCategoryName = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

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

const downloadTextFile = (content: string, fileName: string, mimeType: string) => {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const getProductPrimaryImageUrl = (product: Product, baseUrl: string) =>
  resolveImageUrl(product.imageUrl, baseUrl) ||
  resolveImageUrl(product.image_path, baseUrl) ||
  resolveImageUrl(Array.isArray(product.image_urls) ? product.image_urls[0] : null, baseUrl);

const getStorefrontPrice = (product: Product) => {
  if (Number(product.flash_offer_price || 0) > 0 && product.flash_offer_active) {
    return Number(product.flash_offer_price || 0);
  }
  const priceList1 = Number(product.price_list_1 || 0);
  if (priceList1 > 0) {
    return priceList1;
  }
  return Number(product.price || 0);
};

const getStorefrontPriceLabel = (product: Product) => {
  if (Number(product.flash_offer_price || 0) > 0 && product.flash_offer_active) {
    return 'Web: relampago';
  }
  const priceList1 = Number(product.price_list_1 || 0);
  if (priceList1 > 0 && priceList1 !== Number(product.price || 0)) {
    return 'Web: lista 1';
  }
  return 'Web: precio base';
};

export default function ProductosPage() {
  const { user } = useAdminSession();
  const canViewProfit = canViewProfitMetrics(user?.role);
  const router = useRouter();
  const searchParams = useSearchParams();
  const editId = searchParams?.get('edit');
  const [isMobileLayout, setIsMobileLayout] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth <= 768 : false
  );
  const [detailOnly, setDetailOnly] = useState(false);

  const [products, setProducts] = useState<Product[]>([]);
  const [editProduct, setEditProduct] = useState<Product | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [categoriesLoading, setCategoriesLoading] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [onlyOutOfStock, setOnlyOutOfStock] = useState(false);
  const [page, setPage] = useState(1);
  const [showCategoriesModal, setShowCategoriesModal] = useState(false);
  const [categoryDraft, setCategoryDraft] = useState('');
  const [editingCategoryId, setEditingCategoryId] = useState<number | null>(null);
  const [categoryError, setCategoryError] = useState('');
  const [categorySaving, setCategorySaving] = useState(false);
  const deferredSearch = useDeferredValue(search);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const media = window.matchMedia('(max-width: 768px)');
    const sync = () => setIsMobileLayout(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

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

  useEffect(() => {
    if (!isMobileLayout) {
      setDetailOnly(false);
    }
  }, [isMobileLayout]);

  const filteredProducts = useMemo(() => {
    const tokens = buildSearchTokens(deferredSearch);
    return products.filter((product) => {
      if (categoryFilter && String(product.category_id || '') !== categoryFilter) {
        return false;
      }
      if (onlyOutOfStock && Number(product.stock || 0) > 0) {
        return false;
      }
      if (tokens.length === 0) {
        return true;
      }
      const haystack = normalizeSearchValue(
        [product.name, product.sku, product.barcode || '', product.category || '', product.image_path || '', ...(product.image_urls || [])].join(' ')
      );
      return tokens.every((token) => haystack.includes(token));
    });
  }, [products, deferredSearch, categoryFilter, onlyOutOfStock]);

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
  const selectedProduct = useMemo(() => {
    if (editProduct) return editProduct;
    return null;
  }, [editProduct]);

  const openEditor = (productId: number) => {
    router.push(`/admin/productos?edit=${productId}`);
    const product = products.find((item) => item.id === productId) || null;
    setEditProduct(product);
  };

  const openProductDetail = (productId: number) => {
    const product = products.find((item) => item.id === productId) || null;
    setEditProduct(product);
    setDetailOnly(true);
  };

  const closeProductDetail = () => {
    setDetailOnly(false);
    setEditProduct(null);
  };

  const handleDelete = async (product: Product) => {
    const confirmMessage =
      product.stock <= 0
        ? `Eliminar "${product.name}" de la lista? Tiene stock 0 y dejara de mostrarse en Productos.`
        : `Eliminar "${product.name}" de la lista?`;
    if (!confirm(confirmMessage)) return;

    try {
      await loadRuntimeConfig();
      const res = await fetch(`${getApiBaseUrl()}/admin/products/${product.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });

      if (!res.ok) throw new Error('No se pudo eliminar');

      setProducts((current) => current.filter((item) => item.id !== product.id));
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
      body: JSON.stringify({
          name: product.name,
          sku: product.sku,
          barcode: product.barcode || null,
          price: product.price,
          price_list_1: product.price_list_1 || 0,
          price_list_2: product.price_list_2 || 0,
          cost: product.cost,
          stock: product.stock,
          category_id: product.category_id,
          image_path: product.image_path || '',
          image_urls: Array.isArray(product.image_urls) ? product.image_urls : [],
          is_offer: product.is_offer,
          is_featured: !product.is_featured,
          highlight_new_arrivals: product.highlight_new_arrivals,
        }),
      });

      if (!res.ok) throw new Error('No se pudo actualizar');

      await loadProducts();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error actualizando');
    }
  };

  const buildProductUpdatePayload = (product: Product, overrides: Partial<Product>) => ({
    name: product.name,
    sku: product.sku,
    barcode: product.barcode || null,
    price: product.price,
    price_list_1: product.price_list_1 || 0,
    price_list_2: product.price_list_2 || 0,
    cost: product.cost,
    stock: product.stock,
    category_id: product.category_id,
    image_path: product.image_path || '',
    image_urls: Array.isArray(product.image_urls) ? product.image_urls : [],
    is_offer: product.is_offer,
    is_featured: product.is_featured,
    highlight_new_arrivals: product.highlight_new_arrivals,
    flash_offer_price: product.flash_offer_price || 0,
    flash_offer_ends_at: product.flash_offer_ends_at || null,
    ...overrides,
  });

  const updateProduct = async (product: Product, overrides: Partial<Product>) => {
    await loadRuntimeConfig();
    const res = await fetch(`${getApiBaseUrl()}/admin/products/${product.id}`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildProductUpdatePayload(product, overrides)),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || 'No se pudo actualizar el producto');
    await loadProducts();
  };

  const activateFlashOffer = async (product: Product) => {
    const rawPrice = prompt(`Precio relampago para "${product.name}"`, String(product.flash_offer_price || getStorefrontPrice(product)));
    if (rawPrice === null) return;
    const price = Number(rawPrice.replace(',', '.'));
    if (!Number.isFinite(price) || price <= 0) {
      alert('Precio invalido');
      return;
    }
    const endsAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    try {
      await updateProduct(product, {
        flash_offer_price: price,
        flash_offer_ends_at: endsAt.toISOString(),
      });
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error activando oferta relampago');
    }
  };

  const clearFlashOffer = async (product: Product) => {
    try {
      await updateProduct(product, {
        flash_offer_price: 0,
        flash_offer_ends_at: null,
      });
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error quitando oferta relampago');
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
    const duplicatedCategory = categories.find(
      (category) =>
        category.id !== editingCategoryId && normalizeCategoryName(category.name) === normalizeCategoryName(name)
    );
    if (duplicatedCategory) {
      setCategoryError('Ese rubro ya existe');
      return;
    }
    try {
      setCategorySaving(true);
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
    } finally {
      setCategorySaving(false);
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
    const embeddedLogoUrl = await fetchImageAsDataUrl(`${window.location.origin}/logo-small.jpeg`);

    const rowParts = await Promise.all(
      exportItems.map(async (product) => {
        const resolvedImageUrl = getProductPrimaryImageUrl(product, baseUrl);
        const embeddedImageUrl =
          includeImages && resolvedImageUrl ? await fetchImageAsDataUrl(resolvedImageUrl) : null;
        const finalImageUrl = embeddedImageUrl || resolvedImageUrl;
        const amount = valueMode === 'cost' ? product.cost || 0 : getStorefrontPrice(product);
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
    const html = `
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
            .brandBlock { display: flex; gap: 14px; align-items: center; }
            .brandLogo { width: 64px; height: 64px; object-fit: contain; border-radius: 12px; border: 1px solid #e5e7eb; background: white; padding: 4px; box-sizing: border-box; }
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
                onclick="(function(){ var blob = new Blob(['<!doctype html>' + document.documentElement.outerHTML], { type: 'text/html;charset=utf-8' }); var link = document.createElement('a'); var url = URL.createObjectURL(blob); link.href = url; link.download = '${escapeHtml(fileName)}'; document.body.appendChild(link); link.click(); link.remove(); setTimeout(function(){ URL.revokeObjectURL(url); }, 1000); })()"
              >
                Descargar archivo
              </button>
              <button type="button" class="toolbarButton secondaryButton" onclick="window.close()">Cerrar</button>
            </div>
          </div>
          <div class="header">
            <div class="brandBlock">
              ${embeddedLogoUrl ? `<img src="${escapeHtml(embeddedLogoUrl)}" alt="USB Shop" class="brandLogo" />` : ''}
              <div>
                <h1>USB Shop</h1>
                <p>${escapeHtml(title)}</p>
              </div>
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
    `;

    downloadTextFile(html, fileName, 'text/html;charset=utf-8');

    const previewBlob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const previewUrl = URL.createObjectURL(previewBlob);
    const previewWindow = window.open(previewUrl, '_blank', 'noopener,noreferrer');
    if (!previewWindow) {
      window.location.assign(previewUrl);
    }
    window.setTimeout(() => URL.revokeObjectURL(previewUrl), 60_000);
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
        <label className={styles.stockToggle}>
          <input
            type="checkbox"
            checked={onlyOutOfStock}
            onChange={(e) => {
              setOnlyOutOfStock(e.target.checked);
              setPage(1);
            }}
          />
          <span>Solo stock 0</span>
        </label>
      </div>

      {isMobileLayout && !detailOnly ? (
        <section className={styles.mobilePicker}>
          <div className={styles.mobilePickerHeader}>
            <div>
              <h2>Productos disponibles</h2>
              <p>Busca un producto y toca una tarjeta para ver el detalle completo.</p>
            </div>
            <strong>{filteredProducts.length}</strong>
          </div>
          <div className={styles.mobileCardList}>
            {loading ? (
              <div className={styles.loading}>Cargando...</div>
            ) : filteredProducts.length === 0 ? (
              <div className={styles.empty}>
                <p>No hay productos para ese filtro</p>
              </div>
            ) : (
              visibleProducts.map((product) => {
                const productImageUrl = getProductPrimaryImageUrl(product, baseUrl);
                const storefrontPrice = getStorefrontPrice(product);
                return (
                  <button
                    key={product.id}
                    type="button"
                    className={styles.mobileCard}
                    onClick={() => openProductDetail(product.id)}
                  >
                    <div className={styles.mobileCardTop}>
                      {productImageUrl ? (
                        <img src={productImageUrl} alt={product.name} className={styles.productThumb} />
                      ) : (
                        <span className={styles.noImage}>Sin imagen</span>
                      )}
                      <div className={styles.mobileCardCopy}>
                        <strong>{product.name}</strong>
                        <span>SKU {product.sku || '-'}</span>
                        <span>{product.category || categoryMap.get(product.category_id || 0) || 'Sin rubro'}</span>
                      </div>
                    </div>
                    <div className={styles.mobileCardMeta}>
                      <span>{currencyFormatter.format(storefrontPrice)}</span>
                      <span>Stock {product.stock}</span>
                      <span>{product.is_featured ? 'Destacado' : 'Comun'}</span>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </section>
      ) : null}

      <div className={styles.pagination}>
        <span>
          {filteredProducts.length} productos{search ? ` para "${search}"` : ''} |
          {' '}orden alfabetico
        </span>
      </div>

      {!isMobileLayout ? <div className={styles.tableWrapper}>
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
                {canViewProfit ? <th>Margen</th> : null}
                <th>Stock</th>
                <th>Destacado</th>
                <th>Oferta</th>
                <th>Relampago</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {visibleProducts.map((product) => {
                const productImageUrl = getProductPrimaryImageUrl(product, baseUrl);
                const margin = calculateMargin(product.cost, product.price);
                const storefrontPrice = getStorefrontPrice(product);
                const storefrontPriceLabel = getStorefrontPriceLabel(product);
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
                    <td className={styles.price}>
                      <div className={styles.priceStack}>
                        <strong>{currencyFormatter.format(storefrontPrice)}</strong>
                        <span>{storefrontPriceLabel}</span>
                        {storefrontPrice !== Number(product.price || 0) ? (
                          <small>Base: {currencyFormatter.format(Number(product.price || 0))}</small>
                        ) : null}
                      </div>
                    </td>
                    <td className={styles.price}>${product.cost.toFixed(2)}</td>
                    {canViewProfit ? (
                      <td className={styles.margin}>
                        {margin === null ? <span className={styles.marginEmpty}>Sin costo</span> : `${margin.toFixed(1)}%`}
                      </td>
                    ) : null}
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
                    <td>
                      {product.flash_offer_active ? (
                        <div className={styles.flashCell}>
                          <strong>{currencyFormatter.format(Number(product.flash_offer_price || 0))}</strong>
                          <span>Hasta {product.flash_offer_ends_at ? formatArgentinaDateTime(product.flash_offer_ends_at) : '-'}</span>
                          <button
                            type="button"
                            className={styles.btnSmall}
                            onClick={(event) => {
                              event.stopPropagation();
                              void clearFlashOffer(product);
                            }}
                          >
                            Quitar
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className={styles.btnSmall}
                          onClick={(event) => {
                            event.stopPropagation();
                            void activateFlashOffer(product);
                          }}
                        >
                          3 dias
                        </button>
                      )}
                    </td>
                    <td className={styles.actions}>
                      <Link href={`/admin/productos?edit=${product.id}`} className={styles.btnEdit}>
                        Editar
                      </Link>
                      <button
                        className={styles.btnDelete}
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleDelete(product);
                        }}
                      >
                        {product.stock <= 0 ? 'Eliminar agotado' : 'Eliminar'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div> : null}

      {isMobileLayout && detailOnly && selectedProduct ? (
        <section className={styles.mobileDetail}>
          <div className={styles.mobileDetailHeader}>
            <button type="button" className={styles.btnSecondary} onClick={closeProductDetail}>
              Volver
            </button>
            <button type="button" className={styles.btnEdit} onClick={() => openEditor(selectedProduct.id)}>
              Editar
            </button>
          </div>
          <div className={styles.mobileDetailCard}>
            {getProductPrimaryImageUrl(selectedProduct, baseUrl) ? (
              <img
                src={getProductPrimaryImageUrl(selectedProduct, baseUrl) || ''}
                alt={selectedProduct.name}
                className={styles.mobileDetailImage}
              />
            ) : null}
            <h2>{selectedProduct.name}</h2>
            <div className={styles.mobileDetailGrid}>
              {(() => {
                const storefrontPrice = getStorefrontPrice(selectedProduct);
                const storefrontPriceLabel = getStorefrontPriceLabel(selectedProduct);
                return (
                  <>
                    <div><span>Precio web</span><strong>{currencyFormatter.format(storefrontPrice)}</strong></div>
                    <div><span>Origen</span><strong>{storefrontPriceLabel}</strong></div>
                    <div><span>Precio base</span><strong>{currencyFormatter.format(selectedProduct.price || 0)}</strong></div>
                    <div><span>Lista 1</span><strong>{currencyFormatter.format(Number(selectedProduct.price_list_1 || 0))}</strong></div>
                    <div><span>Lista 2</span><strong>{currencyFormatter.format(Number(selectedProduct.price_list_2 || 0))}</strong></div>
                  </>
                );
              })()}
              <div><span>SKU</span><strong>{selectedProduct.sku || '-'}</strong></div>
              <div><span>Codigo</span><strong>{selectedProduct.barcode || '-'}</strong></div>
              <div><span>Rubro</span><strong>{selectedProduct.category || categoryMap.get(selectedProduct.category_id || 0) || 'Sin rubro'}</strong></div>
              <div><span>Costo</span><strong>{currencyFormatter.format(selectedProduct.cost || 0)}</strong></div>
              <div><span>Stock</span><strong>{selectedProduct.stock}</strong></div>
              <div><span>Estado</span><strong>{selectedProduct.is_active ? 'Activo' : 'Inactivo'}</strong></div>
              <div><span>Destacado</span><strong>{selectedProduct.is_featured ? 'Si' : 'No'}</strong></div>
              <div><span>Oferta</span><strong>{selectedProduct.is_offer ? 'Si' : 'No'}</strong></div>
              {canViewProfit ? (
                <div><span>Margen</span><strong>{calculateMargin(selectedProduct.cost, selectedProduct.price)?.toFixed(1) || '0'}%</strong></div>
              ) : null}
            </div>
            <div className={styles.mobileDetailActions}>
              <button type="button" className={styles.btnSecondary} onClick={() => void toggleFeatured(selectedProduct)}>
                {selectedProduct.is_featured ? 'Quitar destacado' : 'Marcar destacado'}
              </button>
              <button type="button" className={styles.btnDelete} onClick={() => void handleDelete(selectedProduct)}>
                {selectedProduct.stock <= 0 ? 'Eliminar agotado' : 'Eliminar'}
              </button>
            </div>
          </div>
        </section>
      ) : null}

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
              canViewProfitMetrics={canViewProfit}
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

            <form
              className={styles.categoryEditor}
              onSubmit={(e) => {
                e.preventDefault();
                if (!categorySaving) {
                  void submitCategory();
                }
              }}
            >
              <input
                type="text"
                value={categoryDraft}
                onChange={(e) => {
                  setCategoryDraft(e.target.value);
                  if (categoryError) {
                    setCategoryError('');
                  }
                }}
                placeholder="Nombre del rubro"
                className={styles.searchInput}
              />
              <button type="submit" className={styles.btnSecondary} disabled={categorySaving}>
                {categorySaving ? 'Guardando...' : editingCategoryId ? 'Guardar' : 'Crear'}
              </button>
              {editingCategoryId ? (
                <button type="button" className={styles.btnSecondary} onClick={resetCategoryEditor}>
                  Cancelar
                </button>
              ) : null}
            </form>

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
