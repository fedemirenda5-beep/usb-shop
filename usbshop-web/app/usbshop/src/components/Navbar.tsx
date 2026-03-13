import Link from "next/link";

type NavItem = {
  label: string;
  href: string;
};

type NavbarProps = {
  cartCount?: number;
  cartTotal?: number;
  onCartClick?: () => void;
  navItems?: NavItem[];
  showTrust?: boolean;
};

export default function Navbar({
  cartCount = 0,
  cartTotal = 0,
  onCartClick,
  showTrust = true,
}: NavbarProps) {
  return (
    <header className="navbar">
      <div className="navbar-top">
        <div className="navbar-brand">
          <Link href="/" className="logo">
            <div className="logo-badge">
              <img src="/logo-small.jpeg" alt="USB Shop" />
            </div>
            <div className="logo-text">
              <h1>
                <span className="logo-accent">USB</span> Shop
              </h1>
            </div>
          </Link>
          {showTrust ? (
            <div className="navbar-trust">
              <div className="trust-item trust-item--compact">
                <span className="trust-title">Envio rapido</span>
                <span className="trust-text">Gratis desde $250.000 o 24/48h segun zona.</span>
              </div>
              <div className="trust-item trust-item--compact">
                <span className="trust-title">Pago seguro</span>
                <span className="trust-text">Transferencia, efectivo o contra entrega.</span>
              </div>
              <div className="trust-item trust-item--compact">
                <span className="trust-title">Stock real</span>
                <span className="trust-text">Lo que ves, esta disponible para pedir.</span>
              </div>
            </div>
          ) : null}
        </div>
        {onCartClick ? (
          <button type="button" className="cart-pill" onClick={onCartClick}>
            <span>Carrito</span>
            <span className="cart-count">{cartCount}</span>
            <span>${cartTotal.toLocaleString("es-AR")}</span>
          </button>
        ) : (
          <Link href="#carrito" className="cart-pill">
            <span>Carrito</span>
            <span className="cart-count">{cartCount}</span>
            <span>${cartTotal.toLocaleString("es-AR")}</span>
          </Link>
        )}
      </div>
    </header>
  );
}
