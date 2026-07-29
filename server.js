const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const { parseChicoteWorkbook } = require('./importParser');
require('dotenv').config();
const app = express();
const PORT = process.env.PORT || 5000;
const upload = multer({ storage: multer.memoryStorage() });

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
  } catch (err) {
    console.error('Erro ao inicializar o banco:', err.message);
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

app.get('/pedidos', async (req, res) => {
  try {
    const pedidos = await db.all('SELECT * FROM pedidos');
    const itens = await db.all('SELECT * FROM itens_pedidos');
    const obsCounts = await db.all('SELECT pedido_id, COUNT(*)::int AS count FROM historico_observacoes GROUP BY pedido_id');
    const obsCountMap = new Map(obsCounts.map(o => [o.pedido_id, o.count]));
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
        observacoesCount: obsCountMap.get(pedido.id) || 0,
        itens: itens.filter(item => item.pedido_id === pedido.id).map(item => ({
          ...item,
          codigoDesenho: item.codigodesenho,
          quantidadePedido: item.quantidadepedido,
          quantidadeEntregue: item.quantidadeentregue,
          chicoteId: item.chicote_id,
        }))
      };
    });
    res.json(pedidosComItens);
  } catch (err) {
    console.error('Erro ao listar pedidos:', err.message);
    res.status(500).json({ message: 'Erro ao listar pedidos', error: err.message });
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
    res.json(chicotes.map((c) => ({
      id: c.id,
      cliente: c.cliente,
      codigoItemCliente: c.codigoitemcliente,
      codigoDca: c.codigodca,
      tempoIdeal: c.tempoideal,
      temEtapas: (etapaCountMap.get(c.id) || 0) > 0,
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
      'SELECT id, chicote_id, ordem, nome, setor, quemTexto, instrucoes FROM etapas_chicote WHERE chicote_id = ANY($1::int[]) ORDER BY ordem',
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
              return {
                id: e.id,
                ordem: e.ordem,
                nome: e.nome,
                setor: e.setor,
                quemTexto: e.quemtexto,
                instrucoes: e.instrucoes,
                minhaExecucao: calcularExecucao(minhaExecucao),
                execucaoAtual: calcularExecucaoAtual(execucaoMaisRecente),
              };
            });
          const todasConcluidas = etapasDoItem.length > 0 && etapasDoItem.every((e) => e.execucaoAtual?.status === 'concluido');
          const tempoTotalReal = todasConcluidas
            ? etapasDoItem.reduce((soma, e) => soma + (e.execucaoAtual?.tempoAcumulado || 0), 0)
            : null;
          return {
            id: item.id,
            codigoDesenho: item.codigodesenho,
            quantidadePedido: item.quantidadepedido,
            tempoIdeal: chicoteTempoIdealMap.get(item.chicote_id) ?? null,
            tempoTotalReal,
            etapas: etapasDoItem,
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

    const jaExecutada = await db.get(
      `SELECT ex.status, col.nome AS colaboradorNome FROM execucoes_etapa ex
       JOIN colaboradores col ON col.id = ex.colaborador_id
       WHERE ex.item_pedido_id = $1 AND ex.etapa_chicote_id = $2 AND ex.colaborador_id != $3
       ORDER BY ex.id DESC LIMIT 1`,
      [itemPedidoId, etapaChicoteId, colaboradorId]
    );
    if (jaExecutada) {
      const acao = jaExecutada.status === 'concluido' ? 'concluída' : jaExecutada.status === 'pausado' ? 'pausada' : 'iniciada';
      return res.status(409).json({ message: `Essa etapa já foi ${acao} por ${jaExecutada.colaboradornome}.` });
    }

    const agora = formatDateToLocalISO(new Date(), 'iniciar-etapa');
    const execucao = await db.get(
      `INSERT INTO execucoes_etapa (item_pedido_id, etapa_chicote_id, colaborador_id, status, inicio, tempoAcumulado)
       VALUES ($1, $2, $3, 'em_andamento', $4, 0) RETURNING id`,
      [itemPedidoId, etapaChicoteId, colaboradorId, agora]
    );

    const item = await db.get('SELECT pedido_id FROM itens_pedidos WHERE id = $1', [itemPedidoId]);
    if (item) {
      await db.run("UPDATE pedidos SET status = 'andamento', inicio = $2 WHERE id = $1 AND status = 'novo'", [item.pedido_id, agora]);
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
             ip.codigoDesenho,
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
      'SELECT id, chicote_id, ordem, nome, setor, quemTexto, instrucoes FROM etapas_chicote WHERE chicote_id = ANY($1::int[]) ORDER BY ordem',
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
              const execucao = execucoes
                .filter((ex) => ex.item_pedido_id === item.id && ex.etapa_chicote_id === e.id)
                .sort((a, b) => b.id - a.id)[0];
              return {
                id: e.id,
                ordem: e.ordem,
                nome: e.nome,
                setor: e.setor,
                quemTexto: e.quemtexto,
                instrucoes: e.instrucoes,
                execucao: calcularExecucao(execucao),
              };
            });
          const todasConcluidas = etapasDoItem.length > 0 && etapasDoItem.every((e) => e.execucao?.status === 'concluido');
          const tempoTotalReal = todasConcluidas
            ? etapasDoItem.reduce((soma, e) => soma + (e.execucao?.tempoAcumulado || 0), 0)
            : null;
          return {
            id: item.id,
            codigoDesenho: item.codigodesenho,
            quantidadePedido: item.quantidadepedido,
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
    itens 
  } = req.body;

  const inicioFormatado = converterFormatoData(inicio);
  const dataConclusaoFormatada = status === 'concluido' && !dataConclusao
    ? new Date().toISOString().slice(0, 19).replace('T', ' ')
    : dataConclusao ? converterFormatoData(dataConclusao) : null;
  const dataPausadaFormatada = dataPausada ? converterFormatoData(dataPausada) : null;
  const dataInicioPausaFormatada = dataInicioPausa ? converterFormatoData(dataInicioPausa) : null;

  const tempoFinal = pausado === '1' ? Number(tempoPausado) : Number(tempo);

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
        dataInicioPausa = $15
      WHERE id = $16
      RETURNING *
    `;
    const pedidoValues = [
      empresa || null,
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
        SET codigoDesenho = $1, quantidadePedido = $2, quantidadeEntregue = $3, chicote_id = $4
        WHERE pedido_id = $5 AND id = $6
        RETURNING *
      `;
      const insertItemSql = `
        INSERT INTO itens_pedidos (pedido_id, codigoDesenho, quantidadePedido, quantidadeEntregue, chicote_id)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
      `;
      const historicoSql = `
        INSERT INTO historico_entregas (pedido_id, item_id, quantidadeEntregue, dataEdicao)
        VALUES ($1, $2, $3, $4)
        RETURNING *
      `;

      for (const item of itens) {
        const { id: itemId, codigoDesenho, quantidadePedido, quantidadeEntregue, chicoteId } = item;
        let updatedItem;
        const itemExistente = itensExistentesMap.get(codigoDesenho);
        if (itemExistente) {
          const quantidadeEntregueAnterior = itemExistente.quantidadeentregue || 0;
          const novaQuantidadeEntregue = parseInt(quantidadeEntregue || 0, 10);
          const quantidadeAdicionada = novaQuantidadeEntregue - quantidadeEntregueAnterior;
          // Se o formulário não mandar chicoteId (undefined), preserva o vínculo que já existia
          const chicoteIdFinal = chicoteId !== undefined ? (chicoteId || null) : itemExistente.chicote_id;

          const itemResult = await client.query(itemSql, [
            codigoDesenho,
            quantidadePedido,
            novaQuantidadeEntregue,
            chicoteIdFinal,
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
            chicoteId || null
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
  const { empresa, numeroOS, dataEntrada, previsaoEntrega, responsavel, status, inicio, itens } = req.body;

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
  }

  const inicioFormatado = converterFormatoData(inicio);

  const pedidoSql = `
    INSERT INTO pedidos (empresa, numeroOS, dataEntrada, previsaoEntrega, responsavel, status, inicio, tempo, tempoPausado, pausado)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 0, 0)
    RETURNING id
  `;
  const pedidoValues = [empresa, numeroOS, dataEntrada, previsaoEntrega, responsavel || null, status, inicioFormatado];

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const result = await client.query(pedidoSql, pedidoValues);
    const pedidoId = result.rows[0]?.id;
    if (!pedidoId) {
      throw new Error('Falha ao inserir pedido: ID não retornado');
    }

    const itemSql = `
      INSERT INTO itens_pedidos (pedido_id, codigoDesenho, quantidadePedido, quantidadeEntregue, chicote_id)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id
    `;
    const historicoSql = `
      INSERT INTO historico_entregas (pedido_id, item_id, quantidadeEntregue, dataEdicao)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `;

    for (const item of itens) {
      const { codigoDesenho, quantidadePedido, quantidadeEntregue, chicoteId } = item;
      const itemResult = await client.query(itemSql, [pedidoId, codigoDesenho, quantidadePedido, quantidadeEntregue || 0, chicoteId || null]);
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
      empresa, 
      numeroOS, 
      dataEntrada, 
      previsaoEntrega, 
      responsavel, 
      status, 
      inicio: inicioFormatado, 
      tempo: 0, 
      tempoPausado: 0, 
      pausado: '0', 
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

    res.status(200).json({ message: 'E-mails enviados com sucesso' });
  } catch (error) {
    console.error('Erro ao enviar e-mails:', error.message, 'Stack:', error.stack);
    res.status(500).json({ message: 'Erro ao enviar e-mails', error: error.message, stack: error.stack });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});