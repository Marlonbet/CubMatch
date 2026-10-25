// v1.12.1: tope de relevo diferenciado voz/video (punto 3 de la cola).
// - Dos cubetas mensuales separadas: voz 20 min, video 5 min.
// - Gastar una no toca la otra; un medio sin 'video' cuenta como voz.
// - Textos por medio (aviso, corte y restante en Ajustes), sin jerga.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LIMITE_RELEVO_MS, LIMITE_RELEVO_VIDEO_MS, limiteParaMedia,
  mesClave, conUso, restanteMs, agotado, minutosRestantes, textoRestanteMedia,
  avisoLimite, corteLimite,
  TEXTO_LIMITE_EXPL, TEXTO_LIMITE_AVISO, TEXTO_LIMITE_AVISO_VIDEO,
  TEXTO_LIMITE_CORTE, TEXTO_LIMITE_CORTE_VIDEO,
} from '../src/tiempollamadas.js';

const OCT15 = new Date(2026, 9, 15, 12, 0, 0).getTime(); // 2026-10 local

test('límites diferenciados: voz 20 min, video 5 min, y lo demás es voz', () => {
  assert.equal(LIMITE_RELEVO_MS, 20 * 60 * 1000);
  assert.equal(LIMITE_RELEVO_VIDEO_MS, 5 * 60 * 1000);
  assert.equal(limiteParaMedia('audio'), LIMITE_RELEVO_MS);
  assert.equal(limiteParaMedia('video'), LIMITE_RELEVO_VIDEO_MS);
  assert.equal(limiteParaMedia(undefined), LIMITE_RELEVO_MS, 'sin medio no bloquea: cuenta como voz');
  assert.equal(limiteParaMedia('basura'), LIMITE_RELEVO_MS);
});

test('una cubeta de video llena no agota la de voz, y viceversa', () => {
  const cincoMinVideo = { mes: '2026-10', ms: 5 * 60000 };
  assert.equal(agotado(cincoMinVideo, OCT15, limiteParaMedia('video')), true, '5 min agotan el video');
  assert.equal(agotado(cincoMinVideo, OCT15, limiteParaMedia('audio')), false, '5 min no agotan la voz');
  const veinteMinVoz = { mes: '2026-10', ms: 20 * 60000 };
  assert.equal(agotado(veinteMinVoz, OCT15, limiteParaMedia('audio')), true);
  assert.equal(agotado(veinteMinVoz, OCT15, limiteParaMedia('video')), true, '20 min también superan el tope de video');
  assert.equal(restanteMs(cincoMinVideo, OCT15, limiteParaMedia('video')), 0);
  assert.equal(minutosRestantes({ mes: '2026-10', ms: 4 * 60000 + 30000 }, OCT15, limiteParaMedia('video')), 1, 'medio minuto de video = 1 min restante');
});

test('textoRestanteMedia: frase propia por medio, con su límite', () => {
  assert.equal(textoRestanteMedia(null, OCT15, 'audio'), 'Te quedan 20 min de llamadas de voz este mes');
  assert.equal(textoRestanteMedia(null, OCT15, 'video'), 'Te quedan 5 min de videollamadas este mes');
  assert.equal(textoRestanteMedia({ mes: '2026-10', ms: 3 * 60000 }, OCT15, 'video'), 'Te quedan 2 min de videollamadas este mes');
  assert.equal(textoRestanteMedia({ mes: '2026-10', ms: 20 * 60000 }, OCT15, 'audio'), 'Ya no te quedan minutos de llamadas de voz este mes');
  assert.equal(textoRestanteMedia({ mes: '2026-10', ms: 5 * 60000 }, OCT15, 'video'), 'Ya no te quedan minutos de videollamadas este mes');
});

test('aviso y corte por medio: el video nombra sus 5 minutos', () => {
  assert.equal(avisoLimite('audio'), TEXTO_LIMITE_AVISO);
  assert.equal(corteLimite('audio'), TEXTO_LIMITE_CORTE);
  assert.equal(avisoLimite('video'), TEXTO_LIMITE_AVISO_VIDEO);
  assert.equal(corteLimite('video'), TEXTO_LIMITE_CORTE_VIDEO);
  assert.match(TEXTO_LIMITE_AVISO_VIDEO, /5 minutos de videollamadas/);
  assert.match(TEXTO_LIMITE_CORTE_VIDEO, /5 minutos de videollamadas/);
  assert.match(TEXTO_LIMITE_CORTE_VIDEO, /se renuevan el día 1/);
  for (const t of [TEXTO_LIMITE_AVISO_VIDEO, TEXTO_LIMITE_CORTE_VIDEO]) {
    assert.ok(!/TURN|CGNAT|\bICE\b|STUN/.test(t), 'sin jerga: ' + t);
  }
});

test('explicación conjunta: nombra los dos topes y el porqué del menor', () => {
  assert.match(TEXTO_LIMITE_EXPL, /20 minutos de voz/);
  assert.match(TEXTO_LIMITE_EXPL, /5 minutos de videollamadas/);
  assert.match(TEXTO_LIMITE_EXPL, /se renueva el día 1/);
  assert.match(TEXTO_LIMITE_EXPL, /WiFi/);
  assert.ok(!/TURN|CGNAT|\bICE\b|STUN/.test(TEXTO_LIMITE_EXPL), 'sin jerga');
});

test('mes nuevo: ambas cubetas renacen de cero', () => {
  const NOV01 = new Date(2026, 10, 1, 0, 30, 0).getTime();
  const regVoz = conUso({ mes: '2026-10', ms: 20 * 60000 }, 60000, NOV01);
  assert.deepEqual(regVoz, { mes: '2026-11', ms: 60000 });
  assert.equal(agotado({ mes: '2026-10', ms: 5 * 60000 }, NOV01, limiteParaMedia('video')), false);
  assert.equal(mesClave(NOV01), '2026-11');
});
