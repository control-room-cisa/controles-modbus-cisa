import * as dotenv from 'dotenv';

dotenv.config();

function getEnv(name: string, defaultValue?: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    if (defaultValue !== undefined) return defaultValue;
    throw new Error(`Variable de entorno requerida no definida: ${name}`);
  }
  return value;
}

function getEnvNumber(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`La variable ${name} debe ser un número, recibido: "${raw}"`);
  }
  return parsed;
}

function getEnvBool(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  return ['1', 'true', 'yes', 'on', 'si', 'sí'].includes(raw.trim().toLowerCase());
}

function validarHora(valor: string, nombre: string): string {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(valor.trim());
  if (!match) {
    throw new Error(`${nombre} debe tener formato HH:MM (24h). Recibido: "${valor}"`);
  }
  const horas = match[1]!.padStart(2, '0');
  const minutos = match[2]!;
  return `${horas}:${minutos}`;
}

export interface ModbusTcpConfig {
  host: string;
  port: number;
  unitId: number;
  timeoutMs: number;
  debug: boolean;
}

export type StatusReadFc = 1 | 2;

export interface CoilsConfig {
  on: number;
  off: number;
  status: number;
  /** Offset aplicado a todas las direcciones (útil si el PLC documenta en 1-based). */
  offset: number;
  pulseMs: number;
  /** 1 = FC1 (coil), 2 = FC2 (discrete input) */
  statusReadFc: StatusReadFc;
}

export interface ScheduleDefaults {
  on: string;
  off: string;
  enabled: boolean;
  timezone: string;
}

export interface WebConfig {
  port: number;
}

export interface SimulatorConfig {
  port: number;
  coils: number;
}

export const tcpConfig: ModbusTcpConfig = {
  host: getEnv('MODBUS_HOST', '127.0.0.1'),
  port: getEnvNumber('MODBUS_PORT', 502),
  unitId: getEnvNumber('MODBUS_UNIT_ID', 1),
  timeoutMs: getEnvNumber('MODBUS_TIMEOUT_MS', 2000),
  debug: getEnvBool('MODBUS_DEBUG', false),
};

function parseFc(raw: string): StatusReadFc {
  const n = Number(raw);
  if (n !== 1 && n !== 2) {
    throw new Error(`STATUS_READ_FC debe ser 1 o 2. Recibido: "${raw}"`);
  }
  return n;
}

export const coilsConfig: CoilsConfig = {
  on: getEnvNumber('COIL_ON', 25),
  off: getEnvNumber('COIL_OFF', 26),
  status: getEnvNumber('COIL_STATUS', 16),
  offset: getEnvNumber('COIL_OFFSET', 0),
  pulseMs: getEnvNumber('PULSE_MS', 500),
  statusReadFc: parseFc(getEnv('STATUS_READ_FC', '1')),
};

export const scheduleDefaults: ScheduleDefaults = {
  on: validarHora(getEnv('SCHEDULE_ON', '17:30'), 'SCHEDULE_ON'),
  off: validarHora(getEnv('SCHEDULE_OFF', '06:00'), 'SCHEDULE_OFF'),
  enabled: getEnvBool('SCHEDULE_ENABLED', true),
  timezone: getEnv('SCHEDULE_TIMEZONE', 'America/Guatemala'),
};

export const webConfig: WebConfig = {
  port: getEnvNumber('WEB_PORT', 3000),
};

export const simulatorConfig: SimulatorConfig = {
  port: getEnvNumber('SIM_PORT', 502),
  coils: getEnvNumber('SIM_COILS', 32),
};

export { validarHora };
