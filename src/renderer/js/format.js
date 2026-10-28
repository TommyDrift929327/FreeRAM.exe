/**
 * Helpers de formatage (français, unités binaires).
 * Les tailles utilisent 1 Go = 1024^3 octets, comme le Gestionnaire des tâches.
 */

const number0 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
const number1 = new Intl.NumberFormat('fr-FR', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 1
});
const number2 = new Intl.NumberFormat('fr-FR', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2
});
const timeFormat = new Intl.DateTimeFormat('fr-FR', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
});

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const KIB = 1024;

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function formatBytes(bytes, options = {}) {
  if (bytes === null || bytes === undefined || !Number.isFinite(Number(bytes))) return '—';
  const value = Number(bytes);
  const abs = Math.abs(value);
  const digits = options.digits ?? 1;

  if (abs >= GIB) {
    const formatter = digits >= 2 ? number2 : number1;
    return `${formatter.format(value / GIB)} Go`;
  }
  if (abs >= MIB) return `${number0.format(value / MIB)} Mo`;
  if (abs >= KIB) return `${number0.format(value / KIB)} Ko`;
  return `${number0.format(value)} o`;
}

export function formatPercent(value, digits = 0) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  const formatter = digits > 0 ? number1 : number0;
  return `${formatter.format(Number(value))} %`;
}

export function formatTemperature(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return null;
  }
  return `${number1.format(Number(value))} °C`;
}

export function formatDelta(bytes) {
  if (bytes === null || bytes === undefined || !Number.isFinite(Number(bytes))) return '—';
  const value = Number(bytes);
  if (Math.abs(value) < 8 * MIB) return '≈ 0';
  const sign = value >= 0 ? '+' : '−';
  return `${sign}${formatBytes(Math.abs(value), { digits: 2 })}`;
}

export function formatSeconds(milliseconds, digits = 1) {
  if (!Number.isFinite(Number(milliseconds))) return '—';
  const formatter = digits > 0 ? number1 : number0;
  return `${formatter.format(Number(milliseconds) / 1000)} s`;
}

export function formatClock(timestamp) {
  if (!timestamp) return '—';
  return timeFormat.format(new Date(timestamp));
}

export function formatAge(timestamp) {
  if (!timestamp) return '—';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 3) return "à l'instant";
  if (seconds < 60) return `il y a ${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `il y a ${minutes} min`;
  return `il y a ${Math.round(minutes / 60)} h`;
}

export function formatPidList(pids, max = 10) {
  if (!Array.isArray(pids) || pids.length === 0) return '—';
  const shown = pids.slice(0, max).join(', ');
  return pids.length > max ? `${shown} +${pids.length - max}` : shown;
}

const HUES = [158, 187, 205, 264, 286, 322, 36, 92];

export function hueForName(name) {
  const text = String(name || '');
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) % 100000;
  }
  return HUES[hash % HUES.length];
}

export function initialForName(name) {
  const base = String(name || '').replace(/\.exe$/i, '').trim();
  const match = base.match(/[a-z0-9]/i);
  return (match ? match[0] : '?').toUpperCase();
}

export function normalizeSearch(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

export { number0, number1, number2 };
