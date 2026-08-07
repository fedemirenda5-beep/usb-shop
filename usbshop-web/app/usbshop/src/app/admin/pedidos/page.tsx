'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ensureApiBaseUrl, fetchApiResponse, getApiBaseUrl, getFriendlyApiError } from '@/lib/api';
import { ARGENTINA_TZ } from '@/lib/datetime';
import { useAdminSession } from '@/hooks/useAdminSession';
import { ADMIN_LIMITS } from '../adminConfig';
import styles from './pedidos.module.css';

interface OrderItem {
  product_id: number;
  sku?: string | null;
  name?: string | null;
  category_id?: number | null;
  category_name?: string | null;
  requires_imei?: boolean;
  quantity: number;
  unit_price: number;
}

interface Order {
  id: number;
  customer_name: string;
  customer_phone: string;
  customer_email: string;
  notes: string;
  total: number;
  status: 'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'BUDGETED';
  created_at: string;
  confirmed_at: string | null;
  confirmed_invoice_id: string | null;
  items: OrderItem[];
}

const statusColors: Record<string, { bg: string; text: string; label: string }> = {
  PENDING: { bg: 'rgba(249, 115, 22, 0.12)', text: '#c2410c', label: 'Pendiente' },
  CONFIRMED: { bg: 'rgba(34, 197, 94, 0.12)', text: '#15803d', label: 'Procesada' },
  BUDGETED: { bg: 'rgba(59, 130, 246, 0.12)', text: '#1d4ed8', label: 'Presupuestada' },
  CANCELLED: { bg: 'rgba(220, 38, 38, 0.12)', text: '#b91c1c', label: 'Cancelada' },
};

const money = (value: number) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(value || 0);

