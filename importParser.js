const XLSX = require('xlsx');

const normalize = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toUpperCase();

const firstNonEmpty = (cells) => {
  for (const c of cells) {
    if (String(c).trim() !== '') return String(c).trim();
  }
  return '';
};

const ETAPA_RE = /^(\d+)\s*-?\s*ETAPA\s*-?\s*(.*)$/i;

const KNOWN_HEADER_LABELS = {
  CLIENTE: 'cliente',
  'CODIGO DO ITEM CLIENTE': 'codigoItemCliente',
  'CODIGO DCA': 'codigoDca',
};

const IGNORED_LABELS = new Set([
  'OS', 'QUANTIDADE', 'DATA INICIO', 'DATA',
  'HORA INICIO:', 'HORA FIM:', 'HORA INICIO', 'HORA FIM', 'ORDEM DA ETAPA',
]);

/**
 * Extrai { chicote, etapas, ignoradas } de um workbook de ficha de etapas de chicote.
 * @param {Buffer} buffer conteúdo do arquivo .xlsx
 * @param {string} filename nome original do arquivo, só pra referência no resultado
 */
function parseChicoteWorkbook(buffer, filename) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });

  const chicote = { cliente: '', codigoItemCliente: '', codigoDca: '' };
  const etapas = [];
  const ignoradas = [];

  let currentEtapa = null;
  let collectingInstrucoes = false;
  let ordem = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const label0raw = row[0];
    const label0 = normalize(label0raw);
    const value = firstNonEmpty(row.slice(1));
    const rowIsBlank = label0 === '' && value === '';

    if (rowIsBlank) continue;

    const etapaMatch = String(label0raw || '').trim().match(ETAPA_RE);
    if (etapaMatch) {
      if (currentEtapa) etapas.push(currentEtapa);
      ordem += 1;
      currentEtapa = {
        ordem,
        nome: etapaMatch[2].replace(/^-+\s*/, '').trim(),
        setor: '',
        quemTexto: '',
        colaboradores: null,
        instrucoes: '',
      };
      collectingInstrucoes = false;
      continue;
    }

    if (!currentEtapa) {
      if (KNOWN_HEADER_LABELS[label0]) {
        chicote[KNOWN_HEADER_LABELS[label0]] = value;
      } else if (!IGNORED_LABELS.has(label0) && label0 !== '') {
        ignoradas.push({ linha: i + 1, motivo: 'linha não reconhecida no cabeçalho', conteudo: row.filter((c) => String(c).trim() !== '') });
      }
      continue;
    }

    if (label0 === 'SETOR') {
      currentEtapa.setor = value;
      collectingInstrucoes = false;
    } else if (label0 === 'QUEM') {
      currentEtapa.quemTexto = value;
      const numMatch = value.match(/(\d+)/);
      currentEtapa.colaboradores = numMatch ? parseInt(numMatch[1], 10) : null;
      collectingInstrucoes = false;
    } else if (label0 === 'INSTRUCOES') {
      currentEtapa.instrucoes = value;
      collectingInstrucoes = true;
    } else if (label0 === '' && collectingInstrucoes && value !== '') {
      currentEtapa.instrucoes += '\n' + value;
    } else if (label0 === '' && !collectingInstrucoes) {
      continue;
    } else if (IGNORED_LABELS.has(label0)) {
      collectingInstrucoes = false;
    } else {
      collectingInstrucoes = false;
      ignoradas.push({ linha: i + 1, motivo: 'linha não reconhecida dentro da etapa', conteudo: row.filter((c) => String(c).trim() !== '') });
    }
  }
  if (currentEtapa) etapas.push(currentEtapa);

  return { arquivo: filename, chicote, etapas, ignoradas };
}

module.exports = { parseChicoteWorkbook };
