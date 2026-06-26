import { IsArray, IsOptional, IsString, MaxLength } from 'class-validator';

/** Crear un issue desde el portal → GitHub Issue + ítem del board del cliente.
 *  Validaciones de metodología (descripción/criterios) se aplican en el servicio. */
export class CreateIssueDto {
  @IsString() @MaxLength(250) title: string;
  @IsString() type: string; // nombre de la opción Tipo del board (Historia, Bug, …)
  @IsString() description: string;
  @IsOptional() @IsString() acceptanceCriteria?: string; // Gherkin — obligatorio en Historia
  @IsOptional() @IsString() area?: string;
  @IsOptional() @IsString() priority?: string;
  @IsOptional() @IsString() estimate?: string; // S/M/L/XL
  @IsOptional() @IsString() sprint?: string; // título de la iteración
  @IsOptional() @IsString() startDate?: string; // yyyy-mm-dd (campo Inicio)
  @IsOptional() @IsString() dueDate?: string; // yyyy-mm-dd (campo Fin)
  @IsOptional() @IsArray() @IsString({ each: true }) links?: string[]; // adjuntos = URLs
}
