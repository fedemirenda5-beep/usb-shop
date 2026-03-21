'use client';

import { useEffect, useMemo, useState } from 'react';
import { getApiBaseUrl, loadRuntimeConfig } from '@/lib/api';
import styles from './gastos.module.css';

type Expense = {
  id: number;
  category: string;
  amount: number;
  description?: string | null;
  created_at?: string | null;
};

type ExpenseFormState = {
  category: string;
  amount: string;
  description: string;
};

const suggestedCategories = [
  'Arreglo de vehiculos',
  'Alquiler',
  'Pago de sueldos',
  'Servicios',
  'Combustible',
  'Impuestos',
  'Mantenimiento',
  'Envios',
  'Otros',
];

const emptyExpenseForm = (): ExpenseFormState => ({
  category: '',
  amount: '',
  description: '',
});

const money = (value: number) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(value || 0);

const formatDate = (value?: string | null) => {
  if (!value) return '-';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString('es-AR');
};

export default function GastosPage() {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState<ExpenseFormState>(emptyExpenseForm);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  const loadExpenses = async (filters?: { startDate?: string; endDate?: string }) => {
    try {
      setLoading(true);
      setError('');
      await loadRuntimeConfig();
      const params = new URLSearchParams({ limit: '200' });
      if (filters?.startDate) params.set('start_date', filters.startDate);
      if (filters?.endDate) params.set('end_date', filters.endDate);
      const res = await fetch(`${getApiBaseUrl()}/admin/expenses?${params.toString()}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.detail || 'No se pudieron cargar los gastos');
      }
      const data = await res.json();
      setExpenses(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error cargando gastos');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadExpenses();
  }, []);

  const handleFormChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => {
    const { name, value } = e.target;
    setForm((prev) => ({
      ...prev,
      [name]: value,
    }));
  };

  const handleSaveExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const amount = Number(form.amount.toString().replace(',', '.'));
      if (!form.category.trim()) {
        throw new Error('La categoria es obligatoria');
      }
      if (Number.isNaN(amount) || amount <= 0) {
        throw new Error('El monto debe ser un numero mayor a 0');
      }
      await loadRuntimeConfig();
      const res = await fetch(`${getApiBaseUrl()}/admin/expenses`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category: form.category.trim(),
          amount,
          description: form.description.trim(),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.detail || 'No se pudo guardar el gasto');
      }
      setForm(emptyExpenseForm());
      await loadExpenses({ startDate, endDate });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error guardando gasto');
    } finally {
      setSaving(false);
    }
  };

  const handleFilterSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await loadExpenses({ startDate, endDate });
  };

  const handleClearFilters = async () => {
    setStartDate('');
    setEndDate('');
    await loadExpenses();
  };

  const visibleTotal = useMemo(
    () => expenses.reduce((acc, item) => acc + Number(item.amount || 0), 0),
    [expenses]
  );

  const averageExpense = useMemo(
    () => (expenses.length > 0 ? visibleTotal / expenses.length : 0),
    [expenses, visibleTotal]
  );

  const topCategory = useMemo(() => {
    if (expenses.length === 0) return 'Sin registros';
    const totals = new Map<string, number>();
    expenses.forEach((item) => {
      const key = item.category?.trim() || 'Sin categoria';
      totals.set(key, (totals.get(key) || 0) + Number(item.amount || 0));
    });
    return [...totals.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'Sin registros';
  }, [expenses]);

  return (
    <div className={styles.page}>
      <section className={styles.header}>
        <div>
          <h1>Gastos</h1>
          <p>Declara gastos operativos como alquiler, sueldos, arreglos y otros egresos del negocio.</p>
        </div>
      </section>

      {error ? <div className={styles.errorBox}>{error}</div> : null}

      <section className={styles.metricsGrid}>
        <article className={styles.metricCard}>
          <span>Total visible</span>
          <strong>{money(visibleTotal)}</strong>
          <p>Suma de los gastos filtrados en pantalla.</p>
        </article>
        <article className={styles.metricCard}>
          <span>Registros</span>
          <strong>{expenses.length}</strong>
          <p>Cantidad de gastos cargados en este listado.</p>
        </article>
        <article className={styles.metricCard}>
          <span>Promedio por gasto</span>
          <strong>{money(averageExpense)}</strong>
          <p>Valor medio del conjunto filtrado.</p>
        </article>
        <article className={styles.metricCard}>
          <span>Categoria principal</span>
          <strong>{topCategory}</strong>
          <p>Rubro con mayor monto acumulado en la vista actual.</p>
        </article>
      </section>

      <section className={styles.contentGrid}>
        <article className={styles.panel}>
          <div className={styles.panelHeader}>
            <div>
              <h2>Nuevo gasto</h2>
              <p>El registro impacta directamente en balances y reportes.</p>
            </div>
          </div>

          <form className={styles.formGrid} onSubmit={handleSaveExpense}>
            <label>
              Categoria
              <input
                name="category"
                list="expense-categories"
                value={form.category}
                onChange={handleFormChange}
                placeholder="Ej. Alquiler"
                required
              />
              <datalist id="expense-categories">
                {suggestedCategories.map((category) => (
                  <option key={category} value={category} />
                ))}
              </datalist>
            </label>

            <label>
              Monto
              <input
                name="amount"
                type="number"
                step="0.01"
                min="0.01"
                value={form.amount}
                onChange={handleFormChange}
                placeholder="0.00"
                required
              />
            </label>

            <label className={styles.fullWidth}>
              Descripcion
              <textarea
                name="description"
                value={form.description}
                onChange={handleFormChange}
                rows={4}
                placeholder="Detalle opcional del gasto"
              />
            </label>

            <div className={styles.formActions}>
              <button type="submit" className={styles.primaryButton} disabled={saving}>
                {saving ? 'Guardando...' : 'Registrar gasto'}
              </button>
            </div>
          </form>
        </article>

        <article className={styles.panel}>
          <div className={styles.panelHeader}>
            <div>
              <h2>Filtro de consulta</h2>
              <p>Puedes revisar periodos puntuales para controlar egresos.</p>
            </div>
          </div>

          <form className={styles.filterGrid} onSubmit={handleFilterSubmit}>
            <label>
              Desde
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </label>
            <label>
              Hasta
              <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </label>
            <div className={styles.formActions}>
              <button type="submit" className={styles.primaryButton} disabled={loading}>
                Filtrar
              </button>
              <button type="button" className={styles.secondaryButton} onClick={handleClearFilters} disabled={loading}>
                Limpiar
              </button>
            </div>
          </form>
        </article>
      </section>

      <section className={styles.tablePanel}>
        <div className={styles.panelHeader}>
          <div>
            <h2>Ultimos gastos cargados</h2>
            <p>Listado ordenado del mas reciente al mas antiguo.</p>
          </div>
        </div>

        <div className={styles.tableWrap}>
          {loading ? (
            <div className={styles.empty}>Cargando gastos...</div>
          ) : expenses.length === 0 ? (
            <div className={styles.empty}>No hay gastos registrados para el filtro actual.</div>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Categoria</th>
                  <th>Descripcion</th>
                  <th>Monto</th>
                </tr>
              </thead>
              <tbody>
                {expenses.map((expense) => (
                  <tr key={expense.id}>
                    <td>{formatDate(expense.created_at)}</td>
                    <td>
                      <span className={styles.categoryBadge}>{expense.category}</span>
                    </td>
                    <td>{expense.description?.trim() || '-'}</td>
                    <td className={styles.amountCell}>{money(expense.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}
