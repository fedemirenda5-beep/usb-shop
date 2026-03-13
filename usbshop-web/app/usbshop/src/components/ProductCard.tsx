import React from "react";
import { getApiBaseUrl } from "@/lib/api";

type CardProps = {
  product: {
    id: number;
    name: string;
    price: number;
    category: string;
    stock?: number;
    badge?: string;
    imageUrl?: string | null;
    imageUrls?: string[] | null;
    description?: string | null;
    isFeatured?: boolean;
  };
  inCart?: number;
  onAdd?: () => void;
  onToggleFeatured?: () => void;
  onView?: () => void;
  imagePriority?: "high" | "low" | "auto";
  imageRefreshKey?: number;
  style?: React.CSSProperties;
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

export default function ProductCard({
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
  const badge = isOut ? "Sin stock" : product.badge ?? (product.isFeatured ? "Destacado" : undefined);
  const canView = Boolean(onView);
  const images = React.useMemo(() => {
    const list = Array.isArray(product.imageUrls) ? product.imageUrls : [];
    if (list.length > 0) {
      return list;
    }
    return product.imageUrl ? [product.imageUrl] : [];
  }, [product.imageUrls, product.imageUrl]);
  const [imageIndex, setImageIndex] = React.useState(0);
  const [imgSrc, setImgSrc] = React.useState<string | null>(() =>
    normalizeImageSrc(images[0])
  );
  const [useRawImage, setUseRawImage] = React.useState(false);
  const [proxySrc, setProxySrc] = React.useState<string | null>(null);
  const mediaRef = React.useRef<HTMLDivElement | null>(null);
  const [shouldLoadImage, setShouldLoadImage] = React.useState(imagePriority === "high");
  const hasMultipleImages = images.length > 1;
  const displaySrc = React.useMemo(
    () => {
      if (!shouldLoadImage || (!imgSrc && !proxySrc)) {
        return null;
      }
      const base = proxySrc ?? (useRawImage ? imgSrc : buildCardImageSrc(imgSrc));
      return appendRefreshKey(base, imageRefreshKey);
    },
    [imageRefreshKey, imgSrc, proxySrc, shouldLoadImage, useRawImage]
  );
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
      { rootMargin: "280px 0px" }
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
    setUseRawImage(false);
    setProxySrc(null);
  }, [imageIndex, images, imageRefreshKey]);
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
  const handleOpenImage = () => {
    const target = images[imageIndex];
    if (!target) {
      return;
    }
    window.open(target, "_blank", "noopener,noreferrer");
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
        onDoubleClick={handleOpenImage}
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
        title={product.imageUrl ? "Doble click para ver la imagen" : undefined}
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
            <div className="product-image-fallback-icon">IMG</div>
            <div className="product-image-fallback-text">Sin imagen</div>
            <div className="product-image-fallback-meta">{product.category}</div>
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
              ‹
            </button>
            <button
              type="button"
              className="product-carousel-btn product-carousel-btn--next"
              onClick={handleNextImage}
              aria-label="Imagen siguiente"
            >
              ›
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
        <span>ID {product.id}</span>
      </div>
      <div>
        <h3 className="product-title">{product.name}</h3>
        {product.description ? (
          <p className="product-description">{product.description}</p>
        ) : null}
        <p className="product-price">${product.price.toLocaleString("es-AR")}</p>
      </div>
      <div className="product-actions">
        {badge ? <span className="product-badge">{badge}</span> : <span />}
        <div className="product-buttons">
          {onToggleFeatured ? (
            <button className="button button--ghost button--compact" onClick={onToggleFeatured}>
              {product.isFeatured ? "Quitar top" : "Marcar top"}
            </button>
          ) : null}
          <button
            className={`button ${isOut ? "button--ghost" : "button--lime"}`}
            onClick={onAdd}
            disabled={isOut}
          >
            {isOut ? "Sin stock" : inCart > 0 ? `En carrito x${inCart}` : "Agregar"}
          </button>
        </div>
      </div>
    </article>
  );
}
