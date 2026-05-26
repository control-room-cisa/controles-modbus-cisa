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
