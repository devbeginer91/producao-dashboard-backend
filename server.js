const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const path = require('path');
const AdmZip = require('adm-zip');
const { Pool } = require('pg');
const { parseChicoteWorkbook } = require('./importParser');
require('dotenv').config();
const app = express();
const PORT = process.env.PORT || 5000;
const upload = multer({ storage: multer.memoryStorage() });
const uploadZip = multer({ storage: multer.memoryStorage(), limits: { fileSize: 300 * 1024 * 1024 } });
const uploadDesenhos = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const MIME_POR_EXTENSAO = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  dwg: 'application/acad',
  dxf: 'application/dxf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const formatDateToLocalISO = (date, context = 'unknown') => {
  const d = date ? new Date(date) : new Date();
  if (isNaN(d.getTime()) || (typeof date === 'string' && date.includes('undefined'))) {
    return new Date().toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).slice(0, 19);
  }
  return d.toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).slice(0, 19);
};

const calcularTempo = (inicio, fim = formatDateToLocalISO(new Date())) => {
  const inicioDate = new Date(inicio);
  const fimDate = new Date(fim);
  if (isNaN(inicioDate) || isNaN(fimDate)) {
    return 0;
  }
  const diffMs = fimDate - inicioDate;
  return diffMs < 0 ? 0 : Math.round(diffMs / (1000 * 60));
};

// Como calcularTempo, mas em segundos — usado pelo cronômetro de execução de
// etapa, onde arredondar pra minuto inteiro perde precisão demais.
const calcularTempoSegundos = (inicio, fim = formatDateToLocalISO(new Date())) => {
  const inicioDate = new Date(inicio);
  const fimDate = new Date(fim);
  if (isNaN(inicioDate) || isNaN(fimDate)) {
    return 0;
  }
  const diffMs = fimDate - inicioDate;
  return diffMs < 0 ? 0 : Math.round(diffMs / 1000);
};

app.use((req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://producao-dashboard-backend.onrender.com ws://producao-dashboard-frontend.onrender.com"
  );
  next();
});

