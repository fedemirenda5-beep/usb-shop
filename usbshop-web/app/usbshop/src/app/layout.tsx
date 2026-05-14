import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "USB Shop",
  description: "Catalogo y ventas online integradas con ControlStock",
  icons: {
    icon: "/usbshop-logo.jpeg",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body className="body">
        <div className="page-shell">{children}</div>
      </body>
    </html>
  );
}
