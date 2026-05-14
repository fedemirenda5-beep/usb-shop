import Image from "next/image";

export default function PageLogo() {
  return (
    <div className="page-logo">
      <Image src="/usbshop-logo.jpeg" alt="USB Shop" width={184} height={184} priority />
    </div>
  );
}

