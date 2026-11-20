'use client';

import { useEffect, useState } from 'react';
import Navbar from '@/components/Navbar';
import { clearBuyerStorage, useBuyer } from '@/components/BuyerSession';
import { fetchApiResponse } from '@/lib/api';
import './cuenta.css';

export default function BuyerAccountPage() {
  const { buyer, loading } = useBuyer();
  const [mode, setMode] = useState('login');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordMessage, setPasswordMessage] = useState('');
  const [passwordError, setPasswordError] = useState('');
  useEffect(() => {
    const value = new URLSearchParams(window.location.hash.slice(1)).get('token');
    if (value) { setToken(value); setMode('activate'); window.history.replaceState(null, '', window.location.pathname); }
  }, []);
  const title = mode === 'activate' ? 'Elegí tu contraseña' : mode === 'register' ? 'Creá tu cuenta' : mode === 'recover' ? 'Recuperá tu acceso' : 'Ingresá a USB Shop';
  return <><Navbar /><main className="buyer-account"><a href="/">← Volver al catálogo</a>
    <h1>{title}</h1>
    {mode === 'activate' ? <p>Un solo paso para activar tu acceso o renovar tu contraseña.</p> : <p>Tu catálogo de siempre, con precios y compras para clientes habilitados.</p>}
    {buyer && mode !== 'activate' ? <div>
      <p>Hola, {buyer.name}.</p>
      {buyer.status === 'approved' ? <a className="button button--lime" href="/">Ver precios y comprar</a> : <><p>{buyer.status === 'pending' ? 'Recibimos tu solicitud. Estamos habilitando tu acceso y te avisaremos por email.' : 'Tu acceso está suspendido. Contactanos para revisarlo.'}</p><a className="button button--ghost" href="https://wa.me/542364574765?text=Hola%2C%20ya%20cre%C3%A9%20mi%20cuenta%20y%20quiero%20consultar%20por%20la%20habilitaci%C3%B3n.">Consultar por WhatsApp</a></>}
      {!changingPassword ? <button className="buyer-password-toggle" type="button" onClick={() => { setChangingPassword(true); setPasswordError(''); setPasswordMessage(''); }}>Cambiar contraseña</button> : <form onSubmit={async event => {
        event.preventDefault();
        if (passwordBusy) return;
        const form = event.currentTarget;
        const data = Object.fromEntries(new FormData(form));
        if (data.new_password !== data.confirm_password) { setPasswordError('Las contraseñas nuevas no coinciden.'); setPasswordMessage(''); return; }
        setPasswordBusy(true); setPasswordError(''); setPasswordMessage('');
        try {
          const response = await fetchApiResponse('/buyer/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
          const result = await response.json();
          if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : 'No se pudo cambiar la contraseña');
          form.reset();
          setPasswordMessage('Tu contraseña se cambió correctamente.');
          setChangingPassword(false);
        } catch (err) { setPasswordError(err instanceof Error ? err.message : 'No pudimos conectar. Intentá nuevamente.'); }
        finally { setPasswordBusy(false); }
      }}>
        <label>Contraseña actual<input name="current_password" type="password" autoComplete="current-password" maxLength={128} required /></label>
        <label>Nueva contraseña<input name="new_password" type="password" autoComplete="new-password" minLength={8} maxLength={128} required /></label>
        <label>Confirmar nueva contraseña<input name="confirm_password" type="password" autoComplete="new-password" minLength={8} maxLength={128} required /></label>
        {passwordError && <p role="alert" className="buyer-error">{passwordError}</p>}
        <button className="button button--lime" disabled={passwordBusy}>{passwordBusy ? 'Guardando…' : 'Guardar contraseña'}</button>
        <button className="buyer-password-toggle" type="button" onClick={() => { setChangingPassword(false); setPasswordError(''); }}>Cancelar</button>
      </form>}
      {passwordMessage && <p role="status">{passwordMessage}</p>}
    </div> : <form onSubmit={async event => {
      event.preventDefault();
      if (busy) return;
      const data = Object.fromEntries(new FormData(event.currentTarget));
      setBusy(true); setError(''); setMessage('');
      try {
        const response = await fetchApiResponse(`/buyer/${mode}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...data, token }) });
        const result = await response.json();
        if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : 'Revisá los datos e intentá nuevamente');
        if (mode === 'recover') setMessage(result.message);
        else { clearBuyerStorage(result.id); window.location.assign(result.status === 'approved' ? '/' : '/mi-cuenta/'); }
      } catch (err) { setError(err instanceof Error ? err.message : 'No pudimos conectar. Intentá nuevamente.'); }
      finally { setBusy(false); }
    }}>
      {mode === 'register' && <><label>Nombre o comercio<input name="name" autoComplete="organization" maxLength={160} required /></label><label>WhatsApp<input name="phone" type="tel" autoComplete="tel" minLength={6} maxLength={40} required /></label></>}
      {mode !== 'activate' && <label>Email<input name="email" type="email" autoComplete="email" maxLength={254} required /></label>}
      {mode !== 'recover' && <><label>{mode === 'activate' ? 'Nueva contraseña' : 'Contraseña'}<input name="password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={mode === 'login' ? 1 : 8} maxLength={128} aria-describedby={mode !== 'login' ? 'password-help' : undefined} required /></label>{mode !== 'login' && <small id="password-help">Al menos 8 caracteres.</small>}</>}
      {mode === 'register' && <p>Si ya sos cliente, pedinos tu invitación por WhatsApp para entrar sin esperar la aprobación.</p>}
      {mode === 'recover' && <p className="buyer-recovery-help">¿No te llega el correo? <a href={`https://wa.me/542364574765?text=${encodeURIComponent('Hola, no recibí el enlace para recuperar la contraseña de mi cuenta de USB Shop.')}`} target="_blank" rel="noreferrer">Escribinos por WhatsApp y te ayudamos a recuperar el acceso.</a></p>}
      {error && <p role="alert" className="buyer-error">{error}</p>}{message && <p role="status">{message}</p>}
      <button className="button button--lime" disabled={busy || loading}>{busy ? 'Un momento…' : mode === 'activate' ? 'Guardar contraseña y entrar' : mode === 'register' ? 'Crear cuenta' : mode === 'recover' ? 'Enviar enlace' : 'Ingresar'}</button>
      {mode !== 'activate' && <div className="buyer-links">{(['login', 'register', 'recover'] as const).filter(item => item !== mode).map(item => <button key={item} type="button" onClick={() => { setMode(item); setError(''); setMessage(''); }}>{item === 'login' ? 'Ya tengo cuenta' : item === 'register' ? 'Crear cuenta' : 'Olvidé mi contraseña'}</button>)}</div>}
    </form>}
  </main></>;
}
