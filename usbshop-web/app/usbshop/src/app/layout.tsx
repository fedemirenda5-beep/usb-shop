import type { Metadata } from "next";
import { QueryProvider } from "@/components/QueryProvider";
import "./globals.css";
import "./storefront.css";

export const metadata: Metadata = {
  title: "USB Shop",
  description: "Encontrá audio, accesorios y tecnología en USB Shop. Explorá nuestro catálogo, armá tu pedido y consultanos por WhatsApp.",
  icons: {
    icon: "/logo-small.jpeg",
    shortcut: "/logo-small.jpeg",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body className="body">
        <QueryProvider>
          <div className="page-shell">{children}</div>
        </QueryProvider>
      </body>
    </html>
  );
}
