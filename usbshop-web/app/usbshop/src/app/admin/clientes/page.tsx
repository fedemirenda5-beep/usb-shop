'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { getApiBaseUrl, loadRuntimeConfig } from '@/lib/api';
import { openAdminSellerCustomersPrint } from '@/lib/adminSellerCustomersPrint';
import { formatArgentinaDateTime } from '@/lib/datetime';
import { ADMIN_LIMITS } from '../adminConfig';
import styles from './clientes.module.css';

type Seller = {
  id: number;
  name: string;
  is_active: boolean;
};

type Customer = {
  id: number;
  name: string;
  is_active?: boolean;
  email?: string | null;
  phone?: string | null;
  sale_mode?: string | null;
  locality?: string | null;
  address?: string | null;
  tax_condition?: string | null;
  cuit?: string | null;
  external_ref?: string | null;
  seller_id?: number | null;
  zone?: string | null;
  balance: number;
  invoice_count: number;
  created_at?: string | null;
};

type CustomerDetail = {
  id: number;
  name: string;
  is_active?: boolean;
  email?: string | null;
  phone?: string | null;
  sale_mode?: string | null;
  locality?: string | null;
  address?: string | null;
  tax_condition?: string | null;
  cuit?: string | null;
  external_ref?: string | null;
  seller_id?: number | null;
  zone?: string | null;
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
  is_active: string;
  email: string;
  phone: string;
  sale_mode: string;
  locality: string;
  address: string;
  tax_condition: string;
  cuit: string;
  seller_id: string;
  zone: string;
};

const emptyCustomerForm = (): CustomerFormState => ({
  name: '',
  is_active: '1',
  email: '',
  phone: '',
  sale_mode: 'CONTADO',
  locality: '',
  address: '',
  tax_condition: 'CONSUMIDOR_FINAL',
  cuit: '',
  seller_id: '',
  zone: '',
});

const formatCurrency = (value: number) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(value || 0);

const formatDate = (value?: string | null) => {
  return formatArgentinaDateTime(value);
};

const monthFormatter = new Intl.DateTimeFormat('es-AR', { month: 'short' });

const getMonthBucket = (value?: string | null) => {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return {
    year: parsed.getFullYear(),
    month: parsed.getMonth(),
  };
};

