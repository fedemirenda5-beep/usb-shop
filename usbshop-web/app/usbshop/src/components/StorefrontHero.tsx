type StorefrontHeroProps = {
  onExplore: () => void;
};

export default function StorefrontHero({ onExplore }: StorefrontHeroProps) {
  return (
    <section className="shop-hero" aria-labelledby="shop-hero-title">
      <div className="shop-hero-copy">
        <p className="shop-eyebrow"><span /> TU PRÓXIMO FAVORITO ESTÁ ACÁ</p>
        <h1 id="shop-hero-title">Conectá con<br />lo que <em>te mueve.</em></h1>
        <p className="shop-hero-description">Audio, accesorios y tecnología para todos los días. Encontrá eso que buscás y armá tu próximo pedido.</p>
        <div className="shop-hero-actions">
          <button className="button button--lime" type="button" onClick={onExplore}>Explorar productos <span aria-hidden="true">↗</span></button>
          <a href="#novedades" className="shop-hero-link">Ver novedades <span aria-hidden="true">→</span></a>
        </div>
        <p className="shop-hero-caption">USB SHOP <span /> Tecnología que va con vos.</p>
      </div>
      <div className="shop-hero-art" aria-hidden="true">
        <div className="shop-orbit shop-orbit--outer" />
        <div className="shop-orbit shop-orbit--inner" />
        <span className="shop-art-label">DALE PLAY A TU DÍA</span>
        <div className="shop-display shop-display--audio">
          <span>AUDIO</span>
          <img src="/icons/headphones.svg" width="220" height="140" alt="" />
          <strong>Tu mundo. Tu sonido.</strong>
        </div>
        <div className="shop-display shop-display--watch">
          <img src="/icons/smartwatch.svg" width="150" height="110" alt="" />
          <span>SIEMPRE CON VOS</span>
        </div>
        <div className="shop-display shop-display--gaming">
          <img src="/icons/joystick.svg" width="150" height="95" alt="" />
          <span>MODO PLAY</span>
        </div>
        <span className="shop-art-plus">+</span>
        <span className="shop-art-note">DESCUBRÍ. ELEGÍ. DISFRUTÁ.</span>
      </div>
    </section>
  );
}
