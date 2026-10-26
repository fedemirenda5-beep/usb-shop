'use client';

import { useEffect, useState } from 'react';
import { fetchApiResponse } from '@/lib/api';
import styles from './buyerAccounts.module.css';

type Customer = { id: number; name: string; email?: string | null; phone?: string | null };
type Match = Customer & { match_reasons: string[]; is_active: boolean; linked_account_id: number | null };
type Account = { id: number; name: string; email: string; phone: string; status: string; customer_id: number | null; customer_name?: string; matches?: Match[] };
const whatsappNumber = (value: string) => {
  let digits = value.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('54')) return digits;
  if (digits.startsWith('0')) digits = digits.slice(1);
  return digits ? `54${digits}` : '';
};
const labels: Record<string, string> = { pending: 'Pendiente', approved: 'Aprobado', blocked: 'Bloqueado', rejected: 'Rechazado' };
async function api(path: string, body?: object) {
  const response = await fetchApiResponse(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : 'No se pudo guardar');
  return result;
}

export default function BuyerAccountsPanel({ customer }: { customer: Customer | null }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('pending');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [address, setAddress] = useState('');
  const [link, setLink] = useState('');
  const load = async () => { setAccounts(await api('/admin/buyer-accounts')); };
  useEffect(() => { void load().catch(err => setError(err.message)); }, []);
  useEffect(() => { setAddress(customer?.email || ''); setLink(''); setNotice(''); }, [customer?.id, customer?.email]);
  const update = async (account: Account, status: string, customerId?: number | null, createCustomer = false, confirmDistinct = false) => {
    setBusy(true); setError(''); setNotice('');
    try {
      await api(`/admin/buyer-accounts/${account.id}`, { status, customer_id: customerId, create_customer: createCustomer, confirm_distinct_customer: confirmDistinct });
      await load(); setNotice(status === 'approved' ? 'Acceso habilitado. El cliente recibirá un aviso por email.' : 'Acceso actualizado.');
    } catch (err) { setError(err instanceof Error ? err.message : 'No se pudo guardar'); }
    finally { setBusy(false); }
  };
  const selectedAccount = customer ? accounts.find(item => item.customer_id === customer.id) : null;
  const count = accounts.filter(item => item.status === 'pending').length;
  return <section className={styles.panel}>
    <div className={styles.actions}><h2>Acceso de clientes a la web</h2><button type="button" onClick={() => { setOpen(!open); void load().catch(err => setError(err.message)); }}>Solicitudes pendientes · {count}</button></div>
    {error && <p role="alert" className={styles.error}>{error}</p>}{notice && <p role="status">{notice}</p>}
    {customer && <div className={styles.card}>
      <strong>{customer.name}</strong><p>{selectedAccount ? `${selectedAccount.email} · ${labels[selectedAccount.status]}` : 'Todavía no tiene acceso a la web.'}</p>
      {selectedAccount && <p>Contraseña elegida por el cliente. Guardada de forma protegida; no es visible para el personal.</p>}
      {selectedAccount?.status === 'approved' ? <button disabled={busy} onClick={() => void update(selectedAccount, 'blocked')}>Suspender acceso</button> : selectedAccount && <button disabled={busy} onClick={() => void update(selectedAccount, 'approved', customer.id)}>Habilitar acceso</button>}
      {!selectedAccount || selectedAccount.status === 'approved' ? <form onSubmit={async event => {
        event.preventDefault(); setBusy(true); setError(''); setLink('');
        try { const result = await api(`/admin/buyer-invitations/${customer.id}`, { email: address }); setLink(result.url); }
        catch (err) { setError(err instanceof Error ? err.message : 'No se pudo generar'); }
        finally { setBusy(false); }
      }}><label>Email del cliente<input type="email" value={address} onChange={event => setAddress(event.target.value)} required /></label><button disabled={busy}>Generar invitación</button><small>El cliente elige su contraseña y queda habilitado. El enlace dura 7 días y se usa una sola vez.</small></form> : null}
      {link && <div><label>Invitación lista<input value={link} readOnly onFocus={event => event.target.select()} /></label><div className={styles.actions}><button onClick={() => void navigator.clipboard.writeText(link).then(() => setNotice('Enlace copiado.')).catch(() => setNotice('Seleccioná el enlace para copiarlo.'))}>Copiar enlace</button><a target="_blank" rel="noreferrer" href={`https://wa.me/${whatsappNumber(customer.phone || '')}?text=${encodeURIComponent(`Hola ${customer.name}, te invitamos a USB Shop. Elegí tu contraseña y ya podés ver precios y comprar: ${link}`)}`}>Compartir por WhatsApp</a></div></div>}
    </div>}
    {open && <><div className={styles.actions}><label>Mostrar<select value={filter} onChange={event => setFilter(event.target.value)}><option value="pending">Pendientes</option><option value="all">Todas las cuentas</option><option value="approved">Aprobadas</option><option value="blocked">Bloqueadas</option><option value="rejected">Rechazadas</option></select></label><button onClick={() => void load().catch(err => setError(err.message))}>Actualizar</button></div>
      <div className={styles.grid}>{accounts.filter(item => filter === 'all' || item.status === filter).map(item => <AccountCard key={item.id} account={item} busy={busy} update={update} />)}</div>
      {!accounts.some(item => filter === 'all' || item.status === filter) && <p>No hay cuentas en este estado.</p>}
    </>}
  </section>;
}

