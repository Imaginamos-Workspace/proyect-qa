/**
 * Tests de las utilidades del scraper. Corren con el runner nativo de Node
 * (sin jest ni vitest — cero dependencias nuevas):
 *
 *   cd apps/backend && npx tsc --noEmit -p tsconfig.json && node --test dist-test/
 *
 * o directamente sobre el fuente con el stripper de tipos de Node 22+:
 *   node --test --experimental-strip-types src/modules/sales/web/*.spec.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeDomain,
  extractRoleEmails,
  extractColombianPhones,
  extractSocialLinks,
} from './scraper.utils';

test('normalizeDomain: colapsa las variantes del mismo sitio', () => {
  const esperado = 'casaluker.com.co';
  for (const entrada of [
    'https://www.casaluker.com.co/contacto',
    'http://CASALUKER.COM.CO',
    'www.casaluker.com.co',
    'casaluker.com.co/',
    'https://casaluker.com.co.',
  ]) {
    assert.equal(normalizeDomain(entrada), esperado, `falló con: ${entrada}`);
  }
});

test('normalizeDomain: respeta los sufijos de segundo nivel', () => {
  // .com.co es sufijo público: el registrable son 3 etiquetas.
  assert.equal(normalizeDomain('tienda.exito.com.co'), 'exito.com.co');
  // .com no lo es: 2 etiquetas.
  assert.equal(normalizeDomain('tienda.exito.com'), 'exito.com');
  assert.equal(normalizeDomain('https://sub.dominio.rappi.com'), 'rappi.com');
});

test('normalizeDomain: rechaza lo que no es una empresa', () => {
  for (const basura of ['', 'localhost', '192.168.0.1', 'sin-punto', 'http://[::1]']) {
    assert.equal(normalizeDomain(basura), null, `debería rechazar: ${basura}`);
  }
});

test('extractRoleEmails: guarda buzones de rol y descarta datos personales', () => {
  const html = `
    contacto@empresa.com.co
    ventas@empresa.com.co
    juan.perez@empresa.com.co
    maria@empresa.com.co
  `;
  const emails = extractRoleEmails(html);
  assert.deepEqual(emails.sort(), ['contacto@empresa.com.co', 'ventas@empresa.com.co']);
  // Habeas Data: los nominales no se persisten.
  assert.ok(!emails.some((e) => e.startsWith('juan')));
  assert.ok(!emails.some((e) => e.startsWith('maria')));
});

test('extractRoleEmails: no confunde assets con correos', () => {
  assert.deepEqual(extractRoleEmails('<img src="logo@2x.png"> sprite@3x.jpg'), []);
});

test('extractColombianPhones: fijos y móviles en los formatos que se ven', () => {
  const texto = `
    Bogotá: (601) 745 8900
    Móvil: +57 310 456 7890
    Medellín: 604-123-4567
    Sin separadores: 3201234567
  `;
  assert.deepEqual(extractColombianPhones(texto).sort(), [
    '+573104567890',  // móvil con +57
    '+573201234567',  // móvil sin separadores
    '+576017458900',  // fijo Bogotá con paréntesis
    '+576041234567',  // fijo Medellín con guiones
  ].sort());
});

test('extractColombianPhones: ignora números que no son telefónicos', () => {
  // NITs, años, precios y celulares de más dígitos no deben colarse.
  assert.deepEqual(extractColombianPhones('NIT 900.123.456-7 · año 2026 · $1.250.000'), []);
  assert.deepEqual(extractColombianPhones('12345678901'), []);
});

test('extractColombianPhones: no matchea dentro de UUIDs ni hashes (regresión real)', () => {
  // Ambos salieron de HTML de producción (colsubsidio.com y alqueria.com.co)
  // y se colaban como teléfonos: dígitos embebidos en un id y en un hash.
  assert.deepEqual(
    extractColombianPhones('"id":"1a4928a5-7bee-4324-adfa-c23805172508","drupal_internal__'),
    [],
  );
  assert.deepEqual(
    extractColombianPhones('f811a16c3578fc70dd45e7b014a3030723815a8a_f4744e52c3.jpg'),
    [],
  );
});

test('extractColombianPhones: solo indicativos realmente asignados', () => {
  // 380 y 333 no son rangos móviles de Colombia; 609 no es un fijo válido.
  assert.deepEqual(extractColombianPhones('380 517 2508'), []);
  assert.deepEqual(extractColombianPhones('333 123 4567'), []);
  assert.deepEqual(extractColombianPhones('609 123 4567'), []);
  // Estos sí: Tigo 300, Claro 320, Movistar 315, fijo Barranquilla 605.
  assert.deepEqual(extractColombianPhones('300 123 4567').length, 1);
  assert.deepEqual(extractColombianPhones('320 123 4567').length, 1);
  assert.deepEqual(extractColombianPhones('315 123 4567').length, 1);
  assert.deepEqual(extractColombianPhones('605 123 4567').length, 1);
});

test('extractColombianPhones: deduplica el mismo número escrito distinto', () => {
  const t = '(601) 745 8900 y +57 601 7458900 y 601-745-8900';
  assert.deepEqual(extractColombianPhones(t), ['+576017458900']);
});

test('extractSocialLinks: toma perfiles y descarta homes de la red', () => {
  const links = extractSocialLinks([
    'https://www.linkedin.com/company/casaluker',
    'https://facebook.com/',           // home sin perfil → fuera
    'https://instagram.com/casaluker',
    'https://twitter.com/casaluker',   // se mapea a 'x'
    'no-es-una-url',
  ]);
  assert.equal(links.linkedin, 'https://www.linkedin.com/company/casaluker');
  assert.equal(links.instagram, 'https://instagram.com/casaluker');
  assert.equal(links.x, 'https://twitter.com/casaluker');
  assert.ok(!('facebook' in links));
});
