type MonthlyPurchases = {
  monthlySalesTotal?: number;
  monthlyPurchaseCount?: number;
  daysWithoutPurchase?: number | null;
};

export function formatCustomerMonthlyPurchases(customer: MonthlyPurchases): string {
  if (customer.monthlyPurchaseCount === 0) {
    if (customer.daysWithoutPurchase == null) return 'Sin compras registradas';
    const days = customer.daysWithoutPurchase;
    return `${days} ${days === 1 ? 'día' : 'días'} sin comprar`;
  }
  if (customer.monthlySalesTotal === undefined) return '—';
  return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' })
    .format(customer.monthlySalesTotal);
}
