"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

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

type CampaignTheme =
  | "worldcup"
  | "fathersday"
  | "childrensday"
  | "mothersday"
  | "christmas";

type CampaignBanner = {
  variant: "standard" | "worldcup";
  theme: CampaignTheme;
  eyebrow: string;
  title?: string;
  message: string;
  meta: string;
  ctaLabel: string;
  href: string;
};

const getNthWeekdayOfMonth = (
  year: number,
  monthIndex: number,
  weekday: number,
  occurrence: number
) => {
  const firstDay = new Date(year, monthIndex, 1);
  const offset = (weekday - firstDay.getDay() + 7) % 7;
  return new Date(year, monthIndex, 1 + offset + (occurrence - 1) * 7);
};

const getAnnualCampaignBanner = (now: Date): CampaignBanner | null => {
  const year = now.getFullYear();
  const currentTime = now.getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  const campaignLeadDays = 7;
  const withinWindow = (target: Date, daysBefore: number, daysAfter: number) => {
    const deltaDays = Math.floor((currentTime - target.getTime()) / dayMs);
    return deltaDays >= -daysBefore && deltaDays <= daysAfter;
  };

  const worldCupStart = new Date(2026, 5, 11);
  const worldCupEnd = new Date(2026, 6, 19);
  if (
    currentTime >= worldCupStart.getTime() - campaignLeadDays * dayMs &&
    currentTime <= worldCupEnd.getTime()
  ) {
    return {
      variant: "worldcup",
      theme: "worldcup",
      eyebrow: "Modo Mundial",
      title: "Vamos Argentina",
      message:
        "Tecnologia, regalos y oportunidades para vivir cada partido con toda la energia argentina.",
      meta: "Seleccion tematica y oportunidades por tiempo limitado",
      ctaLabel: "Ver destacados",
      href: "#catalogo",
    };
  }

  const fathersDay = getNthWeekdayOfMonth(year, 5, 0, 3);
  if (withinWindow(fathersDay, campaignLeadDays, 2)) {
    return {
      variant: "standard",
      theme: "fathersday",
      eyebrow: "Dia del Padre",
      title: "Regalos para papa",
      message:
        "Ideas utiles, cancheras y listas para elegir rapido un regalo con personalidad.",
      meta: "Especial para papa",
      ctaLabel: "Explorar regalos",
      href: "#catalogo",
    };
  }

  const childrensDay = getNthWeekdayOfMonth(year, 7, 0, 3);
  if (withinWindow(childrensDay, campaignLeadDays, 2)) {
    return {
      variant: "standard",
      theme: "childrensday",
      eyebrow: "Feliz dia del niño!",
      title: "Regalos con juego y tecnologia",
      message: "",
      meta: "Jugar · regalar · sorprender",
      ctaLabel: "Ver seleccion",
      href: "/?categoria=Juguetes#selected-category-results",
    };
  }

  const mothersDay = getNthWeekdayOfMonth(year, 9, 0, 3);
  if (withinWindow(mothersDay, campaignLeadDays, 2)) {
    return {
      variant: "standard",
      theme: "mothersday",
      eyebrow: "Dia de la Madre",
      title: "Un regalo bien pensado",
      message:
        "Una seleccion delicada, linda y practica para encontrar un regalo con mucho mimo.",
      meta: "Especial para mama",
      ctaLabel: "Ver seleccion",
      href: "#catalogo",
    };
  }

  const christmasStart = new Date(year, 11, 25);
  if (withinWindow(christmasStart, campaignLeadDays, 1)) {
    return {
      variant: "standard",
      theme: "christmas",
      eyebrow: "Navidad USB Shop",
      title: "Regalos para el arbol",
      message:
        "Regalos con clima festivo, colores de temporada y opciones listas para celebrar.",
      meta: "Magia de fin de ano",
      ctaLabel: "Ver catalogo",
      href: "#catalogo",
    };
  }

  return null;
};

