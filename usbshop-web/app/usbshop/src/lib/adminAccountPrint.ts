import { formatArgentinaDateTime } from '@/lib/datetime';

type AccountPrintCustomer = {
  id: number;
  name: string;
  email?: string | null;
  phone?: string | null;
  sale_mode?: string | null;
  locality?: string | null;
  address?: string | null;
  tax_condition?: string | null;
  cuit?: string | null;
};

type AccountPrintMovement = {
  id: number;
  movement_type: string;
  entry_label?: string | null;
  amount: number;
  signed_amount: number;
  reference?: string | null;
  invoice_id?: number | null;
  created_at?: string | null;
  payment_method?: string | null;
  document_type?: string | null;
  status_label?: string | null;
  running_balance: number;
};

type AccountPrintPayload = {
  customer: AccountPrintCustomer;
  balance: number;
  movements: AccountPrintMovement[];
  rangeLabel: string;
};

const money = (value: number) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(value || 0);

const formatDate = (value?: string | null) => formatArgentinaDateTime(value);

const escapeHtml = (value: unknown) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const buildPrintableHtml = (payload: AccountPrintPayload, logoUrl: string) => {
  const movementRows = payload.movements
    .map(
      (movement) => `
        <tr>
          <td>${escapeHtml(formatDate(movement.created_at))}</td>
          <td>${escapeHtml(movement.entry_label || movement.document_type || (movement.movement_type === 'DEBIT' ? 'Debito' : 'Pago'))}</td>
          <td>${escapeHtml(movement.reference || movement.payment_method || (movement.invoice_id ? `Comprobante #${movement.invoice_id}` : '-'))}</td>
          <td class="${movement.signed_amount >= 0 ? 'debit' : 'credit'}">${escapeHtml(money(movement.signed_amount))}</td>
          <td>${escapeHtml(movement.status_label || '-')}</td>
          <td class="balance-cell">${escapeHtml(money(movement.running_balance))}</td>
        </tr>
      `
    )
    .join('');

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Cuenta corriente ${escapeHtml(payload.customer.name)}</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #fff; color: #111827; font-family: Arial, sans-serif; }
    body { min-height: 100vh; }
    .page { width: 100%; padding: 8mm; }
    .sheet { width: 100%; display: grid; gap: 12px; }
    .banner { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 16px; align-items: center; padding: 8px 10px; border: 1px solid #0b0b0b; border-radius: 12px; }
    .brand { display: flex; gap: 14px; align-items: center; }
    .logo-box { width: 84px; height: 84px; border: 1px solid #0b0b0b; border-radius: 10px; display: grid; place-items: center; padding: 6px; }
    .logo-box img { width: 100%; height: 100%; object-fit: contain; display: block; }
    .brand-name { font-size: 28px; font-weight: 900; color: #2d0a5b; text-transform: uppercase; line-height: 1; }
    .brand-meta { color: #475569; font-size: 12px; margin-top: 4px; }
    .title-chip { display: inline-block; padding: 8px 18px; border-radius: 12px; background: #2d0a5b; color: #a5f341; font-weight: 900; font-size: 16px; letter-spacing: .08em; text-transform: uppercase; }
    .panel { background: #fff; border: 1px solid #0b0b0b; border-radius: 12px; padding: 12px; }
    .header-grid { display: grid; grid-template-columns: 1fr 320px; gap: 12px; }
    .customer { display: grid; gap: 6px; font-size: 12px; }
    .customer strong { font-size: 18px; }
    .meta-grid { display: grid; gap: 8px; }
    .meta-row { display: flex; justify-content: space-between; gap: 12px; font-size: 12px; border-bottom: 1px solid #e5e7eb; padding-bottom: 6px; }
    .meta-row:last-child { border-bottom: 0; padding-bottom: 0; }
    .meta-row span { color: #475569; text-transform: uppercase; font-size: 10px; letter-spacing: .05em; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 9px 8px; border-bottom: 1px solid #e2e8f0; text-align: left; font-size: 12px; vertical-align: top; }
    th { background: #f8fafc; text-transform: uppercase; font-size: 11px; }
    .debit { color: #b91c1c; font-weight: 700; }
    .credit { color: #0f766e; font-weight: 700; }
    .balance-cell { font-weight: 700; }
    @media print {
      .banner, .panel, table { break-inside: avoid; }
      thead { display: table-header-group; }
      tr { page-break-inside: avoid; }
      @page { size: A4; margin: 6mm; }
    }
  </style>
</head>
<body>
  <div class="page">
    <div class="sheet">
      <section class="banner">
        <div class="brand">
          <div class="logo-box"><img src="${escapeHtml(logoUrl)}" alt="USB Shop" /></div>
          <div>
            <div class="brand-name">USB Shop</div>
            <div class="brand-meta">Cuenta corriente</div>
          </div>
        </div>
        <div class="title-chip">Estado de cuenta</div>
      </section>
      <section class="panel">
        <div class="header-grid">
          <div class="customer">
            <strong>${escapeHtml(payload.customer.name)}</strong>
            <span>${escapeHtml(payload.customer.address || payload.customer.locality || 'Sin domicilio')}</span>
            <span>${escapeHtml(payload.customer.phone || payload.customer.email || 'Sin contacto')}</span>
            <span>${escapeHtml(payload.customer.cuit || 'Sin CUIT/DNI')}</span>
            <span>${escapeHtml(payload.customer.tax_condition || 'Sin condicion fiscal')}</span>
          </div>
          <div class="meta-grid">
            <div class="meta-row"><span>Cliente</span><strong>#${escapeHtml(payload.customer.id)}</strong></div>
            <div class="meta-row"><span>Periodo</span><strong>${escapeHtml(payload.rangeLabel)}</strong></div>
            <div class="meta-row"><span>Saldo actual</span><strong>${escapeHtml(payload.balance >= 0 ? `Deudor ${money(payload.balance)}` : `A favor ${money(Math.abs(payload.balance))}`)}</strong></div>
            <div class="meta-row"><span>Movimientos</span><strong>${escapeHtml(payload.movements.length)}</strong></div>
          </div>
        </div>
      </section>
      <section class="panel">
        <table>
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Concepto</th>
              <th>Detalle</th>
              <th>Importe</th>
              <th>Estado</th>
              <th>Saldo</th>
            </tr>
          </thead>
          <tbody>
            ${movementRows || '<tr><td colspan="6">Sin movimientos.</td></tr>'}
          </tbody>
        </table>
      </section>
    </div>
  </div>
  <script>
    window.addEventListener('load', function() {
      setTimeout(function() { window.print(); }, 120);
    }, { once: true });
  </script>
</body>
</html>`;
};

export async function openAdminAccountPrint(payload: AccountPrintPayload): Promise<void> {
  const popup = window.open('', '_blank', 'width=960,height=900');
  if (!popup) throw new Error('El navegador bloqueo la ventana de impresion');
  const logoUrl = new URL('/logo-small.jpeg', window.location.origin).toString();
  popup.document.open();
  popup.document.write(buildPrintableHtml(payload, logoUrl));
  popup.document.close();
  popup.focus();
}
