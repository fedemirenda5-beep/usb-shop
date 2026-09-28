import type { ConsignmentDetail } from './consignments';
import { formatArgentinaDateTime } from './datetime';

const escapeHtml = (value: unknown) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export function buildConsignmentPrintHtml(detail: ConsignmentDetail, logoUrl: string): string {
  const rows = detail.items.map(item => `<tr>
    <td>${escapeHtml(item.sku || '—')}</td>
    <td>${escapeHtml(item.name)}</td>
    <td class="quantity">${escapeHtml(item.delivered)}</td>
  </tr>`).join('');
  return `<!doctype html>
<html lang="es"><head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Consignación #${escapeHtml(detail.id)} — USB Shop</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; color: #17202e; background: white; font: 14px Arial, sans-serif; }
    main { max-width: 900px; margin: auto; padding: 24px; }
    header { display: flex; align-items: center; gap: 16px; border-bottom: 2px solid #291342; padding-bottom: 18px; }
    header img { width: 64px; height: 64px; object-fit: contain; }
    h1 { margin: 4px 0; font-size: 23px; }
    p { line-height: 1.5; }
    .customer { margin: 20px 0; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid #cbd5e1; overflow-wrap: anywhere; }
    th { background: #f1f5f9; font-size: 12px; }
    .quantity { text-align: right; }
    .total { text-align: right; font-weight: bold; }
    .notes { white-space: pre-wrap; overflow-wrap: anywhere; }
    .signatures { display: flex; gap: 40px; margin-top: 70px; break-inside: avoid; }
    .signature { flex: 1; border-top: 1px solid #17202e; padding-top: 8px; font-size: 12px; }
    .toolbar { padding: 12px; text-align: center; background: #f1f5f9; }
    button { padding: 10px 18px; font: inherit; cursor: pointer; }
    @media print {
      @page { size: A4; margin: 12mm; }
      main { max-width: none; padding: 0; }
      .toolbar { display: none; }
      thead { display: table-header-group; }
      tr { break-inside: avoid; }
    }
  </style>
</head><body>
  <div class="toolbar"><button id="print-document" type="button">Imprimir / Guardar PDF</button></div>
  <main>
    <header><img src="${escapeHtml(logoUrl)}" alt="USB Shop" /><div>
      <strong>USB Shop</strong><h1>Entrega en consignación #${escapeHtml(detail.id)}</h1>
      <span>Fecha de entrega: ${escapeHtml(formatArgentinaDateTime(detail.created_at))}</span>
    </div></header>
    <p class="customer"><strong>Cliente:</strong> ${escapeHtml(detail.customer_name)}</p>
    <table><thead><tr><th>SKU</th><th>Producto</th><th class="quantity">Unidades entregadas</th></tr></thead>
      <tbody>${rows}</tbody></table>
    <p class="total">Total de unidades entregadas: ${escapeHtml(detail.delivered)}</p>
    ${detail.notes ? `<p class="notes"><strong>Observaciones:</strong>\n${escapeHtml(detail.notes)}</p>` : ''}
    <p>Mercadería entregada en consignación.</p>
    <div class="signatures"><div class="signature">Entregó · Firma y aclaración</div><div class="signature">Recibió · Firma y aclaración</div></div>
  </main>
</body></html>`;
}

export function openAdminConsignmentPrint(detail: ConsignmentDetail): void {
  const popup = window.open('', '_blank', 'width=960,height=900');
  if (!popup) throw new Error('El navegador bloqueó la ventana de impresión. Permití las ventanas emergentes y volvé a intentar.');
  popup.document.open();
  popup.document.write(buildConsignmentPrintHtml(detail, new URL('/logo-small.jpeg', window.location.origin).toString()));
  popup.document.close();
  const print = () => { if (!popup.closed) { popup.focus(); popup.print(); } };
  popup.document.getElementById('print-document')?.addEventListener('click', print);
  const logo = popup.document.querySelector('img');
  if (!logo || logo.complete) { print(); return; }
  let printed = false;
  const printOnce = () => {
    if (printed) return;
    printed = true;
    window.clearTimeout(timeout);
    print();
  };
  const timeout = window.setTimeout(printOnce, 1500);
  logo.addEventListener('load', printOnce, { once: true });
  logo.addEventListener('error', printOnce, { once: true });
}
