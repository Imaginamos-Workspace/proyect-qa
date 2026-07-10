import { Controller, ForbiddenException, Get, Req } from '@nestjs/common';
import { ProspectsService } from './prospects.service';

import { timingSafeEqual } from 'crypto';

/** Corrida SEMANAL de prospección — la dispara el cron de Vercel (lunes 8am
 *  Colombia; ver vercel.json). Va SIN el guard de Supabase (el cron no tiene
 *  sesión de usuario). FAIL-CLOSED: exige un secreto compartido
 *  (CRON_SECRET como Bearer, o INGEST_API_KEY como x-api-key). Sin ninguno
 *  seteado el endpoint queda CERRADO — no se degrada a x-vercel-cron (que es
 *  spoofeable y dejaba abierta la quema de cuota de Apollo). Vercel manda
 *  automáticamente `Authorization: Bearer $CRON_SECRET` en sus crons. */
@Controller('sales/prospects')
export class ProspectsCronController {
  constructor(private readonly prospects: ProspectsService) {}

  @Get('cron-weekly')
  async cronWeekly(@Req() req: { headers: Record<string, string | string[] | undefined> }) {
    const header = (name: string) => {
      const v = req.headers[name];
      return Array.isArray(v) ? v[0] : v ?? '';
    };
    const cronSecret = process.env.CRON_SECRET?.trim();
    const ingestKey = process.env.INGEST_API_KEY?.trim();
    const ok =
      (!!cronSecret && safeEqual(header('authorization'), `Bearer ${cronSecret}`)) ||
      (!!ingestKey && safeEqual(header('x-api-key'), ingestKey));
    if (!ok) {
      throw new ForbiddenException(
        'No autorizado. Configura CRON_SECRET en el backend (Vercel lo envía como Bearer en sus crons).',
      );
    }
    return this.prospects.runWeekly();
  }
}

/** Comparación de secretos en tiempo constante (mismo patrón que heal-token). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
