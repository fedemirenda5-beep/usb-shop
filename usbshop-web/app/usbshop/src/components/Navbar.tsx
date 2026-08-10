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
      <svg className="navbar-note-scene" viewBox="0 0 140 86" role="presentation" focusable="false">
        <defs>
          <linearGradient id="toyPlane" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#7dd3fc" />
            <stop offset="100%" stopColor="#2563eb" />
          </linearGradient>
          <linearGradient id="toyTrain" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#f472b6" />
            <stop offset="100%" stopColor="#db2777" />
          </linearGradient>
          <linearGradient id="toyCar" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#4ade80" />
            <stop offset="100%" stopColor="#16a34a" />
          </linearGradient>
        </defs>

        <g className="navbar-note-scene-plane">
          <path
            d="M0 11L18 7L30 0L34 3L25 10L43 11L47 15L24 17L17 26L12 24L14 17L0 19L0 11Z"
            fill="url(#toyPlane)"
          />
          <path d="M16 12H29" className="navbar-note-scene-plane-line" />
        </g>

        <path d="M18 59C48 57 81 57 121 60" className="navbar-note-scene-ground" />

        <g className="navbar-note-scene-train">
          <rect x="0" y="12" width="26" height="12" rx="5" fill="url(#toyTrain)" />
          <rect x="24" y="14" width="20" height="10" rx="4" fill="#ec4899" />
          <rect x="7" y="15" width="8" height="5" rx="2" fill="#fce7f3" />
          <rect x="18" y="15" width="5" height="5" rx="2" fill="#fce7f3" />
          <rect x="28" y="16" width="6" height="4" rx="2" fill="#fce7f3" />
          <circle cx="9" cy="27" r="4" className="navbar-note-scene-wheel" />
          <circle cx="24" cy="27" r="4" className="navbar-note-scene-wheel" />
          <circle cx="37" cy="27" r="4" className="navbar-note-scene-wheel" />
          <circle cx="9" cy="27" r="1.7" className="navbar-note-scene-wheel-core" />
          <circle cx="24" cy="27" r="1.7" className="navbar-note-scene-wheel-core" />
          <circle cx="37" cy="27" r="1.7" className="navbar-note-scene-wheel-core" />
        </g>

        <g className="navbar-note-scene-car">
          <rect x="0" y="10" width="30" height="11" rx="6" fill="url(#toyCar)" />
          <path d="M9 10L15 4H23L27 10" fill="#bbf7d0" />
          <circle cx="8" cy="24" r="4" className="navbar-note-scene-wheel" />
          <circle cx="23" cy="24" r="4" className="navbar-note-scene-wheel" />
          <circle cx="8" cy="24" r="1.7" className="navbar-note-scene-wheel-core" />
          <circle cx="23" cy="24" r="1.7" className="navbar-note-scene-wheel-core" />
        </g>

        <path d="M20 30C28 20 38 16 51 18" className="navbar-note-scene-trail" />
      </svg>
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
              <span className="navbar-note-kicker">{campaignBanner.eyebrow}</span>
              {campaignBanner.title ? (
                <strong className="navbar-note-title">{campaignBanner.title}</strong>
              ) : null}
              <span className="navbar-note-text">{campaignBanner.message}</span>
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
