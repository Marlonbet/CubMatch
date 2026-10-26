// Tests de la minificación de CSS (v1.12.2, punto 4: ligereza de datos).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { minificarCss } from '../tools/mincss.mjs';

test('minificarCss: quita comentarios y espacios sin tocar reglas', () => {
  const out = minificarCss('/* hola */ .a { color: red; margin: 0 8px; } .b{padding: 4px;}');
  assert.equal(out, '.a{color:red;margin:0 8px}.b{padding:4px}');
});

test('minificarCss: las cadenas se copian tal cual', () => {
  const out = minificarCss('.a{font-family: "Segoe UI", Roboto; content: "";}');
  assert.ok(out.includes('"Segoe UI"'), out);
  assert.ok(out.includes('content:""'), out);
});

test('minificarCss: calc() conserva los espacios de + y -', () => {
  const out = minificarCss('.a{height: calc(100vh - var(--nav-total)); width: calc(10px + 2em);}');
  assert.ok(out.includes('calc(100vh - var(--nav-total))'), out);
  assert.ok(out.includes('calc(10px + 2em)'), out);
});

test('minificarCss: el espacio antes de : en selectores no se toca', () => {
  const out = minificarCss('.a :hover { color: red; }');
  assert.ok(out.includes('.a :hover'), out);
});

test('minificarCss: áreas de grid entre comillas quedan separadas', () => {
  const out = minificarCss('.a{grid-template-areas: "brand logobig" "btns hero";}');
  assert.ok(out.includes('"brand logobig" "btns hero"'), out);
});

test('minificarCss: styles.css real pierde peso sin perder reglas', () => {
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  const min = minificarCss(css);
  assert.ok(!min.includes('/*'), 'no deben quedar comentarios');
  assert.ok(min.length < css.length * 0.85, `esperaba <85%: ${min.length} de ${css.length}`);
  const reglas = (s) => (s.match(/{/g) || []).length;
  assert.equal(reglas(min), reglas(css), 'el nº de reglas no debe cambiar');
  for (const clave of ['"Segoe UI"', 'calc(100vh - var(--nav-total))', '.tabnav', '@media (max-width:360px)']) {
    assert.ok(min.includes(clave), `falta en el CSS minificado: ${clave}`);
  }
});
