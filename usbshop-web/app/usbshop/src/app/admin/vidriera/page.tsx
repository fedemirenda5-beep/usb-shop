'use client';

import { useEffect, useState } from 'react';
import { fetchApiResponse, getFriendlyApiError } from '@/lib/api';
import styles from './vidriera.module.css';

type Product = { id: number; name: string; sku: string; stock: number; available_stock?: number; is_active: boolean };
type Showcase = { selected: Product[]; legacy_count: number; max_featured: number };

async function readResponse<T>(response: Response): Promise<T> {
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'No se pudo guardar la Vidriera');
  return data;
}

export default function ShowcasePage() {
  const [selected, setSelected] = useState<Product[]>([]);
  const [legacyCount, setLegacyCount] = useState(0);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const [searchError, setSearchError] = useState('');
  const [notice, setNotice] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [searchAttempt, setSearchAttempt] = useState(0);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    fetchApiResponse('/admin/showcase', { signal: controller.signal })
      .then(readResponse<Showcase>)
      .then(data => { if (!controller.signal.aborted) { setSelected(data.selected); setLegacyCount(data.legacy_count); setReady(true); } })
      .catch(err => { if (!controller.signal.aborted) setError(getFriendlyApiError(err, 'No se pudo cargar la Vidriera')); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [attempt]);

  useEffect(() => {
    const controller = new AbortController();
    setSearching(true);
    setSearchError('');
    const timer = setTimeout(() => {
      fetchApiResponse(`/admin/products?q=${encodeURIComponent(query.trim())}&limit=20`, { signal: controller.signal })
        .then(readResponse<Product[]>)
        .then(data => { if (!controller.signal.aborted) setResults(data); })
        .catch(err => { if (!controller.signal.aborted) setSearchError(getFriendlyApiError(err, 'No se pudieron buscar productos')); })
        .finally(() => { if (!controller.signal.aborted) setSearching(false); });
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, searchAttempt]);

  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  function change(next: Product[]) { setSelected(next); setDirty(true); setNotice(''); }
  function move(index: number, step: number) {
    const next = [...selected];
    [next[index], next[index + step]] = [next[index + step], next[index]];
    change(next);
  }
  async function save() {
    setSaving(true); setError(''); setNotice('');
    try {
      const data = await readResponse<Showcase>(await fetchApiResponse('/admin/showcase', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product_ids: selected.map(product => product.id) }),
      }));
      setSelected(data.selected); setLegacyCount(0); setDirty(false);
      setNotice('Vidriera guardada. La tienda mostrará esta selección al actualizarse.');
    } catch (err) { setError(getFriendlyApiError(err, 'No se pudo guardar la Vidriera')); }
    finally { setSaving(false); }
  }

  return <main className={styles.page}>
    <header><h1>Vidriera</h1><p>Elegí hasta 8 destacados y ordenalos. En la tienda se muestran 4 por vez y rotan automáticamente.</p></header>
    <div className={styles.info}>Novedades: los 4 ingresos más recientes con stock; si no alcanzan los de los últimos 14 días, se completa con los anteriores. Volvió a ingresar: productos repuestos desde stock cero en los últimos 7 días. Ambas secciones se actualizan solas.</div>
    {legacyCount > 0 && <p className={styles.warning}>Hay {legacyCount} productos con la marca anterior de destacado. Elegí hasta 8 y guardá tu primera Vidriera. Los anteriores se mantienen hasta que guardes; luego se reemplazan por tu selección.</p>}
    {error && <div role="alert" className={styles.warning}>{error} {!ready && <button onClick={() => setAttempt(value => value + 1)}>Reintentar</button>}</div>}
    {notice && <p role="status">{notice}</p>}
    {loading ? <p role="status">Cargando Vidriera…</p> : <>
      <section className={styles.panel}>
        <div className={styles.heading}><h2>Destacados · {selected.length} de 8</h2><button className={styles.primary} disabled={!ready || saving || (!dirty && !legacyCount)} onClick={save}>{saving ? 'Guardando…' : 'Guardar Vidriera'}</button></div>
        <p>Los productos sin disponibilidad quedan pausados y vuelven a mostrarse cuando tengan stock. Conservan su lugar en la selección.</p>
        {dirty && <p role="status">Tenés cambios sin guardar.</p>}
        {selected.length === 0 && <p>Todavía no elegiste productos. Agregalos desde el buscador.</p>}
        <ol className={styles.list}>{selected.map((product, index) => <li key={product.id}>
          <div className={styles.product}><strong>{index + 1}. {product.name}</strong><span>SKU: {product.sku} · {(product.available_stock ?? product.stock) > 0 && product.is_active ? 'Disponible' : 'Pausado: sin disponibilidad'}</span></div>
          <div className={styles.actions}>
            <button aria-label={`Subir ${product.name}`} disabled={saving || index === 0} onClick={() => move(index, -1)}>↑ Subir</button>
            <button aria-label={`Bajar ${product.name}`} disabled={saving || index === selected.length - 1} onClick={() => move(index, 1)}>↓ Bajar</button>
            <button aria-label={`Quitar ${product.name}`} disabled={saving} onClick={() => change(selected.filter(item => item.id !== product.id))}>Quitar</button>
          </div>
        </li>)}</ol>
      </section>
      <section className={styles.panel}>
        <h2>Agregar productos</h2><label htmlFor="showcase-search">Buscar por nombre o SKU</label>
        <input id="showcase-search" className={styles.search} value={query} onChange={event => setQuery(event.target.value)} placeholder="Buscá el producto que querés destacar" />
        {searchError && <p role="alert">{searchError} <button onClick={() => setSearchAttempt(value => value + 1)}>Reintentar</button></p>}
        {searching ? <p role="status">Buscando…</p> : <ul className={styles.list}>{results.map(product => {
          const added = selected.some(item => item.id === product.id);
          return <li key={product.id}><div className={styles.product}><strong>{product.name}</strong><span>SKU: {product.sku} · Stock disponible: {product.available_stock ?? product.stock}</span></div>
            <button disabled={!ready || saving || added || selected.length >= 8} onClick={() => change([...selected, product])}>{added ? 'Agregado' : 'Agregar'}</button></li>;
        })}</ul>}
        {!searching && !searchError && results.length === 0 && <p>No hay productos para esa búsqueda.</p>}
        {selected.length >= 8 && <p>Completaste los 8 lugares. Quitá un producto para reemplazarlo.</p>}
      </section>
    </>}
  </main>;
}
