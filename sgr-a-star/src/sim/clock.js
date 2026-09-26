import { T_M, MYR, YEAR } from './units.js';

export const START_YEAR = 2018.0; // эпоха начала: S2 проходит перицентр в 2018,38

// Скорость времени логарифмическая: rate = 10^logRate секунд модели за секунду реального времени.
export const LOG_RATE_MIN = 0; // реальное время
export const LOG_RATE_MAX = 14.5; // ≈ 10 млн лет за секунду

export class SimClock {
  constructor() {
    this.t = 0; // секунды модели от эпохи START_YEAR (float64)
    this.logRate = 3;
    this.direction = 1;
    this.paused = false;
    this.lastDt = 0;
  }
  get rate() {
    return this.paused ? 0 : this.direction * Math.pow(10, this.logRate);
  }
  tick(dtReal) {
    const dt = this.rate * dtReal;
    this.t += dt;
    this.lastDt = dt;
    return dt;
  }
  get tM() { return this.t / T_M; }
  get tMyr() { return this.t / MYR; }
  get year() { return START_YEAR + this.t / 3.15576e7; }
}
