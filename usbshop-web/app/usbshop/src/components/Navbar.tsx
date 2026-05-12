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
              <p>Accesorios, audio y tecnologia para tu dia a dia.</p>
            </div>
          </Link>
          {showTrust ? <div className="navbar-note">Stock real y atencion directa por WhatsApp.</div> : null}
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
