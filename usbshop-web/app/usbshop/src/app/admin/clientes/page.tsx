'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { getApiBaseUrl, loadRuntimeConfig } from '@/lib/api';
import styles from './clientes.module.css';

type Customer = {
  id: number;
  name: string;
  email?: string | null;
  phone?: string | null;
  tax_id?: string | null;
  tax_condition?: string | null;
  address?: string | null;
  city?: string | null;
  notes?: string | null;
  balance: number;
  documents?: DocumentHeader[];
};

type Movement = {
  id: number;
  movement_type: 'DEBIT' | 'CREDIT';
  amount: number;
  signed_amount: number;
  description?: string | null;
  document_type?: string | null;
  document_number?: string | null;
  due_date?: string | null;
  created_at: string;
};

type DocumentHeader = {
  id: number;
  document_kind: string;
  document_number: string;
  issue_date: string;
  total: number;
  created_at: string;
};

type DocumentItem = {
  description: string;
  quantity: number;
  unit_price: number;
  subtotal?: number;
};

type DocumentDetail = {
  id: number;
  customer_id: number;
  document_kind: string;
  document_number: string;
  issue_date: string;
  total: number;
  customer_name: string;
  customer_tax_id?: string | null;
  customer_tax_condition?: string | null;
  customer_address?: string | null;
  notes?: string | null;
  items: DocumentItem[];
};

type CustomerFormState = {
  name: string;
  email: string;
  phone: string;
  tax_id: string;
  tax_condition: string;
  address: string;
  city: string;
  notes: string;
};

type MovementFormState = {
  movement_type: 'DEBIT' | 'CREDIT';
  amount: string;
  description: string;
  due_date: string;
};

type DocumentFormState = {
  document_kind: string;
  issue_date: string;
  notes: string;
  items: DocumentItem[];
};

const emptyCustomerForm = (): CustomerFormState => ({
  name: '',
  email: '',
  phone: '',
  tax_id: '',
  tax_condition: 'Consumidor Final',
  address: '',
  city: '',
  notes: '',
});

const emptyMovementForm = (): MovementFormState => ({
  movement_type: 'DEBIT',
  amount: '',
  description: '',
  due_date: '',
});

const emptyDocumentForm = (): DocumentFormState => ({
  document_kind: 'RECIBO_X',
  issue_date: new Date().toISOString().slice(0, 10),
  notes: '',
  items: [{ description: '', quantity: 1, unit_price: 0 }],
});

const formatCurrency = (value: number) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(value || 0);

const formatDate = (value?: string | null) => {
  if (!value) return '-';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString('es-AR');
};

