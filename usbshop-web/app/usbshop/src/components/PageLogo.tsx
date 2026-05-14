import Image from "next/image";

export default function PageLogo() {
  return (
    <div className="page-logo">
      <Image src="/logo-small.jpeg" alt="USB Shop" width={88} height={88} priority />
    </div>
  );
}

