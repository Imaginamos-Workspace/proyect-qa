import { ArrayMaxSize, IsArray, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Crear un issue desde el portal → GitHub Issue + ítem del board del cliente.
 *  Validaciones de metodología (descripción/criterios) se aplican en el servicio. */
export class CreateIssueDto {
  @IsString() @IsNotEmpty() @MaxLength(250) title: string;
  @IsString() @IsNotEmpty() type: string; // nombre de la opción Tipo del board (Historia, Bug, …)
  @IsString() @IsNotEmpty() @MaxLength(10_000) description: string;
  @IsOptional() @IsString() @MaxLength(10_000) acceptanceCriteria?: string; // Gherkin — obligatorio en Historia
  @IsOptional() @IsString() @MaxLength(80) area?: string;
  @IsOptional() @IsString() @MaxLength(80) priority?: string;
  @IsOptional() @IsString() @MaxLength(40) estimate?: string; // S/M/L/XL
  @IsOptional() @IsString() @MaxLength(120) sprint?: string; // título de la iteración
  @IsOptional() @IsString() @Matches(YMD, { message: 'Inicio inválido (use YYYY-MM-DD).' }) startDate?: string;
  @IsOptional() @IsString() @Matches(YMD, { message: 'Entrega inválida (use YYYY-MM-DD).' }) dueDate?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(500, { each: true })
  links?: string[]; // adjuntos = URLs
}
