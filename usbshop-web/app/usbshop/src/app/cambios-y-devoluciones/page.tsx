import Link from "next/link";

const WHATSAPP_LINK =
  "https://wa.me/542364574765?text=Hola%2C%20quiero%20gestionar%20un%20cambio%20o%20devoluci%C3%B3n";

export default function CambiosYDevolucionesPage() {
  return (
    <main className="page">
      <header className="section">
        <p className="section-kicker">Legal</p>
        <h1 className="section-title">Cambios y devoluciones</h1>
        <p className="hero-text">
          Todos nuestros productos tienen garantía por fallas de fábrica. Si tenés un problema con
          tu compra, escribinos y lo resolvemos.
        </p>
        <div className="section-actions">
          <a className="button button--lime" href={WHATSAPP_LINK} target="_blank" rel="noreferrer noopener">
            Hablar por WhatsApp
          </a>
          <Link className="button button--ghost" href="/">
            Volver a la tienda
          </Link>
        </div>
      </header>

      <section className="section section--tight">
        <div className="info-grid">
          <div className="info-card">
            <h4>Garantía por fallas de fábrica</h4>
            <p>
              Si el producto presenta una falla de fabricación, gestionamos la solución y la
              coordinación de entrega o reemplazo según corresponda.
            </p>
          </div>
          <div className="info-card">
            <h4>Qué necesitamos</h4>
            <p>
              Para agilizar el trámite, envianos el número de pedido (si lo tenés) y una breve
              descripción del problema. Si podés, sumá fotos o video.
            </p>
          </div>
          <div className="info-card">
            <h4>Coordinación</h4>
            <p>
              Te respondemos por WhatsApp para coordinar la entrega, el cambio o la devolución según
              el caso.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}

