import { ModbusClient } from './modbus-client';
import type { CoilsConfig } from './config';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Controlador de las luces de la Casa de Máquinas 1B.
 *
 * El PLC expone:
 *  - Coil ON     (ej. 0:0025): escribir 1 momentáneo → enciende
 *  - Coil OFF    (ej. 0:0026): escribir 1 momentáneo → apaga
 *  - Coil ESTADO (ej. 0:0016): lectura del estado actual (true=encendido)
 */
export class LucesController {
  constructor(
    private readonly modbus: ModbusClient,
    private readonly coils: CoilsConfig,
  ) {}

  private get addrOn(): number {
    return this.coils.on + this.coils.offset;
  }
  private get addrOff(): number {
    return this.coils.off + this.coils.offset;
  }
  private get addrStatus(): number {
    return this.coils.status + this.coils.offset;
  }

  async estaEncendida(): Promise<boolean> {
    const [estado] =
      this.coils.statusReadFc === 2
        ? await this.modbus.readDiscreteInputs(this.addrStatus, 1)
        : await this.modbus.readCoils(this.addrStatus, 1);
    return Boolean(estado);
  }

  async encender(): Promise<void> {
    await this.pulso(this.addrOn);
  }

  async apagar(): Promise<void> {
    await this.pulso(this.addrOff);
  }

  private async pulso(address: number): Promise<void> {
    await this.modbus.writeCoil(address, true);
    try {
      await delay(this.coils.pulseMs);
    } finally {
      await this.modbus.writeCoil(address, false);
    }
  }
}
