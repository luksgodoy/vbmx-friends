// VbMx Friends — o fundo em mosaico "Compasso" (docs/proposta-ui-modos.md § 9, opção C; mockup em docs/mockup-fundo-mosaico.html).
// Um acento só (azul a 34%) mais neutros, traços finos, e uma máscara opaca atrás de todo bloco (friends.css): o mosaico vive só
// nas calhas. Na batida 1 de cada compasso cada peça dá um passo pequeno, amortecido em 2 batidas, e descansa na outra metade.
// Decorativo (aria-hidden), sem texto: não passa pelo i18n.
//
// O relógio NÃO é duplicado: a batida vem de VbMxFriends.estado() (posição da faixa que toca + grade, VbMxGrade.batidaEm) e o
// BPM é o `bpmSoando`. Aqui só há um integrador suave por cima: fase += dt × BPM/60 × velocidade, puxada devagar (~4 s) para a
// batida do áudio. Mudar o BPM muda a velocidade, nunca a posição — troca de faixa e pausa não dão salto.
//   - pausou ou sem BPM conhecido: a velocidade cai a zero em ~0,35 s e o laço DESLIGA (nenhum quadro, nenhum temporizador);
//     sem BPM conhecido o fundo fica parado até a próxima faixa analisada (decisão padrão, "a confirmar": docs/decisoes.md);
//   - aba oculta (visibilitychange): desliga; prefers-reduced-motion: o laço nunca liga, fica o desenho na fase 0;
//   - custo: um temporizador pede UM quadro por vez (24/s no passo) e dorme na metade de descanso do compasso; só `transform`.
// Teste: node interface/testar-friends-fundo.js (lógica pura) e a prova no Chrome (interface/provar-friends-chrome.js).
//
// VbMxFundo:
//   suave(f) · passoCompasso(fase, pc?) → {k, ponteiro, arcos, triangulo}   o passo por compasso (graus)
//   criarRelogio() → {passo(dt, entrada), fase(), bpmEf(), vel(), parado(), definirFase(f), descansoS(pc)}
//   entradaDoEstado(estado, VbMxGrade) → {tocando, bpm, batida, pc}
//   precisaDeQuadros(entrada, reduzido, oculto) → bool
//   iniciar({el, estado(), janela?, documento?, grade?}) → {avisar(), leitura(), definirFase(f)}
(function (raiz, fabrica) {
  const api = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.VbMxFundo = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (raiz) {
  'use strict';

  const TAU = Math.PI * 2;
  const TAU_BPM = 1.5;      // s: o andamento chega ao BPM novo em ~1,5 s, sem degrau
  const TAU_VEL = 0.35;     // s: pausar freia em ~0,35 s
  const TAU_SYNC = 4;       // s: a fase integrada é puxada para a batida do áudio, devagar
  const PC_PADRAO = 4;
  const GRAUS = { ponteiro: 22.5, arcos: -6, triangulo: 15 };   // por compasso: 1 volta do ponteiro em 16 compassos
  const FPS = 24;           // quadros pedidos por segundo no passo
  const LEITURA_MS = 250;   // a batida do áudio é relida a cada 250 ms; entre uma leitura e outra só o integrador anda
  const SONO_MAX_S = 2;     // o descanso nunca dorme mais que isto sem reler o estado

  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  const suave = (f) => f * f * (3 - 2 * f);
  const passoDe = (pc) => (num(pc) && pc >= 1 ? pc : PC_PADRAO);
  const envolver = (e, pc) => ((((e + pc / 2) % pc) + pc) % pc) - pc / 2;   // o erro de fase, em [-pc/2, pc/2)

  // O passo por compasso: na batida 1 começa, em 2 batidas termina (suave), e as outras metade do compasso descansa. k é contínuo.
  function passoCompasso(fase, pc) {
    const p = passoDe(pc), comp = Math.floor(fase / p), k = comp + suave(Math.min(1, (fase - comp * p) / (p / 2)));
    return { k, ponteiro: k * GRAUS.ponteiro, arcos: k * GRAUS.arcos, triangulo: k * GRAUS.triangulo };
  }

  // Do que o controlador expõe (VbMxFriends.estado()) para o que o relógio precisa. Sem BPM conhecido: bpm e batida nulos.
  function entradaDoEstado(st, G) {
    const a = st && st.atual;
    if (!a) return { tocando: false, bpm: null, batida: null, pc: PC_PADRAO };
    const grade = G && typeof G.daFaixa === 'function' ? G.daFaixa(a.faixa) : null;
    const bpm = num(a.bpmSoando) && a.bpmSoando > 0 ? a.bpmSoando : null;
    return {
      tocando: st.fase === 'tocando', bpm,
      batida: bpm && grade && num(a.posicao) ? G.batidaEm(grade, a.posicao) : null,
      pc: grade ? passoDe(grade.porCompasso) : PC_PADRAO,
    };
  }

  const anda = (e) => !!(e && e.tocando && num(e.bpm) && e.bpm > 0);
  const precisaDeQuadros = (e, reduzido, oculto) => anda(e) && !reduzido && !oculto;

  function criarRelogio() {
    let fase = null, bpmEf = 0, vel = 0;
    return {
      passo(dt, e) {
        const anda1 = anda(e), pc = passoDe(e && e.pc);
        if (!(dt > 0)) return;
        if (anda1 && fase === null) fase = e && num(e.batida) ? e.batida : 0;
        if (anda1) bpmEf = bpmEf > 0 ? bpmEf + (e.bpm - bpmEf) * (1 - Math.exp(-dt / TAU_BPM)) : e.bpm;
        vel += ((anda1 ? 1 : 0) - vel) * (1 - Math.exp(-dt / TAU_VEL));
        if (!anda1 && vel < 0.01) vel = 0;
        if (fase !== null) fase += dt * bpmEf / 60 * vel;
        if (anda1 && num(e.batida) && vel > 0.98) fase += envolver(e.batida - fase, pc) * (1 - Math.exp(-dt / TAU_SYNC));
      },
      fase: () => fase === null ? 0 : fase,
      bpmEf: () => bpmEf,
      vel: () => vel,
      parado: (e) => vel === 0 && !anda(e),
      definirFase(f) { fase = f; },
      // quanto tempo (s) o laço pode dormir: só na metade de descanso do compasso, em regime. 0 = pedir o próximo quadro já.
      descansoS(pc) {
        if (fase === null || vel < 0.98 || !(bpmEf > 0)) return 0;
        const p = passoDe(pc), pos = fase - Math.floor(fase / p) * p;
        return pos >= p / 2 ? (p - pos) / (bpmEf / 60) : 0;
      },
    };
  }

  // ---------- o desenho: SVG puro, uma base parada e quatro peças que dão o passo ----------
  const svg = (vb, s) => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + vb + '" preserveAspectRatio="xMidYMid slice" focusable="false">' + s + '</svg>';
  function xadrez(x, y, col, lin, l, giro) {
    let s = '<g transform="rotate(' + giro + ' ' + x + ' ' + y + ')">';
    for (let i = 0; i < col; i++) for (let j = 0; j < lin; j++) {
      s += '<rect class="' + ((i + j) % 2 ? 'pp' : (i + j) % 4 ? 'pz' : '') + ' tp g1" x="' + (x + i * l) + '" y="' + (y + j * l) + '" width="' + l + '" height="' + l + '"/>';
    }
    return s + '</g>';
  }
  function feixe(x1, y1, x2, y2, n, passo, cls) {
    let s = '';
    const dx = x2 - x1, dy = y2 - y1, c = Math.hypot(dx, dy), nx = -dy / c * passo, ny = dx / c * passo;
    for (let i = 0; i < n; i++) s += '<line class="' + cls + '" x1="' + (x1 + nx * i) + '" y1="' + (y1 + ny * i) + '" x2="' + (x2 + nx * i) + '" y2="' + (y2 + ny * i) + '"/>';
    return s;
  }
  const VB = '0 0 1440 900', VQ = '0 0 200 200';
  const BASE = svg(VB, '<line class="tp g1" x1="-20" y1="250" x2="1460" y2="330"/><line class="tz g3" x1="80" y1="900" x2="620" y2="120"/>' +
    feixe(1020, 900, 1420, 560, 4, 16, 'tp g1') + xadrez(560, 640, 4, 3, 32, -10) + '<line class="tp g1" x1="1000" y1="0" x2="760" y2="900"/>');
  const PECAS = {
    relogio: svg(VQ, '<circle class="tz g3" cx="100" cy="100" r="92"/><circle class="tp g1" cx="100" cy="100" r="70"/><line class="tz g3" x1="100" y1="100" x2="100" y2="8"/><circle class="pz" cx="100" cy="100" r="9" stroke="none"/><line class="tp g1" x1="100" y1="100" x2="100" y2="170"/>'),
    arcos: svg(VQ, '<path class="tp g3" d="M10 100 A90 90 0 0 1 190 100"/><path class="tp g1" d="M34 100 A66 66 0 0 1 166 100"/><path class="tz g1" d="M58 100 A42 42 0 0 1 142 100"/><path class="tp g1" d="M100 190 A90 90 0 0 1 22 145"/>'),
    tri: svg(VQ, '<polygon class="tz g3" points="100,22 182,164 18,164"/>'),
    ponto: svg(VQ, '<circle class="pz" cx="100" cy="100" r="80" stroke="none"/><circle class="tz g1" cx="100" cy="100" r="96"/>'),
  };

  function iniciar(op) {
    const el = op && op.el, estado = op && op.estado;
    if (!el || typeof estado !== 'function') throw new TypeError('VbMxFundo.iniciar: el e estado() são obrigatórios');
    const jan = op.janela || raiz, doc = op.documento || (jan && jan.document), G = op.grade || raiz.VbMxGrade;
    const agora = () => (jan.performance && jan.performance.now ? jan.performance.now() : Date.now());
    el.innerHTML = '<div class="fr-base">' + BASE + '</div>' + Object.keys(PECAS).map((k) => '<div class="fr-peca fr-peca-' + k + '">' + PECAS[k] + '</div>').join('');
    const pecas = { relogio: el.querySelector('.fr-peca-relogio'), arcos: el.querySelector('.fr-peca-arcos'), tri: el.querySelector('.fr-peca-tri') };
    const RM = jan.matchMedia ? jan.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
    const rel = criarRelogio();
    let ent = { tocando: false, bpm: null, batida: null, pc: PC_PADRAO }, ultimaLeitura = -1e9, raf = 0, espera = 0, tAnt = 0, dormiu = false, reduzidoVisto = false, quadros = 0, ultimo = '';

    const oculto = () => !!(doc && doc.hidden);
    function ler() { try { ent = entradaDoEstado(estado(), G); } catch (_) { /* sem estado: fica como estava */ } ultimaLeitura = agora(); }
    function desenhar() {   // metade do compasso é descanso: nada é escrito se o passo não mudou
      const p = passoCompasso(RM.matches ? 0 : rel.fase(), ent.pc);
      const chave = p.ponteiro.toFixed(2) + '|' + p.arcos.toFixed(2) + '|' + p.triangulo.toFixed(2);
      if (chave === ultimo) return false;
      ultimo = chave;
      pecas.relogio.style.transform = 'rotate(' + p.ponteiro.toFixed(2) + 'deg)';
      pecas.arcos.style.transform = 'rotate(' + p.arcos.toFixed(2) + 'deg)';
      pecas.tri.style.transform = 'rotate(' + p.triangulo.toFixed(2) + 'deg)';
      return true;
    }
    function desligar() { if (raf) jan.cancelAnimationFrame(raf); if (espera) jan.clearTimeout(espera); raf = espera = 0; dormiu = false; }
    function agendar() {
      const d = rel.descansoS(ent.pc) * 1000 - 8;
      dormiu = d > 1000 / FPS;
      espera = jan.setTimeout(() => { espera = 0; raf = jan.requestAnimationFrame(quadro); }, dormiu ? Math.min(d, SONO_MAX_S * 1000) : 1000 / FPS);
    }
    function quadro(t) {
      raf = 0;
      const dt = Math.min(dormiu ? SONO_MAX_S + 0.1 : 0.5, Math.max(0, (agora() - tAnt) / 1000)); tAnt = agora();   // o teto de 0,5 s protege de saltos (aba lenta); só o descanso combinado passa dele
      if (agora() - ultimaLeitura >= LEITURA_MS) ler();
      rel.passo(dt, ent);
      if (desenhar()) quadros += 1;
      if (rel.parado(ent) || RM.matches || oculto()) return;   // pausado e parado (ou sem BPM): nenhum quadro, nenhum temporizador
      agendar();
    }
    function ligar() {
      if (raf || espera || RM.matches || oculto()) return;
      ler();
      if (rel.parado(ent)) return;
      tAnt = agora(); raf = jan.requestAnimationFrame(quadro);
    }
    // o controlador mudou (tocar, pausar, trocar de faixa, buscar): acorda o laço, inclusive no meio do descanso
    function avisar() {
      ler();
      if (RM.matches !== reduzidoVisto) { reduzidoVisto = RM.matches; estatico(); }   // a preferência mudou e o 'change' ainda não chegou (Chrome headless): o próximo aviso do controlador alcança
      if (espera) { jan.clearTimeout(espera); espera = 0; raf = jan.requestAnimationFrame(quadro); return; }
      ligar();
    }
    function estatico() { reduzidoVisto = RM.matches; desligar(); if (RM.matches) rel.definirFase(0); ultimo = ''; desenhar(); }

    if (doc) doc.addEventListener('visibilitychange', () => { if (oculto()) desligar(); else ligar(); });
    if (RM.addEventListener) RM.addEventListener('change', () => { estatico(); ligar(); });
    estatico(); ligar();

    const api = {
      avisar,
      // a fase "de agora" (projetada desde o último quadro, que pode estar dormindo) para a prova no Chrome (não é API do Friends)
      leitura: () => ({ fase: rel.fase() + (raf || espera ? Math.max(0, agora() - tAnt) / 1000 * rel.bpmEf() / 60 * rel.vel() : 0), bpmEf: rel.bpmEf(), vel: rel.vel(), quadros, batida: ent.batida, rodando: !!(raf || espera), reduzido: !!RM.matches, oculto: oculto() }),
      definirFase(f) { rel.definirFase(f); ultimo = ''; desenhar(); },
    };
    exportado.atual = api;   // só para a prova no Chrome ler o relógio e fixar a fase
    return api;
  }

  const exportado = { TAU, GRAUS, FPS, suave, passoCompasso, entradaDoEstado, precisaDeQuadros, criarRelogio, iniciar, atual: null };
  return exportado;
});
