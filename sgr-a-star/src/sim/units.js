// Единицы симуляции: G = c = M(Стрелец A*) = 1.
// Длина: GM/c² ≈ 6,35 млн км, время: GM/c³ ≈ 21,2 с.

export const M_SUN_BH = 4.3e6; // масса Стрельца A* в массах Солнца (GRAVITY, 2019–2022)
const G = 6.674e-11;
const C = 2.99792458e8;
const M_SUN = 1.98847e30;

export const LEN_M = (G * M_SUN_BH * M_SUN) / (C * C); // метров в одной единице длины
export const T_M = LEN_M / C; // секунд в одной единице времени

export const KM = 1e3 / LEN_M;
export const AU = 1.495978707e11 / LEN_M;
export const LY = 9.4607e15 / LEN_M;
export const PC = 3.0857e16 / LEN_M;
export const KPC = PC * 1e3;

export const YEAR = 3.15576e7; // с
export const MYR = YEAR * 1e6;

const nf = (v, d = 1) =>
  v.toLocaleString('ru-RU', { maximumFractionDigits: d, minimumFractionDigits: 0 });

export function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/** Длина (в единицах GM/c²) → текст */
export function formatLength(u) {
  const km = (u * LEN_M) / 1e3;
  const au = u / AU;
  const ly = u / LY;
  if (km < 1e6) return `${nf(km, 0)} км`;
  if (au < 0.5) return `${nf(km / 1e6, km < 1e7 ? 1 : 0)} млн км`;
  if (au < 5000) return `${nf(au, au < 10 ? 1 : 0)} а.е.`;
  if (ly < 1000) {
    const v = ly < 10 ? Math.round(ly * 100) / 100 : Math.round(ly);
    return `${nf(v, 2)} св. ${Number.isInteger(v) ? plural(v, 'год', 'года', 'лет') : 'года'}`;
  }
  return `${nf(ly / 1000, 0)} тыс. св. лет`;
}

/** Длительность в секундах → текст */
export function formatDuration(s) {
  const a = Math.abs(s);
  if (a < 60) return `${nf(a, a < 10 ? 1 : 0)} с`;
  if (a < 3600) return `${nf(a / 60, 1)} мин`;
  if (a < 86400) return `${nf(a / 3600, 1)} ч`;
  if (a < YEAR * 0.5) return `${nf(a / 86400, 1)} сут`;
  const y = a / YEAR;
  if (y < 1e3) {
    const v = y < 10 ? Math.round(y * 10) / 10 : Math.round(y);
    return `${nf(v, 1)} ${Number.isInteger(v) ? plural(v, 'год', 'года', 'лет') : 'года'}`;
  }
  if (y < 1e6) return `${nf(y / 1e3, 1)} тыс. лет`;
  if (y < 1e9) return `${nf(y / 1e6, 1)} млн лет`;
  return `${nf(y / 1e9, 2)} млрд лет`;
}
