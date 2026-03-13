import Link from "next/link";
import type { KeyboardEvent } from "react";
import { DEFAULT_WHATSAPP_LINK } from "@/lib/whatsapp";

type HeroProps = {
  searchValue: string;
  onSearchChange: (value: string) => void;
  onSearchSubmit?: () => void;
  onShortcutClick?: (
    targetId: "catalogo" | "novedades" | "ofertas" | "destacados" | "top-ventas"
  ) => void;
};

export default function Hero({
  searchValue,
  onSearchChange,
  onSearchSubmit,
  onShortcutClick,
}: HeroProps) {
  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") {
      return;
    }
    event.preventDefault();
    onSearchSubmit?.();
  };
  return (
    <div className="hero-block">
      <section className="hero">
        <div className="hero-content">
          <p className="hero-kicker">Stock listo para hoy</p>
          <h1 className="hero-title">Tecnología que se vende rápido, con precios y stock en tiempo real.</h1>
          <div className="hero-banner">
            Top ventas y novedades listas para entregar.
          </div>
          <p className="hero-tagline">
            Compra simple, entrega rápida y atención directa.
          </p>
          <div className="hero-actions">
            <Link href="#novedades" className="button button--lime">
              Ver novedades
            </Link>
            <Link href="#catalogo" className="button button--ghost">
              Ver catálogo completo
            </Link>
            <a
              className="button button--whatsapp"
              href={DEFAULT_WHATSAPP_LINK}
              target="_blank"
              rel="noreferrer noopener"
            >
              Consultar por WhatsApp
            </a>
          </div>
        </div>
          <div className="hero-grid">
          <div className="hero-card">
            <h4>Socios de tu operación</h4>
            <p>Optimizamos tu abastecimiento con procesos claros y tiempos predecibles.</p>
          </div>
          <div className="hero-card">
            <h4>Servicio profesional</h4>
            <p>Atención dedicada, respaldo técnico y seguimiento en cada pedido.</p>
          </div>
          <div className="hero-card">
            <h4>Confianza y transparencia</h4>
            <p>Información clara, stock real y una experiencia de compra consistente.</p>
          </div>
        </div>
      </section>
      <div className="hero-shortcuts">
        <button
          type="button"
          className="hero-shortcut hero-shortcut--hot"
          onClick={() => onShortcutClick?.("novedades")}
        >
          Novedades
        </button>
        <button
          type="button"
          className="hero-shortcut"
          onClick={() => onShortcutClick?.("ofertas")}
        >
          Ofertas
        </button>
        <button
          type="button"
          className="hero-shortcut"
          onClick={() => onShortcutClick?.("destacados")}
        >
          Destacados
        </button>
        <button
          type="button"
          className="hero-shortcut"
          onClick={() => onShortcutClick?.("top-ventas")}
        >
          Productos recomendados
        </button>
      </div>
      <div className="hero-search hero-search--standalone hero-search--sticky">
        <input
          type="search"
          placeholder="Buscar productos por nombre o categoría..."
          aria-label="Buscar productos"
          value={searchValue}
          onChange={(event) => onSearchChange(event.target.value)}
          onKeyDown={handleSearchKeyDown}
        />
        <button type="button" className="button button--lime" onClick={onSearchSubmit}>
          Buscar
        </button>
      </div>
    </div>
  );
}
