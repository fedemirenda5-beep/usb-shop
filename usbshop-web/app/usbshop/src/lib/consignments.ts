import { fetchApiResponse, loadRuntimeConfig } from './api';

export type Consignment = {
  id: number; customer_id: number; customer_name: string; created_at: string;
  notes: string; pending: number; delivered: number; sold: number; returned: number;
};
export type ConsignmentDetail = Consignment & {
  items: Array<{ product_id: number; name: string; sku: string; price: number; general_stock: number;
    delivered: number; sold: number; returned: number; pending: number }>;
  movements: Array<{ id: string; kind: string; name: string; quantity: number; created_at: string; invoice_id: number | null }>;
};

export async function consignmentRequest<T>(path: string, payload?: unknown): Promise<T> {
  await loadRuntimeConfig();
  const response = await fetchApiResponse(path, payload === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'No se pudo completar la operacion');
  return data as T;
}
