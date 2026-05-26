import { ModbusClient } from './modbus-client';
import type { CoilsConfig } from './config';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface BitEntry {
  addr: number;
  value: boolean;
}

export interface RegisterEntry {
  addr: number;
  value: number;
}

export interface Diagnostico {
  coilsConfig: {
    addrOn: number;
    addrOff: number;
    addrStatus: number;
    offset: number;
    pulseMs: number;
    statusReadFc: 1 | 2;
  };
  rangoBits: { desde: number; hasta: number };
  rangoRegistros: { desde: number; hasta: number };
  coils: BitEntry[] | null;
  coilsError?: string;
  discreteInputs: BitEntry[] | null;
  discreteInputsError?: string;
  holdingRegisters: RegisterEntry[] | null;
  holdingRegistersError?: string;
  estadoActual: boolean | null;
  estadoError?: string;
}

export interface CambioBit {
  tabla: 'coils' | 'discreteInputs';
  addr: number;
  antes: boolean;
  despues: boolean;
}

export interface CambioRegistro {
  tabla: 'holdingRegisters';
  addr: number;
  antes: number;
  despues: number;
  bitsCambiados: number[];
}

export interface SondeoResultado {
  accion: string;
  antes: Diagnostico;
  despues: Diagnostico;
  cambiosCoils: CambioBit[];
  cambiosInputs: CambioBit[];
  cambiosRegistros: CambioRegistro[];
  totalCambios: number;
}

export type RawAccion =
  | { fc: 5; addr: number; value: boolean; pulso: boolean; pulsoMs?: number; unitId?: number }
  | { fc: 6; addr: number; value: number; unitId?: number }
  | { fc: 15; addr: number; values: boolean[]; pulso: boolean; pulsoMs?: number; unitId?: number };

