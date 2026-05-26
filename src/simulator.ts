import { ServerTCP } from 'modbus-serial';
import type { IServiceVector } from 'modbus-serial/ServerTCP';
import { coilsConfig, simulatorConfig } from './config';

/**
 * Simulador del PLC de Casa de Máquinas 1B.
 *
 * Reproduce la lógica documentada:
 *  - Escribir 1 en COIL_ON → enciende (coil de estado pasa a 1).
 *  - Escribir 1 en COIL_OFF → apaga (coil de estado pasa a 0).
 *  - El coil de estado se puede leer en cualquier momento.
 */
function crearSimulador(numCoils: number, puerto: number): ServerTCP {
  const coils: boolean[] = new Array(numCoils).fill(false);
  const holdingRegisters: number[] = new Array(64).fill(0);

  const addrOn = coilsConfig.on + coilsConfig.offset;
  const addrOff = coilsConfig.off + coilsConfig.offset;
  const addrStatus = coilsConfig.status + coilsConfig.offset;

  const vector: IServiceVector = {
    getCoil: (addr: number, _unitID: number): boolean => {
      if (addr < 0 || addr >= coils.length) return false;
      return coils[addr] ?? false;
    },
    setCoil: (addr: number, value: boolean, _unitID: number): void => {
      if (addr < 0 || addr >= coils.length) {
        throw new Error(`Coil ${addr} fuera de rango (0..${coils.length - 1})`);
      }
      coils[addr] = value;

      if (addr === addrOn && value === true) {
        coils[addrStatus] = true;
        console.log(`[SIM] Pulso ON recibido → estado = ENCENDIDO`);
      } else if (addr === addrOff && value === true) {
        coils[addrStatus] = false;
        console.log(`[SIM] Pulso OFF recibido → estado = APAGADO`);
      } else if (addr === addrOn || addr === addrOff) {
        // se ignora: bajada del pulso a 0
      } else {
        console.log(`[SIM] coil[${addr}] = ${value ? 'ON' : 'OFF'}`);
      }
    },
    getHoldingRegister: (addr: number): number => {
      if (addr < 0 || addr >= holdingRegisters.length) return 0;
      return holdingRegisters[addr] ?? 0;
    },
    setRegister: (addr: number, value: number): void => {
      if (addr < 0 || addr >= holdingRegisters.length) {
        throw new Error(`Registro ${addr} fuera de rango`);
      }
      holdingRegisters[addr] = value & 0xffff;
    },
    getInputRegister: (addr: number): number => addr,
    getDiscreteInput: (addr: number): boolean => addr % 2 === 0,
  };

  const server = new ServerTCP(vector, {
    host: '0.0.0.0',
    port: puerto,
    debug: false,
    unitID: 1,
  });

  server.on('initialized', () => {
    console.log(`[SIM] Servidor Modbus TCP escuchando en 0.0.0.0:${puerto}`);
    console.log(`[SIM] COIL_ON=${addrOn}  COIL_OFF=${addrOff}  COIL_STATUS=${addrStatus}`);
  });

  server.on('socketError', (err: Error | null) => {
    if (err) console.error('[SIM] Error de socket:', err.message);
  });

  server.on('serverError', (err: Error | null) => {
    if (err) console.error('[SIM] Error de servidor:', err.message);
  });

  return server;
}

if (require.main === module) {
  const server = crearSimulador(simulatorConfig.coils, simulatorConfig.port);

  const shutdown = (): void => {
    console.log('\n[SIM] Cerrando simulador...');
    server.close(() => {
      console.log('[SIM] Cerrado.');
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

export { crearSimulador };
