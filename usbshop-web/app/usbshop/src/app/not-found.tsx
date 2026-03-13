import Link from "next/link";

export default function NotFound() {
  return (
    <main className="page">
      <section className="section">
        <p className="section-kicker">404</p>
        <h1 className="section-title">Página no encontrada</h1>
        <p className="hero-text">
          El enlace puede estar roto o la página ya no existe.
        </p>
        <div className="section-actions">
          <Link className="button button--lime" href="/">
            Volver al inicio
          </Link>
          <Link className="button button--ghost" href="/#catalogo">
            Ir al catálogo
          </Link>
        </div>
      </section>
    </main>
  );
}

