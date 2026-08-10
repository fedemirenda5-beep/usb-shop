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
          <linearGradient id="toySkyFade" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.96" />
            <stop offset="100%" stopColor="#dbeafe" stopOpacity="0.2" />
          </linearGradient>
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
          <linearGradient id="toyWindow" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#f8fafc" />
            <stop offset="100%" stopColor="#cbd5e1" />
          </linearGradient>
          <radialGradient id="toyGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.65" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </radialGradient>
        </defs>

        <rect x="6" y="5" width="128" height="74" rx="28" fill="url(#toySkyFade)" />
        <ellipse cx="96" cy="18" rx="16" ry="6" fill="rgba(255,255,255,.55)" />
        <ellipse cx="111" cy="16" rx="9" ry="4" fill="rgba(255,255,255,.7)" />
        <ellipse cx="34" cy="11" rx="11" ry="4" fill="rgba(255,255,255,.52)" />
        <circle cx="112" cy="20" r="18" fill="url(#toyGlow)" />

        <g className="navbar-note-scene-plane">
          <ellipse cx="23" cy="18" rx="18" ry="5" className="navbar-note-scene-shadow-soft" />
          <path
            d="M0 13L18 9L31 0L36 4L26 11L46 13L50 17L27 19L19 29L13 27L15 19L0 21L0 13Z"
            fill="url(#toyPlane)"
          />
          <path
            d="M19 13H31"
            className="navbar-note-scene-plane-line"
          />
          <circle cx="17" cy="14" r="1.8" fill="rgba(255,255,255,.85)" />
        </g>

        <path d="M10 60C36 56 78 56 131 61" className="navbar-note-scene-ground" />
        <path d="M10 61C44 65 86 65 131 61" className="navbar-note-scene-ground-soft" />
        <path d="M18 63H122" className="navbar-note-scene-rail" />
        <path d="M18 67H122" className="navbar-note-scene-rail" />
        <g opacity=".45">
          <path d="M25 63V67" className="navbar-note-scene-rail-sleeper" />
          <path d="M39 63V67" className="navbar-note-scene-rail-sleeper" />
          <path d="M53 63V67" className="navbar-note-scene-rail-sleeper" />
          <path d="M67 63V67" className="navbar-note-scene-rail-sleeper" />
          <path d="M81 63V67" className="navbar-note-scene-rail-sleeper" />
          <path d="M95 63V67" className="navbar-note-scene-rail-sleeper" />
          <path d="M109 63V67" className="navbar-note-scene-rail-sleeper" />
        </g>

        <g className="navbar-note-scene-train">
          <ellipse cx="22" cy="34" rx="26" ry="6" className="navbar-note-scene-shadow-soft" />
          <rect x="0" y="14" width="24" height="14" rx="5" fill="url(#toyTrain)" />
          <rect x="22" y="16" width="18" height="12" rx="4" fill="#ec4899" />
          <rect x="6" y="17" width="7" height="5" rx="1.8" fill="url(#toyWindow)" />
          <rect x="15" y="17" width="5" height="5" rx="1.8" fill="url(#toyWindow)" />
          <rect x="26" y="18" width="5" height="4.5" rx="1.6" fill="url(#toyWindow)" />
          <rect x="33" y="18" width="4" height="4.5" rx="1.6" fill="url(#toyWindow)" />
          <path d="M4 14L9 9H17V14" fill="#fbcfe8" />
          <path d="M2 24H38" className="navbar-note-scene-highlight-line" />
          <circle cx="8" cy="31" r="4" className="navbar-note-scene-wheel" />
          <circle cx="23" cy="31" r="4" className="navbar-note-scene-wheel" />
          <circle cx="35" cy="31" r="4" className="navbar-note-scene-wheel" />
          <circle cx="8" cy="31" r="1.7" className="navbar-note-scene-wheel-core" />
          <circle cx="23" cy="31" r="1.7" className="navbar-note-scene-wheel-core" />
          <circle cx="35" cy="31" r="1.7" className="navbar-note-scene-wheel-core" />
          <path d="M2 28H40" stroke="rgba(15,23,42,.18)" strokeWidth="1.4" strokeLinecap="round" />
        </g>

        <g className="navbar-note-scene-car">
          <ellipse cx="23" cy="26" rx="21" ry="6" className="navbar-note-scene-shadow-soft" />
          <path
            d="M0 18C0 13 4 10 9 10H19L25 5H33C37 5 40 8 41 12L43 18C43 21 40 23 37 23H8C3 23 0 21 0 18Z"
            fill="url(#toyCar)"
          />
          <path d="M11 10L17 7H31C33 7 35 8 36 10" fill="#bbf7d0" />
          <rect x="14" y="8" width="7" height="5" rx="1.6" fill="url(#toyWindow)" />
          <rect x="23" y="8" width="9" height="5" rx="1.6" fill="url(#toyWindow)" />
          <path d="M4 18H38" className="navbar-note-scene-highlight-line" />
          <circle cx="10" cy="24" r="4.2" className="navbar-note-scene-wheel" />
          <circle cx="32" cy="24" r="4.2" className="navbar-note-scene-wheel" />
          <circle cx="10" cy="24" r="1.8" className="navbar-note-scene-wheel-core" />
          <circle cx="32" cy="24" r="1.8" className="navbar-note-scene-wheel-core" />
          <circle cx="39" cy="16" r="1.2" fill="rgba(255,255,255,.9)" />
        </g>

        <path d="M19 31C28 21 39 16 53 18" className="navbar-note-scene-trail" />
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
