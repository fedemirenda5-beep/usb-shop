'use client';

import { useEffect, useMemo, useState } from 'react';
import { getApiBaseUrl, loadRuntimeConfig } from '@/lib/api';
import { useAdminSession } from '@/hooks/useAdminSession';
import styles from './vendedores.module.css';

type Seller = {
  id: number;
  name: string;
  commission_percent: number;
  is_active: boolean;
  created_at?: string | null;
  updated_at?: string | null;
};

type SellerFormState = {
  name: string;
  commission_percent: string;
  is_active: boolean;
};

type SellerMonthlySummary = {
  seller_id: number;
  name: string;
  commission_percent: number;
  sales: number;
  profit: number;
  commission: number;
  invoice_count: number;
};

const emptySellerForm = (): SellerFormState => ({
  name: '',
  commission_percent: '0',
  is_active: true,
});

const formatPercent = (value: number) =>
  `${new Intl.NumberFormat('es-AR', {
    minimumFractionDigits: value % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value || 0)}%`;

const money = (value: number) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(value || 0);

const formatDate = (value?: string | null) => {
  if (!value) return '-';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString('es-AR');
};

export default function VendedoresPage() {
  const { user } = useAdminSession();
  const [sellers, setSellers] = useState<Seller[]>([]);
  const [monthlySummary, setMonthlySummary] = useState<SellerMonthlySummary[]>([]);
  const [monthlyPeriod, setMonthlyPeriod] = useState('');
  const [selectedSellerId, setSelectedSellerId] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [showSellerForm, setShowSellerForm] = useState(false);
  const [sellerForm, setSellerForm] = useState<SellerFormState>(emptySellerForm);

  const selectedSeller = sellers.find((seller) => seller.id === selectedSellerId) ?? null;
  const isFullAdmin = (user?.role || '').toLowerCase() === 'admin';
  const formattedMonthlyPeriod = useMemo(() => {
    if (!monthlyPeriod) return 'este mes';
    const [year, month] = monthlyPeriod.split('-');
    const parsed = new Date(Number(year), Number(month) - 1, 1);
    return Number.isNaN(parsed.getTime())
      ? monthlyPeriod
      : parsed.toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });
  }, [monthlyPeriod]);

  const loadSellers = async (query = '') => {
    try {
      setLoading(true);
      setError('');
      const params = new URLSearchParams({ limit: '150' });
      if (query.trim()) params.set('q', query.trim());
      await loadRuntimeConfig();
      const res = await fetch(`${getApiBaseUrl()}/admin/sellers?${params.toString()}`, {
        credentials: 'include',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.detail || 'No se pudieron cargar los vendedores');
      }
      const data = await res.json();
      setSellers(data);
      setSelectedSellerId((currentId: number | null) => {
        if (showSellerForm) return currentId;
        if (currentId && data.some((item: Seller) => item.id === currentId)) return currentId;
        return data[0]?.id ?? null;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error cargando vendedores');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void loadSellers(search);
    }, 250);
    return () => window.clearTimeout(timeoutId);
  }, [search]);

  useEffect(() => {
    if (!isFullAdmin) {
      setMonthlySummary([]);
      setMonthlyPeriod('');
      return;
    }
    const loadMonthlySummary = async () => {
      try {
        setSummaryLoading(true);
        await loadRuntimeConfig();
        const res = await fetch(`${getApiBaseUrl()}/admin/sellers/monthly-summary`, {
          credentials: 'include',
        });
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          throw new Error(data?.detail || 'No se pudo cargar el resumen mensual');
        }
        const data = await res.json();
        setMonthlySummary(Array.isArray(data.items) ? data.items : []);
        setMonthlyPeriod(typeof data.period === 'string' ? data.period : '');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error cargando resumen mensual');
      } finally {
        setSummaryLoading(false);
      }
    };
    void loadMonthlySummary();
  }, [isFullAdmin]);

  const handleSellerFormChange = (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const { name, type, checked, value } = e.target;
    setSellerForm((prev) => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value,
    }));
  };

  const resetForNewSeller = () => {
    setSelectedSellerId(null);
    setSellerForm(emptySellerForm());
    setShowSellerForm(true);
    setError('');
  };

  const editSeller = (seller: Seller) => {
    setSelectedSellerId(seller.id);
    setSellerForm({
      name: seller.name,
      commission_percent: String(seller.commission_percent ?? 0),
      is_active: seller.is_active,
    });
    setShowSellerForm(true);
    setError('');
  };

  const saveSeller = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const commission = Number(sellerForm.commission_percent.replace(',', '.'));
      if (Number.isNaN(commission) || commission < 0) {
        throw new Error('La comision debe ser un numero mayor o igual a 0');
      }
      await loadRuntimeConfig();
      const url = selectedSellerId
        ? `${getApiBaseUrl()}/admin/sellers/${selectedSellerId}`
        : `${getApiBaseUrl()}/admin/sellers`;
      const method = selectedSellerId ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: sellerForm.name,
          commission_percent: commission,
          is_active: sellerForm.is_active,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.detail || 'No se pudo guardar el vendedor');
      }
      const data = await res.json();
      await loadSellers(search);
      setSelectedSellerId(data.id);
      setShowSellerForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error guardando vendedor');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1>Vendedores</h1>
          <p>Alta y mantenimiento de vendedores con comision asignada.</p>
        </div>
        <div className={styles.headerActions}>
          <button type="button" className={styles.primaryButton} onClick={resetForNewSeller}>
            + Nuevo vendedor
          </button>
        </div>
      </div>

      {error ? <div className={styles.errorBox}>{error}</div> : null}

      <div className={styles.searchBar}>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar vendedor por nombre"
        />
      </div>

      <div className={styles.tablePanel}>
        <div className={styles.tableMeta}>
          <span>{sellers.length} vendedores{search ? ` para "${search}"` : ''}</span>
        </div>
        <div className={styles.tableWrap}>
          {loading ? (
            <div className={styles.empty}>Cargando vendedores...</div>
          ) : sellers.length === 0 ? (
            <div className={styles.empty}>No hay vendedores cargados.</div>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Vendedor</th>
                  <th>Comision</th>
                  <th>Estado</th>
                  <th>Actualizado</th>
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {sellers.map((seller) => (
                  <tr
                    key={seller.id}
                    className={seller.id === selectedSellerId ? styles.activeRow : ''}
                    onClick={() => setSelectedSellerId(seller.id)}
                    onDoubleClick={() => editSeller(seller)}
                  >
                    <td>{seller.id}</td>
                    <td>
                      <strong>{seller.name}</strong>
                      <span className={styles.metaLine}>
                        Creado: {formatDate(seller.created_at)}
                      </span>
                    </td>
                    <td>{formatPercent(seller.commission_percent)}</td>
                    <td>
                      <span className={seller.is_active ? styles.activeBadge : styles.inactiveBadge}>
                        {seller.is_active ? 'Activo' : 'Inactivo'}
                      </span>
                    </td>
                    <td>{formatDate(seller.updated_at || seller.created_at)}</td>
                    <td>
                      <button
                        type="button"
                        className={styles.secondaryButton}
                        onClick={(event) => {
                          event.stopPropagation();
                          editSeller(seller);
                        }}
                      >
                        Editar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {isFullAdmin ? (
        <section className={styles.panel}>
          <div className={styles.panelHeader}>
            <div>
              <h3>Resumen mensual por vendedor</h3>
              <p>Ventas y ganancia estimada de {formattedMonthlyPeriod} para los vendedores activos.</p>
            </div>
          </div>

          {summaryLoading ? (
            <div className={styles.empty}>Cargando resumen mensual...</div>
          ) : monthlySummary.length === 0 ? (
            <div className={styles.empty}>No hay ventas registradas este mes para vendedores activos.</div>
          ) : (
            <div className={styles.monthlySummaryGrid}>
              {monthlySummary.map((item) => (
                <article key={item.seller_id} className={styles.summaryCard}>
                  <div className={styles.summaryHeader}>
                    <strong>{item.name}</strong>
                    <span>{formatPercent(item.commission_percent)}</span>
                  </div>
                  <div className={styles.summaryMetrics}>
                    <div>
                      <span>Venta del mes</span>
                      <strong>{money(item.sales)}</strong>
                    </div>
                    <div>
                      <span>Ganancia</span>
                      <strong>{money(item.profit)}</strong>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      ) : null}

      <section className={styles.main}>
        {showSellerForm ? (
          <div className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <h2>{selectedSellerId ? 'Editar vendedor' : 'Nuevo vendedor'}</h2>
                <p>Defini nombre comercial y porcentaje de comision.</p>
              </div>
            </div>

            <form className={styles.formGrid} onSubmit={saveSeller}>
              <label>
                Nombre
                <input
                  name="name"
                  value={sellerForm.name}
                  onChange={handleSellerFormChange}
                  required
                />
              </label>
              <label>
                Comision (%)
                <input
                  name="commission_percent"
                  type="number"
                  step="0.01"
                  min="0"
                  value={sellerForm.commission_percent}
                  onChange={handleSellerFormChange}
                  required
                />
              </label>
              <label className={styles.checkboxField}>
                <input
                  name="is_active"
                  type="checkbox"
                  checked={sellerForm.is_active}
                  onChange={handleSellerFormChange}
                />
                <span>Vendedor activo</span>
              </label>
              <div className={styles.formActions}>
                <button type="submit" className={styles.primaryButton} disabled={saving}>
                  {saving ? 'Guardando...' : selectedSellerId ? 'Guardar cambios' : 'Crear vendedor'}
                </button>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={() => setShowSellerForm(false)}
                >
                  Cancelar
                </button>
              </div>
            </form>
          </div>
        ) : null}

        {selectedSeller ? (
          <div className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <h3>Ficha del vendedor</h3>
                <p>Resumen rapido para consultar y editar sin perder la grilla.</p>
              </div>
              <button type="button" className={styles.secondaryButton} onClick={() => editSeller(selectedSeller)}>
                Editar vendedor
              </button>
            </div>

            <div className={styles.detailGrid}>
              <div className={styles.detailItem}>
                <span>Nombre</span>
                <strong>{selectedSeller.name}</strong>
              </div>
              <div className={styles.detailItem}>
                <span>Comision actual</span>
                <strong>{formatPercent(selectedSeller.commission_percent)}</strong>
              </div>
              <div className={styles.detailItem}>
                <span>Estado</span>
                <strong>{selectedSeller.is_active ? 'Activo' : 'Inactivo'}</strong>
              </div>
              <div className={styles.detailItem}>
                <span>Ultima actualizacion</span>
                <strong>{formatDate(selectedSeller.updated_at || selectedSeller.created_at)}</strong>
              </div>
            </div>
          </div>
        ) : (
          <div className={styles.notice}>
            Selecciona un vendedor para ver su ficha o usa <strong>+ Nuevo vendedor</strong> para darlo de alta.
          </div>
        )}
      </section>
    </div>
  );
}
