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

  /** Lee N discrete inputs (FC2). */
  async readDiscreteInputs(address: number, length: number): Promise<boolean[]> {
    return this.withReconnect(`FC2 readDiscreteInputs(${address}, ${length})`, async () => {
      const result = await this.client.readDiscreteInputs(address, length);
      return result.data.slice(0, length);
    });
  }

  /** Escribe un único coil (FC5). */
  async writeCoil(address: number, state: boolean): Promise<void> {
    await this.withReconnect(`FC5 writeCoil(${address}, ${state ? 1 : 0})`, async () => {
      await this.client.writeCoil(address, state);
    });
  }
}
