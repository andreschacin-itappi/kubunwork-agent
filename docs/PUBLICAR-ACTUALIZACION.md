# Publicar una actualización del agente (auto-update silencioso)

Solo funciona para agentes que ya tienen el auto-updater instalado (desde la
v0.2.0 en adelante). Antes de esa versión no hay nada que la detecte — esas
instalaciones se actualizan a mano, redistribuyendo el `.exe` por Pumble como
siempre.

## Cuándo alcanza con esto (la mayoría de los casos)

Si el cambio es solo código propio (`src/`, `ui/`, `assets/`, dependencias
JS puras) — sin tocar la versión de Electron ni agregar una dependencia con
binario nativo nuevo:

```bash
cd agent
# 1. Sube la versión en package.json (ej. "0.2.0" -> "0.2.1")
npm run package:update
```

Esto genera `dist/ItappiTrackingAgent-update-<version>.zip` (unos pocos MB,
no los ~140 MB del instalador completo) y muestra en la terminal un
`latest.json` listo para copiar.

**Publicar** (en el servidor, como root):

```bash
cp dist/ItappiTrackingAgent-update-<version>.zip /opt/tracking-timer/updates/
# pega el latest.json que imprimió el script:
cat > /opt/tracking-timer/updates/latest.json <<'EOF'
{ ... }
EOF
```

A partir de ahí, cada agente lo detecta solo (chequea cada ~6h y al iniciar
sesión), lo descarga, verifica el checksum y lo aplica **sin avisar al
empleado**, en el primer momento en que esté inactivo o con el rastreo en
pausa — nunca interrumpe una actividad en curso. No hace falta reinstalar
nada a mano.

**Despublicar / pausar el rollout**: borrar `latest.json` de esa carpeta
(los agentes vuelven a ver 204 = "sin actualización" y no hacen nada). El
`.zip` puede quedarse, solo importa si `latest.json` apunta a él.

## Cuándo hace falta redistribuir el `.exe` completo

- Se sube la versión de Electron (`package.json` → `devDependencies.electron`).
- Se agrega o actualiza una dependencia con binario nativo (como
  `uiohook-napi`) a una versión que cambia el `.node` compilado.
- Es la primera vez que se instala el agente en una máquina (no hay nada
  corriendo que pueda auto-actualizarse).

En esos casos: `npm run package:win`, subir el `.zip` de siempre a Pumble.
Conviene, de todas formas, correr también `npm run package:update` para esa
misma versión y publicarla — así los agentes que YA tienen el updater
instalado (aunque sea una versión vieja del updater) no quedan esperando un
release que solo llegó por Pumble a los nuevos.

## Verificar el rollout

Panel web → **Empleados** → columna **Versión** (viene del header
`X-Agent-Version` que el agente manda en cada llamada a `/api/agent/me`).
