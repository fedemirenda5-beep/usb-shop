import Link from "next/link";

export default function TerminosPage() {
  return (
    <main className="page">
      <header className="section">
        <p className="section-kicker">Legal</p>
        <h1 className="section-title">Términos</h1>
        <p className="hero-text">
          Al usar este sitio y generar un pedido, aceptás estas condiciones generales.
        </p>
        <div className="section-actions">
          <Link className="button button--ghost" href="/">
            Volver a la tienda
          </Link>
        </div>
      </header>

      <section className="section section--tight">
        <div className="info-grid">
          <div className="info-card">
            <h4>Precios y stock</h4>
            <p>
              El stock y los precios se actualizan de forma dinámica. Si hay una diferencia, te
              contactamos para confirmarlo antes de finalizar.
            </p>
          </div>
          <div className="info-card">
            <h4>Pedidos</h4>
            <p>
              Al iniciar un pedido desde el carrito, se registra como pendiente hasta su
              confirmación por nuestros canales de atención.
            </p>
          </div>
          <div className="info-card">
            <h4>Garantía</h4>
            <p>Todos nuestros productos tienen garantía por fallas de fábrica.</p>
          </div>
        </div>
      </section>
    </main>
  );
}