app.use(cors({
  origin: ['https://producao-dashboard-frontend.onrender.com', 'http://localhost:3000'],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

app.get('/', (req, res) => {
  res.send('Backend do Controle de Produção está ativo! Acesse a API em /pedidos ou o frontend em /dashboard.');
});

app.use((req, res, next) => {
  next();
});

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL must be set in the environment');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.connect((err) => {
  if (err) {
    console.error('Erro ao conectar ao PostgreSQL:', err.message);
    process.exit(1);
  } else {
    initializeDatabase();
  }
});

const db = {
  run: (sql, params = []) => {
    return new Promise((resolve, reject) => {
      pool.query(sql, params, (err, result) => {
        if (err) reject(err);
        else resolve({ lastID: result.rows[0]?.id, changes: result.rowCount });
      });
    });
  },
  get: (sql, params = []) => {
    return new Promise((resolve, reject) => {
      pool.query(sql, params, (err, result) => {
        if (err) reject(err);
        else resolve(result.rows[0]);
      });
    });
  },
  all: (sql, params = []) => {
    return new Promise((resolve, reject) => {
      pool.query(sql, params, (err, result) => {
        if (err) reject(err);
        else resolve(result.rows);
      });
    });
  }
};

const initializeDatabase = async () => {
  try {
    await db.run(`
      CREATE TABLE IF NOT EXISTS pedidos (
        id SERIAL PRIMARY KEY,
        empresa TEXT NOT NULL,
        numeroOS TEXT NOT NULL,
        dataEntrada TEXT NOT NULL,
        previsaoEntrega TEXT NOT NULL,
        responsavel TEXT,
        status TEXT NOT NULL,
        inicio TEXT NOT NULL,
        tempo FLOAT DEFAULT 0,
        peso FLOAT,
        volume FLOAT,
        dataConclusao TEXT,
        pausado INTEGER DEFAULT 0,
        tempoPausado FLOAT DEFAULT 0,
        dataPausada TEXT,
        dataInicioPausa TEXT
      )
    `);

    await db.run(`
      CREATE TABLE IF NOT EXISTS itens_pedidos (
        id SERIAL PRIMARY KEY,
        pedido_id INTEGER,
        codigoDesenho TEXT NOT NULL,
        quantidadePedido INTEGER NOT NULL,
        quantidadeEntregue INTEGER DEFAULT 0,
        FOREIGN KEY (pedido_id) REFERENCES pedidos(id) ON DELETE CASCADE
      )
    `);

    await db.run(`
      CREATE TABLE IF NOT EXISTS historico_entregas (
        id SERIAL PRIMARY KEY,
        pedido_id INTEGER,
        item_id INTEGER,
        quantidadeEntregue INTEGER NOT NULL,
        dataEdicao TEXT NOT NULL,
        FOREIGN KEY (pedido_id) REFERENCES pedidos(id) ON DELETE CASCADE,
        FOREIGN KEY (item_id) REFERENCES itens_pedidos(id) ON DELETE CASCADE
      )
    `);

    await db.run(`
      CREATE TABLE IF NOT EXISTS historico_observacoes (
        id SERIAL PRIMARY KEY,
        pedido_id INTEGER,
        observacao TEXT NOT NULL,
        dataEdicao TEXT NOT NULL,
        FOREIGN KEY (pedido_id) REFERENCES pedidos(id) ON DELETE CASCADE
      )
    `);

    await db.run(`
      CREATE TABLE IF NOT EXISTS chicotes (
        id SERIAL PRIMARY KEY,
        cliente TEXT NOT NULL,
        codigoItemCliente TEXT NOT NULL,
        codigoDca TEXT,
        arquivoOrigem TEXT,
        criadoEm TEXT NOT NULL,
        atualizadoEm TEXT NOT NULL,
        UNIQUE (cliente, codigoItemCliente)
      )
    `);

    await db.run(`
      CREATE TABLE IF NOT EXISTS etapas_chicote (
        id SERIAL PRIMARY KEY,
        chicote_id INTEGER NOT NULL,
        ordem INTEGER NOT NULL,
        nome TEXT NOT NULL,
        setor TEXT,
        quemTexto TEXT,
        colaboradores INTEGER,
        instrucoes TEXT,
        FOREIGN KEY (chicote_id) REFERENCES chicotes(id) ON DELETE CASCADE
      )
    `);

    await db.run(`
      CREATE TABLE IF NOT EXISTS usuarios_pcp (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        senhaHash TEXT NOT NULL,
        nome TEXT NOT NULL,
        criadoEm TEXT NOT NULL
      )
    `);

    await db.run(`
      CREATE TABLE IF NOT EXISTS colaboradores (
        id SERIAL PRIMARY KEY,
        matricula TEXT NOT NULL UNIQUE,
        nome TEXT NOT NULL,
        setor TEXT NOT NULL,
        criadoEm TEXT NOT NULL
      )
    `);

    await db.run(`ALTER TABLE itens_pedidos ADD COLUMN IF NOT EXISTS chicote_id INTEGER REFERENCES chicotes(id)`);
    await db.run(`ALTER TABLE itens_pedidos ADD COLUMN IF NOT EXISTS prioritario INTEGER DEFAULT 0`);

    await db.run(`
      CREATE TABLE IF NOT EXISTS execucoes_etapa (
        id SERIAL PRIMARY KEY,
        item_pedido_id INTEGER NOT NULL,
        etapa_chicote_id INTEGER NOT NULL,
        colaborador_id INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'em_andamento',
        inicio TEXT NOT NULL,
        tempoAcumulado FLOAT DEFAULT 0,
        dataPausada TEXT,
        dataConclusao TEXT,
        FOREIGN KEY (item_pedido_id) REFERENCES itens_pedidos(id) ON DELETE CASCADE,
        FOREIGN KEY (etapa_chicote_id) REFERENCES etapas_chicote(id) ON DELETE CASCADE,
        FOREIGN KEY (colaborador_id) REFERENCES colaboradores(id) ON DELETE CASCADE
      )
    `);

    // Prioridade/ordem migrou de itens_pedidos pra pedidos (item.prioritario fica sem uso a partir daqui)
    await db.run(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS prioritario INTEGER DEFAULT 0`);
    await db.run(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS ordemPrioridade INTEGER`);

    await db.run(`ALTER TABLE chicotes ADD COLUMN IF NOT EXISTS tempoIdeal FLOAT`);
    await db.run(`ALTER TABLE etapas_chicote ADD COLUMN IF NOT EXISTS tempoIdeal FLOAT`);

    // Módulo Financeiro: OC do cliente (por pedido), valor unitário e faturamento (por item).
    await db.run(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS ocCliente TEXT`);
    await db.run(`ALTER TABLE itens_pedidos ADD COLUMN IF NOT EXISTS valorUnitario FLOAT`);
    // faturado/valorFaturado/dataFaturamento vêm do modelo antigo (faturamento único por item) e
    // ficam como cache do estado mais recente; quantidadeFaturada + historico_faturamentos abaixo
    // são a fonte de verdade, permitindo faturar em mais de uma vez (faturamento parcial).
    await db.run(`ALTER TABLE itens_pedidos ADD COLUMN IF NOT EXISTS faturado INTEGER DEFAULT 0`);
    await db.run(`ALTER TABLE itens_pedidos ADD COLUMN IF NOT EXISTS valorFaturado FLOAT`);
    await db.run(`ALTER TABLE itens_pedidos ADD COLUMN IF NOT EXISTS dataFaturamento TEXT`);
    await db.run(`ALTER TABLE itens_pedidos ADD COLUMN IF NOT EXISTS quantidadeFaturada INTEGER DEFAULT 0`);

    await db.run(`
      CREATE TABLE IF NOT EXISTS historico_faturamentos (
        id SERIAL PRIMARY KEY,
        item_id INTEGER NOT NULL,
        quantidadeFaturada INTEGER NOT NULL,
        valorFaturado FLOAT NOT NULL,
        dataFaturamento TEXT NOT NULL,
        FOREIGN KEY (item_id) REFERENCES itens_pedidos(id) ON DELETE CASCADE
      )
    `);

    // Migração única: itens que já tinham sido faturados no modelo antigo (flag faturado=1,
    // um faturamento só, valor de quantidadeEntregue na época) viram o primeiro evento do
    // histórico, senão eles ficariam com quantidadeFaturada=0 e pareceriam nunca faturados.
    await db.run(`
      INSERT INTO historico_faturamentos (item_id, quantidadeFaturada, valorFaturado, dataFaturamento)
      SELECT id, quantidadeEntregue, valorFaturado, dataFaturamento
      FROM itens_pedidos
      WHERE faturado = 1
        AND valorFaturado IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM historico_faturamentos WHERE item_id = itens_pedidos.id)
    `);
    await db.run(`
      UPDATE itens_pedidos SET quantidadeFaturada = quantidadeEntregue
      WHERE faturado = 1 AND quantidadeFaturada = 0
    `);

    await db.run(`
      CREATE TABLE IF NOT EXISTS financeiro_clientes_ocultos (
        id SERIAL PRIMARY KEY,
        empresa TEXT NOT NULL UNIQUE,
        ocultadoEm TEXT NOT NULL
      )
    `);

    await db.run(`
      CREATE TABLE IF NOT EXISTS desenhos_chicote (
        id SERIAL PRIMARY KEY,
        chicote_id INTEGER REFERENCES chicotes(id) ON DELETE SET NULL,
        cliente TEXT NOT NULL,
        codigoArquivo TEXT NOT NULL,
        nomeArquivo TEXT NOT NULL,
        tipoArquivo TEXT,
        tamanho INTEGER,
        conteudo BYTEA NOT NULL,
        criadoEm TEXT NOT NULL
      )
    `);
    // Ao reimportar/revincular um desenho com o mesmo código pro mesmo chicote, a versão
    // anterior fica com ativo=false (histórico) em vez de ser substituída/perdida.
    await db.run(`ALTER TABLE desenhos_chicote ADD COLUMN IF NOT EXISTS ativo BOOLEAN NOT NULL DEFAULT true`);

    await db.run(`
      CREATE TABLE IF NOT EXISTS avisos_serao (
        id SERIAL PRIMARY KEY,
        data TEXT NOT NULL,
        horarioLimite TEXT NOT NULL,
        criadoEm TEXT NOT NULL
      )
    `);
    await db.run('ALTER TABLE avisos_serao DROP COLUMN IF EXISTS setores');

    await db.run(`
      CREATE TABLE IF NOT EXISTS respostas_serao (
        id SERIAL PRIMARY KEY,
        aviso_id INTEGER NOT NULL REFERENCES avisos_serao(id) ON DELETE CASCADE,
        colaborador_id INTEGER NOT NULL REFERENCES colaboradores(id) ON DELETE CASCADE,
        resposta TEXT NOT NULL,
        respondidoEm TEXT NOT NULL,
        UNIQUE (aviso_id, colaborador_id)
      )
    `);

    await db.run(`
      CREATE TABLE IF NOT EXISTS notificacoes (
        id SERIAL PRIMARY KEY,
        tipo TEXT NOT NULL,
        titulo TEXT NOT NULL,
        mensagem TEXT,
        rota TEXT,
        criadoEm TEXT NOT NULL
      )
    `);
  } catch (err) {
    console.error('Erro ao inicializar o banco:', err.message);
  }
};

const removerAcentos = (str) => (str || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');

const chaveComparacaoEmpresa = (str) => removerAcentos(str).trim().toUpperCase().replace(/\s+/g, ' ');

// Evita duplicar cliente por erro de digitação de acento/caixa/espaço (ex: "PROGAS" vs
// "PROGÁS"): se já existe um cliente com a mesma grafia normalizada, usa a grafia já
// cadastrada; senão, padroniza espaço/caixa mas preserva os acentos digitados (cliente novo).
const resolverNomeEmpresa = async (empresaDigitada) => {
  const digitada = (empresaDigitada || '').trim().replace(/\s+/g, ' ');
  if (!digitada) return digitada;
  const chave = chaveComparacaoEmpresa(digitada);
  const existentes = await db.all('SELECT DISTINCT empresa FROM pedidos');
  const match = existentes.find((e) => chaveComparacaoEmpresa(e.empresa) === chave);
  return match ? match.empresa : digitada.toUpperCase();
};

// Compara como texto (formato "YYYY-MM-DD HH:MM:SS", igual ao formatDateToLocalISO) em vez
// de "new Date(horarioLimite) < new Date()": o servidor (Render) roda em UTC, então parsear a
// string sem fuso explícito e comparar como Date daria o horário limite como 3h mais cedo do
// que o combinado em horário de Brasília.
const avisoSeraoExpirado = (horarioLimite) => horarioLimite < formatDateToLocalISO(new Date());

// Formata "YYYY-MM-DD"/"YYYY-MM-DD HH:MM:SS" direto como texto, sem passar por
// `new Date(...)` — pelo mesmo motivo do avisoSeraoExpirado acima: essas strings já
// representam horário de Brasília, e parsear como Date no servidor (UTC) desloca 3h.
const formatarDataBR = (dataISO) => {
  const [ano, mes, dia] = dataISO.split('-');
  return `${dia}/${mes}/${ano}`;
};
const formatarDataHoraBR = (dataHoraTexto) => {
  const [dataParte, horaParte] = dataHoraTexto.split(' ');
  return `${formatarDataBR(dataParte)}, ${horaParte.slice(0, 5)}`;
};

// Central de notificações (sino admin/PCP) — chamada a partir dos mesmos pontos
// que já disparam e-mail, em vez de duplicar a lógica de detecção de evento.
const criarNotificacao = async ({ tipo, titulo, mensagem, rota }) => {
  try {
    const criadoEm = formatDateToLocalISO(new Date(), 'notificacao');
    await db.run(
      'INSERT INTO notificacoes (tipo, titulo, mensagem, rota, criadoEm) VALUES ($1, $2, $3, $4, $5)',
      [tipo, titulo, mensagem || null, rota || null, criadoEm]
    );
  } catch (error) {
    console.error('Erro ao criar notificação:', error.message);
  }
};

const converterFormatoData = (dataInput) => {
  if (!dataInput || typeof dataInput !== 'string' || dataInput.includes('undefined')) {
    return new Date().toISOString().slice(0, 19).replace('T', ' ');
  }

  const isoFormatRegex = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
  if (isoFormatRegex.test(dataInput)) {
    const parsedDate = new Date(dataInput);
    if (!isNaN(parsedDate)) {
      return dataInput;
    }
  }

  const parsedDate = new Date(dataInput);
  if (!isNaN(parsedDate)) {
    return parsedDate.toISOString().slice(0, 19).replace('T', ' ');
  }

  return new Date().toISOString().slice(0, 19).replace('T', ' ');
};

const montarEmail = (pedido, itens, observacao, quantidadesEditadas) => {
  const detalhesPedido = `
    Detalhes do Pedido:
    - Empresa: ${pedido.empresa || 'Não informado'}
    - Número da OS: ${pedido.numeroOS || 'Não informado'}
    - Data de Entrada: ${pedido.dataEntrada ? new Date(pedido.dataEntrada).toLocaleDateString('pt-BR') : 'Não informado'}
    - Previsão de Entrega: ${pedido.previsaoEntrega ? new Date(pedido.previsaoEntrega).toLocaleDateString('pt-BR') : 'Não informado'}
    - Responsável: ${pedido.responsavel || 'Não informado'}
    - Status: ${pedido.status || 'Não informado'}
    - Início: ${pedido.inicio}
    ${pedido.dataConclusao ? `- Conclusão: ${pedido.dataConclusao}` : ''}
    - Tempo (min): ${pedido.tempo || 0}
    - Pausado: ${pedido.pausado ? 'Sim' : 'Não'}
    - Tempo Pausado (min): ${pedido.tempoPausado || 0}
    Itens:
    ${itens.map(item => `- Código: ${item.codigoDesenho}, Qtd Pedida: ${item.quantidadePedido}, Qtd Entregue: ${item.quantidadeEntregue}, Saldo: ${item.quantidadePedido - item.quantidadeEntregue}`).join('\n')}
  `;

  const quantidadesEditadasText = quantidadesEditadas && quantidadesEditadas.length > 0 ? `
    Quantidade Editada:
    ${quantidadesEditadas.map(edit => `- Código: ${edit.codigoDesenho}, QTD: ${edit.quantidade}, Peso: ${pedido.peso || 'Não informado'}, Volume: ${pedido.volume || 'Não informado'}`).join('\n')}
  ` : '';

  const observacaoText = observacao ? `${observacao}\n\n` : '';
  return `${observacaoText}${detalhesPedido}${quantidadesEditadasText}`.trim();
};

if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
  throw new Error('EMAIL_USER and EMAIL_PASS must be set in the environment');
}

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

if (!process.env.AUTH_USERNAME || !process.env.AUTH_PASSWORD) {
  throw new Error('AUTH_USERNAME and AUTH_PASSWORD must be set in the environment');
}

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.AUTH_USERNAME && password === process.env.AUTH_PASSWORD) {
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false });
  }
});

app.get('/pcp/usuarios', async (req, res) => {
  try {
    const usuarios = await db.all('SELECT id, username, nome, criadoEm FROM usuarios_pcp ORDER BY nome');
    res.json(usuarios.map((u) => ({ id: u.id, username: u.username, nome: u.nome, criadoEm: u.criadoem })));
  } catch (error) {
    console.error('Erro ao listar usuários PCP:', error.message);
    res.status(500).json({ message: 'Erro ao listar usuários PCP', error: error.message });
  }
});

app.delete('/pcp/usuarios/:id', async (req, res) => {
  try {
    const resultado = await db.run('DELETE FROM usuarios_pcp WHERE id = $1', [req.params.id]);
    if (resultado.changes === 0) {
      return res.status(404).json({ message: 'Usuário PCP não encontrado' });
    }
    res.json({ sucesso: true });
  } catch (error) {
    console.error('Erro ao remover usuário PCP:', error.message);
    res.status(500).json({ message: 'Erro ao remover usuário PCP', error: error.message });
  }
});

app.post('/pcp/usuarios', async (req, res) => {
  const { username, senha, nome } = req.body;
  if (!username || !senha || !nome) {
    return res.status(400).json({ message: 'Usuário, senha e nome são obrigatórios.' });
  }
  try {
    const senhaHash = await bcrypt.hash(senha, 10);
    const criadoEm = formatDateToLocalISO(new Date(), 'pcp-usuario');
    const result = await db.get(
      'INSERT INTO usuarios_pcp (username, senhaHash, nome, criadoEm) VALUES ($1, $2, $3, $4) RETURNING id, username, nome',
      [username, senhaHash, nome, criadoEm]
    );
    res.status(201).json(result);
  } catch (error) {
    if (error.message.includes('duplicate key')) {
      return res.status(409).json({ message: 'Já existe uma conta de PCP com esse usuário.' });
    }
    console.error('Erro ao criar usuário PCP:', error.message);
    res.status(500).json({ message: 'Erro ao criar usuário PCP', error: error.message });
  }
});

app.post('/pcp/login', async (req, res) => {
  const { username, senha } = req.body;
  try {
    const usuario = await db.get('SELECT id, username, nome, senhahash FROM usuarios_pcp WHERE username = $1', [username]);
    if (!usuario) {
      return res.status(401).json({ message: 'Usuário ou senha incorretos.' });
    }
    const senhaCorreta = await bcrypt.compare(senha || '', usuario.senhahash);
    if (!senhaCorreta) {
      return res.status(401).json({ message: 'Usuário ou senha incorretos.' });
    }
    res.json({ id: usuario.id, username: usuario.username, nome: usuario.nome });
  } catch (error) {
    console.error('Erro ao autenticar PCP:', error.message);
    res.status(500).json({ message: 'Erro ao autenticar', error: error.message });
  }
});

app.get('/colaboradores', async (req, res) => {
  try {
    const colaboradores = await db.all('SELECT id, matricula, nome, setor, criadoEm FROM colaboradores ORDER BY nome');
    res.json(colaboradores.map((c) => ({
      id: c.id,
      matricula: c.matricula,
      nome: c.nome,
      setor: c.setor,
      criadoEm: c.criadoem,
    })));
  } catch (error) {
    console.error('Erro ao listar colaboradores:', error.message);
    res.status(500).json({ message: 'Erro ao listar colaboradores', error: error.message });
  }
});

app.get('/colaboradores/:id/execucoes', async (req, res) => {
  try {
    const colaborador = await db.get('SELECT id, nome, matricula FROM colaboradores WHERE id = $1', [req.params.id]);
    if (!colaborador) {
      return res.status(404).json({ message: 'Colaborador não encontrado' });
    }
    const execucoes = await db.all(
      `SELECT ex.id, ex.status, ex.inicio, ex.dataConclusao, ex.tempoAcumulado,
              ec.nome AS etapaNome, c.cliente, c.codigoItemCliente, p.empresa, p.numeroOS
       FROM execucoes_etapa ex
       JOIN etapas_chicote ec ON ec.id = ex.etapa_chicote_id
       JOIN chicotes c ON c.id = ec.chicote_id
       JOIN itens_pedidos ip ON ip.id = ex.item_pedido_id
       JOIN pedidos p ON p.id = ip.pedido_id
       WHERE ex.colaborador_id = $1
       ORDER BY ex.inicio DESC`,
      [req.params.id]
    );
    res.json({
      colaborador: { id: colaborador.id, nome: colaborador.nome, matricula: colaborador.matricula },
      execucoes: execucoes.map((ex) => ({
        id: ex.id,
        status: ex.status,
        inicio: ex.inicio,
        dataConclusao: ex.dataconclusao,
        tempoSegundos: Number(ex.tempoacumulado) || 0,
        etapaNome: ex.etapanome,
        cliente: ex.cliente,
        codigoItemCliente: ex.codigoitemcliente,
        empresa: ex.empresa,
        numeroOS: ex.numeroos,
      })),
    });
  } catch (error) {
    console.error('Erro ao buscar execuções do colaborador:', error.message);
    res.status(500).json({ message: 'Erro ao buscar execuções do colaborador', error: error.message });
  }
});

app.delete('/execucoes-etapa/:id', async (req, res) => {
  try {
    const resultado = await db.run('DELETE FROM execucoes_etapa WHERE id = $1', [req.params.id]);
    if (resultado.changes === 0) {
      return res.status(404).json({ message: 'Execução não encontrada' });
    }
    res.json({ sucesso: true });
  } catch (error) {
    console.error('Erro ao remover execução:', error.message);
    res.status(500).json({ message: 'Erro ao remover execução', error: error.message });
  }
});

app.delete('/colaboradores/:id', async (req, res) => {
  try {
    // colaborador_id em execucoes_etapa é ON DELETE CASCADE — apagar aqui apagaria
    // junto todo o histórico de execuções/tempos desse colaborador. Por padrão bloqueia
    // se já existir alguma; passando ?apagarHistorico=true o admin confirma que quer
    // apagar login e histórico juntos (ex: colaborador de teste).
    const temExecucoes = await db.all(
      'SELECT id FROM execucoes_etapa WHERE colaborador_id = $1',
      [req.params.id]
    );
    if (temExecucoes.length > 0 && req.query.apagarHistorico !== 'true') {
      return res.status(409).json({
        message: 'Esse colaborador já tem histórico de execuções registrado.',
        execucoes: temExecucoes.length,
      });
    }
    const resultado = await db.run('DELETE FROM colaboradores WHERE id = $1', [req.params.id]);
    if (resultado.changes === 0) {
      return res.status(404).json({ message: 'Colaborador não encontrado' });
    }
    res.json({ sucesso: true });
  } catch (error) {
    console.error('Erro ao remover colaborador:', error.message);
    res.status(500).json({ message: 'Erro ao remover colaborador', error: error.message });
  }
});

app.post('/colaboradores', async (req, res) => {
  const { matricula, nome, setor } = req.body;
  if (!matricula || !nome || !setor) {
    return res.status(400).json({ message: 'Matrícula, nome e setor são obrigatórios.' });
  }
  try {
    const criadoEm = formatDateToLocalISO(new Date(), 'colaborador');
    const result = await db.get(
      'INSERT INTO colaboradores (matricula, nome, setor, criadoEm) VALUES ($1, $2, $3, $4) RETURNING id, matricula, nome, setor',
      [matricula, nome, setor, criadoEm]
    );
    res.status(201).json(result);
  } catch (error) {
    if (error.message.includes('duplicate key')) {
      return res.status(409).json({ message: 'Já existe um colaborador cadastrado com essa matrícula.' });
    }
    console.error('Erro ao cadastrar colaborador:', error.message);
    res.status(500).json({ message: 'Erro ao cadastrar colaborador', error: error.message });
  }
});

app.post('/colaboradores/login', async (req, res) => {
  const { matricula, senha } = req.body;
  if (senha !== process.env.COLABORADOR_SENHA_PADRAO) {
    return res.status(401).json({ message: 'Matrícula ou senha incorretos.' });
  }
  try {
    const colaborador = await db.get('SELECT id, matricula, nome, setor FROM colaboradores WHERE matricula = $1', [matricula]);
    if (!colaborador) {
      return res.status(401).json({ message: 'Matrícula ou senha incorretos.' });
    }
    res.json(colaborador);
  } catch (error) {
    console.error('Erro ao autenticar colaborador:', error.message);
    res.status(500).json({ message: 'Erro ao autenticar', error: error.message });
  }
});

app.get('/notificacoes', async (req, res) => {
  try {
    const notificacoes = await db.all('SELECT * FROM notificacoes ORDER BY id DESC LIMIT 50');
    res.json(notificacoes.map((n) => ({
      id: n.id,
      tipo: n.tipo,
      titulo: n.titulo,
      mensagem: n.mensagem,
      rota: n.rota,
      criadoEm: n.criadoem,
    })));
  } catch (error) {
    console.error('Erro ao listar notificações:', error.message);
    res.status(500).json({ message: 'Erro ao listar notificações', error: error.message });
  }
});

const RESPOSTAS_SERAO_VALIDAS = new Set(['nao_vai', 'ate_1825', 'ate_1930', 'ate_2000', 'ate_2100']);
const RESPOSTAS_SERAO_LABELS = {
  nao_vai: 'Não vou ficar',
  ate_1825: 'Vou ficar até 18:25',
  ate_1930: 'Vou ficar até 19:30',
  ate_2000: 'Vou ficar até 20:00',
  ate_2100: 'Vou ficar até 21:00',
};

app.post('/avisos-serao', async (req, res) => {
  const { data, horarioLimite } = req.body;
  if (!data || !horarioLimite) {
    return res.status(400).json({ message: 'Data e horário limite são obrigatórios.' });
  }
  try {
    const criadoEm = formatDateToLocalISO(new Date(), 'aviso-serao');
    const result = await db.get(
      'INSERT INTO avisos_serao (data, horarioLimite, criadoEm) VALUES ($1, $2, $3) RETURNING id',
      [data, horarioLimite, criadoEm]
    );

    const dataFormatada = formatarDataBR(data);
    const horarioLimiteFormatado = formatarDataHoraBR(horarioLimite);

    try {
      const rawEmailTo = (process.env.EMAIL_TO || 'danielalves@dcachicoteseletricos.com.br').replace(/\s+/g, '');
      const destinatarios = rawEmailTo.split(',').map((e) => e.trim()).filter((e) => e.length > 0 && e.includes('@'));
      for (const destinatario of destinatarios) {
        await transporter.sendMail({
          from: `"Controle de Produção" <${process.env.EMAIL_USER || 'dcashopecia@gmail.com'}>`,
          to: destinatario,
          subject: `Novo aviso de serão — ${dataFormatada}`,
          text: `Um novo aviso de serão foi cadastrado.\n\nData do serão: ${dataFormatada}\nColaboradores podem responder até: ${horarioLimiteFormatado}`,
        });
      }
    } catch (emailError) {
      console.error('Erro ao enviar e-mail de aviso de serão:', emailError.message);
    }

    await criarNotificacao({
      tipo: 'serao_criado',
      titulo: `Novo aviso de serão — ${dataFormatada}`,
      mensagem: `Colaboradores podem responder até ${horarioLimiteFormatado}`,
      rota: '/avisos-serao',
    });

    res.status(201).json({ id: result.id, data, horarioLimite, criadoEm });
  } catch (error) {
    console.error('Erro ao criar aviso de serão:', error.message);
    res.status(500).json({ message: 'Erro ao criar aviso de serão', error: error.message });
  }
});

app.get('/avisos-serao', async (req, res) => {
  try {
    const avisos = await db.all('SELECT * FROM avisos_serao ORDER BY data DESC, id DESC');
    const totalColaboradores = await db.get('SELECT COUNT(*)::int AS total FROM colaboradores');
    const resultado = [];
    for (const aviso of avisos) {
      const respondidos = await db.get(
        'SELECT COUNT(DISTINCT colaborador_id)::int AS total FROM respostas_serao WHERE aviso_id = $1',
        [aviso.id]
      );
      resultado.push({
        id: aviso.id,
        data: aviso.data,
        horarioLimite: aviso.horariolimite,
        criadoEm: aviso.criadoem,
        totalConvocados: totalColaboradores.total,
        totalRespondidos: respondidos.total,
      });
    }
    res.json(resultado);
  } catch (error) {
    console.error('Erro ao listar avisos de serão:', error.message);
    res.status(500).json({ message: 'Erro ao listar avisos de serão', error: error.message });
  }
});

app.get('/avisos-serao/:id', async (req, res) => {
  try {
    const aviso = await db.get('SELECT * FROM avisos_serao WHERE id = $1', [req.params.id]);
    if (!aviso) {
      return res.status(404).json({ message: 'Aviso não encontrado' });
    }
    const colaboradores = await db.all(
      `SELECT col.id, col.nome, col.matricula, col.setor, rs.resposta, rs.respondidoEm
       FROM colaboradores col
       LEFT JOIN respostas_serao rs ON rs.colaborador_id = col.id AND rs.aviso_id = $1
       ORDER BY col.setor, col.nome`,
      [aviso.id]
    );
    res.json({
      id: aviso.id,
      data: aviso.data,
      horarioLimite: aviso.horariolimite,
      criadoEm: aviso.criadoem,
      colaboradores: colaboradores.map((c) => ({
        id: c.id,
        nome: c.nome,
        matricula: c.matricula,
        setor: c.setor,
        resposta: c.resposta,
        respondidoEm: c.respondidoem,
      })),
    });
  } catch (error) {
    console.error('Erro ao buscar aviso de serão:', error.message);
    res.status(500).json({ message: 'Erro ao buscar aviso de serão', error: error.message });
  }
});

app.delete('/avisos-serao/:id', async (req, res) => {
  try {
    const resultado = await db.run('DELETE FROM avisos_serao WHERE id = $1', [req.params.id]);
    if (resultado.changes === 0) {
      return res.status(404).json({ message: 'Aviso não encontrado' });
    }
    res.json({ sucesso: true });
  } catch (error) {
    console.error('Erro ao encerrar aviso de serão:', error.message);
    res.status(500).json({ message: 'Erro ao encerrar aviso de serão', error: error.message });
  }
});

app.get('/avisos-serao-ativos', async (req, res) => {
  const { colaboradorId } = req.query;
  try {
    const avisos = await db.all('SELECT * FROM avisos_serao ORDER BY data');
    const resultado = [];
    for (const aviso of avisos) {
      let respostaAtual = null;
      if (colaboradorId) {
        const resposta = await db.get(
          'SELECT resposta FROM respostas_serao WHERE aviso_id = $1 AND colaborador_id = $2',
          [aviso.id, colaboradorId]
        );
        respostaAtual = resposta ? resposta.resposta : null;
      }
      resultado.push({
        id: aviso.id,
        data: aviso.data,
        horarioLimite: aviso.horariolimite,
        respostaAtual,
        expirado: avisoSeraoExpirado(aviso.horariolimite),
      });
    }
    res.json(resultado);
  } catch (error) {
    console.error('Erro ao buscar avisos de serão ativos:', error.message);
    res.status(500).json({ message: 'Erro ao buscar avisos de serão ativos', error: error.message });
  }
});

app.put('/avisos-serao/:id/resposta', async (req, res) => {
  const { colaboradorId, resposta } = req.body;
  if (!colaboradorId || !RESPOSTAS_SERAO_VALIDAS.has(resposta)) {
    return res.status(400).json({ message: 'Colaborador e resposta válida são obrigatórios.' });
  }
  try {
    const aviso = await db.get('SELECT * FROM avisos_serao WHERE id = $1', [req.params.id]);
    if (!aviso) {
      return res.status(404).json({ message: 'Aviso não encontrado' });
    }
    if (avisoSeraoExpirado(aviso.horariolimite)) {
      return res.status(403).json({ message: 'O horário limite pra responder esse aviso já passou.' });
    }
    const colaborador = await db.get('SELECT id, nome FROM colaboradores WHERE id = $1', [colaboradorId]);
    if (!colaborador) {
      return res.status(404).json({ message: 'Colaborador não encontrado' });
    }
    const respondidoEm = formatDateToLocalISO(new Date(), 'resposta-serao');
    await db.run(
      `INSERT INTO respostas_serao (aviso_id, colaborador_id, resposta, respondidoEm)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (aviso_id, colaborador_id) DO UPDATE SET resposta = $3, respondidoEm = $4`,
      [req.params.id, colaboradorId, resposta, respondidoEm]
    );
    await criarNotificacao({
      tipo: 'serao_resposta',
      titulo: `${colaborador.nome} respondeu ao serão`,
      mensagem: RESPOSTAS_SERAO_LABELS[resposta] || resposta,
      rota: '/avisos-serao',
    });
    res.json({ sucesso: true, resposta });
  } catch (error) {
    console.error('Erro ao registrar resposta de serão:', error.message);
    res.status(500).json({ message: 'Erro ao registrar resposta de serão', error: error.message });
  }
});

app.get('/pedidos/empresas', async (req, res) => {
  try {
    const linhas = await db.all('SELECT DISTINCT empresa FROM pedidos ORDER BY empresa');
    res.json(linhas.map((l) => l.empresa));
  } catch (error) {
    console.error('Erro ao listar empresas:', error.message);
    res.status(500).json({ message: 'Erro ao listar empresas', error: error.message });
  }
});

app.get('/pedidos', async (req, res) => {
  try {
    const { empresa, id, faturado } = req.query;
    const filtrado = Boolean(empresa || id);
    const pedidos = id
      ? await db.all('SELECT * FROM pedidos WHERE id = $1', [parseInt(id)])
      : empresa
      ? await db.all('SELECT * FROM pedidos WHERE empresa = $1', [empresa])
      : await db.all('SELECT * FROM pedidos');
    const pedidoIds = pedidos.map((p) => p.id);
    // faturado=false: itens com saldo a faturar (quantidadeFaturada < quantidadePedido).
    // faturado=true: itens já faturados ao menos uma vez (quantidadeFaturada > 0) — um item
    // pode aparecer nos dois casos ao mesmo tempo quando foi faturado parcialmente.
    // Usado pelo Financeiro pra não carregar (e reprocessar produção de) todo o histórico
    // já faturado de um cliente antigo de uma vez.
    const itens = filtrado
      ? (pedidoIds.length === 0
          ? []
          : faturado === 'false'
          ? await db.all('SELECT * FROM itens_pedidos WHERE pedido_id = ANY($1::int[]) AND quantidadeFaturada < quantidadePedido', [pedidoIds])
          : faturado === 'true'
          ? await db.all('SELECT * FROM itens_pedidos WHERE pedido_id = ANY($1::int[]) AND quantidadeFaturada > 0', [pedidoIds])
          : await db.all('SELECT * FROM itens_pedidos WHERE pedido_id = ANY($1::int[])', [pedidoIds]))
      : await db.all('SELECT * FROM itens_pedidos');
    const obsCounts = await db.all('SELECT pedido_id, COUNT(*)::int AS count FROM historico_observacoes GROUP BY pedido_id');
    const obsCountMap = new Map(obsCounts.map(o => [o.pedido_id, o.count]));

    const chicoteIds = [...new Set(itens.filter((i) => i.chicote_id).map((i) => i.chicote_id))];
    const itemIdsComChicote = itens.filter((i) => i.chicote_id).map((i) => i.id);
    const producaoPorItem = new Map();
    if (itemIdsComChicote.length > 0) {
      const etapasChicotes = await db.all(
        'SELECT id, chicote_id, ordem, nome FROM etapas_chicote WHERE chicote_id = ANY($1::int[]) ORDER BY ordem',
        [chicoteIds]
      );
      const execucoesItens = await db.all(
        `SELECT ex.*, col.nome AS colaboradorNome FROM execucoes_etapa ex
         JOIN colaboradores col ON col.id = ex.colaborador_id
         WHERE ex.item_pedido_id = ANY($1::int[])`,
        [itemIdsComChicote]
      );
      itens.filter((i) => i.chicote_id).forEach((item) => {
        const etapasDoItem = etapasChicotes.filter((e) => e.chicote_id === item.chicote_id);
        const execucoesDoItem = execucoesItens.filter((ex) => ex.item_pedido_id === item.id);
        const temExecucaoAtiva = execucoesDoItem.some((ex) => ex.status !== 'concluido');
        const etapasConcluidas = [];
        let todasConcluidas = etapasDoItem.length > 0;
        let somaTempoMedio = 0;
        etapasDoItem.forEach((e) => {
          const execucoesDaEtapa = execucoesDoItem.filter((ex) => ex.etapa_chicote_id === e.id);
          const concluidas = execucoesDaEtapa.filter((ex) => ex.status === 'concluido');
          if (concluidas.length === 0) {
            todasConcluidas = false;
            return;
          }
          const tempoMedio = concluidas.reduce((soma, ex) => soma + (Number(ex.tempoacumulado) || 0), 0) / concluidas.length;
          somaTempoMedio += tempoMedio;
          etapasConcluidas.push({
            nome: e.nome,
            tempoSegundos: Math.round(tempoMedio),
            colaboradores: [...new Set(concluidas.map((ex) => ex.colaboradornome))],
          });
        });
        const qtd = Number(item.quantidadepedido);
        const tempoTotalReal = todasConcluidas && qtd > 0 ? Math.round(somaTempoMedio / qtd) : null;
        producaoPorItem.set(item.id, {
          totalEtapas: etapasDoItem.length,
          etapasConcluidas,
          temExecucaoAtiva,
          tempoTotalReal,
        });
      });
    }

    const pedidosComItens = pedidos.map(pedido => {
      const tempoPausado = Number(pedido.tempopausado) || 0;
      let tempoFinal = tempoPausado;
      if (pedido.status === 'concluido') {
        tempoFinal = Number(pedido.tempo) || 0;
      } else if (pedido.status === 'andamento' && pedido.pausado !== '1') {
        const dataReferencia = pedido.datapausada || pedido.inicio;
        const tempoDecorrido = calcularTempo(dataReferencia, formatDateToLocalISO(new Date()));
        tempoFinal = tempoPausado + tempoDecorrido;
      }
      return {
        ...pedido,
        numeroOS: pedido.numeroos,
        dataEntrada: pedido.dataentrada,
        previsaoEntrega: pedido.previsaoentrega,
        dataConclusao: pedido.dataconclusao,
        dataPausada: pedido.datapausada,
        dataInicioPausa: pedido.datainiciopausa,
        inicio: converterFormatoData(pedido.inicio),
        dataConclusao: pedido.dataconclusao ? converterFormatoData(pedido.dataconclusao) : null,
        dataPausada: pedido.datapausada ? converterFormatoData(pedido.datapausada) : null,
        dataInicioPausa: pedido.datainiciopausa ? converterFormatoData(pedido.datainiciopausa) : null,
        tempo: tempoFinal,
        tempoPausado: tempoPausado,
        pausado: pedido.pausado ? pedido.pausado.toString() : '0',
        prioritario: pedido.prioritario === 1 || pedido.prioritario === true,
        ordemPrioridade: pedido.ordemprioridade,
        ocCliente: pedido.occliente,
        observacoesCount: obsCountMap.get(pedido.id) || 0,
        itens: itens.filter(item => item.pedido_id === pedido.id).map(item => ({
          ...item,
          codigoDesenho: item.codigodesenho,
          quantidadePedido: item.quantidadepedido,
          quantidadeEntregue: item.quantidadeentregue,
          chicoteId: item.chicote_id,
          valorUnitario: item.valorunitario,
          faturado: item.faturado === 1 || item.faturado === true,
          quantidadeFaturada: item.quantidadefaturada || 0,
          valorFaturado: item.valorfaturado,
          dataFaturamento: item.datafaturamento,
          producao: producaoPorItem.get(item.id) || null,
        }))
      };
    });
    res.json(pedidosComItens);
  } catch (err) {
    console.error('Erro ao listar pedidos:', err.message);
    res.status(500).json({ message: 'Erro ao listar pedidos', error: err.message });
  }
});

app.get('/financeiro/resumo', async (req, res) => {
  try {
    // Só itens com saldo a faturar (quantidadeFaturada < quantidadePedido): cliente 100%
    // faturado nem entra na soma, então some da lista sozinho — sem precisar listar todo
    // mundo e filtrar depois. Cliente com item sem valorUnitario ainda cadastrado continua
    // aparecendo (soma 0), que é o gancho pra entrar nele e preencher os valores.
    const itens = await db.all(
      `SELECT ip.quantidadePedido, ip.quantidadeFaturada, ip.valorUnitario, p.empresa
       FROM itens_pedidos ip
       JOIN pedidos p ON p.id = ip.pedido_id
       WHERE ip.quantidadeFaturada < ip.quantidadePedido`
    );
    const ocultos = await db.all('SELECT empresa FROM financeiro_clientes_ocultos');
    const ocultosSet = new Set(ocultos.map((o) => o.empresa));

    const porCliente = new Map();
    itens.forEach((item) => {
      if (ocultosSet.has(item.empresa)) return;
      const saldoAFaturar = Number(item.quantidadepedido) - Number(item.quantidadefaturada || 0);
      const valorAberto = item.valorunitario == null ? 0 : saldoAFaturar * Number(item.valorunitario);
      porCliente.set(item.empresa, (porCliente.get(item.empresa) || 0) + valorAberto);
    });

    const clientes = Array.from(porCliente.entries())
      .map(([empresa, valorEmAberto]) => ({ empresa, valorEmAberto }))
      .sort((a, b) => b.valorEmAberto - a.valorEmAberto || a.empresa.localeCompare(b.empresa));
    const totalGeral = clientes.reduce((soma, c) => soma + c.valorEmAberto, 0);

    res.json({ clientes, totalGeral });
  } catch (err) {
    console.error('Erro ao gerar resumo financeiro:', err.message);
    res.status(500).json({ message: 'Erro ao gerar resumo financeiro', error: err.message });
  }
});

app.get('/financeiro/clientes-ocultos', async (req, res) => {
  try {
    const ocultos = await db.all(
      'SELECT empresa, ocultadoEm FROM financeiro_clientes_ocultos ORDER BY empresa'
    );
    res.json(ocultos.map((o) => ({ empresa: o.empresa, ocultadoEm: o.ocultadoem })));
  } catch (err) {
    console.error('Erro ao listar clientes ocultos:', err.message);
    res.status(500).json({ message: 'Erro ao listar clientes ocultos', error: err.message });
  }
});

app.post('/financeiro/clientes-ocultos', async (req, res) => {
  const { empresa } = req.body;
  if (!empresa) {
    return res.status(400).json({ message: 'Empresa é obrigatória.' });
  }
  try {
    const agora = formatDateToLocalISO(new Date(), 'ocultar-cliente-financeiro');
    await db.run(
      `INSERT INTO financeiro_clientes_ocultos (empresa, ocultadoEm) VALUES ($1, $2)
       ON CONFLICT (empresa) DO NOTHING`,
      [empresa, agora]
    );
    res.json({ sucesso: true });
  } catch (err) {
    console.error('Erro ao ocultar cliente:', err.message);
    res.status(500).json({ message: 'Erro ao ocultar cliente', error: err.message });
  }
});

app.delete('/financeiro/clientes-ocultos/:empresa', async (req, res) => {
  try {
    await db.run('DELETE FROM financeiro_clientes_ocultos WHERE empresa = $1', [req.params.empresa]);
    res.json({ sucesso: true });
  } catch (err) {
    console.error('Erro ao reexibir cliente:', err.message);
    res.status(500).json({ message: 'Erro ao reexibir cliente', error: err.message });
  }
});

app.put('/itens-pedidos/:id/faturar', async (req, res) => {
  // Fatura só o saldo ainda não faturado (quantidadeEntregue - quantidadeFaturada), não o item
  // inteiro — permite chamar esse endpoint várias vezes conforme a produção vai entregando mais,
  // registrando cada chamada como um evento em historico_faturamentos (faturamento parcial).
  const id = parseInt(req.params.id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const itemResult = await client.query('SELECT * FROM itens_pedidos WHERE id = $1 FOR UPDATE', [id]);
    const item = itemResult.rows[0];
    if (!item) {
      throw Object.assign(new Error('Item não encontrado'), { status: 404 });
    }
    if (item.valorunitario === null || item.valorunitario === undefined) {
      throw Object.assign(new Error('Cadastre o valor unitário do item antes de faturar'), { status: 400 });
    }
    const quantidadeFaturadaAtual = item.quantidadefaturada || 0;
    const saldoFaturavel = Number(item.quantidadeentregue || 0) - quantidadeFaturadaAtual;
    if (saldoFaturavel <= 0) {
      throw Object.assign(new Error('Não há quantidade entregue pendente de faturamento pra esse item'), { status: 400 });
    }

    const valorFaturadoEvento = Number(item.valorunitario) * saldoFaturavel;
    const dataFaturamento = formatDateToLocalISO(new Date(), 'faturar-item');
    const novaQuantidadeFaturada = quantidadeFaturadaAtual + saldoFaturavel;
    const novoValorFaturadoTotal = Number(item.valorfaturado || 0) + valorFaturadoEvento;
    const totalmenteFaturado = novaQuantidadeFaturada >= Number(item.quantidadepedido);

    await client.query(
      `INSERT INTO historico_faturamentos (item_id, quantidadeFaturada, valorFaturado, dataFaturamento)
       VALUES ($1, $2, $3, $4)`,
      [id, saldoFaturavel, valorFaturadoEvento, dataFaturamento]
    );
    const updateResult = await client.query(
      `UPDATE itens_pedidos
       SET quantidadeFaturada = $1, valorFaturado = $2, dataFaturamento = $3, faturado = $4
       WHERE id = $5 RETURNING *`,
      [novaQuantidadeFaturada, novoValorFaturadoTotal, dataFaturamento, totalmenteFaturado ? 1 : 0, id]
    );
    const atualizado = updateResult.rows[0];

    await client.query('COMMIT');

    res.json({
      id: atualizado.id,
      quantidadeFaturada: atualizado.quantidadefaturada,
      valorFaturado: atualizado.valorfaturado,
      dataFaturamento: atualizado.datafaturamento,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao faturar item:', error.message);
    res.status(error.status || 500).json({ message: error.message || 'Erro ao faturar item' });
  } finally {
    client.release();
  }
});

app.get('/financeiro/relatorio', async (req, res) => {
  try {
    const { cliente, inicio, fim } = req.query;
    // Cada linha é um evento de faturamento (historico_faturamentos), não o item — um item
    // faturado em duas vezes aparece duas vezes aqui, uma por evento, que é a evidência de
    // faturamento parcial que o relatório precisa mostrar.
    const condicoes = [];
    const params = [];
    if (cliente) {
      params.push(cliente);
      condicoes.push(`p.empresa = $${params.length}`);
    }
    if (inicio) {
      params.push(inicio);
      condicoes.push(`hf.dataFaturamento >= $${params.length}`);
    }
    if (fim) {
      params.push(`${fim} 23:59:59`);
      condicoes.push(`hf.dataFaturamento <= $${params.length}`);
    }
    const where = condicoes.length > 0 ? `WHERE ${condicoes.join(' AND ')}` : '';

    const itens = await db.all(
      `SELECT hf.id, hf.dataFaturamento, hf.valorFaturado, hf.quantidadeFaturada,
              SUM(hf.quantidadeFaturada) OVER (PARTITION BY hf.item_id ORDER BY hf.dataFaturamento, hf.id) AS quantidadeFaturadaAcumulada,
              ip.quantidadePedido, ip.valorUnitario, ip.codigoDesenho, ip.chicote_id,
              p.empresa, p.numeroOS, p.ocCliente, p.dataEntrada
       FROM historico_faturamentos hf
       JOIN itens_pedidos ip ON ip.id = hf.item_id
       JOIN pedidos p ON p.id = ip.pedido_id
       ${where}
       ORDER BY hf.dataFaturamento DESC`,
      params
    );

    const resultado = itens.map((i) => ({
      id: i.id,
      dataFaturamento: i.datafaturamento,
      empresa: i.empresa,
      numeroOS: i.numeroos,
      ocCliente: i.occliente,
      dataEntrada: i.dataentrada,
      codigoDesenho: i.codigodesenho,
      chicoteId: i.chicote_id,
      quantidadeFaturada: i.quantidadefaturada,
      quantidadePedido: i.quantidadepedido,
      valorUnitario: i.valorunitario,
      valorFaturado: i.valorfaturado,
      parcial: Number(i.quantidadefaturadaacumulada) < Number(i.quantidadepedido),
    }));

    const totalFaturado = resultado.reduce((soma, i) => soma + Number(i.valorFaturado), 0);
    const porClienteMap = new Map();
    resultado.forEach((i) => porClienteMap.set(i.empresa, (porClienteMap.get(i.empresa) || 0) + Number(i.valorFaturado)));
    const porCliente = Array.from(porClienteMap.entries())
      .map(([empresa, total]) => ({ empresa, total }))
      .sort((a, b) => b.total - a.total);

    res.json({ itens: resultado, totalFaturado, porCliente });
  } catch (error) {
    console.error('Erro ao gerar relatório de faturamento:', error.message);
    res.status(500).json({ message: 'Erro ao gerar relatório de faturamento', error: error.message });
  }
});

app.put('/pedidos/:id/prioridade', async (req, res) => {
  const id = parseInt(req.params.id);
  const { prioritario } = req.body;
  try {
    const result = await db.run('UPDATE pedidos SET prioritario = $1 WHERE id = $2', [prioritario ? 1 : 0, id]);
    if (result.changes === 0) {
      return res.status(404).json({ message: 'Pedido não encontrado' });
    }
    if (prioritario) {
      const pedido = await db.get('SELECT empresa, numeroOS FROM pedidos WHERE id = $1', [id]);
      await criarNotificacao({
        tipo: 'pcp_prioridade',
        titulo: `OS ${pedido.numeroos} marcada como prioritária`,
        mensagem: pedido.empresa,
        rota: '/priorizar-producao',
      });
    }
    res.json({ id, prioritario: !!prioritario });
  } catch (error) {
    console.error('Erro ao atualizar prioridade do pedido:', error.message);
    res.status(500).json({ message: 'Erro ao atualizar prioridade do pedido', error: error.message });
  }
});

app.put('/pedidos/:id/ordem-prioridade', async (req, res) => {
  const id = parseInt(req.params.id);
  const { ordemPrioridade } = req.body;
  try {
    const result = await db.run('UPDATE pedidos SET ordemPrioridade = $1 WHERE id = $2', [ordemPrioridade ?? null, id]);
    if (result.changes === 0) {
      return res.status(404).json({ message: 'Pedido não encontrado' });
    }
    if (ordemPrioridade != null) {
      const pedido = await db.get('SELECT empresa, numeroOS FROM pedidos WHERE id = $1', [id]);
      await criarNotificacao({
        tipo: 'pcp_prioridade',
        titulo: `Ordem de prioridade da OS ${pedido.numeroos} alterada`,
        mensagem: `${pedido.empresa} — posição ${ordemPrioridade}`,
        rota: '/priorizar-producao',
      });
    }
    res.json({ id, ordemPrioridade: ordemPrioridade ?? null });
  } catch (error) {
    console.error('Erro ao atualizar ordem de prioridade:', error.message);
    res.status(500).json({ message: 'Erro ao atualizar ordem de prioridade', error: error.message });
  }
});

app.post('/chicotes/import/preview', upload.array('arquivos'), async (req, res) => {
  try {
    const arquivos = req.files || [];
    if (arquivos.length === 0) {
      return res.status(400).json({ message: 'Nenhum arquivo enviado.' });
    }

    const resultados = [];
    for (const arquivo of arquivos) {
      let parsed;
      try {
        parsed = parseChicoteWorkbook(arquivo.buffer, arquivo.originalname);
      } catch (parseErr) {
        resultados.push({
          arquivo: arquivo.originalname,
          erroLeitura: parseErr.message,
        });
        continue;
      }

      let existente = false;
      let chicoteIdExistente = null;
      if (parsed.chicote.cliente && parsed.chicote.codigoItemCliente) {
        const row = await db.get(
          'SELECT id FROM chicotes WHERE cliente = $1 AND codigoItemCliente = $2',
          [parsed.chicote.cliente, parsed.chicote.codigoItemCliente]
        );
        if (row) {
          existente = true;
          chicoteIdExistente = row.id;
        }
      }

      resultados.push({ ...parsed, existente, chicoteIdExistente });
    }

    res.json({ resultados });
  } catch (error) {
    console.error('Erro ao analisar arquivos de chicote:', error.message, 'Stack:', error.stack);
    res.status(500).json({ message: 'Erro ao analisar arquivos', error: error.message, stack: error.stack });
  }
});

app.post('/chicotes/import/confirm', async (req, res) => {
  const { itens } = req.body;
  if (!Array.isArray(itens) || itens.length === 0) {
    return res.status(400).json({ message: 'Nenhum item para importar.' });
  }

  const resultados = [];
  const agora = formatDateToLocalISO(new Date(), 'import-chicote');

  for (const item of itens) {
    const { arquivo, chicote, etapas } = item;
    const client = await pool.connect();
    try {
      if (!chicote || !chicote.cliente || !chicote.codigoItemCliente) {
        throw new Error('Cliente e código do item cliente são obrigatórios.');
      }

      await client.query('BEGIN');

      const upsertSql = `
        INSERT INTO chicotes (cliente, codigoItemCliente, codigoDca, arquivoOrigem, criadoEm, atualizadoEm)
        VALUES ($1, $2, $3, $4, $5, $5)
        ON CONFLICT (cliente, codigoItemCliente)
        DO UPDATE SET codigoDca = $3, arquivoOrigem = $4, atualizadoEm = $5
        RETURNING id
      `;
      const upsertResult = await client.query(upsertSql, [
        chicote.cliente,
        chicote.codigoItemCliente,
        chicote.codigoDca || null,
        arquivo || null,
        agora,
      ]);
      const chicoteId = upsertResult.rows[0].id;

      await client.query('DELETE FROM etapas_chicote WHERE chicote_id = $1', [chicoteId]);

      const etapaSql = `
        INSERT INTO etapas_chicote (chicote_id, ordem, nome, setor, quemTexto, colaboradores, instrucoes)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `;
      for (const etapa of etapas || []) {
        await client.query(etapaSql, [
          chicoteId,
          etapa.ordem,
          etapa.nome,
          etapa.setor || null,
          etapa.quemTexto || null,
          etapa.colaboradores,
          etapa.instrucoes || null,
        ]);
      }

      await client.query('COMMIT');
      resultados.push({ arquivo, sucesso: true, chicoteId });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Erro ao importar chicote:', arquivo, error.message);
      resultados.push({ arquivo, sucesso: false, erro: error.message });
    } finally {
      client.release();
    }
  }

  res.json({ resultados });
});

app.post('/desenhos/importar-zip', uploadZip.single('arquivo'), async (req, res) => {
  try {
    const arquivoZip = req.file;
    if (!arquivoZip) {
      return res.status(400).json({ message: 'Nenhum arquivo .zip enviado.' });
    }

    let zip;
    try {
      zip = new AdmZip(arquivoZip.buffer);
    } catch (zipErr) {
      return res.status(400).json({ message: 'Não foi possível ler o arquivo .zip.', error: zipErr.message });
    }

    const chicotes = await db.all('SELECT id, cliente, codigoItemCliente FROM chicotes');
    const chaveChicote = (cliente, codigo) => `${(cliente || '').trim().toLowerCase()}::${(codigo || '').trim().toLowerCase()}`;
    const chicotesPorChave = new Map(chicotes.map((c) => [chaveChicote(c.cliente, c.codigoitemcliente), c.id]));
    // Fallback pra zip sem pasta por cliente: se o código do arquivo bate com um único
    // chicote em toda a base, vincula mesmo assim (é o caso de reimportar/atualizar um
    // desenho já existente sem recriar a estrutura de pastas).
    const chicotesPorCodigo = new Map();
    chicotes.forEach((c) => {
      const chave = (c.codigoitemcliente || '').trim().toLowerCase();
      if (!chicotesPorCodigo.has(chave)) chicotesPorCodigo.set(chave, []);
      chicotesPorCodigo.get(chave).push({ id: c.id, cliente: c.cliente });
    });

    const agora = formatDateToLocalISO(new Date(), 'importar-desenhos');
    const entradas = zip.getEntries().filter((e) => !e.isDirectory);

    let importados = 0;
    let vinculados = 0;
    const arquivosSemVinculo = [];
    const ignorados = [];

    for (const entrada of entradas) {
      const partes = entrada.entryName.split('/').filter(Boolean);
      const nomeArquivo = partes[partes.length - 1];

      if (!nomeArquivo || nomeArquivo.startsWith('.') || partes.some((p) => p.startsWith('__MACOSX'))) {
        continue;
      }

      const cliente = partes.length >= 2 ? partes[0] : null;
      const ext = path.extname(nomeArquivo);
      const codigoArquivo = path.basename(nomeArquivo, ext);
      const conteudo = entrada.getData();

      if (!conteudo || conteudo.length === 0) {
        ignorados.push({ arquivo: entrada.entryName, motivo: 'Arquivo vazio' });
        continue;
      }

      let clienteFinal = cliente || '(sem pasta)';
      let chicoteId = cliente ? chicotesPorChave.get(chaveChicote(cliente, codigoArquivo)) || null : null;
      if (!chicoteId && !cliente) {
        const candidatos = chicotesPorCodigo.get(codigoArquivo.trim().toLowerCase()) || [];
        if (candidatos.length === 1) {
          chicoteId = candidatos[0].id;
          clienteFinal = candidatos[0].cliente;
        }
      }

      if (chicoteId) {
        // Reimportação do mesmo código pro mesmo chicote: arquiva a versão anterior
        // em vez de deixar as duas como "atuais".
        await db.run(
          `UPDATE desenhos_chicote SET ativo = false
           WHERE chicote_id = $1 AND LOWER(codigoArquivo) = LOWER($2) AND ativo = true`,
          [chicoteId, codigoArquivo]
        );
      }

      await db.run(
        `INSERT INTO desenhos_chicote (chicote_id, cliente, codigoArquivo, nomeArquivo, tipoArquivo, tamanho, conteudo, criadoEm, ativo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)`,
        [chicoteId, clienteFinal, codigoArquivo, nomeArquivo, ext.replace('.', '').toLowerCase() || null, conteudo.length, conteudo, agora]
      );

      importados += 1;
      if (chicoteId) {
        vinculados += 1;
      } else {
        arquivosSemVinculo.push({ arquivo: nomeArquivo, cliente: clienteFinal });
      }
    }

    res.json({
      totalArquivos: entradas.length,
      importados,
      vinculados,
      semVinculo: arquivosSemVinculo.length,
      arquivosSemVinculo,
      ignorados,
    });
  } catch (error) {
    console.error('Erro ao importar desenhos:', error.message, error.stack);
    res.status(500).json({ message: 'Erro ao importar desenhos', error: error.message });
  }
});

app.post('/desenhos/importar-arquivos', uploadDesenhos.array('arquivos'), async (req, res) => {
  try {
    const arquivos = req.files || [];
    if (arquivos.length === 0) {
      return res.status(400).json({ message: 'Nenhum arquivo enviado.' });
    }
    const clienteInformado = (req.body.cliente || '').trim() || null;

    const chicotes = await db.all('SELECT id, cliente, codigoItemCliente FROM chicotes');
    const chaveChicote = (cliente, codigo) => `${(cliente || '').trim().toLowerCase()}::${(codigo || '').trim().toLowerCase()}`;
    const chicotesPorChave = new Map(chicotes.map((c) => [chaveChicote(c.cliente, c.codigoitemcliente), c.id]));
    const chicotesPorCodigo = new Map();
    chicotes.forEach((c) => {
      const chave = (c.codigoitemcliente || '').trim().toLowerCase();
      if (!chicotesPorCodigo.has(chave)) chicotesPorCodigo.set(chave, []);
      chicotesPorCodigo.get(chave).push({ id: c.id, cliente: c.cliente });
    });

    const agora = formatDateToLocalISO(new Date(), 'importar-desenhos-arquivos');
    let importados = 0;
    let vinculados = 0;
    const arquivosSemVinculo = [];

    for (const arquivo of arquivos) {
      const ext = path.extname(arquivo.originalname);
      const codigoArquivo = path.basename(arquivo.originalname, ext);
      const conteudo = arquivo.buffer;
      if (!conteudo || conteudo.length === 0) continue;

      let clienteFinal = clienteInformado || '(sem pasta)';
      let chicoteId = clienteInformado ? chicotesPorChave.get(chaveChicote(clienteInformado, codigoArquivo)) || null : null;
      if (!chicoteId && !clienteInformado) {
        const candidatos = chicotesPorCodigo.get(codigoArquivo.trim().toLowerCase()) || [];
        if (candidatos.length === 1) {
          chicoteId = candidatos[0].id;
          clienteFinal = candidatos[0].cliente;
        }
      }

      if (chicoteId) {
        await db.run(
          `UPDATE desenhos_chicote SET ativo = false
           WHERE chicote_id = $1 AND LOWER(codigoArquivo) = LOWER($2) AND ativo = true`,
          [chicoteId, codigoArquivo]
        );
      }

      await db.run(
        `INSERT INTO desenhos_chicote (chicote_id, cliente, codigoArquivo, nomeArquivo, tipoArquivo, tamanho, conteudo, criadoEm, ativo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)`,
        [chicoteId, clienteFinal, codigoArquivo, arquivo.originalname, ext.replace('.', '').toLowerCase() || null, conteudo.length, conteudo, agora]
      );

      importados += 1;
      if (chicoteId) {
        vinculados += 1;
      } else {
        arquivosSemVinculo.push({ arquivo: arquivo.originalname, cliente: clienteFinal });
      }
    }

    res.json({
      totalArquivos: arquivos.length,
      importados,
      vinculados,
      semVinculo: arquivosSemVinculo.length,
      arquivosSemVinculo,
    });
  } catch (error) {
    console.error('Erro ao importar desenhos (arquivos avulsos):', error.message, error.stack);
    res.status(500).json({ message: 'Erro ao importar desenhos', error: error.message });
  }
});

app.get('/desenhos', async (req, res) => {
  try {
    const { chicoteId, cliente, vinculado, ativo } = req.query;
    const params = [];
    const condicoes = [];
    if (chicoteId) {
      params.push(parseInt(chicoteId));
      condicoes.push(`chicote_id = $${params.length}`);
    }
    if (cliente) {
      params.push(cliente);
      if (vinculado === 'false') {
        // Inclui os órfãos importados sem pasta de cliente (zip sem estrutura de pastas),
        // senão eles ficam invisíveis pra sempre e nunca aparecem pra vincular manualmente.
        condicoes.push(`(cliente = $${params.length} OR cliente = '(sem pasta)')`);
      } else {
        condicoes.push(`cliente = $${params.length}`);
      }
    }
    if (vinculado === 'false') {
      condicoes.push('chicote_id IS NULL');
    } else if (vinculado === 'true') {
      condicoes.push('chicote_id IS NOT NULL');
    }
    if (ativo === 'true') {
      condicoes.push('ativo = true');
    } else if (ativo === 'false') {
      condicoes.push('ativo = false');
    }
    const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';
    const desenhos = await db.all(
      `SELECT id, chicote_id, cliente, codigoArquivo, nomeArquivo, tipoArquivo, tamanho, criadoEm, ativo
       FROM desenhos_chicote ${where} ORDER BY cliente, codigoArquivo, criadoEm DESC`,
      params
    );
    res.json(desenhos.map((d) => ({
      id: d.id,
      chicoteId: d.chicote_id,
      cliente: d.cliente,
      codigoArquivo: d.codigoarquivo,
      nomeArquivo: d.nomearquivo,
      tipoArquivo: d.tipoarquivo,
      tamanho: d.tamanho,
      criadoEm: d.criadoem,
      ativo: d.ativo,
    })));
  } catch (error) {
    console.error('Erro ao listar desenhos:', error.message);
    res.status(500).json({ message: 'Erro ao listar desenhos', error: error.message });
  }
});

app.get('/desenhos/:id/arquivo', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const desenho = await db.get(
      'SELECT nomeArquivo, tipoArquivo, conteudo FROM desenhos_chicote WHERE id = $1',
      [id]
    );
    if (!desenho) {
      return res.status(404).json({ message: 'Desenho não encontrado' });
    }
    const mime = MIME_POR_EXTENSAO[(desenho.tipoarquivo || '').toLowerCase()] || 'application/octet-stream';
    const nomeSanitizado = desenho.nomearquivo.replace(/"/g, '');
    res.setHeader('Content-Type', mime);
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${nomeSanitizado}"; filename*=UTF-8''${encodeURIComponent(desenho.nomearquivo)}`
    );
    res.send(desenho.conteudo);
  } catch (error) {
    console.error('Erro ao baixar desenho:', error.message);
    res.status(500).json({ message: 'Erro ao baixar desenho', error: error.message });
  }
});

