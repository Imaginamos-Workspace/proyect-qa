/**
 * Tests del normalizador de búsqueda de Datos Abiertos.
 *
 * El dataset tiene la codificación corrompida en origen, y de forma DESPAREJA:
 * las vocales con tilde están rotas ("BOGOTa", "MEDELLiN") pero la Ñ y la Ü
 * están intactas ("BRICEÑO", "CHACHAGÜi"). Una normalización ingenua que
 * quite todos los diacríticos arregla Bogotá y rompe Briceño.
 *
 * Estos casos salieron de mirar los municipios reales del dataset.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizarBusqueda } from './opendata.service';

test('quita las tildes de vocal, que en el dataset están rotas', () => {
  // El dataset guarda "BOGOTa" y "MEDELLiN": con tilde no matchea nada.
  assert.equal(normalizarBusqueda('Bogotá'), 'Bogota');
  assert.equal(normalizarBusqueda('MEDELLÍN'), 'MEDELLIN');
  assert.equal(normalizarBusqueda('construcción'), 'construccion');
  assert.equal(normalizarBusqueda('logística'), 'logistica');
});

test('CONSERVA la ñ y la ü, que en el dataset sí están bien', () => {
  // "BRICEÑO" y "CAÑASGORDAS" están correctos: quitarles la ñ los rompería.
  assert.equal(normalizarBusqueda('Briceño'), 'Briceño');
  assert.equal(normalizarBusqueda('Cañasgordas'), 'Cañasgordas');
  assert.equal(normalizarBusqueda('Coveñas'), 'Coveñas');
  // La diéresis también sobrevivió en el dataset ("CHACHAGÜi").
  assert.equal(normalizarBusqueda('Chachagüí'), 'Chachagüi');
});

test('tolera espacios de más, puntuación y sufijos administrativos', () => {
  assert.equal(normalizarBusqueda('  Bogotá  '), 'Bogota');
  assert.equal(normalizarBusqueda('Bogotá D.C.'), 'Bogota');
  assert.equal(normalizarBusqueda('Bogota DC'), 'Bogota');
  assert.equal(normalizarBusqueda('BOGOTÁ, D. C.'), 'BOGOTA');
  assert.equal(normalizarBusqueda('Bogotá   Distrito   Capital'), 'Bogota');
  assert.equal(normalizarBusqueda('Santa   Marta'), 'Santa Marta');
});

test('no explota con entradas vacías o raras', () => {
  assert.equal(normalizarBusqueda(''), '');
  assert.equal(normalizarBusqueda('   '), '');
  assert.equal(normalizarBusqueda('...'), '');
  assert.equal(normalizarBusqueda(undefined as unknown as string), '');
  assert.equal(normalizarBusqueda(null as unknown as string), '');
});

test('es idempotente — normalizar dos veces da lo mismo', () => {
  for (const entrada of ['Bogotá D.C.', 'Briceño', 'MEDELLÍN', 'construcción']) {
    const una = normalizarBusqueda(entrada);
    assert.equal(normalizarBusqueda(una), una, `no idempotente con: ${entrada}`);
  }
});

test('el texto ya normalizado pasa sin cambios', () => {
  assert.equal(normalizarBusqueda('Bogota'), 'Bogota');
  assert.equal(normalizarBusqueda('logistica'), 'logistica');
});
