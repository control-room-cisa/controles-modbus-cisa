import * as fs from 'fs';
import * as path from 'path';
import { schedule as cronSchedule, type ScheduledTask } from 'node-cron';
import { validarHora, type ScheduleDefaults } from './config';
import type { LucesController } from './luces-controller';

export interface ScheduleState {
  enabled: boolean;
  on: string;
  off: string;
  timezone: string;
}

/**
 * Motivo por el que se ejecutó la reconciliación.
 *  · 'activacion' — el usuario acaba de encender el modo automático.
 *  · 'horario'    — cambió la ventana on/off/timezone con auto ya activo.
 */
export type ReconciliacionMotivo = 'activacion' | 'horario';

export interface SchedulerStatus extends ScheduleState {
  nextOn: string | null;
  nextOff: string | null;
  lastEvent: {
    type: 'on' | 'off';
    at: string;
    success: boolean;
    /** 'cron' (disparo programado) o 'sync' (reconciliación del modo auto). */
    source: 'cron' | 'sync';
    error?: string;
  } | null;
}

function horaACron(hhmm: string): string {
  const [hh, mm] = hhmm.split(':');
  return `${Number(mm)} ${Number(hh)} * * *`;
}

function hhmmAMinutos(hhmm: string): number {
  const [hh, mm] = hhmm.split(':').map(Number);
  return (hh ?? 0) * 60 + (mm ?? 0);
}

/** Minutos transcurridos desde medianoche en la zona horaria dada. */
function minutosLocales(fecha: Date, tz: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const partes = fmt.formatToParts(fecha);
  const hora = Number(partes.find((p) => p.type === 'hour')?.value ?? '0');
  const minuto = Number(partes.find((p) => p.type === 'minute')?.value ?? '0');
  return hora * 60 + minuto;
}

/**
 * Devuelve true si `ahora` cae en la ventana de encendido [on, off).
 * Soporta ventanas que cruzan la medianoche (p. ej. on=17:30, off=06:00).
 */
export function dentroDeVentana(
  on: string,
  off: string,
  tz: string,
  ahora: Date = new Date(),
): boolean {
  const onMin = hhmmAMinutos(on);
  const offMin = hhmmAMinutos(off);
  const nowMin = minutosLocales(ahora, tz);
  if (onMin === offMin) return false;
  if (onMin < offMin) {
    return nowMin >= onMin && nowMin < offMin;
  }
  return nowMin >= onMin || nowMin < offMin;
}

/**
 * Gestor del modo automático. Programa dos jobs cron diarios:
 * uno para enviar el pulso ON y otro para el pulso OFF.
 *
 * Las horas son editables en caliente; al cambiarlas se destruyen los
 * jobs viejos y se crean los nuevos. El estado se persiste en disco.
 */
export class Scheduler {
  private state: ScheduleState;
  private onTask: ScheduledTask | null = null;
  private offTask: ScheduledTask | null = null;
  private lastEvent: SchedulerStatus['lastEvent'] = null;

  constructor(
    private readonly luces: LucesController,
    private readonly defaults: ScheduleDefaults,
    private readonly storagePath: string,
  ) {
    this.state = this.cargar();
  }

  start(): void {
    if (this.state.enabled) {
      this.rearmarJobs();
    }
  }

  getStatus(): SchedulerStatus {
    return {
      ...this.state,
      nextOn: this.onTask?.getNextRun()?.toISOString() ?? null,
      nextOff: this.offTask?.getNextRun()?.toISOString() ?? null,
      lastEvent: this.lastEvent,
    };
  }

  update(parcial: Partial<ScheduleState>): SchedulerStatus {
    const antes = { ...this.state };
    const nuevo: ScheduleState = {
      enabled: parcial.enabled ?? this.state.enabled,
      on: parcial.on !== undefined ? validarHora(parcial.on, 'on') : this.state.on,
      off: parcial.off !== undefined ? validarHora(parcial.off, 'off') : this.state.off,
      timezone: parcial.timezone ?? this.state.timezone,
    };
    this.state = nuevo;
    this.persistir();

    this.detenerJobs();
    if (this.state.enabled) {
      this.rearmarJobs();

      // Reconciliar si:
      //  · acaba de activarse el modo auto, o
      //  · sigue activo pero cambió la ventana (on/off/timezone).
      const acabaDeActivarse = !antes.enabled;
      const cambioVentana =
        antes.on !== nuevo.on ||
        antes.off !== nuevo.off ||
        antes.timezone !== nuevo.timezone;

      if (acabaDeActivarse || cambioVentana) {
        const motivo: ReconciliacionMotivo = acabaDeActivarse ? 'activacion' : 'horario';
        void this.reconciliar(motivo);
      }
    }
    return this.getStatus();
  }

