'use client';

import { useState, useEffect, useMemo } from 'react';
import { useAdminSession } from '@/hooks/useAdminSession';
import styles from './reportes.module.css';

interface OrderItem {
  product_id: number;
  quantity: number;
  unit_price: number;
  product_name?: string;
}

interface Order {
  id: number;
  total: number;
  status: string;
  created_at: string;
  items: OrderItem[];
}

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:8000';

export default function ReportesPage() {
  const { user } = useAdminSession();
  const [allOrders, setAllOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Default date range: current month
  const now = new Date();
  const firstDay = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
  const lastDay = now.toISOString().split('T')[0];

  const [dateFrom, setDateFrom] = useState(firstDay);
  const [dateTo, setDateTo] = useState(lastDay);

  const loadAllData = async () => {
    try {
      setLoading(true);
      setError('');
      
      // Fetch combined orders (PENDING, CONFIRMED, CANCELLED) to have full perspective
      // In a real app we might want more complex filtering, but for MVP fetching all works
      const statuses = ['PENDING', 'CONFIRMED', 'CANCELLED'];
      let collected: Order[] = [];
      
      for (const status of statuses) {
        const res = await fetch(`${API_BASE}/admin/orders-with-items?status=${status}&limit=500`, { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          collected = [...collected, ...data];
        }
      }
      
      setAllOrders(collected.sort((a, b) => b.id - a.id));
    } catch (err) {
      setError('No se pudieron cargar los datos para los reportes');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAllData();
  }, []);

  // Filter and Calculate Reports
  const filteredOrders = useMemo(() => {
    return allOrders.filter(o => {
      const date = o.created_at.split('T')[0];
      return date >= dateFrom && date <= dateTo;
    });
  }, [allOrders, dateFrom, dateTo]);

  const reports = useMemo(() => {
    const confirmed = filteredOrders.filter(o => o.status === 'CONFIRMED');
    const totalSales = confirmed.reduce((acc, o) => acc + o.total, 0);
    const orderCount = confirmed.length;
    const avgTicket = orderCount > 0 ? totalSales / orderCount : 0;

    // Product Ranking
    const products: Record<number, { name: string, qty: number, total: number }> = {};
    confirmed.forEach(o => {
      o.items.forEach(item => {
        if (!products[item.product_id]) {
          products[item.product_id] = { name: item.product_name || `ID: ${item.product_id}`, qty: 0, total: 0 };
        }
        products[item.product_id].qty += item.quantity;
        products[item.product_id].total += (item.quantity * item.unit_price);
      });
    });

    const ranking = Object.values(products).sort((a, b) => b.total - a.total).slice(0, 10);

    // Status breakdown
    const statusCounts = filteredOrders.reduce((acc, o) => {
      acc[o.status] = (acc[o.status] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    return {
      totalSales,
      orderCount,
      avgTicket,
      ranking,
      statusCounts
    };
  }, [filteredOrders]);

  if (loading) return <div className={styles.loading}>Analizando datos de ventas...</div>;

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1>Reportes</h1>
        <div className={styles.controls}>
          <div>
            <label>Desde: </label>
            <input 
              type="date" 
              className={styles.dateInput} 
              value={dateFrom} 
              onChange={(e) => setDateFrom(e.target.value)} 
            />
          </div>
          <div>
            <label>Hasta: </label>
            <input 
              type="date" 
              className={styles.dateInput} 
              value={dateTo} 
              onChange={(e) => setDateTo(e.target.value)} 
            />
          </div>
          <button className={styles.refreshBtn} onClick={loadAllData}>⚡</button>
        </div>
      </div>

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.summary}>
        <div className={styles.card}>
          <span className={styles.cardTitle}>Ventas Totales</span>
          <span className={styles.cardValue}>${reports.totalSales.toFixed(2)}</span>
          <span className={styles.cardSubtitle}>Solo pedidos CONFIRMADOS</span>
        </div>
        <div className={styles.card}>
          <span className={styles.cardTitle}>Cantidad Pedidos</span>
          <span className={styles.cardValue}>{reports.orderCount}</span>
          <span className={styles.cardSubtitle}>Pedidos cerrados con éxito</span>
        </div>
        <div className={styles.card}>
          <span className={styles.cardTitle}>Ticket Promedio</span>
          <span className={styles.cardValue}>${reports.avgTicket.toFixed(2)}</span>
          <span className={styles.cardSubtitle}>Valor medio de cada venta</span>
        </div>
      </div>

      <div className={styles.grid}>
        <div className={styles.section}>
          <h2>Ranking de Productos</h2>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Producto</th>
                <th>Cant.</th>
                <th>Monto</th>
              </tr>
            </thead>
            <tbody>
              {reports.ranking.map((p, i) => (
                <tr key={i}>
                  <td>{p.name}</td>
                  <td>{p.qty}</td>
                  <td style={{ fontWeight: 600 }}>${p.total.toFixed(2)}</td>
                </tr>
              ))}
              {reports.ranking.length === 0 && <tr><td colSpan={3}>Sin ventas en el período</td></tr>}
            </tbody>
          </table>
        </div>

        <div className={styles.section}>
          <h2>Pedidos por Estado</h2>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Estado</th>
                <th>Cantidad</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><span className={styles.statusBadge} style={{backgroundColor: '#fef3c7', color: '#92400e'}}>Pendientes</span></td>
                <td>{reports.statusCounts['PENDING'] || 0}</td>
              </tr>
              <tr>
                <td><span className={styles.statusBadge} style={{backgroundColor: '#dcfce7', color: '#166534'}}>Confirmados</span></td>
                <td>{reports.statusCounts['CONFIRMED'] || 0}</td>
              </tr>
              <tr>
                <td><span className={styles.statusBadge} style={{backgroundColor: '#fee2e2', color: '#991b1b'}}>Cancelados</span></td>
                <td>{reports.statusCounts['CANCELLED'] || 0}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
