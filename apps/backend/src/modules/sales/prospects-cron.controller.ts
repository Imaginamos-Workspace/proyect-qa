import { Controller, ForbiddenException, Get, Req } from '@nestjs/common';
import { ProspectsService } from './prospects.service';

/** Corrida SEMANAL de prospección — la dispara el cron de Vercel (lunes 8am
 *  Colombia; ver vercel.json). Va SIN el guard de Supabase (el cron no tiene
 *  sesión de usuario): autoriza por CRON_SECRET (Vercel lo manda como Bearer
 *  si está seteado), por INGEST_API_KEY (disparo manual) o por el header
 *  x-vercel-cron. ponytail: x-vercel-cron es spoofeable — el peor abuso
 *  posible es gastar cuota de búsqueda de Apollo; si molesta, setear
 *  CRON_SECRET en Vercel y este endpoint queda cerrado a solo el cron. */
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
      (cronSecret && header('authorization') === `Bearer ${cronSecret}`) ||
      (ingestKey && header('x-api-key') === ingestKey) ||
      (!cronSecret && !!header('x-vercel-cron'));
    if (!ok) throw new ForbiddenException('No autorizado para disparar la corrida semanal.');
    return this.prospects.runWeekly();
  }
}
