import Link from "next/link";

export default function PrivacidadPage() {
  return (
    <main className="page">
      <header className="section">
        <p className="section-kicker">Legal</p>
        <h1 className="section-title">Privacidad</h1>
        <p className="hero-text">
          Usamos tus datos únicamente para gestionar pedidos y responder consultas.
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
            <h4>Qué datos recopilamos</h4>
            <p>
              Cuando generás un pedido, solicitamos nombre, teléfono y email. Las notas son
              opcionales.
            </p>
          </div>
          <div className="info-card">
            <h4>Para qué los usamos</h4>
            <p>
              Para contactar al cliente, confirmar disponibilidad, coordinar entrega y dar
              seguimiento al pedido.
            </p>
          </div>
          <div className="info-card">
            <h4>Compartir información</h4>
            <p>
              No vendemos ni publicamos tus datos. Solo se usan para la operación de compra y la
              atención al cliente.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
