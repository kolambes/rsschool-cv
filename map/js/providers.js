// Data Provider Layer: интерфейс GPS-провайдера, mock-провайдер и менеджер данных.
//
// Архитектура повторяет серверный контракт (см. map/README.md):
//   interface GpsProvider {
//     name: string
//     fetchVehiclePositions(): Promise<RawVehiclePosition[]>
//     normalizePosition(raw): NormalizedVehiclePosition
//     validatePosition(position): { ok: boolean, errors: string[] }
//   }
//
// В статической сборке зарегистрирован только MockGpsProvider, поэтому система
// честно работает в режиме «Демо-данные». Реальный провайдер подключается сюда же
// без изменения UI-слоя.

import { ROUTES, VEHICLES } from './demo-data.js';
import { cumulativeLengths, pointAlong } from './geo.js';
import {
  DATA_STATUS, GPS_TTL, LIVE_UPDATE_INTERVAL, LIVE_UPDATE_INTERVAL_SLOW,
} from './config.js';

// Мемоизация геометрии маршрутов (не пересчитывается на каждый кадр)
const routeGeom = new Map();
for (const r of ROUTES) {
  const cum = cumulativeLengths(r.coordinates);
  routeGeom.set(r.id, { coords: r.coordinates, cum, total: cum[cum.length - 1] });
}
export function getRouteGeometry(routeId) { return routeGeom.get(routeId); }

// ── Mock-провайдер ──────────────────────────────────────────────────────────
export class MockGpsProvider {
  constructor() {
    this.name = 'mock-demo';
    this.isDemo = true;
    this._t0 = Date.now();
  }

  // Позиция вычисляется детерминированно из времени: борт «едет» по линии
  // маршрута туда-обратно со своей скоростью.
  async fetchVehiclePositions() {
    const now = Date.now();
    const elapsed = (now - this._t0) / 1000; // с
    return VEHICLES.map((v) => {
      const geom = routeGeom.get(v.routeId);
      const speedMs = (v.speed * 1000) / 3600;
      const travelled = elapsed * speedMs * v.dir;
      const cycle = geom.total * 2;
      let d = ((v.offset * geom.total + travelled) % cycle + cycle) % cycle;
      let forward = true;
      if (d > geom.total) { d = cycle - d; forward = false; } // обратное направление
      return {
        vehicleId: v.id,
        routeId: v.routeId,
        board: v.board,
        type: v.type,
        distanceAlong: d,
        forward,
        speedKmh: v.speed + Math.round(Math.sin(elapsed / 7 + v.offset * 10) * 4),
        timestamp: now,
      };
    });
  }

  normalizePosition(raw) {
    const geom = routeGeom.get(raw.routeId);
    const { coord, bearing } = pointAlong(geom.coords, geom.cum, raw.distanceAlong);
    return {
      id: raw.vehicleId,
      routeId: raw.routeId,
      board: raw.board,
      type: raw.type,
      lon: coord[0],
      lat: coord[1],
      bearing: raw.forward ? bearing : (bearing + 180) % 360,
      speedKmh: Math.max(0, raw.speedKmh),
      distanceAlong: raw.distanceAlong,
      forward: raw.forward,
      timestamp: raw.timestamp,
    };
  }

  validatePosition(p) {
    const errors = [];
    if (!Number.isFinite(p.lon) || !Number.isFinite(p.lat)) errors.push('Некорректные координаты');
    if (p.lon < 25.8 || p.lon > 26.3 || p.lat < 53.0 || p.lat > 53.3) errors.push('Позиция вне зоны обслуживания');
    if (!p.routeId) errors.push('Не указан маршрут');
    return { ok: errors.length === 0, errors };
  }
}

// ── Менеджер провайдеров: кэш, TTL, деградация, статус ──────────────────────
export class ProviderManager {
  constructor() {
    this.provider = null;
    this.positions = [];          // последние валидные позиции (кэш)
    this.lastUpdate = 0;
    this.status = DATA_STATUS.OFFLINE;
    this.degraded = false;        // режим редких обновлений
    this.errorCount = 0;
    this._timer = null;
    this._listeners = new Set();
    this._log = [];
  }

  registerProvider(provider) {
    this.provider = provider;
  }

  onUpdate(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }

  _emit() { for (const fn of this._listeners) fn(this.positions, this.status, this.lastUpdate); }

  log(level, msg) {
    this._log.push({ t: Date.now(), level, msg });
    if (this._log.length > 200) this._log.shift();
    if (level === 'error') console.error('[provider]', msg);
  }

  // Публичный health-статус (аналог /api/map/health на сервере)
  health() {
    return {
      provider: this.provider ? this.provider.name : null,
      status: this.status,
      lastUpdate: this.lastUpdate,
      degraded: this.degraded,
      vehicles: this.positions.length,
      errors: this.errorCount,
    };
  }

  async refresh() {
    if (!this.provider) {
      this.status = DATA_STATUS.OFFLINE;
      this._emit();
      return;
    }
    try {
      const raw = await this.provider.fetchVehiclePositions();
      const normalized = [];
      for (const item of raw) {
        const pos = this.provider.normalizePosition(item);
        const check = this.provider.validatePosition(pos);
        if (check.ok) normalized.push(pos);
        else this.log('warn', `Позиция ${pos.id} отклонена: ${check.errors.join('; ')}`);
      }
      this.positions = normalized;
      this.lastUpdate = Date.now();
      this.errorCount = 0;
      this.status = this.provider.isDemo ? DATA_STATUS.DEMO : DATA_STATUS.LIVE;
    } catch (err) {
      // Graceful degradation: не падаем, оставляем кэш и помечаем данные
      this.errorCount += 1;
      this.log('error', `Ошибка провайдера: ${err && err.message}`);
      const age = Date.now() - this.lastUpdate;
      this.status = age > GPS_TTL ? DATA_STATUS.OFFLINE : DATA_STATUS.STALE;
      if (this.errorCount >= 3 && !this.degraded) this.setDegraded(true);
    }
    this._emit();
  }

  setDegraded(value) {
    if (this.degraded === value) return;
    this.degraded = value;
    this.log('info', value ? 'Включён режим редких обновлений' : 'Обычная частота обновлений');
    this._restart();
  }

  start() {
    this._restart();
    this.refresh();
  }

  _restart() {
    if (this._timer) clearInterval(this._timer);
    const interval = this.degraded ? LIVE_UPDATE_INTERVAL_SLOW : LIVE_UPDATE_INTERVAL;
    this._timer = setInterval(() => this.refresh(), interval);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
}

export const providerManager = new ProviderManager();
