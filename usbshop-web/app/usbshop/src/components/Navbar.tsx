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
      <svg className="navbar-note-scene" viewBox="0 0 196 112" role="presentation" focusable="false">
        <defs>
          <linearGradient id="kidsCardGlow" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.98" />
            <stop offset="100%" stopColor="#dbeafe" stopOpacity="0.12" />
          </linearGradient>
          <linearGradient id="kidsPlaneBody" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#93c5fd" />
            <stop offset="100%" stopColor="#2563eb" />
          </linearGradient>
          <linearGradient id="kidsPlaneAccent" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#fef3c7" />
            <stop offset="100%" stopColor="#fb7185" />
          </linearGradient>
          <linearGradient id="kidsTrainBody" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#f472b6" />
            <stop offset="100%" stopColor="#be185d" />
          </linearGradient>
          <linearGradient id="kidsTrainAccent" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#fde68a" />
            <stop offset="100%" stopColor="#f59e0b" />
          </linearGradient>
          <linearGradient id="kidsCarBody" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#4ade80" />
            <stop offset="100%" stopColor="#15803d" />
          </linearGradient>
          <linearGradient id="kidsGlass" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#f8fafc" />
            <stop offset="100%" stopColor="#bfdbfe" />
          </linearGradient>
          <radialGradient id="kidsHalo" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.78" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </radialGradient>
        </defs>

        <rect x="8" y="8" width="180" height="96" rx="34" fill="url(#kidsCardGlow)" />
        <ellipse cx="134" cy="26" rx="28" ry="10" fill="rgba(255,255,255,.62)" />
        <ellipse cx="154" cy="23" rx="16" ry="7" fill="rgba(255,255,255,.78)" />
        <ellipse cx="52" cy="18" rx="18" ry="7" fill="rgba(255,255,255,.54)" />
        <circle cx="156" cy="28" r="24" fill="url(#kidsHalo)" />

        <g className="navbar-note-scene-plane">
          <ellipse cx="36" cy="28" rx="24" ry="7" className="navbar-note-scene-shadow-soft" />
          <path
            d="M6 23L35 16L55 2L63 6L49 19L81 22L88 28L50 31L38 47L29 44L31 31L6 34L6 23Z"
            fill="url(#kidsPlaneBody)"
          />
          <path d="M37 17L48 9L54 10L47 18Z" fill="url(#kidsPlaneAccent)" />
          <path d="M36 23H53" className="navbar-note-scene-plane-line" />
          <circle cx="31" cy="24" r="2.2" fill="rgba(255,255,255,.92)" />
          <path d="M14 27C23 19 31 16 39 14" className="navbar-note-scene-trail" />
        </g>

        <path d="M20 77C58 72 110 72 178 78" className="navbar-note-scene-ground" />
        <path d="M18 82H172" className="navbar-note-scene-rail" />
        <path d="M18 87H172" className="navbar-note-scene-rail" />
        <g opacity=".42">
          <path d="M28 82V87" className="navbar-note-scene-rail-sleeper" />
          <path d="M46 82V87" className="navbar-note-scene-rail-sleeper" />
          <path d="M64 82V87" className="navbar-note-scene-rail-sleeper" />
          <path d="M82 82V87" className="navbar-note-scene-rail-sleeper" />
          <path d="M100 82V87" className="navbar-note-scene-rail-sleeper" />
          <path d="M118 82V87" className="navbar-note-scene-rail-sleeper" />
          <path d="M136 82V87" className="navbar-note-scene-rail-sleeper" />
          <path d="M154 82V87" className="navbar-note-scene-rail-sleeper" />
        </g>

        <g className="navbar-note-scene-train">
          <ellipse cx="47" cy="50" rx="40" ry="8" className="navbar-note-scene-shadow-soft" />
          <rect x="14" y="33" width="34" height="21" rx="8" fill="url(#kidsTrainBody)" />
          <rect x="48" y="36" width="26" height="18" rx="6" fill="#ec4899" />
          <path d="M20 33L28 24H39V33" fill="url(#kidsTrainAccent)" />
          <rect x="22" y="39" width="9" height="7" rx="2.4" fill="url(#kidsGlass)" />
          <rect x="34" y="39" width="8" height="7" rx="2.4" fill="url(#kidsGlass)" />
          <rect x="54" y="40" width="7" height="6" rx="2.1" fill="url(#kidsGlass)" />
          <rect x="63" y="40" width="7" height="6" rx="2.1" fill="url(#kidsGlass)" />
          <path d="M18 49H70" className="navbar-note-scene-highlight-line" />
          <circle cx="25" cy="57" r="5.2" className="navbar-note-scene-wheel" />
          <circle cx="48" cy="57" r="5.2" className="navbar-note-scene-wheel" />
          <circle cx="66" cy="57" r="5.2" className="navbar-note-scene-wheel" />
          <circle cx="25" cy="57" r="2.1" className="navbar-note-scene-wheel-core" />
          <circle cx="48" cy="57" r="2.1" className="navbar-note-scene-wheel-core" />
          <circle cx="66" cy="57" r="2.1" className="navbar-note-scene-wheel-core" />
          <path d="M17 52H72" stroke="rgba(15,23,42,.16)" strokeWidth="1.5" strokeLinecap="round" />
        </g>

        <g className="navbar-note-scene-car">
          <ellipse cx="33" cy="35" rx="26" ry="8" className="navbar-note-scene-shadow-soft" />
          <path
            d="M10 41C10 33 16 28 25 28H37L46 18H58C66 18 72 23 74 30L77 40C77 45 72 49 66 49H24C16 49 10 46 10 41Z"
            fill="url(#kidsCarBody)"
          />
          <path d="M29 28L38 22H58C63 22 67 24 69 28" fill="#bbf7d0" />
          <rect x="34" y="24" width="11" height="8" rx="2.4" fill="url(#kidsGlass)" />
          <rect x="48" y="24" width="15" height="8" rx="2.4" fill="url(#kidsGlass)" />
          <path d="M17 41H69" className="navbar-note-scene-highlight-line" />
          <circle cx="28" cy="50" r="5.6" className="navbar-note-scene-wheel" />
          <circle cx="59" cy="50" r="5.6" className="navbar-note-scene-wheel" />
          <circle cx="28" cy="50" r="2.2" className="navbar-note-scene-wheel-core" />
          <circle cx="59" cy="50" r="2.2" className="navbar-note-scene-wheel-core" />
          <circle cx="69" cy="37" r="1.6" fill="rgba(255,255,255,.9)" />
        </g>
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
