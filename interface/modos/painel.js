// VbMx — o painel de modos (interface/index.html): a primeira tela do app, onde se escolhe entre o
// Profissional (interface/classico.html, a mesa completa) e o Friends (interface/friends.html, o shuffle que
// mixa sozinho). A escolha fica no localStorage: o último modo vem destacado e, com "abrir direto" marcado, o
// painel é pulado na próxima abertura. Para voltar: o link "Modos" no topo de cada modo abre index.html?escolher,
// que sempre mostra o painel. Contrato: docs/contratos.md § VbMxModos. Teste: node interface/testar-friends.js.
//
// Lógica pura (decidir, lerEscolha, gravarEscolha) + iniciar(documento, janela), chamado no DOMContentLoaded.
(function (raiz, fabrica) {
  const api = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.VbMxModos = api;
  if (typeof document !== 'undefined' && document.addEventListener && document.querySelector) {
    document.addEventListener('DOMContentLoaded', () => { if (document.querySelector('[data-modo]')) api.iniciar(document, window); });
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MODOS = { profissional: 'classico.html', friends: 'friends.html' };
  const CHAVE_MODO = 'vbmx-modo';
  const CHAVE_DIRETO = 'vbmx-modo-direto';

  function lerEscolha(armazem) {
    try {
      const modo = armazem && armazem.getItem(CHAVE_MODO);
      return { modo: MODOS[modo] ? modo : null, direto: !!armazem && armazem.getItem(CHAVE_DIRETO) === '1' && !!MODOS[modo] };
    } catch (e) { return { modo: null, direto: false }; }   // localStorage bloqueado (modo privado): o painel aparece sempre
  }
  function gravarEscolha(armazem, modo, direto) {
    if (!MODOS[modo]) throw new TypeError(`modo desconhecido: ${modo}`);
    try { armazem.setItem(CHAVE_MODO, modo); armazem.setItem(CHAVE_DIRETO, direto ? '1' : '0'); return true; }
    catch (e) { return false; }
  }
  // busca: location.search ('?escolher' força o painel). lido: lerEscolha(…).
  function decidir(entrada) {
    const e = entrada || {}, lido = e.lido || { modo: null, direto: false };
    const forcado = /(^|[?&])escolher(=|&|$)/.test(e.busca || '');
    if (!forcado && lido.direto && MODOS[lido.modo]) return { acao: 'ir', destino: MODOS[lido.modo], lembrado: lido.modo };
    return { acao: 'mostrar', destino: null, lembrado: lido.modo };
  }

  function iniciar(doc, janela) {
    const armazem = (() => { try { return janela.localStorage; } catch (e) { return null; } })();
    const lido = lerEscolha(armazem);
    const d = decidir({ busca: janela.location.search, lido });
    if (d.acao === 'ir') { janela.location.replace(d.destino); return; }
    const direto = doc.querySelector('#abrir-direto');
    if (direto) direto.checked = lido.direto;
    doc.querySelectorAll('[data-modo]').forEach((b) => {
      const modo = b.getAttribute('data-modo');
      if (modo === d.lembrado) {
        b.classList.add('lembrado'); b.setAttribute('aria-describedby', 'ultimo-usado');
        // o selo "último usado" sai do dicionário (painel.css lê data-ultimo); refeito quando o idioma muda
        const i18n = janela.VbMxI18n;
        if (i18n) { const selo = () => b.setAttribute('data-ultimo', i18n.t('painel.ultimo')); selo(); i18n.aoMudar(selo); }
      }
      b.addEventListener('click', (ev) => {
        ev.preventDefault();
        if (armazem) gravarEscolha(armazem, modo, direto && direto.checked);
        janela.location.href = MODOS[modo];
      });
    });
    const foco = doc.querySelector(`[data-modo="${d.lembrado}"]`) || doc.querySelector('[data-modo]');
    if (foco) foco.focus();
  }

  return { MODOS, CHAVE_MODO, CHAVE_DIRETO, lerEscolha, gravarEscolha, decidir, iniciar };
});
