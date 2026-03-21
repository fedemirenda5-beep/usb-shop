'use client';

import { useEffect, useState } from 'react';
import { getApiBaseUrl, loadRuntimeConfig } from '@/lib/api';
import { formatArgentinaDateTime } from '@/lib/datetime';
import styles from './clientes.module.css';

type Customer = {
  id: number;
  name: string;
  email?: string | null;
  phone?: string | null;
  sale_mode?: string | null;
  locality?: string | null;
  address?: string | null;
  tax_condition?: string | null;
  cuit?: string | null;
  external_ref?: string | null;
  balance: number;
  invoice_count: number;
  created_at?: string | null;
};

type CustomerDetail = {
  id: number;
  name: string;
  email?: string | null;
  phone?: string | null;
  sale_mode?: string | null;
  locality?: string | null;
  address?: string | null;
  tax_condition?: string | null;
  cuit?: string | null;
  external_ref?: string | null;
  balance: number;
  created_at?: string | null;
  documents: Array<{
    id: number;
    total: number;
    created_at: string;
    document_type?: string | null;
    sale_mode?: string | null;
    due_date?: string | null;
    notes?: string | null;
  }>;
  movements: Array<{
    id: number;
    movement_type: string;
    amount: number;
    signed_amount: number;
    reference?: string | null;
    invoice_id?: number | null;
    created_at?: string | null;
    payment_method?: string | null;
    document_type?: string | null;
    due_date?: string | null;
    running_balance: number;
  }>;
};

type CustomerFormState = {
  name: string;
  email: string;
  phone: string;
  sale_mode: string;
  locality: string;
  address: string;
  tax_condition: string;
  cuit: string;
};

const emptyCustomerForm = (): CustomerFormState => ({
  name: '',
  email: '',
  phone: '',
  sale_mode: 'CONTADO',
  locality: '',
  address: '',
  tax_condition: 'CONSUMIDOR_FINAL',
  cuit: '',
});

const formatCurrency = (value: number) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(value || 0);

const formatDate = (value?: string | null) => {
  return formatArgentinaDateTime(value);
};

