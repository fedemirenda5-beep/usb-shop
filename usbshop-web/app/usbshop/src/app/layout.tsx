import type { Metadata } from "next";
import { QueryProvider } from "@/components/QueryProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: "USB Shop",
  description: "Catalogo y ventas online integradas con ControlStock",
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