const CampaignVisual = ({ theme }: { theme: CampaignTheme }) => {
  if (theme === "worldcup") {
    return (
      <div className="navbar-note-visual" aria-hidden="true">
        <div className="navbar-note-confetti">
          <span className="navbar-note-confetti-piece navbar-note-confetti-piece--1" />
          <span className="navbar-note-confetti-piece navbar-note-confetti-piece--2" />
          <span className="navbar-note-confetti-piece navbar-note-confetti-piece--3" />
          <span className="navbar-note-confetti-piece navbar-note-confetti-piece--4" />
          <span className="navbar-note-confetti-piece navbar-note-confetti-piece--5" />
        </div>
        <div className="navbar-note-flag">
          <span className="navbar-note-flag-sun" />
        </div>
      </div>
    );
  }

  if (theme === "fathersday") {
    return (
      <div className="navbar-note-visual navbar-note-visual--fathersday" aria-hidden="true">
        <span className="navbar-note-fathers-star navbar-note-fathers-star--1" />
        <span className="navbar-note-fathers-star navbar-note-fathers-star--2" />
        <span className="navbar-note-fathers-mustache" />
        <span className="navbar-note-fathers-tie" />
      </div>
    );
  }

  if (theme === "mothersday") {
    return (
      <div className="navbar-note-visual navbar-note-visual--mothersday" aria-hidden="true">
        <span className="navbar-note-heart navbar-note-heart--main" />
        <span className="navbar-note-heart navbar-note-heart--small" />
        <span className="navbar-note-flower navbar-note-flower--left" />
        <span className="navbar-note-flower navbar-note-flower--right" />
      </div>
    );
  }

  if (theme === "christmas") {
    return (
      <div className="navbar-note-visual navbar-note-visual--christmas" aria-hidden="true">
        <span className="navbar-note-snow navbar-note-snow--1" />
        <span className="navbar-note-snow navbar-note-snow--2" />
        <span className="navbar-note-tree" />
        <span className="navbar-note-giftbox" />
      </div>
    );
  }

  return (
    <div className="navbar-note-visual navbar-note-visual--childrensday" aria-hidden="true">
      <span className="navbar-note-kids-aura" />
      <span className="navbar-note-kids-grid" />
      <span className="navbar-note-kids-ribbon">Kids tech picks</span>
      <span className="navbar-note-kids-card navbar-note-kids-card--plane">
        <img src="/seasonal/childrensday-plane.png" alt="" />
      </span>
      <span className="navbar-note-kids-card navbar-note-kids-card--train">
        <img src="/seasonal/childrensday-train.png" alt="" />
      </span>
      <span className="navbar-note-kids-card navbar-note-kids-card--car">
        <img src="/seasonal/childrensday-car.png" alt="" />
      </span>
    </div>
  );
};

export default function Navbar({
  cartCount = 0,
  cartTotal = 0,
  onCartClick,
  showTrust = true,
}: NavbarProps) {
  const [campaignBanner, setCampaignBanner] = useState<CampaignBanner | null>(null);
  const cartIsFull = cartCount > 0;

  useEffect(() => {
    setCampaignBanner(getAnnualCampaignBanner(new Date()));
  }, []);

  const cartPillContent = (
    <>
      <span className="cart-visual" aria-hidden="true">
        <svg
          viewBox="0 0 32 24"
          className={`cart-visual-svg ${
            cartIsFull ? "cart-visual-svg--full" : "cart-visual-svg--empty"
          }`}
          role="presentation"
        >
          {cartIsFull ? (
            <>
              <rect className="cart-box-shape cart-box-shape--back" x="9" y="6" width="6" height="5" rx="1" />
              <rect className="cart-box-shape cart-box-shape--mid" x="13" y="5" width="6" height="6" rx="1" />
              <rect className="cart-box-shape cart-box-shape--front" x="17" y="6" width="6" height="5" rx="1" />
            </>
          ) : null}
          <path
            className="cart-basket-shape"
            d="M5 5h4l2.4 9h11.5l2.8-7.5H12.2"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle className="cart-wheel-shape" cx="13" cy="19" r="2.1" />
          <circle className="cart-wheel-shape" cx="22" cy="19" r="2.1" />
          <path
            className="cart-handle-shape"
            d="M4 4.5l-1.5-2"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <span>Carrito</span>
      <span className="cart-count">{cartCount}</span>
      <span>${cartTotal.toLocaleString("es-AR")}</span>
    </>
  );

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
        </div>
        {showTrust && campaignBanner ? (
          <Link
            href={campaignBanner.href}
            className={`navbar-note navbar-note--${campaignBanner.variant} navbar-note--${campaignBanner.theme}`}
            aria-label={`${campaignBanner.eyebrow}: ${campaignBanner.title || campaignBanner.message}`}
          >
            <CampaignVisual theme={campaignBanner.theme} />
            <div className="navbar-note-copy">
              <div className="navbar-note-topline">
                <span className="navbar-note-kicker">{campaignBanner.eyebrow}</span>
                <span className="navbar-note-chip">Curaduria USB Shop</span>
              </div>
              {campaignBanner.title ? (
                <strong className="navbar-note-title">{campaignBanner.title}</strong>
              ) : null}
              <span className="navbar-note-text">{campaignBanner.message}</span>
              {campaignBanner.theme === "childrensday" ? (
                <div className="navbar-note-badges" aria-hidden="true">
                  <span className="navbar-note-badge">Seleccion especial</span>
                  <span className="navbar-note-badge">Juguetes + tech</span>
                  <span className="navbar-note-badge">Entrega rapida</span>
                </div>
              ) : null}
              <div className="navbar-note-footer">
                <span className="navbar-note-meta">{campaignBanner.meta}</span>
                <span className="navbar-note-cta">
                  {campaignBanner.ctaLabel}
                  <span aria-hidden="true">→</span>
                </span>
              </div>
            </div>
          </Link>
        ) : null}
        {onCartClick ? (
          <button type="button" className="cart-pill" onClick={onCartClick}>
            {cartPillContent}
          </button>
        ) : (
          <Link href="#carrito" className="cart-pill">
            {cartPillContent}
          </Link>
        )}
      </div>
    </header>
  );
}
