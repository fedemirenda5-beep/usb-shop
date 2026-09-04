import { formatArgentinaDateTime } from '@/lib/datetime';

type SettlementInvoice = {
  invoice_id: number;
  created_at?: string | null;
  document_type?: string | null;
  customer_name: string;
  total: number;
  commission: number;
};

type SellerSettlementPrintPayload = {
  sellerName: string;
  commissionPercent: number;
  rangeLabel: string;
  sales: number;
  commission: number;
  invoiceCount: number;
  invoices: SettlementInvoice[];
};

const money = (value: number) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(value || 0);

const escapeHtml = (value: unknown) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const buildPrintableHtml = (payload: SellerSettlementPrintPayload, logoUrl: string) => {
  const rows = payload.invoices
    .map((invoice) => `
      <tr>
        <td>${escapeHtml(formatArgentinaDateTime(invoice.created_at))}</td>
        <td>${escapeHtml(invoice.document_type || 'Factura')} #${escapeHtml(invoice.invoice_id)}</td>
        <td>${escapeHtml(invoice.customer_name)}</td>
        <td>${escapeHtml(money(invoice.total))}</td>
        <td>${escapeHtml(money(invoice.commission))}</td>
      </tr>
    `)
    .join('');

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Liquidacion ${escapeHtml(payload.sellerName)}</title>
  <style>
    * { box-sizing: border-box; }
    html, body { margin: 0; background: #fff; color: #111827; font-family: Arial, sans-serif; }
    .page { padding: 8mm; }
    .header, .panel { border: 1px solid #111827; border-radius: 10px; padding: 12px; }
    .header { display: flex; justify-content: space-between; gap: 18px; align-items: center; }
    .brand { display: flex; align-items: center; gap: 12px; }
    .brand img { width: 62px; height: 62px; object-fit: contain; border: 1px solid #111827; border-radius: 8px; padding: 4px; }
    h1, h2, p { margin: 0; }
    h1 { font-size: 24px; text-transform: uppercase; }
    .muted { margin-top: 4px; color: #475569; font-size: 12px; }
    .chip { padding: 8px 12px; background: #111827; color: #fff; border-radius: 8px; font-size: 12px; font-weight: 700; text-transform: uppercase; }
    .panel { margin-top: 12px; }
    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(145px, 1fr)); gap: 10px; }
    .metric { border: 1px solid #cbd5e1; border-radius: 8px; padding: 10px; }
    .metric span { display: block; color: #475569; font-size: 11px; text-transform: uppercase; }
    .metric strong { display: block; margin-top: 5px; font-size: 18px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 8px; border-bottom: 1px solid #cbd5e1; text-align: left; font-size: 12px; vertical-align: top; }
    th { background: #f8fafc; text-transform: uppercase; font-size: 10px; }
    .money { text-align: right; font-weight: 700; white-space: nowrap; }
    .signatures { display: grid; grid-template-columns: repeat(2, 1fr); gap: 40px; margin-top: 52px; }
    .signature { border-top: 1px solid #111827; padding-top: 7px; text-align: center; font-size: 12px; }
    .note { color: #475569; font-size: 11px; line-height: 1.4; }
    @media print { @page { size: A4; margin: 6mm; } thead { display: table-header-group; } tr { break-inside: avoid; } }
  </style>
</head>
<body>
  <main class="page">
    <section class="header">
      <div class="brand">
        <img src="${escapeHtml(logoUrl)}" alt="USB Shop" />
        <div><h1>USB Shop</h1><p class="muted">Liquidacion de comisiones a vendedor</p></div>
      </div>
      <div class="chip">Comprobante de pago</div>
    </section>
    <section class="panel">
      <h2>${escapeHtml(payload.sellerName)}</h2>
      <p class="muted">Periodo liquidado: ${escapeHtml(payload.rangeLabel)}</p>
    </section>
    <section class="panel summary">
      <div class="metric"><span>Ventas incluidas</span><strong>${escapeHtml(money(payload.sales))}</strong></div>
      <div class="metric"><span>Comprobantes</span><strong>${escapeHtml(payload.invoiceCount)}</strong></div>
      <div class="metric"><span>Comision asignada</span><strong>${escapeHtml(`${payload.commissionPercent}%`)}</strong></div>
      <div class="metric"><span>Total a pagar</span><strong>${escapeHtml(money(payload.commission))}</strong></div>
      <div class="metric"><span>Fecha de emision</span><strong>${escapeHtml(formatArgentinaDateTime(new Date().toISOString()))}</strong></div>
    </section>
    <section class="panel">
      <h2>Detalle de ventas liquidado</h2>
      <table><thead><tr><th>Fecha</th><th>Comprobante</th><th>Cliente</th><th class="money">Venta</th><th class="money">Comision</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5">No hay ventas en este periodo.</td></tr>'}</tbody></table>
    </section>
    <section class="signatures"><div class="signature">Firma del vendedor</div><div class="signature">Firma autorizada</div></section>
    <p class="note">Este comprobante documenta la liquidacion impresa. La impresion no registra ni modifica pagos en el sistema.</p>
  </main>
  <script>window.addEventListener('load', function () { setTimeout(function () { window.print(); }, 120); }, { once: true });</script>
</body>
</html>`;
};

export function openAdminSellerSettlementPrint(payload: SellerSettlementPrintPayload): void {
  const popup = window.open('', '_blank', 'width=960,height=900');
  if (!popup) throw new Error('El navegador bloqueo la ventana de impresion');
  const logoUrl = new URL('/logo-small.jpeg', window.location.origin).toString();
  popup.document.open();
  popup.document.write(buildPrintableHtml(payload, logoUrl));
  popup.document.close();
  popup.focus();
}
