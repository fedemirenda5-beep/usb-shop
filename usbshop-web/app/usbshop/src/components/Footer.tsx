import Image from "next/image";
import Link from "next/link";

const WHATSAPP_LINK =
  "https://wa.me/542364574765?text=Hola%2C%20quiero%20consultar%20por%20un%20producto";

export default function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="site-footer" aria-labelledby="footer-heading">
      <h2 id="footer-heading" className="sr-only">
        Información de la tienda
      </h2>
      <div className="footer-inner">
        <div className="footer-grid">
          <section className="footer-col" aria-label="USB Shop">
            <div className="footer-brand">
              <div className="footer-logo">
                <Image src="/usbshop-logo.jpeg" alt="USB Shop" width={74} height={74} />
              </div>
              <div>
                <div className="footer-brand__title">USB Shop</div>
                <div className="footer-brand__tag">Venta mayorista</div>
              </div>
            </div>
            <p className="footer-text">
              Tecnología con stock y precios actualizados para vender rápido.
            </p>
          </section>

          <section className="footer-col" aria-label="Contacto">
            <div className="footer-title">Contacto</div>
            <a
              className="footer-link"
              href={WHATSAPP_LINK}
              target="_blank"
              rel="noreferrer noopener"
            >
              WhatsApp
            </a>
            <p className="footer-muted">
              Atención directa para consultas, disponibilidad y coordinación de entrega.
            </p>
          </section>

          <section className="footer-col" aria-label="Envíos y pagos">
            <div className="footer-title">Envíos y pagos</div>
            <ul className="footer-list">
              <li>Envío rápido</li>
              <li>Gratis desde $250.000 o 24/48h según zona</li>
              <li>Transferencia, efectivo o contra entrega</li>
            </ul>
          </section>

          <section className="footer-col" aria-label="Legal">
            <div className="footer-title">Legal</div>
            <ul className="footer-links">
              <li>
                <Link className="footer-link" href="/cambios-y-devoluciones/">
                  Cambios y devoluciones
                </Link>
              </li>
              <li>
                <Link className="footer-link" href="/terminos/">
                  Términos
                </Link>
              </li>
              <li>
                <Link className="footer-link" href="/privacidad/">
                  Privacidad
                </Link>
              </li>
            </ul>
            <p className="footer-muted">
              Todos nuestros productos tienen garantía por fallas de fábrica.
            </p>
          </section>
        </div>

        <div className="footer-bottom">
          <span>© {year} USB Shop.</span>
          <span className="footer-sep" aria-hidden="true">
            ·
          </span>
          <span>Todos los derechos reservados.</span>
        </div>
      </div>
    </footer>
  );
}
