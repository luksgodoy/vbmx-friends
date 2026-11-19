// VbMx Friends — a tela (interface/friends.html). Monta o áudio mínimo no 1º clique (AudioContext → ganho de
// cada deck → volume → saída: sem stems, sem efeitos, sem cadeia), liga o VbMxPainel (pastas, análise e cache,
// os mesmos do Profissional) ao controlador VbMxFriends e desenha. Quem decide e mixa é o controlador
// (interface/modos/friends.js) e o motor (motor/automix.js); aqui só há DOM. É o último script da página.
(function () {
  'use strict';
  if (typeof document === 'undefined' || !document.getElementById('fr-tocar')) return;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // texto e formatos pelo idioma escolhido (interface/js/i18n.js): t() com parâmetros, nunca frase concatenada
  const I = window.VbMxI18n, t = I.t, mmss = I.tempo, br = I.numero;
  const trm = (txt) => (window.VbMxMsg ? window.VbMxMsg.traduzir(txt) : txt);   // mensagens do motor (js/msg-motor.js)
  const ler = (k, padrao) => { try { const v = localStorage.getItem(k); return v === null ? padrao : v; } catch (e) { return padrao; } };
  const gravar = (k, v) => { try { localStorage.setItem(k, String(v)); } catch (e) { /* sem localStorage: vale só agora */ } };

  // Cores da onda na paleta noturna (opção C, modos/bauhaus.css): já tocado azul claro, o que falta cinza, a marca da
  // mixagem em amarelo e a cabeça em papel; traços translúcidos e só a metade de cima (a capa aparece por trás). VbMxFriendsOnda.CORES continua sendo o padrão do módulo.
  const CORES_ONDA = { tocado: 'rgba(110, 155, 230, 0.6)', resto: 'rgba(125, 120, 105, 0.5)', mix: '#f2b90f', cabeca: '#f2ebdd', fundoMix: 'rgba(242, 185, 15, 0.16)', feitoMix: 'rgba(242, 185, 15, 0.34)' };
  const raiz = document.querySelector('.friends');
  const FRASES_FASE = ['vazio', 'parado', 'carregando', 'tocando', 'pausado', 'mixando'];
  let faseAnunciada = '';   // o que o leitor de tela já ouviu (estadoVisual)
  let ctx = null, volume = null;
  const ondas = VbMxFriendsOnda.criarCache();
  const chaveOnda = (f) => String(f.caminho || f.id);
  let ondaChave = '';   // o que está desenhado no canvas: só redesenha quando isto muda
  const tocavel = (f) => VbMxMotor.faixaValida(f) && f.analisavel !== false;
  const saidas = {};
  let faixas = [];
  let volumeAtual = Math.max(0, Math.min(100, Number(ler('vbmx-friends-volume', 80)) || 0));

  function garantirAudio() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC({ latencyHint: 'playback' });   // tocar sem mexer: latência maior, menos estalo
    volume = ctx.createGain(); volume.gain.value = (volumeAtual / 100) ** 2; volume.connect(ctx.destination);
    for (const l of ['A', 'B']) { const g = ctx.createGain(); g.gain.value = 0; g.connect(volume); saidas[l] = g; }
    VbMxTocador.configurar({ ctx, destino: (l) => saidas[l], aoTerminar: (l) => ctl.aoTerminar(l) });
    return ctx;
  }

  let ts = null;   // o fluxo do plugin TrackSave (nulo fora de localhost)
  // ---- capa ao fundo do "tocando agora" (modos/friends-capa.js): a padrão já, a de verdade quando chegar ----
  const PESQUISA_CHAVE = 'vbmx-friends-capa-pesquisa';   // '1' | '0'; padrão ligado, mas só vale com o TrackSave no ar
  const tsAtivo = () => !!(ts && ts.estado().noAr);
  const capas = VbMxCapa.criar({
    onde: VbMxTrackSave.ondeEstou(window.location), tsAtivo,
    pesquisaLigada: () => ler(PESQUISA_CHAVE, '1') === '1',
    aoMudar: (c) => { const im = $('agora-capa'); if (im.getAttribute('src') !== c.url) im.src = c.url; im.dataset.origem = c.origem; },
  });
  $('agora-capa').src = VbMxCapa.CAPA_PADRAO; $('agora-capa').dataset.origem = 'padrao';
  // a faixa a seguir tem a capa dela, mesmo tratamento: outra instância (cache próprio), mesma cadeia arquivo → TrackSave → padrão
  const capasSeguir = VbMxCapa.criar({
    onde: VbMxTrackSave.ondeEstou(window.location), tsAtivo,
    pesquisaLigada: () => ler(PESQUISA_CHAVE, '1') === '1',
    aoMudar: (c) => { const im = $('seguir-capa'); if (im.getAttribute('src') !== c.url) im.src = c.url; im.dataset.origem = c.origem; },
  });
  $('seguir-capa').src = VbMxCapa.CAPA_PADRAO; $('seguir-capa').dataset.origem = 'padrao';

  // escolha salva: a nova em compassos; se só há a antiga em s (10…30), migra para o compasso mais próximo (a 128 BPM) e grava a nova
  const compassosIniciais = VbMxAutomix.compassosSalvos(ler('vbmx-friends-compassos', null), ler('vbmx-friends-duracao', null));
  gravar('vbmx-friends-compassos', compassosIniciais);
  // formato da curva do crossfader, lembrado entre sessões em 'vbmx-friends-formato' (inválido = linear)
  // + os pontos do personalizado em 'vbmx-friends-curva' (JSON {t1,g1,t2,g2}); ausente ou corrompido = sem pontos, e o personalizado cai no linear
  const A = VbMxAutomix;
  const paramsIniciais = (() => { try { return A.normalizarParams(JSON.parse(ler('vbmx-friends-curva', 'null'))); } catch (e) { return null; } })();
  let formatoInicial = A.formatoValido(ler('vbmx-friends-formato', null));
  if (formatoInicial === A.PERSONALIZADO && !paramsIniciais) formatoInicial = A.FORMATO_PADRAO;
  let fundo = null;   // o fundo em mosaico nasce logo depois do controlador (aoMudar pode chamar desenhar antes)
  const ctl = VbMxFriends.criar({
    tocador: VbMxTocador,
    saida: (l) => saidas[l],
    decodificar: async (f) => {
      const arq = await f.obter();
      const buf = await garantirAudio().decodeAudioData(await arq.arrayBuffer());
      // picos da onda: uma vez por faixa, em fatias, sem segurar o deck (quem espera o decodificar não espera isto)
      ondas.pedir(chaveOnda(f), buf).then(() => { ondaChave = ''; }, () => { /* sem onda: fica a linha */ });
      return buf;
    },
    aoMudar: () => desenhar(),
    compassos: compassosIniciais,
    formato: formatoInicial,
    params: paramsIniciais,
  });
  fundo = VbMxFundo.iniciar({ el: $('fr-fundo'), estado: () => ctl.estado() });

  // duração da transição: 4/8/16/32/64 compassos, lembrada em 'vbmx-friends-compassos'; o valor real do plano aparece em "A seguir"
  function marcarDuracao(c) {
    for (const b of document.querySelectorAll('#fr-duracao .fr-seg')) b.setAttribute('aria-checked', Number(b.dataset.c) === c ? 'true' : 'false');
  }
  marcarDuracao(compassosIniciais);
  $('fr-duracao').onclick = (e) => {
    const b = e.target.closest && e.target.closest('.fr-seg');
    if (!b) return;
    const c = VbMxAutomix.compassosValidos(b.dataset.c);
    gravar('vbmx-friends-compassos', c); marcarDuracao(c); ctl.definirCompassos(c);
  };

  // desenho das curvas a partir de VbMxAutomix.curvaGanho (a mesma função do áudio). Miniatura 40×24; o X grande 200×60 com platôs de 20%.
  function caminho(formato, lado, x0, x1, yTopo, yBase, fio, params) {
    const pn = formato === A.PERSONALIZADO ? A.normalizarParams(params) : null;
    const n = formato === 'degrau' ? 100 : 40, y = (g) => (yBase - (yBase - yTopo) * g).toFixed(1), pts = [];
    const ts = []; for (let i = 0; i <= n; i++) ts.push(i / n);
    if (pn) ts.push(pn.t1, pn.t2, 1 - pn.t1, 1 - pn.t2);   // os vértices exatos: o ponto arrastável fica em cima da curva
    ts.sort((a, b) => a - b);
    for (const u of ts) pts.push(`${(x0 + (x1 - x0) * u).toFixed(1)} ${y(A.curvaGanho(formato, u, params)[lado])}`);
    const g0 = A.curvaGanho(formato, 0, params)[lado], g1 = A.curvaGanho(formato, 1, params)[lado];
    return `M${fio[0]} ${y(g0)}${fio[0] === x0 ? '' : ` H${x0}`} L${pts.join(' L')}${fio[1] === x1 ? '' : ` H${fio[1]}`}`;
  }
  // pontos do personalizado: o que está guardado (ou a reta, se nunca ajustou); ativos (cheios) só com o personalizado escolhido
  const PONTOS = [$('fr-pt-1'), $('fr-pt-2')];
  const chaveParams = (p) => (p ? `${p.t1.toFixed(3)},${p.g1.toFixed(3)},${p.t2.toFixed(3)},${p.g2.toFixed(3)}` : 'x');
  function desenharFormato(st) {
    const f = st.formatoMix, pm = st.paramsMix, pg = st.params || A.PARAMS_LINEAR;
    for (const b of document.querySelectorAll('#fr-formato .fr-fmt')) {
      const k = b.dataset.f;
      b.setAttribute('aria-checked', k === st.formato ? 'true' : 'false');
      b.disabled = st.mixando;
      const chave = k === A.PERSONALIZADO ? chaveParams(pg) : '1';
      if (b.dataset.d !== chave) {
        b.dataset.d = chave;
        b.querySelector('.sai').setAttribute('d', caminho(k, 'saindo', 2, 38, 4, 20, [2, 38], pg));
        b.querySelector('.entra').setAttribute('d', caminho(k, 'entrando', 2, 38, 4, 20, [2, 38], pg));
      }
    }
    const cx = f + '|' + (f === A.PERSONALIZADO ? chaveParams(pm) : '');
    if (raiz.dataset.formatoX !== cx) {
      raiz.dataset.formatoX = cx;
      const sv = $('fr-x').querySelector('svg');
      sv.querySelector('.sai').setAttribute('d', caminho(f, 'saindo', 40, 160, 8, 52, [0, 200], pm));
      sv.querySelector('.entra').setAttribute('d', caminho(f, 'entrando', 40, 160, 8, 52, [0, 200], pm));
    }
    PONTOS.forEach((el, i) => {
      const tt = i ? pg.t2 : pg.t1, gg = i ? pg.g2 : pg.g1, pct = (v) => Math.round(v * 100);
      el.style.left = `${(20 + 60 * tt).toFixed(2)}%`; el.style.top = `${((52 - 44 * gg) / 60 * 100).toFixed(2)}%`;
      el.setAttribute('aria-valuenow', String(pct(tt)));
      el.setAttribute('aria-valuetext', t('friends.curva.ponto.valor', { t: pct(tt), g: pct(gg) }));
      el.setAttribute('aria-disabled', st.mixando ? 'true' : 'false');
      el.dataset.ativo = st.formatoMix === A.PERSONALIZADO ? '1' : '0';
    });
    $('fr-curva-info').textContent = t('friends.curva.info', { ini: Math.round(pg.t1 * 100), fim: Math.round(pg.t2 * 100), pot: Math.round(A.resumoPotencia(A.PERSONALIZADO, pg).min * 100) });
  }
  $('fr-formato').onclick = (e) => {
    const b = e.target.closest && e.target.closest('.fr-fmt');
    if (!b || b.disabled) return;
    const f = A.formatoValido(b.dataset.f);
    if (ctl.definirFormato(f)) gravar('vbmx-friends-formato', ctl.estado().formato);
  };
  // arrastar/teclar um ponto: liga o personalizado (A.moverPonto limita o ponto para nunca cruzar nem inverter) e lembra os pontos
  function aplicarPonto(qual, tt, gg) {
    const p = A.moverPonto(ctl.estado().params, qual, tt, gg);
    if (ctl.definirCurva(p)) { gravar('vbmx-friends-curva', JSON.stringify(ctl.estado().params)); gravar('vbmx-friends-formato', A.PERSONALIZADO); }
  }
  function voltarLinear() {
    if (ctl.estado().mixando) return;
    ctl.definirCurva(A.PARAMS_LINEAR); ctl.definirFormato('linear');
    gravar('vbmx-friends-curva', JSON.stringify(ctl.estado().params)); gravar('vbmx-friends-formato', 'linear');
  }
  PONTOS.forEach((el, i) => {
    const qual = i + 1;
    let arrastando = false;
    const do_evento = (e) => {   // posição do dedo/mouse → (t, g) no desenho do X (platôs de 20% de cada lado, 8…52 de 60)
      const r = $('fr-x').getBoundingClientRect();
      return [((e.clientX - r.left) / r.width * 200 - 40) / 120, (52 - (e.clientY - r.top) / r.height * 60) / 44];
    };
    el.addEventListener('pointerdown', (e) => {
      if (ctl.estado().mixando || (e.button != null && e.button > 0)) return;
      arrastando = true; try { el.setPointerCapture(e.pointerId); } catch (x) { /* sem captura: o mouse sai do alvo e perde o arrasto */ }
      el.focus(); e.preventDefault();
      aplicarPonto(qual, ...do_evento(e));
    });
    el.addEventListener('pointermove', (e) => { if (arrastando) aplicarPonto(qual, ...do_evento(e)); });
    const soltar = () => { arrastando = false; };
    el.addEventListener('pointerup', soltar); el.addEventListener('pointercancel', soltar);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Home' || e.key === 'Escape') { e.preventDefault(); voltarLinear(); return; }
      const passo = e.shiftKey ? 0.1 : 0.02, d = { ArrowLeft: [-passo, 0], ArrowRight: [passo, 0], ArrowDown: [0, -passo], ArrowUp: [0, passo] }[e.key];
      if (!d || ctl.estado().mixando) return;
      e.preventDefault();
      const pg = ctl.estado().params || A.PARAMS_LINEAR;
      aplicarPonto(qual, (qual === 2 ? pg.t2 : pg.t1) + d[0], (qual === 2 ? pg.g2 : pg.g1) + d[1]);
    });
  });

  $('fr-shuffle').checked = ler('vbmx-friends-shuffle', '1') === '1';
  ctl.definirShuffle($('fr-shuffle').checked);
  $('fr-volume').value = volumeAtual;

  const painel = VbMxPainel.iniciar({ montarEm: $('pastas'), aoMudar: (fs) => { faixas = ts ? ts.vestir(fs || []) : fs || []; ctl.definirBiblioteca(faixas); desenharBiblioteca(); } });

  $('fr-tocar').onclick = async () => {
    garantirAudio();
    if (ctx.state !== 'running') await ctx.resume();
    ctl.tocarPausar();
  };
  $('fr-mixar').onclick = () => ctl.mixarAgora();
  $('fr-outra').onclick = () => ctl.outraSugestao();
  $('fr-shuffle').onchange = (e) => { gravar('vbmx-friends-shuffle', e.target.checked ? '1' : '0'); ctl.definirShuffle(e.target.checked); };
  $('fr-volume').oninput = (e) => {
    volumeAtual = Number(e.target.value); gravar('vbmx-friends-volume', volumeAtual);
    if (volume) volume.gain.setTargetAtTime((volumeAtual / 100) ** 2, ctx.currentTime, 0.02);
  };
  $('fr-biblioteca').onclick = (e) => {
    const b = e.target.closest('button[data-id]'); if (!b) return;
    const f = faixas.find((x) => String(x.id) === b.dataset.id);
    if (!f) return;
    if (b.dataset.acao === 'fila') ctl.adicionarNaFila(f); else ctl.escolherManual(f);
  };
  // fila do DJ: remover, reordenar e limpar (a fila vive no controlador e não persiste ao recarregar)
  $('fr-fila').onclick = (e) => {
    const b = e.target.closest('button[data-fila]'); if (!b) return;
    const i = Number(b.dataset.i);
    if (b.dataset.fila === 'remover') ctl.removerDaFila(i);
    else if (b.dataset.fila === 'subir') ctl.moverNaFila(i, i - 1);
    else if (b.dataset.fila === 'descer') ctl.moverNaFila(i, i + 1);
  };
  $('fr-fila-limpar').onclick = () => ctl.limparFila();

  function desenharFila(st) {
    const fila = st.fila || [];
    $('fila-conta').textContent = fila.length ? String(fila.length) : '';
    $('fr-fila-limpar').hidden = !fila.length;
    $('fr-fila-vazia').hidden = !!fila.length;
    $('fr-fila').innerHTML = fila.map((it, i) => {
      const nome = it.faixa.titulo || it.faixa.id;
      return `<li><span class="fr-pos">${i + 1}</span><span class="fr-nome">${esc(it.faixa.titulo)} <small>${esc(it.faixa.artista || '')}</small></span>` +
        `<button type="button" class="fr-acao" data-fila="subir" data-i="${i}" aria-label="${esc(t('fila.subir-aria', { titulo: nome }))}"${i === 0 ? ' disabled' : ''}>↑</button>` +
        `<button type="button" class="fr-acao" data-fila="descer" data-i="${i}" aria-label="${esc(t('fila.descer-aria', { titulo: nome }))}"${i === fila.length - 1 ? ' disabled' : ''}>↓</button>` +
        `<button type="button" class="fr-acao" data-fila="remover" data-i="${i}" aria-label="${esc(t('fila.remover-aria', { titulo: nome }))}">×</button></li>`;
    }).join('');
  }

  function desenharBiblioteca() {
    const st = ctl.estado();
    desenharFila(st);
    const atualId = st.atual && st.atual.faixa.id, proxId = st.proxima && st.proxima.faixa && st.proxima.faixa.id;
    const ja = new Set(st.tocadas.map((f) => f.id));
    const ordem = faixas.slice().sort((a, b) => I.comparar(a.artista || '', b.artista || '') || I.comparar(a.titulo || '', b.titulo || ''));
    const prontas = ordem.filter(tocavel).length;
    $('lista-conta').textContent = faixas.length ? t('biblioteca.conta', { prontas, total: faixas.length }) : '';
    $('fr-biblioteca').innerHTML = ordem.slice(0, 400).map((f) => {
      const ok = tocavel(f), marca = f.id === atualId ? 'tocando' : f.id === proxId ? 'a-seguir' : ja.has(f.id) ? 'tocou' : '';
      return `<li class="${marca ? 'fr-marcada' : ''}${marca === 'tocando' ? ' fr-tocando' : marca === 'a-seguir' ? ' fr-seguindo' : ''}"><span class="fr-nome">${esc(f.titulo)} <small>${esc(f.artista || '')}</small></span>` +
        `<span class="mono fr-dado">${f.bpm ? br(f.bpm, 1) : '—'} · ${esc(f.camelot || '—')}</span>` +
        (ok ? `<button type="button" class="botao-pasta fr-fila-add" data-acao="fila" data-id="${esc(f.id)}" aria-label="${esc(t('fila.add-aria', { titulo: f.titulo || f.id }))}">${t('fila.add')}</button>` : '') +
        (marca ? `<span class="fr-selo">${t('biblioteca.' + marca)}</span>` : ok && st.atual && !st.mixando ? `<button type="button" class="botao-pasta" data-id="${esc(f.id)}">${t('biblioteca.a-seguir')}</button>` : ok ? '' : `<span class="fr-selo fr-fraco">${t('biblioteca.sem-analise')}</span>`) +
        '</li>';
    }).join('');
    $('fr-historico').innerHTML = st.tocadas.slice().reverse().map((f) => `<li><span class="fr-nome">${esc(f.titulo)} <small>${esc(f.artista || '')}</small></span></li>`).join('');
  }

  // A onda da faixa que toca: posição (cabeça branca) e o trecho em que a mixagem automática acontece (verde, a
  // partir do inicioMix do plano de motor/automix.js). O canvas tem os pixels do tamanho na tela × devicePixelRatio.
  // ---- interação com os dois marcadores da barra (Pointer Events: mouse, toque e caneta) ----
  //   bolinha azul / clique na onda ou no fio = BUSCA: durante o arrasto só a tela anda (cabeça, relógio); o áudio vai para o
  //     ponto ao SOLTAR (um buscar por gesto, não um por pixel). Bloqueada no cruzamento.
  //   triângulo amarelo = PONTO DA MIXAGEM: cada movimento replaneja (só números, o áudio não muda) e encaixa na batida 1.
  // A lógica de conversão e de limites mora em VbMxFriendsOnda / VbMxAutomix (testada em Node); aqui só há ponteiro e DOM.
  let arrasto = null;   // {tipo: 'busca'|'ponto', t, desvio}
  const posVista = (a) => (arrasto && arrasto.tipo === 'busca' ? arrasto.t : a.posicao);
  const larguraFio = () => $('agora-fio').getBoundingClientRect();
  function tempoDoPonteiro(ev, desvioPx) {
    const r = larguraFio(), a = ctl.estado().atual;
    return a ? VbMxFriendsOnda.tempoDaPosicao(ev.clientX - r.left + (desvioPx || 0), r.width, a.duracao) : 0;
  }
  function iniciarBusca(ev) {
    if (ev.button > 0 || !ctl.estado().podeBuscar) return;
    const a = ctl.estado().atual, r = larguraFio();
    const desvio = ev.target === $('agora-bola') ? VbMxFriendsOnda.posicaoDoTempo(a.posicao, r.width, a.duracao) - (ev.clientX - r.left) : 0;
    arrasto = { tipo: 'busca', t: tempoDoPonteiro(ev, desvio), desvio };
    ev.currentTarget.setPointerCapture && ev.currentTarget.setPointerCapture(ev.pointerId);
    $('agora-bola').classList.add('arrastando');
    redesenharArrasto();
  }
  // Mover e soltar escutam o document inteiro: não dependem de o ponteiro continuar sobre o marcador (nem de a captura
  // valer — o Chrome por CDP, por exemplo, não a aplica a eventos sintéticos).
  function soltar(cancelado) {
    if (!arrasto) return;
    const { tipo, t } = arrasto;
    arrasto = null;
    $('agora-bola').classList.remove('arrastando'); $('agora-ponto').classList.remove('arrastando');
    if (tipo === 'busca' && !cancelado) ctl.buscar(t);
    ondaChave = ''; desenhar();
  }
  document.addEventListener('pointermove', (ev) => {
    if (!arrasto) return;
    if (arrasto.tipo === 'busca') arrasto.t = tempoDoPonteiro(ev, arrasto.desvio);
    else ctl.definirPontoMixagem(tempoDoPonteiro(ev));
    redesenharArrasto();
  });
  document.addEventListener('pointerup', () => soltar(false));
  document.addEventListener('pointercancel', () => soltar(true));
  function redesenharArrasto() { ondaChave = ''; desenharAgora(ctl.estado()); }
  for (const el of [$('agora-fio'), $('agora-onda')]) {
    el.addEventListener('pointerdown', (ev) => { if (ev.target === $('agora-ponto')) return; iniciarBusca(ev); });
  }
  const ponto = $('agora-ponto');
  ponto.addEventListener('pointerdown', (ev) => {
    if (ev.button > 0 || !ctl.estado().plano || !ctl.estado().plano.editavel) return;
    arrasto = { tipo: 'ponto', t: 0, desvio: 0 };
    ponto.setPointerCapture && ponto.setPointerCapture(ev.pointerId);
    ponto.classList.add('arrastando'); ev.preventDefault();
    ctl.definirPontoMixagem(tempoDoPonteiro(ev)); redesenharArrasto();
  });
  // Teclado: bolinha = setas ±5 s, Home, End; triângulo = setas ±1 compasso, Home/End = primeiro/último possível, Esc = automático.
  $('agora-bola').addEventListener('keydown', (ev) => {
    const a = ctl.estado().atual; if (!a || !ctl.estado().podeBuscar) return;
    const v = VbMxFriendsOnda.passoDeTeclado(ev.key, a.posicao, { duracao: a.duracao, fim: a.duracao - VbMxAutomix.MARGEM_FIM_S });
    if (v === null) return;
    ev.preventDefault(); ctl.buscar(v); ondaChave = ''; desenhar();
  });
  ponto.addEventListener('keydown', (ev) => {
    const pl = ctl.estado().plano; if (!pl || !pl.editavel) return;
    const k = ev.key;
    if (k === 'ArrowLeft' || k === 'ArrowDown') ctl.moverPontoMixagem(-1);
    else if (k === 'ArrowRight' || k === 'ArrowUp') ctl.moverPontoMixagem(1);
    else if (k === 'Home') ctl.definirPontoMixagem(pl.limites.min);
    else if (k === 'End') ctl.definirPontoMixagem(pl.limites.max);
    else if (k === 'Escape' || k === 'Backspace' || k === 'Delete') ctl.pontoAutomatico();
    else return;
    ev.preventDefault(); ondaChave = ''; desenhar();
  });

  function desenharOnda(st) {
    const cv = $('agora-onda'); if (!cv || !cv.getContext) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const w = Math.round(cv.clientWidth * dpr), h = Math.round(cv.clientHeight * dpr);
    if (!w || !h) return;
    const a = st.atual, picos = a ? ondas.pronto(chaveOnda(a.faixa)) : null;
    const m = VbMxFriendsOnda.marcas(a ? { duracao: a.duracao, posicao: posVista(a), taxa: a.taxa, plano: st.plano, mixando: st.mixando, progresso: st.progresso } : null, w);
    const r = (v) => v === null ? 'x' : Math.round(v);
    const chave = [w, h, a ? chaveOnda(a.faixa) : '', picos ? 1 : 0, r(m.cabeca), r(m.mixIni), r(m.mixFim), r(m.mixFeito)].join('|');
    if (chave === ondaChave) return;
    ondaChave = chave;
    if (cv.width !== w) cv.width = w;
    if (cv.height !== h) cv.height = h;
    cv.dataset.estado = !a ? 'vazia' : picos ? 'pronta' : 'calculando';
    VbMxFriendsOnda.desenhar(cv.getContext('2d'), picos, m, { largura: w, altura: h, cores: CORES_ONDA, metade: true });
  }

  function desenharAgora(st) {
    desenharOnda(st);
    const a = st.atual, pl = st.plano;
    const bola = $('agora-bola'), ponto = $('agora-ponto'), busca = !!st.podeBuscar;
    $('agora-onda').dataset.busca = busca ? '1' : '0'; $('agora-fio').dataset.busca = busca ? '1' : '0';
    if (a) {
      const pos = posVista(a), pct = a.duracao ? Math.min(100, (pos / a.duracao) * 100) : 0;
      $('agora-barra').style.width = pct + '%';
      raiz.style.setProperty('--p', pct.toFixed(2) + '%');
      if (pl && a.duracao) { ponto.hidden = false; ponto.style.left = Math.min(100, (pl.inicioMix / a.duracao) * 100) + '%'; raiz.style.setProperty('--m', ponto.style.left); }
      else ponto.hidden = true;
      $('agora-tempo').textContent = `${mmss(pos / a.taxa)} / ${mmss(a.duracao / a.taxa)}`;
      bola.setAttribute('aria-valuemax', String(Math.round(a.duracao)));
      bola.setAttribute('aria-valuenow', String(Math.round(pos)));
      bola.setAttribute('aria-valuetext', t('posicao.valor', { pos: mmss(pos / a.taxa), total: mmss(a.duracao / a.taxa) }));
    } else {
      $('agora-barra').style.width = '0%'; raiz.style.setProperty('--p', '0%'); ponto.hidden = true; $('agora-tempo').textContent = '';
      bola.setAttribute('aria-valuenow', '0'); bola.setAttribute('aria-valuemax', '0'); bola.setAttribute('aria-valuetext', t('agora.sem-faixa'));
    }
    bola.setAttribute('aria-disabled', busca ? 'false' : 'true');
    const edita = !!(pl && pl.editavel);
    ponto.setAttribute('aria-disabled', edita ? 'false' : 'true');
    const mp = $('agora-mixponto');
    if (a && pl) {
      const quando = mmss(pl.inicioMix / a.taxa);
      ponto.setAttribute('aria-valuemin', String(Math.round(pl.limites ? pl.limites.min : 0)));
      ponto.setAttribute('aria-valuemax', String(Math.round(pl.limites ? pl.limites.max : a.duracao)));
      ponto.setAttribute('aria-valuenow', String(Math.round(pl.inicioMix)));
      ponto.setAttribute('aria-valuetext', t(pl.manual ? 'ponto.valor.manual' : 'ponto.valor.auto', { quando }));
      mp.innerHTML = st.mixando ? esc(t('ponto.bloqueado')) : t(pl.manual ? 'ponto.manual' : 'ponto.auto', { quando: esc(quando) });   // as chaves ponto.manual/auto trazem <b>{quando}</b>
    } else { mp.textContent = ''; ponto.removeAttribute('aria-valuenow'); ponto.removeAttribute('aria-valuetext'); }
    raiz.style.setProperty('--x', String(st.mixando ? Math.round(st.progresso * 100) : 0));   // o marcador do X do cruzamento
    const p = st.plano;
    // "compasso 5 de 8": derivado aqui do progresso e dos compassos do plano; o estado() do controlador não expõe o compasso (e não é preciso mexer no motor)
    const nComp = st.plano && st.plano.sincroniza ? st.plano.compassos : 0, pct = Math.round(st.progresso * 100);
    $('seguir-quando').textContent = st.mixando
      ? (nComp > 0 ? t('seguir.mixando-compasso', { pct, c: Math.min(nComp, Math.floor(st.progresso * nComp) + 1), n: nComp }) : t('seguir.mixando', { pct }))
      : p ? textoSeguir(p) : '';
    $('fr-duracao-info').textContent = textoDuracao(st);
    desenharFormato(st);
  }

  function textoSeguir(p) {
    const limite = p.limitado ? t('seguir.limite', { n: p.pedidos }) : '', falta = mmss(p.faltaS), s = Math.round(p.duracaoMix);
    return p.sincroniza ? t('seguir.sync', { falta, n: p.compassos, s, limite }) : t('seguir.livre', { falta, s, limite });
  }

  // "8 compassos ≈ 15 s": o s vem do BPM que soa; sem faixa, de 128 BPM. Se a faixa/ponto limitam, mostra o valor efetivo.
  function textoDuracao(st) {
    const n = st.compassos, p = st.plano, cs = st.compassoS > 0 ? st.compassoS : 4 * 60 / VbMxAutomix.BPM_REFERENCIA;
    const ref = st.compassoS > 0 ? '' : t('duracao.ref', { bpm: VbMxAutomix.BPM_REFERENCIA });
    const base = t('duracao.base', { n, s: Math.round(n * cs), ref });
    if (p && !st.mixando && p.limitado) {
      const s = Math.round(p.duracaoMix);
      return p.sincroniza ? t('duracao.lim-sync', { base, n: p.compassos, s }) : t('duracao.lim', { base, s });
    }
    return base;
  }

  function desenhar() {
    const st = ctl.estado();
    const a = st.atual;
    capas.pedir(a ? a.faixa : null);
    capasSeguir.pedir(st.proxima && st.proxima.faixa ? st.proxima.faixa : null);   // sem próxima (ou ainda carregando) = capa padrão
    $('agora-titulo').textContent = a ? a.faixa.titulo : '—';
    $('agora-sub').textContent = a ? `${a.faixa.artista || ''} · ${a.bpmSoando ? I.bpm(a.bpmSoando) : '—'} · ${a.faixa.camelot || '—'}${Math.abs(a.taxa - 1) > 1e-4 ? ` · pitch ${br((a.taxa - 1) * 100, 1)}%` : ''}`
      : st.fase === 'carregando' ? t('agora.abrindo') : faixas.length ? t('agora.sortear') : t('friends.agora.inicial');
    $('fr-tocar').textContent = t(st.fase === 'tocando' ? 'friends.pausar' : st.fase === 'pausado' ? 'friends.continuar' : st.fase === 'carregando' ? 'friends.abrindo' : 'friends.comecar');
    $('fr-tocar').disabled = st.fase === 'carregando';
    $('fr-mixar').disabled = !(st.fase === 'tocando' && st.proxima && !st.proxima.carregando && !st.mixando);
    $('fr-outra').disabled = !(a && st.shuffle && !st.mixando && !(st.proxima && st.proxima.carregando));
    const px = st.proxima;
    $('seguir-titulo').textContent = px ? (px.faixa ? `${px.faixa.titulo}${px.faixa.artista ? ' — ' + px.faixa.artista : ''}` : '…') : st.shuffle ? '—' : t('seguir.desligado');
    $('seguir-motivo').textContent = px ? trm(px.motivo) + (st.plano ? ` · ${trm(st.plano.motivo)}` : '') : '';
    $('seguir-motivo').title = px && px.explicacao ? trm(px.explicacao) : '';
    const aviso = $('fr-aviso');
    aviso.hidden = !st.erro; aviso.textContent = trm(st.erro) || '';
    estadoVisual(st);
    desenharAgora(st);
    desenharBiblioteca();
    if (fundo) fundo.avisar();   // o fundo em mosaico lê o BPM e a batida do próprio estado: só acorda quando algo mudou
  }

  // Estado para o CSS (opção C): data-fase no <main> — vazio (sem pasta) | parado | carregando ("abrindo a primeira
  // faixa…") | tocando | pausado | mixando —, data-shuffle e a linha do set. Nada disto muda o motor.
  function estadoVisual(st) {
    const fase = st.mixando ? 'mixando' : (!faixas.length && st.fase === 'parado') ? 'vazio' : st.fase;
    raiz.dataset.fase = fase;
    raiz.dataset.shuffle = st.shuffle ? '1' : '0';
    if (fase !== faseAnunciada) { faseAnunciada = fase; $('fr-fase').textContent = FRASES_FASE.includes(fase) ? t('fase.' + fase) : ''; }
    const ja = Math.min(3, st.tocadas.length);
    $('fr-trilho').innerHTML = '<i class="ja"></i>'.repeat(ja) + '<i class="ag"></i><i class="px"></i><i class="fim"></i>';
  }

  // ---- plugin TrackSave: link do YouTube → servidor local → análise → biblioteca (modos/friends-tracksave.js) ----
  function desenharTrackSave(e) {
    const visivel = e.fase !== 'oculto';
    $('fr-ts').hidden = !visivel;
    if (!visivel) return;
    $('ts-form').hidden = !e.noAr;
    $('ts-dica').hidden = e.fase !== 'fora';
    $('ts-link').disabled = e.ocupado; $('ts-baixar').disabled = e.ocupado;
    $('ts-baixar').textContent = t(e.fase === 'baixando' ? 'ts.baixando' : e.fase === 'analisando' ? 'ts.analisando-botao' : 'ts.trazer');
    const pr = $('ts-progresso');
    pr.hidden = !e.ocupado;
    if (typeof e.fracao === 'number') pr.value = Math.max(0, Math.min(1, e.fracao)); else pr.removeAttribute('value');
    const s = $('ts-status');
    s.textContent = e.fase === 'sondando' ? t('ts.procurando') : e.mensagem || '';   // textContent: mensagem do servidor nunca vira HTML
    s.classList.toggle('fr-ts-erro', e.fase === 'erro' || (e.fase === 'fora' && !!e.mensagem) || e.fase === 'origem');
    if (e.fase === 'feito') $('ts-link').value = '';
    // a capa pelo TrackSave só roda em 127.0.0.1:8770 (friends-capa.js): na publicada o interruptor não aparece
    $('ts-capa-linha').hidden = !(e.noAr && onde === 'local'); $('ts-capa-nota').hidden = !(e.noAr && onde === 'local');
    if (e.noAr !== noArVisto) { noArVisto = e.noAr; capas.refazer(); capasSeguir.refazer(); }   // o TrackSave ligou/desligou: tenta a capa de novo
  }
  let noArVisto = false;
  // na versão publicada (GitHub Pages) o plugin só existe na máquina que abriu uma vez com ?tracksave=1 (lembrado
  // aqui; ?tracksave=0 desliga). Nas outras, nada disto existe: nem a seção, nem um pedido a 127.0.0.1.
  const TS_CHAVE = 'vbmx-friends-tracksave';   // '1' | '0'
  const tsPedido = VbMxTrackSave.pedidoNaUrl(window.location.search);
  if (tsPedido !== null) gravar(TS_CHAVE, tsPedido);
  const onde = VbMxTrackSave.liberar(VbMxTrackSave.ondeEstou(window.location), ler(TS_CHAVE, '0') === '1');
  if (onde !== 'fora') {
    ts = VbMxTrackSave.criarFluxo({
      cliente: VbMxTrackSave.criar({}), onde, aoEstado: desenharTrackSave,
      painel: { adicionar: (p) => painel.adicionar(p), faixas: () => painel.faixas(), ocupado: () => !!VbMxPainel.pastasParaFiltro().ocupado },
    });
    $('ts-form').onsubmit = (ev) => { ev.preventDefault(); ts.trazer($('ts-link').value); };
    $('ts-sondar').onclick = () => ts.sondar();
    $('ts-capa').checked = ler(PESQUISA_CHAVE, '1') === '1';
    $('ts-capa').onchange = (ev) => { gravar(PESQUISA_CHAVE, ev.target.checked ? '1' : '0'); capas.refazer(); capasSeguir.refazer(); };
    ts.iniciar();
  }

  if (typeof ResizeObserver === 'function') new ResizeObserver(() => desenharOnda(ctl.estado())).observe($('agora-onda'));
  else window.addEventListener('resize', () => desenharOnda(ctl.estado()));
  setInterval(() => { ctl.tick(); desenharAgora(ctl.estado()); }, 250);
  (function quadro() { if (!document.hidden && ctl.estado().fase === 'tocando') desenharOnda(ctl.estado()); requestAnimationFrame(quadro); })();
  // troca de idioma ao vivo: o i18n.js já refez o texto marcado no HTML; aqui refaz o que a tela monta (frases, aria-valuetext, selos)
  I.aoMudar(() => { faseAnunciada = ''; ondaChave = ''; desenhar(); if (ts) desenharTrackSave(ts.estado()); });
  desenhar();
})();
