import * as path from 'path';
import {
  coilsConfig,
  scheduleDefaults,
  tcpConfig,
  webConfig,
} from './config';
import { ModbusClient } from './modbus-client';
import { LucesController } from './luces-controller';
import { Scheduler } from './scheduler';
import { crearServidor } from './server';

async function main(): Promise<void> {
  console.log('=== Luces 1B · Casa de Máquinas ===');
  console.log(`PLC Modbus TCP ${tcpConfig.host}:${tcpConfig.port} (unit ${tcpConfig.unitId})`);
  console.log(
    `Coils → ON=${coilsConfig.on}  OFF=${coilsConfig.off}  ESTADO=${coilsConfig.status}  offset=${coilsConfig.offset}  pulso=${coilsConfig.pulseMs}ms`,
  );

  const modbus = new ModbusClient(tcpConfig);

  try {
    await modbus.connect();
    console.log('Modbus conectado.');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`Aviso: no se pudo conectar al PLC al inicio (${msg}). El servidor seguirá arriba y reintentará en cada petición.`);
  }

  const luces = new LucesController(modbus, coilsConfig);

  const storagePath = path.resolve(process.cwd(), 'data', 'schedule.json');
  const scheduler = new Scheduler(luces, scheduleDefaults, storagePath);
  scheduler.start();

  const status = scheduler.getStatus();
  console.log(
    `Scheduler → ${status.enabled ? 'ACTIVO' : 'inactivo'} | ON ${status.on} · OFF ${status.off} | TZ ${status.timezone}`,
  );

  const app = crearServidor(luces, scheduler);
  const server = app.listen(webConfig.port, () => {
    console.log(`UI web disponible en  http://localhost:${webConfig.port}`);
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n${signal} recibido, cerrando...`);
    scheduler.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await modbus.disconnect().catch(() => undefined);
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error('Error fatal:', msg);
  process.exit(1);
});
