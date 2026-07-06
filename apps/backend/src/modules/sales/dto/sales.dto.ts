import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

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

/** Ceder el proceso a otro vendedor (login de GitHub de team.json). */
export class TransferOpportunityDto {
  @IsString() @IsNotEmpty() @MaxLength(80)
  @Matches(/^[\w-]+$/, { message: 'toLogin debe ser un login de GitHub válido.' })
  toLogin: string;
}
