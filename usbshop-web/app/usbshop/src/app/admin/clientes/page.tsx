'use client';

import { useState, useEffect } from 'react';
import { useAdminSession } from '@/hooks/useAdminSession';
import styles from './clientes.module.css';

interface Customer {
  id: number;
  name: string;
  email: string;
  phone: string;
  locality: string;
  address: string;
  tax_condition: string;
  cuit: string;
  order_count: number;
  total_spent: number;
  last_order: string;
  created_at: string;
}

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:8000';

export default function ClientesPage() {
  const { user } = useAdminSession();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [editingCustomer, setEditingCustomer] = useState<Partial<Customer> | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const emptyCustomer: Partial<Customer> = {
    name: '',
    email: '',
    phone: '',
    locality: '',
    address: '',
    tax_condition: 'CONSUMIDOR_FINAL',
    cuit: '',
    order_count: 0,
    total_spent: 0
  };

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

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!editingCustomer) return;

    try {
      setIsSaving(true);
      const isNew = !editingCustomer.id;
      const url = isNew 
        ? `${API_BASE}/admin/customers`
        : `${API_BASE}/admin/customers/${editingCustomer.id}`;
      
      const res = await fetch(url, {
        method: isNew ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editingCustomer),
        credentials: 'include'
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.detail || 'Error al guardar cliente');
      }
      
      setEditingCustomer(null);
      loadCustomers(search);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error al guardar');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div>
          <h1>Clientes</h1>
          <p>Listado de clientes que han realizado pedidos web</p>
        </div>
        <button 
          className={styles.addBtn}
          onClick={() => setEditingCustomer(emptyCustomer)}
        >
          + Nuevo Cliente
        </button>
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
                <th>CUIT / Cond. IVA</th>
                <th>Ubicación</th>
                <th>Web Stats</th>
                <th className={styles.actionsHeader}>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {customers.map((customer) => (
                <tr key={customer.id}>
                  <td>
                    <div className={styles.customerInfo}>
                      <span className={styles.customerName}>{customer.name}</span>
                      <span className={styles.customerEmail}>{customer.email}</span>
                      <span className={styles.customerPhone}>{customer.phone}</span>
                    </div>
                  </td>
                  <td>
                    <div className={styles.taxInfo}>
                      <span className={styles.cuit}>{customer.cuit || 'Sin CUIT'}</span>
                      <span className={styles.taxCondition}>{customer.tax_condition}</span>
                    </div>
                  </td>
                  <td>
                    <div className={styles.locationInfo}>
                      <span className={styles.locality}>{customer.locality || '-'}</span>
                      <span className={styles.address}>{customer.address}</span>
                    </div>
                  </td>
                  <td>
                    <div className={styles.statsInfo}>
                      <span className={styles.badge}>{customer.order_count} ped.</span>
                      <span className={styles.total}>${customer.total_spent.toFixed(2)}</span>
                    </div>
                  </td>
                  <td className={styles.actions}>
                    <button 
                      onClick={() => setEditingCustomer(customer)}
                      className={styles.editBtn}
                      title="Editar Datos"
                    >
                      ✏️
                    </button>
                    <a 
                      href={`/admin/pedidos?search=${customer.email}`}
                      className={styles.ordersBtn}
                      title="Ver sus pedidos"
                    >
                      📦
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editingCustomer && (
        <div className={styles.modalOverlay}>
          <div className={styles.modal}>
            <h2>{editingCustomer.id ? 'Editar Cliente' : 'Nuevo Cliente'}</h2>
            <form onSubmit={handleSubmit}>
              <div className={styles.formGroup}>
                <label>Nombre</label>
                <input 
                  type="text" 
                  value={editingCustomer.name} 
                  onChange={e => setEditingCustomer({...editingCustomer, name: e.target.value})}
                  required
                />
              </div>
              <div className={styles.formGrid}>
                <div className={styles.formGroup}>
                  <label>Email</label>
                  <input 
                    type="email" 
                    value={editingCustomer.email} 
                    onChange={e => setEditingCustomer({...editingCustomer, email: e.target.value})}
                  />
                </div>
                <div className={styles.formGroup}>
                  <label>Teléfono</label>
                  <input 
                    type="text" 
                    value={editingCustomer.phone} 
                    onChange={e => setEditingCustomer({...editingCustomer, phone: e.target.value})}
                  />
                </div>
              </div>
              <div className={styles.formGrid}>
                <div className={styles.formGroup}>
                  <label>CUIT</label>
                  <input 
                    type="text" 
                    value={editingCustomer.cuit} 
                    onChange={e => setEditingCustomer({...editingCustomer, cuit: e.target.value})}
                  />
                </div>
                <div className={styles.formGroup}>
                  <label>Condición IVA</label>
                  <select 
                    value={editingCustomer.tax_condition}
                    onChange={e => setEditingCustomer({...editingCustomer, tax_condition: e.target.value})}
                  >
                    <option value="CONSUMIDOR_FINAL">Consumidor Final</option>
                    <option value="RESPONSABLE_INSCRIPTO">Responsable Inscripto</option>
                    <option value="MONOTRIBUTO">Monotributo</option>
                    <option value="EXENTO">Exento</option>
                  </select>
                </div>
              </div>
              <div className={styles.formGrid}>
                <div className={styles.formGroup}>
                  <label>Localidad</label>
                  <input 
                    type="text" 
                    value={editingCustomer.locality} 
                    onChange={e => setEditingCustomer({...editingCustomer, locality: e.target.value})}
                  />
                </div>
                <div className={styles.formGroup}>
                  <label>Dirección</label>
                  <input 
                    type="text" 
                    value={editingCustomer.address} 
                    onChange={e => setEditingCustomer({...editingCustomer, address: e.target.value})}
                  />
                </div>
              </div>
              <div className={styles.modalActions}>
                <button type="button" onClick={() => setEditingCustomer(null)} disabled={isSaving}>
                  Cancelar
                </button>
                <button type="submit" className={styles.saveBtn} disabled={isSaving}>
                  {isSaving ? 'Guardando...' : 'Guardar Cambios'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
