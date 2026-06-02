import type { AdminModuleId } from './adminModules';

export type AdminRole = 'admin' | 'staff' | string;

const STAFF_HIDDEN_MODULES = new Set<AdminModuleId>(['balances', 'reportes', 'usuarios']);

export const canAccessAdminModule = (role: AdminRole | null | undefined, moduleId: AdminModuleId) => {
  if ((role || '').toLowerCase() === 'staff') {
    return !STAFF_HIDDEN_MODULES.has(moduleId);
  }
  return true;
};

export const canViewProfitMetrics = (role: AdminRole | null | undefined) =>
  (role || '').toLowerCase() !== 'staff';
