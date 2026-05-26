# modbus-luces-1b

Control de luces de la **Casa de Máquinas 1B** vía **Modbus TCP** + **UI web con Tailwind**.

- **Modo manual** desde la UI: botones Encender / Apagar / Alternar.
- **Modo automático** con horario diario editable (ON/OFF), persistido en disco.
- **Pulso instantáneo** sobre los coils del PLC (`0:0025` para encender, `0:0026` para apagar).
- **Lectura de estado** desde el coil `0:0016`.
- **Simulador integrado** para desarrollar sin el PLC real.

## PLC objetivo

| Parámetro       | Valor                       |
| --------------- | --------------------------- |
| IP              | `192.168.6.100`             |
| Puerto Modbus   | `502`                       |
| Unit ID         | `1`                         |
| Coil ON         | `0:0025` (pulso instantáneo)|
| Coil OFF        | `0:0026` (pulso instantáneo)|
| Coil ESTADO     | `0:0016` (lectura)          |

> Si la documentación del PLC numera las direcciones en **1-based** y el cable
> Modbus las espera en **0-based**, ajusta `COIL_OFFSET=-1` en `.env`.

## Requisitos

- Node.js >= 20 (probado con 22).
- npm 10+.

## Instalación

```bash
npm install
cp .env.example .env   # ya viene apuntando al PLC 192.168.6.100
```

## Scripts

| Comando            | Qué hace                                                       |
| ------------------ | --------------------------------------------------------------- |
| `npm run sim`      | Levanta el simulador Modbus TCP local (puerto `5020` por defecto). |
| `npm run dev`      | Arranca la app con recarga (servidor web + scheduler).         |
| `npm run build`    | Compila a `dist/`.                                              |
| `npm start`        | Ejecuta el build (`dist/index.js`).                             |
| `npm run typecheck`| Verifica tipos sin emitir archivos.                             |
| `npm run clean`    | Borra la carpeta `dist/`.                                       |

## Uso contra el PLC real

```bash
npm run build
npm start
# Abre http://localhost:3000
```

## Uso contra el simulador (sin PLC)

En una terminal:

```bash
npm run sim       # arranca el simulador en :5020
```

En otra (ajustando temporalmente las variables del cliente):

```powershell
$env:MODBUS_HOST="127.0.0.1"; $env:MODBUS_PORT="5020"; npm run dev
```

Abre <http://localhost:3000>. El simulador reacciona a los pulsos:
escribir 1 en coil `25` enciende el estado, escribir 1 en coil `26` lo apaga.

## API REST

| Método | Endpoint           | Descripción                                          |
| ------ | ------------------ | ---------------------------------------------------- |
| GET    | `/api/status`      | Estado actual + horario + próximos disparos.         |
| POST   | `/api/on`          | Manda pulso ON al coil de encendido.                 |
| POST   | `/api/off`         | Manda pulso OFF al coil de apagado.                  |
| GET    | `/api/schedule`    | Devuelve la configuración de horario.                |
| PUT    | `/api/schedule`    | Actualiza `{ enabled, on, off, timezone }`.          |

Ejemplo:

```bash
curl http://localhost:3000/api/status
curl -X POST http://localhost:3000/api/on
curl -X PUT -H "Content-Type: application/json" \
     -d '{"on":"18:00","off":"05:30","enabled":true}' \
     http://localhost:3000/api/schedule
```

## Variables de entorno

Ver `.env.example`. Las más importantes:

| Variable             | Por defecto         | Descripción                                     |
| -------------------- | ------------------- | ----------------------------------------------- |
| `MODBUS_HOST`        | `192.168.6.100`     | IP del PLC.                                     |
| `MODBUS_PORT`        | `502`               | Puerto Modbus TCP.                              |
| `MODBUS_UNIT_ID`     | `1`                 | Unit ID Modbus.                                 |
| `MODBUS_TIMEOUT_MS`  | `2000`              | Timeout de operaciones.                         |
| `COIL_ON`            | `25`                | Coil de pulso ON (0:0025).                      |
| `COIL_OFF`           | `26`                | Coil de pulso OFF (0:0026).                     |
| `COIL_STATUS`        | `16`                | Coil de lectura de estado (0:0016).             |
| `COIL_OFFSET`        | `0`                 | Offset (usa `-1` si la doc es 1-based).         |
| `PULSE_MS`           | `300`               | Duración del pulso momentáneo.                  |
| `SCHEDULE_ON`        | `17:30`             | Hora ON por defecto (editable desde UI).        |
| `SCHEDULE_OFF`       | `06:00`             | Hora OFF por defecto (editable desde UI).       |
| `SCHEDULE_ENABLED`   | `true`              | Si el scheduler arranca activo.                 |
| `SCHEDULE_TIMEZONE`  | `America/Guatemala` | Zona horaria de los cron jobs.                  |
| `WEB_PORT`           | `3000`              | Puerto del servidor HTTP.                       |
| `SIM_PORT`           | `5020`              | Puerto del simulador.                           |
| `SIM_COILS`          | `32`                | Número de coils del simulador.                  |

El horario editado desde la UI se persiste en `data/schedule.json`, así
que sobrevive a reinicios. Las variables `SCHEDULE_*` del `.env` se usan
sólo como valores iniciales si no existe el archivo.

## Sobre el "pulso instantáneo"

Algunos PLCs requieren un pulso explícito (escribir 1, mantener un
momento, volver a 0). Eso es lo que hace `LucesController.encender()` y
`apagar()`:

```ts
await modbus.writeCoil(addrOn, true);
await delay(PULSE_MS);   // 300 ms por defecto
await modbus.writeCoil(addrOn, false);
```

Si tu PLC ya hace el auto-reset interno, puedes reducir `PULSE_MS` a `50`.
Si necesita un pulso más largo, súbelo. Cambia solo la variable de entorno.

## ¿Tailwind en Node.js?

Sí. El proyecto sirve el HTML desde Express (`public/index.html`) y carga
**Tailwind por CDN** (`https://cdn.tailwindcss.com`) — cero build step.
Si quieres compilar Tailwind a CSS estático (para producción, sin red),
el flujo sería:

1. `npm i -D tailwindcss postcss autoprefixer`
2. `npx tailwindcss init`
3. Configurar `content: ['./public/**/*.html']`
4. `npx tailwindcss -i ./public/style.src.css -o ./public/style.css --watch`
5. Reemplazar el `<script src="cdn">` por `<link rel="stylesheet" href="/style.css">`.

## Estructura

```
.
├── src/
│   ├── config.ts            # Carga .env y valida variables
│   ├── modbus-client.ts     # Cliente Modbus TCP con reconexión
│   ├── luces-controller.ts  # Pulso ON/OFF, lectura de estado
│   ├── scheduler.ts         # Modo automático con cron + persistencia
│   ├── server.ts            # Express + API REST + static
│   ├── simulator.ts         # Simulador del PLC 1B
│   └── index.ts             # Bootstrap completo
├── public/
│   └── index.html           # UI con Tailwind (CDN)
├── data/
│   └── schedule.json        # Persistencia del horario (auto-creado)
├── tsconfig.json
├── package.json
├── .env / .env.example
└── README.md
```

## Licencia

ISC
