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
        <section className="footer-brands" aria-labelledby="footer-brands-heading">
          <div>
            <h3 id="footer-brands-heading">Marcas que encontrás en USB Shop</h3>
            <p>Tecnología para todos los días.</p>
          </div>
          <ul className="footer-brands-list" aria-label="Marcas del catálogo">
            <li><Image className="footer-brand-samsung" src="/brands/samsung.svg" alt="Samsung" width={130} height={29} /></li>
            <li><Image className="footer-brand-xiaomi" src="/brands/xiaomi.png" alt="Xiaomi" width={36} height={36} /><span aria-hidden="true">Xiaomi</span></li>
            <li><Image className="footer-brand-iglufive" src="/brands/iglufive.jpg" alt="Iglufive" width={100} height={100} /></li>
            <li><Image className="footer-brand-sandisk" src="/brands/sandisk.svg" alt="SanDisk" width={150} height={35} /></li>
            <li><Image className="footer-brand-gtc" src="/brands/gtc.png" alt="GTC" width={120} height={120} /></li>
            <li><Image className="footer-brand-time" src="/brands/time.webp" alt="Time" width={170} height={170} /></li>
          </ul>
        </section>
        <div className="footer-grid">
          <section className="footer-col" aria-label="USB Shop">
            <div className="footer-brand">
              <div className="logo-badge footer-logo">
                <Image src="/logo-small.jpeg" alt="USB Shop" width={44} height={44} />
              </div>
              <div>
                <div className="footer-brand__title">
                  <span className="logo-accent">USB</span> Shop
                </div>
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
