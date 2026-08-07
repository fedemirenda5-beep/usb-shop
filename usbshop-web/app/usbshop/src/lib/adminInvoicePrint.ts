import { fetchApiResponse, getApiBaseUrl, getFriendlyApiError } from '@/lib/api';
import { formatArgentinaDateTime } from '@/lib/datetime';

type InvoicePrintDetail = {
  invoice: {
    id: number;
    customer_name: string;
    created_at: string;
    document_type?: string | null;
    sale_mode?: string | null;
    price_list?: number | null;
    notes?: string | null;
    customer_email?: string | null;
    customer_phone?: string | null;
    locality?: string | null;
    address?: string | null;
    tax_condition?: string | null;
    cuit?: string | null;
    seller_name?: string | null;
    special_discount?: number | null;
  };
  items: Array<{
    id: number;
    product_name: string;
    quantity: number;
    unit_price: number;
    line_total: number;
    imeis?: string[];
  }>;
  payments: Array<{
    id: number;
    amount: number;
    movement_type: string;
    reference?: string | null;
    created_at?: string | null;
    payment_method?: string | null;
  }>;
  summary: {
    subtotal: number;
    special_discount?: number;
    total?: number;
    payments_total: number;
    balance_due: number;
  };
};

const money = (value: number) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(value || 0);

const formatDate = (value?: string | null) => formatArgentinaDateTime(value);

const getPriceListLabel = (value?: number | null) => {
  if (value === 1) return 'Lista 1';
  if (value === 2) return 'Lista 2';
  return 'Lista especial';
};