app.put('/desenhos/:id/vincular', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { chicoteId } = req.body;
    const desenho = await db.get('SELECT id, codigoArquivo FROM desenhos_chicote WHERE id = $1', [id]);
    if (!desenho) {
      return res.status(404).json({ message: 'Desenho não encontrado' });
    }
    if (chicoteId) {
      const chicote = await db.get('SELECT id FROM chicotes WHERE id = $1', [chicoteId]);
      if (!chicote) {
        return res.status(404).json({ message: 'Chicote não encontrado' });
      }
      // Vincular manualmente também supera qualquer versão anterior do mesmo código
      // já vinculada a esse chicote, mandando ela pro histórico.
      await db.run(
        `UPDATE desenhos_chicote SET ativo = false
         WHERE chicote_id = $1 AND LOWER(codigoArquivo) = LOWER($2) AND id != $3 AND ativo = true`,
        [chicoteId, desenho.codigoarquivo, id]
      );
    }
    await db.run('UPDATE desenhos_chicote SET chicote_id = $1, ativo = true WHERE id = $2', [chicoteId || null, id]);
    res.json({ sucesso: true });
  } catch (error) {
    console.error('Erro ao vincular desenho:', error.message);
    res.status(500).json({ message: 'Erro ao vincular desenho', error: error.message });
  }
});

