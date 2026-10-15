type ShippingCoverCustomer = {
  name: string;
  address?: string | null;
  locality?: string | null;
};

const escapeHtml = (value: string) => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

export function buildShippingCoverPrintHtml(customer: ShippingCoverCustomer): string {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Carátula de envío - ${escapeHtml(customer.name)}</title>
  <style>
    * { box-sizing: border-box; }
    html, body { margin: 0; background: #fff; color: #000; font-family: Arial, sans-serif; }
    main { margin: 16mm; padding: 14mm; border: 2px solid #000; }
    h1 { margin: 0 0 14mm; font-size: 22px; text-transform: uppercase; }
    dl { margin: 0; }
    dt { margin-top: 10mm; font-size: 16px; text-transform: uppercase; }
    dd { margin: 3mm 0 0; font-size: 32px; font-weight: bold; overflow-wrap: anywhere; white-space: pre-wrap; }
    .sender { margin-top: 14mm; padding-top: 8mm; border-top: 1px solid #000; }
    .sender dd { font-size: 26px; }
    @page { size: A4 portrait; margin: 12mm; }
    @media print { main { margin: 0; } }
  </style>
</head>
<body>
  <main>
    <h1>Carátula de envío</h1>
    <dl>
      <dt>Destinatario</dt>
      <dd>${escapeHtml(customer.name)}</dd>
      <dt>Dirección</dt>
      <dd>${escapeHtml(customer.address?.trim() || 'Sin dirección cargada')}</dd>
      <dt>Localidad</dt>
      <dd>${escapeHtml(customer.locality?.trim() || 'Sin localidad cargada')}</dd>
    </dl>
    <dl class="sender">
      <dt>Remitente</dt>
      <dd>Federico Mirenda</dd>
    </dl>
  </main>
</body>
</html>`;
}

export function openAdminShippingCoverPrint(customer: ShippingCoverCustomer): void {
  const popup = window.open('', '_blank', 'width=900,height=800');
  if (!popup) {
    throw new Error('El navegador bloqueó la ventana de impresión. Permití las ventanas emergentes y volvé a intentar.');
  }
  popup.document.open();
  popup.document.write(buildShippingCoverPrintHtml(customer));
  popup.document.close();
  popup.focus();
  popup.print();
}