export default function ClientesPage() {
  const detailRequestRef = useRef(0);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [sellers, setSellers] = useState<Seller[]>([]);
  const [selectedCustomerId, setSelectedCustomerId] = useState<number | null>(null);
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerDetail | null>(null);
  const [showCustomerForm, setShowCustomerForm] = useState(false);
  const [search, setSearch] = useState('');
  const [sellerFilter, setSellerFilter] = useState('all');
  const [zoneFilter, setZoneFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deletingCustomer, setDeletingCustomer] = useState(false);
  const [assigningSeller, setAssigningSeller] = useState(false);
  const [togglingCustomerStatus, setTogglingCustomerStatus] = useState(false);
  const [syncingCustomers, setSyncingCustomers] = useState(false);
  const [error, setError] = useState('');
  const [customerForm, setCustomerForm] = useState<CustomerFormState>(emptyCustomerForm);
  const [quickSellerId, setQuickSellerId] = useState('');
  const [printScope, setPrintScope] = useState<'all' | 'seller'>('all');
  const [showGrowthChart, setShowGrowthChart] = useState(false);

  const loadCustomers = async (query = '', signal?: AbortSignal) => {
    try {
      setLoading(true);
      const params = new URLSearchParams({ limit: '1000' });
      if (query.trim()) params.set('q', query.trim());
      await loadRuntimeConfig();
      const res = await fetch(`${getApiBaseUrl()}/admin/backoffice-customers?${params}`, {
        credentials: 'include',
        signal,
      });
      if (!res.ok) throw new Error('No se pudieron cargar los clientes');
      const data = await res.json();
      setCustomers(data);
      if (!selectedCustomerId && data.length > 0) setSelectedCustomerId(data[0].id);
      if (selectedCustomerId && !data.some((item: Customer) => item.id === selectedCustomerId)) {
        setSelectedCustomerId(data[0]?.id ?? null);
      }
    } catch (err) {
      if (signal?.aborted) return;
      setError(err instanceof Error ? err.message : 'Error cargando clientes');
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  };

  const loadCustomerDetail = async (customerId: number, signal?: AbortSignal) => {
    const requestId = detailRequestRef.current + 1;
    detailRequestRef.current = requestId;
    try {
      await loadRuntimeConfig();
      const res = await fetch(`${getApiBaseUrl()}/admin/backoffice-customers/${customerId}`, {
        credentials: 'include',
        signal,
      });
      if (!res.ok) throw new Error('No se pudo cargar el cliente');
      const customerData = await res.json();
      if (signal?.aborted || requestId !== detailRequestRef.current) return;
      setSelectedCustomer(customerData);
      setCustomerForm({
        name: customerData.name || '',
        is_active: customerData.is_active === false ? '0' : '1',
        email: customerData.email || '',
        phone: customerData.phone || '',
        sale_mode: customerData.sale_mode || 'CONTADO',
        locality: customerData.locality || '',
        address: customerData.address || '',
        tax_condition: customerData.tax_condition || 'CONSUMIDOR_FINAL',
        cuit: customerData.cuit || '',
        seller_id: customerData.seller_id ? String(customerData.seller_id) : '',
        zone: customerData.zone || '',
      });
      setQuickSellerId(customerData.seller_id ? String(customerData.seller_id) : '');
      setShowCustomerForm(false);
    } catch (err) {
      if (signal?.aborted) return;
      setSelectedCustomer(null);
      setCustomerForm(emptyCustomerForm());
      setQuickSellerId('');
      setError(err instanceof Error ? err.message : 'Error cargando el detalle');
    }
  };

  const loadSellers = async (signal?: AbortSignal) => {
    try {
      await loadRuntimeConfig();
      const res = await fetch(`${getApiBaseUrl()}/admin/sellers?limit=${ADMIN_LIMITS.sellersList}`, {
        credentials: 'include',
        signal,
      });
      if (!res.ok) throw new Error('No se pudieron cargar los vendedores');
      const data = await res.json();
      setSellers(Array.isArray(data) ? data.filter((item: Seller) => item.is_active) : []);
    } catch (err) {
      if (signal?.aborted) return;
      setError(err instanceof Error ? err.message : 'Error cargando vendedores');
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    void loadSellers(controller.signal);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
      void loadCustomers(search, controller.signal);
    }, 250);
    return () => {
      controller.abort();
      window.clearTimeout(timeoutId);
    };
  }, [search]);

  useEffect(() => {
    if (selectedCustomerId) {
      const controller = new AbortController();
      void loadCustomerDetail(selectedCustomerId, controller.signal);
      return () => controller.abort();
    } else {
      setSelectedCustomer(null);
      setCustomerForm(emptyCustomerForm());
      setQuickSellerId('');
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

  const loadCustomerDetailData = async (customerId: number) => {
    await loadRuntimeConfig();
    const res = await fetch(`${getApiBaseUrl()}/admin/backoffice-customers/${customerId}`, {
      credentials: 'include',
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(data?.detail || 'No se pudo cargar el cliente');
    }
    return res.json();
  };

  const openCustomerForEdit = async (customerId: number) => {
    try {
      setError('');
      const customerData = await loadCustomerDetailData(customerId);
      setSelectedCustomerId(customerId);
      setSelectedCustomer(customerData);
      setCustomerForm({
        name: customerData.name || '',
        is_active: customerData.is_active === false ? '0' : '1',
        email: customerData.email || '',
        phone: customerData.phone || '',
        sale_mode: customerData.sale_mode || 'CONTADO',
        locality: customerData.locality || '',
        address: customerData.address || '',
        tax_condition: customerData.tax_condition || 'CONSUMIDOR_FINAL',
        cuit: customerData.cuit || '',
        seller_id: customerData.seller_id ? String(customerData.seller_id) : '',
        zone: customerData.zone || '',
      });
      setQuickSellerId(customerData.seller_id ? String(customerData.seller_id) : '');
      setShowCustomerForm(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo abrir el cliente');
    }
  };

  const openSelectedCustomerForEdit = () => {
    if (!selectedCustomer) return;
    setCustomerForm({
      name: selectedCustomer.name || '',
      is_active: selectedCustomer.is_active === false ? '0' : '1',
      email: selectedCustomer.email || '',
      phone: selectedCustomer.phone || '',
      sale_mode: selectedCustomer.sale_mode || 'CONTADO',
      locality: selectedCustomer.locality || '',
      address: selectedCustomer.address || '',
      tax_condition: selectedCustomer.tax_condition || 'CONSUMIDOR_FINAL',
      cuit: selectedCustomer.cuit || '',
      seller_id: selectedCustomer.seller_id ? String(selectedCustomer.seller_id) : '',
      zone: selectedCustomer.zone || '',
    });
    setError('');
    setShowCustomerForm(true);
  };

  const sellerMap = useMemo(
    () => new Map(sellers.map((seller) => [seller.id, seller.name])),
    [sellers]
  );

  const filteredCustomers = useMemo(() => {
    return customers.filter((customer) => {
      if (sellerFilter !== 'all' && String(customer.seller_id || '') !== sellerFilter) return false;
      if (zoneFilter !== 'all' && (customer.zone || '').trim() !== zoneFilter) return false;
      return true;
    });
  }, [customers, sellerFilter, zoneFilter]);

  const availableZones = useMemo(() => {
    return Array.from(
      new Set(
        customers
          .map((customer) => (customer.zone || '').trim())
          .filter((zone) => zone.length > 0)
      )
    ).sort((a, b) => a.localeCompare(b, 'es'));
  }, [customers]);

  const customerGrowth = useMemo(() => {
    const countsByYear = new Map<number, number[]>();
    for (const customer of customers) {
      const bucket = getMonthBucket(customer.created_at);
      if (!bucket) continue;
      if (!countsByYear.has(bucket.year)) {
        countsByYear.set(bucket.year, Array.from({ length: 12 }, () => 0));
      }
      countsByYear.get(bucket.year)![bucket.month] += 1;
    }

    const years = Array.from(countsByYear.keys()).sort((a, b) => b - a);
    const selectedYear = years[0] ?? new Date().getFullYear();
    const monthlyCounts = countsByYear.get(selectedYear) || Array.from({ length: 12 }, () => 0);
    const maxCount = Math.max(1, ...monthlyCounts);
    const points = monthlyCounts
      .map((count, index) => {
        const x = 24 + index * 64;
        const y = 180 - (count / maxCount) * 132;
        return `${x},${y}`;
      })
      .join(' ');

    return {
      year: selectedYear,
      years,
      maxCount,
      monthlyCounts: monthlyCounts.map((count, index) => ({
        key: `${selectedYear}-${index}`,
        label: monthFormatter.format(new Date(selectedYear, index, 1)).replace('.', ''),
        count,
        x: 24 + index * 64,
        y: 180 - (count / maxCount) * 132,
      })),
      points,
    };
  }, [customers]);

  const printSellerCustomers = async () => {
    const targetSellerId = sellerFilter !== 'all' ? Number(sellerFilter) : null;
    if (printScope === 'seller' && !targetSellerId) {
      setError('Selecciona un vendedor en el filtro para imprimir solo sus clientes.');
      return;
    }
    const printableCustomers =
      printScope === 'seller'
        ? filteredCustomers
            .filter((item) => item.seller_id === targetSellerId)
            .sort((a, b) => a.name.localeCompare(b.name, 'es'))
        : filteredCustomers.slice().sort((a, b) => a.name.localeCompare(b.name, 'es'));
    try {
      await openAdminSellerCustomersPrint({
        sellerName:
          printScope === 'seller' && targetSellerId
            ? sellerMap.get(targetSellerId) || `Vendedor ${targetSellerId}`
            : 'Todos los clientes',
        generatedAtLabel: formatDate(new Date().toISOString()),
        customers: printableCustomers.map((customer) => ({
          id: customer.id,
          name: customer.name,
          phone: customer.phone,
          email: customer.email,
          locality: customer.locality,
          address: customer.address,
          zone: customer.zone,
          balance: customer.balance,
        })),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo abrir la impresion');
    }
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
        body: JSON.stringify({
          ...customerForm,
          is_active: customerForm.is_active === '1',
        }),
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

  const updateSelectedCustomer = async (
    overrides: Partial<CustomerFormState>,
    options?: { keepFormOpen?: boolean }
  ) => {
    if (!selectedCustomerId || !selectedCustomer) return false;
    const payload = {
      name: selectedCustomer.name || '',
      is_active: selectedCustomer.is_active !== false,
      email: selectedCustomer.email || '',
      phone: selectedCustomer.phone || '',
      sale_mode: selectedCustomer.sale_mode || 'CONTADO',
      locality: selectedCustomer.locality || '',
      address: selectedCustomer.address || '',
      tax_condition: selectedCustomer.tax_condition || 'CONSUMIDOR_FINAL',
      cuit: selectedCustomer.cuit || '',
      seller_id: selectedCustomer.seller_id ? String(selectedCustomer.seller_id) : '',
      zone: selectedCustomer.zone || '',
      ...overrides,
    };
    const res = await fetch(`${getApiBaseUrl()}/admin/backoffice-customers/${selectedCustomerId}`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...payload,
        is_active: payload.is_active === '1' || payload.is_active === true,
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(data?.detail || 'No se pudo actualizar el cliente');
    }
    await loadCustomers(search);
    await loadCustomerDetail(selectedCustomerId);
    if (!options?.keepFormOpen) {
      setShowCustomerForm(false);
    }
    return true;
  };

  const saveQuickSellerAssignment = async () => {
    if (!selectedCustomer) return;
    try {
      setAssigningSeller(true);
      setError('');
      await loadRuntimeConfig();
      await updateSelectedCustomer({ seller_id: quickSellerId }, { keepFormOpen: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo asignar el vendedor');
    } finally {
      setAssigningSeller(false);
    }
  };

  const toggleSelectedCustomerActive = async () => {
    if (!selectedCustomer) return;
    try {
      setTogglingCustomerStatus(true);
      setError('');
      await loadRuntimeConfig();
      await updateSelectedCustomer(
        { is_active: selectedCustomer.is_active === false ? '1' : '0' },
        { keepFormOpen: true }
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo actualizar el estado del cliente');
    } finally {
      setTogglingCustomerStatus(false);
    }
  };

  const deleteCustomer = async (customerId: number, customerName: string) => {
    const confirmed = window.confirm(
      `Vas a eliminar el cliente "${customerName}". Esta accion no se puede deshacer.`
    );
    if (!confirmed) return;
    try {
      setDeletingCustomer(true);
      setError('');
      await loadRuntimeConfig();
      const res = await fetch(`${getApiBaseUrl()}/admin/backoffice-customers/${customerId}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.detail || 'No se pudo eliminar el cliente');
      }
      if (selectedCustomerId === customerId) {
        setSelectedCustomerId(null);
        setSelectedCustomer(null);
        setCustomerForm(emptyCustomerForm());
        setQuickSellerId('');
      }
      await loadCustomers(search);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error eliminando cliente');
    } finally {
      setDeletingCustomer(false);
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
          <p>Padron unico con asignacion simple por vendedor y zona.</p>
        </div>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => setShowGrowthChart(true)}
          >
            Grafico clientes
          </button>
          <div className={styles.printControls}>
            <select
              value={printScope}
              onChange={(e) => setPrintScope(e.target.value === 'seller' ? 'seller' : 'all')}
              className={styles.headerSelect}
            >
              <option value="all">Imprimir todos</option>
              <option value="seller">Filtrar por vendedor</option>
            </select>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => void printSellerCustomers()}
            >
              Imprimir clientes
            </button>
          </div>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={syncCustomersFromOrders}
            disabled={syncingCustomers}
          >
            {syncingCustomers ? 'Actualizando...' : 'Importar desde pedidos web'}
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

      <div className={styles.filtersBar}>
        <label>
          Vendedor
          <select value={sellerFilter} onChange={(e) => setSellerFilter(e.target.value)}>
            <option value="all">Todos</option>
            {sellers.map((seller) => (
              <option key={seller.id} value={String(seller.id)}>
                {seller.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Zona
          <select value={zoneFilter} onChange={(e) => setZoneFilter(e.target.value)}>
            <option value="all">Todas</option>
            {availableZones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className={styles.tablePanel}>
        <div className={styles.tableMeta}>
          <span>{filteredCustomers.length} clientes visibles{search ? ` para "${search}"` : ''}</span>
        </div>
        <div className={styles.tableWrap}>
          {loading ? (
            <div className={styles.empty}>Cargando clientes...</div>
          ) : filteredCustomers.length === 0 ? (
            <div className={styles.empty}>No hay clientes cargados.</div>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.colId}>ID</th>
                  <th className={styles.colCliente}>Cliente</th>
                  <th className={styles.colEstado}>Estado</th>
                  <th className={styles.colContacto}>Contacto</th>
                  <th className={styles.colVendedor}>Vendedor</th>
                  <th className={styles.colZona}>Zona</th>
                  <th className={styles.colCuit}>CUIT / DNI</th>
                  <th className={styles.colComprobantes}>Comprobantes</th>
                  <th className={styles.colSaldo}>Saldo</th>
                  <th className={styles.colAcciones}>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {filteredCustomers.map((customer) => (
                  <tr
                    key={customer.id}
                    className={customer.id === selectedCustomerId ? styles.customerRowActive : ''}
                    onClick={() => setSelectedCustomerId(customer.id)}
                    onDoubleClick={openSelectedCustomerForEdit}
                    title="Click para seleccionar. Doble click para editar."
                  >
                    <td className={styles.colId}>{customer.id}</td>
                    <td
                      className={`${styles.colCliente} ${styles.truncateCell}`}
                      title={customer.locality || customer.address || customer.name}
                    >
                      <strong>{customer.name}</strong>
                    </td>
                    <td className={styles.colEstado}>
                      <span className={customer.is_active === false ? styles.inactiveBadge : styles.activeBadge}>
                        {customer.is_active === false ? 'Inactivo' : 'Activo'}
                      </span>
                    </td>
                    <td className={`${styles.colContacto} ${styles.truncateCell}`}>{customer.email || customer.phone || 'Sin dato'}</td>
                    <td className={`${styles.colVendedor} ${styles.truncateCell}`}>{customer.seller_id ? sellerMap.get(customer.seller_id) || `Vendedor ${customer.seller_id}` : '-'}</td>
                    <td className={`${styles.colZona} ${styles.truncateCell}`}>{customer.zone || '-'}</td>
                    <td className={`${styles.colCuit} ${styles.truncateCell}`}>{customer.cuit || '-'}</td>
                    <td className={styles.colComprobantes}>{customer.invoice_count}</td>
                    <td className={`${styles.colSaldo} ${customer.balance > 0 ? styles.debt : styles.credit}`}>
                      {formatCurrency(customer.balance)}
                    </td>
                    <td className={styles.colAcciones}>
                      <div className={styles.rowActions}>
                        <button
                          type="button"
                          className={styles.iconButton}
                          onClick={(event) => {
                            event.stopPropagation();
                            void openCustomerForEdit(customer.id);
                          }}
                          title={`Editar ${customer.name}`}
                          aria-label={`Editar ${customer.name}`}
                        >
                          <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25Zm2.92 2.33H5v-.92l9.06-9.06.92.92L5.92 19.58ZM20.71 7.04a1 1 0 0 0 0-1.41L18.37 3.3a1 1 0 0 0-1.41 0l-1.13 1.13 3.75 3.75 1.13-1.14Z" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          className={styles.iconDeleteButton}
                          onClick={(event) => {
                            event.stopPropagation();
                            void deleteCustomer(customer.id, customer.name);
                          }}
                          title={`Eliminar ${customer.name}`}
                          aria-label={`Eliminar ${customer.name}`}
                          disabled={deletingCustomer}
                        >
                          <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm1 6h2v8h-2V9Zm4 0h2v8h-2V9ZM7 9h2v8H7V9Zm-1 11a2 2 0 0 1-2-2V8h16v10a2 2 0 0 1-2 2H6Z" />
                          </svg>
                        </button>
                      </div>
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
                Estado
                <select name="is_active" value={customerForm.is_active} onChange={handleCustomerFormChange}>
                  <option value="1">Activo</option>
                  <option value="0">Inactivo</option>
                </select>
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
              <label>
                Vendedor
                <select name="seller_id" value={customerForm.seller_id} onChange={handleCustomerFormChange}>
                  <option value="">Sin asignar</option>
                  {sellers.map((seller) => (
                    <option key={seller.id} value={String(seller.id)}>
                      {seller.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Zona
                <input
                  name="zone"
                  value={customerForm.zone}
                  onChange={handleCustomerFormChange}
                  list="customer-zone-options"
                  placeholder="Ej. Centro, Norte, Sur"
                />
              </label>
              <label className={styles.fullWidth}>
                Domicilio
                <input name="address" value={customerForm.address} onChange={handleCustomerFormChange} />
              </label>
              <datalist id="customer-zone-options">
                {availableZones.map((zone) => (
                  <option key={zone} value={zone} />
                ))}
              </datalist>
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
          <div className={styles.main}>
            <div className={styles.summaryPanel}>
              <div>
                <strong>{selectedCustomer.name}</strong>
                <span>{selectedCustomer.locality || selectedCustomer.address || 'Sin localidad cargada'}</span>
              </div>
              <div>
                <strong>Estado</strong>
                <span className={selectedCustomer.is_active === false ? styles.inactiveBadge : styles.activeBadge}>
                  {selectedCustomer.is_active === false ? 'Inactivo' : 'Activo'}
                </span>
              </div>
              <div>
                <strong>Vendedor</strong>
                <span>
                  {selectedCustomer.seller_id
                    ? sellerMap.get(selectedCustomer.seller_id) || `Vendedor ${selectedCustomer.seller_id}`
                    : 'Sin asignar'}
                </span>
              </div>
              <div>
                <strong>Zona</strong>
                <span>{selectedCustomer.zone || 'Sin zona'}</span>
              </div>
              <div>
                <strong>Saldo</strong>
                <span className={selectedCustomer.balance > 0 ? styles.debt : styles.credit}>
                  {formatCurrency(selectedCustomer.balance)}
                </span>
              </div>
              <div className={styles.summaryField}>
                <strong>Asignar vendedor</strong>
                <div className={styles.inlineActions}>
                  <select
                    value={quickSellerId}
                    onChange={(e) => setQuickSellerId(e.target.value)}
                    className={styles.inlineSelect}
                  >
                    <option value="">Sin asignar</option>
                    {sellers.map((seller) => (
                      <option key={seller.id} value={String(seller.id)}>
                        {seller.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    onClick={() => void saveQuickSellerAssignment()}
                    disabled={assigningSeller}
                  >
                    {assigningSeller ? 'Guardando...' : 'Guardar vendedor'}
                  </button>
                </div>
              </div>
              <div className={styles.summaryActions}>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={openSelectedCustomerForEdit}
                >
                  Editar cliente
                </button>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={() => void toggleSelectedCustomerActive()}
                  disabled={togglingCustomerStatus}
                >
                  {togglingCustomerStatus
                    ? 'Guardando...'
                    : selectedCustomer.is_active === false
                      ? 'Reactivar cliente'
                      : 'Dar de baja'}
                </button>
                <button
                  type="button"
                  className={styles.dangerButton}
                  onClick={() => void deleteCustomer(selectedCustomer.id, selectedCustomer.name)}
                  disabled={deletingCustomer}
                >
                  {deletingCustomer ? 'Eliminando...' : 'Eliminar cliente'}
                </button>
              </div>
            </div>

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
                        <Link href={`/admin/comprobantes?invoice=${document.id}`} className={styles.secondaryButton}>
                          Ver en comprobantes
                        </Link>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
          </div>
        ) : null}

        <div className={styles.notice}>
          Esta pantalla ya no usa clientes internos paralelos. Clientes, comprobantes y cuentas
          corrientes trabajan sobre la misma base real del backoffice.
        </div>
      </section>

      {showGrowthChart ? (
        <div className={styles.modalOverlay} onClick={() => setShowGrowthChart(false)}>
          <aside
            className={styles.chartModal}
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="customer-growth-title"
          >
            <div className={styles.panelHeader}>
              <div>
                <h2 id="customer-growth-title">Crecimiento de clientes {customerGrowth.year}</h2>
                <p>Altas mensuales de clientes para visualizar subas y bajas durante el año.</p>
              </div>
              <button type="button" className={styles.secondaryButton} onClick={() => setShowGrowthChart(false)}>
                Cerrar
              </button>
            </div>

            <div className={styles.chartFrame}>
              <svg viewBox="0 0 752 220" className={styles.chartSvg} role="img" aria-label="Grafico de altas mensuales de clientes">
                <line x1="24" y1="180" x2="728" y2="180" className={styles.chartAxis} />
                <line x1="24" y1="28" x2="24" y2="180" className={styles.chartAxis} />
                <polyline points={customerGrowth.points} className={styles.chartLine} />
                {customerGrowth.monthlyCounts.map((item) => (
                  <g key={item.key}>
                    <circle cx={item.x} cy={item.y} r="5" className={styles.chartPoint} />
                    <text x={item.x} y={200} textAnchor="middle" className={styles.chartLabel}>
                      {item.label}
                    </text>
                    <text x={item.x} y={item.y - 12} textAnchor="middle" className={styles.chartValue}>
                      {item.count}
                    </text>
                  </g>
                ))}
              </svg>
            </div>

            <div className={styles.chartGrid}>
              {customerGrowth.monthlyCounts.map((item) => (
                <article key={item.key} className={styles.chartCard}>
                  <span>{item.label} {customerGrowth.year}</span>
                  <strong>{item.count} clientes</strong>
                </article>
              ))}
            </div>
          </aside>
        </div>
      ) : null}
    </div>
  );
}
