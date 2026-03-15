'use client';

import { useState, useEffect } from 'react';
import { useAdminSession } from '@/hooks/useAdminSession';
import styles from './clientes.module.css';

interface Customer {
  name: string;
  email: string;
  phone: string;
  order_count: number;
  total_spent: number;
  first_order: string;
  last_order: string;
}

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:8000';

export default function ClientesPage() {
  const { user } = useAdminSession();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');

  const loadCustomers = async (query = '') => {
    try {
      setLoading(true);
      setError('');
      const url = new URL(`${API_BASE}/admin/customers`);
      url.searchParams.append('limit', '100');
      if (query) url.searchParams.append('q', query);

      const res = await fetch(url.toString(), { credentials: 'include' });
      if (!res.ok) throw new Error('Error al cargar clientes');
      
      const data = await res.json();
      setCustomers(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      loadCustomers(search);
    }, 500);
    return () => clearTimeout(timer);
  }, [search]);

  const formatDate = (dateStr: string) => {
    if (!dateStr) return '-';
    return new Date(dateStr).toLocaleDateString('es-ES', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    });
  };

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1>Clientes</h1>
        <p>Listado de clientes que han realizado pedidos web</p>
      </div>

      <div className={styles.searchBar}>
        <input
          type="text"
          placeholder="Buscar por nombre, email o teléfono..."
          className={styles.searchInput}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.tableContainer}>
        {loading ? (
          <div className={styles.loading}>Cargando datos de clientes...</div>
        ) : customers.length === 0 ? (
          <div className={styles.empty}>No se encontraron clientes</div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Cliente</th>
                <th>Teléfono</th>
                <th>Pedidos</th>
                <th>Total Gastado</th>
                <th>Último Pedido</th>
              </tr>
            </thead>
            <tbody>
              {customers.map((customer, idx) => (
                <tr key={customer.email || idx}>
                  <td>
                    <div className={styles.customerInfo}>
                      <span className={styles.customerName}>{customer.name}</span>
                      <span className={styles.customerEmail}>{customer.email}</span>
                    </div>
                  </td>
                  <td>
                    <span className={styles.phone}>{customer.phone || '-'}</span>
                  </td>
                  <td>
                    <span className={styles.badge}>{customer.order_count}</span>
                  </td>
                  <td>
                    <span className={styles.total}>${customer.total_spent.toFixed(2)}</span>
                  </td>
                  <td>
                    <span className={styles.date}>{formatDate(customer.last_order)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