app.delete('/desenhos/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const resultado = await db.run('DELETE FROM desenhos_chicote WHERE id = $1', [id]);
    if (resultado.changes === 0) {
      return res.status(404).json({ message: 'Desenho não encontrado' });
    }
    res.json({ sucesso: true });
  } catch (error) {
    console.error('Erro ao remover desenho:', error.message);
    res.status(500).json({ message: 'Erro ao remover desenho', error: error.message });
  }
});

app.post('/chicotes', async (req, res) => {
  const { cliente, codigoItemCliente, codigoDca, tempoIdeal } = req.body;
  if (!cliente || !cliente.trim() || !codigoItemCliente || !codigoItemCliente.trim()) {
    return res.status(400).json({ message: 'Cliente e código do item cliente são obrigatórios.' });
  }
  try {
    const clienteFinal = cliente.trim();
    const codigoFinal = codigoItemCliente.trim();
    const existente = await db.get(
      'SELECT id FROM chicotes WHERE cliente = $1 AND codigoItemCliente = $2',
      [clienteFinal, codigoFinal]
    );
    if (existente) {
      return res.status(409).json({ message: 'Já existe um chicote com esse código pra esse cliente.', id: existente.id });
    }
    const agora = formatDateToLocalISO(new Date(), 'criar-chicote');
    const row = await db.get(
      `INSERT INTO chicotes (cliente, codigoItemCliente, codigoDca, tempoIdeal, criadoEm, atualizadoEm)
       VALUES ($1, $2, $3, $4, $5, $5) RETURNING id`,
      [clienteFinal, codigoFinal, codigoDca || null, tempoIdeal === '' || tempoIdeal == null ? null : tempoIdeal, agora]
    );
    res.status(201).json({
      id: row.id,
      cliente: clienteFinal,
      codigoItemCliente: codigoFinal,
      codigoDca: codigoDca || null,
      tempoIdeal: tempoIdeal === '' || tempoIdeal == null ? null : tempoIdeal,
    });
  } catch (error) {
    console.error('Erro ao criar chicote:', error.message);
    res.status(500).json({ message: 'Erro ao criar chicote', error: error.message });
  }
});

app.get('/chicotes/clientes', async (req, res) => {
  try {
    const rows = await db.all('SELECT cliente, COUNT(*)::int AS total FROM chicotes GROUP BY cliente ORDER BY cliente');
    res.json(rows.map((r) => ({ cliente: r.cliente, total: r.total })));
  } catch (error) {
    console.error('Erro ao listar clientes de chicotes:', error.message);
    res.status(500).json({ message: 'Erro ao listar clientes de chicotes', error: error.message });
  }
});

