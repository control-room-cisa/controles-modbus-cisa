import ModbusRTU from 'modbus-serial';
import type { ModbusTcpConfig } from './config';

function ts(): string {
  return new Date().toISOString().substring(11, 23);
}

/**
 * Envoltorio sobre `modbus-serial` con conexión TCP, reconexión perezosa,
 * logging opcional y métodos tipados para coils, discrete inputs y registros.
 */
export class ModbusClient {
  private readonly client: ModbusRTU;
  private connecting: Promise<void> | null = null;

  constructor(private readonly config: ModbusTcpConfig) {
    this.client = new ModbusRTU();
    this.client.on('close', () => {
      if (this.config.debug) console.log(`[${ts()}] MODBUS close`);
    });
    this.client.on('error', (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[${ts()}] MODBUS error:`, msg);
    });
  }

  async connect(): Promise<void> {
    if (this.client.isOpen) return;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      try {
        if (this.config.debug) {
          console.log(
            `[${ts()}] MODBUS connect → tcp://${this.config.host}:${this.config.port} unit=${this.config.unitId}`,
          );
        }
        await this.client.connectTCP(this.config.host, { port: this.config.port });
        this.client.setID(this.config.unitId);
        this.client.setTimeout(this.config.timeoutMs);
      } finally {
        this.connecting = null;
      }
    })();

    return this.connecting;
  }

  async disconnect(): Promise<void> {
    if (!this.client.isOpen) return;
    await new Promise<void>((resolve) => this.client.close(() => resolve()));
  }

  get isConnected(): boolean {
    return this.client.isOpen;
  }

  getUnitId(): number {
    return this.client.getID();
  }

  setUnitId(unitId: number): void {
    this.client.setID(unitId);
  }

  private async withReconnect<T>(label: string, op: () => Promise<T>): Promise<T> {
    if (!this.client.isOpen) await this.connect();
    try {
      const result = await op();
      if (this.config.debug) console.log(`[${ts()}] MODBUS ✓ ${label}`);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[${ts()}] MODBUS ✗ ${label} → ${msg}`);
      if (!this.client.isOpen) {
        await this.connect();
        return op();
      }
      throw err;
    }
  }

  /** Lee N coils (FC1). */
  async readCoils(address: number, length: number): Promise<boolean[]> {
    return this.withReconnect(`FC1 readCoils(${address}, ${length})`, async () => {
      const result = await this.client.readCoils(address, length);
      return result.data.slice(0, length);
    });
  }

  /** Lee N coils en bloques de `chunk` para evitar límites del PLC. */
  async readCoilsChunked(address: number, length: number, chunk = 100): Promise<boolean[]> {
    const out: boolean[] = [];
    for (let off = 0; off < length; off += chunk) {
      const size = Math.min(chunk, length - off);
      const part = await this.readCoils(address + off, size);
      out.push(...part);
    }
    return out;
  }

  /** Lee N discrete inputs (FC2). */
  async readDiscreteInputs(address: number, length: number): Promise<boolean[]> {
    return this.withReconnect(`FC2 readDiscreteInputs(${address}, ${length})`, async () => {
      const result = await this.client.readDiscreteInputs(address, length);
      return result.data.slice(0, length);
    });
  }

  /** Lee N discrete inputs en bloques de `chunk`. */
  async readDiscreteInputsChunked(
    address: number,
    length: number,
    chunk = 100,
  ): Promise<boolean[]> {
    const out: boolean[] = [];
    for (let off = 0; off < length; off += chunk) {
      const size = Math.min(chunk, length - off);
      const part = await this.readDiscreteInputs(address + off, size);
      out.push(...part);
    }
    return out;
  }

  /** Lee N holding registers en bloques de `chunk` (máx 125 por request). */
  async readHoldingRegistersChunked(
    address: number,
    length: number,
    chunk = 100,
  ): Promise<number[]> {
    const out: number[] = [];
    for (let off = 0; off < length; off += chunk) {
      const size = Math.min(chunk, length - off);
      const part = await this.readHoldingRegisters(address + off, size);
      out.push(...part);
    }
    return out;
  }

  /** Escribe un único coil (FC5). */
  async writeCoil(address: number, state: boolean): Promise<void> {
    await this.withReconnect(`FC5 writeCoil(${address}, ${state ? 1 : 0})`, async () => {
      await this.client.writeCoil(address, state);
    });
  }

  /** Escribe múltiples coils consecutivos (FC15). */
  async writeCoils(address: number, states: boolean[]): Promise<void> {
    await this.withReconnect(`FC15 writeCoils(${address}, [${states.length}])`, async () => {
      await this.client.writeCoils(address, states);
    });
  }

  /** Lee N holding registers (FC3). */
  async readHoldingRegisters(address: number, length: number): Promise<number[]> {
    return this.withReconnect(`FC3 readHoldingRegisters(${address}, ${length})`, async () => {
      const result = await this.client.readHoldingRegisters(address, length);
      return result.data.slice(0, length);
    });
  }

  /** Escribe un único holding register (FC6). */
  async writeRegister(address: number, value: number): Promise<void> {
    await this.withReconnect(`FC6 writeRegister(${address}, ${value})`, async () => {
      await this.client.writeRegister(address, value);
    });
  }
}