export default function ClientesPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [selectedCustomerId, setSelectedCustomerId] = useState<number | null>(null);
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerDetail | null>(null);
  const [showCustomerForm, setShowCustomerForm] = useState(false);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncingCustomers, setSyncingCustomers] = useState(false);
  const [error, setError] = useState('');
  const [customerForm, setCustomerForm] = useState<CustomerFormState>(emptyCustomerForm);

  const loadCustomers = async (query = '') => {
    try {
      setLoading(true);
      const params = new URLSearchParams({ limit: '150' });
      if (query.trim()) params.set('q', query.trim());
      await loadRuntimeConfig();
      const res = await fetch(`${getApiBaseUrl()}/admin/backoffice-customers?${params}`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error('No se pudieron cargar los clientes');
      const data = await res.json();
      setCustomers(data);
      if (!selectedCustomerId && data.length > 0) setSelectedCustomerId(data[0].id);
      if (selectedCustomerId && !data.some((item: Customer) => item.id === selectedCustomerId)) {
        setSelectedCustomerId(data[0]?.id ?? null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error cargando clientes');
    } finally {
      setLoading(false);
    }
  };

  const loadCustomerDetail = async (customerId: number) => {
    try {
      await loadRuntimeConfig();
      const res = await fetch(`${getApiBaseUrl()}/admin/backoffice-customers/${customerId}`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error('No se pudo cargar el cliente');
      const customerData = await res.json();
      setSelectedCustomer(customerData);
      setCustomerForm({
        name: customerData.name || '',
        email: customerData.email || '',
        phone: customerData.phone || '',
        sale_mode: customerData.sale_mode || 'CONTADO',
        locality: customerData.locality || '',
        address: customerData.address || '',
        tax_condition: customerData.tax_condition || 'CONSUMIDOR_FINAL',
        cuit: customerData.cuit || '',
      });
      setShowCustomerForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error cargando el detalle');
    }
  };

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void loadCustomers(search);
    }, 250);
    return () => window.clearTimeout(timeoutId);
  }, [search]);

  useEffect(() => {
    if (selectedCustomerId) {
      void loadCustomerDetail(selectedCustomerId);
    } else {
      setSelectedCustomer(null);
      setCustomerForm(emptyCustomerForm());
    }
  }, [selectedCustomerId]);

  const handleCustomerFormChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>
  ) => {
    const { name, value } = e.target;
    setCustomerForm((prev) => ({ ...prev, [name]: value }));
  };

  const resetForNewCustomer = () => {
    setSelectedCustomerId(null);
    setSelectedCustomer(null);
    setCustomerForm(emptyCustomerForm());
    setError('');
    setShowCustomerForm(true);
  };

  const openSelectedCustomerForEdit = () => {
    if (!selectedCustomer) return;
    setCustomerForm({
      name: selectedCustomer.name || '',
      email: selectedCustomer.email || '',
      phone: selectedCustomer.phone || '',
      sale_mode: selectedCustomer.sale_mode || 'CONTADO',
      locality: selectedCustomer.locality || '',
      address: selectedCustomer.address || '',
      tax_condition: selectedCustomer.tax_condition || 'CONSUMIDOR_FINAL',
      cuit: selectedCustomer.cuit || '',
    });
    setError('');
    setShowCustomerForm(true);
  };

  const saveCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await loadRuntimeConfig();
      const url = selectedCustomerId
        ? `${getApiBaseUrl()}/admin/backoffice-customers/${selectedCustomerId}`
        : `${getApiBaseUrl()}/admin/backoffice-customers`;
      const method = selectedCustomerId ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(customerForm),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.detail || 'No se pudo guardar el cliente');
      }
      const data = await res.json();
      const nextId = selectedCustomerId || data.id;
      await loadCustomers(search);
      if (nextId) setSelectedCustomerId(nextId);
      setShowCustomerForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error guardando cliente');
    } finally {
      setSaving(false);
    }
  };

  const syncCustomersFromOrders = async () => {
    setSyncingCustomers(true);
    setError('');
    try {
      await loadRuntimeConfig();
      const res = await fetch(`${getApiBaseUrl()}/admin/backoffice-customers/sync-web-orders`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.detail || 'No se pudieron actualizar los clientes');
      }
      await loadCustomers(search);
      if (selectedCustomerId) {
        await loadCustomerDetail(selectedCustomerId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error actualizando clientes');
    } finally {
      setSyncingCustomers(false);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1>Clientes</h1>
          <p>Padron unico de clientes reales del backoffice.</p>
        </div>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={syncCustomersFromOrders}
            disabled={syncingCustomers}
          >
            {syncingCustomers ? 'Actualizando...' : 'Importar desde pedidos web'}
          </button>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={openSelectedCustomerForEdit}
            disabled={!selectedCustomer}
          >
            Editar cliente
          </button>
          <button type="button" className={styles.primaryButton} onClick={resetForNewCustomer}>
            + Nuevo cliente
          </button>
        </div>
      </div>

      {error ? <div className={styles.errorBox}>{error}</div> : null}

      <div className={styles.searchBar}>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por nombre, email, telefono o CUIT"
        />
      </div>

      <div className={styles.tablePanel}>
        <div className={styles.tableMeta}>
          <span>{customers.length} clientes{search ? ` para "${search}"` : ''}</span>
        </div>
        <div className={styles.tableWrap}>
          {loading ? (
            <div className={styles.empty}>Cargando clientes...</div>
          ) : customers.length === 0 ? (
            <div className={styles.empty}>No hay clientes cargados.</div>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Cliente</th>
                  <th>Contacto</th>
                  <th>CUIT / DNI</th>
                  <th>Comprobantes</th>
                  <th>Saldo</th>
                </tr>
              </thead>
              <tbody>
                {customers.map((customer) => (
                  <tr
                    key={customer.id}
                    className={customer.id === selectedCustomerId ? styles.customerRowActive : ''}
                    onClick={() => setSelectedCustomerId(customer.id)}
                  >
                    <td>{customer.id}</td>
                    <td>
                      <strong>{customer.name}</strong>
                      <span className={styles.metaLine}>{customer.locality || customer.address || 'Sin localidad'}</span>
                    </td>
                    <td>{customer.email || customer.phone || 'Sin dato'}</td>
                    <td>{customer.cuit || '-'}</td>
                    <td>{customer.invoice_count}</td>
                    <td className={customer.balance > 0 ? styles.debt : styles.credit}>
                      {formatCurrency(customer.balance)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <section className={styles.main}>
        {showCustomerForm ? (
          <div className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <h2>{selectedCustomerId ? 'Editar cliente' : 'Nuevo cliente'}</h2>
                <p>{selectedCustomerId ? 'Actualiza nombre, direccion, telefono y datos fiscales del cliente.' : 'Alta y edicion sobre la tabla real de clientes.'}</p>
              </div>
            </div>

            <form className={styles.formGrid} onSubmit={saveCustomer}>
              <label>
                Nombre o razon social
                <input name="name" value={customerForm.name} onChange={handleCustomerFormChange} required />
              </label>
              <label>
                Email
                <input name="email" value={customerForm.email} onChange={handleCustomerFormChange} />
              </label>
              <label>
                Telefono
                <input name="phone" value={customerForm.phone} onChange={handleCustomerFormChange} />
              </label>
              <label>
                CUIT / DNI
                <input name="cuit" value={customerForm.cuit} onChange={handleCustomerFormChange} />
              </label>
              <label>
                Condicion fiscal
                <select name="tax_condition" value={customerForm.tax_condition} onChange={handleCustomerFormChange}>
                  <option value="CONSUMIDOR_FINAL">Consumidor Final</option>
                  <option value="RESPONSABLE_INSCRIPTO">Responsable Inscripto</option>
                  <option value="MONOTRIBUTISTA">Monotributista</option>
                  <option value="EXENTO">Exento</option>
                </select>
              </label>
              <label>
                Modalidad de venta
                <select name="sale_mode" value={customerForm.sale_mode} onChange={handleCustomerFormChange}>
                  <option value="CONTADO">Contado</option>
                  <option value="CUENTA_CORRIENTE">Cuenta corriente</option>
                </select>
              </label>
              <label>
                Ciudad
                <input name="locality" value={customerForm.locality} onChange={handleCustomerFormChange} />
              </label>
              <label className={styles.fullWidth}>
                Domicilio
                <input name="address" value={customerForm.address} onChange={handleCustomerFormChange} />
              </label>
              <div className={styles.formActions}>
                <button type="submit" className={styles.primaryButton} disabled={saving}>
                  {saving ? 'Guardando...' : selectedCustomerId ? 'Guardar cambios' : 'Crear cliente'}
                </button>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={() => setShowCustomerForm(false)}
                >
                  Cancelar
                </button>
              </div>
            </form>
          </div>
        ) : null}

        {selectedCustomer ? (
          <div className={styles.grid}>
            <div className={styles.panel}>
              <div className={styles.panelHeader}>
                <div>
                  <h3>Movimientos recientes</h3>
                  <p>Ultimos movimientos de la cuenta real del cliente.</p>
                </div>
              </div>
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Fecha</th>
                      <th>Tipo</th>
                      <th>Detalle</th>
                      <th>Importe</th>
                      <th>Saldo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedCustomer.movements.length === 0 ? (
                      <tr>
                        <td colSpan={5}>Sin movimientos registrados.</td>
                      </tr>
                    ) : (
                      selectedCustomer.movements.map((movement) => (
                        <tr key={movement.id}>
                          <td>{formatDate(movement.created_at)}</td>
                          <td>{movement.movement_type === 'DEBIT' ? 'Debito' : 'Credito'}</td>
                          <td>
                            {movement.reference || movement.payment_method || '-'}
                            {movement.invoice_id ? (
                              <span className={styles.metaLine}>
                                {movement.document_type || 'Comprobante'} #{movement.invoice_id}
                              </span>
                            ) : null}
                          </td>
                          <td className={movement.signed_amount >= 0 ? styles.debt : styles.credit}>
                            {formatCurrency(movement.signed_amount)}
                          </td>
                          <td>{formatCurrency(movement.running_balance)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className={styles.panel}>
              <div className={styles.panelHeader}>
                <div>
                  <h3>Comprobantes recientes</h3>
                  <p>Historial real tomado de `invoices`.</p>
                </div>
              </div>
              <div className={styles.documentList}>
                {selectedCustomer.documents.length === 0 ? (
                  <p>Sin comprobantes emitidos.</p>
                ) : (
                  selectedCustomer.documents.map((document) => (
                    <div key={document.id} className={styles.documentCard}>
                      <div>
                        <strong>#{document.id}</strong>
                        <span>
                          {document.document_type || 'Comprobante'} · {formatDate(document.created_at)}
                        </span>
                      </div>
                      <div className={styles.documentCardRight}>
                        <em>{formatCurrency(document.total)}</em>
                        <a href="/admin/comprobantes" className={styles.secondaryButton}>
                          Ver en comprobantes
                        </a>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        ) : null}

        <div className={styles.notice}>
          Esta pantalla ya no usa clientes internos paralelos. Clientes, comprobantes y cuentas
          corrientes trabajan sobre la misma base real del backoffice.
        </div>
      </section>
    </div>
  );
}
