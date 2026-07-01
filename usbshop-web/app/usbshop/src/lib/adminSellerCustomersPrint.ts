type SellerCustomerPrintItem = {
  id: number;
  name: string;
  phone?: string | null;
  email?: string | null;
  locality?: string | null;
  address?: string | null;
  zone?: string | null;
  balance?: number;
};

type SellerCustomerPrintPayload = {
  sellerName: string;
  generatedAtLabel: string;
  customers: SellerCustomerPrintItem[];
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

const buildPrintableHtml = (payload: SellerCustomerPrintPayload, logoUrl: string) => {
  const rows = payload.customers
    .map(
      (customer) => `
        <tr>
          <td>#${escapeHtml(customer.id)}</td>
          <td>
            <strong>${escapeHtml(customer.name)}</strong>
            <div class="subline">${escapeHtml(customer.locality || '')}</div>
          </td>
          <td>${escapeHtml(customer.phone || customer.email || '-')}</td>
          <td>${escapeHtml(customer.zone || '-')}</td>
          <td>${escapeHtml(customer.address || '-')}</td>
          <td class="${(customer.balance || 0) > 0 ? 'debt' : 'credit'}">${escapeHtml(money(customer.balance || 0))}</td>
        </tr>
      `
    )
    .join('');

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Clientes de ${escapeHtml(payload.sellerName)}</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #fff; color: #0f172a; font-family: Arial, sans-serif; }
    body { min-height: 100vh; }
    .page { padding: 8mm; }
    .sheet { display: grid; gap: 12px; }
    .banner { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 16px; align-items: center; padding: 10px 12px; border: 1px solid #0b0b0b; border-radius: 12px; }
    .brand { display: flex; align-items: center; gap: 14px; }
    .logo-box { width: 72px; height: 72px; border: 1px solid #0b0b0b; border-radius: 10px; display: grid; place-items: center; padding: 6px; }
    .logo-box img { width: 100%; height: 100%; object-fit: contain; display: block; }
    .brand-name { font-size: 26px; font-weight: 900; text-transform: uppercase; line-height: 1; }
    .brand-meta { color: #475569; font-size: 12px; margin-top: 4px; }
    .title-chip { display: inline-block; padding: 8px 16px; border-radius: 12px; background: #0f766e; color: #fff; font-weight: 900; font-size: 15px; text-transform: uppercase; }
    .panel { border: 1px solid #0b0b0b; border-radius: 12px; padding: 12px; }
    .meta-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
    .meta-card { border: 1px solid #e2e8f0; border-radius: 10px; padding: 10px; }
    .meta-card span { display: block; color: #64748b; font-size: 10px; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 4px; }
    .meta-card strong { font-size: 16px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 9px 8px; border-bottom: 1px solid #e2e8f0; text-align: left; font-size: 12px; vertical-align: top; }
    th { background: #f8fafc; text-transform: uppercase; font-size: 11px; }
    .subline { margin-top: 4px; color: #64748b; font-size: 11px; }
    .debt { color: #b91c1c; font-weight: 700; }
    .credit { color: #047857; font-weight: 700; }
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
            <div class="brand-meta">Listado de clientes por vendedor</div>
          </div>
        </div>
        <div class="title-chip">${escapeHtml(payload.sellerName)}</div>
      </section>
      <section class="panel">
        <div class="meta-grid">
          <div class="meta-card">
            <span>Vendedor</span>
            <strong>${escapeHtml(payload.sellerName)}</strong>
          </div>
          <div class="meta-card">
            <span>Clientes</span>
            <strong>${escapeHtml(payload.customers.length)}</strong>
          </div>
          <div class="meta-card">
            <span>Emitido</span>
            <strong>${escapeHtml(payload.generatedAtLabel)}</strong>
          </div>
        </div>
      </section>
      <section class="panel">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Cliente</th>
              <th>Contacto</th>
              <th>Zona</th>
              <th>Direccion</th>
              <th>Saldo</th>
            </tr>
          </thead>
          <tbody>
            ${rows || '<tr><td colspan="6">Sin clientes asignados.</td></tr>'}
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

export async function openAdminSellerCustomersPrint(payload: SellerCustomerPrintPayload): Promise<void> {
  const popup = window.open('', '_blank', 'width=960,height=900');
  if (!popup) throw new Error('El navegador bloqueo la ventana de impresion');
  const logoUrl = new URL('/logo-small.jpeg', window.location.origin).toString();
  popup.document.open();
  popup.document.write(buildPrintableHtml(payload, logoUrl));
  popup.document.close();
  popup.focus();
}
