// VbMx Friends — o controlador do shuffle que mixa sozinho. Sem DOM e sem criar nó de áudio: recebe o
// VbMxTocador (dois decks, A e B, que se revezam) e o ganho de saída de cada deck, e faz o ciclo
//   escolher a próxima (VbMxAutomix.escolherProxima) → carregar no deck livre → planejar a transição
//   (VbMxAutomix.planejarTransicao) → no ponto, a próxima começa muda e as curvas de ganho são AGENDADAS no
//   relógio do áudio (setValueCurveAtTime) → no fim do cruzamento a antiga sai e o ciclo recomeça.
// O agendamento no relógio do áudio é o que deixa a mixagem certa com a aba em 2º plano (timer a ~1 s): o laço
// (tick) só precisa acordar ANTECEDENCIA_S antes do ponto. Nada aqui toca stems, efeitos ou a cadeia do
// Profissional: o caminho é tocador → ganho do deck → saída. Contrato: docs/contratos.md § VbMxFriends.
// Teste: node interface/testar-friends.js (tocador e relógio falsos).
//
// VbMxFriends.criar({tocador, saida(letra) → {gain: AudioParam}, decodificar(faixa) → Promise<AudioBuffer>,
//   aleatorio?, aoMudar?(estado), limitePitch?, compassos? (4|8|16|32|64, padrão 8)}) → controlador:
//   definirBiblioteca(faixas)   as faixas do VbMxPainel ({id, bpm, camelot, grade, obter, …})
//   comecar() → Promise          sorteia a 1ª e toca (ou retoma, se pausado)
//   tocarPausar()                pausa/retoma os decks que soam; no meio do cruzamento congela e retoma as curvas
//   buscar(s) → bool             move a reprodução da faixa que toca para s (s da faixa, 0…fim−margem); segue tocando ou
//                                pausada onde estava; bloqueado no cruzamento. Se o ponto da mixagem ficou para trás, volta ao automático
//   definirPontoMixagem(s) → s|null  o DJ escolhe onde a transição começa: encaixa na batida 1 do compasso mais próximo,
//                                dentro de limitesPonto; null se bloqueado (sem próxima, ou já mixando)
//   moverPontoMixagem(n) → s|null    n compassos para a frente (+) ou para trás (−) a partir do ponto atual
//   pontoAutomatico()            volta ao ponto automático (também volta sozinho quando a faixa que toca muda)
//   mixarAgora()                 replaneja a transição para o próximo compasso possível
//   outraSugestao() → Promise    troca a próxima por outra do shuffle (a recusada não volta neste giro)
//   escolherManual(faixa) → Promise  a próxima passa a ser esta
//   adicionarNaFila(faixa)       põe a faixa no fim da fila do DJ (pode repetir a mesma); a fila NÃO persiste e tem prioridade sobre o shuffle
//   removerDaFila(i) · moverNaFila(de, para) · limparFila()   mexem na fila; estado().fila = [{chave, faixa}] na ordem de saída
//   definirCompassos(n)          duração da transição em compassos (4/8/16/32/64): replaneja a próxima; no meio do cruzamento só vale na seguinte
//   definirFormato(f) → bool     formato da curva do crossfader (linear|potencia|corte-tardio|corte-cedo|degrau|personalizado); false e ignorado durante o cruzamento
//   definirCurva(params) → bool  liga o formato 'personalizado' com os pontos {t1,g1,t2,g2} (normalizados: nunca cruzam); params corrompidos = false, nada muda
//   definirShuffle(bool)         desligado: toca a atual até o fim e para
//   tick()                       chamar a cada ~250 ms (setInterval); idempotente
//   aoTerminar(letra)            ligar no aoTerminar do VbMxTocador: fim de faixa sem cruzamento → corte seco
//   estado()                     o que a tela desenha (abaixo)
(function (raiz, fabrica) {
  const A = raiz.VbMxAutomix || (typeof require === 'function' ? require('../../motor/automix.js') : null);
  const api = fabrica(A);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.VbMxFriends = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (A) {
  'use strict';

  // texto pelo idioma (interface/js/i18n.js); no Node, o módulo cai em pt-BR. A mensagem nasce quando o evento acontece.
  const I18N = (typeof globalThis !== 'undefined' && globalThis.VbMxI18n) || (typeof require === 'function' ? require('../js/i18n.js') : null);
  const tr = (chave, params) => (I18N ? I18N.t(chave, params) : chave);
  const trm = (txt) => (typeof globalThis !== 'undefined' && globalThis.VbMxMsg ? globalThis.VbMxMsg.traduzir(txt) : txt);   // mensagens do motor (js/msg-motor.js)
  const outra = (l) => (l === 'A' ? 'B' : 'A');
  const PONTOS_CURVA = 128;
  const MAX_TENTATIVAS = 4;   // faixa que não decodifica: pula e tenta outra, até 4 vezes

  function criar(deps) {
    const d = deps || {};
    if (!d.tocador || typeof d.saida !== 'function' || typeof d.decodificar !== 'function') {
      throw new TypeError('VbMxFriends.criar: tocador, saida(letra) e decodificar(faixa) são obrigatórios');
    }
    const tc = d.tocador;
    const aleatorio = typeof d.aleatorio === 'function' ? d.aleatorio : Math.random;
    const limitePitch = d.limitePitch || A.LIMITE_PITCH_PADRAO;

    let biblioteca = [];
    let fase = 'parado';         // 'parado' | 'carregando' | 'tocando' | 'pausado'
    let shuffle = true;
    let paramsCurva = A.normalizarParams(d.params);   // pontos do formato personalizado (lembrados mesmo com um formato pronto escolhido); nulo = nunca ajustado
    let formato = A.formatoValido(d.formato);
    if (formato === A.PERSONALIZADO && !paramsCurva) formato = A.FORMATO_PADRAO;   // personalizado sem pontos válidos = linear   // formato da curva do crossfader; vale para a próxima transição (o do plano em curso fica no plano)
    let compassos = A.compassosValidos(d.compassos);   // duração pedida da transição (compassos); o s vem do BPM que soa
    let atual = null;            // {letra, faixa, duracao}
    let proxima = null;          // {letra, faixa, duracao, escolha}
    let plano = null;            // VbMxAutomix.planejarTransicao
    let mixando = false;         // a próxima já está tocando (muda ou no cruzamento)
    let preparando = null;       // {faixa?} enquanto decodifica a próxima
    let ficha = 0;               // invalida preparo antigo (outra sugestão no meio do decode)
    const fila = [];             // fila do DJ: [{chave, faixa}]; a 1ª é a próxima antes de qualquer escolha do shuffle
    let chaveFila = 0;
    let puladas = [];            // recusadas em "outra sugestão" ou que falharam: fora até a próxima troca
    let erro = '';
    let pontoManual = null;      // s da faixa que toca: o ponto da mixagem escolhido pelo DJ (null = automático)
    const tocadas = [];          // faixas, na ordem em que entraram

    const avisar = () => { if (typeof d.aoMudar === 'function') d.aoMudar(estado()); };
    const ganho = (letra) => d.saida(letra).gain;
    function fixarGanho(letra, v, t) { const g = ganho(letra); g.cancelScheduledValues(t); g.setValueAtTime(v, t); }
    const taxaDe = (letra, t) => { const e = tc.estado(letra, t); return e.taxa > 0 ? e.taxa : 1; };

    async function decodificarPulando(escolher) {
      for (let i = 0; i < MAX_TENTATIVAS; i++) {
        const escolha = escolher();
        if (!escolha || !escolha.faixa) return { escolha, buffer: null };
        try { return { escolha, buffer: await d.decodificar(escolha.faixa) }; }
        catch (e) { erro = tr('seguir.nao-abriu', { titulo: escolha.faixa.titulo || escolha.faixa.id, motivo: e && e.message ? e.message : e }); puladas.push(escolha.faixa.id); if (escolha.chaveFila) tirarDaFila(escolha.chaveFila); }   // faixa da fila que não abriu: sai da fila
      }
      return { escolha: null, buffer: null };
    }

    function replanejar(aPartirDe) {
      if (!atual || !proxima) { plano = null; return; }
      const t = tc.relogio();
      plano = A.planejarTransicao({ atual: atual.faixa, duracaoAtual: atual.duracao, taxaAtual: taxaDe(atual.letra, t),
        proxima: proxima.faixa, duracaoProxima: proxima.duracao, limitePitch, compassos, encolher: 'compasso',
        aPartirDe: pontoManual !== null && aPartirDe === undefined ? pontoManual : aPartirDe });
    }

    // Entrada de limitesPonto/encaixarPonto: a cabeça mais a antecedência é o mais cedo que o ponto pode ser.
    function entradaPonto(t) {
      const e = tc.estado(atual.letra, t), taxa = e.taxa > 0 ? e.taxa : 1;
      return { atual: atual.faixa, duracaoAtual: atual.duracao, taxaAtual: taxa, compassos, minimo: e.posicao + A.ANTECEDENCIA_S * taxa };
    }
    const podeMoverPonto = () => !!(atual && proxima && plano && !mixando && fase !== 'carregando');
    function definirPontoMixagem(s) {
      if (!podeMoverPonto() || typeof s !== 'number' || !Number.isFinite(s)) return null;
      const r = A.encaixarPonto(s, entradaPonto(tc.relogio()));
      pontoManual = r.tempo;
      replanejar(pontoManual);
      avisar();
      return plano ? plano.inicioMix : null;
    }
    function moverPontoMixagem(n) {
      if (!podeMoverPonto()) return null;
      const c = A.duracaoDoCompasso(atual.faixa);
      return definirPontoMixagem(plano.inicioMix + (c > 0 ? c : 1) * n);
    }
    function pontoAutomatico() {
      if (pontoManual === null) return;
      pontoManual = null;
      if (podeMoverPonto()) replanejar();
      avisar();
    }

    // Busca na faixa que toca (arrastar a bolinha azul, clicar na onda, teclado). Durante o cruzamento as curvas de
    // ganho já estão agendadas no relógio do áudio, então a cabeça não se mexe até ele acabar.
    function buscar(s) {
      if (!atual || mixando || fase === 'carregando' || typeof s !== 'number' || !Number.isFinite(s)) return false;
      const t = tc.relogio(), taxa = taxaDe(atual.letra, t);
      const alvo = Math.max(0, Math.min(Math.max(0, atual.duracao - A.MARGEM_FIM_S), s));
      tc.buscar(atual.letra, alvo);
      if (proxima) {
        const minimo = alvo + A.ANTECEDENCIA_S * taxa;
        if (pontoManual !== null && pontoManual < minimo) pontoManual = null;   // o ponto escolhido ficou para trás
        replanejar(pontoManual === null ? undefined : pontoManual);
        if (pontoManual === null && plano && plano.inicioMix < minimo && plano.sincroniza) replanejar(minimo);
      }
      avisar();
      return true;
    }

    function tirarDaFila(chave) { const i = fila.findIndex((x) => x.chave === chave); if (i >= 0) fila.splice(i, 1); }
    function consumirFila(p) { if (p && p.escolha && p.escolha.chaveFila) tirarDaFila(p.escolha.chaveFila); }
    // Depois de mexer na fila: se a próxima (ou a que está sendo preparada) não é a que a fila manda, prepara de novo.
    // A escolhida à mão (escolherManual) não é tocada; no cruzamento nada muda.
    function reavaliarFila() {
      if (atual && !mixando) {
        const chaveProxima = proxima ? proxima.escolha.chaveFila || (proxima.escolha.origem === 'manual' ? 'manual' : 'auto')
          : preparando ? (preparando.faixa ? 'manual' : preparando.chave || 'auto') : null;
        const desejada = fila.length ? fila[0].chave : 'auto';
        if (chaveProxima !== 'manual' && chaveProxima !== desejada) prepararProxima();
      }
      avisar();
    }
    function adicionarNaFila(faixa) {
      if (!faixa || faixa.id == null) return;
      fila.push({ chave: ++chaveFila, faixa });
      reavaliarFila();
    }
    function removerDaFila(i) { if (Number.isInteger(i) && i >= 0 && i < fila.length) { fila.splice(i, 1); reavaliarFila(); } }
    function moverNaFila(de, para) {
      if (!Number.isInteger(de) || !Number.isInteger(para) || de < 0 || para < 0 || de >= fila.length || para >= fila.length || de === para) return;
      fila.splice(para, 0, fila.splice(de, 1)[0]);
      reavaliarFila();
    }
    function limparFila() { if (fila.length) { fila.length = 0; reavaliarFila(); } }

    function soltarProxima() {
      ficha += 1; preparando = null;
      if (proxima) tc.descarregar(proxima.letra);
      proxima = null; plano = null;
    }

    // Escolhe (ou recebe) a próxima, decodifica e carrega no deck livre. Não mexe em nada durante o cruzamento.
    async function prepararProxima(manual) {
      if (!atual || mixando) return;
      if (!shuffle && !manual && !fila.length) { soltarProxima(); avisar(); return; }
      soltarProxima();
      const minha = ficha;
      const letra = outra(atual.letra);
      preparando = { faixa: manual || null };
      avisar();
      const r = await decodificarPulando(() => {
        if (manual) { const m = manual; manual = null; return { faixa: m, motivo: tr('seguir.manual'), explicacao: '', origem: 'manual' }; }
        if (fila.length) { const it = fila[0]; if (preparando) preparando.chave = it.chave; return { faixa: it.faixa, motivo: tr('seguir.fila'), explicacao: '', origem: 'fila', chaveFila: it.chave }; }
        const e = A.escolherProxima(atual.faixa, biblioteca, { tocadas: tocadas.map((f) => f.id), excluir: puladas,
          taxaAtual: taxaDe(atual.letra, tc.relogio()), limitePitch, aleatorio });
        if (e.reiniciar) tocadas.splice(0, tocadas.length - 1);   // o giro recomeça: fica só a que toca
        return e;
      });
      if (minha !== ficha || !atual || mixando) return;    // alguém pediu outra coisa no meio do decode
      preparando = null;
      if (!r.buffer) { if (r.escolha && !r.escolha.faixa) erro = trm(r.escolha.motivo); avisar(); return; }
      tc.carregar(letra, r.buffer);
      fixarGanho(letra, 0, tc.relogio());
      proxima = { letra, faixa: r.escolha.faixa, duracao: r.buffer.duration, escolha: r.escolha };
      replanejar();
      avisar();
    }

    // Agenda as curvas a partir do progresso p0 (0 no começo; >0 ao retomar de uma pausa).
    function agendarCurvas(p0, tInicio, t0) {
      const c = A.curvaDeGanho(p0, PONTOS_CURVA, plano.curva, plano.formato, plano.params);
      const resto = plano.duracaoMix * (1 - p0);
      const gS = ganho(atual.letra), gE = ganho(proxima.letra);
      gS.cancelScheduledValues(t0); gE.cancelScheduledValues(t0);
      gS.setValueAtTime(c.saindo[0], t0); gE.setValueAtTime(c.entrando[0], t0);
      if (plano.formato === 'degrau') {   // corte seco: um valor só, no meio (o setValueCurve interpolaria uma rampa de uma amostra)
        const tMeio = p0 < 0.5 ? tInicio + plano.duracaoMix * (0.5 - p0) : t0;
        gS.setValueAtTime(0, tMeio); gE.setValueAtTime(1, tMeio);
      } else if (resto > 0.01) { gS.setValueCurveAtTime(c.saindo, tInicio, resto); gE.setValueCurveAtTime(c.entrando, tInicio, resto); }
      else { gS.setValueAtTime(0, tInicio); gE.setValueAtTime(1, tInicio); }
    }

    function iniciarMix() {
      const t0 = tc.relogio();
      const eA = tc.estado(atual.letra, t0), taxaA = eA.taxa > 0 ? eA.taxa : 1, posA = eA.posicao;
      let posP = A.posicaoDaProxima(plano, posA, taxaA);
      if (posP < 0 || posA > plano.inicioMix + 1e-3) {
        if (plano.sincroniza) { replanejar(posA + A.ANTECEDENCIA_S * taxaA); return; }   // o laço atrasou: o próximo compasso
        const resta = Math.max(0.5, (atual.duracao - posA) / taxaA);
        plano = Object.assign({}, plano, { inicioMix: posA, duracaoMix: Math.min(plano.duracaoMix, resta) });
        posP = plano.entrada;
      }
      plano = Object.assign({}, plano, { formato, params: formato === A.PERSONALIZADO ? Object.assign({}, paramsCurva) : null });   // congela o formato (e os pontos) escolhidos para esta transição
      tc.definirTaxa(proxima.letra, plano.taxaProxima);
      tc.buscar(proxima.letra, Math.max(0, posP));
      fixarGanho(proxima.letra, 0, t0);
      tc.tocar(proxima.letra);
      mixando = true;
      agendarCurvas(0, t0 + Math.max(0, (plano.inicioMix - posA) / taxaA), t0);
      avisar();
    }

    function concluirMix() {
      const t = tc.relogio();
      tc.pausar(atual.letra); tc.descarregar(atual.letra);
      fixarGanho(atual.letra, 0, t); fixarGanho(proxima.letra, 1, t);
      atual = { letra: proxima.letra, faixa: proxima.faixa, duracao: proxima.duracao };
      tocadas.push(atual.faixa);
      consumirFila(proxima);
      proxima = null; plano = null; mixando = false; puladas = []; pontoManual = null;
      avisar();
      return prepararProxima();
    }

    function tick() {
      if (fase !== 'tocando' || !atual) return;
      const t0 = tc.relogio();
      const eA = tc.estado(atual.letra, t0), taxaA = eA.taxa > 0 ? eA.taxa : 1;
      if (mixando) { if (A.progresso(plano, eA.posicao, taxaA) >= 1) concluirMix(); return; }
      if (proxima && plano && eA.posicao >= plano.inicioMix - A.ANTECEDENCIA_S * taxaA) iniciarMix();
    }

    async function comecar() {
      if (fase === 'pausado') { tocarPausar(); return; }
      if (fase !== 'parado') return;
      fase = 'carregando'; erro = ''; avisar();
      const r = await decodificarPulando(() => A.primeiraFaixa(biblioteca.filter((f) => !puladas.includes(f.id)), { aleatorio }));
      if (!r.buffer) { fase = 'parado'; if (r.escolha && !r.escolha.faixa) erro = trm(r.escolha.motivo); avisar(); return; }
      const letra = 'A', t = tc.relogio();
      tc.descarregar('B'); fixarGanho('B', 0, t);
      tc.carregar(letra, r.buffer); tc.definirTaxa(letra, 1); fixarGanho(letra, 1, t);
      atual = { letra, faixa: r.escolha.faixa, duracao: r.buffer.duration };
      tocadas.push(atual.faixa); puladas = []; pontoManual = null;
      tc.tocar(letra);
      fase = 'tocando';
      avisar();
      await prepararProxima();
    }

    function tocarPausar() {
      if (!atual) return comecar();
      const t0 = tc.relogio();
      const soando = mixando ? [atual.letra, proxima.letra] : [atual.letra];
      if (fase === 'tocando') {
        soando.forEach((l) => tc.pausar(l));
        if (mixando) {   // congela os ganhos onde a curva estava
          const e = tc.estado(atual.letra, t0), g = A.ganhos(A.progresso(plano, e.posicao, e.taxa), plano.curva, plano.formato, plano.params);
          fixarGanho(atual.letra, g.saindo, t0); fixarGanho(proxima.letra, g.entrando, t0);
        }
        fase = 'pausado';
      } else if (fase === 'pausado') {
        soando.forEach((l) => tc.tocar(l));
        if (mixando) {
          const t = tc.relogio(), e = tc.estado(atual.letra, t), taxa = e.taxa > 0 ? e.taxa : 1;
          const p = A.progresso(plano, e.posicao, taxa);
          agendarCurvas(p, t + Math.max(0, (plano.inicioMix - e.posicao) / taxa), t);
        }
        fase = 'tocando';
      }
      avisar();
    }

    function mixarAgora() {
      if (!atual || !proxima || mixando) return;
      const t = tc.relogio(), e = tc.estado(atual.letra, t), taxa = e.taxa > 0 ? e.taxa : 1;
      pontoManual = null;
      replanejar(e.posicao + A.ANTECEDENCIA_S * taxa);
      avisar();
      tick();
    }

    // Formato da curva do crossfader (VbMxAutomix.FORMATOS). Vale para a próxima transição: durante o cruzamento fica bloqueado
    // (a curva já está agendada). Inválido = linear.
    function definirFormato(f) {
      if (mixando) return false;
      formato = A.formatoValido(f);
      if (formato === A.PERSONALIZADO && !paramsCurva) formato = A.FORMATO_PADRAO;
      avisar(); return true;
    }
    // Arrastar um ponto: liga o personalizado com estes pontos (vale na próxima transição; bloqueado durante o cruzamento).
    function definirCurva(params) {
      const pn = A.normalizarParams(params);
      if (mixando || !pn) return false;
      paramsCurva = pn; formato = A.PERSONALIZADO; avisar(); return true;
    }

    function outraSugestao() {
      if (!atual || mixando) return Promise.resolve();
      if (proxima) puladas.push(proxima.faixa.id);
      return prepararProxima();
    }
    function escolherManual(faixa) {
      if (!atual || mixando || !faixa || faixa.id === atual.faixa.id) return Promise.resolve();
      return prepararProxima(faixa);
    }
    function definirCompassos(n) {
      compassos = A.compassosValidos(n);
      if (atual && proxima && !mixando) {
        if (pontoManual !== null) pontoManual = Math.min(pontoManual, A.limitesPonto(entradaPonto(tc.relogio())).max);   // mais compassos: o ponto escolhido recua até caber
        replanejar(); avisar();
      } else avisar();
    }
    function definirShuffle(ligado) {
      shuffle = !!ligado;
      if (!shuffle && !mixando && proxima && proxima.escolha.origem !== 'manual' && proxima.escolha.origem !== 'fila') { soltarProxima(); avisar(); return Promise.resolve(); }
      if ((shuffle || fila.length) && atual && !proxima && !preparando && !mixando) return prepararProxima();
      avisar();
      return Promise.resolve();
    }

    function aoTerminar(letra) {
      if (!atual || letra !== atual.letra) return;
      if (mixando) { concluirMix(); return; }
      if (proxima) {   // a faixa acabou antes do ponto (aba congelada, faixa curta demais): corte seco
        const t = tc.relogio();
        tc.descarregar(atual.letra); fixarGanho(atual.letra, 0, t);
        tc.definirTaxa(proxima.letra, 1); tc.buscar(proxima.letra, 0); fixarGanho(proxima.letra, 1, t); tc.tocar(proxima.letra);
        atual = { letra: proxima.letra, faixa: proxima.faixa, duracao: proxima.duracao };
        tocadas.push(atual.faixa);
        consumirFila(proxima);
        proxima = null; plano = null; puladas = []; pontoManual = null;
        avisar();
        prepararProxima();
        return;
      }
      tc.descarregar(atual.letra);
      atual = null; fase = 'parado';
      avisar();
    }

    function definirBiblioteca(faixas) {
      biblioteca = Array.isArray(faixas) ? faixas.slice() : [];
      if (atual && !proxima && !preparando && !mixando && (shuffle || fila.length)) prepararProxima();
      else avisar();
    }

    function estado() {
      const t = atual ? tc.relogio() : 0;   // sem faixa não pergunta o relógio: a tela desenha antes do 1º clique (sem AudioContext)
      let a = null, p = null, pl = null, prog = 0;
      if (atual) {
        const e = tc.estado(atual.letra, t), taxa = e.taxa > 0 ? e.taxa : 1;
        a = { faixa: atual.faixa, letra: atual.letra, posicao: e.posicao, duracao: atual.duracao, taxa,
          bpmSoando: atual.faixa.bpm ? (atual.faixa.grade && atual.faixa.grade.bpm ? atual.faixa.grade.bpm : atual.faixa.bpm) * taxa : null };
        if (plano) {
          prog = mixando ? A.progresso(plano, e.posicao, taxa) : 0;
          pl = { sincroniza: plano.sincroniza, motivo: plano.motivo, inicioMix: plano.inicioMix, duracaoMix: plano.duracaoMix,
            compassos: plano.compassos, pedidos: plano.pedidos, limitado: plano.limitado, pitchProxima: plano.pitchProxima, faltaS: Math.max(0, (plano.inicioMix - e.posicao) / taxa),
            manual: pontoManual !== null, editavel: podeMoverPonto(), limites: mixando ? null : A.limitesPonto(entradaPonto(t)) };
        }
      }
      if (proxima) p = { faixa: proxima.faixa, letra: proxima.letra, motivo: proxima.escolha.motivo, explicacao: proxima.escolha.explicacao || '',
        origem: proxima.escolha.origem, carregando: false };
      else if (preparando) p = { faixa: preparando.faixa, motivo: tr('seguir.preparando'), explicacao: '', origem: '', carregando: true };
      return { fase, shuffle, compassos, formato, params: paramsCurva ? Object.assign({}, paramsCurva) : null, formatoMix: mixando && plano && plano.formato ? plano.formato : formato, paramsMix: mixando && plano && plano.formato ? plano.params || null : paramsCurva ? Object.assign({}, paramsCurva) : null, compassoS: a ? A.duracaoDoCompasso(a.faixa) / a.taxa : 0, mixando, progresso: prog, atual: a, proxima: p, plano: pl, tocadas: tocadas.slice(), fila: fila.map((x) => ({ chave: x.chave, faixa: x.faixa })), erro, podeBuscar: !!(atual && !mixando && fase !== 'carregando') };
    }

    return { definirBiblioteca, comecar, tocarPausar, mixarAgora, outraSugestao, escolherManual, adicionarNaFila, removerDaFila, moverNaFila, limparFila, buscar, definirPontoMixagem, moverPontoMixagem, pontoAutomatico, definirShuffle, definirCompassos, definirFormato, definirCurva, tick, aoTerminar, estado };
  }

  return { criar };
});