const escapeHtml = (value: unknown) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const buildPrintableHtml = (detail: InvoicePrintDetail, logoUrl: string) => {
  const itemRows = detail.items
    .map((item) => {
      const imeisHtml =
        Array.isArray(item.imeis) && item.imeis.length > 0
          ? `<div class="imei-list">IMEI${item.imeis.length === 1 ? '' : 's'}: ${escapeHtml(item.imeis.join(', '))}</div>`
          : '';
      return `
        <tr>
          <td>${escapeHtml(item.quantity)}</td>
          <td>
            <div class="product-info">
              <span>${escapeHtml(item.product_name)}</span>
              ${imeisHtml}
            </div>
          </td>
          <td>${escapeHtml(money(item.unit_price))}</td>
          <td class="total-cell">${escapeHtml(money(item.line_total))}</td>
        </tr>
      `
    })
    .join('');

  const paymentRows =
    detail.payments.length === 0
      ? `<div class="empty-box">Sin pagos o ajustes asociados.</div>`
      : detail.payments
          .map(
            (payment) => `
              <article class="movement-item">
                <strong>${escapeHtml(payment.movement_type === 'CREDIT' ? 'Cobranza' : 'Debito')}</strong>
                <span>${escapeHtml(payment.payment_method || payment.reference || 'Movimiento manual')}</span>
                <span>${escapeHtml(formatDate(payment.created_at))}</span>
                <em>${escapeHtml(money(payment.amount))}</em>
              </article>
            `
          )
          .join('');

  const notesHtml = detail.invoice.notes
    ? `
      <section class="notes-box">
        <span class="section-title">Observaciones</span>
        <p>${escapeHtml(detail.invoice.notes)}</p>
      </section>
    `
    : '';

  const specialDiscountInvoice =
    Number(detail.invoice.special_discount || 0) > 0
      ? `<div class="meta-row"><span>Descuento especial</span><strong>-${escapeHtml(money(Number(detail.invoice.special_discount || 0)))}</strong></div>`
      : '';

  const specialDiscountSummary =
    Number(detail.summary.special_discount || 0) > 0
      ? `
        <div class="meta-row inverted"><span>Subtotal</span><strong>${escapeHtml(money(detail.summary.subtotal))}</strong></div>
        <div class="meta-row inverted"><span>Descuento especial</span><strong>-${escapeHtml(money(Number(detail.summary.special_discount || 0)))}</strong></div>
      `
      : '';

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Comprobante #${escapeHtml(detail.invoice.id)}</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #fff; color: #111827; font-family: Arial, sans-serif; }
    body { min-height: 100vh; }
    .page { width: 100%; padding: 8mm; }
    .sheet { width: 100%; display: grid; gap: 12px; }
    .accent { height: 4px; background: #2d0a5b; border-radius: 999px; }
    .banner { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 16px; align-items: center; padding: 8px 10px; border: 1px solid #0b0b0b; border-radius: 12px; }
    .brand { display: flex; gap: 14px; align-items: center; }
    .logo-box { width: 84px; height: 84px; border: 1px solid #0b0b0b; border-radius: 10px; display: grid; place-items: center; padding: 6px; }
    .logo-box img { width: 100%; height: 100%; object-fit: contain; display: block; }
    .brand-name { font-size: 28px; font-weight: 900; color: #2d0a5b; text-transform: uppercase; line-height: 1; }
    .brand-meta { color: #475569; font-size: 12px; margin-top: 4px; }
    .doc-kind { display: inline-block; padding: 8px 18px; border-radius: 12px; background: #2d0a5b; color: #a5f341; font-weight: 900; font-size: 16px; letter-spacing: .12em; text-transform: uppercase; }
    .panel { background: #fff; border: 1px solid #0b0b0b; border-radius: 12px; padding: 10px 12px; }
    .header-grid { display: grid; grid-template-columns: 1.15fr .85fr; border: 1px solid #0b0b0b; border-radius: 8px; overflow: hidden; }
    .column { padding: 12px 14px; }
    .column + .column { border-left: 1px solid #0b0b0b; }
    .section-title { text-transform: uppercase; letter-spacing: .12em; font-size: 10px; color: #2d0a5b; font-weight: 800; margin-bottom: 10px; display: block; }
    .customer { display: grid; gap: 6px; color: #0b0b0b; font-size: 11px; }
    .customer strong { font-size: 17px; }
    .meta-rows { display: grid; gap: 0; }
    .meta-row { display: grid; grid-template-columns: minmax(120px,.95fr) minmax(0,1fr); gap: 16px; font-size: 11px; padding: 5px 0; border-bottom: 1px solid #e2e8f0; align-items: baseline; }
    .meta-row:last-child { border-bottom: 0; padding-bottom: 0; }
    .meta-row span { color: #475569; text-transform: uppercase; letter-spacing: .05em; font-size: 10px; }
    .meta-row strong { color: #0f172a; text-align: right; font-size: 12px; }
    .notes-box { display: grid; gap: 8px; padding: 12px; border-radius: 12px; border: 1px solid #0b0b0b; background: #f0fdfa; }
    .notes-box p { margin: 0; font-size: 12px; line-height: 1.45; }
    .table-wrap { border: 1px solid #0b0b0b; border-radius: 12px; overflow: hidden; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 9px 8px; border-bottom: 1px solid #e2e8f0; text-align: left; font-size: 13px; vertical-align: top; }
    th { background: #f8fafc; text-transform: uppercase; font-size: 12px; }
    .product-info { display: grid; gap: 4px; min-width: 0; }
    .product-info span { overflow-wrap: anywhere; }
    .imei-list { font-size: 11px; color: #475569; overflow-wrap: anywhere; }
    .total-cell { color: #111827; font-weight: 700; }
    .footer { display: grid; grid-template-columns: minmax(0,1.1fr) minmax(260px,.9fr); gap: 16px; align-items: start; }
    .payments { display: grid; gap: 10px; }
    .payments h3 { margin: 0; font-size: 16px; }
    .movement-list { display: grid; gap: 10px; }
    .movement-item { display: grid; grid-template-columns: 1fr 1fr 1fr auto; gap: 10px; align-items: center; padding: 10px; border-radius: 12px; background: #f8fafc; }
    .movement-item span { color: #475569; font-size: 12px; }
    .movement-item em { font-style: normal; font-weight: 700; color: #111827; }
    .empty-box { padding: 12px; border: 1px solid #cbd5e1; border-radius: 12px; color: #475569; }
    .total-box { border: 2px solid #a5f341; border-radius: 12px; padding: 14px; background: #0f172a; color: #e2e8f0; display: grid; gap: 10px; }
    .total-label { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; opacity: .9; }
    .total-value { font-size: 24px; font-weight: 900; color: #a5f341; }
    .meta-row.inverted span { color: #cbd5e1; }
    .meta-row.inverted strong { color: #f8fafc; }
    .signature-row { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 16px; padding-top: 16px; }
    .signature-box { min-height: 88px; border-top: 1px solid #94a3b8; display: flex; align-items: flex-end; padding-top: 10px; color: #475569; font-size: 12px; }
    @media print {
      .banner, .panel, .notes-box, .table-wrap, .footer, .signature-row { break-inside: avoid; }
      thead { display: table-header-group; }
      tr { page-break-inside: avoid; }
      @page { size: A4; margin: 6mm; }
    }
  </style>
</head>
<body>
  <div class="page">
    <div class="sheet">
      <div class="accent"></div>
      <section class="banner">
        <div class="brand">
          <div class="logo-box"><img src="${escapeHtml(logoUrl)}" alt="USB Shop" /></div>
          <div>
            <div class="brand-name">USB Shop</div>
            <div class="brand-meta">Venta mayorista</div>
          </div>
        </div>
        <div class="doc-kind">${escapeHtml(detail.invoice.document_type || 'Comprobante')}</div>
      </section>
      <section class="panel">
        <div class="header-grid">
          <div class="column">
            <span class="section-title">Datos del cliente</span>
            <div class="customer">
              <strong>${escapeHtml(detail.invoice.customer_name)}</strong>
              <span>${escapeHtml(detail.invoice.address || detail.invoice.locality || 'Sin domicilio registrado')}</span>
              <span>${escapeHtml(detail.invoice.customer_phone || detail.invoice.customer_email || 'Sin contacto registrado')}</span>
              <span>${escapeHtml(detail.invoice.cuit ? `CUIT / DNI: ${detail.invoice.cuit}` : 'CUIT / DNI: -')}</span>
              <span>${escapeHtml(detail.invoice.tax_condition ? `Condicion fiscal: ${detail.invoice.tax_condition}` : 'Condicion fiscal: -')}</span>
            </div>
          </div>
          <div class="column">
            <span class="section-title">Resumen</span>
            <div class="meta-rows">
              <div class="meta-row"><span>Numero</span><strong>#${escapeHtml(detail.invoice.id)}</strong></div>
              <div class="meta-row"><span>Fecha de emision</span><strong>${escapeHtml(formatDate(detail.invoice.created_at))}</strong></div>
              <div class="meta-row"><span>Vendedor</span><strong>${escapeHtml(detail.invoice.seller_name || '-')}</strong></div>
              <div class="meta-row"><span>Modo de venta</span><strong>${escapeHtml(detail.invoice.sale_mode || '-')}</strong></div>
              <div class="meta-row"><span>Lista de precios</span><strong>${escapeHtml(getPriceListLabel(detail.invoice.price_list))}</strong></div>
              ${specialDiscountInvoice}
            </div>
          </div>
        </div>
      </section>
      ${notesHtml}
      <section class="panel">
        <span class="section-title">Detalle</span>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Cant.</th>
                <th>Producto</th>
                <th>Unitario</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>${itemRows}</tbody>
          </table>
        </div>
      </section>
      <section class="footer">
        <div class="payments">
          <h3>Movimientos asociados</h3>
          <div class="movement-list">${paymentRows}</div>
        </div>
        <div class="total-box">
          <span class="total-label">Total a pagar</span>
          <strong class="total-value">${escapeHtml(money(Number(detail.summary.total ?? detail.summary.subtotal)))}</strong>
          ${specialDiscountSummary}
          <div class="meta-row inverted"><span>Cobrado</span><strong>${escapeHtml(money(detail.summary.payments_total))}</strong></div>
          <div class="meta-row inverted"><span>Saldo</span><strong>${escapeHtml(money(detail.summary.balance_due))}</strong></div>
        </div>
      </section>
      <section class="signature-row">
        <div class="signature-box"><span>Firma / aclaracion</span></div>
        <div class="signature-box"><span>Recepcion conforme</span></div>
      </section>
    </div>
  </div>
  <script>
    (function() {
      var fired = false;
      function triggerPrint() {
        if (fired) return;
        fired = true;
        setTimeout(function() { window.print(); }, 120);
      }
      var images = Array.prototype.slice.call(document.images || []);
      if (images.length === 0) {
        if (document.readyState === 'complete') triggerPrint();
        else window.addEventListener('load', triggerPrint, { once: true });
        return;
      }
      var pending = images.length;
      function done() {
        pending -= 1;
        if (pending <= 0) triggerPrint();
      }
      images.forEach(function(img) {
        if (img.complete) done();
        else {
          img.addEventListener('load', done, { once: true });
          img.addEventListener('error', done, { once: true });
        }
      });
      setTimeout(triggerPrint, 1500);
    })();
  </script>
</body>
</html>`;
};

export async function openAdminInvoicePrint(invoiceId: number): Promise<void> {
  const popup = window.open('', '_blank', 'width=960,height=900');
  if (!popup) {
    throw new Error('El navegador bloqueo la ventana de impresion');
  }
  popup.document.open();
  popup.document.write('<!doctype html><html><head><meta charset="utf-8"><title>Preparando impresion</title></head><body style="font-family:Arial,sans-serif;padding:24px">Preparando comprobante...</body></html>');
  popup.document.close();

  try {
    const res = await fetchApiResponse(`/admin/invoices/${invoiceId}`);
    if (!res.ok) throw new Error('No se pudo cargar el comprobante');
    const detail = (await res.json()) as InvoicePrintDetail;
    const logoUrl = new URL('/logo-small.jpeg', window.location.origin).toString();
    popup.document.open();
    popup.document.write(buildPrintableHtml(detail, logoUrl));
    popup.document.close();
    popup.focus();
  } catch (error) {
    const message = getFriendlyApiError(error, 'No se pudo preparar la impresion');
    popup.document.open();
    popup.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Error</title></head><body style="font-family:Arial,sans-serif;padding:24px;color:#b91c1c">${escapeHtml(message)}</body></html>`);
    popup.document.close();
    throw error;
  }
}
