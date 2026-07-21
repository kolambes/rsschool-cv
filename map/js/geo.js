// Геометрические утилиты (haversine, интерполяция вдоль линии).
// Слой: Transport Domain Layer (вычисления).

const R = 6371000; // радиус Земли, м

export function haversine(a, b) {
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const dLon = ((b[0] - a[0]) * Math.PI) / 180;
  const la1 = (a[1] * Math.PI) / 180;
  const la2 = (b[1] * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Кумулятивные длины сегментов линии (мемоизируется вызывающей стороной)
export function cumulativeLengths(coords) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) {
    cum.push(cum[i - 1] + haversine(coords[i - 1], coords[i]));
  }
  return cum;
}

// Точка и азимут на расстоянии dist (м) от начала линии
export function pointAlong(coords, cum, dist) {
  const total = cum[cum.length - 1];
  const d = Math.max(0, Math.min(dist, total));
  let i = 1;
  while (i < cum.length - 1 && cum[i] < d) i++;
  const segLen = cum[i] - cum[i - 1] || 1;
  const t = (d - cum[i - 1]) / segLen;
  const [x1, y1] = coords[i - 1];
  const [x2, y2] = coords[i];
  const lon = x1 + (x2 - x1) * t;
  const lat = y1 + (y2 - y1) * t;
  const bearing = (Math.atan2(x2 - x1, y2 - y1) * 180) / Math.PI;
  return { coord: [lon, lat], bearing: (bearing + 360) % 360 };
}

// Расстояние вдоль линии до ближайшей к точке вершины (упрощённо, для демо-прибытий)
export function distanceAlongToPoint(coords, cum, point) {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const d = haversine(coords[i], point);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return cum[best];
}

export function boundsOf(coords) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of coords) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [[minX, minY], [maxX, maxY]];
}
