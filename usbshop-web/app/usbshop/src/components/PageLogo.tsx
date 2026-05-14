import Image from "next/image";

export default function PageLogo() {
  return (
    <div className="page-logo">
      <Image src="/usbshop-logo.svg" alt="USB Shop" width={184} height={84} priority />
    </div>
  );
}

