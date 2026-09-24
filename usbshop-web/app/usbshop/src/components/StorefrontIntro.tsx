type StorefrontIntroProps = {
  onBrowse: () => void;
};

export default function StorefrontIntro({ onBrowse }: StorefrontIntroProps) {
  return (
    <section className="shop-intro" aria-labelledby="shop-intro-title">
      <div className="shop-intro-copy">
        <p className="shop-intro-eyebrow">TU PRÓXIMO FAVORITO ESTÁ ACÁ</p>
        <h1 id="shop-intro-title">Conectá con lo que <span>te gusta.</span></h1>
        <p className="shop-intro-description">Audio, accesorios y tecnología para tu día a día. Descubrí el catálogo y armá tu pedido en un solo lugar.</p>
        <div className="shop-intro-actions">
          <button type="button" className="button button--lime" onClick={onBrowse}>Explorar productos <span aria-hidden="true">↗</span></button>
          <a href="#novedades">Ver novedades <span aria-hidden="true">→</span></a>
        </div>
      </div>
      <div className="shop-intro-art" aria-hidden="true">
        <div className="shop-intro-orbit" />
        <div className="shop-intro-tile shop-intro-tile--audio">
          <span>AUDIO</span><img src="/icons/headphones.svg" alt="" width="220" height="140" />
          <span>Tu música. Tu momento.</span>
        </div>
        <div className="shop-intro-tile shop-intro-tile--watch">
          <img src="/icons/smartwatch.svg" alt="" width="100" height="100" /><span>SMART TECH</span>
        </div>
        <div className="shop-intro-label"><span /> Tecnología que va con vos</div>
      </div>
    </section>
  );
}
