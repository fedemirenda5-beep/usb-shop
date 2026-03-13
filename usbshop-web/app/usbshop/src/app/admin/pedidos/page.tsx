'use client';

import { useState, useEffect } from 'react';
import { useAdminSession } from '@/hooks/useAdminSession';
import styles from './pedidos.module.css';

interface OrderItem {
  product_id: number;
  product_name: string;
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

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:8000';

const statusColors: Record<string, { bg: string; text: string; label: string }> = {
  PENDING: { bg: 'rgba(249, 115, 22, 0.1)', text: '#ea580c', label: 'Pendiente' },
  CONFIRMED: { bg: 'rgba(132, 204, 22, 0.1)', text: '#3f7d2a', label: 'Confirmado' },
  CANCELLED: { bg: 'rgba(220, 38, 38, 0.1)', text: '#dc2626', label: 'Cancelado' },
};

const statusOptions = [
  { value: 'PENDING', label: 'Pendiente' },
  { value: 'CONFIRMED', label: 'Confirmado' },
  { value: 'CANCELLED', label: 'Cancelado' },
];

export default function PedidosPage() {
  const { user } = useAdminSession();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedStatus, setSelectedStatus] = useState('PENDING');
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [detailOrder, setDetailOrder] = useState<Order | null>(null);

  const loadOrders = async (status: string) => {
    try {
      setLoading(true);
      setError('');

      const res = await fetch(
        `${API_BASE}/admin/orders?status=${status}&limit=200&include_items=true`,
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
    loadOrders(selectedStatus);
  }, [selectedStatus]);

  const handleStatusChange = async (orderId: number, newStatus: string) => {
    try {
      const res = await fetch(`${API_BASE}/admin/orders/${orderId}/status`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });

      if (!res.ok) throw new Error('No se pudo actualizar el estado');

      // Si el estado cambia, recarga la lista
      loadOrders(selectedStatus);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error actualizando estado');
    }
  };

  const formatDate = (dateStr: string) => {
    if (!dateStr) return '-';
    return new Date(dateStr).toLocaleDateString('es-ES', {
      month: '2-digit',
      day: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div>
          <h1>Pedidos</h1>
          <p>Gestiona los pedidos de clientes</p>
        </div>
      </div>

      {error && <div className={styles.error}>{error}</div>}

      {/* Status Filter */}
      <div className={styles.filterBar}>
        {statusOptions.map((opt) => (
          <button
            key={opt.value}
            className={`${styles.filterBtn} ${
              selectedStatus === opt.value ? styles.active : ''
            }`}
            onClick={() => setSelectedStatus(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Orders Table */}
      <div className={styles.tableWrapper}>
        {loading ? (
          <div className={styles.loading}>Cargando pedidos...</div>
        ) : orders.length === 0 ? (
          <div className={styles.empty}>
            <p>No hay pedidos {statusOptions.find((o) => o.value === selectedStatus)?.label.toLowerCase()}</p>
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
              {orders.map((order) => {
                const color = statusColors[order.status];
                return (
                  <tbody key={order.id}>
                    <tr className={styles.orderRow}>
                      <td>#{order.id}</td>
                      <td className={styles.name}>{order.customer_name}</td>
                      <td className={styles.email}>{order.customer_email}</td>
                      <td className={styles.total}>${order.total.toFixed(2)}</td>
                      <td className={styles.date}>{formatDate(order.created_at)}</td>
                      <td>
                        <span
                          className={styles.statusBadge}
                          style={{ background: color.bg, color: color.text }}
                        >
                          {color.label}
                        </span>
                      </td>
                      <td className={styles.actions}>
                        <button
                          className={styles.btnDetails}
                          onClick={() => setDetailOrder(detailOrder?.id === order.id ? null : order)}
                        >
                          📋
                        </button>
                        <select
                          className={styles.statusSelect}
                          value={order.status}
                          onChange={(e) => handleStatusChange(order.id, e.target.value)}
                        >
                          {statusOptions.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>

                    {/* Details Row */}
                    {detailOrder?.id === order.id && (
                      <tr className={styles.detailsRow}>
                        <td colSpan={7}>
                          <div className={styles.detailsContent}>
                            <div className={styles.detailsColumns}>
                              <div className={styles.detailColumn}>
                                <h4>Información del cliente:</h4>
                                <p>
                                  <strong>Nombre:</strong> {order.customer_name}
                                </p>
                                <p>
                                  <strong>Email:</strong> {order.customer_email}
                                </p>
                                <p>
                                  <strong>Teléfono:</strong> {order.customer_phone || '-'}
                                </p>
                              </div>

                              <div className={styles.detailColumn}>
                                <h4>Información del pedido:</h4>
                                <p>
                                  <strong>Creado:</strong> {formatDate(order.created_at)}
                                </p>
                                {order.confirmed_at && (
                                  <p>
                                    <strong>Confirmado:</strong> {formatDate(order.confirmed_at)}
                                  </p>
                                )}
                                {order.notes && (
                                  <p>
                                    <strong>Notas:</strong> {order.notes}
                                  </p>
                                )}
                              </div>
                            </div>

                            {/* Items */}
                            {order.items && order.items.length > 0 && (
                              <div className={styles.itemsSection}>
                                <h4>Items:</h4>
                                <table className={styles.itemsTable}>
                                  <thead>
                                    <tr>
                                      <th>Producto</th>
                                      <th>Cantidad</th>
                                      <th>Precio unitario</th>
                                      <th>Subtotal</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {order.items.map((item, idx) => (
                                      <tr key={idx}>
                                        <td>{item.product_name}</td>
                                        <td>{item.quantity}</td>
                                        <td>${item.unit_price.toFixed(2)}</td>
                                        <td>${(item.quantity * item.unit_price).toFixed(2)}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </tbody>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