app.get('/chicotes', async (req, res) => {
  try {
    const { cliente } = req.query;
    const params = [];
    let where = '';
    if (cliente) {
      params.push(cliente);
      where = 'WHERE cliente = $1';
    }
    const chicotes = await db.all(
      `SELECT id, cliente, codigoItemCliente, codigoDca, tempoIdeal FROM chicotes ${where} ORDER BY cliente, codigoItemCliente`,
      params
    );
    const etapaCounts = await db.all('SELECT chicote_id, COUNT(*)::int AS total FROM etapas_chicote GROUP BY chicote_id');
    const etapaCountMap = new Map(etapaCounts.map((e) => [e.chicote_id, e.total]));
    const execucaoCounts = await db.all(
      `SELECT ec.chicote_id, COUNT(*)::int AS total
       FROM execucoes_etapa ex
       JOIN etapas_chicote ec ON ec.id = ex.etapa_chicote_id
       WHERE ex.status = 'concluido'
       GROUP BY ec.chicote_id`
    );
    const execucaoCountMap = new Map(execucaoCounts.map((e) => [e.chicote_id, e.total]));
    res.json(chicotes.map((c) => ({
      id: c.id,
      cliente: c.cliente,
      codigoItemCliente: c.codigoitemcliente,
      codigoDca: c.codigodca,
      tempoIdeal: c.tempoideal,
      temEtapas: (etapaCountMap.get(c.id) || 0) > 0,
      totalExecucoes: execucaoCountMap.get(c.id) || 0,
    })));
  } catch (error) {
    console.error('Erro ao listar chicotes:', error.message);
    res.status(500).json({ message: 'Erro ao listar chicotes', error: error.message });
  }
});

app.get('/chicotes/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const chicote = await db.get('SELECT id, cliente, codigoItemCliente, codigoDca, tempoIdeal FROM chicotes WHERE id = $1', [id]);
    if (!chicote) {
      return res.status(404).json({ message: 'Chicote não encontrado' });
    }
    const etapas = await db.all(
      'SELECT id, ordem, nome, setor, quemTexto, instrucoes, tempoIdeal FROM etapas_chicote WHERE chicote_id = $1 ORDER BY ordem',
      [id]
    );
    const itensVinculados = await db.all(
      `SELECT ip.id, ip.codigoDesenho, p.empresa, p.numeroOS, p.status
       FROM itens_pedidos ip
       JOIN pedidos p ON p.id = ip.pedido_id
       WHERE ip.chicote_id = $1
       ORDER BY p.empresa, p.numeroOS`,
      [id]
    );
    const desenhos = await db.all(
      'SELECT id, nomeArquivo, tipoArquivo, tamanho, criadoEm, ativo, codigoArquivo FROM desenhos_chicote WHERE chicote_id = $1 ORDER BY ativo DESC, criadoEm DESC',
      [id]
    );
    res.json({
      id: chicote.id,
      cliente: chicote.cliente,
      codigoItemCliente: chicote.codigoitemcliente,
      codigoDca: chicote.codigodca,
      tempoIdeal: chicote.tempoideal,
      etapas: etapas.map((e) => ({
        id: e.id,
        ordem: e.ordem,
        nome: e.nome,
        setor: e.setor,
        quemTexto: e.quemtexto,
        instrucoes: e.instrucoes,
        tempoIdeal: e.tempoideal,
      })),
      itensVinculados: itensVinculados.map((i) => ({
        id: i.id,
        codigoDesenho: i.codigodesenho,
        empresa: i.empresa,
        numeroOS: i.numeroos,
        status: i.status,
      })),
      desenhos: desenhos.map((d) => ({
        id: d.id,
        nomeArquivo: d.nomearquivo,
        tipoArquivo: d.tipoarquivo,
        tamanho: d.tamanho,
        criadoEm: d.criadoem,
        ativo: d.ativo,
        codigoArquivo: d.codigoarquivo,
      })),
    });
  } catch (error) {
    console.error('Erro ao buscar chicote:', error.message);
    res.status(500).json({ message: 'Erro ao buscar chicote', error: error.message });
  }
});

app.put('/chicotes/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { codigoItemCliente, codigoDca, tempoIdeal } = req.body;
  if (!codigoItemCliente || !codigoItemCliente.trim()) {
    return res.status(400).json({ message: 'Código do item cliente é obrigatório.' });
  }
  try {
    const agora = formatDateToLocalISO(new Date(), 'editar-chicote');
    const result = await db.run(
      'UPDATE chicotes SET codigoItemCliente = $1, codigoDca = $2, tempoIdeal = $3, atualizadoEm = $4 WHERE id = $5',
      [codigoItemCliente, codigoDca || null, tempoIdeal === '' || tempoIdeal === undefined ? null : tempoIdeal, agora, id]
    );
    if (result.changes === 0) {
      return res.status(404).json({ message: 'Chicote não encontrado' });
    }
    res.json({ id, codigoItemCliente, codigoDca: codigoDca || null, tempoIdeal: tempoIdeal ?? null });
  } catch (error) {
    console.error('Erro ao editar chicote:', error.message);
    res.status(500).json({ message: 'Erro ao editar chicote', error: error.message });
  }
});

app.post('/chicotes/:id/calcular-media-tempos', async (req, res) => {
  const chicoteId = parseInt(req.params.id);
  try {
    const chicote = await db.get('SELECT id FROM chicotes WHERE id = $1', [chicoteId]);
    if (!chicote) {
      return res.status(404).json({ message: 'Chicote não encontrado' });
    }

    const etapas = await db.all('SELECT id FROM etapas_chicote WHERE chicote_id = $1', [chicoteId]);
    if (etapas.length === 0) {
      return res.status(400).json({ message: 'Esse chicote não tem etapas cadastradas.' });
    }
    const etapaIds = etapas.map((e) => e.id);

    const itens = await db.all(
      'SELECT id, pedido_id, quantidadePedido FROM itens_pedidos WHERE chicote_id = $1',
      [chicoteId]
    );
    if (itens.length === 0) {
      return res.status(400).json({ message: 'Nenhum item de pedido vinculado a esse chicote ainda.' });
    }
    const itemIds = itens.map((i) => i.id);
    const itemMap = new Map(itens.map((i) => [i.id, i]));

    const execucoes = await db.all(
      `SELECT item_pedido_id, etapa_chicote_id, colaborador_id, tempoAcumulado, dataConclusao
       FROM execucoes_etapa
       WHERE item_pedido_id = ANY($1::int[]) AND etapa_chicote_id = ANY($2::int[]) AND status = 'concluido'`,
      [itemIds, etapaIds]
    );

    // Tempo de uma etapa = média entre os colaboradores que a executaram
    // (cada um registra seu próprio tempo; com 1 só colaborador, a "média" é o próprio tempo dele).
    const tempoMedioEtapa = (execsDaEtapa) =>
      execsDaEtapa.reduce((soma, ex) => soma + (Number(ex.tempoacumulado) || 0), 0) / execsDaEtapa.length;

    const porItem = new Map();
    execucoes.forEach((ex) => {
      if (!porItem.has(ex.item_pedido_id)) porItem.set(ex.item_pedido_id, new Map());
      const mapaEtapas = porItem.get(ex.item_pedido_id);
      if (!mapaEtapas.has(ex.etapa_chicote_id)) mapaEtapas.set(ex.etapa_chicote_id, []);
      mapaEtapas.get(ex.etapa_chicote_id).push(ex);
    });

    const candidatosPorPedido = new Map();
    porItem.forEach((mapaEtapas, itemPedidoId) => {
      const completo = etapaIds.every((eid) => mapaEtapas.has(eid));
      if (!completo) return;
      const item = itemMap.get(itemPedidoId);
      const todasExecucoes = Array.from(mapaEtapas.values()).flat();
      const conclusaoMaisRecente = Math.max(...todasExecucoes.map((ex) => new Date(ex.dataconclusao).getTime()));
      const candidato = {
        itemPedidoId,
        pedidoId: item.pedido_id,
        quantidadePedido: item.quantidadepedido,
        conclusaoMaisRecente,
        etapaTempos: mapaEtapas,
      };
      const existente = candidatosPorPedido.get(item.pedido_id);
      if (!existente || candidato.conclusaoMaisRecente > existente.conclusaoMaisRecente) {
        candidatosPorPedido.set(item.pedido_id, candidato);
      }
    });

    const candidatosOrdenados = Array.from(candidatosPorPedido.values())
      .sort((a, b) => b.conclusaoMaisRecente - a.conclusaoMaisRecente);

    const validos = [];
    for (const candidato of candidatosOrdenados) {
      if (validos.length >= 5) break;
      const qtd = Number(candidato.quantidadePedido);
      if (!qtd || qtd <= 0 || isNaN(qtd)) continue;
      validos.push(candidato);
    }

    if (validos.length === 0) {
      return res.status(400).json({ message: 'Não há execuções concluídas suficientes desse chicote para calcular a média.' });
    }

    let somaTotalPorUnidade = 0;
    const somaEtapaPorUnidade = new Map(etapaIds.map((eid) => [eid, 0]));

    validos.forEach((candidato) => {
      const qtd = Number(candidato.quantidadePedido);
      let totalSegundos = 0;
      etapaIds.forEach((eid) => {
        const tempoEtapa = tempoMedioEtapa(candidato.etapaTempos.get(eid));
        totalSegundos += tempoEtapa;
        somaEtapaPorUnidade.set(eid, somaEtapaPorUnidade.get(eid) + tempoEtapa / qtd);
      });
      somaTotalPorUnidade += totalSegundos / qtd;
    });

    const paraMinutos = (segundos) => Math.round((segundos / 60) * 10) / 10;
    const mediaTotalMin = paraMinutos(somaTotalPorUnidade / validos.length);
    const mediasEtapas = etapaIds.map((eid) => ({
      id: eid,
      tempoIdeal: paraMinutos(somaEtapaPorUnidade.get(eid) / validos.length),
    }));

    const agora = formatDateToLocalISO(new Date(), 'media-tempos-chicote');
    await db.run('UPDATE chicotes SET tempoIdeal = $1, atualizadoEm = $2 WHERE id = $3', [mediaTotalMin, agora, chicoteId]);
    for (const m of mediasEtapas) {
      await db.run('UPDATE etapas_chicote SET tempoIdeal = $1 WHERE id = $2', [m.tempoIdeal, m.id]);
    }

    const pedidosUsados = await db.all(
      'SELECT id, empresa, numeroOS FROM pedidos WHERE id = ANY($1::int[])',
      [validos.map((v) => v.pedidoId)]
    );

    res.json({
      tempoIdeal: mediaTotalMin,
      etapas: mediasEtapas,
      execucoesUsadas: validos.length,
      pedidos: pedidosUsados.map((p) => ({ empresa: p.empresa, numeroOS: p.numeroos })),
    });
  } catch (error) {
    console.error('Erro ao calcular média de tempos do chicote:', error.message);
    res.status(500).json({ message: 'Erro ao calcular média de tempos do chicote', error: error.message });
  }
});

app.get('/etapas-chicote/:etapaId/colaboradores', async (req, res) => {
  const etapaId = parseInt(req.params.etapaId);
  try {
    const etapa = await db.get(
      `SELECT ec.id, ec.nome, ec.chicote_id, c.cliente, c.codigoItemCliente
       FROM etapas_chicote ec JOIN chicotes c ON c.id = ec.chicote_id
       WHERE ec.id = $1`,
      [etapaId]
    );
    if (!etapa) {
      return res.status(404).json({ message: 'Etapa não encontrada' });
    }

    const execucoes = await db.all(
      `SELECT ex.colaborador_id, ex.tempoAcumulado, col.nome AS colaboradorNome, col.matricula
       FROM execucoes_etapa ex
       JOIN colaboradores col ON col.id = ex.colaborador_id
       WHERE ex.etapa_chicote_id = $1 AND ex.status = 'concluido'`,
      [etapaId]
    );

    const porColaborador = new Map();
    execucoes.forEach((ex) => {
      if (!porColaborador.has(ex.colaborador_id)) {
        porColaborador.set(ex.colaborador_id, {
          colaboradorId: ex.colaborador_id,
          colaboradorNome: ex.colaboradornome,
          matricula: ex.matricula,
          tempos: [],
        });
      }
      porColaborador.get(ex.colaborador_id).tempos.push(Number(ex.tempoacumulado) || 0);
    });

    const ranking = Array.from(porColaborador.values())
      .map((c) => ({
        colaboradorId: c.colaboradorId,
        colaboradorNome: c.colaboradorNome,
        matricula: c.matricula,
        execucoes: c.tempos.length,
        tempoMedioSegundos: Math.round(c.tempos.reduce((soma, t) => soma + t, 0) / c.tempos.length),
      }))
      .sort((a, b) => a.tempoMedioSegundos - b.tempoMedioSegundos);

    res.json({
      etapa: {
        id: etapa.id,
        nome: etapa.nome,
        chicoteId: etapa.chicote_id,
        cliente: etapa.cliente,
        codigoItemCliente: etapa.codigoitemcliente,
      },
      ranking,
    });
  } catch (error) {
    console.error('Erro ao listar ranking de colaboradores da etapa:', error.message);
    res.status(500).json({ message: 'Erro ao listar ranking de colaboradores da etapa', error: error.message });
  }
});

app.get('/etapas-chicote/:etapaId/colaboradores/:colaboradorId', async (req, res) => {
  const etapaId = parseInt(req.params.etapaId);
  const colaboradorId = parseInt(req.params.colaboradorId);
  try {
    const etapa = await db.get(
      `SELECT ec.id, ec.nome, ec.chicote_id, c.cliente, c.codigoItemCliente
       FROM etapas_chicote ec JOIN chicotes c ON c.id = ec.chicote_id
       WHERE ec.id = $1`,
      [etapaId]
    );
    if (!etapa) {
      return res.status(404).json({ message: 'Etapa não encontrada' });
    }
    const colaborador = await db.get('SELECT id, nome, matricula FROM colaboradores WHERE id = $1', [colaboradorId]);
    if (!colaborador) {
      return res.status(404).json({ message: 'Colaborador não encontrado' });
    }

    const execucoes = await db.all(
      `SELECT ex.id, ex.inicio, ex.dataConclusao, ex.tempoAcumulado, p.empresa, p.numeroOS
       FROM execucoes_etapa ex
       JOIN itens_pedidos ip ON ip.id = ex.item_pedido_id
       JOIN pedidos p ON p.id = ip.pedido_id
       WHERE ex.etapa_chicote_id = $1 AND ex.colaborador_id = $2 AND ex.status = 'concluido'
       ORDER BY ex.dataConclusao DESC`,
      [etapaId, colaboradorId]
    );

    const tempos = execucoes.map((ex) => Number(ex.tempoacumulado) || 0);
    const tempoMedioSegundos = tempos.length > 0
      ? Math.round(tempos.reduce((soma, t) => soma + t, 0) / tempos.length)
      : null;

    res.json({
      etapa: {
        id: etapa.id,
        nome: etapa.nome,
        chicoteId: etapa.chicote_id,
        cliente: etapa.cliente,
        codigoItemCliente: etapa.codigoitemcliente,
      },
      colaborador: { id: colaborador.id, nome: colaborador.nome, matricula: colaborador.matricula },
      tempoMedioSegundos,
      execucoes: execucoes.map((ex) => ({
        id: ex.id,
        empresa: ex.empresa,
        numeroOS: ex.numeroos,
        inicio: ex.inicio,
        dataConclusao: ex.dataconclusao,
        tempoSegundos: Math.round(Number(ex.tempoacumulado) || 0),
      })),
    });
  } catch (error) {
    console.error('Erro ao listar execuções do colaborador na etapa:', error.message);
    res.status(500).json({ message: 'Erro ao listar execuções do colaborador na etapa', error: error.message });
  }
});

app.get('/chicotes/:id/relatorio-tempos', async (req, res) => {
  const chicoteId = parseInt(req.params.id);
  const TOLERANCIA = 0.10;
  try {
    const chicote = await db.get('SELECT id, cliente, codigoItemCliente, tempoIdeal FROM chicotes WHERE id = $1', [chicoteId]);
    if (!chicote) {
      return res.status(404).json({ message: 'Chicote não encontrado' });
    }

    const tempoIdealSegundos = chicote.tempoideal != null ? Math.round(Number(chicote.tempoideal) * 60) : null;

    const etapas = await db.all('SELECT id FROM etapas_chicote WHERE chicote_id = $1', [chicoteId]);
    const etapaIds = etapas.map((e) => e.id);

    const itens = await db.all(
      `SELECT ip.id, ip.pedido_id, ip.quantidadePedido, p.empresa, p.numeroOS, p.status
       FROM itens_pedidos ip JOIN pedidos p ON p.id = ip.pedido_id
       WHERE ip.chicote_id = $1`,
      [chicoteId]
    );

    const respostaBase = {
      chicote: {
        id: chicote.id,
        cliente: chicote.cliente,
        codigoItemCliente: chicote.codigoitemcliente,
        tempoIdealMinutos: chicote.tempoideal,
        tempoIdealSegundos,
      },
      toleranciaPercentual: TOLERANCIA * 100,
      execucoes: [],
    };

    if (etapaIds.length === 0 || itens.length === 0) {
      return res.json(respostaBase);
    }

    const itemIds = itens.map((i) => i.id);
    const execucoes = await db.all(
      `SELECT item_pedido_id, etapa_chicote_id, tempoAcumulado, status, dataConclusao
       FROM execucoes_etapa
       WHERE item_pedido_id = ANY($1::int[]) AND etapa_chicote_id = ANY($2::int[])`,
      [itemIds, etapaIds]
    );

    const resultado = itens
      .map((item) => {
        const execucoesDoItem = execucoes.filter((ex) => ex.item_pedido_id === item.id);
        let todasConcluidas = true;
        let somaTempoMedio = 0;
        let conclusaoMaisRecente = null;
        etapaIds.forEach((eid) => {
          const concluidas = execucoesDoItem.filter((ex) => ex.etapa_chicote_id === eid && ex.status === 'concluido');
          if (concluidas.length === 0) {
            todasConcluidas = false;
            return;
          }
          const tempoMedio = concluidas.reduce((soma, ex) => soma + (Number(ex.tempoacumulado) || 0), 0) / concluidas.length;
          somaTempoMedio += tempoMedio;
          concluidas.forEach((ex) => {
            if (ex.dataconclusao && (!conclusaoMaisRecente || ex.dataconclusao > conclusaoMaisRecente)) {
              conclusaoMaisRecente = ex.dataconclusao;
            }
          });
        });
        if (!todasConcluidas) return null;
        const qtd = Number(item.quantidadepedido);
        if (!qtd || qtd <= 0) return null;

        const tempoRealSegundos = Math.round(somaTempoMedio / qtd);
        let classificacao = null;
        if (tempoIdealSegundos != null) {
          const limiteInferior = tempoIdealSegundos * (1 - TOLERANCIA);
          const limiteSuperior = tempoIdealSegundos * (1 + TOLERANCIA);
          classificacao = tempoRealSegundos > limiteSuperior ? 'acima' : tempoRealSegundos < limiteInferior ? 'abaixo' : 'dentro';
        }

        return {
          itemPedidoId: item.id,
          pedidoId: item.pedido_id,
          empresa: item.empresa,
          numeroOS: item.numeroos,
          statusPedido: item.status,
          quantidadePedido: qtd,
          tempoRealSegundos,
          dataConclusao: conclusaoMaisRecente,
          classificacao,
        };
      })
      .filter(Boolean)
      .sort((a, b) => (b.dataConclusao || '').localeCompare(a.dataConclusao || ''));

    respostaBase.execucoes = resultado;
    res.json(respostaBase);
  } catch (error) {
    console.error('Erro ao gerar relatório de tempos do chicote:', error.message);
    res.status(500).json({ message: 'Erro ao gerar relatório de tempos do chicote', error: error.message });
  }
});

