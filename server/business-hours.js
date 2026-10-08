// Cálculo de tempo de máquina parada considerando apenas horas úteis de disponibilidade.
// Ignora finais de semana (Sábado e Domingo) e feriados nacionais brasileiros.

function getEaster(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

const holidaysCache = new Map();
export function getBrazilianHolidays(year) {
  if (holidaysCache.has(year)) return holidaysCache.get(year);
  const holidays = new Set();
  const pad = (n) => String(n).padStart(2, '0');
  const add = (m, d) => holidays.add(`${year}-${pad(m)}-${pad(d)}`);

  // Feriados fixos
  add(1, 1);   // Confraternização Universal
  add(4, 21);  // Tiradentes
  add(5, 1);   // Dia do Trabalho
  add(9, 7);   // Independência do Brasil
  add(10, 12); // Nossa Senhora Aparecida
  add(11, 2);  // Finados
  add(11, 15); // Proclamação da República
  add(11, 20); // Dia Nacional de Zumbi e Consciência Negra (Lei 14.759/2023)
  add(12, 25); // Natal

  // Feriados móveis
  const easter = getEaster(year);
  const addOffset = (days) => {
    const d = new Date(easter.getTime() + days * 86400000);
    holidays.add(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`);
  };
  addOffset(-48); // Segunda de Carnaval
  addOffset(-47); // Terça de Carnaval
  addOffset(-2);  // Sexta-feira Santa
  addOffset(60);  // Corpus Christi

  holidaysCache.set(year, holidays);
  return holidays;
}

export function isHoliday(date) {
  const y = date.getFullYear();
  const pad = (n) => String(n).padStart(2, '0');
  const key = `${y}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return getBrazilianHolidays(y).has(key);
}

/**
 * Retorna os segundos úteis de parada entre sinceIso e untilIso, respeitando
 * o limite diário da máquina (operatingHours) e o expediente útil.
 */
export function calcOperatingStoppedSeconds(sinceIso, { until = null, operatingHours = 8.0, shiftStart = 7, shiftEnd = 17 } = {}) {
  const start = new Date(sinceIso);
  const end = until ? new Date(until) : new Date();
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) return 0;

  const opH = Math.max(1, Math.min(24, Number(operatingHours) || 8));
  const maxDailySec = opH * 3600;
  const actualShiftStart = opH >= 24 ? 0 : shiftStart;
  const actualShiftEnd = opH >= 24 ? 24 : Math.min(24, actualShiftStart + Math.max(10, opH));
  let totalSec = 0;

  const cur = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const last = new Date(end.getFullYear(), end.getMonth(), end.getDate());

  while (cur <= last) {
    const dayOfWeek = cur.getDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6 && !isHoliday(cur)) {
      const dayStart = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate(), actualShiftStart, 0, 0, 0);
      const dayEnd = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate(), actualShiftEnd, 0, 0, 0);
      const effStart = Math.max(start.getTime(), dayStart.getTime());
      const effEnd = Math.min(end.getTime(), dayEnd.getTime());
      if (effEnd > effStart) {
        const sec = (effEnd - effStart) / 1000;
        totalSec += Math.min(maxDailySec, sec);
      }
    }
    cur.setDate(cur.getDate() + 1);
  }
  return Math.round(totalSec);
}

export function calcOperatingStoppedMinutes(sinceIso, untilIso, operatingHours = 8.0) {
  return Math.round(calcOperatingStoppedSeconds(sinceIso, { until: untilIso, operatingHours }) / 60);
}
