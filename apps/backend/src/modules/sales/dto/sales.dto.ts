import { IsArray, IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

const SLUG = /^[a-z0-9-]+$/;

/** Crear una oportunidad nueva — mismo kebab-case que exige `sales:new` local. */
export class CreateOpportunityDto {
  @IsString() @IsNotEmpty() @MaxLength(80)
  @Matches(SLUG, { message: 'cliente debe ser kebab-case (a-z0-9-).' })
  cliente: string;

  @IsString() @IsNotEmpty() @MaxLength(80)
  @Matches(SLUG, { message: 'oportunidad debe ser kebab-case (a-z0-9-).' })
  oportunidad: string;
}

/** Mensaje del vendedor en el chat de la oportunidad. */
export class SendMessageDto {
  @IsString() @IsNotEmpty() @MaxLength(8_000)
  content: string;
}

/** Búsqueda de prospectos en Apollo.io. Todos los filtros son opcionales,
 *  pero el service exige al menos uno (borde validado en ambos lados). */
export class SearchProspectsDto {
  @IsOptional() @IsString() @MaxLength(200)
  keywords?: string;

  @IsOptional() @IsArray() @IsString({ each: true }) @MaxLength(80, { each: true })
  titles?: string[];

  @IsOptional() @IsArray() @IsString({ each: true }) @MaxLength(80, { each: true })
  locations?: string[];

  @IsOptional() @IsArray() @IsString({ each: true })
  @Matches(/^\d+,\d+$/, { each: true, message: 'employeeRanges usa el formato Apollo "min,max" (ej. "11,50").' })
  employeeRanges?: string[];

  @IsOptional() @IsInt() @Min(1) @Max(500)
  page?: number;
}

/** Enriquecer un prospecto de Apollo (people/match — consume 1 crédito). */
export class EnrichProspectDto {
  @IsString() @IsNotEmpty() @MaxLength(64)
  id: string;
}

/** Handoff al TL — el vendedor asigna el Owner TL (rules/13 §Cerrar el brief). */
export class HandoffDto {
  @IsOptional() @IsString() @MaxLength(80)
  @Matches(/^[\w-]+$/, { message: 'tlLogin debe ser un login de GitHub válido.' })
  tlLogin?: string;
}

/** Marcar notificaciones como vistas — sin ids marca TODAS las del que consulta. */
export class MarkNotificationsSeenDto {
  @IsOptional() @IsArray() @IsString({ each: true }) @MaxLength(64, { each: true })
  ids?: string[];
}

/** Ceder el proceso a otro vendedor (login de GitHub de team.json). */
export class TransferOpportunityDto {
  @IsString() @IsNotEmpty() @MaxLength(80)
  @Matches(/^[\w-]+$/, { message: 'toLogin debe ser un login de GitHub válido.' })
  toLogin: string;
}