export default function PedidosPage() {
  useAdminSession();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [detailOrderId, setDetailOrderId] = useState<number | null>(null);
  const [deletingOrderId, setDeletingOrderId] = useState<number | null>(null);
  const [pendingDeleteOrder, setPendingDeleteOrder] = useState<Order | null>(null);

  const loadOrders = async (signal?: AbortSignal) => {
    try {
      setLoading(true);
      setError('');
      const res = await fetchApiResponse(
        `/admin/orders?status=ALL&limit=${ADMIN_LIMITS.ordersList}&include_items=true`,
        { signal }
      );
      if (!res.ok) throw new Error('No se pudieron cargar las ordenes de compra');
      const data = await res.json();
      if (signal?.aborted) return;
      setOrders(data);
    } catch (err) {
      if (signal?.aborted) return;
      setError(getFriendlyApiError(err, 'Error cargando ordenes de compra'));
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    void loadOrders(controller.signal);
    return () => controller.abort();
  }, []);

  const pendingOrders = useMemo(() => orders.filter((order) => order.status === 'PENDING'), [orders]);
  const historicalOrders = useMemo(() => orders.filter((order) => order.status !== 'PENDING'), [orders]);

  const summary = useMemo(
    () => ({
      total: orders.length,
      pending: pendingOrders.length,
      processed: historicalOrders.length,
      confirmed: orders.filter((order) => order.status === 'CONFIRMED').length,
      cancelled: orders.filter((order) => order.status === 'CANCELLED').length,
    }),
    [historicalOrders.length, orders, pendingOrders.length]
  );

  const formatDate = (dateStr: string) => {
    if (!dateStr) return '-';
    return new Date(dateStr).toLocaleDateString('es-AR', {
      timeZone: ARGENTINA_TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const deleteOrder = async (order: Order) => {
    try {
      setDeletingOrderId(order.id);
      setError('');
      await ensureApiBaseUrl();
      const res = await fetch(`${getApiBaseUrl()}/admin/orders/${order.id}/status`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'DELETED' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || 'No se pudo eliminar la orden de compra');
      setPendingDeleteOrder(null);
      setDetailOrderId((current) => (current === order.id ? null : current));
      await loadOrders();
    } catch (err) {
      setError(getFriendlyApiError(err, 'Error eliminando orden de compra'));
    } finally {
      setDeletingOrderId(null);
    }
  };

  const orderRequiresImei = (order: Order) => order.items.some((item) => item.requires_imei);

  const renderRows = (source: Order[], history = false) =>
    source.flatMap((order) => {
      const color = statusColors[order.status];
      const requiresImei = orderRequiresImei(order);
      const rows = [
        <tr key={`row-${history ? 'history' : 'pending'}-${order.id}`} className={styles.orderRow}>
          <td className={styles.orderCode}>Orden de compra #{order.id}</td>
          <td className={styles.name}>{order.customer_name}</td>
          <td className={styles.email}>{order.customer_email || '-'}</td>
          <td className={styles.total}>{money(order.total)}</td>
          <td className={styles.date}>{formatDate(order.created_at)}</td>
          <td>
            <span className={styles.statusBadge} style={{ background: color.bg, color: color.text }}>
              {color.label}
            </span>
          </td>
          <td className={styles.actions}>
            <button
              className={styles.btnDetails}
              onClick={() => setDetailOrderId(detailOrderId === order.id ? null : order.id)}
            >
              Ver detalle
            </button>
            {order.status === 'PENDING' ? (
              <Link href={`/admin/generar-comprobante?order_id=${order.id}`} className={styles.btnInvoice}>
                {requiresImei ? 'Escanear IMEIs y emitir' : 'Procesar orden'}
              </Link>
            ) : null}
            <button
              className={styles.btnDelete}
              onClick={() => setPendingDeleteOrder(order)}
              disabled={deletingOrderId === order.id}
            >
              {deletingOrderId === order.id ? 'Eliminando...' : 'Eliminar'}
            </button>
          </td>
        </tr>,
      ];

      if (detailOrderId === order.id) {
        rows.push(
          <tr key={`detail-${history ? 'history' : 'pending'}-${order.id}`} className={styles.detailsRow}>
            <td colSpan={7}>
              <div className={styles.detailsContent}>
                <div className={styles.detailsColumns}>
                  <div className={styles.detailColumn}>
                    <h4>Cliente</h4>
                    <p><strong>Nombre:</strong> {order.customer_name}</p>
                    <p><strong>Email:</strong> {order.customer_email || '-'}</p>
                    <p><strong>Telefono:</strong> {order.customer_phone || '-'}</p>
                  </div>

                  <div className={styles.detailColumn}>
                    <h4>Orden de compra</h4>
                    <p><strong>Ingreso:</strong> {formatDate(order.created_at)}</p>
                    <p><strong>Estado:</strong> {color.label}</p>
                    {order.confirmed_at ? (
                      <p><strong>Procesada:</strong> {formatDate(order.confirmed_at)}</p>
                    ) : null}
                    {order.confirmed_invoice_id ? (
                      <p><strong>Comprobante emitido:</strong> #{order.confirmed_invoice_id}</p>
                    ) : null}
                    {order.notes ? <p><strong>Observaciones:</strong> {order.notes}</p> : null}
                  </div>
                </div>

                {order.items.length > 0 ? (
                  <div className={styles.itemsSection}>
                    <div className={styles.itemsHeader}>
                      <h4>Detalle de articulos</h4>
                      {requiresImei ? <span className={styles.imeiBadge}>Requiere IMEIs</span> : null}
                    </div>
                    {requiresImei ? (
                      <div className={styles.imeiHint}>
                        Este pedido tiene celulares. Desde este mismo pedido usa <strong>Escanear IMEIs y emitir</strong> para cargar los IMEIs antes de confirmar.
                      </div>
                    ) : null}
                    <table className={styles.itemsTable}>
                      <thead>
                        <tr>
                          <th>Producto</th>
                          <th>Categoria</th>
                          <th>SKU</th>
                          <th>Cantidad</th>
                          <th>Precio unitario</th>
                          <th>Subtotal</th>
                        </tr>
                      </thead>
                      <tbody>
                        {order.items.map((item, idx) => (
                          <tr key={`${order.id}-${idx}`}>
                            <td>{item.name || `Producto ${item.product_id}`}</td>
                            <td>{item.category_name || '-'}</td>
                            <td>{item.sku || '-'}</td>
                            <td>{item.quantity}</td>
                            <td>{money(item.unit_price)}</td>
                            <td>{money(item.quantity * item.unit_price)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
              </div>
            </td>
          </tr>
        );
      }

      return rows;
    });

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div>
          <h1>Pedidos Web</h1>
          <p>Vista operativa con ordenes pendientes al frente e historial separado para evitar confusiones.</p>
        </div>
      </div>

      {error ? <div className={styles.error}>{error}</div> : null}

      <section className={styles.summaryGrid}>
        <article className={styles.summaryCard}>
          <span>Ordenes ingresadas</span>
          <strong>{summary.total}</strong>
        </article>
        <article className={styles.summaryCard}>
          <span>Pendientes</span>
          <strong>{summary.pending}</strong>
        </article>
        <article className={styles.summaryCard}>
          <span>Procesadas</span>
          <strong>{summary.confirmed}</strong>
        </article>
        <article className={styles.summaryCard}>
          <span>Canceladas</span>
          <strong>{summary.cancelled}</strong>
        </article>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <div>
            <h2>Pendientes</h2>
            <p>Solo aparecen las ordenes de compra que todavia necesitan atencion.</p>
          </div>
          <span className={styles.sectionCount}>{summary.pending} pendientes</span>
        </div>

        <div className={styles.tableWrapper}>
          {loading ? (
            <div className={styles.loading}>Cargando ordenes pendientes...</div>
          ) : pendingOrders.length === 0 ? (
            <div className={styles.empty}>
              <p>No hay ordenes de compra pendientes.</p>
            </div>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Orden</th>
                  <th>Cliente</th>
                  <th>Email</th>
                  <th>Total</th>
                  <th>Ingreso</th>
                  <th>Estado</th>
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>{renderRows(pendingOrders)}</tbody>
            </table>
          )}
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <div>
            <h2>Historial de ordenes</h2>
            <p>Ordenes ya procesadas o canceladas, separadas de la operacion principal.</p>
          </div>
          <span className={styles.sectionCount}>{summary.processed} en historial</span>
        </div>

        <details className={styles.historyDisclosure}>
          <summary className={styles.historySummary}>Ver historial</summary>
          <div className={styles.tableWrapper}>
            {loading ? (
              <div className={styles.loading}>Cargando historial...</div>
            ) : historicalOrders.length === 0 ? (
              <div className={styles.empty}>
                <p>No hay ordenes en historial.</p>
              </div>
            ) : (
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Orden</th>
                    <th>Cliente</th>
                    <th>Email</th>
                    <th>Total</th>
                    <th>Ingreso</th>
                    <th>Estado</th>
                    <th>Acciones</th>
                  </tr>
                </thead>
                <tbody>{renderRows(historicalOrders, true)}</tbody>
              </table>
            )}
          </div>
        </details>
      </section>

      {pendingDeleteOrder ? (
        <div className={styles.modalOverlay} onClick={() => (deletingOrderId ? null : setPendingDeleteOrder(null))}>
          <aside className={styles.confirmModal} onClick={(event) => event.stopPropagation()}>
            <div className={styles.confirmHeader}>
              <h2>Eliminar pedido web</h2>
              <p>Usalo para pedidos duplicados o cargados por error. Si ya fue procesado con comprobante, el sistema no lo va a dejar borrar.</p>
            </div>
            <div className={styles.confirmBody}>
              <div className={styles.confirmCard}>
                <span>Orden</span>
                <strong>Orden de compra #{pendingDeleteOrder.id}</strong>
              </div>
              <div className={styles.confirmCard}>
                <span>Cliente</span>
                <strong>{pendingDeleteOrder.customer_name}</strong>
              </div>
              <div className={styles.confirmCard}>
                <span>Total</span>
                <strong>{money(pendingDeleteOrder.total)}</strong>
              </div>
            </div>
            <div className={styles.confirmActions}>
              <button
                type="button"
                className={styles.btnDetails}
                onClick={() => setPendingDeleteOrder(null)}
                disabled={deletingOrderId === pendingDeleteOrder.id}
              >
                Cancelar
              </button>
              <button
                type="button"
                className={styles.btnDelete}
                onClick={() => void deleteOrder(pendingDeleteOrder)}
                disabled={deletingOrderId === pendingDeleteOrder.id}
              >
                {deletingOrderId === pendingDeleteOrder.id ? 'Eliminando...' : 'Confirmar eliminacion'}
              </button>
            </div>
          </aside>
        </div>
      ) : null}
    </div>
  );
}
