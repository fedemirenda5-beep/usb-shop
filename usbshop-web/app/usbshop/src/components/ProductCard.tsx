import React from "react";
import { getApiBaseUrl } from "@/lib/api";

type CardProps = {
  product: {
    id: number;
    name: string;
    price: number;
    originalPrice?: number | null;
    category: string;
    stock?: number;
    badge?: string;
    imageUrl?: string | null;
    imageUrls?: string[] | null;
    description?: string | null;
    isFeatured?: boolean;
    flashOffer?: { price: number; endsAt: string } | null;
  };
  inCart?: number;
  onAdd?: () => void;
  onToggleFeatured?: () => void;
  onView?: () => void;
  imagePriority?: "high" | "low" | "auto";
  imageRefreshKey?: number;
  style?: React.CSSProperties;
};

const shallowEqualStyle = (
  left?: React.CSSProperties,
  right?: React.CSSProperties
) => {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return !left && !right;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  return leftKeys.every(
    (key) => left[key as keyof React.CSSProperties] === right[key as keyof React.CSSProperties]
  );
};

const equalImageUrls = (left?: string[] | null, right?: string[] | null) => {
  if (left === right) {
    return true;
  }
  const safeLeft = left ?? [];
  const safeRight = right ?? [];
  if (safeLeft.length !== safeRight.length) {
    return false;
  }
  return safeLeft.every((value, index) => value === safeRight[index]);
};

const CARD_IMAGE_WIDTH = 420;
const CARD_IMAGE_HEIGHT = 315;

const normalizeImageSrc = (value?: string | null) => {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return encodeURI(trimmed);
  } catch {
    return trimmed;
  }
};

const buildCardImageSrc = (value: string) => {
  if (!/\/products\/\d+\/image\b/.test(value)) {
    return value;
  }
  if (/[?&]w=/.test(value) || /[?&]h=/.test(value)) {
    return value;
  }
  const joiner = value.includes("?") ? "&" : "?";
  return `${value}${joiner}w=${CARD_IMAGE_WIDTH}&h=${CARD_IMAGE_HEIGHT}`;
};

const appendCacheBuster = (src: string, attempt: number) => {
  const token = `img_retry=${attempt}-${Date.now()}`;
  return src.includes("?") ? `${src}&${token}` : `${src}?${token}`;
};

const appendRefreshKey = (src: string, refreshKey?: number) => {
  if (!refreshKey || /[?&]img_v=/.test(src)) {
    return src;
  }
  const token = `img_v=${refreshKey}`;
  return src.includes("?") ? `${src}&${token}` : `${src}?${token}`;
};

const buildProxyImageSrc = (productId: number, index?: number) => {
  const baseUrl = getApiBaseUrl();
  const params = new URLSearchParams({
    w: String(CARD_IMAGE_WIDTH),
    h: String(CARD_IMAGE_HEIGHT),
    q: "72",
    format: "webp",
  });
  if (Number.isInteger(index)) {
    params.set("i", String(index));
  }
  const path = `/products/${productId}/image?${params.toString()}`;
  if (!baseUrl) {
    return path;
  }
  return baseUrl.endsWith("/") ? `${baseUrl.slice(0, -1)}${path}` : `${baseUrl}${path}`;
};

const getFallbackLabel = (value?: string | null) => {
  const words = (value ?? "")
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (words.length === 0) {
    return "USB";
  }
  return words
    .slice(0, 2)
    .map((item) => item.charAt(0).toUpperCase())
    .join("");
};