  /**
   * Evalúa la ventana [on, off) en la zona horaria configurada y devuelve
   * la acción que las luces deberían ejecutar para estar en coherencia
   * con el modo automático.
   */
  evaluarAccion(ahora: Date = new Date()): 'on' | 'off' {
    return dentroDeVentana(this.state.on, this.state.off, this.state.timezone, ahora)
      ? 'on'
      : 'off';
  }

  /**
   * Manda el pulso necesario para que las luces queden en el estado que
   * dicta el horario. Se ejecuta al activar el modo automático y cada vez
   * que se cambia la ventana mientras auto está activo, para mantener
   * coherencia entre modo auto y no-auto.
   */
  async reconciliar(motivo: ReconciliacionMotivo = 'activacion'): Promise<void> {
    if (!this.state.enabled) {
      return;
    }
    const accion = this.evaluarAccion();
    console.log(
      `[SCHEDULER] Reconciliando (${motivo}) · ventana ${this.state.on}-${this.state.off} (${this.state.timezone}) → ${accion.toUpperCase()}`,
    );
    await this.ejecutarPulso(accion, 'sync');
  }

  private rearmarJobs(): void {
    const opts = { timezone: this.state.timezone, noOverlap: true };

    this.onTask = cronSchedule(
      horaACron(this.state.on),
      async () => {
        await this.ejecutarPulso('on', 'cron');
      },
      { ...opts, name: 'pulso-on' },
    );

    this.offTask = cronSchedule(
      horaACron(this.state.off),
      async () => {
        await this.ejecutarPulso('off', 'cron');
      },
      { ...opts, name: 'pulso-off' },
    );
  }

  private detenerJobs(): void {
    if (this.onTask) {
      void this.onTask.destroy();
      this.onTask = null;
    }
    if (this.offTask) {
      void this.offTask.destroy();
      this.offTask = null;
    }
  }

  private async ejecutarPulso(tipo: 'on' | 'off', source: 'cron' | 'sync'): Promise<void> {
    const at = new Date().toISOString();
    try {
      if (tipo === 'on') {
        await this.luces.encender();
      } else {
        await this.luces.apagar();
      }
      this.lastEvent = { type: tipo, at, success: true, source };
      console.log(`[SCHEDULER] Pulso ${tipo.toUpperCase()} (${source}) enviado a las ${at}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastEvent = { type: tipo, at, success: false, source, error: msg };
      console.error(`[SCHEDULER] Falló pulso ${tipo.toUpperCase()} (${source}): ${msg}`);
    }
  }

  private cargar(): ScheduleState {
    try {
      if (fs.existsSync(this.storagePath)) {
        const raw = fs.readFileSync(this.storagePath, 'utf8');
        const parsed = JSON.parse(raw) as Partial<ScheduleState>;
        return {
          enabled: parsed.enabled ?? this.defaults.enabled,
          on: validarHora(parsed.on ?? this.defaults.on, 'on'),
          off: validarHora(parsed.off ?? this.defaults.off, 'off'),
          timezone: parsed.timezone ?? this.defaults.timezone,
        };
      }
    } catch (err) {
      console.error('[SCHEDULER] No se pudo cargar la persistencia, uso valores por defecto:', err);
    }
    return {
      enabled: this.defaults.enabled,
      on: this.defaults.on,
      off: this.defaults.off,
      timezone: this.defaults.timezone,
    };
  }

  private persistir(): void {
    try {
      const dir = path.dirname(this.storagePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.storagePath, JSON.stringify(this.state, null, 2), 'utf8');
    } catch (err) {
      console.error('[SCHEDULER] No se pudo persistir el horario:', err);
    }
  }

  stop(): void {
    this.detenerJobs();
  }
}