function PrintableDocument({ documentId }: { documentId: number }) {
  const [document, setDocument] = useState<DocumentDetail | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const load = async () => {
      try {
        await loadRuntimeConfig();
        const res = await fetch(`${getApiBaseUrl()}/admin/account-documents/${documentId}`, {
          credentials: 'include',
        });
        if (!res.ok) throw new Error('No se pudo cargar el comprobante');
        const data = await res.json();
        setDocument(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error cargando comprobante');
      }
    };
    load();
  }, [documentId]);

  useEffect(() => {
    if (document) {
      window.setTimeout(() => window.print(), 250);
    }
  }, [document]);

  if (error) return <div className={styles.printShell}>{error}</div>;
  if (!document) return <div className={styles.printShell}>Cargando comprobante...</div>;

  return (
    <div className={styles.printShell}>
      <div className={styles.printActions}>
        <button type="button" onClick={() => window.print()} className={styles.primaryButton}>
          Imprimir
        </button>
      </div>
      <article className={styles.printDocument}>
        <header className={styles.printHeader}>
          <div>
            <p className={styles.printEyebrow}>USB Shop</p>
            <h1>{document.document_kind.replace(/_/g, ' ')}</h1>
            <p className={styles.printMuted}>Documento interno. No valido como factura.</p>
          </div>
          <div className={styles.printMeta}>
            <p><strong>Nro:</strong> {document.document_number}</p>
            <p><strong>Fecha:</strong> {document.issue_date}</p>
          </div>
        </header>

        <section className={styles.printCustomer}>
          <p><strong>Cliente:</strong> {document.customer_name}</p>
          <p><strong>CUIT/DNI:</strong> {document.customer_tax_id || '-'}</p>
          <p><strong>Condicion fiscal:</strong> {document.customer_tax_condition || '-'}</p>
          <p><strong>Domicilio:</strong> {document.customer_address || '-'}</p>
        </section>

        <table className={styles.printTable}>
          <thead>
            <tr>
              <th>Detalle</th>
              <th>Cant.</th>
              <th>Unitario</th>
              <th>Subtotal</th>
            </tr>
          </thead>
          <tbody>
            {document.items.map((item, index) => (
              <tr key={`${item.description}-${index}`}>
                <td>{item.description}</td>
                <td>{item.quantity}</td>
                <td>{formatCurrency(item.unit_price)}</td>
                <td>{formatCurrency(item.subtotal || item.quantity * item.unit_price)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {document.notes ? (
          <section className={styles.printNotes}>
            <strong>Observaciones:</strong> {document.notes}
          </section>
        ) : null}

        <footer className={styles.printFooter}>
          <div />
          <div className={styles.printTotalBox}>
            <span>Total</span>
            <strong>{formatCurrency(document.total)}</strong>
          </div>
        </footer>
      </article>
    </div>
  );
}

export default function ClientesPage() {
  const searchParams = useSearchParams();
  const printDocumentId = Number(searchParams?.get('document') || 0);
  const printMode = searchParams?.get('print') === '1' && printDocumentId > 0;

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [selectedCustomerId, setSelectedCustomerId] = useState<number | null>(null);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [movements, setMovements] = useState<Movement[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncingCustomers, setSyncingCustomers] = useState(false);
  const [error, setError] = useState('');
  const [customerForm, setCustomerForm] = useState<CustomerFormState>(emptyCustomerForm);
  const [movementForm, setMovementForm] = useState<MovementFormState>(emptyMovementForm);
  const [documentForm, setDocumentForm] = useState<DocumentFormState>(emptyDocumentForm);

  const loadCustomers = async (query = '') => {
    try {
      setLoading(true);
      const params = new URLSearchParams({ limit: '100' });
      if (query.trim()) params.set('q', query.trim());
      await loadRuntimeConfig();
      const res = await fetch(`${getApiBaseUrl()}/admin/account-customers?${params}`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error('No se pudieron cargar los clientes');
      const data = await res.json();
      setCustomers(data);
      if (!selectedCustomerId && data.length > 0) setSelectedCustomerId(data[0].id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error cargando clientes');
    } finally {
      setLoading(false);
    }
  };

  const loadCustomerDetail = async (customerId: number) => {
    try {
      await loadRuntimeConfig();
      const [customerRes, movementsRes] = await Promise.all([
        fetch(`${getApiBaseUrl()}/admin/account-customers/${customerId}`, { credentials: 'include' }),
        fetch(`${getApiBaseUrl()}/admin/account-customers/${customerId}/movements`, {
          credentials: 'include',
        }),
      ]);
      if (!customerRes.ok) throw new Error('No se pudo cargar el cliente');
      if (!movementsRes.ok) throw new Error('No se pudo cargar la cuenta corriente');
      const customerData = await customerRes.json();
      const movementsData = await movementsRes.json();
      setSelectedCustomer(customerData);
      setMovements(movementsData.items || []);
      setCustomerForm({
        name: customerData.name || '',
        email: customerData.email || '',
        phone: customerData.phone || '',
        tax_id: customerData.tax_id || '',
        tax_condition: customerData.tax_condition || 'Consumidor Final',
        address: customerData.address || '',
        city: customerData.city || '',
        notes: customerData.notes || '',
      });
      setMovementForm(emptyMovementForm());
      setDocumentForm((prev) => ({ ...prev, issue_date: new Date().toISOString().slice(0, 10) }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error cargando el detalle');
    }
  };

  useEffect(() => {
    if (!printMode) loadCustomers();
  }, [printMode]);

  useEffect(() => {
    if (!printMode && selectedCustomerId) loadCustomerDetail(selectedCustomerId);
  }, [selectedCustomerId, printMode]);

  const handleCustomerFormChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>
  ) => {
    const { name, value } = e.target;
    setCustomerForm((prev) => ({ ...prev, [name]: value }));
  };

  const handleMovementFormChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>
  ) => {
    const { name, value } = e.target;
    setMovementForm((prev) => ({ ...prev, [name]: value }));
  };

  const handleDocumentHeaderChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>
  ) => {
    const { name, value } = e.target;
    setDocumentForm((prev) => ({ ...prev, [name]: value }));
  };

  const updateDocumentItem = (index: number, field: keyof DocumentItem, value: string) => {
    setDocumentForm((prev) => ({
      ...prev,
      items: prev.items.map((item, itemIndex) =>
        itemIndex === index
          ? { ...item, [field]: field === 'description' ? value : Number(value) }
          : item
      ),
    }));
  };

  const addDocumentItem = () => {
    setDocumentForm((prev) => ({
      ...prev,
      items: [...prev.items, { description: '', quantity: 1, unit_price: 0 }],
    }));
  };

  const removeDocumentItem = (index: number) => {
    setDocumentForm((prev) => ({
      ...prev,
      items: prev.items.filter((_, itemIndex) => itemIndex !== index),
    }));
  };

  const resetForNewCustomer = () => {
    setSelectedCustomerId(null);
    setSelectedCustomer(null);
    setMovements([]);
    setCustomerForm(emptyCustomerForm());
    setMovementForm(emptyMovementForm());
    setDocumentForm(emptyDocumentForm());
    setError('');
  };

  const saveCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await loadRuntimeConfig();
      const url = selectedCustomerId
        ? `${getApiBaseUrl()}/admin/account-customers/${selectedCustomerId}`
        : `${getApiBaseUrl()}/admin/account-customers`;
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
      setSelectedCustomerId(nextId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error guardando cliente');
    } finally {
      setSaving(false);
    }
  };

  const createMovement = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCustomerId) return;
    setSaving(true);
    setError('');
    try {
      await loadRuntimeConfig();
      const res = await fetch(`${getApiBaseUrl()}/admin/account-customers/${selectedCustomerId}/movements`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...movementForm, amount: Number(movementForm.amount) }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.detail || 'No se pudo registrar el movimiento');
      }
      setMovementForm(emptyMovementForm());
      await loadCustomerDetail(selectedCustomerId);
      await loadCustomers(search);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error registrando movimiento');
    } finally {
      setSaving(false);
    }
  };

  const createDocument = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCustomerId) return;
    setSaving(true);
    setError('');
    try {
      await loadRuntimeConfig();
      const res = await fetch(`${getApiBaseUrl()}/admin/account-documents`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer_id: selectedCustomerId,
          document_kind: documentForm.document_kind,
          issue_date: documentForm.issue_date,
          notes: documentForm.notes,
          items: documentForm.items,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.detail || 'No se pudo generar el comprobante');
      }
      const data = await res.json();
      await loadCustomerDetail(selectedCustomerId);
      await loadCustomers(search);
      setDocumentForm(emptyDocumentForm());
      window.open(`/admin/clientes?document=${data.id}&print=1`, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error generando comprobante');
    } finally {
      setSaving(false);
    }
  };

  const syncCustomersFromOrders = async () => {
    setSyncingCustomers(true);
    setError('');
    try {
      await loadRuntimeConfig();
      const res = await fetch(`${getApiBaseUrl()}/admin/account-customers/sync-web-orders`, {
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

  if (printMode) return <PrintableDocument documentId={printDocumentId} />;

  return (
    <div className={styles.page}>
      <section className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <div>
            <h1>Clientes y cuentas corrientes</h1>
            <p>Alta de clientes, saldo y comprobantes internos.</p>
          </div>
          <div className={styles.sidebarActions}>
            <button type="button" className={styles.secondaryButton} onClick={syncCustomersFromOrders} disabled={syncingCustomers}>
              {syncingCustomers ? 'Actualizando...' : 'Actualizar clientes'}
            </button>
            <button type="button" className={styles.secondaryButton} onClick={resetForNewCustomer}>
              Nuevo cliente
            </button>
          </div>
        </div>

        <form className={styles.searchBar} onSubmit={(e) => { e.preventDefault(); loadCustomers(search); }}>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nombre, email, telefono o CUIT"
          />
          <button type="submit" className={styles.primaryButton}>Buscar</button>
        </form>

        <div className={styles.customerList}>
          {loading ? <p>Cargando clientes...</p> : null}
          {!loading && customers.length === 0 ? <p>No hay clientes cargados.</p> : null}
          {customers.map((customer) => (
            <button
              type="button"
              key={customer.id}
              className={`${styles.customerCard} ${customer.id === selectedCustomerId ? styles.customerCardActive : ''}`}
              onClick={() => setSelectedCustomerId(customer.id)}
            >
              <strong>{customer.name}</strong>
              <span>{customer.tax_id || customer.email || customer.phone || 'Sin dato fiscal'}</span>
              <em className={customer.balance > 0 ? styles.debt : styles.credit}>
                {formatCurrency(customer.balance)}
              </em>
            </button>
          ))}
        </div>
      </section>

      <section className={styles.main}>
        {error ? <div className={styles.errorBox}>{error}</div> : null}
        <div className={styles.panel}>
          <div className={styles.panelHeader}>
            <div>
              <h2>{selectedCustomer ? selectedCustomer.name : 'Nuevo cliente'}</h2>
              <p>
                {selectedCustomer
                  ? `Saldo actual: ${formatCurrency(selectedCustomer.balance)}`
                  : 'Completa los datos fiscales y de contacto.'}
              </p>
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
              <input name="tax_id" value={customerForm.tax_id} onChange={handleCustomerFormChange} />
            </label>
            <label>
              Condicion fiscal
              <select
                name="tax_condition"
                value={customerForm.tax_condition}
                onChange={handleCustomerFormChange}
              >
                <option value="Consumidor Final">Consumidor Final</option>
                <option value="Responsable Inscripto">Responsable Inscripto</option>
                <option value="Monotributista">Monotributista</option>
                <option value="Exento">Exento</option>
              </select>
            </label>
            <label>
              Ciudad
              <input name="city" value={customerForm.city} onChange={handleCustomerFormChange} />
            </label>
            <label className={styles.fullWidth}>
              Domicilio
              <input name="address" value={customerForm.address} onChange={handleCustomerFormChange} />
            </label>
            <label className={styles.fullWidth}>
              Notas
              <textarea name="notes" value={customerForm.notes} onChange={handleCustomerFormChange} rows={3} />
            </label>
            <div className={styles.formActions}>
              <button type="submit" className={styles.primaryButton} disabled={saving}>
                {selectedCustomerId ? 'Guardar cambios' : 'Crear cliente'}
              </button>
            </div>
          </form>
        </div>

        {selectedCustomerId ? (
          <div className={styles.grid}>
            <div className={styles.panel}>
              <div className={styles.panelHeader}>
                <div>
                  <h3>Movimiento manual</h3>
                  <p>Debito suma deuda. Credito descuenta saldo.</p>
                </div>
              </div>
              <form className={styles.formGrid} onSubmit={createMovement}>
                <label>
                  Tipo
                  <select
                    name="movement_type"
                    value={movementForm.movement_type}
                    onChange={handleMovementFormChange}
                  >
                    <option value="DEBIT">Debito</option>
                    <option value="CREDIT">Credito</option>
                  </select>
                </label>
                <label>
                  Importe
                  <input
                    name="amount"
                    type="number"
                    min="0"
                    step="0.01"
                    value={movementForm.amount}
                    onChange={handleMovementFormChange}
                    required
                  />
                </label>
                <label className={styles.fullWidth}>
                  Descripcion
                  <input
                    name="description"
                    value={movementForm.description}
                    onChange={handleMovementFormChange}
                    placeholder="Entrega parcial, ajuste, pago recibido..."
                  />
                </label>
                <label>
                  Vencimiento
                  <input
                    name="due_date"
                    type="date"
                    value={movementForm.due_date}
                    onChange={handleMovementFormChange}
                  />
                </label>
                <div className={styles.formActions}>
                  <button type="submit" className={styles.primaryButton} disabled={saving}>
                    Registrar movimiento
                  </button>
                </div>
              </form>
            </div>

            <div className={styles.panel}>
              <div className={styles.panelHeader}>
                <div>
                  <h3>Generar comprobante</h3>
                  <p>Se guarda snapshot del cliente y se suma a la cuenta corriente.</p>
                </div>
              </div>
              <form onSubmit={createDocument} className={styles.documentForm}>
                <div className={styles.formGrid}>
                  <label>
                    Tipo
                    <select
                      name="document_kind"
                      value={documentForm.document_kind}
                      onChange={handleDocumentHeaderChange}
                    >
                      <option value="RECIBO_X">Recibo X</option>
                      <option value="PRESUPUESTO">Presupuesto</option>
                      <option value="NOTA_DEBITO">Nota de debito</option>
                      <option value="NOTA_CREDITO">Nota de credito</option>
                    </select>
                  </label>
                  <label>
                    Fecha
                    <input
                      type="date"
                      name="issue_date"
                      value={documentForm.issue_date}
                      onChange={handleDocumentHeaderChange}
                    />
                  </label>
                  <label className={styles.fullWidth}>
                    Observaciones
                    <textarea
                      name="notes"
                      rows={2}
                      value={documentForm.notes}
                      onChange={handleDocumentHeaderChange}
                    />
                  </label>
                </div>

                <div className={styles.itemList}>
                  {documentForm.items.map((item, index) => (
                    <div key={index} className={styles.itemRow}>
                      <input
                        value={item.description}
                        onChange={(e) => updateDocumentItem(index, 'description', e.target.value)}
                        placeholder="Detalle"
                        required
                      />
                      <input
                        type="number"
                        min="0.01"
                        step="0.01"
                        value={item.quantity}
                        onChange={(e) => updateDocumentItem(index, 'quantity', e.target.value)}
                        required
                      />
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={item.unit_price}
                        onChange={(e) => updateDocumentItem(index, 'unit_price', e.target.value)}
                        required
                      />
                      <button
                        type="button"
                        onClick={() => removeDocumentItem(index)}
                        disabled={documentForm.items.length === 1}
                        className={styles.ghostButton}
                      >
                        Quitar
                      </button>
                    </div>
                  ))}
                </div>

                <div className={styles.documentActions}>
                  <button type="button" className={styles.secondaryButton} onClick={addDocumentItem}>
                    Agregar item
                  </button>
                  <button type="submit" className={styles.primaryButton} disabled={saving}>
                    Generar e imprimir
                  </button>
                </div>
              </form>
            </div>
          </div>
        ) : null}

        {selectedCustomer ? (
          <div className={styles.grid}>
            <div className={styles.panel}>
              <div className={styles.panelHeader}>
                <div>
                  <h3>Cuenta corriente</h3>
                  <p>Movimientos mas recientes</p>
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
                    </tr>
                  </thead>
                  <tbody>
                    {movements.length === 0 ? (
                      <tr>
                        <td colSpan={4}>Sin movimientos registrados.</td>
                      </tr>
                    ) : (
                      movements.map((movement) => (
                        <tr key={movement.id}>
                          <td>{formatDate(movement.created_at)}</td>
                          <td>{movement.movement_type === 'DEBIT' ? 'Debito' : 'Credito'}</td>
                          <td>
                            {movement.description || '-'}
                            {movement.document_number ? (
                              <span className={styles.metaLine}>
                                {movement.document_type} {movement.document_number}
                              </span>
                            ) : null}
                          </td>
                          <td className={movement.signed_amount > 0 ? styles.debt : styles.credit}>
                            {formatCurrency(movement.signed_amount)}
                          </td>
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
                  <p>Snapshot imprimible de cada emision</p>
                </div>
              </div>
              <div className={styles.documentList}>
                {(selectedCustomer.documents || []).length === 0 ? (
                  <p>Sin comprobantes generados.</p>
                ) : (
                  selectedCustomer.documents?.map((document) => (
                    <div key={document.id} className={styles.documentCard}>
                      <div>
                        <strong>{document.document_number}</strong>
                        <span>
                          {document.document_kind} · {document.issue_date}
                        </span>
                      </div>
                      <div className={styles.documentCardRight}>
                        <em>{formatCurrency(document.total)}</em>
                        <button
                          type="button"
                          className={styles.secondaryButton}
                          onClick={() =>
                            window.open(
                              `/admin/clientes?document=${document.id}&print=1`,
                              '_blank',
                              'noopener,noreferrer'
                            )
                          }
                        >
                          Ver / imprimir
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        ) : null}

        <div className={styles.notice}>
          Para operaciones fiscales reales con validez ante ARCA, hace falta una integracion de
          factura electronica con autorizacion/CAE. Esta seccion genera comprobantes internos
          imprimibles y cuenta corriente operativa.
        </div>
      </section>
    </div>
  );
}
