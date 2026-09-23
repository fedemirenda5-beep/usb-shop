'use client';

import Link from 'next/link';
import { ImeiReturnLink } from '@/components/ImeiReport';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import { fetchApiResponse, getFriendlyApiError } from '@/lib/api';
import { formatArgentinaDateTime } from '@/lib/datetime';
import styles from './imeis.module.css';

type Lookup = {
  found: boolean;
  imei: string;
  status: 'available' | 'sold' | 'unknown';
  product?: { id: number; name: string; sku?: string };
  sale?: { invoice_id?: number; sold_at?: string; customer_name?: string; customer_phone?: string };
  warranty?: { status: string; days: number | null; expires_at: string | null } | null;
  history?: Array<{ id: number; created_at: string; document_type: string; customer_name?: string; customer_phone?: string }>;
};

export default function ImeisPage() {
  const params = useSearchParams();
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<Lookup | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestId = useRef(0);
  const input = useRef<HTMLInputElement>(null);

  const lookup = async (value: string) => {
    const id = ++requestId.current;
    const imei = value.replace(/\D/g, '');
    setResult(null);
    setError('');
    if (!imei) { setLoading(false); setError('Escanea o escribí el IMEI del equipo.'); return; }
    setLoading(true);
    try {
      const res = await fetchApiResponse(`/admin/imei-lookup?${new URLSearchParams({ q: imei })}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'No se pudo consultar el IMEI');
      if (id === requestId.current) setResult(data);
    } catch (err) {
      if (id === requestId.current) setError(getFriendlyApiError(err, 'No se pudo consultar el IMEI'));
    } finally {
      if (id === requestId.current) { setLoading(false); input.current?.focus(); input.current?.select(); }
    }
  };

  useEffect(() => {
    const imei = params.get('q');
    if (imei) { setQuery(imei); void lookup(imei); }
    else input.current?.focus();
    return () => { requestId.current += 1; };
  }, [params]);

  const submit = (event: FormEvent) => { event.preventDefault(); void lookup(query); };
  const warranty = result?.warranty;
  const warrantyLabel = warranty?.status === 'active' ? 'Vigente'
    : warranty?.status === 'expired' ? 'Vencida'
    : warranty?.status === 'not_started' ? 'La fecha de venta es futura' : 'Sin plazo registrado';

  return <main className={styles.page}>
    <header><h1>IMEI y garantías</h1><p>Escaneá el equipo para saber a quién se vendió, cuándo y hasta qué fecha tiene garantía comercial.</p></header>
    <form onSubmit={submit} className={styles.search}>
      <label htmlFor="imei-search">IMEI del equipo</label>
      <div><input ref={input} id="imei-search" inputMode="numeric" autoComplete="off" value={query}
        onChange={event => { setQuery(event.target.value); setResult(null); requestId.current += 1; setLoading(false); }}
        placeholder="Escanear o escribir IMEI" />
        <button disabled={loading}>{loading ? 'Consultando…' : 'Consultar'}</button></div>
      <small>Con lector: escaneá y presioná Enter. Usá el mismo IMEI registrado al ingresar el celular.</small>
    </form>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    <section aria-live="polite">
      {result && !result.found && <article className={styles.card}><h2>IMEI no registrado</h2><p>{result.imei}</p><p>Revisá el número o cargalo en el producto antes de vender el equipo.</p><Link href="/admin/productos">Ir a productos</Link></article>}
      {result?.found && <>
        <article className={styles.card}>
          <span className={styles.badge}>{result.status === 'sold' ? 'Vendido' : 'Disponible'}</span>
          <h2>{result.product?.name}</h2><p className={styles.imei}>{result.imei}</p>
          {result.status === 'sold' ? <dl className={styles.details}>
            <div><dt>Cliente de la venta</dt><dd>{result.sale?.customer_name || 'Sin cliente registrado'}</dd></div>
            <div><dt>Teléfono</dt><dd>{result.sale?.customer_phone || 'Sin teléfono registrado'}</dd></div>
            <div><dt>Fecha de venta</dt><dd>{formatArgentinaDateTime(result.sale?.sold_at)}</dd></div>
            <div><dt>Comprobante</dt><dd><Link href={`/admin/comprobantes?invoice=${result.sale?.invoice_id}`}>Ver comprobante #{result.sale?.invoice_id}</Link></dd></div>
          </dl> : <p>Este IMEI está disponible y no tiene una venta vigente.</p>}
          <Link href={`/admin/productos?edit=${result.product?.id}`}>Ver producto</Link>
          {result.status === 'sold' && result.sale?.invoice_id && <ImeiReturnLink imei={result.imei} invoiceId={result.sale.invoice_id} />}
        </article>
        {result.status === 'sold' && <article className={styles.card}>
          <h2>Garantía comercial: {warrantyLabel}</h2>
          {warranty?.expires_at ? <p>{warranty.days} días desde la venta. Vencimiento: <strong>{formatArgentinaDateTime(warranty.expires_at)}</strong>.</p>
            : <p>Este comprobante es anterior al registro del plazo de garantía. Revisá las condiciones del comprobante original.</p>}
          <small>La cobertura depende de las condiciones del comprobante y de la revisión del equipo.</small>
        </article>}
        <article className={styles.card}><h2>Historial del equipo</h2>
          {result.history?.length ? <ul className={styles.history}>{result.history.map(entry => <li key={entry.id}>
            <strong>{entry.document_type === 'FACTURA' ? 'Venta' : 'Devolución / nota de crédito'}</strong>
            <span>{formatArgentinaDateTime(entry.created_at)} · {entry.customer_name || 'Sin cliente registrado'}</span>
            <Link href={`/admin/comprobantes?invoice=${entry.id}`}>Comprobante #{entry.id}</Link>
          </li>)}</ul> : <p>Sin comprobantes históricos con este IMEI.</p>}
        </article>
      </>}
    </section>
  </main>;
}
