# Itappi Tracking Agent

Agente de escritorio (Electron) que mide tiempo trabajado y actividad, y los
envía al backend de `tracking-timer`.

Implementa el contrato que el backend ya esperaba: `POST /api/agent/login`,
`GET /api/config`, `POST /api/activity`. La fórmula de puntuación replica
`backend/src/services/metrics.ts` — si cambian los baselines o pesos allí, hay
que cambiarlos también en `src/lib/metrics.js`.

## Qué registra

- Tiempo trabajado (cronómetro, descontando inactividad).
- Por minuto: número de pulsaciones, clics, movimientos y distancia del ratón.

**No** registra qué teclas se pulsan, ni textos, ni capturas de pantalla, ni qué
aplicaciones o webs se usan. El esquema del servidor no tiene dónde guardar nada
de eso, y así debe seguir: el empleado inicia sesión con sus propias credenciales
y ve en todo momento lo que se está midiendo.

## Estructura

| Ruta | Qué hace |
| --- | --- |
| `src/main.js` | Proceso principal: ventana, bandeja, IPC, arranque |
| `src/lib/tracker.js` | Motor de medición: ticks, inactividad, buckets |
| `src/lib/sync.js` | Cola offline y subida por lotes |
| `src/lib/api.js` | Cliente HTTP del backend |
| `src/lib/store.js` | Estado persistente (escritura atómica) |
| `src/lib/metrics.js` | Puntuación 0–100, espejo del backend |
| `ui/` | Interfaz (login y panel), sin acceso a Node |
| `build/make-icon.mjs` | Genera `assets/icon.png` y `icon.ico` |
| `build/package-win.mjs` | Empaqueta para Windows x64 |

## Desarrollo

```bash
npm install
npm start      # requiere un escritorio
npm test       # 35 pruebas, sin escritorio
```

## Empaquetado para Windows

```bash
npm run package:win
```

Produce `dist/ItappiTrackingAgent-<versión>-win-x64/` y su `.zip`.

Funciona **desde Linux sin wine**: descarga la distribución oficial de Electron
para win32-x64, verifica su SHA256 contra `SHASUMS256.txt`, monta la app en
`resources/app` y reescribe icono y metadatos del PE con `resedit` (JavaScript
puro). Requiere `python3` para el manejo de zips (stdlib `zipfile`).

El binario nativo de captura (`uiohook-napi`) viene precompilado para win32-x64
dentro del propio paquete npm, así que no hace falta compilar en Windows.

## Limitaciones conocidas

- **Sin firma digital.** Windows SmartScreen avisará la primera vez, y algunos
  antivirus señalarán la captura global de teclado. Firmar requiere un
  certificado de firma de código.
- **No hay instalador.** Es una carpeta portable; el `.exe` necesita los
  archivos que lo acompañan. Un instalador NSIS de una sola pieza requiere
  ejecutar el empaquetado en Windows (o wine).
- **Solo x64.** Para ARM64 hay que cambiar `ARCH` en `build/package-win.mjs`;
  el prebuild `win32-arm64` también existe en el paquete.
- **Sin actualizaciones automáticas.** El backend ya expone
  `GET /api/agent/version`, pero el agente todavía no lo consulta.
