export const WHATSAPP_PHONE = "542364574765";

export const buildWhatsAppLink = (text: string, phone: string = WHATSAPP_PHONE) => {
  const digits = String(phone || "").replace(/[^\d]/g, "");
  const safeText = String(text || "").trim();
  return `https://wa.me/${digits}?text=${encodeURIComponent(safeText)}`;
};

export const DEFAULT_WHATSAPP_TEXT = "Hola, quiero consultar por un producto";
export const DEFAULT_WHATSAPP_LINK = buildWhatsAppLink(DEFAULT_WHATSAPP_TEXT);

