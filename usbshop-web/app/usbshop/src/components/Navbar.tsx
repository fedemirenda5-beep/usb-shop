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

type CampaignBanner = {
  eyebrow: string;
  message: string;
};

const defaultCampaignBanner: CampaignBanner = {
  eyebrow: "Temporada especial",
  message: "Elegi regalos y oportunidades pensadas para cada fecha importante del ano.",
};

const getNthWeekdayOfMonth = (year: number, monthIndex: number, weekday: number, occurrence: number) => {
  const firstDay = new Date(year, monthIndex, 1);
  const offset = (weekday - firstDay.getDay() + 7) % 7;
  return new Date(year, monthIndex, 1 + offset + (occurrence - 1) * 7);
};

const getAnnualCampaignBanner = (now: Date): CampaignBanner => {
  const year = now.getFullYear();
  const currentTime = now.getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  const withinWindow = (target: Date, daysBefore: number, daysAfter: number) => {
    const deltaDays = Math.floor((currentTime - target.getTime()) / dayMs);
    return deltaDays >= -daysBefore && deltaDays <= daysAfter;
  };

  const worldCupStart = new Date(2026, 5, 11);
  const worldCupEnd = new Date(2026, 6, 19);
  if (currentTime >= worldCupStart.getTime() && currentTime <= worldCupEnd.getTime()) {
    return {
      eyebrow: "Modo Mundial",
      message: "Argentina late fuerte: ideas para alentar, regalar y disfrutar cada partido.",
    };
  }

  const fathersDay = getNthWeekdayOfMonth(year, 5, 0, 3);
  if (withinWindow(fathersDay, 14, 2)) {
    return {
      eyebrow: "Dia del Padre",
      message: "Regalos utiles y tecnologia para sorprender a papa en su semana especial.",
    };
  }

  const childrensDay = getNthWeekdayOfMonth(year, 7, 0, 3);
  if (withinWindow(childrensDay, 21, 2)) {
    return {
      eyebrow: "Dia del Nino",
      message: "Ideas para regalar, jugar y compartir con los mas chicos.",
    };
  }

  const mothersDay = getNthWeekdayOfMonth(year, 9, 0, 3);
  if (withinWindow(mothersDay, 21, 2)) {
    return {
      eyebrow: "Dia de la Madre",
      message: "Seleccion especial para regalar algo lindo, practico y bien pensado.",
    };
  }

  const christmasStart = new Date(year, 11, 1);
  const christmasEnd = new Date(year, 11, 26);
  if (currentTime >= christmasStart.getTime() && currentTime <= christmasEnd.getTime()) {
    return {
      eyebrow: "Navidad USB Shop",
      message: "Regalos listos para poner abajo del arbol y resolver tus compras de fin de ano.",
    };
  }

  return defaultCampaignBanner;
};

export default function Navbar({
  cartCount = 0,
  cartTotal = 0,
  onCartClick,
  showTrust = true,
}: NavbarProps) {
  const [campaignBanner, setCampaignBanner] = useState<CampaignBanner>(defaultCampaignBanner);

  useEffect(() => {
    setCampaignBanner(getAnnualCampaignBanner(new Date()));
  }, []);

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
        {showTrust ? (
          <div className="navbar-note">
            <span className="navbar-note-kicker">{campaignBanner.eyebrow}</span>
            <span className="navbar-note-text">{campaignBanner.message}</span>
          </div>
        ) : null}
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
