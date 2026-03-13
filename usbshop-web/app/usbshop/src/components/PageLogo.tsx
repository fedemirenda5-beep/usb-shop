import Image from "next/image";

export default function PageLogo() {
  return (
    <div className="page-logo">
      <Image src="/usbshop-logo.svg" alt="USB Shop" width={184} height={84} priority />
      <div className="logo-icons logo-icons--right" aria-hidden="true">
        <div className="logo-icon">
          <Image src="/icons/speaker.svg" alt="" aria-hidden="true" width={36} height={36} />
        </div>
        <div className="logo-icon">
          <Image
            src="/icons/headphones.svg"
            alt=""
            aria-hidden="true"
            width={36}
            height={36}
          />
        </div>
        <div className="logo-icon">
          <Image
            src="/icons/smartphone.svg"
            alt=""
            aria-hidden="true"
            width={36}
            height={36}
          />
        </div>
        <div className="logo-icon">
          <Image
            src="/icons/smartwatch.svg"
            alt=""
            aria-hidden="true"
            width={36}
            height={36}
          />
        </div>
        <span className="logo-icon logo-icon--wide logo-icon--mask-ps5" aria-hidden="true" />
      </div>
    </div>
  );
}

