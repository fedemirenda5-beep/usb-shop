'use client';

import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Error de aplicacion', error);
  }, [error]);

  return (
    <main
      style={{
        minHeight: '70vh',
        display: 'grid',
        placeItems: 'center',
        padding: '2rem',
        textAlign: 'center',
      }}
    >
      <section>
        <h1>No se pudo cargar esta seccion</h1>
        <p>La informacion no se perdio. Reintenta la carga o vuelve al inicio.</p>
        <button type="button" onClick={reset}>Reintentar</button>
        <a href="/" style={{ display: 'block', marginTop: '1rem' }}>Volver al inicio</a>
      </section>
    </main>
  );
}
