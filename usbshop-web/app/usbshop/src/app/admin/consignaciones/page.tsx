'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { consignmentRequest, type Consignment, type ConsignmentDetail } from '@/lib/consignments';
import { createOrderIdempotencyKey } from '@/lib/api';
import { formatArgentinaDateTime } from '@/lib/datetime';
import { ADMIN_LIMITS } from '../adminConfig';
import styles from './consignaciones.module.css';

type Customer = { id: number; name: string };
type Product = { id: number; name: string; stock: number; available_stock: number; is_bundle?: boolean };
type Draft = Product & { quantity: number };
const movementLabels: Record<string, string> = { DELIVERY: 'Entrega', RETURN: 'Devolución', SALE: 'Venta', SALE_CANCEL: 'Venta cancelada' };

export default function ConsignacionesPage() {
  const searchParams = useSearchParams();
  const [rows, setRows] = useState<Consignment[]>([]);
  const [query, setQuery] = useState(searchParams?.get('q') || '');
  const [pendingOnly, setPendingOnly] = useState(true);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [customerQuery, setCustomerQuery] = useState('');
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [productQuery, setProductQuery] = useState('');
  const [products, setProducts] = useState<Product[]>([]);
  const [draft, setDraft] = useState<Draft[]>([]);
  const [notes, setNotes] = useState('');
  const [detail, setDetail] = useState<ConsignmentDetail | null>(null);
  const [returns, setReturns] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null);
  const detailRequest = useRef(0);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ q: query, pending_only: String(pendingOnly), limit: String(ADMIN_LIMITS.consignmentsList), offset: String(offset) });
      void consignmentRequest<Consignment[]>(`/admin/consignments?${params}`).then((data) => {
        if (active) setRows(data);
      }).catch((err) => { if (active) setError(err.message); }).finally(() => { if (active) setLoading(false); });
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [query, pendingOnly, offset, revision]);

  useEffect(() => {
    let active = true;
    if (!customerQuery.trim() || customer) { setCustomers([]); return; }
    const timer = setTimeout(() => {
      void consignmentRequest<Customer[]>(`/admin/backoffice-customers?q=${encodeURIComponent(customerQuery)}&limit=${ADMIN_LIMITS.scannerLookup}`)
        .then((data) => { if (active) setCustomers(data); }).catch((err) => { if (active) setError(err.message); });
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [customerQuery, customer]);

  useEffect(() => {
    let active = true;
    if (!productQuery.trim()) { setProducts([]); return; }
    const timer = setTimeout(() => {
      void consignmentRequest<Product[]>(`/admin/products?q=${encodeURIComponent(productQuery)}&limit=${ADMIN_LIMITS.scannerLookup}`)
        .then((data) => { if (active) setProducts(data); }).catch((err) => { if (active) setError(err.message); });
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [productQuery, revision]);

  const openDetail = async (id: number) => {
    const request = ++detailRequest.current;
    setError(''); setDetail(null); setReturns({});
    try {
      const data = await consignmentRequest<ConsignmentDetail>(`/admin/consignments/${id}`);
      if (request === detailRequest.current) setDetail(data);
    } catch (err) { if (request === detailRequest.current) setError((err as Error).message); }
  };

  const save = async (kind: 'create' | 'return') => {
    if (busyRef.current) return;
    const path = kind === 'create' ? '/admin/consignments' : `/admin/consignments/${detail?.id}/returns`;
    const payload = kind === 'create' ? {
      customer_id: customer?.id, notes, items: draft.map((item) => ({ product_id: item.id, quantity: item.quantity })),
    } : { items: Object.entries(returns).filter(([, qty]) => Number(qty) > 0).map(([id, qty]) => ({ product_id: Number(id), quantity: Number(qty) })) };
    const fingerprint = JSON.stringify({ path, payload });
    if (attempt.current?.fingerprint !== fingerprint) attempt.current = { fingerprint, key: createOrderIdempotencyKey() };
    busyRef.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const data = await consignmentRequest<ConsignmentDetail>(path, { ...payload, idempotency_key: attempt.current.key });
      ++detailRequest.current;
      setDetail(data); setReturns({}); setRevision((value) => value + 1); attempt.current = null;
      if (kind === 'create') { setShowCreate(false); setDraft([]); setCustomer(null); setCustomerQuery(''); setNotes(''); }
      setNotice(kind === 'create' ? 'Entrega registrada. Las unidades quedaron reservadas para el cliente.' : 'Devolución registrada. Las unidades vuelven a estar disponibles.');
    } catch (err) { setError((err as Error).message); }
    finally { busyRef.current = false; setBusy(false); }
  };

  useEffect(() => {
    const id = Number(searchParams?.get('consignment_id') || 0);
    if (id > 0) void openDetail(id);
  }, [searchParams]);

  return <div className={styles.page}>
    <header className={styles.panel}>
      <h1>Consignaciones</h1>
      <p>Mercadería que sigue siendo parte del stock general y está reservada en poder de tus clientes.</p>
      <div><button className={styles.primary} onClick={() => setShowCreate(!showCreate)} disabled={busy}>{showCreate ? 'Cerrar nueva entrega' : 'Nueva entrega'}</button></div>
    </header>
    {error && <div className={styles.error} role="alert">{error}</div>}
    {notice && <div className={styles.notice} role="status">{notice}</div>}
    {showCreate && <form className={styles.panel} onSubmit={(event) => { event.preventDefault(); void save('create'); }}>
      <h2>Nueva entrega en consignación</h2>
      <p>Se reserva stock disponible. Si la mercadería ya fue entregada, verificá que todavía esté incluida en el stock general antes de registrarla.</p>
      <label>Buscar cliente<input value={customerQuery} disabled={busy} required onChange={(event) => { setCustomer(null); setCustomerQuery(event.target.value); }} /></label>
      <div className={styles.results}>{customers.map((item) => <button type="button" key={item.id} onClick={() => { setCustomer(item); setCustomerQuery(item.name); }}>{item.name}</button>)}</div>
      {customer && <strong>Cliente: {customer.name}</strong>}
      <label>Buscar producto<input value={productQuery} disabled={busy} onChange={(event) => setProductQuery(event.target.value)} /></label>
      <div className={styles.results}>{products.map((product) => <button key={product.id} type="button" disabled={busy || product.available_stock <= 0} onClick={() => setDraft((current) => current.some((item) => item.id === product.id) ? current : [...current, { ...product, quantity: 1 }])}>
        {product.name} · General: {product.stock} · Disponible: {product.available_stock}{product.is_bundle ? ' · Se reservan sus componentes' : ''}
      </button>)}</div>
      <div className={styles.tableWrap}><table><thead><tr><th>Producto</th><th>Unidades</th><th /></tr></thead><tbody>{draft.map((item) => <tr key={item.id}>
        <td>{item.name}</td><td><input aria-label={`Cantidad de ${item.name}`} type="number" min="1" max={item.available_stock} step="1" required disabled={busy} value={item.quantity || ''} onChange={(event) => setDraft((current) => current.map((entry) => entry.id === item.id ? { ...entry, quantity: Number(event.target.value) } : entry))} /></td>
        <td><button type="button" disabled={busy} onClick={() => setDraft((current) => current.filter((entry) => entry.id !== item.id))}>Quitar</button></td>
      </tr>)}</tbody></table></div>
      <label>Notas / referencia del presupuesto (opcional)<textarea value={notes} disabled={busy} onChange={(event) => setNotes(event.target.value)} /></label>
      <div><button className={styles.primary} disabled={busy || !customer || !draft.length}>{busy ? 'Guardando...' : 'Registrar entrega y reservar'}</button></div>
    </form>}
    <section className={styles.panel}>
      <h2>Mercadería por cliente</h2>
      <div className={styles.row}>
        <label>Buscar cliente, producto o SKU<input value={query} onChange={(event) => { setQuery(event.target.value); setOffset(0); }} /></label>
        <label>Estado<select value={String(pendingOnly)} onChange={(event) => { setPendingOnly(event.target.value === 'true'); setOffset(0); }}><option value="true">Con unidades pendientes</option><option value="false">Todas las entregas</option></select></label>
      </div>
      {loading ? <p role="status">Cargando consignaciones...</p> : <>
        <div className={styles.tableWrap}><table><thead><tr><th>Entrega</th><th>Cliente</th><th>Fecha</th><th>Entregadas</th><th>Vendidas</th><th>Devueltas</th><th>Pendientes</th><th /></tr></thead><tbody>{rows.map((row) => <tr key={row.id}>
          <td>#{row.id}</td><td>{row.customer_name}</td><td>{formatArgentinaDateTime(row.created_at)}</td><td>{row.delivered}</td><td>{row.sold}</td><td>{row.returned}</td><td><strong>{row.pending}</strong></td><td><button disabled={busy} onClick={() => void openDetail(row.id)}>Ver detalle</button></td>
        </tr>)}</tbody></table></div>
        {!rows.length && <p>No hay consignaciones para esta búsqueda.</p>}
      </>}
      <div className={styles.row}><button disabled={!offset || loading} onClick={() => setOffset(Math.max(0, offset - ADMIN_LIMITS.consignmentsList))}>Anterior</button><button disabled={rows.length < ADMIN_LIMITS.consignmentsList || loading} onClick={() => setOffset(offset + ADMIN_LIMITS.consignmentsList)}>Siguiente</button></div>
    </section>
    {detail && <section className={styles.panel}>
      <h2>Entrega #{detail.id} · {detail.customer_name}</h2>
      <p>{detail.notes}</p>
      <p>Pendientes en poder del cliente: <strong>{detail.pending}</strong></p>
      {detail.pending > 0 && <div><Link className={styles.action} href={`/admin/generar-comprobante?customer_id=${detail.customer_id}&consignment_id=${detail.id}`}>Emitir venta de esta consignación</Link></div>}
      <form onSubmit={(event) => { event.preventDefault(); void save('return'); }}>
        <div className={styles.tableWrap}><table><thead><tr><th>Producto</th><th>Entregadas</th><th>Vendidas</th><th>Devueltas</th><th>Pendientes</th><th>Devolver ahora</th></tr></thead><tbody>{detail.items.map((item) => <tr key={item.product_id}>
          <td>{item.name}<br /><small>{item.sku}</small></td><td>{item.delivered}</td><td>{item.sold}</td><td>{item.returned}</td><td>{item.pending}</td><td><input aria-label={`Devolver ${item.name}`} type="number" min="0" max={item.pending} step="1" disabled={busy || !item.pending} value={returns[item.product_id] || ''} onChange={(event) => setReturns((current) => ({ ...current, [item.product_id]: event.target.value }))} /></td>
        </tr>)}</tbody></table></div>
        <button disabled={busy || !Object.values(returns).some((qty) => Number(qty) > 0)}>Registrar devolución</button>
      </form>
      <h2>Historial</h2>
      <div className={styles.tableWrap}><table><thead><tr><th>Fecha</th><th>Movimiento</th><th>Producto</th><th>Unidades</th><th>Comprobante</th></tr></thead><tbody>{detail.movements.map((item) => <tr key={item.id}>
        <td>{formatArgentinaDateTime(item.created_at)}</td><td>{movementLabels[item.kind] || item.kind}</td><td>{item.name}</td><td>{item.quantity}</td><td>{item.invoice_id ? `#${item.invoice_id}` : '—'}</td>
      </tr>)}</tbody></table></div>
    </section>}
  </div>;
}