/**
 * Controlador de las luces de la Casa de Máquinas 1B.
 *
 * El PLC expone:
 *  - Coil ON  (ej. 0:0025): escribir 1 momentáneo → enciende
 *  - Coil OFF (ej. 0:0026): escribir 1 momentáneo → apaga
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

  /**
   * Lectura masiva para diagnóstico: coils, discrete inputs y holding
   * registers del PLC para que puedas localizar exactamente dónde está
   * el comando o el feedback.
   */
  async diagnostico(
    startBits = 0,
    countBits = 256,
    startRegs = 0,
    countRegs = 128,
  ): Promise<Diagnostico> {
    const result: Diagnostico = {
      coilsConfig: {
        addrOn: this.addrOn,
        addrOff: this.addrOff,
        addrStatus: this.addrStatus,
        offset: this.coils.offset,
        pulseMs: this.coils.pulseMs,
        statusReadFc: this.coils.statusReadFc,
      },
      rangoBits: { desde: startBits, hasta: startBits + countBits - 1 },
      rangoRegistros: { desde: startRegs, hasta: startRegs + countRegs - 1 },
      coils: null,
      discreteInputs: null,
      holdingRegisters: null,
      estadoActual: null,
    };

    try {
      const coils = await this.modbus.readCoilsChunked(startBits, countBits);
      result.coils = coils.map((value, i) => ({ addr: startBits + i, value }));
    } catch (err) {
      result.coilsError = err instanceof Error ? err.message : String(err);
    }

    try {
      const inputs = await this.modbus.readDiscreteInputsChunked(startBits, countBits);
      result.discreteInputs = inputs.map((value, i) => ({ addr: startBits + i, value }));
    } catch (err) {
      result.discreteInputsError = err instanceof Error ? err.message : String(err);
    }

    try {
      const regs = await this.modbus.readHoldingRegistersChunked(startRegs, countRegs);
      result.holdingRegisters = regs.map((value, i) => ({ addr: startRegs + i, value }));
    } catch (err) {
      result.holdingRegistersError = err instanceof Error ? err.message : String(err);
    }

    try {
      result.estadoActual = await this.estaEncendida();
    } catch (err) {
      result.estadoError = err instanceof Error ? err.message : String(err);
    }

    return result;
  }

  /**
   * Toma una foto, manda el pulso ON u OFF de las luces, vuelve a fotografiar
   * y reporta qué bits/registros cambiaron.
   */
  async probarPulso(accion: 'on' | 'off'): Promise<SondeoResultado> {
    return this.sondear(`pulso ${accion.toUpperCase()}`, async () => {
      if (accion === 'on') await this.encender();
      else await this.apagar();
    });
  }

  /**
   * Sondea con un acceso raw: escribe lo que indique `raw` (un coil con FC5
   * o un registro con FC6) y reporta los cambios en el PLC.
   *
   * - FC5 con `pulso=true`: escribe 1, espera, escribe 0 (comportamiento de pulso).
   * - FC5 con `pulso=false`: escribe el valor pedido y lo deja.
   * - FC6: escribe el valor en el registro y lo deja.
   */
  async probarRaw(raw: RawAccion): Promise<SondeoResultado> {
    let etiqueta: string;
    if (raw.fc === 5) {
      etiqueta = `FC5 coil[${raw.addr}] = ${raw.value ? 1 : 0}${raw.pulso ? ' (pulso)' : ''}`;
    } else if (raw.fc === 6) {
      etiqueta = `FC6 reg[${raw.addr}] = ${raw.value}`;
    } else {
      etiqueta = `FC15 coils[${raw.addr}..${raw.addr + raw.values.length - 1}] = [${raw.values
        .map((v) => (v ? 1 : 0))
        .join(',')}]${raw.pulso ? ' (pulso)' : ''}`;
    }
    if (raw.unitId !== undefined) etiqueta += ` · unit=${raw.unitId}`;

    return this.sondear(etiqueta, async () => {
      const restoreUnit = raw.unitId !== undefined ? this.modbus.getUnitId() : null;
      if (raw.unitId !== undefined) this.modbus.setUnitId(raw.unitId);
      try {
        if (raw.fc === 5) {
          if (raw.pulso) {
            await this.modbus.writeCoil(raw.addr, true);
            await delay(raw.pulsoMs ?? this.coils.pulseMs);
            await this.modbus.writeCoil(raw.addr, false);
          } else {
            await this.modbus.writeCoil(raw.addr, raw.value);
          }
        } else if (raw.fc === 6) {
          await this.modbus.writeRegister(raw.addr, raw.value);
        } else {
          if (raw.pulso) {
            await this.modbus.writeCoils(raw.addr, raw.values);
            await delay(raw.pulsoMs ?? this.coils.pulseMs);
            await this.modbus.writeCoils(
              raw.addr,
              raw.values.map(() => false),
            );
          } else {
            await this.modbus.writeCoils(raw.addr, raw.values);
          }
        }
      } finally {
        if (restoreUnit !== null) this.modbus.setUnitId(restoreUnit);
      }
    });
  }

  private async sondear(
    etiqueta: string,
    accion: () => Promise<void>,
  ): Promise<SondeoResultado> {
    const antes = await this.diagnostico();
    await accion();
    await delay(800);
    const despues = await this.diagnostico();

    const cambiosCoils = this.diffBits(antes.coils, despues.coils, 'coils');
    const cambiosInputs = this.diffBits(
      antes.discreteInputs,
      despues.discreteInputs,
      'discreteInputs',
    );
    const cambiosRegistros = this.diffRegistros(
      antes.holdingRegisters,
      despues.holdingRegisters,
    );

    return {
      accion: etiqueta,
      antes,
      despues,
      cambiosCoils,
      cambiosInputs,
      cambiosRegistros,
      totalCambios:
        cambiosCoils.length + cambiosInputs.length + cambiosRegistros.length,
    };
  }

  private diffBits(
    antes: BitEntry[] | null,
    despues: BitEntry[] | null,
    tabla: 'coils' | 'discreteInputs',
  ): CambioBit[] {
    if (!antes || !despues) return [];
    const cambios: CambioBit[] = [];
    const len = Math.min(antes.length, despues.length);
    for (let i = 0; i < len; i++) {
      const a = antes[i];
      const d = despues[i];
      if (!a || !d) continue;
      if (a.value !== d.value) {
        cambios.push({ tabla, addr: a.addr, antes: a.value, despues: d.value });
      }
    }
    return cambios;
  }

  private diffRegistros(
    antes: RegisterEntry[] | null,
    despues: RegisterEntry[] | null,
  ): CambioRegistro[] {
    if (!antes || !despues) return [];
    const cambios: CambioRegistro[] = [];
    const len = Math.min(antes.length, despues.length);
    for (let i = 0; i < len; i++) {
      const a = antes[i];
      const d = despues[i];
      if (!a || !d) continue;
      if (a.value !== d.value) {
        const xor = (a.value ^ d.value) & 0xffff;
        const bitsCambiados: number[] = [];
        for (let b = 0; b < 16; b++) {
          if ((xor >> b) & 1) bitsCambiados.push(b);
        }
        cambios.push({
          tabla: 'holdingRegisters',
          addr: a.addr,
          antes: a.value,
          despues: d.value,
          bitsCambiados,
        });
      }
    }
    return cambios;
  }
}