app.post('/chicotes/:id/etapas', async (req, res) => {
  const chicoteId = parseInt(req.params.id);
  const { nome, setor, quemTexto, instrucoes, tempoIdeal } = req.body;
  if (!nome || !nome.trim()) {
    return res.status(400).json({ message: 'Nome da etapa é obrigatório.' });
  }
  try {
    const chicote = await db.get('SELECT id FROM chicotes WHERE id = $1', [chicoteId]);
    if (!chicote) {
      return res.status(404).json({ message: 'Chicote não encontrado' });
    }
    const ultima = await db.get('SELECT COALESCE(MAX(ordem), 0) AS maxOrdem FROM etapas_chicote WHERE chicote_id = $1', [chicoteId]);
    const proximaOrdem = (Number(ultima.maxordem) || 0) + 1;
    const etapa = await db.get(
      `INSERT INTO etapas_chicote (chicote_id, ordem, nome, setor, quemTexto, instrucoes, tempoIdeal)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [chicoteId, proximaOrdem, nome.trim(), setor || null, quemTexto || null, instrucoes || null, tempoIdeal === '' || tempoIdeal === undefined ? null : tempoIdeal]
    );
    res.status(201).json({
      id: etapa.id,
      ordem: etapa.ordem,
      nome: etapa.nome,
      setor: etapa.setor,
      quemTexto: etapa.quemtexto,
      instrucoes: etapa.instrucoes,
      tempoIdeal: etapa.tempoideal,
    });
  } catch (error) {
    console.error('Erro ao adicionar etapa:', error.message);
    res.status(500).json({ message: 'Erro ao adicionar etapa', error: error.message });
  }
});

app.put('/etapas-chicote/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { nome, setor, quemTexto, instrucoes, tempoIdeal, ordem } = req.body;
  if (!nome || !nome.trim()) {
    return res.status(400).json({ message: 'Nome da etapa é obrigatório.' });
  }
  try {
    const result = await db.run(
      `UPDATE etapas_chicote SET nome = $1, setor = $2, quemTexto = $3, instrucoes = $4, tempoIdeal = $5, ordem = COALESCE($6, ordem)
       WHERE id = $7`,
      [nome.trim(), setor || null, quemTexto || null, instrucoes || null, tempoIdeal === '' || tempoIdeal === undefined ? null : tempoIdeal, ordem ?? null, id]
    );
    if (result.changes === 0) {
      return res.status(404).json({ message: 'Etapa não encontrada' });
    }
    res.json({ id });
  } catch (error) {
    console.error('Erro ao editar etapa:', error.message);
    res.status(500).json({ message: 'Erro ao editar etapa', error: error.message });
  }
});

app.put('/etapas-chicote/:id/mover', async (req, res) => {
  const id = parseInt(req.params.id);
  const { direcao } = req.body;
  if (direcao !== 'cima' && direcao !== 'baixo') {
    return res.status(400).json({ message: 'Direção inválida. Use "cima" ou "baixo".' });
  }
  try {
    const etapa = await db.get('SELECT * FROM etapas_chicote WHERE id = $1', [id]);
    if (!etapa) {
      return res.status(404).json({ message: 'Etapa não encontrada' });
    }
    const vizinha = direcao === 'cima'
      ? await db.get('SELECT * FROM etapas_chicote WHERE chicote_id = $1 AND ordem < $2 ORDER BY ordem DESC LIMIT 1', [etapa.chicote_id, etapa.ordem])
      : await db.get('SELECT * FROM etapas_chicote WHERE chicote_id = $1 AND ordem > $2 ORDER BY ordem ASC LIMIT 1', [etapa.chicote_id, etapa.ordem]);
    if (!vizinha) {
      return res.status(400).json({ message: 'Essa etapa já está na ponta da lista.' });
    }
    await db.run('UPDATE etapas_chicote SET ordem = $1 WHERE id = $2', [vizinha.ordem, etapa.id]);
    await db.run('UPDATE etapas_chicote SET ordem = $1 WHERE id = $2', [etapa.ordem, vizinha.id]);
    res.json({ id, ordem: vizinha.ordem });
  } catch (error) {
    console.error('Erro ao mover etapa:', error.message);
    res.status(500).json({ message: 'Erro ao mover etapa', error: error.message });
  }
});

app.delete('/etapas-chicote/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const result = await db.run('DELETE FROM etapas_chicote WHERE id = $1', [id]);
    if (result.changes === 0) {
      return res.status(404).json({ message: 'Etapa não encontrada' });
    }
    res.json({ id });
  } catch (error) {
    console.error('Erro ao remover etapa:', error.message);
    res.status(500).json({ message: 'Erro ao remover etapa', error: error.message });
  }
});

// Rotina de carga inicial: garante que todo item de pedido novo/andamento
// já tenha um chicote correspondente (criando um vazio se ainda não existir
// nenhum pra aquele cliente+código). Idempotente — só mexe em itens sem
// chicote_id, então pode ser rodada de novo sem duplicar nada. Não é um
// gatilho automático permanente: daqui pra frente o vínculo é sempre manual.
app.post('/chicotes/sincronizar-pedidos-existentes', async (req, res) => {
  try {
    const itens = await db.all(`
      SELECT ip.id, ip.codigoDesenho, p.empresa
      FROM itens_pedidos ip
      JOIN pedidos p ON p.id = ip.pedido_id
      WHERE p.status IN ('novo', 'andamento') AND ip.chicote_id IS NULL
    `);
    const chicotes = await db.all('SELECT id, cliente, codigoItemCliente FROM chicotes');
    const normaliza = (s) => String(s || '').trim().toUpperCase();
    const agora = formatDateToLocalISO(new Date(), 'sincronizar-chicotes');

    let criados = 0;
    let ignorados = 0;
    for (const item of itens) {
      if (!item.codigodesenho || !item.codigodesenho.trim()) {
        ignorados++;
        continue;
      }
      let chicote = chicotes.find(
        (c) => normaliza(c.cliente) === normaliza(item.empresa) && normaliza(c.codigoitemcliente) === normaliza(item.codigodesenho)
      );
      if (!chicote) {
        const novo = await db.get(
          `INSERT INTO chicotes (cliente, codigoItemCliente, criadoEm, atualizadoEm)
           VALUES ($1, $2, $3, $3) RETURNING id, cliente, codigoItemCliente`,
          [item.empresa, item.codigodesenho, agora]
        );
        chicote = { id: novo.id, cliente: novo.cliente, codigoitemcliente: novo.codigoitemcliente };
        chicotes.push(chicote);
        criados++;
      }
      await db.run('UPDATE itens_pedidos SET chicote_id = $1 WHERE id = $2', [chicote.id, item.id]);
    }

    res.json({ itensProcessados: itens.length, chicotesCriados: criados, itensIgnorados: ignorados });
  } catch (error) {
    console.error('Erro ao sincronizar chicotes:', error.message);
    res.status(500).json({ message: 'Erro ao sincronizar chicotes', error: error.message });
  }
});

app.get('/itens-pedidos', async (req, res) => {
  try {
    const itens = await db.all(`
      SELECT ip.id, ip.pedido_id, ip.codigoDesenho, ip.chicote_id, ip.prioritario,
             p.empresa, p.numeroOS, p.status
      FROM itens_pedidos ip
      JOIN pedidos p ON p.id = ip.pedido_id
      WHERE p.status IN ('novo', 'andamento')
      ORDER BY p.empresa, p.numeroOS
    `);
    const chicotes = await db.all('SELECT id, cliente, codigoItemCliente, codigoDca FROM chicotes');

    const normaliza = (s) => String(s || '').trim().toUpperCase();
    const paraChicoteResumo = (c) => (c ? { id: c.id, codigoItemCliente: c.codigoitemcliente, codigoDca: c.codigodca } : null);

    const resultado = itens.map((item) => {
      const chicoteVinculado = item.chicote_id ? chicotes.find((c) => c.id === item.chicote_id) : null;

      let chicoteSugerido = null;
      if (!item.chicote_id) {
        chicoteSugerido = chicotes.find(
          (c) => normaliza(c.cliente) === normaliza(item.empresa) && normaliza(c.codigoitemcliente) === normaliza(item.codigodesenho)
        ) || null;
      }

      return {
        id: item.id,
        pedidoId: item.pedido_id,
        empresa: item.empresa,
        numeroOS: item.numeroos,
        status: item.status,
        codigoDesenho: item.codigodesenho,
        prioritario: item.prioritario === 1 || item.prioritario === true,
        chicoteId: item.chicote_id,
        chicoteVinculado: paraChicoteResumo(chicoteVinculado),
        chicoteSugerido: paraChicoteResumo(chicoteSugerido),
      };
    });

    res.json(resultado);
  } catch (error) {
    console.error('Erro ao listar itens de pedido:', error.message);
    res.status(500).json({ message: 'Erro ao listar itens de pedido', error: error.message });
  }
});

app.put('/itens-pedidos/:id/chicote', async (req, res) => {
  const id = parseInt(req.params.id);
  const { chicoteId } = req.body;
  try {
    const result = await db.run('UPDATE itens_pedidos SET chicote_id = $1 WHERE id = $2', [chicoteId || null, id]);
    if (result.changes === 0) {
      return res.status(404).json({ message: 'Item de pedido não encontrado' });
    }
    res.json({ id, chicoteId: chicoteId || null });
  } catch (error) {
    console.error('Erro ao vincular chicote:', error.message);
    res.status(500).json({ message: 'Erro ao vincular chicote', error: error.message });
  }
});

app.get('/ordens-producao', async (req, res) => {
  const colaboradorId = parseInt(req.query.colaboradorId);
  if (!colaboradorId) {
    return res.status(400).json({ message: 'colaboradorId é obrigatório.' });
  }
  try {
    const pedidos = await db.all(`
      SELECT id, empresa, numeroOS, status, ordemPrioridade
      FROM pedidos
      WHERE prioritario = 1 AND status IN ('novo', 'andamento')
      ORDER BY ordemPrioridade ASC NULLS LAST, empresa, numeroOS
    `);

    if (pedidos.length === 0) {
      return res.json([]);
    }

    const pedidoIds = pedidos.map((p) => p.id);
    const itens = await db.all(
      'SELECT id, pedido_id, codigoDesenho, quantidadePedido, chicote_id FROM itens_pedidos WHERE pedido_id = ANY($1::int[]) AND chicote_id IS NOT NULL',
      [pedidoIds]
    );

    if (itens.length === 0) {
      return res.json(pedidos.map((p) => ({
        id: p.id,
        empresa: p.empresa,
        numeroOS: p.numeroos,
        status: p.status,
        ordemPrioridade: p.ordemprioridade,
        itens: [],
      })));
    }

    const chicoteIds = [...new Set(itens.map((i) => i.chicote_id))];
    const itemIds = itens.map((i) => i.id);

    const chicotes = await db.all(
      'SELECT id, tempoIdeal FROM chicotes WHERE id = ANY($1::int[])',
      [chicoteIds]
    );
    const chicoteTempoIdealMap = new Map(chicotes.map((c) => [c.id, c.tempoideal]));

    const etapas = await db.all(
      'SELECT id, chicote_id, ordem, nome, setor, quemTexto, colaboradores, instrucoes FROM etapas_chicote WHERE chicote_id = ANY($1::int[]) ORDER BY ordem',
      [chicoteIds]
    );
    const execucoes = await db.all(
      `SELECT ex.*, col.nome AS colaboradorNome FROM execucoes_etapa ex
       JOIN colaboradores col ON col.id = ex.colaborador_id
       WHERE ex.item_pedido_id = ANY($1::int[])`,
      [itemIds]
    );

    const calcularExecucao = (exec) => {
      if (!exec) return null;
      const base = Math.round(Number(exec.tempoacumulado) || 0);
      if (exec.status === 'em_andamento') {
        return {
          id: exec.id,
          status: exec.status,
          tempoAcumuladoBase: base,
          referenciaInicio: exec.datapausada || exec.inicio,
        };
      }
      return { id: exec.id, status: exec.status, tempoAcumulado: base };
    };

    const calcularExecucaoAtual = (exec) => {
      if (!exec) return null;
      const base = Math.round(Number(exec.tempoacumulado) || 0);
      const comum = { id: exec.id, status: exec.status, colaboradorId: exec.colaborador_id, colaboradorNome: exec.colaboradornome };
      if (exec.status === 'em_andamento') {
        return { ...comum, tempoAcumuladoBase: base, referenciaInicio: exec.datapausada || exec.inicio };
      }
      return { ...comum, tempoAcumulado: base };
    };

    const resultado = pedidos.map((pedido) => ({
      id: pedido.id,
      empresa: pedido.empresa,
      numeroOS: pedido.numeroos,
      status: pedido.status,
      ordemPrioridade: pedido.ordemprioridade,
      itens: itens
        .filter((item) => item.pedido_id === pedido.id)
        .map((item) => {
          const etapasDoItem = etapas
            .filter((e) => e.chicote_id === item.chicote_id)
            .map((e) => {
              const execucoesDaEtapa = execucoes
                .filter((ex) => ex.item_pedido_id === item.id && ex.etapa_chicote_id === e.id)
                .sort((a, b) => b.id - a.id);
              const minhaExecucao = execucoesDaEtapa.find((ex) => ex.colaborador_id === colaboradorId);
              const execucaoMaisRecente = execucoesDaEtapa[0];
              const concluidas = execucoesDaEtapa.filter((ex) => ex.status === 'concluido');
              // Tempo da etapa = média entre os colaboradores que a concluíram
              // (cada um registra seu próprio tempo; com 1 só, a "média" é o tempo dele mesmo).
              const tempoMedioConcluido = concluidas.length > 0
                ? concluidas.reduce((soma, ex) => soma + (Number(ex.tempoacumulado) || 0), 0) / concluidas.length
                : null;
              // Todas as execuções da etapa (qualquer colaborador, qualquer status), pra mostrar
              // todo mundo que trabalhou/está trabalhando na mesma etapa, não só a mais recente.
              const execucoesEtapa = execucoesDaEtapa.map((ex) => calcularExecucaoAtual(ex));
              return {
                id: e.id,
                ordem: e.ordem,
                nome: e.nome,
                setor: e.setor,
                quemTexto: e.quemtexto,
                colaboradores: e.colaboradores,
                instrucoes: e.instrucoes,
                minhaExecucao: calcularExecucao(minhaExecucao),
                execucaoAtual: calcularExecucaoAtual(execucaoMaisRecente),
                execucoes: execucoesEtapa,
                concluida: concluidas.length > 0,
                tempoMedioConcluido,
              };
            });
          const todasConcluidas = etapasDoItem.length > 0 && etapasDoItem.every((e) => e.tempoMedioConcluido !== null);
          const qtd = Number(item.quantidadepedido);
          const tempoTotalReal = todasConcluidas && qtd > 0
            ? Math.round(etapasDoItem.reduce((soma, e) => soma + e.tempoMedioConcluido, 0) / qtd)
            : null;
          return {
            id: item.id,
            codigoDesenho: item.codigodesenho,
            quantidadePedido: item.quantidadepedido,
            chicoteId: item.chicote_id,
            tempoIdeal: chicoteTempoIdealMap.get(item.chicote_id) ?? null,
            tempoTotalReal,
            etapas: etapasDoItem.map(({ tempoMedioConcluido, ...resto }) => resto),
          };
        }),
    }));

    res.json(resultado);
  } catch (error) {
    console.error('Erro ao listar ordens de produção:', error.message);
    res.status(500).json({ message: 'Erro ao listar ordens de produção', error: error.message });
  }
});

app.post('/execucoes-etapa/iniciar', async (req, res) => {
  const { itemPedidoId, etapaChicoteId, colaboradorId } = req.body;
  if (!itemPedidoId || !etapaChicoteId || !colaboradorId) {
    return res.status(400).json({ message: 'itemPedidoId, etapaChicoteId e colaboradorId são obrigatórios.' });
  }
  try {
    const emAndamento = await db.get(
      "SELECT id FROM execucoes_etapa WHERE colaborador_id = $1 AND status = 'em_andamento'",
      [colaboradorId]
    );
    if (emAndamento) {
      return res.status(409).json({ message: 'Você já está executando outra etapa. Pause ou conclua antes de iniciar essa.' });
    }

    // Vários colaboradores podem executar a mesma etapa ao mesmo tempo, cada um
    // registrando seu próprio tempo (o tempo da etapa vira a média entre eles).
    // Não há mais bloqueio por causa de outro colaborador já estar/ter estado nessa etapa.

    const agora = formatDateToLocalISO(new Date(), 'iniciar-etapa');
    const execucao = await db.get(
      `INSERT INTO execucoes_etapa (item_pedido_id, etapa_chicote_id, colaborador_id, status, inicio, tempoAcumulado)
       VALUES ($1, $2, $3, 'em_andamento', $4, 0) RETURNING id`,
      [itemPedidoId, etapaChicoteId, colaboradorId, agora]
    );

    const item = await db.get('SELECT pedido_id FROM itens_pedidos WHERE id = $1', [itemPedidoId]);
    if (item) {
      const resultadoStatus = await db.run("UPDATE pedidos SET status = 'andamento', inicio = $2 WHERE id = $1 AND status = 'novo'", [item.pedido_id, agora]);
      if (resultadoStatus.changes > 0) {
        try {
          const pedido = await db.get('SELECT * FROM pedidos WHERE id = $1', [item.pedido_id]);
          const itensDoPedido = await db.all('SELECT * FROM itens_pedidos WHERE pedido_id = $1', [item.pedido_id]);
          const pedidoFormatado = {
            empresa: pedido.empresa,
            numeroOS: pedido.numeroos,
            dataEntrada: pedido.dataentrada,
            previsaoEntrega: pedido.previsaoentrega,
            responsavel: pedido.responsavel,
            status: pedido.status,
            inicio: converterFormatoData(pedido.inicio),
            tempo: 0,
            pausado: false,
            tempoPausado: 0,
          };
          const itensFormatados = itensDoPedido.map((i) => ({
            codigoDesenho: i.codigodesenho,
            quantidadePedido: i.quantidadepedido,
            quantidadeEntregue: i.quantidadeentregue,
          }));
          const emailText = montarEmail(pedidoFormatado, itensFormatados, 'Pedido movido para Em Andamento — colaborador iniciou a produção.', []);
          const rawEmailTo = (process.env.EMAIL_TO || 'danielalves@dcachicoteseletricos.com.br').replace(/\s+/g, '');
          const destinatarios = rawEmailTo.split(',').map((e) => e.trim()).filter((e) => e.length > 0 && e.includes('@'));
          for (const destinatario of destinatarios) {
            await transporter.sendMail({
              from: `"Controle de Produção" <${process.env.EMAIL_USER || 'dcashopecia@gmail.com'}>`,
              to: destinatario,
              subject: `Atualização de Pedido ${pedidoFormatado.numeroOS} - Status: andamento`,
              text: emailText,
            });
          }
          await criarNotificacao({
            tipo: 'pedido',
            titulo: `Pedido ${pedidoFormatado.numeroOS} em andamento`,
            mensagem: `${pedidoFormatado.empresa} — colaborador iniciou a produção.`,
            rota: '/',
          });
        } catch (emailError) {
          console.error('Erro ao enviar e-mail de início de produção:', emailError.message);
        }
      }
    }

    res.status(201).json({ id: execucao.id, status: 'em_andamento', tempoAcumuladoBase: 0, referenciaInicio: agora });
  } catch (error) {
    console.error('Erro ao iniciar etapa:', error.message);
    res.status(500).json({ message: 'Erro ao iniciar etapa', error: error.message });
  }
});

app.put('/execucoes-etapa/:id/pausar', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const exec = await db.get('SELECT * FROM execucoes_etapa WHERE id = $1', [id]);
    if (!exec) return res.status(404).json({ message: 'Execução não encontrada.' });
    if (exec.status !== 'em_andamento') {
      return res.status(400).json({ message: 'Essa etapa não está em andamento.' });
    }
    const agora = formatDateToLocalISO(new Date(), 'pausar-etapa');
    const novoTempo = (Number(exec.tempoacumulado) || 0) + calcularTempoSegundos(exec.datapausada || exec.inicio, agora);
    await db.run("UPDATE execucoes_etapa SET status = 'pausado', tempoAcumulado = $1, dataPausada = $2 WHERE id = $3", [novoTempo, agora, id]);
    res.json({ id, status: 'pausado', tempoAcumulado: Math.round(novoTempo) });
  } catch (error) {
    console.error('Erro ao pausar etapa:', error.message);
    res.status(500).json({ message: 'Erro ao pausar etapa', error: error.message });
  }
});

app.put('/execucoes-etapa/:id/retomar', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const exec = await db.get('SELECT * FROM execucoes_etapa WHERE id = $1', [id]);
    if (!exec) return res.status(404).json({ message: 'Execução não encontrada.' });
    if (exec.status !== 'pausado') {
      return res.status(400).json({ message: 'Essa etapa não está pausada.' });
    }
    const emAndamento = await db.get(
      "SELECT id FROM execucoes_etapa WHERE colaborador_id = $1 AND status = 'em_andamento'",
      [exec.colaborador_id]
    );
    if (emAndamento) {
      return res.status(409).json({ message: 'Você já está executando outra etapa. Pause ou conclua antes de retomar essa.' });
    }
    const agora = formatDateToLocalISO(new Date(), 'retomar-etapa');
    await db.run("UPDATE execucoes_etapa SET status = 'em_andamento', dataPausada = $1 WHERE id = $2", [agora, id]);
    res.json({ id, status: 'em_andamento', tempoAcumuladoBase: Math.round(Number(exec.tempoacumulado) || 0), referenciaInicio: agora });
  } catch (error) {
    console.error('Erro ao retomar etapa:', error.message);
    res.status(500).json({ message: 'Erro ao retomar etapa', error: error.message });
  }
});

app.put('/execucoes-etapa/:id/concluir', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const exec = await db.get('SELECT * FROM execucoes_etapa WHERE id = $1', [id]);
    if (!exec) return res.status(404).json({ message: 'Execução não encontrada.' });
    if (exec.status === 'concluido') {
      return res.status(400).json({ message: 'Essa etapa já foi concluída.' });
    }
    const agora = formatDateToLocalISO(new Date(), 'concluir-etapa');
    let tempoFinal = Number(exec.tempoacumulado) || 0;
    if (exec.status === 'em_andamento') {
      tempoFinal += calcularTempoSegundos(exec.datapausada || exec.inicio, agora);
    }
    await db.run("UPDATE execucoes_etapa SET status = 'concluido', tempoAcumulado = $1, dataConclusao = $2 WHERE id = $3", [tempoFinal, agora, id]);
    res.json({ id, status: 'concluido', tempoAcumulado: Math.round(tempoFinal) });
  } catch (error) {
    console.error('Erro ao concluir etapa:', error.message);
    res.status(500).json({ message: 'Erro ao concluir etapa', error: error.message });
  }
});

app.put('/execucoes-etapa/:id/zerar', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const exec = await db.get('SELECT * FROM execucoes_etapa WHERE id = $1', [id]);
    if (!exec) return res.status(404).json({ message: 'Execução não encontrada.' });
    await db.run('DELETE FROM execucoes_etapa WHERE id = $1', [id]);
    res.json({ id, removida: true });
  } catch (error) {
    console.error('Erro ao zerar tempo da execução:', error.message);
    res.status(500).json({ message: 'Erro ao zerar tempo da execução', error: error.message });
  }
});

app.get('/execucoes-etapa/ativas', async (req, res) => {
  try {
    const rows = await db.all(`
      SELECT ex.id, ex.tempoAcumulado, ex.inicio, ex.dataPausada,
             p.empresa, p.numeroOS,
             ip.codigoDesenho, ip.chicote_id,
             ec.nome AS etapaNome, ec.ordem AS etapaOrdem,
             col.nome AS colaboradorNome
      FROM execucoes_etapa ex
      JOIN itens_pedidos ip ON ip.id = ex.item_pedido_id
      JOIN pedidos p ON p.id = ip.pedido_id
      JOIN etapas_chicote ec ON ec.id = ex.etapa_chicote_id
      JOIN colaboradores col ON col.id = ex.colaborador_id
      WHERE ex.status = 'em_andamento'
      ORDER BY ex.inicio ASC
    `);
    const resultado = rows.map((r) => ({
      id: r.id,
      empresa: r.empresa,
      numeroOS: r.numeroos,
      codigoDesenho: r.codigodesenho,
      chicoteId: r.chicote_id,
      etapaNome: r.etapanome,
      etapaOrdem: r.etapaordem,
      colaboradorNome: r.colaboradornome,
      tempoAcumuladoBase: Math.round(Number(r.tempoacumulado) || 0),
      referenciaInicio: r.datapausada || r.inicio,
    }));
    res.json(resultado);
  } catch (error) {
    console.error('Erro ao listar execuções ativas:', error.message);
    res.status(500).json({ message: 'Erro ao listar execuções ativas', error: error.message });
  }
});

app.get('/ordens-producao/monitor', async (req, res) => {
  try {
    const pedidos = await db.all(`
      SELECT id, empresa, numeroOS, status, ordemPrioridade
      FROM pedidos
      WHERE prioritario = 1 AND status IN ('novo', 'andamento')
      ORDER BY ordemPrioridade ASC NULLS LAST, empresa, numeroOS
    `);

    if (pedidos.length === 0) {
      return res.json([]);
    }

    const pedidoIds = pedidos.map((p) => p.id);
    const itens = await db.all(
      'SELECT id, pedido_id, codigoDesenho, quantidadePedido, chicote_id FROM itens_pedidos WHERE pedido_id = ANY($1::int[]) AND chicote_id IS NOT NULL',
      [pedidoIds]
    );

    if (itens.length === 0) {
      return res.json(pedidos.map((p) => ({
        id: p.id,
        empresa: p.empresa,
        numeroOS: p.numeroos,
        status: p.status,
        ordemPrioridade: p.ordemprioridade,
        itens: [],
      })));
    }

    const chicoteIds = [...new Set(itens.map((i) => i.chicote_id))];
    const itemIds = itens.map((i) => i.id);

    const chicotes = await db.all(
      'SELECT id, tempoIdeal FROM chicotes WHERE id = ANY($1::int[])',
      [chicoteIds]
    );
    const chicoteTempoIdealMap = new Map(chicotes.map((c) => [c.id, c.tempoideal]));

    const etapas = await db.all(
      'SELECT id, chicote_id, ordem, nome, setor, quemTexto, colaboradores, instrucoes FROM etapas_chicote WHERE chicote_id = ANY($1::int[]) ORDER BY ordem',
      [chicoteIds]
    );
    const execucoes = await db.all(
      `SELECT ex.*, col.nome AS colaboradorNome FROM execucoes_etapa ex
       JOIN colaboradores col ON col.id = ex.colaborador_id
       WHERE ex.item_pedido_id = ANY($1::int[])`,
      [itemIds]
    );

    const calcularExecucao = (exec) => {
      if (!exec) return null;
      const base = Math.round(Number(exec.tempoacumulado) || 0);
      if (exec.status === 'em_andamento') {
        return {
          id: exec.id,
          status: exec.status,
          colaboradorNome: exec.colaboradornome,
          tempoAcumuladoBase: base,
          referenciaInicio: exec.datapausada || exec.inicio,
        };
      }
      return { id: exec.id, status: exec.status, colaboradorNome: exec.colaboradornome, tempoAcumulado: base };
    };

    const resultado = pedidos.map((pedido) => ({
      id: pedido.id,
      empresa: pedido.empresa,
      numeroOS: pedido.numeroos,
      status: pedido.status,
      ordemPrioridade: pedido.ordemprioridade,
      itens: itens
        .filter((item) => item.pedido_id === pedido.id)
        .map((item) => {
          const etapasDoItem = etapas
            .filter((e) => e.chicote_id === item.chicote_id)
            .map((e) => {
              const execucoesDaEtapa = execucoes
                .filter((ex) => ex.item_pedido_id === item.id && ex.etapa_chicote_id === e.id)
                .sort((a, b) => b.id - a.id);
              const execucaoMaisRecente = execucoesDaEtapa[0];
              const concluidas = execucoesDaEtapa.filter((ex) => ex.status === 'concluido');
              // Tempo da etapa = média entre os colaboradores que a concluíram.
              const tempoMedioConcluido = concluidas.length > 0
                ? concluidas.reduce((soma, ex) => soma + (Number(ex.tempoacumulado) || 0), 0) / concluidas.length
                : null;
              // Todas as execuções da etapa (qualquer colaborador, qualquer status), pra mostrar
              // todo mundo que trabalhou/está trabalhando na mesma etapa, não só a mais recente.
              const execucoesEtapa = execucoesDaEtapa.map((ex) => calcularExecucao(ex));
              return {
                id: e.id,
                ordem: e.ordem,
                nome: e.nome,
                setor: e.setor,
                quemTexto: e.quemtexto,
                colaboradores: e.colaboradores,
                instrucoes: e.instrucoes,
                execucao: calcularExecucao(execucaoMaisRecente),
                execucoes: execucoesEtapa,
                concluida: concluidas.length > 0,
                tempoMedioConcluido,
              };
            });
          const todasConcluidas = etapasDoItem.length > 0 && etapasDoItem.every((e) => e.tempoMedioConcluido !== null);
          const qtd = Number(item.quantidadepedido);
          const tempoTotalReal = todasConcluidas && qtd > 0
            ? Math.round(etapasDoItem.reduce((soma, e) => soma + e.tempoMedioConcluido, 0) / qtd)
            : null;
          etapasDoItem.forEach((e) => delete e.tempoMedioConcluido);
          return {
            id: item.id,
            codigoDesenho: item.codigodesenho,
            quantidadePedido: item.quantidadepedido,
            chicoteId: item.chicote_id,
            tempoIdeal: chicoteTempoIdealMap.get(item.chicote_id) ?? null,
            tempoTotalReal,
            etapas: etapasDoItem,
          };
        }),
    }));

    res.json(resultado);
  } catch (error) {
    console.error('Erro ao listar monitor de produção:', error.message);
    res.status(500).json({ message: 'Erro ao listar monitor de produção', error: error.message });
  }
});

app.get('/historico-entregas/:pedidoId', async (req, res) => {
  const pedidoId = parseInt(req.params.pedidoId);
  try {
    const historico = await db.all(`
      SELECT h.*, i.codigoDesenho 
      FROM historico_entregas h 
      LEFT JOIN itens_pedidos i ON h.item_id = i.id 
      WHERE h.pedido_id = $1
      ORDER BY h.dataEdicao ASC
    `, [pedidoId]);
    console.log(`GET /historico-entregas/${pedidoId} - Dados retornados:`, historico);
    res.json(historico);
  } catch (error) {
    console.error(`Erro ao buscar histórico para pedido ${pedidoId}:`, error.message);
    res.status(500).json({ message: 'Erro ao buscar histórico', error: error.message });
  }
});

app.put('/historico-entregas/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { quantidadeEntregue } = req.body;

  if (quantidadeEntregue === undefined || quantidadeEntregue < 0) {
    return res.status(400).json({ message: 'Quantidade entregue deve ser um número não negativo' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const historicoResult = await client.query('SELECT * FROM historico_entregas WHERE id = $1', [id]);
    if (historicoResult.rows.length === 0) {
      throw new Error('Entrada de entrega não encontrada');
    }
    const historicoEntry = historicoResult.rows[0];
    const itemId = historicoEntry.item_id;
    const pedidoId = historicoEntry.pedido_id;

    const dataEdicao = formatDateToLocalISO(new Date(), 'edit_historico_entrega');
    const updateResult = await client.query(
      'UPDATE historico_entregas SET quantidadeEntregue = $1, dataEdicao = $2 WHERE id = $3 RETURNING *',
      [quantidadeEntregue, dataEdicao, id]
    );
    const updatedEntry = updateResult.rows[0];

    const historicoTotalResult = await client.query(
      'SELECT SUM(quantidadeEntregue) as total FROM historico_entregas WHERE item_id = $1',
      [itemId]
    );
    const totalEntregue = parseInt(historicoTotalResult.rows[0].total, 10) || 0;

    await client.query(
      'UPDATE itens_pedidos SET quantidadeEntregue = $1 WHERE id = $2',
      [totalEntregue, itemId]
    );

    const itemResult = await client.query('SELECT codigoDesenho FROM itens_pedidos WHERE id = $1', [itemId]);
    const codigoDesenho = itemResult.rows[0]?.codigodesenho || 'Desconhecido';

    await client.query('COMMIT');

    const responseData = {
      ...updatedEntry,
      codigoDesenho
    };
    console.log(`PUT /historico-entregas/${id} - Dados retornados ao frontend:`, responseData);
    res.status(200).json(responseData);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao editar entrada de entrega:', error.message);
    res.status(500).json({ message: 'Erro ao editar entrada de entrega', error: error.message });
  } finally {
    client.release();
  }
});

app.delete('/historico-entregas/:id', async (req, res) => {
  const id = parseInt(req.params.id);

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const historicoResult = await client.query('SELECT * FROM historico_entregas WHERE id = $1', [id]);
    if (historicoResult.rows.length === 0) {
      throw new Error('Entrada de entrega não encontrada');
    }
    const historicoEntry = historicoResult.rows[0];
    const itemId = historicoEntry.item_id;

    console.log(`DELETE /historico-entregas/${id} - Excluindo entrada do histórico:`, historicoEntry);

    const deleteResult = await client.query('DELETE FROM historico_entregas WHERE id = $1 RETURNING *', [id]);
    if (deleteResult.rowCount === 0) {
      throw new Error('Entrada de entrega não encontrada');
    }

    const historicoTotalResult = await client.query(
      'SELECT SUM(quantidadeEntregue) as total FROM historico_entregas WHERE item_id = $1',
      [itemId]
    );
    const totalEntregue = parseInt(historicoTotalResult.rows[0].total, 10) || 0;

    await client.query(
      'UPDATE itens_pedidos SET quantidadeEntregue = $1 WHERE id = $2',
      [totalEntregue, itemId]
    );

    await client.query('COMMIT');

    res.status(204).send();
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao excluir entrada de entrega:', error.message);
    res.status(500).json({ message: 'Erro ao excluir entrada de entrega', error: error.message });
  } finally {
    client.release();
  }
});

app.get('/historico-observacoes/:pedidoId', async (req, res) => {
  const pedidoId = parseInt(req.params.pedidoId);
  try {
    const historico = await db.all(`
      SELECT id, pedido_id, observacao, dataEdicao 
      FROM historico_observacoes 
      WHERE pedido_id = $1
      ORDER BY dataEdicao ASC
    `, [pedidoId]);
    const historicoFormatado = historico.map(entry => ({
      id: entry.id,
      pedido_id: entry.pedido_id,
      observacao: entry.observacao,
      dataEdicao: entry.dataedicao ? converterFormatoData(entry.dataedicao) : null
    }));
    res.json(historicoFormatado || []);
  } catch (error) {
    console.error(`Erro ao buscar histórico de observações para pedido ${pedidoId}:`, error.message);
    res.status(500).json({ message: 'Erro ao buscar histórico de observações', error: error.message });
  }
});

app.put('/historico-observacoes/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { observacao } = req.body;

  if (!observacao || observacao.trim() === '') {
    return res.status(400).json({ message: 'Observação não pode ser vazia' });
  }

  try {
    const dataEdicao = formatDateToLocalISO(new Date(), 'edit_observacao');
    const result = await pool.query(
      'UPDATE historico_observacoes SET observacao = $1, dataEdicao = $2 WHERE id = $3 RETURNING *',
      [observacao.trim(), dataEdicao, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Observação não encontrada' });
    }
    const updatedEntry = result.rows[0];
    res.status(200).json({
      id: updatedEntry.id,
      pedido_id: updatedEntry.pedido_id,
      observacao: updatedEntry.observacao,
      dataEdicao: updatedEntry.dataedicao ? converterFormatoData(updatedEntry.dataedicao) : null
    });
  } catch (error) {
    console.error('Erro ao editar observação:', error.message);
    res.status(500).json({ message: 'Erro ao editar observação', error: error.message });
  }
});

app.delete('/historico-observacoes/:id', async (req, res) => {
  const id = parseInt(req.params.id);

  try {
    const result = await pool.query('DELETE FROM historico_observacoes WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Observação não encontrada' });
    }
    res.status(200).json({ message: 'Observação excluída com sucesso' });
  } catch (error) {
    console.error('Erro ao excluir observação:', error.message);
    res.status(500).json({ message: 'Erro ao excluir observação', error: error.message });
  }
});

app.put('/pedidos/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { 
    empresa, 
    numeroOS,
    dataEntrada,
    previsaoEntrega,
    responsavel, 
    status, 
    inicio, 
    tempo, 
    peso, 
    volume, 
    dataConclusao, 
    pausado, 
    tempoPausado, 
    dataPausada,
    dataInicioPausa,
    itens,
    ocCliente
  } = req.body;

  const inicioFormatado = converterFormatoData(inicio);
  const dataConclusaoFormatada = status === 'concluido' && !dataConclusao
    ? new Date().toISOString().slice(0, 19).replace('T', ' ')
    : dataConclusao ? converterFormatoData(dataConclusao) : null;
  const dataPausadaFormatada = dataPausada ? converterFormatoData(dataPausada) : null;
  const dataInicioPausaFormatada = dataInicioPausa ? converterFormatoData(dataInicioPausa) : null;

  const tempoFinal = pausado === '1' ? Number(tempoPausado) : Number(tempo);
  const empresaResolvida = empresa ? await resolverNomeEmpresa(empresa) : empresa;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const pedidoSql = `
      UPDATE pedidos SET
        empresa = $1,
        numeroOS = $2,
        dataEntrada = $3,
        previsaoEntrega = $4,
        responsavel = $5,
        status = $6,
        inicio = $7,
        tempo = $8,
        peso = $9,
        volume = $10,
        dataConclusao = $11,
        pausado = $12,
        tempoPausado = $13,
        dataPausada = $14,
        dataInicioPausa = $15,
        ocCliente = $16
      WHERE id = $17
      RETURNING *
    `;
    const pedidoValues = [
      empresaResolvida || null,
      numeroOS || null,
      dataEntrada || null,
      previsaoEntrega || null,
      responsavel || null,
      status,
      inicioFormatado,
      tempoFinal,
      peso || null,
      volume || null,
      dataConclusaoFormatada,
      pausado || 0,
      Number(tempoPausado) || 0,
      dataPausadaFormatada,
      dataInicioPausaFormatada,
      ocCliente || null,
      id
    ];

    const result = await client.query(pedidoSql, pedidoValues);
    if (result.rows.length === 0) {
      throw new Error('Pedido não encontrado');
    }
    const pedidoAtualizado = result.rows[0];

    if (status === 'concluido') {
      const updateItensSql = `
        UPDATE itens_pedidos
        SET quantidadeEntregue = quantidadePedido
        WHERE pedido_id = $1
        RETURNING *
      `;
      const itensResult = await client.query(updateItensSql, [id]);

      const historicoSql = `
        INSERT INTO historico_entregas (pedido_id, item_id, quantidadeEntregue, dataEdicao)
        VALUES ($1, $2, $3, $4)
        RETURNING *
      `;
      const dataEdicao = formatDateToLocalISO(new Date(), 'historico');
      for (const item of itensResult.rows) {
        const quantidadeEntregue = item.quantidadepedido;
        if (quantidadeEntregue > 0) {
          await client.query(historicoSql, [id, item.id, quantidadeEntregue, dataEdicao]);
        }
      }
    }

    if (itens && Array.isArray(itens)) {
      const itensExistentes = await client.query('SELECT * FROM itens_pedidos WHERE pedido_id = $1', [id]);
      const itensExistentesMap = new Map(itensExistentes.rows.map(item => [item.codigodesenho, item]));

      const itemSql = `
        UPDATE itens_pedidos
        SET codigoDesenho = $1, quantidadePedido = $2, quantidadeEntregue = $3, chicote_id = $4, valorUnitario = $5
        WHERE pedido_id = $6 AND id = $7
        RETURNING *
      `;
      const insertItemSql = `
        INSERT INTO itens_pedidos (pedido_id, codigoDesenho, quantidadePedido, quantidadeEntregue, chicote_id, valorUnitario)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
      `;
      const historicoSql = `
        INSERT INTO historico_entregas (pedido_id, item_id, quantidadeEntregue, dataEdicao)
        VALUES ($1, $2, $3, $4)
        RETURNING *
      `;

      for (const item of itens) {
        const { id: itemId, codigoDesenho, quantidadePedido, quantidadeEntregue, chicoteId, valorUnitario } = item;
        let updatedItem;
        const itemExistente = itensExistentesMap.get(codigoDesenho);
        if (itemExistente) {
          const quantidadeEntregueAnterior = itemExistente.quantidadeentregue || 0;
          const novaQuantidadeEntregue = parseInt(quantidadeEntregue || 0, 10);
          const quantidadeAdicionada = novaQuantidadeEntregue - quantidadeEntregueAnterior;
          // Se o formulário não mandar chicoteId/valorUnitario (undefined), preserva o que já existia
          const chicoteIdFinal = chicoteId !== undefined ? (chicoteId || null) : itemExistente.chicote_id;
          const valorUnitarioFinal = valorUnitario !== undefined ? (valorUnitario === '' ? null : valorUnitario) : itemExistente.valorunitario;

          const itemResult = await client.query(itemSql, [
            codigoDesenho,
            quantidadePedido,
            novaQuantidadeEntregue,
            chicoteIdFinal,
            valorUnitarioFinal,
            id,
            itemExistente.id
          ]);
          updatedItem = itemResult.rows[0];

          if (quantidadeAdicionada > 0) {
            const dataEdicao = formatDateToLocalISO(new Date(), 'historico');
            await client.query(historicoSql, [
              id,
              updatedItem.id,
              quantidadeAdicionada,
              dataEdicao
            ]);
          }
        } else {
          const itemResult = await client.query(insertItemSql, [
            id,
            codigoDesenho,
            quantidadePedido,
            quantidadeEntregue || 0,
            chicoteId || null,
            valorUnitario !== undefined && valorUnitario !== '' ? valorUnitario : null
          ]);
          updatedItem = itemResult.rows[0];

          if (quantidadeEntregue > 0) {
            const dataEdicao = formatDateToLocalISO(new Date(), 'historico');
            await client.query(historicoSql, [
              id,
              updatedItem.id,
              quantidadeEntregue,
              dataEdicao
            ]);
          }
        }
      }

      const codigosEnviados = new Set(itens.map(item => item.codigoDesenho));
      for (const itemExistente of itensExistentes.rows) {
        if (!codigosEnviados.has(itemExistente.codigodesenho)) {
          console.log(`PUT /pedidos/${id} - Excluindo item ${itemExistente.id} (código: ${itemExistente.codigodesenho}) do pedido ${id}, pois não está mais na lista.`);
          await client.query('DELETE FROM itens_pedidos WHERE id = $1', [itemExistente.id]);
        }
      }
    }

    await client.query('COMMIT');

    const itensSql = 'SELECT * FROM itens_pedidos WHERE pedido_id = $1';
    const itensResult = await client.query(itensSql, [id]);
    const pedidoComItens = { 
      ...pedidoAtualizado, 
      numeroOS: pedidoAtualizado.numeroos,
      dataEntrada: pedidoAtualizado.dataentrada,
      previsaoEntrega: pedidoAtualizado.previsaoentrega,
      dataConclusao: pedidoAtualizado.dataconclusao,
      dataPausada: pedidoAtualizado.datapausada,
      dataInicioPausa: pedidoAtualizado.datainiciopausa,
      tempo: tempoFinal,
      tempoPausado: Number(tempoPausado) || 0,
      pausado: pausado || '0',
      itens: itensResult.rows.map(item => ({
        ...item,
        codigoDesenho: item.codigodesenho,
        quantidadePedido: item.quantidadepedido,
        quantidadeEntregue: item.quantidadeentregue
      }))
    };

    res.status(200).json(pedidoComItens);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao atualizar pedido:', error.message, 'Stack:', error.stack);
    res.status(500).json({ message: 'Erro ao atualizar pedido', error: error.message, stack: error.stack });
  } finally {
    client.release();
  }
});

app.delete('/pedidos/:id', async (req, res) => {
  const id = parseInt(req.params.id);

  try {
    const result = await pool.query('DELETE FROM pedidos WHERE id = $1', [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ message: 'Pedido não encontrado' });
    }
    res.status(204).send();
  } catch (error) {
    console.error('Erro ao excluir pedido:', error.message, 'Stack:', error.stack);
    res.status(500).json({ message: 'Erro ao excluir pedido', error: error.message, stack: error.stack });
  }
});

app.post('/pedidos', async (req, res) => {
  const { empresa, numeroOS, dataEntrada, previsaoEntrega, responsavel, status, inicio, itens, ocCliente } = req.body;

  if (!empresa || !numeroOS || !dataEntrada || !previsaoEntrega || !status || !inicio || !Array.isArray(itens) || itens.length === 0) {
    return res.status(400).json({ message: 'Campos obrigatórios ausentes ou itens inválidos' });
  }

  for (const item of itens) {
    if (!item.codigoDesenho || item.codigoDesenho.trim() === '' || item.quantidadePedido === undefined || item.quantidadePedido === null || item.quantidadePedido === '') {
      return res.status(400).json({ message: 'Todos os itens devem ter código e quantidade pedida válidos' });
    }
    item.quantidadePedido = parseInt(item.quantidadePedido, 10);
    item.quantidadeEntregue = parseInt(item.quantidadeEntregue || 0, 10);
    if (isNaN(item.quantidadePedido) || item.quantidadePedido < 0) {
      return res.status(400).json({ message: 'Quantidade pedida deve ser um número positivo' });
    }
    item.valorUnitario = item.valorUnitario !== undefined && item.valorUnitario !== null && item.valorUnitario !== ''
      ? parseFloat(item.valorUnitario)
      : null;
    if (item.valorUnitario !== null && (isNaN(item.valorUnitario) || item.valorUnitario < 0)) {
      return res.status(400).json({ message: 'Valor unitário deve ser um número não negativo' });
    }
  }

  const inicioFormatado = converterFormatoData(inicio);
  const empresaResolvida = await resolverNomeEmpresa(empresa);

  const pedidoSql = `
    INSERT INTO pedidos (empresa, numeroOS, dataEntrada, previsaoEntrega, responsavel, status, inicio, tempo, tempoPausado, pausado, ocCliente)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 0, 0, $8)
    RETURNING id
  `;
  const pedidoValues = [empresaResolvida, numeroOS, dataEntrada, previsaoEntrega, responsavel || null, status, inicioFormatado, ocCliente || null];

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const result = await client.query(pedidoSql, pedidoValues);
    const pedidoId = result.rows[0]?.id;
    if (!pedidoId) {
      throw new Error('Falha ao inserir pedido: ID não retornado');
    }

    const itemSql = `
      INSERT INTO itens_pedidos (pedido_id, codigoDesenho, quantidadePedido, quantidadeEntregue, chicote_id, valorUnitario)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
    `;
    const historicoSql = `
      INSERT INTO historico_entregas (pedido_id, item_id, quantidadeEntregue, dataEdicao)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `;

    for (const item of itens) {
      const { codigoDesenho, quantidadePedido, quantidadeEntregue, chicoteId, valorUnitario } = item;
      const itemResult = await client.query(itemSql, [pedidoId, codigoDesenho, quantidadePedido, quantidadeEntregue || 0, chicoteId || null, valorUnitario]);
      if (!itemResult.rows || itemResult.rows.length === 0) {
        throw new Error('Falha ao inserir item: Nenhum ID retornado');
      }
      const itemId = itemResult.rows[0].id;
      if (quantidadeEntregue > 0) {
        const dataEdicao = formatDateToLocalISO(new Date(), 'historico');
        await client.query(historicoSql, [pedidoId, itemId, quantidadeEntregue, dataEdicao]);
      }
    }

    await client.query('COMMIT');

    const novoPedido = {
      id: pedidoId,
      empresa: empresaResolvida,
      numeroOS,
      dataEntrada,
      previsaoEntrega,
      responsavel,
      status,
      inicio: inicioFormatado,
      tempo: 0,
      tempoPausado: 0,
      pausado: '0',
      ocCliente: ocCliente || null,
      itens
    };
    res.status(201).json(novoPedido);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao processar pedido:', error.message, 'Stack:', error.stack);
    res.status(500).json({ message: 'Erro ao processar pedido', error: error.message, stack: error.stack });
  } finally {
    client.release();
  }
});

app.post('/enviar-email', async (req, res) => {
  const { pedido, observacao, quantidadesEditadas } = req.body;

  if (!pedido || !pedido.numeroOS) {
    return res.status(400).json({ message: 'Dados do pedido inválidos ou número da OS não fornecido' });
  }

  const pedidoFormatado = {
    ...pedido,
    inicio: converterFormatoData(pedido.inicio),
    dataConclusao: pedido.dataConclusao ? converterFormatoData(pedido.dataConclusao) : null,
  };

  const subject = observacao
    ? `Observação sobre Pedido ${pedidoFormatado.numeroOS}`
    : `Atualização de Pedido ${pedidoFormatado.numeroOS} - Status: ${pedidoFormatado.status || 'Desconhecido'}`;

  const emailText = montarEmail(pedidoFormatado, pedidoFormatado.itens || [], observacao, quantidadesEditadas);

  const rawEmailTo = (process.env.EMAIL_TO || 'danielalves@dcachicoteseletricos.com.br').replace(/\s+/g, '');
  const destinatarios = rawEmailTo
    .split(',')
    .map(email => email.trim())
    .filter(email => email.length > 0 && email.includes('@'));

  if (destinatarios.length === 0) {
    return res.status(400).json({ message: 'Nenhum destinatário válido encontrado em EMAIL_TO' });
  }

  try {
    for (const [index, destinatario] of destinatarios.entries()) {
      const mailOptions = {
        from: `"Controle de Produção" <${process.env.EMAIL_USER || 'dcashopecia@gmail.com'}>`,
        to: destinatario,
        subject,
        text: emailText,
      };
      await transporter.sendMail(mailOptions);
    }

    if (observacao && observacao.trim()) {
      const dataEdicao = formatDateToLocalISO(new Date(), 'historico_observacao');
      const observacaoSql = `
        INSERT INTO historico_observacoes (pedido_id, observacao, dataEdicao)
        VALUES ($1, $2, $3)
        RETURNING *
      `;
      await pool.query(observacaoSql, [pedido.id, observacao.trim(), dataEdicao]);
    }

    const rotaPorStatus = { novo: '/pedidos/novos', andamento: '/', concluido: '/pedidos/concluidos' };
    await criarNotificacao({
      tipo: 'pedido',
      titulo: subject,
      mensagem: `${pedidoFormatado.empresa || ''} — OS ${pedidoFormatado.numeroOS}`.trim(),
      rota: rotaPorStatus[pedidoFormatado.status] || '/',
    });

    const itensProntosParaFaturar = (pedidoFormatado.itens || []).filter(
      (item) => item.valorUnitario != null && (item.quantidadeEntregue || 0) > 0
    );
    if (itensProntosParaFaturar.length > 0) {
      await criarNotificacao({
        tipo: 'financeiro_faturar',
        titulo: `Itens prontos pra faturar — Pedido ${pedidoFormatado.numeroOS}`,
        mensagem: `${pedidoFormatado.empresa || ''}: ${itensProntosParaFaturar.map((i) => i.codigoDesenho).join(', ')}`,
        rota: `/financeiro/${encodeURIComponent(pedidoFormatado.empresa || '')}`,
      });
    }

    res.status(200).json({ message: 'E-mails enviados com sucesso' });
  } catch (error) {
    console.error('Erro ao enviar e-mails:', error.message, 'Stack:', error.stack);
    res.status(500).json({ message: 'Erro ao enviar e-mails', error: error.message, stack: error.stack });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});