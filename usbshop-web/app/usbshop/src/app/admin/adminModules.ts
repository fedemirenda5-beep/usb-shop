export type AdminModuleId =
  | 'dashboard'
  | 'productos'
  | 'pedidos'
  | 'clientes'
  | 'vendedores'
  | 'generar-comprobante'
  | 'comprobantes'
  | 'cuentas-corrientes'
  | 'balances'
  | 'reportes';

export type AdminModule = {
  id: AdminModuleId;
  title: string;
  href: string;
  navLabel: string;
  dashboardLabel: string;
};

export const ADMIN_MODULES: AdminModule[] = [
  {
    id: 'dashboard',
    title: 'Dashboard',
    href: '/admin',
    navLabel: 'Dashboard',
    dashboardLabel: 'Escritorio operativo con datos reales',
  },
  {
    id: 'productos',
    title: 'Productos',
    href: '/admin/productos',
    navLabel: 'Productos',
    dashboardLabel: 'Stock, imagenes, costos y precios',
  },
  {
    id: 'pedidos',
    title: 'Pedidos Web',
    href: '/admin/pedidos',
    navLabel: 'Pedidos Web',
    dashboardLabel: 'Seguimiento de ordenes de compra web',
  },
  {
    id: 'clientes',
    title: 'Clientes',
    href: '/admin/clientes',
    navLabel: 'Clientes',
    dashboardLabel: 'Clientes y cuenta corriente operativa',
  },
  {
    id: 'vendedores',
    title: 'Vendedores',
    href: '/admin/vendedores',
    navLabel: 'Vendedores',
    dashboardLabel: 'Padron comercial y comisiones',
  },
  {
    id: 'generar-comprobante',
    title: 'Generar comprobante',
    href: '/admin/generar-comprobante',
    navLabel: 'Generar comprobante',
    dashboardLabel: 'Alta operativa de facturas, remitos y notas',
  },
  {
    id: 'comprobantes',
    title: 'Comprobantes emitidos',
    href: '/admin/comprobantes',
    navLabel: 'Comprobantes emitidos',
    dashboardLabel: 'Comprobantes emitidos e historial',
  },
  {
    id: 'cuentas-corrientes',
    title: 'Cuentas corrientes',
    href: '/admin/cuentas-corrientes',
    navLabel: 'Cuentas corrientes',
    dashboardLabel: 'Saldos, aging y cobranzas',
  },
  {
    id: 'balances',
    title: 'Balances',
    href: '/admin/balances',
    navLabel: 'Balances',
    dashboardLabel: 'Resumen comercial y financiero',
  },
  {
    id: 'reportes',
    title: 'Reportes',
    href: '/admin/reportes',
    navLabel: 'Reportes',
    dashboardLabel: 'Analisis detallado y rankings',
  },
];

export const NAV_MODULES = ADMIN_MODULES.filter((module) => module.id !== 'dashboard');