function ProductCard({
  product,
  inCart = 0,
  onAdd,
  onToggleFeatured,
  onView,
  imagePriority = "auto",
  imageRefreshKey,
  style,
}: CardProps) {
  const stock = Number.isFinite(product.stock) ? Number(product.stock) : 0;
  const isOut = stock <= 0;
  const hasDiscount = Boolean(product.originalPrice && product.originalPrice > product.price);
  const badge = isOut
    ? "Sin stock"
    : product.badge ?? (product.flashOffer ? "Relampago" : product.isFeatured ? "Destacado" : undefined);
  const canView = Boolean(onView);
  const preferProxyImage =
    typeof window !== "undefined" &&
    window.location.hostname !== "localhost" &&
    window.location.hostname !== "127.0.0.1";
  const images = React.useMemo(() => {
    const list = (Array.isArray(product.imageUrls) ? product.imageUrls : [product.imageUrl])
      .map((value) => normalizeImageSrc(value))
      .filter((value): value is string => Boolean(value));
    return list;
  }, [product.imageUrls, product.imageUrl]);
  const fallbackLabel = React.useMemo(
    () => getFallbackLabel(product.category || product.name),
    [product.category, product.name]
  );
  const fallbackMeta = product.category?.trim() || "Producto sin foto";
  const [imageIndex, setImageIndex] = React.useState(0);
  const [imgSrc, setImgSrc] = React.useState<string | null>(() => images[0] ?? null);
  const [useRawImage, setUseRawImage] = React.useState(false);
  const [proxySrc, setProxySrc] = React.useState<string | null>(() =>
    preferProxyImage && product.id ? buildProxyImageSrc(product.id, 0) : null
  );
  const mediaRef = React.useRef<HTMLDivElement | null>(null);
  const [shouldLoadImage, setShouldLoadImage] = React.useState(imagePriority === "high");
  const hasMultipleImages = images.length > 1;
  const [isCarouselPaused, setIsCarouselPaused] = React.useState(false);
  const displaySrc = React.useMemo(() => {
    if (!shouldLoadImage || (!imgSrc && !proxySrc)) {
      return null;
    }
    const base = proxySrc ?? (useRawImage ? imgSrc : buildCardImageSrc(imgSrc));
    return appendRefreshKey(base, imageRefreshKey);
  }, [imageRefreshKey, imgSrc, proxySrc, shouldLoadImage, useRawImage]);
  const [imgAttempt, setImgAttempt] = React.useState(0);
  const [imgFailed, setImgFailed] = React.useState(false);

  React.useEffect(() => {
    if (imagePriority === "high") {
      setShouldLoadImage(true);
    }
  }, [imagePriority]);

  React.useEffect(() => {
    if (shouldLoadImage || imagePriority === "high") {
      return;
    }
    const node = mediaRef.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setShouldLoadImage(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setShouldLoadImage(true);
          observer.disconnect();
        }
      },
      { rootMargin: "720px 0px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [imagePriority, shouldLoadImage]);

  React.useEffect(() => {
    setImageIndex(0);
  }, [product.id, product.imageUrl, product.imageUrls, imageRefreshKey]);

  React.useEffect(() => {
    if (imageIndex >= images.length && images.length > 0) {
      setImageIndex(0);
    }
  }, [imageIndex, images]);

  React.useEffect(() => {
    setImgSrc(normalizeImageSrc(images[imageIndex]));
    setImgAttempt(0);
    setImgFailed(false);
    setUseRawImage(!preferProxyImage);
    setProxySrc(preferProxyImage && product.id ? buildProxyImageSrc(product.id, imageIndex) : null);
  }, [imageIndex, images, imageRefreshKey, preferProxyImage, product.id]);

  React.useEffect(() => {
    if (!hasMultipleImages || !shouldLoadImage || isCarouselPaused) {
      return;
    }
    const timer = window.setInterval(() => {
      setImageIndex((prev) => (prev + 1) % images.length);
    }, 4200);
    return () => window.clearInterval(timer);
  }, [hasMultipleImages, images.length, isCarouselPaused, shouldLoadImage]);

  const handleImageError = () => {
    const activeSrc = proxySrc ?? imgSrc;
    if (!activeSrc || imgAttempt >= 1) {
      setImgFailed(true);
      return;
    }
    if (!proxySrc && !useRawImage && buildCardImageSrc(activeSrc) !== activeSrc) {
      setUseRawImage(true);
      setImgAttempt(0);
      return;
    }
    if (!proxySrc && product.id) {
      setProxySrc(buildProxyImageSrc(product.id, imageIndex));
      setImgAttempt(0);
      setImgFailed(false);
      setUseRawImage(false);
      return;
    }
    const nextAttempt = imgAttempt + 1;
    setImgAttempt(nextAttempt);
    window.setTimeout(() => {
      if (proxySrc) {
        setProxySrc(appendCacheBuster(activeSrc, nextAttempt));
      } else {
        setImgSrc(appendCacheBuster(activeSrc, nextAttempt));
      }
    }, 250 * nextAttempt);
  };

  const handleView = () => {
    if (!onView) {
      return;
    }
    onView();
  };

  const handlePrevImage = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setImageIndex((prev) => (prev - 1 + images.length) % images.length);
  };

  const handleNextImage = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setImageIndex((prev) => (prev + 1) % images.length);
  };

  const handleDotClick = (event: React.MouseEvent<HTMLButtonElement>, index: number) => {
    event.preventDefault();
    event.stopPropagation();
    setImageIndex(index);
  };

  return (
    <article className={`product-card${isOut ? " is-out" : ""}`} style={style}>
      <div
        ref={mediaRef}
        className={`product-media ${images.length > 0 ? "has-image" : ""}${canView ? " can-view" : ""}`}
        onClick={handleView}
        onMouseEnter={() => setIsCarouselPaused(true)}
        onMouseLeave={() => setIsCarouselPaused(false)}
        onTouchStart={() => setIsCarouselPaused(true)}
        onTouchEnd={() => setIsCarouselPaused(false)}
        onKeyDown={(event) => {
          if (!canView) {
            return;
          }
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            handleView();
          }
        }}
        role={canView ? "button" : undefined}
        tabIndex={canView ? 0 : undefined}
        aria-label={canView ? `Ver detalles de ${product.name}` : undefined}
      >
        {displaySrc && !imgFailed ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={displaySrc}
            alt={product.name}
            className="product-image"
            loading={imagePriority === "high" ? "eager" : "lazy"}
            decoding="async"
            fetchPriority={imagePriority}
            width={CARD_IMAGE_WIDTH}
            height={CARD_IMAGE_HEIGHT}
            onError={handleImageError}
          />
        ) : (
          <div className="product-image-fallback" aria-hidden="true">
            <div className="product-image-fallback-illustration">
              <svg viewBox="0 0 160 120" role="presentation">
                <defs>
                  <linearGradient id="fallback-surface" x1="0" x2="1" y1="0" y2="1">
                    <stop offset="0%" stopColor="#ffffff" stopOpacity="0.96" />
                    <stop offset="100%" stopColor="#dbeafe" stopOpacity="0.82" />
                  </linearGradient>
                  <linearGradient id="fallback-accent" x1="0" x2="1" y1="0" y2="1">
                    <stop offset="0%" stopColor="#84cc16" />
                    <stop offset="100%" stopColor="#0ea5e9" />
                  </linearGradient>
                  <linearGradient id="fallback-ribbon" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stopColor="#1e293b" />
                    <stop offset="100%" stopColor="#334155" />
                  </linearGradient>
                </defs>
                <ellipse cx="80" cy="96" rx="42" ry="10" fill="rgba(15,23,42,0.12)" />
                <path d="M44 40h72c8 0 14 6 14 14v30c0 9-7 16-16 16H46c-9 0-16-7-16-16V54c0-8 6-14 14-14Z" fill="url(#fallback-surface)" stroke="rgba(15,23,42,0.14)" strokeWidth="2" />
                <path d="M48 48h64c6 0 10 4 10 10v20c0 6-4 10-10 10H48c-6 0-10-4-10-10V58c0-6 4-10 10-10Z" fill="rgba(255,255,255,0.72)" />
                <path d="M76 40h8v60h-8z" fill="url(#fallback-ribbon)" />
                <path d="M30 60h100v8H30z" fill="url(#fallback-ribbon)" />
                <path d="M67 30c-8 0-14 5-14 11 0 4 2 7 5 9 5-1 12-4 18-10-2-6-5-10-9-10Z" fill="url(#fallback-accent)" />
                <path d="M93 30c8 0 14 5 14 11 0 4-2 7-5 9-5-1-12-4-18-10 2-6 5-10 9-10Z" fill="#38bdf8" />
                <circle cx="80" cy="64" r="11" fill="url(#fallback-accent)" />
                <path d="M80 53v22M69 64h22" stroke="#ffffff" strokeWidth="4" strokeLinecap="round" />
              </svg>
            </div>
            <div className="product-image-fallback-icon">{fallbackLabel}</div>
            <div className="product-image-fallback-text">{product.name}</div>
            <div className="product-image-fallback-meta">{fallbackMeta}</div>
          </div>
        )}
        {hasMultipleImages ? (
          <div className="product-carousel" aria-hidden="true">
            <button
              type="button"
              className="product-carousel-btn product-carousel-btn--prev"
              onClick={handlePrevImage}
              aria-label="Imagen anterior"
            >
              &#8249;
            </button>
            <button
              type="button"
              className="product-carousel-btn product-carousel-btn--next"
              onClick={handleNextImage}
              aria-label="Imagen siguiente"
            >
              &#8250;
            </button>
            <div className="product-carousel-dots">
              {images.map((_, index) => (
                <button
                  key={`dot-${product.id}-${index}`}
                  type="button"
                  className={`product-carousel-dot${index === imageIndex ? " is-active" : ""}`}
                  onClick={(event) => handleDotClick(event, index)}
                  aria-label={`Ver imagen ${index + 1}`}
                />
              ))}
            </div>
          </div>
        ) : null}
      </div>
      <div className="product-meta">
        <span>{product.category}</span>
      </div>
      <div>
        <h3 className="product-title">{product.name}</h3>
        {product.description ? (
          <p className="product-description">{product.description}</p>
        ) : null}
        {hasDiscount ? (
          <p className="product-price product-price--before">${product.originalPrice.toLocaleString("es-AR")}</p>
        ) : null}
        <p className={`product-price${hasDiscount ? " product-price--offer" : ""}`}>${product.price.toLocaleString("es-AR")}</p>
      </div>
      <div className="product-actions">
        {badge ? <span className="product-badge">{badge}</span> : <span />}
        <div className="product-buttons">
          {onToggleFeatured ? (
            <button type="button" className="button button--ghost button--compact" onClick={onToggleFeatured}>
              {product.isFeatured ? "Quitar top" : "Marcar top"}
            </button>
          ) : null}
          {canView ? (
            <button type="button" className="button button--ghost" onClick={handleView}>
              Ver detalle
            </button>
          ) : null}
          {onAdd ? (
            <button
              type="button"
              className={`button ${isOut ? "button--ghost" : "button--lime"}`}
              onClick={onAdd}
              disabled={isOut}
            >
              {isOut ? "Sin stock" : inCart > 0 ? `En carrito x${inCart}` : "Agregar"}
            </button>
          ) : null}
        </div>
      </div>
    </article>
  );
}

const areCardPropsEqual = (prev: CardProps, next: CardProps) => {
  return (
    prev.inCart === next.inCart &&
    prev.imagePriority === next.imagePriority &&
    prev.imageRefreshKey === next.imageRefreshKey &&
    Boolean(prev.onAdd) === Boolean(next.onAdd) &&
    Boolean(prev.onView) === Boolean(next.onView) &&
    Boolean(prev.onToggleFeatured) === Boolean(next.onToggleFeatured) &&
    shallowEqualStyle(prev.style, next.style) &&
    prev.product.id === next.product.id &&
    prev.product.name === next.product.name &&
    prev.product.price === next.product.price &&
    prev.product.originalPrice === next.product.originalPrice &&
    prev.product.category === next.product.category &&
    prev.product.stock === next.product.stock &&
    prev.product.badge === next.product.badge &&
    prev.product.imageUrl === next.product.imageUrl &&
    prev.product.description === next.product.description &&
    prev.product.isFeatured === next.product.isFeatured &&
    prev.product.flashOffer?.endsAt === next.product.flashOffer?.endsAt &&
    equalImageUrls(prev.product.imageUrls, next.product.imageUrls)
  );
};

export default React.memo(ProductCard, areCardPropsEqual);
