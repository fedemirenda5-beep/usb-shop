'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { formatArgentinaDateTime } from '@/lib/datetime';
import styles from './ImeiReport.module.css';

export type ImeiLookupResponse = {
  found: boolean;
  imei: string;
  is_own?: boolean;
  status: 'available' | 'sold' | 'unknown';
  product?: { id?: number | null; name?: string | null; sku?: string | null; category_id?: number | null; category_name?: string | null };
  sale?: { invoice_id?: number | null; sold_at?: string | null; document_type?: string | null; customer_id?: number | null; customer_name?: string | null; customer_phone?: string | null };
  warranty?: { status: string; days: number | null; expires_at: string | null } | null;
  history?: Array<{ id: number; created_at: string; document_type: string; customer_id?: number | null; customer_name?: string | null; customer_phone?: string | null }>;
};

type ReportProps = { result: ImeiLookupResponse; customer?: { id: number; name: string } };

export function ImeiReport({ result, customer }: ReportProps) {
  const sold = result.status === 'sold';
  const warranty = result.warranty;
  const matches = customer && result.sale?.customer_id ? customer.id === result.sale.customer_id : null;
  const warrantyLabel = warranty?.status === 'active' ? 'Vigente' : warranty?.status === 'expired' ? 'Vencida'
    : warranty?.status === 'not_started' ? 'La fecha de venta es futura' : 'Sin plazo registrado';
  if (!result.found) return <section className={styles.report}>
    <h2>IMEI no registrado</h2><p className={styles.imei}>{result.imei}</p>
    <p>No hay un equipo registrado con este número. Revisá el IMEI del teléfono o su caja.</p>
  </section>;
  return <section className={styles.report}>
    <span className={styles.badge}>{sold ? 'Vendido' : 'Disponible'}</span>
    <h2>{result.product?.name || 'Equipo registrado'}</h2>
    <p className={styles.imei}>IMEI {result.imei}</p>
    <p>SKU: {result.product?.sku || 'Sin SKU'}</p>
    {sold ? <>
      {customer && <p role="status" className={matches === false ? styles.warning : styles.match}>
        {matches === true ? `Este equipo corresponde al cliente seleccionado: ${customer.name}.`
          : matches === false ? `Atención: este equipo fue vendido a ${result.sale?.customer_name || 'otro cliente'}, no a ${customer.name}.`
          : 'No hay un identificador de cliente en la venta para compararlo con el seleccionado.'}
      </p>}
      <dl className={styles.details}>
        <div><dt>Cliente de la venta</dt><dd>{result.sale?.customer_name || 'Sin cliente registrado'}</dd></div>
        <div><dt>Teléfono registrado al vender</dt><dd>{result.sale?.customer_phone || 'Sin teléfono registrado'}</dd></div>
        <div><dt>Fecha de venta</dt><dd>{formatArgentinaDateTime(result.sale?.sold_at)}</dd></div>
        <div><dt>Comprobante de venta</dt><dd>{result.sale?.invoice_id ? <Link href={`/admin/comprobantes?invoice=${result.sale.invoice_id}`} target="_blank" rel="noopener noreferrer">Ver comprobante #{result.sale.invoice_id}</Link> : 'Sin comprobante disponible'}</dd></div>
      </dl>
      <h3>Garantía comercial: {warrantyLabel}</h3>
      {warranty?.expires_at ? <p>{warranty.days} días desde la venta. Vence: <strong>{formatArgentinaDateTime(warranty.expires_at)}</strong>.</p>
        : <p>El comprobante no tiene un plazo de garantía guardado. Revisá las condiciones originales.</p>}
      <p className={styles.help}>Compará este IMEI con el del teléfono y los datos del cliente antes de gestionar una devolución o revisar una falla. La vigencia indica el plazo registrado, no el estado físico del equipo.</p>
    </> : <p>Este IMEI no tiene una venta vigente. {result.history?.length ? 'Revisá el historial: puede haber una devolución registrada.' : 'No hay una venta para asociarlo a un cliente.'}</p>}
    <h3>Historial del equipo</h3>
    {result.history?.length ? <ul className={styles.history}>{result.history.map(entry => <li key={entry.id}>
      <strong>{entry.document_type === 'FACTURA' ? 'Venta' : entry.document_type === 'NOTA_CREDITO' ? 'Devolución / nota de crédito' : entry.document_type}</strong>
      <span>{formatArgentinaDateTime(entry.created_at)} · {entry.customer_name || 'Sin cliente registrado'}</span>
      {entry.customer_phone && <span>Teléfono: {entry.customer_phone}</span>}
      <Link href={`/admin/comprobantes?invoice=${entry.id}`} target="_blank" rel="noopener noreferrer">Comprobante #{entry.id}</Link>
    </li>)}</ul> : <p>Sin comprobantes históricos adicionales con este IMEI.</p>}
    {result.product?.id && <Link href={`/admin/productos?edit=${result.product.id}`} target="_blank" rel="noopener noreferrer">Ver producto</Link>}
  </section>;
}

export function ImeiReportDialog({ result, customer, onClose }: ReportProps & { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  return <dialog ref={dialog} className={styles.dialog} aria-label="Informe del equipo escaneado"
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className={styles.header}><strong>Informe del equipo escaneado</strong>
      <button type="button" autoFocus onClick={onClose}>Cerrar informe</button></div>
    <ImeiReport result={result} customer={customer} />
  </dialog>;
}
