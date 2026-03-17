'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getApiBaseUrl, loadRuntimeConfig } from '@/lib/api';
import { useAdminSession } from '@/hooks/useAdminSession';
import styles from './pedidos.module.css';

interface OrderItem {
  product_id: number;
  sku?: string | null;
  name?: string | null;
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
  status: 'PENDING' | 'CONFIRMED' | 'CANCELLED';
  created_at: string;
  confirmed_at: string | null;
  confirmed_invoice_id: string | null;
  items: OrderItem[];
}

const statusColors: Record<string, { bg: string; text: string; label: string }> = {
  PENDING: { bg: 'rgba(249, 115, 22, 0.1)', text: '#ea580c', label: 'Pendiente' },
  CONFIRMED: { bg: 'rgba(132, 204, 22, 0.1)', text: '#3f7d2a', label: 'Confirmado' },
  CANCELLED: { bg: 'rgba(220, 38, 38, 0.1)', text: '#dc2626', label: 'Cancelado' },
};

export default function PedidosPage() {
  useAdminSession();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [detailOrderId, setDetailOrderId] = useState<number | null>(null);

  const loadOrders = async () => {
    try {
      setLoading(true);
      setError('');
      await loadRuntimeConfig();
      const res = await fetch(
        `${getApiBaseUrl()}/admin/orders?status=PENDING&limit=200&include_items=true`,
        { credentials: 'include' }
      );
      if (!res.ok) throw new Error('No se pudieron cargar los pedidos');
      const data = await res.json();
      setOrders(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error cargando pedidos');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadOrders();
  }, []);

  const formatDate = (dateStr: string) => {
    if (!dateStr) return '-';
    return new Date(dateStr).toLocaleDateString('es-AR', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div>
          <h1>Pedidos</h1>
          <p>Vista enfocada solo en pedidos pendientes de confirmar.</p>
        </div>
      </div>

      {error ? <div className={styles.error}>{error}</div> : null}

      <div className={styles.tableWrapper}>
        {loading ? (
          <div className={styles.loading}>Cargando pedidos...</div>
        ) : orders.length === 0 ? (
          <div className={styles.empty}>
            <p>No hay pedidos pendientes.</p>
          </div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>ID</th>
                <th>Cliente</th>
                <th>Email</th>
                <th>Total</th>
                <th>Fecha</th>
                <th>Estado</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {orders.flatMap((order) => {
                const color = statusColors[order.status];
                const rows = [
                  <tr key={`row-${order.id}`} className={styles.orderRow}>
                    <td>#{order.id}</td>
                    <td className={styles.name}>{order.customer_name}</td>
                    <td className={styles.email}>{order.customer_email || '-'}</td>
                    <td className={styles.total}>${order.total.toFixed(2)}</td>
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
                        Ver
                      </button>
                      {order.status === 'PENDING' ? (
                        <Link href={`/admin/generar-comprobante?order_id=${order.id}`} className={styles.btnInvoice}>
                          Generar comprobante
                        </Link>
                      ) : null}
                    </td>
                  </tr>,
                ];

                if (detailOrderId === order.id) {
                  rows.push(
                    <tr key={`detail-${order.id}`} className={styles.detailsRow}>
                      <td colSpan={7}>
                        <div className={styles.detailsContent}>
                          <div className={styles.detailsColumns}>
                            <div className={styles.detailColumn}>
                              <h4>Informacion del cliente:</h4>
                              <p><strong>Nombre:</strong> {order.customer_name}</p>
                              <p><strong>Email:</strong> {order.customer_email || '-'}</p>
                              <p><strong>Telefono:</strong> {order.customer_phone || '-'}</p>
                            </div>

                            <div className={styles.detailColumn}>
                              <h4>Informacion del pedido:</h4>
                              <p><strong>Creado:</strong> {formatDate(order.created_at)}</p>
                              {order.confirmed_at ? (
                                <p><strong>Confirmado:</strong> {formatDate(order.confirmed_at)}</p>
                              ) : null}
                              {order.confirmed_invoice_id ? (
                                <p><strong>Comprobante asociado:</strong> {order.confirmed_invoice_id}</p>
                              ) : null}
                              {order.notes ? <p><strong>Notas:</strong> {order.notes}</p> : null}
                            </div>
                          </div>

                          {order.items.length > 0 ? (
                            <div className={styles.itemsSection}>
                              <h4>Items:</h4>
                              <table className={styles.itemsTable}>
                                <thead>
                                  <tr>
                                    <th>Producto</th>
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
                                      <td>{item.sku || '-'}</td>
                                      <td>{item.quantity}</td>
                                      <td>${item.unit_price.toFixed(2)}</td>
                                      <td>${(item.quantity * item.unit_price).toFixed(2)}</td>
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
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