function AccountCard({ account, busy, update }: { account: Account; busy: boolean; update: (a: Account, s: string, id?: number | null, create?: boolean, confirmDistinct?: boolean) => Promise<void> }) {
  const [query, setQuery] = useState('');
  const [customers, setCustomers] = useState<Customer[]>([]);
  const matches = account.matches || [];
  const suggested = matches.length === 1 && matches[0].is_active !== false && !matches[0].linked_account_id ? String(matches[0].id) : '';
  const [target, setTarget] = useState(account.customer_id ? String(account.customer_id) : suggested);
  const [confirmDistinct, setConfirmDistinct] = useState(false);
  const needsReview = matches.length > 1 || matches.some(match => match.is_active === false || Boolean(match.linked_account_id));
  const choices = [...new Map([...matches, ...customers].map(customer => [customer.id, customer])).values()];
  const [searchError, setSearchError] = useState('');
  useEffect(() => {
    if (!query.trim()) { setCustomers([]); return; }
    let active = true;
    const timer = window.setTimeout(() => { void api(`/admin/backoffice-customers?q=${encodeURIComponent(query)}&limit=20`).then(data => { if (active) { setCustomers(Array.isArray(data) ? data : data.customers || []); setSearchError(''); } }).catch(() => { if (active) setSearchError('No se pudo buscar. Reintentá.'); }); }, 300);
    return () => { active = false; window.clearTimeout(timer); };
  }, [query]);
  return <article className={styles.card}><strong>{account.name} · {labels[account.status]}</strong><p>{account.email}<br />{account.phone}</p>
    <p>El cliente ya eligió su contraseña.</p>
    {account.customer_name && <p>Ficha: {account.customer_name}</p>}
    {!account.customer_id && <>
      {!needsReview && <p>{suggested && target === suggested ? `Al aceptar se conserva la ficha de ${matches[0].name}.` : 'Al aceptar queda habilitado para ver precios y comprar.'}</p>}
      {needsReview && <p>Revisá las coincidencias y elegí la ficha correcta antes de aceptar.</p>}
      <details open={needsReview || undefined}><summary>Revisar ficha del cliente</summary>
      {matches.length > 0 && <div><strong>Posibles clientes existentes</strong><p>Al vincular una ficha se conservan sus datos, comprobantes y cuenta corriente. El email de ingreso se mantiene separado del email comercial.</p>{matches.map(match => <p key={match.id}>{match.name} · {match.email || match.phone || `#${match.id}`}<br /><small>Coincide por {match.match_reasons.map(reason => ({ name: 'nombre, aunque cambie el orden', email: 'email', phone: 'teléfono' }[reason] || reason)).join(', ')}{match.is_active === false ? ' · Cliente inactivo' : ''}{match.linked_account_id ? ' · Ya tiene cuenta vinculada' : ''}</small></p>)}</div>}
      <label>Vincular a un cliente existente<input placeholder="Buscar por nombre, email o teléfono" value={query} onChange={event => setQuery(event.target.value)} /></label>{searchError && <p role="alert">{searchError}</p>}
      <label>Ficha del cliente<select value={target} onChange={event => { setTarget(event.target.value); setConfirmDistinct(false); }}><option value="">Elegir…</option><option value="new">Crear un cliente nuevo</option>{choices.map(customer => { const match = matches.find(item => item.id === customer.id); return <option key={customer.id} value={customer.id} disabled={match?.is_active === false || Boolean(match?.linked_account_id)}>{customer.name} · {customer.email || customer.phone || `#${customer.id}`}</option>; })}</select></label>
      {target === 'new' && matches.length > 0 && <label><input type="checkbox" checked={confirmDistinct} onChange={event => setConfirmDistinct(event.target.checked)} />Confirmo que es otra persona o comercio y corresponde crear una ficha nueva.</label>}
      </details>
    </>}
    <div className={styles.actions}>{account.status !== 'approved' && <button disabled={busy || (needsReview && !target && !account.customer_id) || (target === 'new' && matches.length > 0 && !confirmDistinct)} onClick={() => void update(account, 'approved', target === 'new' ? null : Number(target) || account.customer_id, target === 'new', confirmDistinct)}>Aceptar</button>}{account.status === 'pending' && <button disabled={busy} onClick={() => void update(account, 'rejected')}>Rechazar</button>}{account.status === 'approved' && <button disabled={busy} onClick={() => void update(account, 'blocked')}>Suspender</button>}<a target="_blank" rel="noreferrer" href={`https://wa.me/${whatsappNumber(account.phone)}`}>WhatsApp</a></div>
  </article>;
}
