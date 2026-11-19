// VbMx Friends — a forma de onda da faixa que toca. Sem DOM: calcula os picos do áudio já decodificado, guarda em
// cache e desenha num contexto 2D que a tela entrega (interface/modos/friends-tela.js).
//
// Os picos saem UMA vez por faixa (cache por chave, a promessa em curso é reaproveitada) e em FATIAS: a cada
// AMOSTRAS_POR_FATIA amostras o cálculo devolve o controle (MessageChannel, que não é estrangulado em aba de 2º
// plano como o setTimeout), então nem a tela nem o laço do automix esperam a faixa inteira. O áudio roda na
// thread do Web Audio e não depende disso. A redução para a largura da tela é a de motor/waveform.js (`reduzir`).
// Contrato: docs/contratos.md § Friends: forma de onda. Teste: node interface/testar-friends-tracksave.js.
//
// VbMxFriendsOnda:
//   calcularPicos(buffer, {porSeg?, amostrasPorFatia?, ceder?}) → Promise<{min, max, porSeg, duracao, pico, fatias}>
//   criarCache(maximo?) → {pedir(chave, buffer, opcoes?) → Promise<picos>, pronto(chave) → picos|null, tamanho()}
//   marcas(agora, largura) → {cabeca, mixIni, mixFim, mixFeito}   (px; null no que não existe)
//   tempoDaPosicao(x, largura, duracao) → s da faixa    px na barra/onda → tempo (limitado a 0…duracao); posicaoDoTempo faz o inverso
//   passoDeTeclado(tecla, valor, {duracao, fim?, passo?}) → s|null   setas ±5 s, Home = 0, End = fim (padrão duracao); outra tecla: null
//   formatarTempo(s) → 'm:ss'
//   desenhar(g, picos, marcas, {largura, altura, cores?, metade?}) → nº de colunas desenhadas
(function (raiz, fabrica) {
  const W = raiz.VbMxWaveform || (typeof require === 'function' ? require('../../motor/waveform.js') : null);
  const api = fabrica(W);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.VbMxFriendsOnda = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (W) {
  'use strict';

  const PICOS_POR_SEG = 50;            // 6 min → 18 mil pares min/max; a tela reduz para a largura dela
  const AMOSTRAS_POR_FATIA = 1 << 18;  // ~6 s de áudio por fatia (poucos ms de CPU)
  const MAX_CACHE = 6;                 // a que toca, a próxima e as últimas
  const CORES = { tocado: '#f2b134', resto: '#5f6875', mix: '#7ad48c', cabeca: '#ffffff', fundoMix: 'rgba(122, 212, 140, 0.16)', feitoMix: 'rgba(122, 212, 140, 0.34)' };
  const num = (x) => typeof x === 'number' && Number.isFinite(x);

  function cederPadrao() {
    return new Promise((ok) => {
      if (typeof MessageChannel === 'function') {
        const c = new MessageChannel();
        c.port1.onmessage = () => { c.port1.close(); ok(); };
        c.port2.postMessage(0);
      } else setTimeout(ok, 0);
    });
  }

  // buffer: AudioBuffer (ou parecido: length, sampleRate, numberOfChannels, getChannelData). Cada amostra é a média
  // dos canais, como em motor/waveform.js.
  async function calcularPicos(buffer, opcoes) {
    const o = opcoes || {};
    const pps = num(o.porSeg) && o.porSeg > 0 ? o.porSeg : PICOS_POR_SEG;
    const fatia = num(o.amostrasPorFatia) && o.amostrasPorFatia > 0 ? o.amostrasPorFatia : AMOSTRAS_POR_FATIA;
    const ceder = typeof o.ceder === 'function' ? o.ceder : cederPadrao;
    const n = buffer ? buffer.length : 0, taxa = buffer ? buffer.sampleRate : 0, nc = buffer ? buffer.numberOfChannels : 0;
    if (!(n > 0) || !(taxa > 0) || !(nc > 0)) return { min: new Float32Array(0), max: new Float32Array(0), porSeg: pps, duracao: 0, pico: 0, fatias: 0 };
    const canais = [];
    for (let c = 0; c < nc; c++) canais.push(buffer.getChannelData(c));
    const passo = taxa / pps, cols = Math.ceil(n / passo);
    const min = new Float32Array(cols), max = new Float32Array(cols);
    const c0 = canais[0], c1 = nc > 1 ? canais[1] : null;
    let pico = 0, fatias = 0, desde = 0;
    for (let col = 0; col < cols; col++) {
      const a = Math.floor(col * passo), b = Math.min(n, Math.max(a + 1, Math.floor((col + 1) * passo)));
      let lo = Infinity, hi = -Infinity;
      if (nc === 1) for (let i = a; i < b; i++) { const v = c0[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      else if (nc === 2) for (let i = a; i < b; i++) { const v = (c0[i] + c1[i]) * 0.5; if (v < lo) lo = v; if (v > hi) hi = v; }
      else for (let i = a; i < b; i++) { let v = 0; for (let c = 0; c < nc; c++) v += canais[c][i]; v /= nc; if (v < lo) lo = v; if (v > hi) hi = v; }
      if (lo === Infinity) { lo = 0; hi = 0; }
      min[col] = lo; max[col] = hi;
      const m = Math.max(-lo, hi); if (m > pico) pico = m;
      desde += b - a;
      if (desde >= fatia && col < cols - 1) { desde = 0; fatias += 1; await ceder(); }
    }
    return { min, max, porSeg: pps, duracao: n / taxa, pico, fatias };
  }

  // Uma conta por faixa: a 2ª chamada com a mesma chave devolve a MESMA promessa (em curso ou pronta).
  function criarCache(maximo) {
    const max = num(maximo) && maximo > 0 ? maximo : MAX_CACHE;
    const mapa = new Map();   // chave → {promessa, picos}
    function pedir(chave, buffer, opcoes) {
      const k = String(chave);
      const tem = mapa.get(k);
      if (tem) { mapa.delete(k); mapa.set(k, tem); return tem.promessa; }   // usada agora: vai para o fim da fila
      const reg = { promessa: null, picos: null };
      reg.promessa = calcularPicos(buffer, opcoes).then((p) => { reg.picos = p; return p; }, (e) => { if (mapa.get(k) === reg) mapa.delete(k); throw e; });
      mapa.set(k, reg);
      while (mapa.size > max) mapa.delete(mapa.keys().next().value);
      return reg.promessa;
    }
    const pronto = (chave) => { const r = mapa.get(String(chave)); return r && r.picos ? r.picos : null; };
    return { pedir, pronto, tamanho: () => mapa.size };
  }

  // agora: {duracao, posicao, taxa, plano?: {inicioMix, duracaoMix}, mixando?, progresso?} (o `atual` e o `plano` de
  // VbMxFriends.estado(), que vem de VbMxAutomix.planejarTransicao). inicioMix é posição na faixa (s); duracaoMix é
  // de relógio, então na faixa o cruzamento ocupa duracaoMix × taxa.
  function marcas(agora, largura) {
    const vazio = { cabeca: null, mixIni: null, mixFim: null, mixFeito: null };
    const a = agora || {}, w = num(largura) && largura > 0 ? largura : 0;
    if (!(a.duracao > 0) || !w) return vazio;
    const px = (t) => Math.max(0, Math.min(w, (t / a.duracao) * w));
    const taxa = num(a.taxa) && a.taxa > 0 ? a.taxa : 1;
    const m = { cabeca: px(num(a.posicao) ? a.posicao : 0), mixIni: null, mixFim: null, mixFeito: null };
    const p = a.plano;
    if (p && num(p.inicioMix)) {
      m.mixIni = px(p.inicioMix);
      m.mixFim = px(p.inicioMix + (num(p.duracaoMix) ? p.duracaoMix : 0) * taxa);
      if (a.mixando) m.mixFeito = m.mixIni + (m.mixFim - m.mixIni) * Math.max(0, Math.min(1, num(a.progresso) ? a.progresso : 0));
    }
    return m;
  }

  // Conversão posição ↔ tempo do arrasto: a barra e a onda têm a mesma largura e a faixa inteira cabe nela.
  function tempoDaPosicao(x, largura, duracao) {
    if (!(num(x) && num(largura) && largura > 0 && num(duracao) && duracao > 0)) return 0;
    return Math.max(0, Math.min(duracao, (x / largura) * duracao));
  }
  function posicaoDoTempo(t, largura, duracao) {
    if (!(num(t) && num(largura) && largura > 0 && num(duracao) && duracao > 0)) return 0;
    return Math.max(0, Math.min(largura, (t / duracao) * largura));
  }
  // Teclado do slider de busca. fim: o último valor válido (a faixa menos a margem de fim).
  function passoDeTeclado(tecla, valor, o) {
    const op = o || {}, dur = num(op.duracao) ? op.duracao : 0, passo = num(op.passo) && op.passo > 0 ? op.passo : 5;
    const fim = num(op.fim) ? Math.min(op.fim, dur) : dur, v = num(valor) ? valor : 0;
    const lim = (x) => Math.max(0, Math.min(fim, x));
    switch (tecla) {
      case 'ArrowLeft': case 'ArrowDown': return lim(v - passo);
      case 'ArrowRight': case 'ArrowUp': return lim(v + passo);
      case 'Home': return 0;
      case 'End': return lim(fim);
      default: return null;
    }
  }
  function formatarTempo(s) {
    if (!(num(s) && s >= 0)) return '—';
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  }

  const reduzidos = typeof WeakMap === 'function' ? new WeakMap() : null;   // picos → {largura, r}: reduz uma vez por largura
  function reduzir(picos, largura) {
    const tem = reduzidos && reduzidos.get(picos);
    if (tem && tem.largura === largura) return tem.r;
    const r = W.reduzir({ min: picos.min, max: picos.max }, largura);
    if (reduzidos) reduzidos.set(picos, { largura, r });
    return r;
  }

  // g: CanvasRenderingContext2D (ou falso com fillRect/clearRect/fillStyle). Largura e altura em pixels do canvas.
  function desenhar(g, picos, m, opcoes) {
    const o = opcoes || {}, w = Math.max(0, Math.floor(o.largura || 0)), h = Math.max(0, Math.floor(o.altura || 0));
    const cor = Object.assign({}, CORES, o.cores || {});
    const mk = m || {};
    g.clearRect(0, 0, w, h);
    if (!w || !h) return 0;
    const meio = h / 2;
    if (mk.mixIni !== null && mk.mixIni !== undefined && mk.mixFim > mk.mixIni) {
      g.fillStyle = cor.fundoMix; g.fillRect(mk.mixIni, 0, mk.mixFim - mk.mixIni, h);
      if (mk.mixFeito > mk.mixIni) { g.fillStyle = cor.feitoMix; g.fillRect(mk.mixIni, 0, mk.mixFeito - mk.mixIni, h); }
    }
    let colunas = 0;
    if (picos && picos.min && picos.min.length) {
      const r = reduzir(picos, w), norma = picos.pico > 0 ? picos.pico : 1;
      const corte = mk.cabeca === null || mk.cabeca === undefined ? 0 : Math.floor(mk.cabeca);
      for (const [de, ate, estilo] of [[0, Math.min(w, corte), cor.tocado], [Math.min(w, corte), w, cor.resto]]) {
        g.fillStyle = estilo;
        for (let x = de; x < ate; x++) {
          const amp = Math.min(1, Math.max(-r.min[x], r.max[x]) / norma);
          if (o.metade) { const alt = Math.max(1, amp * (meio - 1)); g.fillRect(x, meio - alt, 1, alt); }   // só o lado de cima, sem espelho
          else { const alt = Math.max(1, amp * (h - 2)); g.fillRect(x, meio - alt / 2, 1, alt); }
          colunas += 1;
        }
      }
    } else { g.fillStyle = cor.resto; g.fillRect(0, o.metade ? Math.floor(meio) - 1 : Math.floor(meio), w, 1); }   // sem picos (ainda calculando, ou sem faixa): linha
    const tr = Math.max(2, Math.round(w / 480));
    if (mk.mixIni !== null && mk.mixIni !== undefined) { g.fillStyle = cor.mix; g.fillRect(Math.min(w - tr, mk.mixIni), 0, tr, h); }
    if (mk.cabeca !== null && mk.cabeca !== undefined) { g.fillStyle = cor.cabeca; g.fillRect(Math.min(w - tr, mk.cabeca), 0, tr, h); }
    return colunas;
  }

  return { PICOS_POR_SEG, AMOSTRAS_POR_FATIA, MAX_CACHE, CORES, calcularPicos, criarCache, marcas, tempoDaPosicao, posicaoDoTempo, passoDeTeclado, formatarTempo, desenhar };
});
