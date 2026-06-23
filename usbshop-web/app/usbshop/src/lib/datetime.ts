const ARGENTINA_TIME_ZONE = 'America/Argentina/Buenos_Aires';
const ARGENTINA_OFFSET = '-03:00';

const buildFormatter = (options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('es-AR', {
    timeZone: ARGENTINA_TIME_ZONE,
    ...options,
  });

const dateTimeFormatter = buildFormatter({
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const dateFormatter = buildFormatter({
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const monthFormatter = buildFormatter({
  month: 'long',
});

const shortMonthYearFormatter = buildFormatter({
  month: 'short',
  year: '2-digit',
});

const extractParts = (date: Date) => {
  const parts = buildFormatter({
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const map = new Map(parts.map((part) => [part.type, part.value]));
  return {
    year: map.get('year') || '0000',
    month: map.get('month') || '01',
    day: map.get('day') || '01',
    hour: map.get('hour') || '00',
    minute: map.get('minute') || '00',
    second: map.get('second') || '00',
  };
};

export const parseDateValue = (value?: string | null) => {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  let normalized = raw;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    normalized = `${raw}T12:00:00Z`;
  } else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(?:\.\d{1,6})?)?$/.test(raw)) {
    normalized = raw.replace(' ', 'T') + 'Z';
  }

  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

export const formatArgentinaDateTime = (value?: string | null) => {
  const parsed = parseDateValue(value);
  return parsed ? dateTimeFormatter.format(parsed) : value || '-';
};

export const formatArgentinaDate = (value?: string | null) => {
  const parsed = parseDateValue(value);
  return parsed ? dateFormatter.format(parsed) : value || '-';
};

export const formatArgentinaMonth = (value: string) => {
  const [year, month] = value.split('-');
  const parsed = new Date(Number(year), Number(month) - 1, 1);
  return Number.isNaN(parsed.getTime()) ? value : monthFormatter.format(parsed);
};

export const formatArgentinaShortMonthYear = (value: string) => {
  const [year, month] = value.split('-');
  const parsed = new Date(Number(year), Number(month) - 1, 1);
  return Number.isNaN(parsed.getTime()) ? value : shortMonthYearFormatter.format(parsed);
};

export const getArgentinaNowDateInput = () => {
  const parts = extractParts(new Date());
  return `${parts.year}-${parts.month}-${parts.day}`;
};

export const getArgentinaNowDateTimeLocalInput = () => {
  const parts = extractParts(new Date());
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
};

export const argentinaDateTimeLocalToIso = (value?: string | null) => {
  if (!value) return null;
  const normalized = value.length === 16 ? `${value}:00` : value;
  const parsed = new Date(`${normalized}${ARGENTINA_OFFSET}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

export const ARGENTINA_TZ = ARGENTINA_TIME_ZONE;
