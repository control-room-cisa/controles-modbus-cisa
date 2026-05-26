import * as path from 'path';
import express, { type Request, type Response, type NextFunction } from 'express';
import type { LucesController } from './luces-controller';
import type { Scheduler } from './scheduler';

export function crearServidor(luces: LucesController, scheduler: Scheduler): express.Express {
  const app = express();
  app.use(express.json());

  // Helper para envolver controladores async
  const asyncHandler =
    (fn: (req: Request, res: Response) => Promise<unknown>) =>
    (req: Request, res: Response, next: NextFunction): void => {
      fn(req, res).catch(next);
    };

  app.get(
    '/api/status',
    asyncHandler(async (_req, res) => {
      const encendida = await luces.estaEncendida();
      const sched = scheduler.getStatus();
      res.json({ encendida, schedule: sched });
    }),
  );

  app.post(
    '/api/on',
    asyncHandler(async (_req, res) => {
      if (scheduler.getStatus().enabled) {
        res.status(409).json({
          ok: false,
          error: 'Modo automático activo · desactívalo antes de operar manualmente.',
        });
        return;
      }
      await luces.encender();
      res.json({ ok: true, action: 'on' });
    }),
  );

  app.post(
    '/api/off',
    asyncHandler(async (_req, res) => {
      if (scheduler.getStatus().enabled) {
        res.status(409).json({
          ok: false,
          error: 'Modo automático activo · desactívalo antes de operar manualmente.',
        });
        return;
      }
      await luces.apagar();
      res.json({ ok: true, action: 'off' });
    }),
  );

  app.get(
    '/api/diag',
    asyncHandler(async (_req, res) => {
      const diag = await luces.diagnostico();
      res.json(diag);
    }),
  );

  app.post(
    '/api/probe/:accion',
    asyncHandler(async (req, res) => {
      const accion = req.params.accion;
      if (accion !== 'on' && accion !== 'off') {
        res.status(400).json({ ok: false, error: 'accion debe ser on u off' });
        return;
      }
      const sondeo = await luces.probarPulso(accion);
      res.json(sondeo);
    }),
  );

  app.post(
    '/api/probe-raw',
    asyncHandler(async (req, res) => {
      const body = req.body as {
        fc?: number;
        addr?: number;
        value?: number | boolean;
        values?: (number | boolean)[];
        pulso?: boolean;
        pulsoMs?: number;
        unitId?: number;
      };
      const fc = body.fc;
      const addr = body.addr;
      if (fc !== 5 && fc !== 6 && fc !== 15) {
        res.status(400).json({ ok: false, error: 'fc debe ser 5, 6 o 15' });
        return;
      }
      if (typeof addr !== 'number' || !Number.isFinite(addr) || addr < 0 || addr > 65535) {
        res.status(400).json({ ok: false, error: 'addr inválido (0..65535)' });
        return;
      }
      const unitId = body.unitId;
      if (
        unitId !== undefined &&
        (!Number.isFinite(unitId) || unitId < 0 || unitId > 247)
      ) {
        res.status(400).json({ ok: false, error: 'unitId inválido (0..247)' });
        return;
      }
      if (fc === 5) {
        const value = typeof body.value === 'boolean' ? body.value : body.value === 1;
        const sondeo = await luces.probarRaw({
          fc: 5,
          addr,
          value,
          pulso: body.pulso !== false,
          pulsoMs: body.pulsoMs,
          unitId,
        });
        res.json(sondeo);
      } else if (fc === 6) {
        const value = Number(body.value);
        if (!Number.isFinite(value) || value < 0 || value > 0xffff) {
          res.status(400).json({ ok: false, error: 'value de registro inválido (0..65535)' });
          return;
        }
        const sondeo = await luces.probarRaw({ fc: 6, addr, value, unitId });
        res.json(sondeo);
      } else {
        // FC15
        const raw = body.values ?? [body.value];
        const values = raw.map((v) => (typeof v === 'boolean' ? v : v === 1));
        if (values.length === 0 || values.length > 1968) {
          res.status(400).json({ ok: false, error: 'values requiere 1..1968 elementos' });
          return;
        }
        const sondeo = await luces.probarRaw({
          fc: 15,
          addr,
          values,
          pulso: body.pulso !== false,
          pulsoMs: body.pulsoMs,
          unitId,
        });
        res.json(sondeo);
      }
    }),
  );

  app.get('/api/schedule', (_req: Request, res: Response) => {
    res.json(scheduler.getStatus());
  });

  app.put('/api/schedule', (req: Request, res: Response) => {
    try {
      const body = req.body as {
        enabled?: boolean;
        on?: string;
        off?: string;
        timezone?: string;
      };
      const actualizado = scheduler.update(body);
      res.json(actualizado);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ ok: false, error: msg });
    }
  });

  // Sirve la UI (HTML con Tailwind via CDN)
  const publicDir = path.resolve(__dirname, '..', 'public');
  app.use(express.static(publicDir));

  // Middleware de errores
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[API] Error:', msg);
    res.status(500).json({ ok: false, error: msg });
  });

  return app;
}
